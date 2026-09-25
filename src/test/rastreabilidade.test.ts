/**
 * Rastreabilidade da recuperacao: do input ate a regra final.
 *
 * O que estes testes cobram e uma coisa so, e ela e facil de perder de vista:
 *
 *     NAO BASTA REGISTRAR "regra = aceita".
 *
 * Tem de ficar registrado POR QUE — com o valor observado e o valor exigido,
 * estruturados, para os dois lados do veredito. Uma rejeicao sem o numero que a
 * causou nao e auditavel: quem le seis meses depois nao consegue reconstruir a
 * decisao, e e exatamente nesse momento que a trilha precisaria servir.
 *
 * O caso de referencia e o do enunciado:
 *
 *     regra   RegraSeguranca PAM < 60
 *     escore  0.94  (alto)
 *     Cypher  REJECT
 *     porque  PAM observado 82, exigido < 60
 *
 * A trilha e METADADO DE EXECUCAO: nenhum destes campos entra no artefato, na
 * DSL ou na saida do usuario. Ha um teste para isso tambem.
 */

import assert from 'node:assert/strict';

import {
    prepararHibrido,
    explicarRegra,
    rastrearRegra,
    regrasAceitas,
    regrasRejeitadas,
    regrasSemEvidencia,
    relatorioAuditoria,
    resumoAuditoria
} from '../knowledge/recuperacao-hibrida.js';
import type { BuscaVetorial, Embutidor } from '../knowledge/recuperacao-rag.js';
import type { ExecutorCypher, LinhaRegra } from '../knowledge/recuperacao-cypher.js';
import type { ItemPontuado } from '../knowledge/foco.js';
import type { ClinicalContext } from '../knowledge/graphrag.js';

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

const embutir: Embutidor = async () => [0.1, 0.2, 0.3];

function cenario(telemetria: Record<string, number>, intencao = 'avaliar hipotensao persistente'): ClinicalContext {
    return { intencao, paciente: 'PT-2026-0031', telemetria, populacoes: [], farmacosEmUso: ['Noradrenalina'] };
}

function achado(nome: string, escore: number): ItemPontuado {
    return { nome, escore, cosseno: 2 * escore - 1, nodeId: `no-${nome}` };
}

function buscaDe(porIndice: Record<string, ItemPontuado[]>): BuscaVetorial {
    return async (indice, _v, topK) => (porIndice[indice] ?? []).slice(0, topK);
}

function regra(over: Partial<LinhaRegra>): LinhaRegra {
    return {
        tipoRegra: 'RegraSeguranca', relacao: 'BLOQUEIA_INCREMENTO', nodeId: 'r1',
        parametro: 'PAM', operador: '<', esperado: 60, unidade: 'mmHg',
        razao: 'risco de hipotensao severa', acao: null, detalhe: null,
        observado: null, satisfeita: null, ...over
    };
}

/** Executor com a mesma semantica de comparacao do CASE real do Cypher. */
function executorDe(porItem: Record<string, LinhaRegra[]>): ExecutorCypher {
    return async (_c, params) => {
        const nome = params.nome as string;
        const telemetria = params.telemetria as Record<string, number>;
        return (porItem[nome] ?? []).map(r => {
            const observado = telemetria[r.parametro] ?? null;
            let satisfeita: boolean | null = null;
            if (observado !== null) {
                satisfeita =
                    r.operador === '<' ? observado < r.esperado
                    : r.operador === '>' ? observado > r.esperado
                    : r.operador === '>=' ? observado >= r.esperado
                    : null;
            }
            return { ...r, observado, satisfeita };
        });
    };
}

/** O caso do enunciado: R17 com escore alto e condicao falsa. */
const BUSCA_R17 = buscaDe({
    farmaco_embedding: [achado('Propofol', 0.94)],
    protocolo_embedding: []
});
const CYPHER_R17 = executorDe({ Propofol: [regra({ nodeId: 'R17' })] });

