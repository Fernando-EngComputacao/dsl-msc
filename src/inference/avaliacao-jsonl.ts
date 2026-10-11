export interface RegistroAvaliacaoImportado {
    dominio?: string;
    lado?: string;
    linha?: number;
    intencao?: string;
    plano?: string;
    sujeito?: string;
    naoAvaliado?: boolean;
    validacaoSintatica?: { veredito?: string; [campo: string]: unknown };
    ast?: { $type?: string; name?: string; [campo: string]: unknown };
    validacaoSemantica?: { veredito?: string; [campo: string]: unknown };
    oraculo?: { veredito?: string; origem?: string; [campo: string]: unknown };
    julgamentoLLM?: { status?: string; [campo: string]: unknown };
    tempoTotalSegundos?: number;
    tempoSintaxeSegundos?: number;
    tempoOraculoSegundos?: number;
    tempoLlmJudgeSegundos?: number;
    /** Tempos de GERAÇÃO dos cenários avaliados (ver tempos-lote.ts, web-chat), repassados e agregados pela avaliação. */
    tempoGeracaoTotalSegundos?: number;
    tempoGeracaoSequenciasSegundos?: number;
    tempoGeracaoPIsValidasSegundos?: number;
    tempoGeracaoValidacaoPlanosSegundos?: number;
    concordancia?: boolean;
    classificacao?: string;
    tempos?: { sintaxeMs?: number; recuperacaoMs?: number; oraculoMs?: number | null; llmJudgeMs?: number | null; paraleloMs?: number; totalMs?: number };
    [campo: string]: unknown;
}

/** Lê um objeto JSON por linha sem transformar nem descartar campos do registro. */
export function parseRegistrosAvaliacao(texto: string): RegistroAvaliacaoImportado[] {
    const registros: RegistroAvaliacaoImportado[] = [];
    for (const [indice, linha] of texto.split(/\r?\n/).entries()) {
        if (!linha.trim()) continue;
        let valor: unknown;
        try {
            valor = JSON.parse(linha);
        } catch {
            throw new Error(`JSON inválido na linha ${indice + 1}.`);
        }
        if (!valor || typeof valor !== 'object' || Array.isArray(valor)) {
            throw new Error(`Registro inválido na linha ${indice + 1}: esperado um objeto JSON.`);
        }
        registros.push(valor as RegistroAvaliacaoImportado);
    }
    if (registros.length === 0) throw new Error('O arquivo não contém registros JSONL.');
    return registros;
}
