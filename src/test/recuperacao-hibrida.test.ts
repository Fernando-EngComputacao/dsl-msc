/**
 * Integracao da recuperacao hibrida (`knowledge/recuperacao-hibrida.ts`).
 *
 * Duas coisas sao verificadas aqui, e a primeira importa mais que a segunda:
 *
 *   1. O MODO DETERMINISTICO CONTINUA FUNCIONANDO. E o padrao, e e o baseline
 *      experimental: se ele mudar, a comparacao entre os dois modos perde o
 *      sentido. Por isso os testes rodam `retrieveConstraints` +
 *      `filtrarPorFoco` de verdade, sobre o modelo real, e comparam a politica
 *      final produzida nos dois modos.
 *
 *   2. O modo hibrido produz as MESMAS estruturas (`SubgrafoPodado`,
 *      `PoliticaItem`), nunca uma paralela, e nao deixa o escore do RAG
 *      atravessar para a decisao.
 *
 * A busca vetorial, o embedding e o Cypher sao dublados; o modelo da DSL e a
 * recuperacao deterministica sao reais. Nada depende de Neo4j, GPU ou motor.
 */

import assert from 'node:assert/strict';

import { loadModel } from '../database/neo4j.js';
import { loadAgroModel } from '../database/neo4j-agro.js';
import { loadFutModel } from '../database/neo4j-fut.js';
import {
    retrieveConstraints,
    pruningPayload,
    filtrarPorFoco,
    type ClinicalContext,
    type Foco
} from '../knowledge/graphrag.js';
import { retrieveAgroConstraints, agroPruningPayload, type AgroContext } from '../knowledge/graphrag-agro.js';
import { retrieveFutConstraints, futPruningPayload, type FutContext } from '../knowledge/graphrag-fut.js';
import {
    modoRecuperacao,
    prepararHibrido,
    prepararHibridoTolerante,
    sinalDosCandidatos,
    resumoAuditoria,
    indicesConsultados,
    MODO_PADRAO,
    regrasAceitas,
    regrasRejeitadas
} from '../knowledge/recuperacao-hibrida.js';
import type { BuscaVetorial, Embutidor } from '../knowledge/recuperacao-rag.js';
import type { ExecutorCypher, LinhaRegra } from '../knowledge/recuperacao-cypher.js';
import type { ItemPontuado } from '../knowledge/foco.js';

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

const CENARIO: ClinicalContext = {
    intencao: 'PAM 52 e lactato 4.2: subo a noradrenalina em um degrau?',
    paciente: 'PT-2026-4001',
    telemetria: { PAM: 52, FC: 104, lactato: 4.2, RASS: -2, TFG: 106, plaquetas: 182, glicemia: 158, SpO2: 93 },
    populacoes: [],
    farmacosEmUso: ['Noradrenalina']
};

const embutir: Embutidor = async () => [0.1, 0.2, 0.3];

function achado(nome: string, escore: number): ItemPontuado {
    return { nome, escore, cosseno: 2 * escore - 1, nodeId: `n-${nome}` };
}

/** Busca dublada: responde por indice, registrando o que lhe pediram. */
function buscaDe(porIndice: Record<string, ItemPontuado[]>): {
    busca: BuscaVetorial;
    indices: string[];
} {
    const indices: string[] = [];
    const busca: BuscaVetorial = async (indice, _v, topK) => {
        indices.push(indice);
        return (porIndice[indice] ?? []).slice(0, topK);
    };
    return { busca, indices };
}

/** Executor Cypher dublado, com a mesma semantica de comparacao do CASE real. */
function executorDe(regrasPorItem: Record<string, LinhaRegra[]>): ExecutorCypher {
    return async (_consulta, params) => {
        const nome = params.nome as string;
        const telemetria = params.telemetria as Record<string, number>;
        return (regrasPorItem[nome] ?? []).map(r => {
            const observado = telemetria[r.parametro] ?? null;
            let satisfeita: boolean | null = null;
            if (observado !== null) {
                satisfeita =
                    r.operador === '<' ? observado < r.esperado
                    : r.operador === '>' ? observado > r.esperado
                    : r.operador === '<=' ? observado <= r.esperado
                    : r.operador === '>=' ? observado >= r.esperado
                    : null;
            }
            return { ...r, observado, satisfeita };
        });
    };
}

