/**
 * O foco e ESCOPO, nunca permissao.
 *
 * `filtrarPorFoco*` pode tirar itens e contextos do que o Prompt Semantico
 * mostra e, com os itens, do que a gramatica gera. Nao pode devolver a um item
 * uma decisao que `retrieve*Constraints` ja tinha retirado:
 *
 *     para cada item em foco:  decisoes depois do foco  ⊆  decisoes antes do foco
 *
 * A comparacao usa `apenasEstreitou`, a mesma guarda que `refinarPolitica`
 * aplica em runtime.
 *
 * Os casos nomeados sao os que a auditoria achou: o foco reconstruia a politica
 * a partir do `esquema_dados` e perdia o estado de curso e o veto de contexto
 * ativo que ficava fora do foco.
 *
 * Roda OFFLINE. Onde o teste parte de uma fala, o foco vem do `retrieverFoco*`
 * real com sinal vetorial vazio: sobram o casamento por nome e a expansao pelas
 * arestas. Nas falas usadas aqui, que nomeiam um item, o indice nao semearia
 * item nenhum; ele so escolheria um contexto quando nenhuma aresta alcanca um
 * ("inicia dobutamina"), e ai o sinal vazio deixa o protocolo que veta o item
 * FORA do foco — o pior caso, que e o que interessa.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';

import type { Session } from 'neo4j-driver';

import { loadModel } from '../database/neo4j.js';
import { loadAgroModel } from '../database/neo4j-agro.js';
import { loadFutModel } from '../database/neo4j-fut.js';
import {
    filtrarPorFoco,
    pruningPayload,
    retrieveConstraints,
    retrieverFoco,
    type ClinicalContext,
    type Foco
} from '../knowledge/graphrag.js';
import {
    agroPruningPayload,
    filtrarPorFocoAgro,
    retrieveAgroConstraints,
    retrieverFocoAgro,
    type AgroContext,
    type AgroFoco
} from '../knowledge/graphrag-agro.js';
import {
    filtrarPorFocoFut,
    futPruningPayload,
    retrieveFutConstraints,
    retrieverFocoFut,
    type FutContext,
    type FutFoco
} from '../knowledge/graphrag-fut.js';
import { nomesAgro, nomesFut, nomesMed } from '../knowledge/documentos.js';
import { apenasEstreitou } from '../knowledge/recuperacao-politica.js';
import { montarPromptSemantico } from '../inference/llm-client.js';
import { TELEMETRIA_PADRAO as LEITURA_FUT } from '../inference/fut-client.js';
import type { SinalVetorial } from '../knowledge/foco.js';
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

/** Com `sinal`, `retrieverFoco*` nao consulta o indice nem toca a sessao. */
const SEM_SINAL: SinalVetorial = { itens: [], contextos: [] };
const SEM_SESSAO = undefined as unknown as Session;

/** Decisoes que as condutas de continuidade usam — as que o estado de curso tira
 *  de um farmaco que nao esta infundindo (`PAPEIS_MED.decisoesQueContinuam`). */
const CONTINUAM_MED = ['AUMENTAR_VAZAO', 'REDUZIR_VAZAO', 'MANTER_VAZAO', 'SUSPENDER', 'AJUSTAR_DOSE'];

function decisoesDe(subgrafo: SubgrafoPodado, item: string): string[] {
    const politica = subgrafo.politicas.find(p => p.item === item);
    assert.ok(politica, `${item} nao esta na politica`);
    return politica.decisoes;
}

/**
 * Tudo o que o foco devolveu ou afrouxou, item a item — vazio quando ele so
 * estreitou. Vai alem de `apenasEstreitou`, que olha itens e decisoes: um item
 * nao pode sair desbloqueado, e meios e valores nao podem mudar.
 */
