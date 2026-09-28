/**
 * Dubles do PI Agent para os testes do modo multiagente. Nao e suite: nao
 * entra em `npm test` sozinho, e usado por elas.
 *
 * O duble "que obedece" monta a resposta SO com o que um PI Agent real recebe —
 * o payload do PI e o prompt —, nunca com o contexto de outro PI: a primeira
 * decisao e o primeiro valor que a politica do PI admite, o primeiro meio, e
 * uma justificativa copiada das linhas de evidencia e de telemetria do proprio
 * prompt (fatos verdadeiros, com os numeros como aparecem).
 */

import type { VerificadorGramatical } from '../inference/ciclo-global.js';
import type { MotorPIAgent, PedidoPIAgent, RespostaPIAgent } from '../inference/pi-agent.js';

/**
 * O `/verify` duble: aceita o artefato (a sintaxe e do motor, e estes testes
 * rodam offline) e guarda o que recebeu, para os testes conferirem que o
 * artefato composto foi, de fato, submetido.
 */
export function verificadorQueAceita(recebidos: string[] = []): VerificadorGramatical {
    return async plano => {
        recebidos.push(plano);
        return { valido: true, erro: null };
    };
}

/** Resposta do motor falso HTTP para `/verify`. */
export const RESPOSTA_VERIFY = { valido: true, erro: null };

/** O bloco `[TITULO]` do prompt, sem o titulo e sem `(nenhum)`. */
export function blocoDoPrompt(prompt: string, titulo: string): string[] {
    const linhas = prompt.split('\n');
    const inicio = linhas.indexOf(`[${titulo}]`);
    if (inicio < 0) return [];
    const bloco: string[] = [];
    for (const l of linhas.slice(inicio + 1)) {
        if (l.startsWith('[') || l.trim() === '') break;
        if (l !== '(nenhum)') bloco.push(l);
    }
    return bloco;
}

/**
 * Uma justificativa feita so de fatos do prompt: a primeira evidencia e a
 * primeira medida; sem nenhuma das duas, o proprio pedido.
 */
export function justificativaDoPrompt(prompt: string): string {
    const partes = [blocoDoPrompt(prompt, 'EVIDENCIAS')[0], blocoDoPrompt(prompt, 'TELEMETRIA RELEVANTE')[0]]
        .filter((x): x is string => Boolean(x))
        .map(l => l.replace(/^- /, ''));
    const texto = partes.length > 0 ? partes.join('; ') : `pedido: ${blocoDoPrompt(prompt, 'PEDIDO')[0] ?? ''}`;
    return texto.replace(/'/g, '');
}

/** A clausula do PI no protocolo, com os campos dados. */
export function saidaPI(
    pedido: PedidoPIAgent,
    campos: { decisao?: string; valor?: string; unidade?: string; meio?: string; justificativa?: string } = {}
): string {
    const p = pedido.subgrafo_regras.papeis;
    const politica = pedido.subgrafo_regras.politicas[0];
    const decisao = campos.decisao ?? politica.decisoes[0];
    const valores = politica.valoresPorDecisao?.[decisao] ?? politica.valores;
    const valor = campos.valor ?? valores[0]?.valor ?? '0.0';
    const unidade = campos.unidade ?? valores[0]?.unidade ?? politica.unidades[0] ?? 'un';
    const doPrompt = blocoDoPrompt(pedido.prompt, 'DECISOES ADMISSIVEIS')
        .find(l => l.startsWith(`${p.meio}: `))?.slice(p.meio.length + 2).split(', ')[0];
    const meio = campos.meio ?? politica.meios[0] ?? doPrompt ?? 'LIVRE';
    const justificativa = campos.justificativa ?? justificativaDoPrompt(pedido.prompt);
    return `PI ${pedido.ordem} | ${pedido.conduta} | ${p.clausula} ${politica.item} ${p.decisao} ${decisao} ` +
        `${p.campoQuantidade} ${valor} ${unidade} ${p.meio} ${meio} justificativa '${justificativa}' FIM`;
}

/** A resposta do motor para um pedido, obedecendo o protocolo e o contexto. */
export function respostaQueObedece(pedido: PedidoPIAgent): RespostaPIAgent {
    return { saida: saidaPI(pedido), tokens_prompt: 500 + pedido.ordem, valida_na_gramatica: true };
}

/** Um PI Agent duble que sempre responde dentro do protocolo e do contexto. */
export function piAgentQueObedece(chamadas: PedidoPIAgent[] = []): MotorPIAgent {
    return async pedido => {
        chamadas.push(pedido);
        return respostaQueObedece(pedido);
    };
}

/**
 * Um PI Agent duble roteirizado POR PI: para a ordem `n`, devolve `roteiro[n]`
 * em ordem, uma saida por chamada; um item `undefined` (ou roteiro esgotado)
 * responde obedecendo. Cada saida pode ser texto ou funcao do pedido.
 */
export function piAgentRoteirizado(
    roteiro: Record<number, (string | ((p: PedidoPIAgent) => string) | undefined)[]>,
    chamadas: PedidoPIAgent[] = []
): MotorPIAgent {
    return async pedido => {
        chamadas.push(pedido);
        const k = chamadas.filter(c => c.ordem === pedido.ordem).length - 1;
        const passo = roteiro[pedido.ordem]?.[k];
        const saida = passo === undefined ? saidaPI(pedido) : typeof passo === 'string' ? passo : passo(pedido);
        return { saida, tokens_prompt: 500 + pedido.ordem, valida_na_gramatica: true };
    };
}
