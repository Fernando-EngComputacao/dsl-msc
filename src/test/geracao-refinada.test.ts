/**
 * O subgrafo refinado chegando ao gerador (Etapa 9).
 *
 * Ate aqui `refinarPolitica` era observacional: `gerarPlanoRestrito` recalculava
 * a propria poda e descartava o refinamento em silencio. Estes testes provam que
 * isso acabou, e — mais importante — que acabou SEM abrir caminho para o erro
 * oposto.
 *
 * O ponto de observacao e `montarEntradaGeracao*`: a funcao pura que monta
 * exatamente o que `decodificar` recebe. Testar por ela e o que permite conferir
 * o subgrafo real da geracao sem rede, sem GPU e sem motor.
 *
 * O TESTE QUE MAIS IMPORTA e o do refinamento efetivo: no cenario de referencia
 * grafo e AST concordam, entao o refinamento e no-op e um bug de fiacao passaria
 * despercebido. Por isso ha um cenario construido em que o refinamento REMOVE
 * uma decisao, e se verifica que ela nao chega ao gerador.
 */

import assert from 'node:assert/strict';

import { loadModel } from '../database/neo4j.js';
import { loadAgroModel } from '../database/neo4j-agro.js';
import { loadFutModel } from '../database/neo4j-fut.js';
import {
    retrieveConstraints,
    pruningPayload,
    type ClinicalContext
} from '../knowledge/graphrag.js';
import { retrieveAgroConstraints, agroPruningPayload, type AgroContext } from '../knowledge/graphrag-agro.js';
import { retrieveFutConstraints, futPruningPayload, type FutContext } from '../knowledge/graphrag-fut.js';
import { montarEntradaGeracao, montarPromptSemantico } from '../inference/llm-client.js';
import { montarEntradaGeracaoAgro } from '../inference/agro-client.js';
import { montarEntradaGeracaoFut } from '../inference/fut-client.js';
import { refinarPolitica, apenasEstreitou } from '../knowledge/recuperacao-politica.js';
import { anotarRecomendacao } from '../knowledge/politica.js';
import type { RegraValidada } from '../knowledge/recuperacao-cypher.js';
import type { SubgrafoPodado } from '../knowledge/politica.js';