function ampliacoes(antes: SubgrafoPodado, depois: SubgrafoPodado): string[] {
    const porItem = new Map(antes.politicas.map(p => [p.item, p]));
    const achados: string[] = [];
    for (const p of depois.politicas) {
        const original = porItem.get(p.item);
        if (!original) {
            achados.push(`${p.item}: item que nao estava na politica`);
            continue;
        }
        const novas = p.decisoes.filter(d => !original.decisoes.includes(d));
        if (novas.length > 0) achados.push(`${p.item} ganhou [${novas.join(', ')}]`);
        if (original.bloqueado && !p.bloqueado) achados.push(`${p.item} saiu desbloqueado`);
        for (const campo of ['meios', 'unidades', 'valores', 'valoresPorDecisao'] as const) {
            if (JSON.stringify(p[campo]) !== JSON.stringify(original[campo])) {
                achados.push(`${p.item}: ${campo} mudou`);
            }
        }
    }
    return achados;
}

/** Os focos que o caso 4 aplica a cada cenario, alem do foco real da fala. */
function focosSinteticos<F>(
    itens: string[],
    contextos: string[],
    montar: (itens: Set<string>, contextos: Set<string>) => F
): [string, F][] {
    return [
        ['todos os itens e contextos', montar(new Set(itens), new Set(contextos))],
        ['todos os itens, nenhum contexto', montar(new Set(itens), new Set())],
        ...itens.map((i): [string, F] => [`so ${i}`, montar(new Set([i]), new Set())]),
        ...contextos.map((c): [string, F] => [`todos os itens + ${c}`, montar(new Set(itens), new Set([c]))])
    ];
}

interface Dominio<C, K, F> {
    arquivo: string;
    itens: string[];
    contextos: string[];
    recuperar: (cenario: C) => K;
    podar: (constraints: K, cenario: C) => SubgrafoPodado;
    filtrar: (constraints: K, foco: F, cenario: C) => K;
    focoDaFala: (fala: string) => Promise<F>;
    montarFoco: (itens: Set<string>, contextos: Set<string>) => F;
}

/**
 * Caso 4: cada cenario do arquivo, sob o foco real da fala e sob os focos
 * sinteticos. Devolve quantas comparacoes rodaram e o que ampliou.
 */
async function nenhumFocoAmplia<C extends { intencao?: string }, K, F>(
    d: Dominio<C, K, F>
): Promise<{ comparacoes: number; achados: string[] }> {
    const cenarios = fs
        .readFileSync(d.arquivo, 'utf-8')
        .split('\n')
        .filter(l => l.trim().length > 0)
        .map(l => JSON.parse(l) as C);

    let comparacoes = 0;
    const achados: string[] = [];
    for (const [n, cenario] of cenarios.entries()) {
        const constraints = d.recuperar(cenario);
        // Copia profunda: se o foco alterasse a politica que recebeu, a
        // comparacao contra o original mutado esconderia a ampliacao.
        const antes = structuredClone(d.podar(constraints, cenario));
        const focos: [string, F][] = [
            ['foco real da fala', await d.focoDaFala(cenario.intencao ?? '')],
            ...focosSinteticos(d.itens, d.contextos, d.montarFoco)
        ];

        for (const [rotulo, foco] of focos) {
            const depois = d.podar(d.filtrar(constraints, foco, cenario), cenario);
            comparacoes++;
            const problemas = ampliacoes(antes, depois);
            if (!apenasEstreitou(antes, depois) && problemas.length === 0) {
                problemas.push('apenasEstreitou reprovou');
            }
            if (JSON.stringify(d.podar(constraints, cenario)) !== JSON.stringify(antes)) {
                problemas.push('o foco alterou a politica que recebeu');
            }
            if (problemas.length > 0) achados.push(`cenario ${n + 1}, ${rotulo}: ${problemas.join('; ')}`);
        }
    }
    return { comparacoes, achados };
}

