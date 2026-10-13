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

/**
 * O nome do arquivo de uma avaliacao: `evalueted_<nome>_<AAAAMMDD-HHmmss>.jsonl`.
 *
 * `<nome>` e o do arquivo de entrada SEM o prefixo `results_` e SEM o carimbo
 * de data do proprio arquivo de resultados (`results_cenarios-2-fut_20261007-202028.jsonl`
 * -> `cenarios-2-fut`); o carimbo do final e o do INSTANTE DA AVALIACAO. Sem nome de
 * entrada (ou sem nada que sobre dele), `<nome>` e o dominio.
 */
export function nomeArquivoAvaliacao(nomeEntrada: string | undefined, dominio: string, agora: Date): string {
    const base = (nomeEntrada ?? '')
        .split(/[\\/]/)
        .pop()!
        .replace(/\.jsonl?$/i, '')
        .replace(/^results_/, '')
        .replace(/_\d{8}-\d{6}$/, '')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    const p = (n: number): string => String(n).padStart(2, '0');
    const carimbo = `${agora.getFullYear()}${p(agora.getMonth() + 1)}${p(agora.getDate())}-${p(agora.getHours())}${p(agora.getMinutes())}${p(agora.getSeconds())}`;
    return `evalueted_${base || dominio}_${carimbo}.jsonl`;
}