let falhas = 0;
function teste(nome: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok   ${nome}`))
        .catch((erro: Error) => {
            falhas++;
            console.log(`  FALHA ${nome}\n       ${erro.message}`);
        });
}

const MED: ClinicalContext = {
    intencao: 'PAM 52 e lactato 4.2: subo a noradrenalina?',
    paciente: 'PT-2026-4001',
    telemetria: { PAM: 52, FC: 104, lactato: 4.2, RASS: -2, TFG: 28, plaquetas: 45, glicemia: 158, SpO2: 93 },
    populacoes: ['Renal_Cronico'],
    farmacosEmUso: ['Noradrenalina']
};

/** Regra validada que INCIDE e bloqueia incremento sobre um item. */
function bloqueio(item: string, dominio: 'med' | 'agro' | 'fut' = 'med', relacao = 'BLOQUEIA_INCREMENTO'): RegraValidada {
    return {
        regraId: `${item}/RegraSeguranca/PAM<60`,
        tipo: 'RegraSeguranca',
        relacao,
        item,
        dominio,
        aplicavel: true,
        condicoesSatisfeitas: [{
            campo: 'PAM', observado: 52, esperado: '< 60 mmHg',
            operador: '<', limite: 60, unidade: 'mmHg', satisfeita: true
        }],
        condicoesFalhas: [],
        lacunas: [],
        evidencia: { PAM: 52 },
        validacaoCypher: { valida: true, motivo: 'PAM 52 < 60 mmHg: condicao satisfeita', consulta: '' },
        efeito: { razao: 'risco de hipotensao severa' },
        rag: { candidatoId: item, escore: 0.8, cosseno: 0.6, papel: 'item', posicao: 0 }
    };
}

async function main(): Promise<void> {
    const model = await loadModel('src/examples/med/uti.dsl');
    const constraints = retrieveConstraints(model, MED);
    const P: SubgrafoPodado = pruningPayload(constraints, MED);

    console.log('\n[o subgrafo fornecido e o que chega ao gerador]');

    await teste('1+2. entrada recebe o SubgrafoPodado explicito e o utiliza', () => {
        const marcado: SubgrafoPodado = {
            ...P,
            politicas: P.politicas.slice(0, 1).map(p => ({ ...p, item: p.item }))
        };
        const entrada = montarEntradaGeracao(MED, constraints, model, marcado);

        assert.equal(entrada.subgrafo, marcado, 'o subgrafo fornecido tem de ser o MESMO objeto');
        assert.equal(entrada.subgrafo.politicas.length, 1);
        // E o contrato foi montado a partir DELE, nao da poda interna.
        assert.equal(entrada.contrato.politicas.size, 1);
    });

    await teste('3. o pruning interno NAO roda quando o subgrafo e fornecido', () => {
        // Um subgrafo deliberadamente diferente do que a poda produziria: se o
        // pruning interno rodasse, o resultado voltaria a ter todos os itens.
        const soUm: SubgrafoPodado = { ...P, politicas: [P.politicas[0]] };
        const entrada = montarEntradaGeracao(MED, constraints, model, soUm);

        assert.notEqual(P.politicas.length, 1, 'pre-condicao: a poda interna traria mais itens');
        assert.equal(entrada.subgrafo.politicas.length, 1, 'a poda interna rodou e sobrescreveu');
        assert.deepEqual(entrada.subgrafo.politicas.map(p => p.item), [P.politicas[0].item]);
    });

    await teste('4. sem subgrafo fornecido, o caminho legado e identico ao de antes', () => {
        const entrada = montarEntradaGeracao(MED, constraints, model);
        assert.deepEqual(entrada.subgrafo, pruningPayload(constraints, MED));
        assert.equal(entrada.comando, MED.intencao);
        assert.ok(entrada.contexto.includes('[CENARIO]'), 'o Prompt Semantico continua sendo montado');
        assert.ok(entrada.contrato.politicas.size > 0);
        assert.equal(entrada.contrato.sujeito, 'PT-2026-4001');
    });

    console.log('\n[O TESTE QUE IMPORTA: refinamento que REALMENTE remove decisao]');

    await teste('13. decisao removida pelo refinamento nao chega ao gerador', () => {
        // (a) a politica deterministica CONTEM a decisao
        const alvo = P.politicas.find(p => p.decisoes.includes('INICIAR_INFUSAO'))!;
        assert.ok(alvo, 'pre-condicao: algum item admite INICIAR_INFUSAO');

        // (b) RAG + Cypher identificam a regra aplicavel sobre esse item
        const validadas = [bloqueio(alvo.item)];

        // (c) o refinamento remove a decisao
        const rec = refinarPolitica(P, validadas);
        const refinado = rec.subgrafo.politicas.find(p => p.item === alvo.item)!;
        assert.ok(!refinado.decisoes.includes('INICIAR_INFUSAO'), 'o refinamento nao removeu');
        assert.equal(rec.ajustes.length, 1);

        // (d) o SubgrafoPodado final nao contem a decisao
        assert.ok(!rec.subgrafo.politicas.some(p =>
            p.item === alvo.item && p.decisoes.includes('INICIAR_INFUSAO')));

        // (e) o gerador recebe ESSE subgrafo
        const entrada = montarEntradaGeracao(MED, constraints, model, rec.subgrafo);
        assert.equal(entrada.subgrafo, rec.subgrafo);

        // (f) e o contrato da geracao tambem nao admite a decisao removida
        const noContrato = entrada.contrato.politicas.get(alvo.item)!;
        assert.ok(!noContrato.decisoes.includes('INICIAR_INFUSAO'),
            'a decisao removida sobreviveu no contrato entregue a geracao');
        assert.equal(noContrato.bloqueado, true);

        // ... enquanto o caminho legado (sem refinamento) AINDA a admite —
        // e o contraste que prova que a fiacao mudou alguma coisa.
        const legado = montarEntradaGeracao(MED, constraints, model);
        assert.ok(legado.contrato.politicas.get(alvo.item)!.decisoes.includes('INICIAR_INFUSAO'));
    });

    console.log('\n[nada se perde no caminho refinado]');

    await teste('5+6. VETA/PROIBE continuam no subgrafo entregue a geracao', () => {
        assert.ok(constraints.vetados.length > 0, 'pre-condicao: ha veto ativo');
        const rec = refinarPolitica(P, [bloqueio(P.politicas[0].item)]);
        const entrada = montarEntradaGeracao(MED, constraints, model, rec.subgrafo);

        for (const v of constraints.vetados) {
            const p = entrada.subgrafo.politicas.find(x => x.item === v.farmaco);
            if (!p) continue;
            assert.equal(p.bloqueado, true, `${v.farmaco}: veto perdido a caminho do gerador`);
            assert.ok(p.motivos.some(m => m.includes('vetado por')));
            // E o Prompt Semantico continua anunciando o veto.
            assert.ok(entrada.contexto.includes(v.farmaco));
        }
        assert.ok(entrada.contexto.includes('[FARMACOS VETADOS NESTE CONTEXTO]'));
    });

    await teste('7+8. AJUSTA, valores e unidades continuam no subgrafo entregue', () => {
        assert.ok(constraints.ajustes.length > 0, 'pre-condicao: ha ajuste ativo');
        const rec = refinarPolitica(P, [bloqueio(P.politicas[0].item)]);
        const entrada = montarEntradaGeracao(MED, constraints, model, rec.subgrafo);

        for (const antes of P.politicas) {
            const depois = entrada.subgrafo.politicas.find(p => p.item === antes.item)!;
            assert.deepEqual(depois.valores, antes.valores, `${antes.item}: valores perdidos`);
            assert.deepEqual(depois.valoresPorDecisao, antes.valoresPorDecisao, `${antes.item}: reticulo perdido`);
            assert.deepEqual(depois.unidades, antes.unidades, `${antes.item}: unidades perdidas`);
            assert.deepEqual(depois.meios, antes.meios);
        }
        assert.ok(entrada.contexto.includes('[AJUSTES DE DOSE EXIGIDOS]'));
    });

    await teste('9. estado de curso continua valendo no subgrafo entregue', () => {
        const rec = refinarPolitica(P, [bloqueio('Vasopressina')]);
        const entrada = montarEntradaGeracao(MED, constraints, model, rec.subgrafo);
        const nora = entrada.subgrafo.politicas.find(p => p.item === 'Noradrenalina')!;

        assert.ok(!nora.decisoes.includes('INICIAR_INFUSAO'),
            'noradrenalina ja infunde: iniciar nao pode voltar a ser exprimivel');
        assert.ok(entrada.contexto.includes('em infusao neste momento: Noradrenalina'));
    });

    await teste('10. refinada subconjunto da deterministica, ate o gerador', () => {
        const rec = refinarPolitica(P, P.politicas.map(p => bloqueio(p.item)));
        const entrada = montarEntradaGeracao(MED, constraints, model, rec.subgrafo);
        assert.ok(apenasEstreitou(P, entrada.subgrafo));

        const autorizado = new Map(P.politicas.map(p => [p.item, new Set(p.decisoes)]));
        for (const p of entrada.subgrafo.politicas) {
            for (const d of p.decisoes) {
                assert.ok(autorizado.get(p.item)!.has(d), `'${d}' em '${p.item}' nao era autorizada`);
            }
        }
    });

    await teste('11. violacao de nao-ampliacao interrompe antes de gerar', () => {
        // `refinarPolitica` e o portao: forjar uma ampliacao la dentro e
        // impossivel pela API, entao se verifica o guarda que ele consulta e o
        // fato de que ele LANCA em vez de devolver.
        const alargado: SubgrafoPodado = {
            ...P,
            politicas: P.politicas.map((p, i) =>
                i === 0 ? { ...p, decisoes: [...p.decisoes, 'DECISAO_NOVA'] } : p
            )
        };
        assert.equal(apenasEstreitou(P, alargado), false);

        // E o contrato do fail-closed: quem chama recebe excecao, nao um
        // resultado degradado para a politica mais ampla.
        const fonte = String(refinarPolitica);
        assert.ok(/apenasEstreitou/.test(fonte) && /throw/.test(fonte),
            'refinarPolitica precisa barrar a ampliacao com excecao');
    });

    await teste('12. RegraValidada[] vazio nao produz politica vazia no gerador', () => {
        const rec = refinarPolitica(P, []);
        const entrada = montarEntradaGeracao(MED, constraints, model, rec.subgrafo);

        assert.ok(entrada.subgrafo.politicas.length > 0, 'a politica chegou vazia ao gerador');
        assert.deepEqual(entrada.subgrafo, P, 'o silencio do RAG nao pode mudar nada');
        assert.equal(entrada.contrato.politicas.size, P.politicas.length);
        // E o caminho com [] e indistinguivel do legado.
        assert.deepEqual(entrada.subgrafo, montarEntradaGeracao(MED, constraints, model).subgrafo);
    });

    console.log('\n[o Prompt Semantico reflete a politica vigente]');

    await teste('legado: sem politica vigente, o prompt sai como sempre saiu', () => {
        const p = montarPromptSemantico(constraints, MED);
        assert.ok(!p.includes('POLITICA VIGENTE'), 'bloco novo vazou para o caminho legado');
        assert.ok(!p.includes('sem decisao de incremento'), 'anotacao vazou para o caminho legado');
        // Gabarito e avaliacao em lote dependem desta estabilidade.
        assert.equal(p, montarPromptSemantico(constraints, MED));
    });

    await teste('com politica vigente: o bloco declara o que a gramatica gera', () => {
        const rec = refinarPolitica(P, [bloqueio(P.politicas[0].item)]);
        const p = montarPromptSemantico(constraints, MED, rec.subgrafo);

        assert.ok(p.includes('[POLITICA VIGENTE — o que e exprimivel neste cenario]'));
        assert.ok(p.includes('esta lista e a autoridade'));
        // Cada item da politica aparece com exatamente as decisoes que sobraram.
        for (const item of rec.subgrafo.politicas) {
            // O nome do item aparece em varios blocos (cenario, recomendados,
            // interacoes): a busca tem de ser DENTRO do bloco da politica.
            const bloco = p.slice(p.indexOf('[POLITICA VIGENTE')).split('\n');
            const linha = bloco.find(l => l.startsWith(`- ${item.item}`))!;
            assert.ok(linha, `${item.item} ausente do bloco`);
            for (const d of item.decisoes) assert.ok(linha.includes(d), `${item.item}: falta ${d}`);
        }
    });

    await teste('a recomendacao inexprimivel e ANOTADA, nunca apagada', () => {
        const recomendado = constraints.recomendados[0]?.farmaco;
        assert.ok(recomendado, 'pre-condicao: o cenario recomenda algum item');

        const rec = refinarPolitica(P, [bloqueio(recomendado)]);
        const p = montarPromptSemantico(constraints, MED, rec.subgrafo);
        const linha = p.split('\n').find(l => l.startsWith(`- ${recomendado}:`))!;

        // O fato de o protocolo recomendar continua no prompt...
        assert.ok(linha.includes(constraints.recomendados[0].indicacao),
            'a indicacao do protocolo foi perdida');
        assert.ok(linha.includes(constraints.recomendados[0].protocolo));
        // ... acrescido da informacao que faltava.
        assert.ok(linha.includes('sem decisao de incremento admissivel agora'), linha);
    });

    await teste('recomendacao ainda exprimivel NAO e anotada', () => {
        const recomendado = constraints.recomendados[0]?.farmaco;
        const semRefino = montarPromptSemantico(constraints, MED, P);
        const linha = semRefino.split('\n').find(l => l.startsWith(`- ${recomendado}:`))!;
        const politica = P.politicas.find(x => x.item === recomendado);

        if (politica && politica.decisoes.some(d => P.papeis.decisoesDeIncremento.includes(d))) {
            assert.ok(!linha.includes('sem decisao de incremento'), linha);
        }
    });

    await teste('item ausente da politica por FOCO recebe anotacao propria', () => {
        // Heparina existe no modelo mas o foco pode nao traze-la; a anotacao
        // distingue "restrito" de "fora da politica deste cenario".
        const semItem: SubgrafoPodado = { ...P, politicas: P.politicas.slice(1) };
        const fora = P.politicas[0].item;
        assert.equal(anotarRecomendacao(semItem, fora), '(fora da politica vigente neste cenario)');
        // E um item presente e livre nao recebe anotacao alguma.
        const livre = P.politicas.find(p => p.decisoes.some(d => P.papeis.decisoesDeIncremento.includes(d)));
        if (livre) assert.equal(anotarRecomendacao(P, livre.item), undefined);
    });

    await teste('os blocos factuais continuam todos no prompt', () => {
        const rec = refinarPolitica(P, [bloqueio(P.politicas[0].item)]);
        const p = montarPromptSemantico(constraints, MED, rec.subgrafo);

        assert.ok(p.includes('[CENARIO]'), 'telemetria e estado de curso');
        assert.ok(p.includes('em infusao neste momento: Noradrenalina'));
        assert.ok(p.includes('[FARMACOS VETADOS NESTE CONTEXTO]'));
        assert.ok(p.includes('[AJUSTES DE DOSE EXIGIDOS]'));
        assert.ok(p.includes('[INVARIANTES GLOBAIS]'));
        // O bloco da politica vem por ULTIMO: fatos primeiro, autoridade depois.
        assert.ok(p.lastIndexOf('[POLITICA VIGENTE') > p.lastIndexOf('[INVARIANTES GLOBAIS]'));
    });

    await teste('prompt e gramatica concordam no que chega ao gerador', () => {
        const alvo = P.politicas.find(p => p.decisoes.includes('INICIAR_INFUSAO'))!;
        const rec = refinarPolitica(P, [bloqueio(alvo.item)]);
        const entrada = montarEntradaGeracao(MED, constraints, model, rec.subgrafo);
        const bloco = entrada.contexto.slice(entrada.contexto.indexOf('[POLITICA VIGENTE')).split('\n');
        const linha = bloco.find(l => l.startsWith(`- ${alvo.item}`))!;

        // A gramatica nao gera...
        assert.ok(!entrada.subgrafo.politicas.find(p => p.item === alvo.item)!.decisoes.includes('INICIAR_INFUSAO'));
        // ... e o bloco de autoridade do prompt tambem nao a anuncia.
        assert.ok(linha, 'item ausente do bloco de politica vigente');
        assert.ok(!linha.includes('INICIAR_INFUSAO'), linha);
    });

    console.log('\n[a resposta da API reflete a politica efetiva]');

    /**
     * `processarMed` nao e exportada, entao o teste reproduz a MESMA composicao
     * que `server.ts` faz — `politicaEfetiva = subgrafoRefinado ?? poda` — e
     * exige que todos os consumidores concordem. Se alguem voltar a derivar um
     * campo da poda nao refinada, o acordo quebra aqui.
     */
    function respostaDoServidor(validadas: RegraValidada[]) {
        const poda = pruningPayload(constraints, MED);
        const subgrafoRefinado = validadas.length > 0
            ? refinarPolitica(poda, validadas).subgrafo
            : undefined;
        const politicaEfetiva = subgrafoRefinado ?? poda;
        const entrada = montarEntradaGeracao(MED, constraints, model, politicaEfetiva);
        return {
            politicaEfetiva,
            // os tres campos que o evento `final` carrega
            decisoesAdmissiveis: politicaEfetiva.acoes_permitidas,
            politicas: politicaEfetiva.politicas.map(pi => ({
                item: pi.item, decisoes: pi.decisoes, bloqueado: pi.bloqueado
            })),
            promptSemantico: entrada.contexto,
            entrada
        };
    }

    await teste('hibrido: a decisao removida some de decisoesAdmissiveis', () => {
        const alvo = P.politicas.find(p => p.decisoes.includes('INICIAR_INFUSAO'))!;

        // Determinístico: a ação existe.
        const antes = respostaDoServidor([]);
        assert.ok(antes.decisoesAdmissiveis.includes('INICIAR_INFUSAO'),
            'pre-condicao: a politica deterministica permite INICIAR_INFUSAO');

        // Híbrido: o refinamento a remove do único item que a admitia...
        const soUm: SubgrafoPodado = { ...P, politicas: [alvo] };
        const rec = refinarPolitica(soUm, [bloqueio(alvo.item)]);
        assert.ok(!rec.subgrafo.acoes_permitidas.includes('INICIAR_INFUSAO'));

        // ... e a geracao tampouco a admite.
        const entrada = montarEntradaGeracao(MED, constraints, model, rec.subgrafo);
        assert.ok(!entrada.subgrafo.acoes_permitidas.includes('INICIAR_INFUSAO'));
        assert.ok(!entrada.contrato.politicas.get(alvo.item)!.decisoes.includes('INICIAR_INFUSAO'));
    });

    await teste('todos os campos de politica da resposta vem da MESMA fonte', () => {
        const alvo = P.politicas.find(p => p.decisoes.includes('INICIAR_INFUSAO'))!;
        const r = respostaDoServidor([bloqueio(alvo.item)]);

        // decisoesAdmissiveis == acoes da politica efetiva
        assert.deepEqual(r.decisoesAdmissiveis, r.politicaEfetiva.acoes_permitidas);
        // auditoria.politicas == politicas da politica efetiva
        assert.deepEqual(r.politicas.map(p => p.item), r.politicaEfetiva.politicas.map(p => p.item));
        for (const p of r.politicas) {
            const efetiva = r.politicaEfetiva.politicas.find(x => x.item === p.item)!;
            assert.deepEqual(p.decisoes, efetiva.decisoes);
            assert.equal(p.bloqueado, efetiva.bloqueado);
        }
        // a geracao recebeu exatamente esse objeto
        assert.equal(r.entrada.subgrafo, r.politicaEfetiva);
        // e o prompt foi montado dele
        const bloco = r.promptSemantico.slice(r.promptSemantico.indexOf('[POLITICA VIGENTE'));
        const linha = bloco.split('\n').find(l => l.startsWith(`- ${alvo.item}`))!;
        assert.ok(!linha.includes('INICIAR_INFUSAO'), linha);
    });

    await teste('nenhum campo da resposta anuncia decisao que a geracao nao admite', () => {
        const rec = refinarPolitica(P, P.politicas.map(p => bloqueio(p.item)));
        const politicaEfetiva = rec.subgrafo;
        const entrada = montarEntradaGeracao(MED, constraints, model, politicaEfetiva);
        const admissiveis = new Set(entrada.subgrafo.acoes_permitidas);

        for (const d of politicaEfetiva.acoes_permitidas) {
            assert.ok(admissiveis.has(d), `a API anunciaria '${d}', que a geracao nao admite`);
        }
        // E o incremento sumiu de verdade dos dois lados.
        for (const inc of P.papeis.decisoesDeIncremento) {
            assert.ok(!politicaEfetiva.acoes_permitidas.includes(inc), inc);
        }
    });

    await teste('deterministico: a resposta continua sendo a politica de sempre', () => {
        const r = respostaDoServidor([]);
        assert.deepEqual(r.politicaEfetiva, pruningPayload(constraints, MED));
        assert.deepEqual(r.decisoesAdmissiveis, P.acoes_permitidas);
        assert.deepEqual(r.politicas.map(p => p.item), P.politicas.map(p => p.item));
    });

    console.log('\n[os tres dominios aceitam o subgrafo refinado]');

    await teste('agro: entrada refinada, legado preservado', async () => {
        const m = await loadAgroModel('src/examples/agro/lavoura.agro');
        const ctx: AgroContext = {
            intencao: 'aplicar no talhao', talhao: 'T-04',
            telemetria: { vento: 8, temperatura_foliar: 30, umidade: 60 },
            areas: [], produtosEmUso: []
        };
        const c = retrieveAgroConstraints(m, ctx);
        const base = agroPruningPayload(c, ctx);
        const alvo = base.politicas.find(p =>
            p.decisoes.some(d => base.papeis.decisoesDeIncremento.includes(d)))!;

        const rec = refinarPolitica(base, [bloqueio(alvo.item, 'agro', 'BLOQUEIA')]);
        const entrada = montarEntradaGeracaoAgro(ctx, c, m, rec.subgrafo);

        assert.equal(entrada.subgrafo, rec.subgrafo);
        for (const d of base.papeis.decisoesDeIncremento) {
            assert.ok(!entrada.contrato.politicas.get(alvo.item)!.decisoes.includes(d));
        }
        // Legado intacto.
        assert.deepEqual(montarEntradaGeracaoAgro(ctx, c, m).subgrafo, base);
    });

    await teste('fut: entrada refinada, legado preservado', async () => {
        const m = await loadFutModel('src/examples/fut/futebol.fut');
        const ctx: FutContext = {
            intencao: 'entrada dura', partida: 'PARTIDA-2026-07',
            telemetria: { minuto: 78, forca_impacto: 8 },
            contextos: [], infracoesEmUso: []
        };
        const c = retrieveFutConstraints(m, ctx);
        const base = futPruningPayload(c, ctx);
        const rec = refinarPolitica(base, [bloqueio(base.politicas[0].item, 'fut', 'BLOQUEIA')]);
        const entrada = montarEntradaGeracaoFut(ctx, c, m, rec.subgrafo);

        assert.equal(entrada.subgrafo, rec.subgrafo);
        assert.ok(apenasEstreitou(base, entrada.subgrafo));
        assert.deepEqual(montarEntradaGeracaoFut(ctx, c, m).subgrafo, base);
    });

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
