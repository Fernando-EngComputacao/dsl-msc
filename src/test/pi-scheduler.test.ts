/**
 * Scheduler dos PIs: o DAG da sequencia validada e as ondas de execucao.
 *
 * O que se cobra:
 *   - o grafo tem exatamente as arestas de `dependeDe` — nenhuma inventada — e
 *     e validado deterministicamente: dependencia inexistente, posterior,
 *     propria e ciclo sao erro; repetida e normalizada (aviso);
 *   - as ondas sao as camadas do DAG: PIs independentes na mesma onda, qualquer
 *     que seja a ordem deles; um dependente espera TODOS os predecessores; dentro
 *     da onda, a ordem do Planner;
 *   - so VALID libera dependente; predecessor INVALID (orcamento esgotado),
 *     UNRESOLVED ou FAILED bloqueia, e nenhum resultado e inventado;
 *   - o retry de um PI nao reexecuta PI ja valido; a composicao continua na
 *     ordem do Planner;
 *   - nada roda em paralelo: dentro da onda, um PI por vez.
 *
 * Roda OFFLINE: grafo puro, motor de ondas com `resolver` falso, e o fluxo
 * multiagente com a DSL e a recuperacao deterministica reais e Planner, PI
 * Agent e /verify dubles.
 */

import assert from 'node:assert/strict';
import * as path from 'node:path';

import { loadModel } from '../database/neo4j.js';
import {
    condutasPorDecisaoMed,
    esquemaDeDadosMed,
    esquemaDeclaradoMed,
    pruningPayload,
    retrieveConstraints,
    type ClinicalContext,
    type RetrievedConstraints
} from '../knowledge/graphrag.js';
import { lerArtefato, montarContrato } from '../knowledge/contrato.js';
import type { PIPlanejado } from '../knowledge/contrato-pi.js';
import { comoDadoPuro } from '../knowledge/decompositor.js';
import { auditoriaVazia } from '../knowledge/recuperacao-hibrida.js';
import type { ResultadoValidacao } from '../knowledge/validacao.js';
import { validarSequencia } from '../knowledge/validacao-sequencia.js';
import { montarEntradaGeracao, montarPromptSemantico } from '../inference/llm-client.js';
import { decodificar, type MotorFragmento, type ResultadoMultiagente } from '../inference/decodificacao.js';
import {
    ORCAMENTO_PADRAO,
    avancarStatus,
    decomporSequencia,
    incoerenciasDoContexto,
    novoContextoExecucao,
    registrarConhecimento,
    resumoExecucao,
    type ContextoExecucaoMultiagente,
    type StatusPI
} from '../inference/multiagente.js';
import { resolverPIs, type MotorPIAgent, type PedidoPIAgent } from '../inference/pi-agent.js';
import {
    executarOndas,
    liberados,
    planejarExecucaoPI,
    registrosDeOndas,
    type DesfechoPI,
    type NoPI,
    type PlanoExecucaoPI
} from '../inference/pi-scheduler.js';
import type { MotorPlanner } from '../inference/planner.js';
import type { ConhecimentoRecuperado } from '../inference/recuperacao-conhecimento.js';
import { piAgentQueObedece, piAgentRoteirizado, saidaPI, verificadorQueAceita } from './dubles-pi-agent.js';

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

const codigos = (r: ResultadoValidacao): string[] => r.erros.map(e => e.codigo);
/** Uma sequencia so com o que o scheduler le: `n(ordem, ...dependeDe)`. */
const n = (ordem: number, ...dependeDe: number[]): NoPI => ({ ordem, dependeDe });
function plano(pis: NoPI[]): PlanoExecucaoPI {
    const r = planejarExecucaoPI(pis);
    assert.equal(r.veredito, 'VALID', JSON.stringify(r.erros));
    return r.valor!;
}
const ondas = (pis: NoPI[]): number[][] => plano(pis).ondas.map(o => o.ordens);

/** Cenario de referencia: PAM 52 bloqueia o Propofol, FC 145 a Noradrenalina, e dois escalonamentos disparam. */
const CENARIO: ClinicalContext = {
    paciente: 'PT-TESTE-0001',
    intencao: 'A pressao ta despencando (PAM=52), sobe a nora e aprofunda o propofol',
    telemetria: { PAM: 52, FC: 145, lactato: 4.8, RASS: 2, TFG: 28, plaquetas: 45, glicemia: 210 },
    populacoes: ['Renal_Cronico'],
    farmacosEmUso: ['Noradrenalina', 'Propofol', 'Vancomicina']
};