async function main(): Promise<void> {
    const med = await loadModel('src/examples/med/uti.dsl');
    const agro = await loadAgroModel('src/examples/agro/lavoura.agro');
    const fut = await loadFutModel('src/examples/fut/futebol.fut');

    /** O cenario de referencia de `llm-client.ts`: choque septico ativo
     *  (PAM 52 < 65), Vancomicina em curso, Vasopressina e Dobutamina fora. */
    const LEITO: ClinicalContext = {
        paciente: 'PT-2026-0031',
        telemetria: { PAM: 52, FC: 145, lactato: 4.8, RASS: 2, TFG: 28, plaquetas: 45, glicemia: 210 },
        populacoes: ['Renal_Cronico'],
        farmacosEmUso: ['Noradrenalina', 'Propofol', 'Vancomicina']
    };

    /** Politica antes e depois do foco. Sem `foco`, usa o da propria fala. */
    async function focarMed(fala: string, foco?: Foco, leito: ClinicalContext = LEITO) {
        const contexto: ClinicalContext = { ...leito, intencao: fala };
        const constraints = retrieveConstraints(med, contexto);
        const antes = pruningPayload(constraints, contexto);
        const f = foco ?? (await retrieverFoco(SEM_SESSAO, fala, med, SEM_SINAL));
        const focadas = filtrarPorFoco(constraints, f, med, contexto);
        return { contexto, constraints, antes, foco: f, focadas, depois: pruningPayload(focadas, contexto) };
    }

    console.log('\n[estado de curso sobrevive ao foco]');

    await teste('caso 1: Vancomicina em curso nao volta a admitir INICIAR_INFUSAO', async () => {
        const r = await focarMed('sobe a noradrenalina');
        assert.ok(r.foco.farmacos.has('Vancomicina'), 'pre-condicao: a Vancomicina entra pelas arestas do Choque_Septico');
        assert.ok(!decisoesDe(r.antes, 'Vancomicina').includes('INICIAR_INFUSAO'),
            'pre-condicao: o estado de curso ja tinha retirado INICIAR_INFUSAO');

        assert.ok(!decisoesDe(r.depois, 'Vancomicina').includes('INICIAR_INFUSAO'),
            'o foco devolveu INICIAR_INFUSAO a um farmaco que ja infunde');
        // O motivo que explica a restricao tambem sobrevive.
        const vanco = r.depois.politicas.find(p => p.item === 'Vancomicina')!;
        assert.ok(vanco.motivos.includes('ja em curso: nao cabe iniciar de novo'), JSON.stringify(vanco.motivos));
    });

    await teste('caso 2: Vasopressina fora de curso nao volta a admitir titulacao nem suspensao', async () => {
        const r = await focarMed('sobe a noradrenalina');
        assert.ok(r.foco.farmacos.has('Vasopressina'), 'pre-condicao: a Vasopressina entra pelas arestas');
        for (const d of CONTINUAM_MED) {
            assert.ok(!decisoesDe(r.antes, 'Vasopressina').includes(d), `pre-condicao: ${d} ja tinha saido`);
        }

        const depois = decisoesDe(r.depois, 'Vasopressina');
        for (const d of CONTINUAM_MED) {
            assert.ok(!depois.includes(d), `o foco devolveu ${d} a um farmaco que nao esta infundindo`);
        }
        assert.deepEqual(depois, decisoesDe(r.antes, 'Vasopressina'));
    });

    console.log('\n[veto de contexto ativo sobrevive ao foco]');

    await teste('caso 3: o veto do Choque_Septico ativo sobrevive com o protocolo fora do foco', async () => {
        const r = await focarMed('inicia dobutamina');
        assert.ok(r.constraints.protocolosAtivos.some(p => p.nome === 'Choque_Septico'),
            'pre-condicao: PAM 52 < 65 ativa o Choque_Septico');
        assert.ok(!r.foco.protocolos.has('Choque_Septico'), 'pre-condicao: o protocolo que veta fica fora do foco');

        const dobuta = r.depois.politicas.find(p => p.item === 'Dobutamina')!;
        assert.ok(dobuta, 'a Dobutamina, pedida pelo nome, continua em foco');
        assert.equal(dobuta.bloqueado, true, 'o veto ativo virou permissao');
        assert.ok(!dobuta.decisoes.includes('INICIAR_INFUSAO'), 'o foco devolveu INICIAR_INFUSAO a um farmaco vetado');
        assert.deepEqual(dobuta.decisoes, decisoesDe(r.antes, 'Dobutamina'));
    });

    await teste('caso 3b: idem quando o indice poe outro protocolo em foco', async () => {
        // No modo real, sem aresta ate um protocolo, o indice escolhe o mais
        // proximo — que pode nao ser o que veta. Nenhuma escolha pode liberar.
        for (const protocolo of ['Sedacao_Analgesia_VM', 'Controle_Glicemico_UTI']) {
            const r = await focarMed('inicia dobutamina', {
                farmacos: new Set(['Dobutamina']),
                protocolos: new Set([protocolo]),
                origem: new Map()
            });
            assert.deepEqual(decisoesDe(r.depois, 'Dobutamina'), decisoesDe(r.antes, 'Dobutamina'), protocolo);
            assert.equal(r.depois.politicas.find(p => p.item === 'Dobutamina')!.bloqueado, true, protocolo);
        }
    });

    await teste('o Prompt Semantico continua explicando o veto que a gramatica aplica', async () => {
        const r = await focarMed('inicia dobutamina');
        const prompt = montarPromptSemantico(r.focadas, r.contexto, r.depois);
        assert.ok(prompt.includes('- Dobutamina (protocolo Choque_Septico):'),
            'a gramatica proibe e o prompt nao diz por que');
        // Escopo preservado: o protocolo explica o veto, mas nao volta ao foco.
        assert.ok(!prompt.includes('Choque_Septico (CID'), 'o protocolo fora do foco voltou a [PROTOCOLOS EM FOCO]');
    });

    console.log('\n[o foco continua estreitando]');

    await teste('farmaco fora do foco sai da politica', async () => {
        const r = await focarMed('inicia dobutamina');
        assert.deepEqual(r.depois.politicas.map(p => p.item), ['Dobutamina']);
        assert.ok(r.antes.politicas.length > 1, 'pre-condicao: antes do foco havia mais farmacos');
    });

    await teste('veto de protocolo em foco sem gatilho ativo estreita a politica', async () => {
        // RASS -2 nao dispara a sedacao; o protocolo so entra porque esta em foco.
        const leito: ClinicalContext = { ...LEITO, telemetria: { ...LEITO.telemetria, RASS: -2 } };
        const r = await focarMed('sedacao com midazolam', {
            farmacos: new Set(['Midazolam']),
            protocolos: new Set(['Sedacao_Analgesia_VM']),
            origem: new Map()
        }, leito);
        assert.ok(!r.constraints.protocolosAtivos.some(p => p.nome === 'Sedacao_Analgesia_VM'),
            'pre-condicao: sem gatilho ativo');
        assert.ok(decisoesDe(r.antes, 'Midazolam').includes('INICIAR_INFUSAO'), 'pre-condicao: antes do foco podia iniciar');

        const midazolam = r.depois.politicas.find(p => p.item === 'Midazolam')!;
        assert.equal(midazolam.bloqueado, true);
        assert.ok(!midazolam.decisoes.includes('INICIAR_INFUSAO'));
        assert.ok(midazolam.motivos.some(m => m.startsWith('vetado por protocolo Sedacao_Analgesia_VM')));
        assert.ok(apenasEstreitou(r.antes, r.depois));
    });

    console.log('\n[agro e fut]');

    /** O relato de `foco.test.ts`: pedido sobre cana, Soja e Milho ativos. */
    const TALHAO: AgroContext = {
        talhao: 'TL-2026-1101',
        telemetria: {
            vento: 8, temperatura: 38, umidade: 56, NDVI: 0.81, umidade_foliar: 40,
            temperatura_foliar: 36, distancia_manancial: 352, distancia_cultura_sensivel: 400,
            chuva_prevista: 0, infestacao: 38
        },
        areas: [],
        produtosEmUso: ['Clorpirifos', 'Nicosulfuron'],
        intencao: 'A cana tá com a folha fervendo, começa o imidacloprido.'
    };

    async function focarAgro() {
        const constraints = retrieveAgroConstraints(agro, TALHAO);
        const foco = await retrieverFocoAgro(SEM_SESSAO, TALHAO.intencao!, agro, SEM_SINAL);
        const focadas = filtrarPorFocoAgro(constraints, foco, agro, TALHAO);
        return {
            constraints, foco, focadas,
            antes: agroPruningPayload(constraints, TALHAO),
            depois: agroPruningPayload(focadas, TALHAO)
        };
    }

    await teste('agro: o veto do Milho ativo ao Dois_Quatro_D sobrevive ao foco na cana', async () => {
        const r = await focarAgro();
        assert.ok(r.constraints.culturasAtivas.some(c => c.nome === 'Milho'), 'pre-condicao: Milho ativo');
        assert.ok(!r.foco.culturas.has('Milho') && r.foco.produtos.has('Dois_Quatro_D'),
            'pre-condicao: Milho fora do foco, Dois_Quatro_D dentro');

        const politica = r.depois.politicas.find(p => p.item === 'Dois_Quatro_D')!;
        assert.equal(politica.bloqueado, true, 'o veto ativo do Milho virou permissao');
        assert.ok(!politica.decisoes.includes('INICIAR_APLICACAO'));
        assert.deepEqual(politica.decisoes, decisoesDe(r.antes, 'Dois_Quatro_D'));
        assert.ok(r.focadas.vetados.some(v => v.produto === 'Dois_Quatro_D' && v.cultura === 'Milho'),
            'o prompt perdeu a linha que explica o veto');
    });

    await teste('agro: estado de curso e veto da cana em foco estreitam o Nicosulfuron', async () => {
        const r = await focarAgro();
        const politica = r.depois.politicas.find(p => p.item === 'Nicosulfuron')!;
        assert.ok(!politica.decisoes.includes('INICIAR_APLICACAO'), 'ja na calda: iniciar nao pode voltar');
        assert.equal(politica.bloqueado, true);
        assert.ok(politica.motivos.some(m => m.startsWith('vetado por cultura Cana_de_Acucar')));
        assert.ok(apenasEstreitou(r.antes, r.depois));
    });

    await teste('agro: Soja e Milho seguem fora do escopo do prompt', async () => {
        const r = await focarAgro();
        assert.deepEqual(r.focadas.culturasAtivas.map(c => c.nome), ['Cana_de_Acucar']);
        assert.ok(r.focadas.recomendados.every(x => x.cultura === 'Cana_de_Acucar'));
        // Nos vetos, so como ORIGEM de veto sobre produto que continua em foco.
        for (const v of r.focadas.vetados) {
            assert.ok(r.foco.produtos.has(v.produto), `veto sobre ${v.produto}, fora do foco`);
        }
    });

    await teste('fut: o veto do Penalti_Na_Area ativo ao Impedimento sobrevive ao foco', async () => {
        const partida: FutContext = { ...LEITURA_FUT, intencao: 'foi impedimento' };
        const constraints = retrieveFutConstraints(fut, partida);
        const foco = await retrieverFocoFut(SEM_SESSAO, partida.intencao!, fut, SEM_SINAL);
        assert.ok(constraints.lancesAtivos.some(l => l.nome === 'Penalti_Na_Area'), 'pre-condicao: lance ativo');
        assert.ok(!foco.lances.has('Penalti_Na_Area') && foco.infracoes.has('Impedimento'),
            'pre-condicao: lance que veta fora do foco, infracao dentro');

        const antes = futPruningPayload(constraints, partida);
        const focadas = filtrarPorFocoFut(constraints, foco, fut, partida);
        const depois = futPruningPayload(focadas, partida);
        assert.deepEqual(decisoesDe(depois, 'Impedimento'), decisoesDe(antes, 'Impedimento'));
        assert.equal(depois.politicas.find(p => p.item === 'Impedimento')!.bloqueado, true);
        assert.ok(focadas.vetados.some(v => v.infracao === 'Impedimento' && v.lance === 'Penalti_Na_Area'));
    });

    console.log('\n[caso 4: nenhum foco amplia, em 200 cenarios por dominio]');

    const nm = nomesMed(med);
    const na = nomesAgro(agro);
    const nf = nomesFut(fut);
    // Um dominio com 200 cenarios e N focos por cenario: abaixo disto, algo parou
    // de rodar e o teste passaria sem ter olhado nada.
    const MINIMO_COMPARACOES = 200 * 10;

    await teste('caso 4 (med): apenasEstreitou(antes do foco, depois do foco) em todo cenario', async () => {
        const r = await nenhumFocoAmplia<ClinicalContext, ReturnType<typeof retrieveConstraints>, Foco>({
            arquivo: 'src/examples/med/cenarios-200-med.jsonl',
            itens: nm.farmacos,
            contextos: nm.protocolos,
            recuperar: c => retrieveConstraints(med, c),
            podar: (k, c) => pruningPayload(k, c),
            filtrar: (k, f, c) => filtrarPorFoco(k, f, med, c),
            focoDaFala: fala => retrieverFoco(SEM_SESSAO, fala, med, SEM_SINAL),
            montarFoco: (i, c) => ({ farmacos: i, protocolos: c, origem: new Map() })
        });
        assert.ok(r.comparacoes >= MINIMO_COMPARACOES, `so ${r.comparacoes} comparacoes`);
        assert.deepEqual(r.achados.slice(0, 5), [], `${r.achados.length} ampliacao(oes) em ${r.comparacoes}`);
        console.log(`       ${r.comparacoes} comparacoes`);
    });

    await teste('caso 4 (agro): apenasEstreitou(antes do foco, depois do foco) em todo cenario', async () => {
        const r = await nenhumFocoAmplia<AgroContext, ReturnType<typeof retrieveAgroConstraints>, AgroFoco>({
            arquivo: 'src/examples/agro/cenarios-200-agro.jsonl',
            itens: na.produtos,
            contextos: na.culturas,
            recuperar: c => retrieveAgroConstraints(agro, c),
            podar: (k, c) => agroPruningPayload(k, c),
            filtrar: (k, f, c) => filtrarPorFocoAgro(k, f, agro, c),
            focoDaFala: fala => retrieverFocoAgro(SEM_SESSAO, fala, agro, SEM_SINAL),
            montarFoco: (i, c) => ({ produtos: i, culturas: c, origem: new Map() })
        });
        assert.ok(r.comparacoes >= MINIMO_COMPARACOES, `so ${r.comparacoes} comparacoes`);
        assert.deepEqual(r.achados.slice(0, 5), [], `${r.achados.length} ampliacao(oes) em ${r.comparacoes}`);
        console.log(`       ${r.comparacoes} comparacoes`);
    });

    await teste('caso 4 (fut): apenasEstreitou(antes do foco, depois do foco) em todo cenario', async () => {
        const r = await nenhumFocoAmplia<FutContext, ReturnType<typeof retrieveFutConstraints>, FutFoco>({
            arquivo: 'src/examples/fut/cenarios-200-fut.jsonl',
            itens: nf.infracoes,
            contextos: nf.lances,
            recuperar: c => retrieveFutConstraints(fut, c),
            podar: (k, c) => futPruningPayload(k, c),
            filtrar: (k, f, c) => filtrarPorFocoFut(k, f, fut, c),
            focoDaFala: fala => retrieverFocoFut(SEM_SESSAO, fala, fut, SEM_SINAL),
            montarFoco: (i, c) => ({ infracoes: i, lances: c, origem: new Map() })
        });
        assert.ok(r.comparacoes >= MINIMO_COMPARACOES, `so ${r.comparacoes} comparacoes`);
        assert.deepEqual(r.achados.slice(0, 5), [], `${r.achados.length} ampliacao(oes) em ${r.comparacoes}`);
        console.log(`       ${r.comparacoes} comparacoes`);
    });

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
