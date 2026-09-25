/**
 * Fase de GERACAO SEMANTICA: o LLM propoe um plano em texto livre.
 *
 *     pedido + Prompt Semantico + politica efetiva + evidencias
 *         -> MotorLLM.gerarPlanoSemantico (sem gramatica)
 *         -> plano candidato
 *
 * O plano candidato NAO e um artefato: nao passou por gramatica nem por
 * contrato. Ele so vira artefato na fase seguinte, a de REALIZACAO GRAMATICAL
 * (`decodificar`), e so depois de validado — o validador semantico e o laco de
 * reparo sao da Etapa 2 (SPC_CML_SEMANTIC_REPAIR, SPC_CML_MAX_RETRIES).
 *
 * Este modulo e a "camada superior" da abstracao: e aqui que a politica e as
 * evidencias viram texto. O backend recebe `sistema` e `usuario` prontos e nao
 * precisa conhecer a estrutura da politica.
 */

import { blocoPoliticaEfetiva, type SubgrafoPodado } from '../knowledge/politica.js';
import type { MotorLLM, PedidoGeracaoSemantica, ResultadoLLM } from './motor-llm.js';

export interface EntradaGeracaoSemantica {
    /** A fala do usuario, como chegou. */
    comando: string;
    /** O Prompt Semantico do dominio (`montarPromptSemantico*`), de preferencia ja com a politica efetiva. */
    promptSemantico: string;
    /** A politica efetiva desta requisicao: a mesma que depois vira gramatica e contrato. */
    politicaEfetiva: SubgrafoPodado;
    /** Fatos da leitura que o plano pode citar, um por linha. */
    evidencias?: string[];
    modelo?: string;
    temperatura?: number;
    maxTokens?: number;
    metadados?: Record<string, string | number | boolean>;
}

/**
 * O papel do modelo e os limites dele. O LLM propoe; quem decide o que e
 * permitido e a politica efetiva, que a gramatica e o contrato vao aplicar de
 * qualquer forma. Pedir aqui que ele respeite a politica nao a substitui: so
 * poupa tentativas que seriam reprovadas.
 */
export function instrucaoSemantica(politica: SubgrafoPodado): string {
    const { artefato, item, decisao } = politica.papeis;
    return [
        `Voce PROPOE um ${artefato} para o pedido abaixo. Voce nao decide o que e permitido.`,
        '',
        'A POLITICA VIGENTE no texto do usuario e a autoridade:',
        `- use apenas ${item} e ${decisao} que ela lista como exprimiveis;`,
        '- nao crie regras, permissoes, decisoes nem evidencias;',
        '- um fato que so aparece no pedido nao e leitura: sem o dado, diga "evidencia insuficiente".',
        '',
        'Responda com uma decisao por linha, neste formato:',
        `<${item}> | <${decisao}> | <justificativa, citando a evidencia usada>`
    ].join('\n');
}

/**
 * Monta o pedido. Se o Prompt Semantico veio sem o bloco da politica vigente,
 * ele e acrescentado: o modelo nao pode propor sem ver o que e exprimivel.
 */
export function montarPedidoSemantico(e: EntradaGeracaoSemantica): PedidoGeracaoSemantica {
    const partes = [`[PEDIDO]\n${e.comando}`, e.promptSemantico];
    if (!e.promptSemantico.includes('[POLITICA VIGENTE')) {
        partes.push(blocoPoliticaEfetiva(e.politicaEfetiva).join('\n'));
    }
    if (e.evidencias && e.evidencias.length > 0) {
        partes.push(['[EVIDENCIAS]', ...e.evidencias.map(ev => `- ${ev}`)].join('\n'));
    }
    return {
        sistema: instrucaoSemantica(e.politicaEfetiva),
        usuario: partes.filter(p => p.trim().length > 0).join('\n\n'),
        politicaEfetiva: e.politicaEfetiva,
        evidencias: e.evidencias,
        modelo: e.modelo,
        temperatura: e.temperatura,
        maxTokens: e.maxTokens,
        metadados: { artefato: e.politicaEfetiva.papeis.artefato, ...e.metadados }
    };
}

/** Propoe o plano candidato. Qualquer backend serve: esta fase nao usa gramatica. */
export function gerarPlanoSemantico(motor: MotorLLM, e: EntradaGeracaoSemantica): Promise<ResultadoLLM> {
    return motor.gerarPlanoSemantico(montarPedidoSemantico(e));
}