async function main(): Promise<void> {
    // =========================================================================
    console.log('\nGrafo e ondas');
    // =========================================================================

    await teste('caso 1 — tudo independente: uma onda so, [1, 2, 3, 4]', () => {
        const p = plano([n(1), n(2), n(3), n(4)]);
        assert.deepEqual(p.ondas, [{ indice: 0, ordens: [1, 2, 3, 4] }]);
        assert.deepEqual(p.metricas, { pis: 4, arestas: 0, ondas: 1, larguraMaxima: 4, profundidade: 1, pisPorOnda: [4] });
    });

    await teste('caso 2 — cadeia: uma onda por PI, [1] [2] [3] [4]', () => {
        const p = plano([n(1), n(2, 1), n(3, 2), n(4, 3)]);
        assert.deepEqual(p.ondas.map(o => o.ordens), [[1], [2], [3], [4]]);
        assert.deepEqual(p.metricas, { pis: 4, arestas: 3, ondas: 4, larguraMaxima: 1, profundidade: 4, pisPorOnda: [1, 1, 1, 1] });
    });

    await teste('caso 3 — paralelismo potencial: [1, 2, 3] [4]; a ordem do PI nao e dependencia', () => {
        assert.deepEqual(ondas([n(1), n(2), n(3), n(4, 1)]), [[1, 2, 3], [4]], 'e nao [1] [2] [3] [4]');
        const p = plano([n(1), n(2), n(3), n(4, 1)]);
        assert.deepEqual([p.metricas.larguraMaxima, p.metricas.profundidade], [3, 2]);
    });

    await teste('caso 4 — DAG ramificado: [1] [2, 3] [4], com predecessores e sucessores', () => {
        const p = plano([n(1), n(2, 1), n(3, 1), n(4, 2, 3)]);
        assert.deepEqual(p.ondas.map(o => o.ordens), [[1], [2, 3], [4]]);
        assert.deepEqual(p.predecessores, { 1: [], 2: [1], 3: [1], 4: [2, 3] });
        assert.deepEqual(p.sucessores, { 1: [2, 3], 2: [4], 3: [4], 4: [] });
        assert.deepEqual(p.ondaDoPI, { 1: 0, 2: 1, 3: 1, 4: 2 });
        assert.deepEqual(p.metricas, { pis: 4, arestas: 4, ondas: 3, larguraMaxima: 2, profundidade: 3, pisPorOnda: [1, 2, 1] });
    });

    await teste('caso 5 — dependencia multipla: o 4 espera TODOS os predecessores, inclusive o mais fundo', () => {
        assert.deepEqual(ondas([n(1), n(2), n(3), n(4, 1, 2, 3)]), [[1, 2, 3], [4]]);
        // Com o 3 dependendo do 2, o 4 so entra depois do 3 — nao junto com o 1.
        assert.deepEqual(ondas([n(1), n(2), n(3, 2), n(4, 1, 2, 3)]), [[1, 2], [3], [4]]);
        const p = plano([n(1), n(2), n(3), n(4, 1, 2, 3)]);
        const quase: Record<number, StatusPI> = { 1: 'VALID', 2: 'VALID', 3: 'EM_EXECUCAO', 4: 'PENDENTE' };
        assert.deepEqual(liberados(p, quase), { prontos: [], bloqueados: [], aguardando: [4] }, 'dois de tres VALID nao liberam');
        assert.deepEqual(liberados(p, { ...quase, 3: 'VALID' }).prontos, [4]);
    });

    await teste('o exemplo da especificacao: PI1 -> PI4 e PI2 -> PI3 -> PI4 da [1, 2] [3] [4]', () => {
        assert.deepEqual(ondas([n(1), n(2), n(3, 2), n(4, 1, 3)]), [[1, 2], [3], [4]]);
    });

    await teste('caso 6 — dependencia inexistente: erro estrutural', () => {
        const r = planejarExecucaoPI([n(1), n(2, 99)]);
        assert.equal(r.veredito, 'INVALID');
        assert.deepEqual(codigos(r), ['dependencia_inexistente']);
        assert.equal(r.erros[0].pi, 2);
        assert.match(r.erros[0].mensagem, /PI 2 depende do PI 99, que nao existe/);
    });

    await teste('caso 7 — dependencia futura: erro estrutural', () => {
        const r = planejarExecucaoPI([n(1), n(2, 3), n(3)]);
        assert.deepEqual(codigos(r), ['dependencia_posterior']);
        assert.deepEqual(r.erros[0].pis, [2, 3]);
    });

    await teste('caso 8 — auto-dependencia: erro estrutural', () => {
        assert.deepEqual(codigos(planejarExecucaoPI([n(1), n(2, 2)])), ['dependencia_propria']);
    });

    await teste('caso 9 — ciclo: erro, com o ciclo explicito; nada e corrigido', () => {
        const r = planejarExecucaoPI([n(1, 3), n(2, 1), n(3, 2)]);
        assert.equal(r.veredito, 'INVALID');
        assert.ok(codigos(r).includes('ciclo_de_dependencias'));
        const ciclo = r.erros.find(e => e.codigo === 'ciclo_de_dependencias')!;
        assert.deepEqual(ciclo.pis, [1, 3, 2]);
        assert.match(ciclo.mensagem, /1 -> 3 -> 2 -> 1/);
        assert.equal(r.valor, undefined, 'nenhum plano de execucao');
        // O mesmo grafo, sempre o mesmo veredito.
        assert.deepEqual(planejarExecucaoPI([n(1, 3), n(2, 1), n(3, 2)]), r);
        // Ciclo de dois, e ciclo so entre parte dos PIs (o 1 fica fora dele).
        assert.deepEqual(planejarExecucaoPI([n(1), n(2, 3), n(3, 2)]).erros.find(e => e.codigo === 'ciclo_de_dependencias')!.pis, [2, 3]);
    });

    await teste('caso 10 — dependencia duplicada: normalizada, com aviso; a aresta conta uma vez', () => {
        const r = planejarExecucaoPI([n(1), n(2, 1, 1)]);
        assert.equal(r.veredito, 'VALID');
        assert.deepEqual(r.avisos.map(a => a.codigo), ['dependencia_repetida']);
        assert.deepEqual(r.valor!.predecessores[2], [1]);
        assert.deepEqual(r.valor!.metricas.arestas, 1);
        assert.deepEqual(r.valor!.avisos, r.avisos);
    });

    await teste('ordem repetida e varios erros juntos: todos acusados', () => {
        assert.deepEqual(codigos(planejarExecucaoPI([n(1), n(1)])), ['ordem_repetida']);
        assert.deepEqual(codigos(planejarExecucaoPI([n(1, 1), n(2, 7)])), ['dependencia_propria', 'dependencia_inexistente']);
    });

    await teste('deterministico e dado puro: mesma entrada, mesmo plano; congelado; le o PIPlanejado sem copiar o tipo', () => {
        const seq: PIPlanejado[] = [
            { ordem: 1, item: 'A', conduta: 'X', dependeDe: [] },
            { ordem: 2, item: 'B', conduta: 'Y', dependeDe: [] },
            { ordem: 3, item: 'C', conduta: 'Z', dependeDe: [1] }
        ];
        const a = plano(seq);
        assert.deepEqual(a, plano(seq));
        assert.ok(Object.isFrozen(a) && Object.isFrozen(a.ondas[0].ordens) && Object.isFrozen(a.predecessores));
        assert.deepEqual(JSON.parse(JSON.stringify(a)), a, 'atravessa JSON');
        assert.deepEqual(seq[2].dependeDe, [1], 'a sequencia nao muda');
    });

    await teste('profundidade = caminho mais longo = numero de ondas, em todos os formatos', () => {
        for (const pis of [
            [n(1), n(2), n(3), n(4)], [n(1), n(2, 1), n(3, 2), n(4, 3)], [n(1), n(2), n(3), n(4, 1)],
            [n(1), n(2, 1), n(3, 1), n(4, 2, 3)], [n(1), n(2), n(3, 2), n(4, 1, 3)], [n(1), n(2), n(3, 1), n(4), n(5, 3, 4), n(6)]
        ]) {
            const m = plano(pis).metricas;
            assert.equal(m.profundidade, m.ondas);
            assert.equal(m.pisPorOnda.reduce((x, y) => x + y, 0), m.pis);
            assert.equal(m.larguraMaxima, Math.max(...m.pisPorOnda));
        }
        assert.deepEqual(plano([n(1), n(2), n(3, 1), n(4), n(5, 3, 4), n(6)]).metricas, { pis: 6, arestas: 3, ondas: 3, larguraMaxima: 4, profundidade: 3, pisPorOnda: [4, 1, 1] });
    });

    // =========================================================================
    console.log('\nLiberacao');
    // =========================================================================

    await teste('caso 12 — predecessor UNRESOLVED, FAILED ou INVALID final: o dependente nao roda (bloqueado), o independente sim', () => {
        const p = plano([n(1), n(2, 1), n(3, 2), n(4)]);
        for (const fim of ['UNRESOLVED', 'FAILED', 'INVALID'] as const) {
            assert.deepEqual(liberados(p, { 1: fim }), { prontos: [4], bloqueados: [2, 3], aguardando: [] }, `${fim}: o 3 fica bloqueado pelo 2, que nunca roda`);
        }
        assert.deepEqual(liberados(p, {}), { prontos: [1, 4], bloqueados: [], aguardando: [2, 3] });
        assert.deepEqual(liberados(p, { 1: 'EM_EXECUCAO' }), { prontos: [4], bloqueados: [], aguardando: [2, 3] }, 'em execucao: espera');
        assert.deepEqual(liberados(p, { 1: 'VALID', 4: 'VALID' }), { prontos: [2], bloqueados: [], aguardando: [3] });
    });

    // =========================================================================
    console.log('\nExecucao por ondas (resolver falso)');
    // =========================================================================

    /** Um resolver que registra quem rodou e devolve o desfecho roteirizado (padrao VALID). */
    function resolverFalso(desfechos: Record<number, DesfechoPI | 'erro'> = {}) {
        const chamados: number[] = [];
        const resolver = async (ordem: number): Promise<DesfechoPI> => {
            chamados.push(ordem);
            const d = desfechos[ordem] ?? 'VALID';
            if (d === 'erro') throw new Error(`motor fora do ar no PI ${ordem}`);
            return d;
        };
        return { chamados, resolver };
    }

    await teste('ondas em serie: cada PI uma vez, onda por onda, na ordem do Planner dentro da onda', async () => {
        const p = plano([n(1), n(2, 1), n(3), n(4, 2, 3)]);
        const registros = registrosDeOndas(p);
        const { chamados, resolver } = resolverFalso();
        const r = await executarOndas(p, registros, resolver);
        assert.deepEqual(chamados, [1, 3, 2, 4]);
        assert.deepEqual(r, { desfecho: 'VALID', estados: { 1: 'VALID', 2: 'VALID', 3: 'VALID', 4: 'VALID' }, ordemDeExecucao: [1, 3, 2, 4] });
        assert.deepEqual(registros.map(o => [o.indice, o.ordens, o.status, o.executados, o.bloqueados]), [
            [0, [1, 3], 'CONCLUIDA', [1, 3], []],
            [1, [2], 'CONCLUIDA', [2], []],
            [2, [4], 'CONCLUIDA', [4], []]
        ]);
        assert.deepEqual(registros[2].dependencias, { 4: [2, 3] });
        assert.ok(registros.every(o => o.duracaoMs! >= 0));
    });

    await teste('sem concorrencia: o proximo PI so comeca quando o anterior termina, mesmo na mesma onda', async () => {
        const p = plano([n(1), n(2), n(3)]);
        let emCurso = 0;
        let maximo = 0;
        await executarOndas(p, registrosDeOndas(p), async () => {
            emCurso++;
            maximo = Math.max(maximo, emCurso);
            await new Promise(r => setTimeout(r, 5));
            emCurso--;
            return 'VALID';
        });
        assert.equal(maximo, 1, 'nunca dois PIs ao mesmo tempo');
    });

    await teste('caso 11 — retry do PI 2 fica dentro dele: PI 1 e PI 3 nao rodam de novo; o PI 4 so depois do 2 VALID', async () => {
        const p = plano([n(1), n(2), n(3), n(4, 2)]);
        const eventos: string[] = [];
        const tentativas: Record<number, number> = {};
        await executarOndas(p, registrosDeOndas(p), async ordem => {
            // O PI 2 reprova na primeira e passa na segunda — o retry e do resolver do PI.
            for (;;) {
                tentativas[ordem] = (tentativas[ordem] ?? 0) + 1;
                eventos.push(`PI ${ordem}#${tentativas[ordem]}`);
                if (ordem === 2 && tentativas[ordem] === 1) continue;
                eventos.push(`PI ${ordem} VALID`);
                return 'VALID';
            }
        });
        assert.deepEqual(tentativas, { 1: 1, 2: 2, 3: 1, 4: 1 });
        assert.deepEqual(eventos, ['PI 1#1', 'PI 1 VALID', 'PI 2#1', 'PI 2#2', 'PI 2 VALID', 'PI 3#1', 'PI 3 VALID', 'PI 4#1', 'PI 4 VALID']);
    });

    await teste('caso 12 — PI 1 UNRESOLVED: o PI 2 (depende do 1) nao roda; a execucao para, como antes', async () => {
        const p = plano([n(1), n(2, 1)]);
        const registros = registrosDeOndas(p);
        const { chamados, resolver } = resolverFalso({ 1: 'UNRESOLVED' });
        const r = await executarOndas(p, registros, resolver);
        assert.deepEqual(chamados, [1]);
        assert.deepEqual(r, { desfecho: 'UNRESOLVED', estados: { 1: 'UNRESOLVED', 2: 'PENDENTE' }, ordemDeExecucao: [1] });
        assert.deepEqual(registros.map(o => [o.status, o.executados, o.bloqueados]), [['INTERROMPIDA', [1], []], ['NAO_EXECUTADA', [], [2]]]);
    });

    await teste('o primeiro PI sem VALID encerra a execucao: o resto da onda nao roda (nao e bloqueio), os dependentes sim ficam bloqueados', async () => {
        const p = plano([n(1), n(2), n(3, 1), n(4, 2)]);
        const registros = registrosDeOndas(p);
        const { chamados, resolver } = resolverFalso({ 1: 'INVALID' });
        const r = await executarOndas(p, registros, resolver);
        assert.deepEqual(chamados, [1], 'INVALID com orcamento esgotado para tudo, como antes do scheduler');
        assert.equal(r.desfecho, 'INVALID');
        assert.deepEqual(registros.map(o => [o.status, o.executados, o.bloqueados]), [['INTERROMPIDA', [1], []], ['NAO_EXECUTADA', [], [3]]]);
    });

    await teste('falha tecnica no resolver: PI FAILED, ondas fechadas com os bloqueados, e a excecao sobe', async () => {
        const p = plano([n(1), n(2, 1), n(3, 2)]);
        const registros = registrosDeOndas(p);
        const { chamados, resolver } = resolverFalso({ 2: 'erro' });
        await assert.rejects(executarOndas(p, registros, resolver), /motor fora do ar no PI 2/);
        assert.deepEqual(chamados, [1, 2]);
        assert.deepEqual(registros.map(o => [o.status, o.bloqueados]), [['CONCLUIDA', []], ['INTERROMPIDA', []], ['NAO_EXECUTADA', [3]]]);
    });

    // =========================================================================
    console.log('\nNo fluxo multiagente (DSL real, dubles)');
    // =========================================================================

    const modelo = await loadModel(path.join('src', 'examples', 'med', 'uti.dsl'));
    const constraints = retrieveConstraints(modelo, CENARIO);
    const poda = pruningPayload(constraints, CENARIO);
    const contrato = montarContrato(poda, condutasPorDecisaoMed(modelo), constraints.escalonamentos.map(e => `${e.destino}: ${e.detalhe}`), esquemaDeDadosMed(modelo));
    const esquema = esquemaDeclaradoMed(modelo);
    const promptSemantico = montarPromptSemantico(constraints, CENARIO, poda);
    const conhecimentoDe = (id: string): ConhecimentoRecuperado<RetrievedConstraints> => ({
        constraints, foco: null, auditoriaRecuperacao: auditoriaVazia('deterministica', 'med', CENARIO.intencao!, id),
        poda, politicaEfetiva: poda, promptSemantico
    });
    const semSuporte = (p: PedidoPIAgent): string => saidaPI(p, { justificativa: 'Conforme solicitado pelo plantao' });

    async function fluxo(planoDoPlanner: string, piAgent: MotorPIAgent): Promise<ContextoExecucaoMultiagente> {
        const original = process.env.SPC_CML_DECODIFICACAO;
        const motor: MotorFragmento = async () => { throw new Error('nem incremental nem monolitica'); };
        const planner: MotorPlanner = async () => ({ saida: planoDoPlanner, tokens_prompt: 4000 });
        process.env.SPC_CML_DECODIFICACAO = 'multiagente';
        try {
            const r = (await decodificar({
                ...montarEntradaGeracao(CENARIO, constraints, modelo, poda, conhecimentoDe(`req-${Math.random()}`)),
                endpoint: 'http://127.0.0.1:9', motor, motorPlanner: planner, motorPIAgent: piAgent,
                verificadorGramatical: verificadorQueAceita()
            })) as ResultadoMultiagente;
            return r.execucao;
        } finally {
            if (original === undefined) delete process.env.SPC_CML_DECODIFICACAO;
            else process.env.SPC_CML_DECODIFICACAO = original;
        }
    }
    const porOrdem = (chamadas: PedidoPIAgent[]): number[] => chamadas.map(c => c.ordem);

    // Quatro PIs, o 4 dependendo do 2: [1, 2, 3] [4].
    const PLANO_4 = 'PLANO 1 | Propofol | Manter_Bloqueio | [ ] 2 | Noradrenalina | Acionar_Equipe | [ ] 3 | Vancomicina | Solicitar_Exame_Controle | [ ] 4 | Vasopressina | Acionar_Equipe | [ 2 ] FIM';
    // O 2 depende do 1; o 3 e independente: [1, 3] [2].
    const PLANO_3 = 'PLANO 1 | Propofol | Manter_Bloqueio | [ ] 2 | Noradrenalina | Acionar_Equipe | [ 1 ] 3 | Vancomicina | Solicitar_Exame_Controle | [ ] FIM';

    await teste('caso 11 no fluxo — PI 2 INVALID -> retry -> VALID; PI 1 e PI 3 uma chamada so; o PI 4 so depois do 2 VALID', async () => {
        const chamadas: PedidoPIAgent[] = [];
        const ctx = await fluxo(PLANO_4, piAgentRoteirizado({ 2: [semSuporte] }, chamadas));
        assert.equal(ctx.status, 'COMPLETED', JSON.stringify(ctx.historicoStatus.slice(-2)));
        assert.deepEqual(ctx.ondasPI.map(o => o.ordens), [[1, 2, 3], [4]]);
        assert.deepEqual(porOrdem(chamadas), [1, 2, 2, 3, 4]);
        assert.deepEqual(ctx.execucoesPI.map(e => [e.ordem, e.status, e.tentativas.length]), [[1, 'VALID', 1], [2, 'VALID', 2], [3, 'VALID', 1], [4, 'VALID', 1]]);
        // PI_EXECUTING do PI 4 so depois do PI 2 VALID (a ultima validacao do PI 2).
        const passos = ctx.historicoStatus.map(t => `${t.para} ${t.motivo ?? ''}`);
        const ultimaDoPI2 = passos.map((s, i) => [s, i] as const).filter(([s]) => /^PI_VALIDATING PI 2 /.test(s)).pop()![1];
        const primeiraDoPI4 = passos.findIndex(s => /^PI_EXECUTING PI 4 /.test(s));
        assert.ok(primeiraDoPI4 > ultimaDoPI2, 'o dependente espera o retry do predecessor');
        assert.deepEqual(ctx.resultadosPI.map(r => r.ordem), [1, 2, 3, 4]);
        assert.deepEqual(incoerenciasDoContexto(ctx), []);
    });

    await teste('composicao — execucao [1, 3] [2], artefato e resultados na ordem do Planner 1, 2, 3', async () => {
        const chamadas: PedidoPIAgent[] = [];
        const ctx = await fluxo(PLANO_3, piAgentQueObedece(chamadas));
        assert.equal(ctx.status, 'COMPLETED');
        assert.deepEqual(porOrdem(chamadas), [1, 3, 2], 'a execucao seguiu as ondas');
        assert.deepEqual(ctx.resultadosPI.map(r => r.ordem), [1, 2, 3]);
        assert.deepEqual(ctx.planoComposto!.resultados.map(r => r.ordem), [1, 2, 3]);
        assert.deepEqual(lerArtefato(ctx.artefatoFinal!, contrato.papeis).clausulas.map(c => c.item), ['Propofol', 'Noradrenalina', 'Vancomicina']);
    });

    await teste('registro das ondas e metricas do DAG: no contexto, no ciclo global e no resumo (JSON)', async () => {
        const ctx = await fluxo(PLANO_3, piAgentQueObedece());
        const p = ctx.planoExecucaoPI!;
        assert.deepEqual(p.metricas, { pis: 3, arestas: 1, ondas: 2, larguraMaxima: 2, profundidade: 2, pisPorOnda: [2, 1] });
        assert.deepEqual(ctx.ondasPI.map(o => [o.indice, o.ordens, o.dependencias, o.status, o.executados, o.bloqueados]), [
            [0, [1, 3], { 1: [], 3: [] }, 'CONCLUIDA', [1, 3], []],
            [1, [2], { 2: [1] }, 'CONCLUIDA', [2], []]
        ]);
        assert.ok(ctx.ondasPI.every(o => typeof o.duracaoMs === 'number'));
        const decomposto = ctx.historicoStatus.find(t => t.para === 'PI_DECOMPOSED')!;
        assert.equal(decomposto.motivo, '3 contexto(s) de PI em 2 onda(s), largura maxima 2');
        const [ciclo] = ctx.historicoGlobal;
        assert.equal(ciclo.planoExecucaoPI, p);
        assert.equal(ciclo.ondasPI, ctx.ondasPI);
        assert.deepEqual(ciclo.metricas.dag, p.metricas);
        const resumo = JSON.parse(JSON.stringify(resumoExecucao(ctx)));
        assert.deepEqual(resumo.planoExecucaoPI, p);
        assert.deepEqual(resumo.ondasPI, ctx.ondasPI);
    });

    /** Execucao ja em PI_DECOMPOSED, pela validacao e decomposicao reais. */
    function emPIDecomposto(seq: PIPlanejado[]): ContextoExecucaoMultiagente {
        const id = `req-${Math.random()}`;
        const ctx = novoContextoExecucao<ClinicalContext, RetrievedConstraints>({ dominio: 'med', pedido: CENARIO.intencao!, contexto: CENARIO, requestId: id, orcamento: ORCAMENTO_PADRAO });
        registrarConhecimento(ctx, conhecimentoDe(id));
        avancarStatus(ctx, 'PLANNING');
        avancarStatus(ctx, 'SEQUENCE_VALIDATING');
        const validacao = validarSequencia(seq, { contrato, politica: poda, regras: [], pedido: CENARIO.intencao! });
        assert.equal(validacao.veredito, 'VALID', JSON.stringify(validacao.erros));
        ctx.tentativasPlanner.push({ ciclo: 1, tentativa: 1, proposta: 'duble', validacao, fase: 'semantica', sequencia: seq });
        ctx.sequenciaValidada = validacao.valor;
        avancarStatus(ctx, 'SEQUENCE_VALID');
        decomporSequencia(ctx, { contrato, esquema });
        return ctx as ContextoExecucaoMultiagente;
    }

    await teste('caso 12 no fluxo — PI 1 UNRESOLVED: o PI 2 (depende do 1) nao e chamado, fica PENDENTE e bloqueado', async () => {
        const ctx = emPIDecomposto([
            { ordem: 1, item: 'Propofol', conduta: 'Manter_Bloqueio', dependeDe: [] },
            { ordem: 2, item: 'Noradrenalina', conduta: 'Acionar_Equipe', dependeDe: [1] }
        ]);
        // O contexto do PI 1 sem evidencia alguma, e a conduta exige justificativa: UNRESOLVED.
        ctx.contextosPI = [comoDadoPuro({ ...ctx.contextosPI![0], pedido: '', restricoes: [], fatos: [], regras: [], evidencias: [], telemetriaRelevante: {}, regrasRelacionais: [] }), ctx.contextosPI![1]];
        const chamadas: PedidoPIAgent[] = [];
        await resolverPIs(ctx, piAgentRoteirizado({ 1: [p => saidaPI(p, { justificativa: 'Mantido.' })] }, chamadas));
        assert.equal(ctx.status, 'UNRESOLVED');
        assert.deepEqual(porOrdem(chamadas), [1]);
        assert.deepEqual(ctx.execucoesPI.map(e => e.status), ['UNRESOLVED', 'PENDENTE'], 'nenhum resultado inventado para o PI 2');
        assert.deepEqual(ctx.ondasPI.map(o => [o.status, o.executados, o.bloqueados]), [['INTERROMPIDA', [1], []], ['NAO_EXECUTADA', [], [2]]]);
        assert.deepEqual(ctx.resultadosPI, []);
    });

    await teste('sequencia com ciclo forjada depois da validacao: FAILED no scheduler, sem decomposicao nem PI Agent', () => {
        const id = `req-${Math.random()}`;
        const ctx = novoContextoExecucao<ClinicalContext, RetrievedConstraints>({ dominio: 'med', pedido: CENARIO.intencao!, contexto: CENARIO, requestId: id, orcamento: ORCAMENTO_PADRAO });
        registrarConhecimento(ctx, conhecimentoDe(id));
        avancarStatus(ctx, 'PLANNING');
        avancarStatus(ctx, 'SEQUENCE_VALIDATING');
        const seq: PIPlanejado[] = [
            { ordem: 1, item: 'Propofol', conduta: 'Manter_Bloqueio', dependeDe: [2] },
            { ordem: 2, item: 'Noradrenalina', conduta: 'Acionar_Equipe', dependeDe: [1] }
        ];
        ctx.tentativasPlanner.push({ ciclo: 1, tentativa: 1, proposta: 'forjada', fase: 'semantica', sequencia: seq, validacao: { veredito: 'VALID', erros: [], avisos: [], dadosFaltantes: [], valor: seq } });
        ctx.sequenciaValidada = seq;
        avancarStatus(ctx, 'SEQUENCE_VALID');
        assert.throws(() => decomporSequencia(ctx, { contrato, esquema }), /DAG da sequencia validada recusado: .*ciclo_de_dependencias/);
        assert.equal(ctx.status, 'FAILED');
        assert.match(ctx.historicoStatus[ctx.historicoStatus.length - 1].motivo!, /^Scheduler de PIs: .*dependencia_posterior.*ciclo_de_dependencias: as dependencias formam um ciclo: 1 -> 2 -> 1/);
        assert.equal(ctx.contextosPI, undefined);
        assert.equal(ctx.planoExecucaoPI, undefined);
    });

    await teste('guardas e auditoria: sem DAG nao ha PI_EXECUTING; dependente executado sem predecessor VALID e incoerencia', () => {
        const ctx = emPIDecomposto([
            { ordem: 1, item: 'Propofol', conduta: 'Manter_Bloqueio', dependeDe: [] },
            { ordem: 2, item: 'Noradrenalina', conduta: 'Acionar_Equipe', dependeDe: [1] }
        ]);
        ctx.execucoesPI = ctx.contextosPI!.map(c => ({ ordem: c.pi!.ordem, item: c.pi!.item, conduta: c.pi!.conduta, status: 'PENDENTE' as const, tentativas: [], proibidas: [] }));
        const semDag = { ...ctx, planoExecucaoPI: undefined };
        assert.throws(() => avancarStatus(semDag, 'PI_EXECUTING'), /nenhum plano de execucao \(DAG\) dos PIs registrado/);
        assert.deepEqual(incoerenciasDoContexto(ctx), []);
        ctx.execucoesPI[1].tentativas = [{ ordem: 2, tentativa: 1, prompt: '', saida: '', fase: 'protocolo', validacao: { veredito: 'INVALID', erros: [{ codigo: 'x', mensagem: 'x' }], avisos: [], dadosFaltantes: [] }, admissiveis: [] }];
        assert.ok(incoerenciasDoContexto(ctx).includes('PI 2 executou sem o(s) predecessor(es) 1 VALID'));
    });

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
