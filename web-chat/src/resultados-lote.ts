/**
 * O JSONL que o lote baixa (ChatView → "Baixar resultados").
 *
 * Sem o gate ligado, cada linha é o que sempre foi: o cenário, o
 * plano gerado e os tempos da geração.
 *
 * Com o gate ligado (ver `gateLote` em chat.ts e `processarComGate` em
 * src/web/server.ts) — reprovando pelo oráculo, pelo juiz LLM ou pelos dois —,
 * a linha sai no MESMO formato do JSONL da avaliação
 * (`registrosJsonl`, src/inference/avaliar-grafo.ts): além do plano, as camadas
 * separadas (sintaxe, semântica, oráculo, juiz), `dominio` e `lado`. É isso que
 * faz o arquivo do lote já poder ser aberto em "Importar resultado" sem passar
 * de novo por "Julgar resultado" — o plano já saiu da geração avaliado.
 *
 * O arquivo continua aceito em "Julgar resultado" (/api/avaliar lê `plano` e
 * `telemetria` e ignora o resto): reavaliar é uma escolha, não uma obrigação.
 *
 * Nada aqui recalcula veredito: os agregados são somas dos tempos que a geração
 * e a avaliação já mediram, e campo que nenhum registro trouxe fica ausente —
 * nunca zero inventado.
 */

import { emSegundos } from './tempos-lote';
import type { ItemResultadoLote, LoteEstado } from './types';

/** ms → s com 2 casas: a mesma arredondada dos agregados do servidor (`somaSegundos`). */
const segundos = (ms: number): number => Math.round(ms / 10) / 100;

/** Soma um campo numérico sobre os itens; `undefined` quando nenhum item o trouxe. */
function soma<T>(itens: T[], ler: (item: T) => number | null | undefined): number | undefined {
    const valores = itens.map(ler).filter((v): v is number => typeof v === 'number');
    return valores.length === 0 ? undefined : valores.reduce((a, b) => a + b, 0);
}

/** Como o servidor faz em `registrosJsonl`: o agregado do arquivo repetido em toda linha. */
export function agregadosDoLote(resultados: ItemResultadoLote[]): Record<string, number> {
    const somaSegundos = (ler: (r: ItemResultadoLote) => number | null | undefined): number | undefined => {
        const total = soma(resultados, ler);
        return total === undefined ? undefined : segundos(total);
    };
    const comCampo = (campo: string, valor: number | undefined): Record<string, number> =>
        valor === undefined ? {} : { [campo]: valor };

    return {
        // Tempos da AVALIAÇÃO (o gate), somados dos cronômetros de cada plano.
        // `tempoAvaliacaoTotalSegundos` tem nome próprio porque, num arquivo de
        // lote, `tempoTotalSegundos` já é o tempo de GERAÇÃO de um cenário.
        ...comCampo('tempoAvaliacaoTotalSegundos', somaSegundos(r => r.avaliacao?.tempos?.totalMs)),
        ...comCampo('tempoSintaxeSegundos', somaSegundos(r => r.avaliacao?.tempos?.sintaxeMs)),
        ...comCampo('tempoOraculoSegundos', somaSegundos(r => r.avaliacao?.tempos?.oraculoMs)),
        ...comCampo('tempoLlmJudgeSegundos', somaSegundos(r => r.avaliacao?.tempos?.llmJudgeMs)),
        ...comCampo('tempoDiagnosticoSegundos', somaSegundos(r => r.avaliacao?.tempos?.diagnosticoMs)),
        // Tempos de GERAÇÃO dos cenários — os mesmos que /api/avaliar agrega de
        // `tempoTotalMs` quando o arquivo é reavaliado, para a soma bater.
        ...comCampo('tempoGeracaoTotalSegundos', somaSegundos(r => r.tempoTotalMs)),
        ...comCampo('tempoGeracaoSequenciasSegundos', somaSegundos(r => r.tempoSequenciasMs)),
        ...comCampo('tempoGeracaoPIsValidasSegundos', somaSegundos(r => r.tempoPIsValidasMs)),
        ...comCampo('tempoGeracaoValidacaoPlanosSegundos', somaSegundos(r => r.tempoValidacaoPlanosMs))
    };
}

/**
 * Uma linha do arquivo. A ordem importa para quem lê o JSONL na mão: primeiro o
 * que identifica a linha, depois o cenário e o plano, depois as camadas da
 * avaliação e, por último, os agregados.
 *
 * `plano` é o da geração (o texto que foi avaliado é o mesmo, ver
 * `registroDaGeracao` no servidor), então o `plano` que vem dentro da avaliação
 * é descartado aqui em vez de sobrescrevê-lo.
 */
export function linhaDoResultado(
    dominio: 'med' | 'agro' | 'fut',
    item: ItemResultadoLote,
    agregados: Record<string, number>
): Record<string, unknown> {
    const { avaliacao, geracaoValidada, ...cenario } = item;
    if (!avaliacao) {
        // Lote sem gate (ou linha que nem chegou a gerar): o formato antigo, intacto.
        return { ...cenario, ...(geracaoValidada ? { geracaoValidada } : {}) };
    }
    const { plano: _planoAvaliado, contextoGrafo: _contextoGrafo, ...camadas } = avaliacao;
    return {
        dominio,
        // O lote do chat gera SEMPRE pela arquitetura; a baseline vem de fora.
        lado: 'arquitetura',
        ...cenario,
        ...camadas,
        ...(geracaoValidada ? { geracaoValidada } : {}),
        ...agregados
    };
}

