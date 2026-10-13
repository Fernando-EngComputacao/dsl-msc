/**
 * Tempos das FASES da geracao multiagente (`TemposFases`, multiagente.ts): o
 * relogio de parede de cada fase, medido direto — nao somado de cronometros
 * internos — e preservado em todos os caminhos.
 * Executar: npx tsx src/test/tempos-geracao.test.ts
 *
 * Os tempos NAO sao exatos (dependem da maquina): as asserções sao de
 * presenca, de ordem e de coerencia — `tempo > 0` quando a fase executou,
 * ausente quando nao comecou, e a fase medida direto nunca menor que a soma
 * das partes internas que ela contem. Nenhum sleep: o tempo e o do trabalho real.
 *
 * O pipeline roda inteiro (Planner, validacao de sequencia, decomposicao, PI
 * Agents, composicao, `/verify` e validacao global) com dubles dos tres motores.
 */

import assert from 'node:assert/strict';
import * as path from 'node:path';

import { loadModel } from '../database/neo4j.js';
import {
    condutasPorDecisaoMed,
    esquemaDeDadosMed,
    pruningPayload,
    retrieveConstraints,
    type ClinicalContext,
    type RetrievedConstraints
} from '../knowledge/graphrag.js';
import { auditoriaVazia } from '../knowledge/recuperacao-hibrida.js';
import { montarEntradaGeracao, montarPromptSemantico } from '../inference/llm-client.js';
import { decodificar, type MotorFragmento, type ResultadoMultiagente } from '../inference/decodificacao.js';
import type { VerificadorGramatical } from '../inference/ciclo-global.js';
import { resumoExecucao, type ContextoExecucaoMultiagente, type TemposFases } from '../inference/multiagente.js';
import type { MotorPIAgent } from '../inference/pi-agent.js';
import type { MotorPlanner } from '../inference/planner.js';
import type { ConhecimentoRecuperado } from '../inference/recuperacao-conhecimento.js';
import { piAgentQueObedece, piAgentRoteirizado, verificadorQueAceita } from './dubles-pi-agent.js';

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

const REF: ClinicalContext = {
    paciente: 'PT-TESTE-0001',
    intencao: 'A pressao ta despencando (PAM=52), sobe a nora e aprofunda o propofol',
    telemetria: { PAM: 52, FC: 145, lactato: 4.8, RASS: 2, TFG: 28, plaquetas: 45, glicemia: 210 },
    populacoes: ['Renal_Cronico'],
    farmacosEmUso: ['Noradrenalina', 'Propofol', 'Vancomicina']
};
/** Nada bloqueia o incremento, nenhum escalonamento dispara; Noradrenalina + Adrenalina e interacao ALTA. */
const B: ClinicalContext = {
    paciente: 'PT-TESTE-0002',
    intencao: 'sobe a noradrenalina',
    telemetria: { PAM: 58, FC: 110, lactato: 3.0 },
    populacoes: [],
    farmacosEmUso: ['Noradrenalina']
};
const REF_2 = 'PLANO 1 | Propofol | Manter_Bloqueio | [ ] 2 | Noradrenalina | Acionar_Equipe | [ 1 ] FIM';
/** Propofol nao cumpre Titular_Vasopressor com PAM 52: reprovada na validacao da sequencia. */
const INCOMPATIVEL = 'PLANO 1 | Propofol | Titular_Vasopressor | [ ] FIM';
const CONFLITO = 'PLANO 1 | Noradrenalina | Titular_Vasopressor | [ ] 2 | Adrenalina | Iniciar_Vasopressor | [ 1 ] FIM';
const SEM_CONFLITO = 'PLANO 1 | Noradrenalina | Titular_Vasopressor | [ ] 2 | Adrenalina | Manter_Bloqueio | [ 1 ] FIM';

const soma = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

