/**
 * Tempos do processamento em lote — instrumentação, sem efeito no pipeline.
 *
 * O tempo total de cada cenário e o do lote inteiro são medidos aqui, no
 * runner (`rodarLote`, chat.ts), com `performance.now()`. Os três tempos de
 * etapa NÃO são medidos de novo: são lidos dos cronômetros que o próprio
 * pipeline multiagente já grava no resumo da execução que o servidor devolve
 * em `execucaoMultiagente` (ver `resumoExecucao`, src/inference/multiagente.ts):
 *
 *   sequências       cada proposta do Planner, de todos os ciclos, fica em
 *                    `tentativasPlanner` com `metricas.duracaoMs` (chamada ao
 *                    motor, fila incluída) e `metricas.duracaoValidacaoMs`
 *                    (`validarSequencia`, só quando a saída passou na leitura).
 *                    As propostas rodam uma depois da outra.
 *   PIs              `historicoGlobal[c].ondasPI[o].duracaoMs`: o relógio de
 *                    parede de cada onda (`executarOndas`), da primeira chamada
 *                    ao fim do último PI resolvido, com geração, validação e
 *                    retries dentro. As ondas rodam uma depois da outra, e os
 *                    PIs de uma onda também.
 *   validação        `historicoGlobal[c].metricas.duracaoComposicaoMs` +
 *                    `duracaoValidacaoGlobalMs` (`comporEValidarPlano`:
 *                    composição, `/verify` e `validarPlanoGlobal`).
 *
 * Fora do modo multiagente essas etapas não existem: os três ficam `null`.
 * Etapa que não rodou também fica `null` — nunca zero inventado.
 */
import type { ExecucaoMultiagenteResposta } from './api';

export interface TemposEtapas {
    tempoSequenciasMs: number | null;
    tempoPIsValidasMs: number | null;
    tempoValidacaoPlanosMs: number | null;
}

/** Os campos de tempo de UMA linha do JSONL de resultados. */
export interface TemposCenario {
    tempoTotalMs: number;
    tempoTotalSegundos: number;
    tempoSequenciasMs: number | null;
    tempoSequenciasSegundos: number | null;
    tempoPIsValidasMs: number | null;
    tempoPIsValidasSegundos: number | null;
    tempoValidacaoPlanosMs: number | null;
    tempoValidacaoPlanosSegundos: number | null;
}

const soma = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** Milissegundos com precisão de microssegundo. */
export function arredondarMs(ms: number): number {
    return Math.round(ms * 1000) / 1000;
}

/** A mesma duração em segundos, sem perder a precisão do milissegundo. */
export function emSegundos(ms: number): number;
export function emSegundos(ms: number | null): number | null;
export function emSegundos(ms: number | null): number | null {
    return ms === null ? null : Math.round(ms * 1000) / 1_000_000;
}

export function temposDasEtapas(execucao?: ExecucaoMultiagenteResposta): TemposEtapas {
    const tentativas = execucao?.tentativasPlanner ?? [];
    const ciclos = execucao?.historicoGlobal ?? [];
    const ondas = ciclos.flatMap(c => c.ondasPI ?? []).filter(o => typeof o.duracaoMs === 'number');
    const validacoes = ciclos
        .map(c => c.metricas)
        .filter(m => m !== undefined && (m.duracaoComposicaoMs !== undefined || m.duracaoValidacaoGlobalMs !== undefined));
    return {
        tempoSequenciasMs:
            tentativas.length === 0
                ? null
                : arredondarMs(soma(tentativas.map(t => (t.metricas?.duracaoMs ?? 0) + (t.metricas?.duracaoValidacaoMs ?? 0)))),
        tempoPIsValidasMs: ondas.length === 0 ? null : arredondarMs(soma(ondas.map(o => o.duracaoMs as number))),
        tempoValidacaoPlanosMs:
            validacoes.length === 0
                ? null
                : arredondarMs(soma(validacoes.map(m => (m!.duracaoComposicaoMs ?? 0) + (m!.duracaoValidacaoGlobalMs ?? 0))))
    };
}

export function temposDoCenario(tempoTotalMs: number, etapas: TemposEtapas): TemposCenario {
    const total = arredondarMs(tempoTotalMs);
    return {
        tempoTotalMs: total,
        tempoTotalSegundos: emSegundos(total),
        tempoSequenciasMs: etapas.tempoSequenciasMs,
        tempoSequenciasSegundos: emSegundos(etapas.tempoSequenciasMs),
        tempoPIsValidasMs: etapas.tempoPIsValidasMs,
        tempoPIsValidasSegundos: emSegundos(etapas.tempoPIsValidasMs),
        tempoValidacaoPlanosMs: etapas.tempoValidacaoPlanosMs,
        tempoValidacaoPlanosSegundos: emSegundos(etapas.tempoValidacaoPlanosMs)
    };
}

/** `results_<nome do arquivo de entrada, sem extensão>_<AAAAMMDD-HHmmss do início do lote>.jsonl` */
export function nomeArquivoResultados(nomeEntrada: string, inicioDoLote: Date): string {
    const base = nomeEntrada.replace(/\.[^./\\]+$/, '');
    const p = (n: number): string => String(n).padStart(2, '0');
    const d = inicioDoLote;
    const carimbo = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return `results_${base}_${carimbo}.jsonl`;
}
