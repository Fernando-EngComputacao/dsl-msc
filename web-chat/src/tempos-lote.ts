/**
 * Tempos do processamento em lote — instrumentação, sem efeito no pipeline.
 *
 * O tempo total de cada cenário e o do lote inteiro são medidos aqui, no
 * runner (`rodarLote`, chat.ts), com `performance.now()`. Os três tempos de
 * etapa NÃO são medidos de novo nem somados de cronômetros internos: são lidos
 * de `execucaoMultiagente.metricasExecucao.temposFases`, o relógio de parede de
 * cada fase que o próprio pipeline mede de ponta a ponta (ver `TemposFases`,
 * src/inference/multiagente.ts), com `try/finally`, em todos os ciclos e
 * tentativas — também quando a fase termina em exceção ou em FAILED:
 *
 *   sequências   Planner (cada chamada ao motor), validação da sequência e
 *                feedback entre as propostas, de todos os retries.
 *   PIs          decomposição da sequência e execução/validação dos PIs
 *                (onda a onda, retries dentro).
 *   validação    composição do plano, `/verify` e validação global, de todos os
 *                ciclos.
 *
 * Fora do modo multiagente (`SPC_CML_DECODIFICACAO=multiagente`) essas etapas
 * NÃO EXISTEM — o modo padrão, incremental, monta o artefato elemento a
 * elemento, sem Planner, PIs nem validação global —: os três ficam `null`.
 * Etapa que não chegou a começar também fica `null` — nunca zero inventado.
 */
import type { ExecucaoMultiagenteResposta, ResumoGate } from './api';

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
    const fases = execucao?.metricasExecucao?.temposFases;
    const ms = (v: number | undefined): number | null => (typeof v === 'number' ? arredondarMs(v) : null);
    return {
        tempoSequenciasMs: ms(fases?.sequenciasMs),
        tempoPIsValidasMs: ms(fases?.pisMs),
        tempoValidacaoPlanosMs: ms(fases?.validacaoPlanosMs)
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

/**
 * Os tempos do GATE DO ORÁCULO de um cenário (só quando o lote roda com a
 * validação ligada). Eles não entram em `TemposCenario`: lá `tempoTotalMs`
 * continua sendo SÓ a geração do plano que ficou (é o que a tela de avaliação
 * agrega como tempo de geração), e o que o gate acrescenta — as gerações
 * descartadas e as avaliações — fica separado, para nunca inflar aquele número.
 *
 * `tempoCenarioMs` é o relógio de parede do cenário inteiro, medido no runner
 * (`rodarLote`): todas as gerações mais todas as avaliações, incluindo a ida e
 * volta HTTP. Os outros três vêm medidos do servidor (`ResumoGate`), onde cada
 * parte é cronometrada em volta da chamada que a executa.
 */
export interface TemposGateCenario {
    /** Quantas gerações rodaram neste cenário (1 = o oráculo aceitou de primeira). */
    tentativasGeracao: number;
    tempoGeracaoDescartadaMs: number;
    tempoGeracaoDescartadaSegundos: number;
    /** Soma das avaliações de todas as tentativas (sintaxe + semântica [+ juiz]). */
    tempoValidacaoMs: number;
    tempoValidacaoSegundos: number;
    tempoCenarioMs: number;
    tempoCenarioSegundos: number;
}

export function temposDoGate(resumo: ResumoGate, tempoCenarioMs: number): TemposGateCenario {
    const descartada = arredondarMs(resumo.tempoGeracaoDescartadaMs);
    const validacao = arredondarMs(resumo.tempoAvaliacaoMs);
    const cenario = arredondarMs(tempoCenarioMs);
    return {
        tentativasGeracao: resumo.tentativas,
        tempoGeracaoDescartadaMs: descartada,
        tempoGeracaoDescartadaSegundos: emSegundos(descartada),
        tempoValidacaoMs: validacao,
        tempoValidacaoSegundos: emSegundos(validacao),
        tempoCenarioMs: cenario,
        tempoCenarioSegundos: emSegundos(cenario)
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