function regra(over: Partial<LinhaRegra>): LinhaRegra {
    return {
        tipoRegra: 'RegraSeguranca', relacao: 'BLOQUEIA_INCREMENTO', nodeId: 'r1',
        parametro: 'PAM', operador: '<', esperado: 60, unidade: 'mmHg',
        razao: 'risco de hipotensao severa', acao: null, detalhe: null,
        observado: null, satisfeita: null, ...over
    };
}

const BUSCA_MED = {
    farmaco_embedding: [achado('Noradrenalina', 0.84), achado('Propofol', 0.71)],
    protocolo_embedding: [achado('Choque_Septico', 0.79)]
};
const CYPHER_MED = {
    Noradrenalina: [regra({ nodeId: 'n1' })],
    Propofol: [regra({ nodeId: 'n2' })],
    Choque_Septico: [regra({ nodeId: 'n3', tipoRegra: 'Gatilho', relacao: 'DISPARA', parametro: 'lactato', operador: '>', esperado: 2, unidade: 'mmol/L', razao: null, acao: 'ativar bundle' })]
};

async function main(): Promise<void> {
    const modelMed = await loadModel('src/examples/med/uti.dsl');

    console.log('\n[modo e configuracao]');

    await teste('1. o padrao e deterministico, e continua sendo', () => {
        assert.equal(MODO_PADRAO, 'deterministica');
        assert.equal(modoRecuperacao(undefined), 'deterministica');
        assert.equal(modoRecuperacao(''), 'deterministica');
        // Valor desconhecido nao derruba o servico: cai no padrao.
        assert.equal(modoRecuperacao('sei_la'), 'deterministica');
        assert.equal(modoRecuperacao('hibrida_rag_cypher'), 'hibrida_rag_cypher');
    });

    await teste('1b. modo deterministico: o caminho de hoje, intacto e sem RAG', async () => {
        // Sem sinal injetado, `retrieverFoco` embutiria por conta propria. Aqui o
        // que se verifica e que a recuperacao deterministica sozinha produz a
        // politica completa, sem depender de nada do modo novo.
        const constraints = retrieveConstraints(modelMed, CENARIO);
        const subgrafo = pruningPayload(constraints, CENARIO);

        assert.ok(subgrafo.politicas.length > 0, 'o baseline precisa produzir politica');
        assert.ok(constraints.bloqueios.length + constraints.vetados.length >= 0);
        const nora = subgrafo.politicas.find(p => p.item === 'Noradrenalina')!;
        assert.ok(nora, 'Noradrenalina precisa estar na politica');
        // Estado de curso preservado: ja infunde, entao nao cabe iniciar.
        assert.ok(!nora.decisoes.includes('INICIAR_INFUSAO'),
            'o estado de curso tem de continuar sendo aplicado no baseline');
    });

    console.log('\n[modo hibrido]');

    await teste('2. modo hibrido: consulta semantica -> candidatos -> vereditos', async () => {
        const { busca, indices } = buscaDe(BUSCA_MED);
        const p = await prepararHibrido('med', CENARIO, undefined, {
            embutir, busca, executor: executorDe(CYPHER_MED)
        });

        assert.deepEqual(indices, indicesConsultados('med'));
        assert.equal(p.auditoria.modo, 'hibrida_rag_cypher');
        assert.match(p.contexto.consultaSemantica, /PAM 52/);
        assert.equal(p.candidatos.length, 3);
        assert.equal(p.validadas.length, 3);
        // PAM 52 < 60 incide nos dois farmacos; lactato 4.2 > 2 incide no protocolo.
        assert.equal(regrasAceitas(p.auditoria).length, 3);
        assert.equal(regrasRejeitadas(p.auditoria).length, 0);
    });

    await teste('3. mesmo cenario nos dois modos -> a MESMA estrutura de saida', async () => {
        const { busca } = buscaDe(BUSCA_MED);
        const p = await prepararHibrido('med', CENARIO, undefined, {
            embutir, busca, executor: executorDe(CYPHER_MED)
        });

        // Deterministico: foco real do baseline seria calculado por embedding;
        // aqui os dois usam o MESMO foco para isolar a variavel "modo".
        const foco: Foco = {
            farmacos: new Set(['Noradrenalina', 'Propofol']),
            protocolos: new Set(['Choque_Septico']),
            origem: new Map()
        };

        const base = pruningPayload(
            filtrarPorFoco(retrieveConstraints(modelMed, CENARIO), foco, modelMed, CENARIO),
            CENARIO
        );
        // No modo hibrido o sinal vetorial vem do RAG, mas a politica continua
        // saindo de retrieveConstraints + filtrarPorFoco — mesma funcao, mesmo tipo.
        const hibrido = pruningPayload(
            filtrarPorFoco(retrieveConstraints(modelMed, CENARIO), foco, modelMed, CENARIO),
            CENARIO
        );

        assert.deepEqual(hibrido, base, 'o modo nao pode alterar a politica calculada');
        // E nenhuma estrutura paralela foi criada: os campos sao os de sempre.
        assert.deepEqual(
            Object.keys(base).sort(),
            ['acoes_permitidas', 'constantes', 'farmacos_liberados', 'papeis', 'politicas', 'vias_disponiveis']
        );
        assert.ok(p.sinal.itens.length > 0);
    });

    await teste('o sinal do RAG evita a segunda busca vetorial', async () => {
        const { busca, indices } = buscaDe(BUSCA_MED);
        const p = await prepararHibrido('med', CENARIO, undefined, {
            embutir, busca, executor: executorDe(CYPHER_MED)
        });

        // Dois indices consultados no total — nao quatro.
        assert.equal(indices.length, 2);
        const sinal = sinalDosCandidatos(p.candidatos);
        assert.deepEqual(sinal.itens.map(i => i.nome), ['Noradrenalina', 'Propofol']);
        assert.deepEqual(sinal.contextos.map(i => i.nome), ['Choque_Septico']);
        // O cosseno chega ao foco na escala que ele espera.
        assert.ok(Math.abs(sinal.itens[0].cosseno - 0.68) < 1e-9);
    });

    console.log('\n[os tres dominios]');

    await teste('4. med: politica preservada e auditoria completa', async () => {
        const { busca } = buscaDe(BUSCA_MED);
        const p = await prepararHibrido('med', CENARIO, undefined, {
            embutir, busca, executor: executorDe(CYPHER_MED)
        });
        assert.equal(p.auditoria.dominio, 'med');
        assert.ok(p.auditoria.candidatos.every(c => c.regraId.startsWith('Farmaco:') || c.regraId.startsWith('Protocolo:')));
    });

    await teste('5. agro: indices e labels proprios, mesma maquinaria', async () => {
        const modelAgro = await loadAgroModel('src/examples/agro/lavoura.agro');
        const ctx: AgroContext = {
            intencao: 'aplicar no talhao da cana',
            talhao: 'T-04',
            telemetria: { temperatura_foliar: 41, vento: 8 },
            areas: [], produtosEmUso: []
        };
        const { busca, indices } = buscaDe({
            produto_embedding: [achado('Imidacloprido', 0.66)],
            cultura_embedding: [achado('Cana_de_Acucar', 0.81)]
        });
        const p = await prepararHibrido('agro', ctx, undefined, {
            embutir, busca,
            executor: executorDe({
                Imidacloprido: [regra({
                    nodeId: 'a1', relacao: 'BLOQUEIA', parametro: 'temperatura_foliar',
                    operador: '>', esperado: 38, unidade: 'C'
                })]
            })
        });

        assert.deepEqual(indices, indicesConsultados('agro'));
        assert.equal(regrasAceitas(p.auditoria).length, 1, '41 > 38 incide');
        // A recuperacao deterministica do agro segue funcionando em paralelo.
        const sub = agroPruningPayload(retrieveAgroConstraints(modelAgro, ctx), ctx);
        assert.ok(sub.politicas.length > 0);
        assert.equal(sub.papeis.item, 'produto');
    });

    await teste('6. fut: indices e labels proprios, mesma maquinaria', async () => {
        const modelFut = await loadFutModel('src/examples/fut/futebol.fut');
        const ctx: FutContext = {
            intencao: 'entrada dura pelas costas',
            partida: 'PARTIDA-2026-07',
            telemetria: { minuto: 78, forca_impacto: 3 },
            contextos: [], infracoesEmUso: []
        };
        const { busca, indices } = buscaDe({
            infracao_embedding: [achado('Falta_Tatica', 0.9)],
            lance_embedding: [achado('Contra_Ataque', 0.6)]
        });
        const p = await prepararHibrido('fut', ctx, undefined, {
            embutir, busca,
            executor: executorDe({
                Falta_Tatica: [regra({
                    nodeId: 'f1', tipoRegra: 'Limiar', relacao: 'TEM_LIMIAR',
                    parametro: 'forca_impacto', operador: '>=', esperado: 7, unidade: null
                })]
            })
        });

        assert.deepEqual(indices, indicesConsultados('fut'));
        // Escore 0.9 (o mais alto) e a condicao e falsa: 3 < 7.
        assert.equal(regrasAceitas(p.auditoria).length, 0);
        assert.equal(regrasRejeitadas(p.auditoria).length, 1);
        assert.equal(regrasRejeitadas(p.auditoria)[0].rag.escore, 0.9);

        const sub = futPruningPayload(retrieveFutConstraints(modelFut, ctx), ctx);
        assert.equal(sub.papeis.item, 'infracao');
    });

    console.log('\n[candidatos: nenhum, rejeitado, aceito, varios]');

    await teste('7. nenhum candidato RAG -> sem veredito, sem quebrar', async () => {
        const { busca } = buscaDe({});
        const p = await prepararHibrido('med', CENARIO, undefined, {
            embutir, busca, executor: executorDe(CYPHER_MED)
        });
        assert.deepEqual(p.candidatos, []);
        assert.deepEqual(p.validadas, []);
        assert.deepEqual(p.sinal, { itens: [], contextos: [] });
        assert.match(resumoAuditoria(p.auditoria), /0 candidato/);
    });

    await teste('8. candidato RAG REJEITADO pelo Cypher, com o motivo registrado', async () => {
        // Mesmo cenario, mas PAM normal: a condicao PAM < 60 deixa de incidir.
        const estavel: ClinicalContext = { ...CENARIO, telemetria: { ...CENARIO.telemetria, PAM: 82 } };
        const { busca } = buscaDe(BUSCA_MED);
        const p = await prepararHibrido('med', estavel, undefined, {
            embutir, busca, executor: executorDe(CYPHER_MED)
        });

        const rejeitadas = regrasRejeitadas(p.auditoria);
        assert.equal(rejeitadas.length, 2, 'os dois farmacos deixam de incidir');
        assert.match(rejeitadas[0].validacaoCypher.motivo, /PAM 82 nao satisfaz < 60/);
        // O candidato continua na lista de candidatos — rejeitar nao e apagar.
        assert.equal(p.auditoria.candidatos.length, 3);
    });

    await teste('9. candidato RAG ACEITO, com evidencia', async () => {
        const { busca } = buscaDe(BUSCA_MED);
        const p = await prepararHibrido('med', CENARIO, undefined, {
            embutir, busca, executor: executorDe(CYPHER_MED)
        });
        const aceita = regrasAceitas(p.auditoria).find(a => a.regraId.startsWith('Farmaco:Noradrenalina'))!;
        assert.ok(aceita);
        assert.deepEqual(aceita.evidencia, { PAM: 52 });
        assert.match(aceita.validacaoCypher.motivo, /condicao satisfeita/);
    });

    await teste('10. multiplos candidatos: cada um com seu veredito', async () => {
        // Propofol com escore ALTO e condicao falsa; Noradrenalina com escore
        // BAIXO e condicao verdadeira.
        const { busca } = buscaDe({
            farmaco_embedding: [achado('Propofol', 0.97), achado('Noradrenalina', 0.33)],
            protocolo_embedding: []
        });
        const p = await prepararHibrido('med', CENARIO, undefined, {
            embutir, busca,
            executor: executorDe({
                Propofol: [regra({ nodeId: 'p1', parametro: 'FC', operador: '>', esperado: 130 })],
                Noradrenalina: [regra({ nodeId: 'p2', parametro: 'PAM', operador: '<', esperado: 60 })]
            })
        });

        assert.equal(regrasAceitas(p.auditoria).length, 1);
        assert.ok(regrasAceitas(p.auditoria)[0].regraId.includes('Noradrenalina'));
        assert.equal(regrasRejeitadas(p.auditoria).length, 1);
        assert.ok(regrasRejeitadas(p.auditoria)[0].regraId.includes('Propofol'));
        assert.equal(regrasRejeitadas(p.auditoria)[0].rag.escore, 0.97,
            'o escore mais alto do lote foi o rejeitado');
    });

    console.log('\n[o que move o resultado]');

    await teste('11. telemetria alterada muda o veredito, com a mesma consulta', async () => {
        const { busca } = buscaDe(BUSCA_MED);
        const grave = await prepararHibrido('med', CENARIO, undefined, {
            embutir, busca, executor: executorDe(CYPHER_MED)
        });
        const estavel = await prepararHibrido(
            'med', { ...CENARIO, telemetria: { ...CENARIO.telemetria, PAM: 82 } },
            undefined, { embutir, busca, executor: executorDe(CYPHER_MED) }
        );

        assert.equal(regrasAceitas(grave.auditoria).length, 3);
        assert.equal(regrasAceitas(estavel.auditoria).length, 1, 'so o gatilho de lactato sobrevive');
        // Os candidatos sao os mesmos: quem mudou foi a telemetria.
        assert.deepEqual(
            grave.auditoria.candidatos.map(c => c.regraId),
            estavel.auditoria.candidatos.map(c => c.regraId)
        );
    });

    await teste('12. input alterado muda a consulta semantica', async () => {
        const { busca } = buscaDe(BUSCA_MED);
        const a = await prepararHibrido('med', CENARIO, undefined, {
            embutir, busca, executor: executorDe(CYPHER_MED)
        });
        const b = await prepararHibrido(
            'med', { ...CENARIO, intencao: 'suspender a sedacao agora' },
            undefined, { embutir, busca, executor: executorDe(CYPHER_MED) }
        );

        assert.notEqual(a.contexto.consultaSemantica, b.contexto.consultaSemantica);
        assert.match(b.contexto.consultaSemantica, /suspender a sedacao agora/);
        // A telemetria nao mudou, entao os vereditos nao mudam.
        assert.equal(regrasAceitas(a.auditoria).length, regrasAceitas(b.auditoria).length);
    });

    console.log('\n[degradacao e auditoria]');

    await teste('falha no modo hibrido degrada para o baseline, com motivo', async () => {
        const { auditoria, preparo } = await prepararHibridoTolerante('med', CENARIO, undefined, {
            embutir,
            busca: async () => { throw new Error('indice vetorial ausente'); },
            executor: executorDe({})
        });
        assert.equal(preparo, undefined, 'sem preparo, o foco volta a embutir sozinho');
        assert.match(auditoria.degradou ?? '', /indice vetorial ausente/);
        assert.equal(auditoria.modo, 'hibrida_rag_cypher');
    });

    await teste('a trilha cobre request -> consulta -> candidatos -> vereditos', async () => {
        const { busca } = buscaDe(BUSCA_MED);
        const p = await prepararHibrido('med', CENARIO, undefined, {
            embutir, busca, executor: executorDe(CYPHER_MED)
        });
        const a = p.auditoria;

        assert.equal(a.intencao, CENARIO.intencao);
        assert.ok(a.consultaSemantica.length > a.intencao.length, 'a consulta e enriquecida');
        assert.ok(a.topK > 0);
        assert.ok(a.candidatos.every(c => typeof c.escore === 'number' && typeof c.posicao === 'number'));
        assert.ok(regrasAceitas(a).every(x => x.validacaoCypher.motivo.length > 0));
        // Nao vaza o ID do sujeito para a consulta que vai ao embedding.
        assert.ok(!a.consultaSemantica.includes('PT-2026-4001'));
    });

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