async function main(): Promise<void> {
    const modelo = await loadModel(path.join('src', 'examples', 'med', 'uti.dsl'));

    function cenario(ctx: ClinicalContext) {
        const constraints = retrieveConstraints(modelo, ctx);
        const poda = pruningPayload(constraints, ctx);
        void condutasPorDecisaoMed;
        void esquemaDeDadosMed;
        return { ctx, constraints, poda };
    }
    const ref = cenario(REF);
    const cb = cenario(B);
    const semAlvo = cenario({ ...B, intencao: 'a pressao esta caindo, o que faco?' });

    const conhecimentoDe = (s: ReturnType<typeof cenario>): ConhecimentoRecuperado<RetrievedConstraints> => ({
        constraints: s.constraints,
        foco: null,
        auditoriaRecuperacao: auditoriaVazia('deterministica', 'med', s.ctx.intencao!, `req-tempos-${Math.random().toString(36).slice(2)}`),
        poda: s.poda,
        politicaEfetiva: s.poda,
        promptSemantico: montarPromptSemantico(s.constraints, s.ctx, s.poda)
    });

    interface Rodada {
        ctx: ContextoExecucaoMultiagente;
        r: ResultadoMultiagente;
        chamadasPlanner: number;
        verificados: number;
    }
    interface Opcoes {
        motorPlanner?: MotorPlanner;
        piAgent?: MotorPIAgent;
        verificador?: VerificadorGramatical;
    }

    /** Roda o pipeline multiagente com dubles. `planos` = saidas do Planner, em ordem (a ultima se repete). */
    async function rodar(s: ReturnType<typeof cenario>, planos: string[], opcoes: Opcoes = {}): Promise<Rodada> {
        let chamadasPlanner = 0;
        let verificados = 0;
        const motor: MotorFragmento = async () => ({ fragmento: '', encerrou: true });
        const motorPlanner: MotorPlanner =
            opcoes.motorPlanner ??
            (async () => {
                chamadasPlanner++;
                return { saida: planos[Math.min(chamadasPlanner, planos.length) - 1], tokens_prompt: 4000 };
            });
        const base = verificadorQueAceita();
        const verificador: VerificadorGramatical =
            opcoes.verificador ??
            (async (plano, subgrafo) => {
                verificados++;
                return base(plano, subgrafo);
            });
        const modoOriginal = process.env.SPC_CML_DECODIFICACAO;
        process.env.SPC_CML_DECODIFICACAO = 'multiagente';
        try {
            const k = conhecimentoDe(s);
            const r = (await decodificar({
                ...montarEntradaGeracao(s.ctx, s.constraints, modelo, k.politicaEfetiva, k),
                endpoint: 'http://127.0.0.1:9',
                motor,
                motorPlanner,
                motorPIAgent: opcoes.piAgent ?? piAgentQueObedece(),
                verificadorGramatical: verificador
            })) as ResultadoMultiagente;
            return { ctx: r.execucao, r, chamadasPlanner, verificados };
        } finally {
            if (modoOriginal === undefined) delete process.env.SPC_CML_DECODIFICACAO;
            else process.env.SPC_CML_DECODIFICACAO = modoOriginal;
        }
    }

    const fases = (x: Rodada): TemposFases => x.ctx.temposFases;
    const presente = (v: number | undefined, nome: string): number => {
        assert.equal(typeof v, 'number', `${nome} deveria ter sido medido (a fase executou), e e ${String(v)}`);
        assert.ok(Number.isFinite(v!) && v! > 0, `${nome} deveria ser > 0, e e ${String(v)}`);
        return v!;
    };
    /** Os cronometros internos que o pipeline ja tinha: cada fase medida direto os CONTEM, entao e >= a soma deles. */
    const partes = (ctx: ContextoExecucaoMultiagente) => ({
        planner: soma(ctx.tentativasPlanner.map(t => (t.metricas?.duracaoMs ?? 0) + (t.metricas?.duracaoValidacaoMs ?? 0))),
        ondas: soma(ctx.historicoGlobal.flatMap(c => c.ondasPI).map(o => o.duracaoMs ?? 0)),
        validacao: soma(ctx.historicoGlobal.map(c => (c.metricas.duracaoComposicaoMs ?? 0) + (c.metricas.duracaoValidacaoGlobalMs ?? 0)))
    });
    /** O tempo total do registro, medido por fora (como o runner do lote faz): as fases rodam em serie e cabem nele. */
    async function comTotal<T extends Rodada>(f: () => Promise<T>): Promise<{ x: T; totalMs: number }> {
        const inicio = performance.now();
        const x = await f();
        return { x, totalMs: performance.now() - inicio };
    }

    // =========================================================================
    console.log('\nCaminho normal e retries');
    // =========================================================================

    await teste('1. caminho normal: as tres fases medidas, > 0, e dentro do total', async () => {
        const { x, totalMs } = await comTotal(() => rodar(ref, [REF_2]));
        assert.equal(x.ctx.status, 'COMPLETED');
        const f = fases(x);
        const [s, p, v] = [presente(f.sequenciasMs, 'sequenciasMs'), presente(f.pisMs, 'pisMs'), presente(f.validacaoPlanosMs, 'validacaoPlanosMs')];
        const pt = partes(x.ctx);
        assert.ok(s >= pt.planner, `sequencias (${s}) contem o Planner e a validacao (${pt.planner})`);
        assert.ok(p >= pt.ondas, `PIs (${p}) contem as ondas (${pt.ondas})`);
        assert.ok(v >= pt.validacao, `validacao (${v}) contem composicao + validacao global (${pt.validacao})`);
        assert.ok(s + p + v <= totalMs, `as fases rodam em serie: ${s + p + v} <= total ${totalMs}`);
        // O que o servidor devolve e o que o cliente le: o mesmo objeto, sem reescrita.
        assert.deepEqual(resumoExecucao(x.ctx).metricasExecucao!.temposFases, f);
    });

    await teste('2. Planner com retry: sequencias contem as DUAS propostas, nao so a primeira nem so a vencedora', async () => {
        const x = await rodar(ref, [INCOMPATIVEL, REF_2]);
        assert.equal(x.chamadasPlanner, 2);
        assert.equal(x.ctx.status, 'COMPLETED');
        const [t1, t2] = x.ctx.tentativasPlanner;
        const uma = (t: typeof t1) => (t.metricas?.duracaoMs ?? 0) + (t.metricas?.duracaoValidacaoMs ?? 0);
        const s = presente(fases(x).sequenciasMs, 'sequenciasMs');
        assert.ok(s >= uma(t1) + uma(t2), `sequencias (${s}) >= tentativa 1 (${uma(t1)}) + tentativa 2 (${uma(t2)})`);
        assert.ok(s > uma(t2), 'maior que so a tentativa que venceu');
    });

    await teste('3. PI com retry: a fase dos PIs contem a primeira execucao E o retry', async () => {
        const x = await rodar(ref, [REF_2], { piAgent: piAgentRoteirizado({ 1: ['Mantenha o propofol.'] }) });
        assert.equal(x.ctx.status, 'COMPLETED');
        assert.equal(x.ctx.execucoesPI[0].tentativas.length, 2, 'o PI 1 foi tentado duas vezes');
        const p = presente(fases(x).pisMs, 'pisMs');
        assert.ok(p >= partes(x.ctx).ondas, 'a fase contem as ondas, que contem os retries');
        assert.ok(p >= soma(x.ctx.execucoesPI.flatMap(e => e.tentativas).map(t => t.metricas?.duracaoMs ?? 0)), 'e todas as tentativas de PI');
    });

    await teste('4. validacao global com retry: dois ciclos, a fase soma a composicao e a validacao dos DOIS', async () => {
        const x = await rodar(cb, [CONFLITO, SEM_CONFLITO]);
        assert.equal(x.ctx.status, 'COMPLETED');
        assert.equal(x.ctx.historicoGlobal.length, 2);
        assert.equal(x.verificados, 2, '/verify rodou nos dois ciclos');
        const v = presente(fases(x).validacaoPlanosMs, 'validacaoPlanosMs');
        assert.ok(v >= partes(x.ctx).validacao, `validacao (${v}) >= ciclo 1 + ciclo 2 (${partes(x.ctx).validacao})`);
        // Planner e PIs tambem rodaram nos dois ciclos e foram somados.
        assert.ok(presente(fases(x).sequenciasMs, 'sequenciasMs') >= partes(x.ctx).planner);
        assert.ok(presente(fases(x).pisMs, 'pisMs') >= partes(x.ctx).ondas);
    });

    // =========================================================================
    console.log('\nFalhas, excecoes e retornos antecipados');
    // =========================================================================

    await teste('5. excecao do motor do Planner na 1a chamada: FAILED, e o tempo da chamada NAO se perde', async () => {
        const x = await rodar(ref, [], {
            motorPlanner: async () => {
                await new Promise(r => setImmediate(r));
                throw new Error('motor fora do ar');
            }
        });
        assert.equal(x.ctx.status, 'FAILED');
        assert.equal(x.ctx.tentativasPlanner.length, 0, 'nenhuma tentativa foi gravada: a soma dos cronometros internos daria null');
        assert.equal(fases(x).sequenciasMs !== undefined, true, 'a fase comecou e a medicao ficou');
        presente(fases(x).sequenciasMs, 'sequenciasMs');
        assert.equal(fases(x).pisMs, undefined, 'PIs nao comecaram: ausente, nao zero');
        assert.equal(fases(x).validacaoPlanosMs, undefined, 'validacao nao comecou: ausente, nao zero');
    });

    await teste('6. excecao do Planner na 2a chamada: as duas chamadas entram na fase', async () => {
        let n = 0;
        const x = await rodar(ref, [], {
            motorPlanner: async () => {
                n++;
                if (n === 2) throw new Error('motor caiu na segunda');
                return { saida: INCOMPATIVEL, tokens_prompt: 1 };
            }
        });
        assert.equal(x.ctx.status, 'FAILED');
        assert.equal(x.ctx.tentativasPlanner.length, 1, 'so a 1a chamada virou tentativa');
        const t1 = x.ctx.tentativasPlanner[0];
        const s = presente(fases(x).sequenciasMs, 'sequenciasMs');
        assert.ok(s > (t1.metricas?.duracaoMs ?? 0) + (t1.metricas?.duracaoValidacaoMs ?? 0), 'mais que a tentativa gravada: a chamada que falhou tambem conta');
    });

    await teste('7. excecao em /verify (artefato fora de L(G)): FAILED, e a validacao ja executada fica medida', async () => {
        const x = await rodar(ref, [REF_2], { verificador: async () => { throw new Error('motor recusou o /verify'); } });
        assert.equal(x.ctx.status, 'FAILED');
        assert.deepEqual(x.ctx.historicoGlobal[0].metricas.duracaoValidacaoGlobalMs, undefined, 'o cronometro interno se perdeu na excecao...');
        presente(fases(x).validacaoPlanosMs, 'validacaoPlanosMs'); // ...a fase nao
        presente(fases(x).sequenciasMs, 'sequenciasMs');
        presente(fases(x).pisMs, 'pisMs');
    });

    await teste('8. gramatica reprova o artefato composto (InconsistenciaComposicao): FAILED com a validacao medida', async () => {
        const x = await rodar(ref, [REF_2], { verificador: async () => ({ valido: false, erro: 'fora de L(G)' }) });
        assert.equal(x.ctx.status, 'FAILED');
        presente(fases(x).validacaoPlanosMs, 'validacaoPlanosMs');
    });

    await teste('9. sequencia nunca valida (orcamento do Planner esgotado): so a fase de sequencias existe', async () => {
        const x = await rodar(ref, [INCOMPATIVEL]);
        assert.equal(x.ctx.status, 'UNRESOLVED');
        assert.ok(x.chamadasPlanner >= 2, 'houve retries');
        presente(fases(x).sequenciasMs, 'sequenciasMs');
        assert.equal(fases(x).pisMs, undefined);
        assert.equal(fases(x).validacaoPlanosMs, undefined);
    });

    await teste('10. plano global reprovado nos dois ciclos (UNRESOLVED): as tres fases, dois ciclos somados', async () => {
        const x = await rodar(cb, [CONFLITO, CONFLITO, CONFLITO]);
        assert.equal(x.ctx.status, 'UNRESOLVED');
        assert.equal(x.ctx.historicoGlobal.length, 2);
        for (const [nome, v] of Object.entries(fases(x))) presente(v, nome);
        assert.equal(Object.keys(fases(x)).length, 3);
    });

    await teste('11. retorno antecipado — pedido sem alvo: UNRESOLVED antes do Planner, NENHUMA fase, e nenhum zero inventado', async () => {
        const x = await rodar(semAlvo, [REF_2]);
        assert.equal(x.ctx.status, 'UNRESOLVED');
        assert.equal(x.chamadasPlanner, 0);
        assert.deepEqual(fases(x), {}, 'nenhuma fase comecou');
        assert.equal(resumoExecucao(x.ctx).metricasExecucao!.temposFases, undefined, 'o resumo nao traz fase que nao rodou');
    });

    // =========================================================================
    console.log('\nVarios registros, assincronia e concorrencia');
    // =========================================================================

    await teste('12. varios registros em sequencia (como o lote): cada um com o seu relogio, sem estado compartilhado', async () => {
        const rodadas: Rodada[] = [];
        for (const planos of [[REF_2], [INCOMPATIVEL, REF_2], [REF_2]]) rodadas.push(await rodar(ref, planos));
        assert.equal(new Set(rodadas.map(x => x.ctx.temposFases)).size, 3, 'um objeto de tempos por execucao');
        for (const x of rodadas) {
            presente(fases(x).sequenciasMs, 'sequenciasMs');
            presente(fases(x).pisMs, 'pisMs');
            presente(fases(x).validacaoPlanosMs, 'validacaoPlanosMs');
        }
        // O segundo registro tem o dobro de chamadas ao Planner: a sua fase nao herdou nem emprestou nada.
        const s = rodadas.map(x => fases(x).sequenciasMs!);
        assert.ok(s[1] >= partes(rodadas[1].ctx).planner);
        assert.ok(s[0] >= partes(rodadas[0].ctx).planner && s[2] >= partes(rodadas[2].ctx).planner);
    });

    await teste('13. execucoes concorrentes (Promise.all): cada uma mede so a sua; a que nao rodou fase nenhuma continua vazia', async () => {
        const [a, b, c, d] = await Promise.all([
            rodar(ref, [REF_2]),
            rodar(cb, [CONFLITO, SEM_CONFLITO]),
            rodar(semAlvo, [REF_2]),
            rodar(ref, [INCOMPATIVEL, REF_2])
        ]);
        assert.equal(new Set([a, b, c, d].map(x => x.ctx.temposFases)).size, 4);
        assert.deepEqual(fases(c), {}, 'a execucao sem fases nao recebeu o tempo de nenhuma das outras');
        for (const x of [a, b, d]) {
            assert.ok(presente(fases(x).sequenciasMs, 'sequenciasMs') >= partes(x.ctx).planner);
            assert.ok(presente(fases(x).pisMs, 'pisMs') >= partes(x.ctx).ondas);
            assert.ok(presente(fases(x).validacaoPlanosMs, 'validacaoPlanosMs') >= partes(x.ctx).validacao);
        }
        assert.equal(b.ctx.historicoGlobal.length, 2);
        assert.equal(a.ctx.historicoGlobal.length, 1);
    });

    await teste('14. as fases correm em serie, entao a soma delas nunca passa do total medido por fora (concorrentes inclusive)', async () => {
        const inicio = performance.now();
        const xs = await Promise.all([rodar(ref, [REF_2]), rodar(cb, [CONFLITO, SEM_CONFLITO])]);
        const total = performance.now() - inicio;
        for (const x of xs) assert.ok(soma(Object.values(fases(x))) <= total, 'cada execucao cabe no tempo da rodada inteira');
    });

    // =========================================================================
    console.log('\nO que o cliente grava no JSONL');
    // =========================================================================

    // `web-chat` fica fora do `rootDir` do tsc da raiz: o modulo e carregado por caminho dinamico.
    const caminhoCliente = '../../web-chat/src/tempos-lote.ts';
    const cliente = (await import(caminhoCliente)) as {
        temposDasEtapas: (e?: { status: string; metricasExecucao?: { temposFases?: TemposFases } }) => {
            tempoSequenciasMs: number | null;
            tempoPIsValidasMs: number | null;
            tempoValidacaoPlanosMs: number | null;
        };
        temposDoCenario: (totalMs: number, etapas: ReturnType<typeof cliente.temposDasEtapas>) => Record<string, number | null>;
    };

    await teste('15. o registro leva as fases medidas; segundos = ms / 1000 da MESMA medicao; ausente continua null', async () => {
        const x = await rodar(ref, [INCOMPATIVEL, REF_2]);
        const etapas = cliente.temposDasEtapas(resumoExecucao(x.ctx));
        const linha = cliente.temposDoCenario(123456.789, etapas);
        for (const f of ['Sequencias', 'PIsValidas', 'ValidacaoPlanos', 'Total']) {
            const ms = linha[`tempo${f}Ms`] as number;
            const seg = linha[`tempo${f}Segundos`] as number;
            assert.ok(ms > 0, `${f}: ${ms}`);
            assert.ok(Math.abs(seg - ms / 1000) < 1e-6, `${f}: ${seg} != ${ms}/1000`);
        }
        assert.ok(Math.abs((linha.tempoSequenciasMs as number) - fases(x).sequenciasMs!) < 0.001, 'o JSONL repete a medicao do pipeline');
        // sem fase medida: null, nunca 0
        const vazio = cliente.temposDoCenario(10, cliente.temposDasEtapas(resumoExecucao((await rodar(semAlvo, [REF_2])).ctx)));
        assert.deepEqual([vazio.tempoSequenciasMs, vazio.tempoPIsValidasMs, vazio.tempoValidacaoPlanosMs], [null, null, null]);
        assert.deepEqual([vazio.tempoSequenciasSegundos, vazio.tempoPIsValidasSegundos, vazio.tempoValidacaoPlanosSegundos], [null, null, null]);
        assert.equal(vazio.tempoTotalMs, 10, 'o total e do registro, medido por fora, e nao depende das fases');
        // fora do multiagente (modo incremental/monolitico): as fases nao existem
        const incremental = cliente.temposDoCenario(10, cliente.temposDasEtapas(undefined));
        assert.deepEqual([incremental.tempoSequenciasMs, incremental.tempoPIsValidasMs, incremental.tempoValidacaoPlanosMs], [null, null, null]);
    });

    await teste('16. uma fase medida em 0 ms continua 0 (medida), e uma ausente continua null — nada e convertido', () => {
        const etapas = cliente.temposDasEtapas({ status: 'FAILED', metricasExecucao: { temposFases: { sequenciasMs: 0, pisMs: 12.3456789 } } });
        assert.deepEqual([etapas.tempoSequenciasMs, etapas.tempoPIsValidasMs, etapas.tempoValidacaoPlanosMs], [0, 12.346, null]);
    });

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main();