async function main(): Promise<void> {
    console.log('\n[a trilha de ponta a ponta]');

    await teste('os dez pontos estao presentes numa execucao', async () => {
        const p = await prepararHibrido('med', cenario({ PAM: 82, FC: 128 }), undefined, {
            embutir, busca: BUSCA_R17, executor: CYPHER_R17, id: 'rec-teste-1'
        });
        const a = p.auditoria;

        assert.equal(a.id, 'rec-teste-1');                                   // 1
        assert.equal(a.intencao, 'avaliar hipotensao persistente');          // 1
        assert.match(a.consultaSemantica, /avaliar hipotensao persistente/); // 2
        assert.ok(a.topK > 0 && a.indices.length === 2);                     // 3
        assert.equal(a.candidatos[0].regraId, 'Farmaco:Propofol');           // 4
        assert.equal(a.candidatos[0].escore, 0.94);                          // 5
        assert.equal(a.validacao.length, 1);                                 // 6
        assert.ok(Array.isArray(a.validacao[0].condicoesSatisfeitas));       // 7
        assert.ok(Array.isArray(a.validacao[0].condicoesFalhas));            // 8
        assert.deepEqual(a.telemetria, { PAM: 82, FC: 128 });                // 9
        assert.ok(a.validacao[0].regraId.length > 0);                        // 10
    });

    await teste('rastrearRegra liga input -> query -> candidato -> escore -> veredito', async () => {
        const p = await prepararHibrido('med', cenario({ PAM: 82 }), undefined, {
            embutir, busca: BUSCA_R17, executor: CYPHER_R17, id: 'rec-teste-2'
        });
        const alvo = p.auditoria.validacao[0].regraId;
        const t = rastrearRegra(p.auditoria, alvo)!;

        assert.ok(t);
        assert.equal(t.id, 'rec-teste-2');
        assert.equal(t.intencao, 'avaliar hipotensao persistente');
        assert.match(t.consultaSemantica, /Sinais do paciente: PAM 82/);
        assert.equal(t.candidato!.regraId, 'Farmaco:Propofol');
        assert.equal(t.candidato!.escore, 0.94);
        assert.deepEqual(t.telemetriaUsada, { PAM: 82 });
        assert.match(t.explicacao, /REJEITADA/);
    });

    console.log('\n[1-2. aceito e rejeitado, ambos com o porque]');

    await teste('1. candidato ACEITO registra a condicao que o sustenta', async () => {
        const p = await prepararHibrido('med', cenario({ PAM: 52 }), undefined, {
            embutir, busca: BUSCA_R17, executor: CYPHER_R17
        });
        const [r] = regrasAceitas(p.auditoria);

        assert.ok(r, 'a regra deveria ter sido aceita com PAM 52');
        assert.equal(r.condicoesSatisfeitas.length, 1);
        assert.deepEqual(r.condicoesSatisfeitas[0], {
            campo: 'PAM', observado: 52, esperado: '< 60 mmHg',
            operador: '<', limite: 60, unidade: 'mmHg', satisfeita: true
        });
        assert.match(explicarRegra(r), /ACEITA porque PAM observado 52, exigido < 60 mmHg/);
    });

    await teste('2. candidato REJEITADO registra observado E exigido (o caso R17)', async () => {
        const p = await prepararHibrido('med', cenario({ PAM: 82 }), undefined, {
            embutir, busca: BUSCA_R17, executor: CYPHER_R17
        });
        const [r] = regrasRejeitadas(p.auditoria);

        assert.ok(r);
        assert.equal(r.aplicavel, false);
        // O que a versao anterior da auditoria perdia: evidencia na REJEICAO.
        assert.deepEqual(r.evidencia, { PAM: 82 });
        assert.equal(r.condicoesFalhas.length, 1);
        assert.equal(r.condicoesFalhas[0].campo, 'PAM');
        assert.equal(r.condicoesFalhas[0].observado, 82);
        assert.equal(r.condicoesFalhas[0].esperado, '< 60 mmHg');
        assert.equal(r.condicoesFalhas[0].limite, 60);
        assert.equal(r.condicoesFalhas[0].operador, '<');
        // E o escore alto fica lado a lado com a rejeicao.
        assert.equal(r.rag.escore, 0.94);
        assert.match(
            explicarRegra(r),
            /REJEITADA \(escore RAG 0\.94\) porque PAM observado 82, exigido < 60 mmHg/
        );
    });

    await teste('nunca existe veredito sem porque', async () => {
        for (const PAM of [52, 82]) {
            const p = await prepararHibrido('med', cenario({ PAM }), undefined, {
                embutir, busca: BUSCA_R17, executor: CYPHER_R17
            });
            for (const r of p.auditoria.validacao) {
                const condicoes = r.condicoesSatisfeitas.length + r.condicoesFalhas.length + r.lacunas.length;
                assert.ok(condicoes > 0, `${r.regraId} saiu sem condicao alguma registrada`);
                assert.ok(r.validacaoCypher.motivo.length > 0);
                assert.ok(!/^(aceita|rejeitada)$/i.test(r.validacaoCypher.motivo));
            }
        }
    });

    console.log('\n[3-4. varios candidatos, varias condicoes]');

    await teste('3. multiplos candidatos: cada um com sua propria trilha', async () => {
        const p = await prepararHibrido('med', cenario({ PAM: 82, FC: 128, TFG: 28 }), undefined, {
            embutir,
            busca: buscaDe({
                farmaco_embedding: [achado('Propofol', 0.94), achado('Vancomicina', 0.38)],
                protocolo_embedding: []
            }),
            executor: executorDe({
                Propofol: [regra({ nodeId: 'R17' })],
                Vancomicina: [regra({
                    nodeId: 'R22', tipoRegra: 'AjusteRenal', relacao: 'EXIGE_AJUSTE',
                    parametro: 'TFG', operador: '<', esperado: 50, unidade: 'mL/min',
                    razao: null, acao: 'aumentar_intervalo'
                })]
            })
        });

        assert.equal(p.auditoria.validacao.length, 2);
        const aceitas = regrasAceitas(p.auditoria);
        const rejeitadas = regrasRejeitadas(p.auditoria);
        assert.equal(aceitas.length, 1);
        assert.equal(rejeitadas.length, 1);

        // O de MAIOR escore foi o rejeitado, e a trilha mostra os dois porques.
        assert.equal(rejeitadas[0].rag.escore, 0.94);
        assert.equal(rejeitadas[0].condicoesFalhas[0].observado, 82);
        assert.equal(aceitas[0].rag.escore, 0.38);
        assert.equal(aceitas[0].condicoesSatisfeitas[0].observado, 28);
        assert.equal(aceitas[0].efeito.acao, 'aumentar_intervalo');

        // Cada regra rastreavel de forma independente.
        for (const r of p.auditoria.validacao) {
            assert.ok(rastrearRegra(p.auditoria, r.regraId), `${r.regraId} nao rastreavel`);
        }
    });

    await teste('4. multiplas condicoes: satisfeitas e falhas separadas, todas com evidencia', async () => {
        const p = await prepararHibrido('med', cenario({ PAM: 82, FC: 128 }), undefined, {
            embutir,
            busca: buscaDe({ farmaco_embedding: [achado('Propofol', 0.9)], protocolo_embedding: [] }),
            executor: executorDe({
                Propofol: [
                    regra({ nodeId: 'multi', parametro: 'PAM', operador: '<', esperado: 60 }),
                    regra({ nodeId: 'multi', parametro: 'FC', operador: '>', esperado: 120, unidade: 'bpm' })
                ]
            })
        });

        const [r] = p.auditoria.validacao;
        assert.equal(r.aplicavel, false, 'uma condicao falhou');
        assert.equal(r.condicoesSatisfeitas.length, 1);
        assert.equal(r.condicoesFalhas.length, 1);
        assert.equal(r.condicoesSatisfeitas[0].campo, 'FC');
        assert.equal(r.condicoesSatisfeitas[0].observado, 128);
        assert.equal(r.condicoesFalhas[0].campo, 'PAM');
        assert.equal(r.condicoesFalhas[0].observado, 82);
        // A evidencia cobre as DUAS condicoes, nao so a que falhou.
        assert.deepEqual(r.evidencia, { PAM: 82, FC: 128 });
    });

    await teste('condicao sem dado vira lacuna rastreavel, nao falsa', async () => {
        const p = await prepararHibrido('med', cenario({ PAM: 82 }), undefined, {
            embutir,
            busca: buscaDe({ farmaco_embedding: [achado('Propofol', 0.9)], protocolo_embedding: [] }),
            executor: executorDe({
                Propofol: [regra({ nodeId: 'sem', parametro: 'qSOFA', operador: '>=', esperado: 2, unidade: null })]
            })
        });
        const [r] = regrasSemEvidencia(p.auditoria);

        assert.ok(r);
        assert.equal(r.condicoesFalhas.length, 0, 'falta de medida nao e condicao falsa');
        assert.equal(r.lacunas[0].campo, 'qSOFA');
        assert.equal(r.lacunas[0].esperado, '>= 2');
        assert.match(explicarRegra(r), /SEM EVIDENCIA: qSOFA nao medido, exigido >= 2/);
    });

    console.log('\n[5-8. o que a trilha preserva]');

    await teste('5. escore preservado, exatamente como o indice devolveu', async () => {
        const p = await prepararHibrido('med', cenario({ PAM: 82 }), undefined, {
            embutir, busca: BUSCA_R17, executor: CYPHER_R17
        });
        assert.equal(p.auditoria.candidatos[0].escore, 0.94);
        assert.equal(p.auditoria.validacao[0].rag.escore, 0.94);
        assert.ok(Math.abs(p.auditoria.candidatos[0].cosseno - 0.88) < 1e-9);
    });

    await teste('6. evidencia preservada, e e a telemetria real do cenario', async () => {
        const p = await prepararHibrido('med', cenario({ PAM: 82, FC: 128 }), undefined, {
            embutir, busca: BUSCA_R17, executor: CYPHER_R17
        });
        // A evidencia da regra e um subconjunto da telemetria da trilha...
        for (const [campo, valor] of Object.entries(p.auditoria.validacao[0].evidencia)) {
            assert.equal(p.auditoria.telemetria[campo], valor);
        }
        // ...e a telemetria da trilha e a que o Cypher recebeu.
        assert.deepEqual(p.auditoria.telemetria, p.contexto.contextoEstruturado.telemetria);
    });

    await teste('7-8. observado e esperado preservados, sem arredondar', async () => {
        const p = await prepararHibrido('med', cenario({ TFG: 28.125 }), undefined, {
            embutir,
            busca: buscaDe({ farmaco_embedding: [achado('Vancomicina', 0.5)], protocolo_embedding: [] }),
            executor: executorDe({
                Vancomicina: [regra({ nodeId: 'v', parametro: 'TFG', operador: '<', esperado: 29.5, unidade: 'mL/min' })]
            })
        });
        const c = regrasAceitas(p.auditoria)[0].condicoesSatisfeitas[0];

        assert.equal(c.observado, 28.125, 'valor observado exato');
        assert.equal(c.limite, 29.5, 'valor exigido exato');
        assert.equal(c.esperado, '< 29.5 mL/min');
        assert.equal(typeof c.observado, 'number');
    });

    console.log('\n[a trilha e metadado, nao saida]');

    await teste('o relatorio e legivel e traz o porque de cada regra', async () => {
        const p = await prepararHibrido('med', cenario({ PAM: 82 }), undefined, {
            embutir, busca: BUSCA_R17, executor: CYPHER_R17, id: 'rec-rel'
        });
        const texto = relatorioAuditoria(p.auditoria);

        assert.match(texto, /\[rec-rel\] hibrida_rag_cypher \/ med/);
        assert.match(texto, /input:\s+avaliar hipotensao persistente/);
        assert.match(texto, /candidato Farmaco:Propofol escore=0\.94/);
        assert.match(texto, /REJEITADA .* PAM observado 82, exigido < 60 mmHg/);
        assert.match(resumoAuditoria(p.auditoria), /\[rec-rel\].*1 rejeitada/);
    });

    await teste('nada da trilha vaza para o artefato do usuario', async () => {
        // O artefato e montado por `contrato.ts`/`decodificacao.ts`, que nao
        // conhecem a auditoria. Aqui se verifica o contrato inverso: a trilha nao
        // carrega, e nao pode carregar, o texto do artefato.
        const p = await prepararHibrido('med', cenario({ PAM: 82 }), undefined, {
            embutir, busca: BUSCA_R17, executor: CYPHER_R17
        });
        const chaves = Object.keys(p.auditoria);
        for (const proibido of ['plano', 'artefato', 'resultado', 'ordem', 'missao', 'arbitragem']) {
            assert.ok(!chaves.includes(proibido), `"${proibido}" nao pertence a trilha`);
        }
        // E a trilha nao inventa dado do paciente alem do que o pipeline ja usa:
        // o ID do sujeito nao entra na consulta semantica registrada.
        assert.ok(!p.auditoria.consultaSemantica.includes('PT-2026-0031'));
    });

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
