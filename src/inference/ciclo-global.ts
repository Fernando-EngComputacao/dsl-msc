/**
 * Composicao e validacao global de um ciclo do modo multiagente.
 *
 *     PI_ALL_VALID -> COMPOSING          comporPlano (knowledge/composicao.ts)
 *                  -> GLOBAL_VALIDATING  /verify (L(Ĝ), no motor) + validarPlanoGlobal
 *
 * O veredito fica em `ctx.validacaoGlobal`; o que fazer com ele (COMPLETED,
 * reinicio no Planner, UNRESOLVED) e do orquestrador (`decodificarMultiagente`).
 *
 * A SINTAXE E DO MOTOR. `/verify` reparseia o artefato contra a Ĝ da politica
 * efetiva — a mesma gramatica que o monolitico usa; nenhuma regra dela e
 * reescrita aqui. Um artefato composto de resultados validados que a gramatica
 * recusa e defeito interno (composicao ou divergencia entre politica e Ĝ), nao
 * erro do plano: FAILED, e nao um ciclo a mais.
 *
 * O FEEDBACK GLOBAL VAI AO PLANNER. Um plano globalmente reprovado volta
 * inteiro ao Planner — o problema pode ser a escolha de item e conduta, nao a
 * acao —, e nunca direto aos PI Agents.
 */

import { comporPlano, InconsistenciaComposicao, type PlanoComposto } from '../knowledge/composicao.js';
import type { SubgrafoPodado } from '../knowledge/politica.js';
import type { ResultadoValidacao } from '../knowledge/validacao.js';
import { relatorioGlobal, validarPlanoGlobal, type ConhecimentoGlobal } from '../knowledge/validacao-global.js';
import { avancarStatus, type ContextoExecucaoMultiagente, type DuracoesGlobais } from './multiagente.js';
import { comoProtocolo } from './planner.js';

/** O veredito do motor sobre a sintaxe: o artefato pertence a L(Ĝ)? */
export interface VerificacaoGramatical {
    valido: boolean;
    erro?: string | null;
}

/** Quem confere a sintaxe. O real e `/verify` (`verificadorGramaticaHttp`); injetavel para teste. */
export type VerificadorGramatical = (plano: string, subgrafo: SubgrafoPodado) => Promise<VerificacaoGramatical>;

/**
 * PI_ALL_VALID -> COMPOSING -> GLOBAL_VALIDATING, com o veredito em
 * `ctx.validacaoGlobal`; ou COMPOSING -> UNRESOLVED, quando o conhecimento nao
 * tem contexto para o cabecalho. Composicao inconsistente e artefato fora de
 * L(Ĝ) sobem como `InconsistenciaComposicao` (o orquestrador faz FAILED).
 */
export async function comporEValidarPlano(
    ctx: ContextoExecucaoMultiagente,
    k: ConhecimentoGlobal,
    verificador: VerificadorGramatical,
    agora: () => number = () => performance.now()
): Promise<DuracoesGlobais> {
    avancarStatus(ctx, 'COMPOSING', `${ctx.resultadosPI.length} resultado(s) de PI, na ordem do Planner`);
    const inicio = agora();
    const composto = comporPlano(ctx.sequenciaValidada!, ctx.resultadosPI, k.contrato, {
        requestId: ctx.requestId,
        ciclo: ctx.tentativaGlobal
    });
    const composicaoMs = Math.round((agora() - inicio) * 1000) / 1000;
    if (composto.veredito !== 'VALID') {
        ctx.errosValidacao.push(composto);
        avancarStatus(ctx, 'UNRESOLVED', `sem como compor o artefato: ${composto.dadosFaltantes.join('; ')}`);
        return { composicaoMs };
    }
    ctx.planoComposto = composto.valor!;

    avancarStatus(ctx, 'GLOBAL_VALIDATING');
    const inicioValidacao = agora();
    const gramatica = await verificador(ctx.planoComposto.texto, k.politica);
    if (!gramatica.valido) {
        throw new InconsistenciaComposicao(`o artefato composto nao pertence a L(Ĝ) da politica efetiva: ${gramatica.erro ?? 'sem detalhe'}`);
    }
    ctx.validacaoGlobal = validarPlanoGlobal(ctx.planoComposto, k);
    return { composicaoMs, validacaoGlobalMs: Math.round((agora() - inicioValidacao) * 1000) / 1000 };
}

/**
 * O feedback de um plano globalmente reprovado, para a secao
 * [FEEDBACK DA VALIDACAO ANTERIOR] do Planner no ciclo seguinte: o plano que
 * ele propos, as acoes que os PI Agents decidiram, e cada problema com os PIs
 * envolvidos, a regra, a evidencia e o reparo possivel.
 */
export function montarFeedbackGlobal(validacao: ResultadoValidacao, plano: PlanoComposto, ciclo: number): string {
    return [
        `PLANO GLOBAL REJEITADO pela validacao do plano completo (ciclo ${ciclo}).`,
        'Cada PI foi valido sozinho; o problema esta na combinacao, na cobertura ou na escolha de item e conduta.',
        `plano anterior: ${comoProtocolo(plano.pis)}`,
        'o que cada PI decidiu:',
        ...plano.resultados.map(r => `- PI ${r.ordem} (${r.item} -> ${r.conduta}): ${r.acao.decisao}`),
        'problemas:',
        relatorioGlobal(validacao.erros),
        'Proponha uma NOVA sequencia — outra combinacao de item e conduta, ou outra ordem — que evite os problemas acima.',
        'Gere novamente SOMENTE a sequencia de PIs.',
        'Nao produza acoes ou justificativas.'
    ].join('\n');
}
