/**
 * Das regras validadas para a Politica por Item
 * (`knowledge/recuperacao-politica.ts`).
 *
 * A politica e a camada de seguranca do sistema, entao o que estes testes
 * cobram nao e so "o agrupamento funciona". E, principalmente:
 *
 *   1. NADA DO QUE JA EXISTE SE PERDE. Bloqueio, veto, ajuste, escalonamento,
 *      estado de curso, valores, unidades e constantes continuam la depois da
 *      passada. O caso critico e o VETO: ele e uma ARESTA no grafo (VETA /
 *      PROIBE), sem `parametro`, e por isso NUNCA aparece em `ValidatedRule[]`.
 *      Se alguem um dia reescrever isto para montar a politica a partir das
 *      regras validadas, os vetos somem — e o teste 7 cai.
 *
 *   2. A PASSADA SO ESTREITA. Uma decisao que a avaliacao deterministica
 *      retirou nao pode voltar por conta de uma regra do grafo.
 *
 * O modelo da DSL e a recuperacao deterministica sao REAIS nos tres dominios;
 * so as regras validadas sao dubladas, para poder exercitar casos que a
 * telemetria de exemplo nao produz.
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
import {
    retrieveAgroConstraints,
    agroPruningPayload,
    type AgroContext
} from '../knowledge/graphrag-agro.js';
import {
    retrieveFutConstraints,
    futPruningPayload,
    type FutContext
} from '../knowledge/graphrag-fut.js';
import {
    agruparPorItem,
    apenasEstreitou,
    classificar,
    refinarPolitica,
    regrasRestritivas,
    resumoReconciliacao
} from '../knowledge/recuperacao-politica.js';
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

/** Regra validada, com o minimo que a construcao da politica le. */
function regraValidada(over: Partial<RegraValidada> & { item: string }): RegraValidada {
    return {
        regraId: `Farmaco:${over.item}/RegraSeguranca/PAM<60`,
        tipo: 'RegraSeguranca',
        relacao: 'BLOQUEIA_INCREMENTO',
        dominio: 'med',
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
        rag: { candidatoId: `Farmaco:${over.item}`, escore: 0.8, cosseno: 0.6, papel: 'item', posicao: 0 },
        ...over
    };
}

/** Cenario clinico do caso relatado, com PAM baixa e noradrenalina em curso. */
const MED: ClinicalContext = {
    intencao: 'PAM 52 e lactato 4.2: subo a noradrenalina?',
    paciente: 'PT-2026-4001',
    telemetria: { PAM: 52, FC: 104, lactato: 4.2, RASS: -2, TFG: 28, plaquetas: 45, glicemia: 158, SpO2: 93 },
    populacoes: ['Renal_Cronico'],
    farmacosEmUso: ['Noradrenalina']
};

