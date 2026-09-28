import type { DetalheLado, StatusJuiz, VereditoSemantico } from './api';

/** Rótulo em português de cada estado — o mesmo para sintaxe, semântica, oráculo e juiz. */
export const ROTULO: Record<VereditoSemantico | StatusJuiz, string> = {
    VALID: 'VÁLIDO',
    INVALID: 'INVÁLIDO',
    UNRESOLVED: 'INDETERMINADO',
    NOT_EVALUATED: 'NÃO AVALIADA',
    NOT_CALLED: 'NÃO CHAMADO',
    NO_RESPONSE: 'SEM RESPOSTA'
};

/**
 * O tom visual de um lado é o do ORÁCULO — o resultado normativo. O juiz nunca
 * pinta a linha: a discordância aparece como marca à parte (⚠), e um oráculo
 * INVALID continua vermelho mesmo com o juiz dizendo VALID. UNRESOLVED tem cor
 * própria, distinta de INVALID e de "não avaliado".
 */
export type TomLado = 'neutro' | 'valido' | 'invalido' | 'indeterminado';

export function tomDoLado(lado: DetalheLado | undefined): TomLado {
    if (!lado || lado.naoAvaliado || !lado.oraculo) return 'neutro';
    const v = lado.oraculo.veredito;
    if (v === 'UNRESOLVED') return 'indeterminado';
    return v === 'VALID' && !lado.violacao ? 'valido' : 'invalido';
}

/** "oráculo INVÁLIDO · LLM VÁLIDO · ⚠ discordância" — a pill da linha e do painel. O oráculo vem primeiro. */
export function rotuloVeredicto(lado: DetalheLado | undefined): string {
    if (!lado) return '';
    if (lado.naoAvaliado || !lado.oraculo) return 'não avaliado';
    const partes = [`oráculo ${ROTULO[lado.oraculo.veredito]}`, `LLM ${ROTULO[lado.julgamentoLLM!.status]}`];
    if (lado.concordancia === false) partes.push('⚠ discordância');
    if (lado.violacao) partes.push('violação');
    return partes.join(' · ');
}

/** "linha 1, coluna 186" quando o parser informou a posição. */
export function posicao(e: { linha?: number; coluna?: number }): string {
    if (e.linha === undefined) return '';
    return e.coluna === undefined ? `linha ${e.linha}` : `linha ${e.linha}, coluna ${e.coluna}`;
}