/** Contagens do lote inteiro, para a última linha (resumo) e para a tela. */
export interface ResumoVereditosLote {
    avaliados: number;
    /** Vereditos do ORÁCULO nas linhas que ficaram. */
    valid: number;
    invalid: number;
    unresolved: number;
    naoAvaliados: number;
    /** Status do JUIZ nas linhas que ficaram (só conta quando ele rodou). */
    juizValid: number;
    /** Juiz INVALID ou UNRESOLVED na linha que ficou. */
    juizReprovou: number;
    /** Juiz sem veredito na linha que ficou (`NOT_CALLED`, `NO_RESPONSE`). */
    juizSemVeredito: number;
    /** Linhas que o critério do gate NÃO aprovou (teto batido, falha técnica). */
    naoAprovados: number;
    /** Cenários aprovados já na primeira geração. */
    aceitosDePrimeira: number;
    /** Cenários que bateram o teto de tentativas sem aprovação. */
    limiteAtingido: number;
    /** Gerações rodadas no lote (com o gate, pode passar do número de cenários). */
    geracoes: number;
    /** Gerações descartadas por quem reprovou — o custo do gate, repartido. */
    descartesPeloOraculo: number;
    descartesPeloJuiz: number;
}

export function resumoVereditos(resultados: ItemResultadoLote[]): ResumoVereditosLote {
    const resumo: ResumoVereditosLote = {
        avaliados: 0,
        valid: 0,
        invalid: 0,
        unresolved: 0,
        naoAvaliados: 0,
        juizValid: 0,
        juizReprovou: 0,
        juizSemVeredito: 0,
        naoAprovados: 0,
        aceitosDePrimeira: 0,
        limiteAtingido: 0,
        geracoes: 0,
        descartesPeloOraculo: 0,
        descartesPeloJuiz: 0
    };
    for (const r of resultados) {
        const gate = r.geracaoValidada;
        resumo.geracoes += gate?.tentativas ?? (r.plano !== undefined || r.erro !== undefined ? 1 : 0);
        if (gate?.limiteAtingido) resumo.limiteAtingido++;
        if (gate?.aceita && gate.tentativas === 1) resumo.aceitosDePrimeira++;
        if (gate && !gate.aceita) resumo.naoAprovados++;
        for (const d of gate?.descartadas ?? []) {
            if (d.fonte === 'juiz') resumo.descartesPeloJuiz++;
            else resumo.descartesPeloOraculo++;
        }
        if (!r.avaliacao) continue;

        const juiz = r.avaliacao.julgamentoLLM?.status;
        if (juiz === 'VALID') resumo.juizValid++;
        else if (juiz === 'INVALID' || juiz === 'UNRESOLVED') resumo.juizReprovou++;
        else if (juiz !== undefined) resumo.juizSemVeredito++;

        if (r.avaliacao.naoAvaliado || !r.avaliacao.oraculo) {
            resumo.naoAvaliados++;
            continue;
        }
        resumo.avaliados++;
        const veredito = r.avaliacao.oraculo.veredito;
        if (veredito === 'VALID') resumo.valid++;
        else if (veredito === 'INVALID') resumo.invalid++;
        else resumo.unresolved++;
    }
    return resumo;
}

/** O que o gate acrescenta ao resumo: o critério usado, as contagens e o custo. */
function blocoDoGate(lote: LoteEstado, vereditos: ResumoVereditosLote): Record<string, unknown> {
    const validacaoMs = soma(lote.resultados, r => r.tempoValidacaoMs);
    const descartadaMs = soma(lote.resultados, r => r.tempoGeracaoDescartadaMs);
    return {
        gate: {
            criterio: lote.validacao?.criterio,
            maxTentativas: lote.validacao?.maxTentativas,
            juizLLM: lote.validacao?.juiz,
            ...vereditos
        },
        ...(validacaoMs === undefined ? {} : { tempoValidacaoTotalSegundos: segundos(validacaoMs) }),
        ...(descartadaMs === undefined ? {} : { tempoGeracaoDescartadaTotalSegundos: segundos(descartadaMs) })
    };
}

/**
 * A última linha do arquivo: o resumo do lote. Ela não tem `plano` nem `lado`,
 * então nem /api/avaliar nem a tela de importação a tomam por um registro de
 * resultado — é só o fecho legível do experimento.
 */
export function linhaDeResumo(lote: LoteEstado, agregados: Record<string, number>): Record<string, unknown> {
    const vereditos = resumoVereditos(lote.resultados);
    return {
        duracaoSegundos: lote.duracaoSegundos ?? Number(((Date.now() - lote.iniciadoEm) / 1000).toFixed(1)),
        quantidadeCenariosProcessados: lote.resultados.length,
        // Mantem a precisao de microssegundo que o lote media antes do gate.
        ...(lote.tempoTotalBatchMs !== undefined
            ? { tempoTotalBatchMs: lote.tempoTotalBatchMs, tempoTotalBatchSegundos: emSegundos(lote.tempoTotalBatchMs) }
            : {}),
        ...(lote.validacao ? blocoDoGate(lote, vereditos) : {}),
        ...agregados
    };
}

/** O arquivo inteiro: uma linha JSON por cenário e a linha de resumo no fim. */
export function conteudoDoArquivo(dominio: 'med' | 'agro' | 'fut', lote: LoteEstado): string {
    const agregados = agregadosDoLote(lote.resultados);
    const linhas = lote.resultados.map(item => JSON.stringify(linhaDoResultado(dominio, item, agregados)));
    linhas.push(JSON.stringify(linhaDeResumo(lote, agregados)));
    return linhas.join('\n');
}