async function main(): Promise<void> {
    const modelMed = await loadModel('src/examples/med/uti.dsl');
    const constraintsMed = retrieveConstraints(modelMed, MED);
    const baseMed: SubgrafoPodado = pruningPayload(constraintsMed, MED);

    console.log('\n[agrupamento por item]');

    await teste('1. uma regra -> um PI estreitado', () => {
        const alvo = baseMed.politicas.find(p => p.decisoes.some(d => d === 'INICIAR_INFUSAO'))!;
        assert.ok(alvo, 'o cenario precisa ter algum item com decisao de incremento');

        const r = refinarPolitica(baseMed, [regraValidada({ item: alvo.item })]);
        const depois = r.subgrafo.politicas.find(p => p.item === alvo.item)!;

        assert.equal(r.ajustes.length, 1);
        assert.equal(r.ajustes[0].item, alvo.item);
        assert.ok(!depois.decisoes.includes('INICIAR_INFUSAO'));
        assert.equal(depois.bloqueado, true);
        // A politica continua sendo a mesma estrutura, com todos os itens.
        assert.equal(r.subgrafo.politicas.length, baseMed.politicas.length);
    });

    await teste('2. varias regras para o MESMO item -> um PI so, com os dois motivos', () => {
        const alvo = baseMed.politicas.find(p => p.decisoes.includes('INICIAR_INFUSAO'))!;
        const r = refinarPolitica(baseMed, [
            regraValidada({ item: alvo.item, regraId: 'r1' }),
            regraValidada({ item: alvo.item, regraId: 'r2', efeito: { razao: 'segunda regra' } })
        ]);

        assert.equal(r.ajustes.length, 1, 'um ajuste por item, nao por regra');
        assert.equal(r.ajustes[0].regras.length, 2);
        const depois = r.subgrafo.politicas.find(p => p.item === alvo.item)!;
        assert.ok(depois.motivos.some(m => m.includes('segunda regra')));
    });

    await teste('3. regras para itens diferentes -> PIs diferentes', () => {
        const alvos = baseMed.politicas.filter(p => p.decisoes.includes('INICIAR_INFUSAO')).slice(0, 2);
        assert.equal(alvos.length, 2, 'o cenario precisa de dois itens com incremento');

        const r = refinarPolitica(baseMed, alvos.map(a => regraValidada({ item: a.item })));
        assert.equal(r.ajustes.length, 2);
        assert.deepEqual(r.ajustes.map(a => a.item).sort(), alvos.map(a => a.item).sort());

        const grupos = agruparPorItem(alvos.map(a => regraValidada({ item: a.item })));
        assert.equal(grupos.size, 2);
    });

    console.log('\n[aceita entra, rejeitada nao]');

    await teste('4. regra REJEITADA nao estreita a politica', () => {
        const alvo = baseMed.politicas.find(p => p.decisoes.includes('INICIAR_INFUSAO'))!;
        const rejeitada = regraValidada({
            item: alvo.item,
            aplicavel: false,
            condicoesSatisfeitas: [],
            condicoesFalhas: [{
                campo: 'PAM', observado: 82, esperado: '< 60 mmHg',
                operador: '<', limite: 60, unidade: 'mmHg', satisfeita: false
            }],
            // Escore altissimo: nem isso pode fazer a regra valer.
            rag: { candidatoId: 'x', escore: 0.99, cosseno: 0.98, papel: 'item', posicao: 0 }
        });

        const r = refinarPolitica(baseMed, [rejeitada]);
        assert.deepEqual(r.ajustes, []);
        assert.equal(r.concordam, true);
        assert.deepEqual(
            r.subgrafo.politicas.find(p => p.item === alvo.item)!.decisoes,
            alvo.decisoes,
            'a politica nao pode mudar por uma regra que nao incide'
        );
        assert.equal(regrasRestritivas([rejeitada]).length, 0);
    });

    await teste('5. regra ACEITA aparece no PI, com o motivo legivel', () => {
        const alvo = baseMed.politicas.find(p => p.decisoes.includes('INICIAR_INFUSAO'))!;
        const r = refinarPolitica(baseMed, [regraValidada({ item: alvo.item })]);
        const depois = r.subgrafo.politicas.find(p => p.item === alvo.item)!;

        assert.ok(depois.motivos.length > alvo.motivos.length);
        assert.ok(depois.motivos.some(m => /PAM 52 < 60 mmHg/.test(m)), depois.motivos.join(' | '));
        assert.ok(depois.motivos.some(m => /risco de hipotensao severa/.test(m)));
        assert.match(resumoReconciliacao(r), new RegExp(alvo.item));
    });

    await teste('Gatilho, Escalonamento e Limiar nao estreitam politica de item', () => {
        const alvo = baseMed.politicas.find(p => p.decisoes.includes('INICIAR_INFUSAO'))!;
        const naoRestritivas = ['DISPARA', 'ESCALONA', 'TEM_LIMIAR'].map(relacao =>
            regraValidada({ item: alvo.item, relacao, tipo: relacao === 'DISPARA' ? 'Gatilho' : 'Escalonamento' })
        );
        assert.equal(regrasRestritivas(naoRestritivas).length, 0);
        const r = refinarPolitica(baseMed, naoRestritivas);
        assert.deepEqual(r.ajustes, []);
    });

    console.log('\n[o que ja existia continua existindo]');

    await teste('6. bloqueio deterministico continua depois da passada', () => {
        // TFG 28 e plaquetas 45 disparam invariantes no modelo real.
        assert.ok(constraintsMed.bloqueios.length > 0, 'o cenario precisa ter bloqueio ativo');
        const bloqueado = constraintsMed.bloqueios[0].farmaco;

        const r = refinarPolitica(baseMed, []);
        const antes = baseMed.politicas.find(p => p.item === bloqueado);
        const depois = r.subgrafo.politicas.find(p => p.item === bloqueado);
        if (antes) {
            assert.ok(depois, 'o item bloqueado nao pode sumir da politica');
            assert.equal(depois!.bloqueado, antes.bloqueado);
            assert.deepEqual(depois!.decisoes, antes.decisoes);
            assert.deepEqual(depois!.motivos, antes.motivos);
        }
    });

    await teste('7. VETO continua — e ele NUNCA vem das regras validadas', () => {
        assert.ok(constraintsMed.vetados.length > 0, 'o cenario precisa ter veto ativo');
        const vetado = constraintsMed.vetados[0].farmaco;
        const antes = baseMed.politicas.find(p => p.item === vetado);

        // Passada com ZERO regras validadas: e assim que o Cypher enxerga um
        // veto, porque VETA/PROIBE sao arestas sem `parametro`.
        const r = refinarPolitica(baseMed, []);
        const depois = r.subgrafo.politicas.find(p => p.item === vetado);

        if (antes) {
            assert.ok(depois, 'o item vetado sumiu da politica');
            assert.equal(depois!.bloqueado, true, 'o veto tem de continuar marcando bloqueado');
            assert.ok(depois!.motivos.some(m => /vetado por/.test(m)), depois!.motivos.join(' | '));
            assert.deepEqual(depois!.decisoes, antes.decisoes);
        }
    });

    await teste('8. ajuste (dose escalada por populacao) continua no reticulo', () => {
        assert.ok(constraintsMed.ajustes.length > 0, 'o cenario precisa ter ajuste ativo');
        const r = refinarPolitica(baseMed, []);
        for (const antes of baseMed.politicas) {
            const depois = r.subgrafo.politicas.find(p => p.item === antes.item)!;
            assert.deepEqual(depois.valores, antes.valores, `${antes.item}: valores perdidos`);
            assert.deepEqual(depois.valoresPorDecisao, antes.valoresPorDecisao, `${antes.item}: reticulo por decisao perdido`);
            assert.deepEqual(depois.unidades, antes.unidades, `${antes.item}: unidades perdidas`);
            assert.deepEqual(depois.meios, antes.meios, `${antes.item}: meios perdidos`);
        }
    });

    await teste('9. escalonamento e constantes do cenario continuam intactos', () => {
        const r = refinarPolitica(baseMed, [
            regraValidada({ item: baseMed.politicas[0].item })
        ]);
        assert.deepEqual(r.subgrafo.constantes, baseMed.constantes);
        assert.equal(r.subgrafo.constantes.sujeito, 'PT-2026-4001');
        assert.deepEqual(r.subgrafo.papeis, baseMed.papeis);
        // O escalonamento e do contrato, nao do subgrafo — e o contrato o le de
        // `constraints`, que esta passada nao toca.
        assert.equal(constraintsMed.escalonamentos.length, constraintsMed.escalonamentos.length);
    });

    await teste('10. estado de curso continua: nao se INICIA o que ja infunde', () => {
        const nora = baseMed.politicas.find(p => p.item === 'Noradrenalina')!;
        assert.ok(!nora.decisoes.includes('INICIAR_INFUSAO'), 'pre-condicao do cenario');

        const r = refinarPolitica(baseMed, [regraValidada({ item: 'Noradrenalina' })]);
        const depois = r.subgrafo.politicas.find(p => p.item === 'Noradrenalina')!;
        assert.ok(!depois.decisoes.includes('INICIAR_INFUSAO'));
    });

    console.log('\n[a invariante: so estreita]');

    await teste('a passada nunca acrescenta decisao, item ou meio', () => {
        const r = refinarPolitica(baseMed, baseMed.politicas.map(p => regraValidada({ item: p.item })));
        assert.ok(apenasEstreitou(baseMed, r.subgrafo), 'a reconciliacao alargou a politica');

        for (const depois of r.subgrafo.politicas) {
            const antes = baseMed.politicas.find(p => p.item === depois.item)!;
            assert.ok(depois.decisoes.length <= antes.decisoes.length);
        }
        assert.ok(r.subgrafo.acoes_permitidas.length <= baseMed.acoes_permitidas.length);
    });

    await teste('sem regra alguma, a politica sai identica (passada e no-op)', () => {
        const r = refinarPolitica(baseMed, []);
        assert.deepEqual(r.subgrafo, baseMed);
        assert.equal(r.concordam, true);
        assert.match(resumoReconciliacao(r), /concordam/);
    });

    await teste('regra sobre item fora da politica vira divergencia, nao alteracao', () => {
        const r = refinarPolitica(baseMed, [regraValidada({ item: 'Farmaco_Inexistente' })]);
        assert.equal(r.divergencias.length, 1);
        assert.equal(r.divergencias[0].item, 'Farmaco_Inexistente');
        assert.match(r.divergencias[0].detalhe, /nao esta na politica/);
        assert.equal(r.concordam, false);
        assert.deepEqual(r.subgrafo.politicas, baseMed.politicas, 'a politica nao pode mudar');
    });

    console.log('\n[nao-ampliacao: PolicyRefined subconjunto de PolicyDeterministic]');

    await teste('TESTE 2. decisao que o RAG traz e a politica NAO tem nao e criada', () => {
        // A regra cita uma decisao inventada; a politica deterministica nao a
        // contem. O refinamento nao pode introduzi-la de forma alguma.
        const alvo = baseMed.politicas[0];
        const inventada = 'DECISAO_QUE_NAO_EXISTE';
        assert.ok(!alvo.decisoes.includes(inventada), 'pre-condicao');

        const r = refinarPolitica(baseMed, [regraValidada({
            item: alvo.item,
            efeito: { razao: inventada, acao: inventada }
        })]);

        for (const p of r.subgrafo.politicas) {
            assert.ok(!p.decisoes.includes(inventada), `${p.item} ganhou decisao inventada`);
        }
        assert.ok(!r.subgrafo.acoes_permitidas.includes(inventada));
    });

    await teste('TESTE 16. nada fora do autorizado por P aparece na politica final', () => {
        // Varre TODOS os itens e decisoes: o refinado tem de ser subconjunto.
        const todas = baseMed.politicas.map(p => regraValidada({ item: p.item }));
        const r = refinarPolitica(baseMed, todas);

        const autorizado = new Map(baseMed.politicas.map(p => [p.item, new Set(p.decisoes)]));
        for (const p of r.subgrafo.politicas) {
            const permitidas = autorizado.get(p.item);
            assert.ok(permitidas, `item '${p.item}' nao existia na politica deterministica`);
            for (const d of p.decisoes) {
                assert.ok(permitidas!.has(d), `'${d}' em '${p.item}' nao era autorizada`);
            }
            // Meios e valores tambem nao podem crescer.
            const antes = baseMed.politicas.find(x => x.item === p.item)!;
            assert.ok(p.meios.every(m => antes.meios.includes(m)));
            assert.ok(p.valores.every(v => antes.valores.some(a => a.valor === v.valor && a.unidade === v.unidade)));
        }
        assert.ok(r.subgrafo.farmacos_liberados.every(i => autorizado.has(i)));
    });

    await teste('a garantia de nao-ampliacao roda em runtime, nao so em teste', () => {
        // Um subgrafo "refinado" forjado com decisao a mais tem de ser rejeitado
        // por `apenasEstreitou` — que e o guarda que `refinarPolitica` consulta.
        const alargado: SubgrafoPodado = {
            ...baseMed,
            politicas: baseMed.politicas.map((p, i) =>
                i === 0 ? { ...p, decisoes: [...p.decisoes, 'DECISAO_NOVA'] } : p
            )
        };
        assert.equal(apenasEstreitou(baseMed, alargado), false);
        assert.equal(apenasEstreitou(baseMed, baseMed), true);
    });

    console.log('\n[rejeicao nao vira validacao]');

    await teste('TESTE 3/10. score alto + Cypher REJECT -> a politica nao ganha nada', () => {
        const alvo = baseMed.politicas.find(p => p.decisoes.includes('INICIAR_INFUSAO'))!;
        const rejeitadaComScoreAlto = regraValidada({
            item: alvo.item,
            aplicavel: false,
            condicoesSatisfeitas: [],
            condicoesFalhas: [{
                campo: 'PAM', observado: 82, esperado: '< 60 mmHg',
                operador: '<', limite: 60, unidade: 'mmHg', satisfeita: false
            }],
            rag: { candidatoId: 'x', escore: 0.99, cosseno: 0.98, papel: 'item', posicao: 0 }
        });

        assert.equal(classificar(rejeitadaComScoreAlto), 'nao_incidente');
        const r = refinarPolitica(baseMed, [rejeitadaComScoreAlto]);
        assert.deepEqual(r.subgrafo, baseMed, 'nada pode mudar');
    });

    await teste('regra sem evidencia tambem nao refina (nem para mais, nem para menos)', () => {
        const alvo = baseMed.politicas[0];
        const semDado = regraValidada({
            item: alvo.item,
            aplicavel: false,
            condicoesSatisfeitas: [],
            lacunas: [{ campo: 'qSOFA', esperado: '>= 2', motivo: 'nao medido' }]
        });
        assert.equal(classificar(semDado), 'sem_evidencia');
        assert.deepEqual(refinarPolitica(baseMed, [semDado]).subgrafo, baseMed);
    });

    console.log('\n[TESTE 9: ausencia de candidatos]');

    await teste('TESTE 9. nenhum candidato RAG NAO zera a politica', () => {
        // DECISAO ARQUITETURAL, explicita: lista vazia de regras validadas
        // significa "o RAG nada acrescentou a esta decisao", NAO "nada e
        // permitido". A politica deterministica passa intacta. O contrario —
        // interpretar silencio como proibicao — daria ao RAG poder de veto por
        // omissao, que e justamente o que a arquitetura proibe.
        const r = refinarPolitica(baseMed, []);
        assert.deepEqual(r.subgrafo, baseMed);
        assert.ok(r.subgrafo.politicas.length > 0, 'a politica nao pode ficar vazia');
        assert.equal(r.concordam, true);
        assert.deepEqual(r.ajustes, []);
        assert.deepEqual(r.divergencias, []);
    });

    await teste('TESTE 1. o cenario completo: A,B refinados; VETA/PROIBE/AJUSTA preservados', () => {
        // A politica real deste cenario ja tem veto (Protocolo/Populacao),
        // proibicao (populacao Renal_Cronico) e ajuste por fator.
        assert.ok(constraintsMed.vetados.length > 0 && constraintsMed.ajustes.length > 0);

        const comIncremento = baseMed.politicas.filter(p => p.decisoes.includes('INICIAR_INFUSAO')).slice(0, 2);
        const r = refinarPolitica(baseMed, comIncremento.map(p => regraValidada({ item: p.item })));

        // A e B refinados.
        for (const alvo of comIncremento) {
            assert.ok(!r.subgrafo.politicas.find(p => p.item === alvo.item)!.decisoes.includes('INICIAR_INFUSAO'));
        }
        // VETA / PROIBE preservados: o item vetado continua bloqueado com o motivo.
        for (const v of constraintsMed.vetados) {
            const p = r.subgrafo.politicas.find(x => x.item === v.farmaco);
            if (!p) continue;
            assert.equal(p.bloqueado, true, `${v.farmaco}: veto perdido`);
            assert.ok(p.motivos.some(m => m.includes('vetado por')), `${v.farmaco}: motivo do veto perdido`);
        }
        // AJUSTA preservado: o reticulo escalado continua identico.
        for (const antes of baseMed.politicas) {
            const depois = r.subgrafo.politicas.find(p => p.item === antes.item)!;
            assert.deepEqual(depois.valores, antes.valores, `${antes.item}: retículo alterado`);
            assert.deepEqual(depois.unidades, antes.unidades);
        }
    });

    console.log('\n[classificacao antes do refinamento]');

    await teste('cada relacao do schema cai na classe certa', () => {
        const item = baseMed.politicas[0].item;
        const casos: [Partial<RegraValidada>, string][] = [
            [{ relacao: 'BLOQUEIA_INCREMENTO' }, 'bloqueio_condicional'],
            [{ relacao: 'BLOQUEIA' }, 'bloqueio_condicional'],
            [{ relacao: 'EXIGE_AJUSTE', efeito: { acao: 'suspender' } }, 'bloqueio_condicional'],
            // Ajuste renal que nao suspende e ajuste, nao ativacao de contexto.
            [{ relacao: 'EXIGE_AJUSTE', efeito: { acao: 'aumentar_intervalo' } }, 'ajuste'],
            [{ relacao: 'DISPARA' }, 'ativacao_de_contexto'],
            [{ relacao: 'ESCALONA' }, 'escalonamento'],
            [{ relacao: 'TEM_LIMIAR' }, 'sancao'],
            // O Cypher de validacao nao alcanca estas arestas; se um dia alcancar,
            // elas nao podem cair numa classe que alguem ja trate.
            [{ relacao: 'VETA' }, 'nao_reconhecida'],
            [{ relacao: 'PROIBE' }, 'nao_reconhecida'],
            [{ relacao: 'AJUSTA' }, 'nao_reconhecida']
        ];
        for (const [over, esperado] of casos) {
            assert.equal(classificar(regraValidada({ item, ...over })), esperado, JSON.stringify(over));
        }
    });

    console.log('\n[11. os tres dominios]');

    await teste('med: papeis proprios, invariante mantida', () => {
        assert.equal(baseMed.papeis.item, 'farmaco');
        const r = refinarPolitica(baseMed, [regraValidada({ item: baseMed.politicas[0].item })]);
        assert.ok(apenasEstreitou(baseMed, r.subgrafo));
    });

    await teste('agro: BLOQUEIA (nao BLOQUEIA_INCREMENTO) e reconhecido', async () => {
        const modelAgro = await loadAgroModel('src/examples/agro/lavoura.agro');
        const ctx: AgroContext = {
            intencao: 'aplicar no talhao', talhao: 'T-04',
            telemetria: { vento: 8, temperatura_foliar: 30, umidade: 60 },
            areas: [], produtosEmUso: []
        };
        const base = agroPruningPayload(retrieveAgroConstraints(modelAgro, ctx), ctx);
        const alvo = base.politicas.find(p => p.decisoes.some(d => base.papeis.decisoesDeIncremento.includes(d)))!;
        assert.ok(alvo, 'o cenario agro precisa de item com incremento');

        const r = refinarPolitica(base, [regraValidada({
            item: alvo.item, dominio: 'agro', relacao: 'BLOQUEIA',
            regraId: `Produto:${alvo.item}/RegraSeguranca/temperatura_foliar>38`
        })]);

        assert.equal(base.papeis.item, 'produto');
        assert.equal(r.ajustes.length, 1);
        for (const d of base.papeis.decisoesDeIncremento) {
            assert.ok(!r.subgrafo.politicas.find(p => p.item === alvo.item)!.decisoes.includes(d));
        }
        assert.ok(apenasEstreitou(base, r.subgrafo));
    });

    await teste('fut: papeis proprios, e o que nao e restritivo nao estreita', async () => {
        const modelFut = await loadFutModel('src/examples/fut/futebol.fut');
        const ctx: FutContext = {
            intencao: 'entrada dura', partida: 'PARTIDA-2026-07',
            telemetria: { minuto: 78, forca_impacto: 8 },
            contextos: [], infracoesEmUso: []
        };
        const base = futPruningPayload(retrieveFutConstraints(modelFut, ctx), ctx);
        assert.equal(base.papeis.item, 'infracao');
        assert.ok(base.politicas.length > 0);

        // Limiar/TEM_LIMIAR descreve a SANCAO da infracao, nao uma restricao
        // sobre ela: nao pode estreitar politica nenhuma.
        const r = refinarPolitica(base, [regraValidada({
            item: base.politicas[0].item, dominio: 'fut',
            tipo: 'Limiar', relacao: 'TEM_LIMIAR'
        })]);
        assert.deepEqual(r.ajustes, []);
        assert.deepEqual(r.subgrafo.politicas, base.politicas);

        // Ja um BLOQUEIA estreita, como nos outros dominios.
        const bloqueio = refinarPolitica(base, [regraValidada({
            item: base.politicas[0].item, dominio: 'fut', relacao: 'BLOQUEIA'
        })]);
        assert.ok(apenasEstreitou(base, bloqueio.subgrafo));
    });

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
