/**
 * O QUE O TESTE DE CONEXÃO PROVOU, peça por peça — a leitura que transforma uma
 * mensagem crua do provedor ("o provedor respondeu 503: …") em três respostas
 * diretas: a CHAVE serve? o MODELO existe? o PROVEDOR atendeu?
 *
 * Existe porque a mensagem do provedor não responde isso sozinha. Um 503
 * "high demand" parece falha de configuração e não é: o provedor só chega ao
 * 503 DEPOIS de autenticar o pedido e achar o modelo — logo chave e modelo
 * estão de pé, e o que falta é tentar de novo. Um 400 do Gemini, ao contrário,
 * costuma ser chave inválida, onde os outros provedores mandariam 401.
 *
 * A regra é a de `causaDoStatus` (src/inference/juiz-fronteira.ts), que é quem
 * olha o status e o corpo; aqui só se traduz a causa em "o que está provado" e
 * "o que fazer agora". NADA é deduzido do texto do erro nesta camada.
 *
 * O que uma peça `indefinido` quer dizer: o teste parou antes de chegar nela.
 * Com a chave recusada, por exemplo, o provedor nunca olhou o nome do modelo —
 * dizer que o modelo está certo seria inventar.
 */

import type { ResultadoTesteJuiz } from './api';

/** As peças que o teste consegue julgar separadamente. */
export type PecaTeste = 'chave' | 'modelo' | 'provedor';

/** `ok`: provado que funciona. `falhou`: é esta a peça errada. `indefinido`: o teste não chegou lá. */
export type EstadoPeca = 'ok' | 'falhou' | 'indefinido';

export interface LinhaDiagnostico {
    peca: PecaTeste;
    rotulo: string;
    estado: EstadoPeca;
    /** Por que este estado, em uma linha. */
    detalhe: string;
}

export interface DiagnosticoTeste {
    linhas: LinhaDiagnostico[];
    /** O próximo passo de quem está olhando a tela. */
    acao: string;
}

const ROTULO: Record<PecaTeste, string> = {
    chave: 'Chave de API',
    modelo: 'Modelo',
    provedor: 'Provedor'
};

/** Tudo passou: foi uma ida e volta inteira. */
const SUCESSO: Record<PecaTeste, string> = {
    chave: 'aceita pelo provedor',
    modelo: 'existe e respondeu',
    provedor: 'respondeu no formato do juiz'
};

/**
 * Por causa da falha: o estado de cada peça e o que fazer. A chave do mapa é a
 * `causa` que o servidor devolveu — nunca o texto do erro.
 */
const POR_CAUSA: Record<
    string,
    { estados: Record<PecaTeste, EstadoPeca>; detalhes: Record<PecaTeste, string>; acao: string }
> = {
    chave: {
        estados: { chave: 'falhou', modelo: 'indefinido', provedor: 'ok' },
        detalhes: {
            chave: 'recusada: inválida, expirada, sem permissão para este modelo ou com a API do provedor desabilitada no projeto',
            modelo: 'não dá para saber: o provedor parou na autenticação, antes de olhar o nome do modelo',
            provedor: 'no ar — respondeu, e a resposta foi uma recusa'
        },
        acao: 'Gere uma chave nova no painel do provedor e cole aqui. No Gemini, confira também se a API Generative Language está habilitada no projeto da chave.'
    },
    modelo: {
        estados: { chave: 'ok', modelo: 'falhou', provedor: 'ok' },
        detalhes: {
            chave: 'aceita: o provedor autenticou o pedido antes de recusar o modelo',
            modelo: 'não existe para esta chave, ou o nome está escrito de outro jeito',
            provedor: 'no ar'
        },
        acao: 'Confira o nome exato do modelo na documentação do provedor (ou deixe o campo em branco para usar o padrão).'
    },
    cota: {
        estados: { chave: 'ok', modelo: 'ok', provedor: 'ok' },
        detalhes: {
            chave: 'aceita: o limite só é contado depois de autenticar',
            modelo: 'existe: o pedido chegou a ser roteado para ele',
            provedor: 'no ar, mas recusou por limite de uso (429)'
        },
        acao: 'Nada a corrigir aqui: espere o limite renovar, ou use uma chave com cota maior. Numa avaliação em lote, a repetição automática costuma dar conta.'
    },
    provedor: {
        estados: { chave: 'ok', modelo: 'ok', provedor: 'falhou' },
        detalhes: {
            chave: 'aceita: chave recusada viria como 401/403, não como 5xx',
            modelo: 'existe: o pedido foi roteado para ele antes de falhar',
            provedor: 'sobrecarregado ou fora do ar neste momento (5xx)'
        },
        acao: 'Não é a sua configuração: tente de novo em alguns instantes. Se insistir, use outro modelo do mesmo provedor — a sobrecarga costuma ser de um modelo só.'
    },
    rede: {
        estados: { chave: 'indefinido', modelo: 'indefinido', provedor: 'falhou' },
        detalhes: {
            chave: 'não testada: o pedido não chegou ao provedor',
            modelo: 'não testado: o pedido não chegou ao provedor',
            provedor: 'inacessível do servidor da avaliação (DNS, proxy, firewall ou tempo esgotado)'
        },
        acao: 'Veja se o servidor da avaliação tem saída para a internet (proxy, firewall) e tente de novo.'
    },
    formato: {
        estados: { chave: 'ok', modelo: 'ok', provedor: 'falhou' },
        detalhes: {
            chave: 'aceita',
            modelo: 'existe e respondeu',
            provedor: 'respondeu fora do contrato do juiz: faltou evidências, justificativa ou veredito'
        },
        acao: 'A chave e o modelo servem, mas este modelo não segue o formato de três linhas do juiz — prefira um modelo de instrução do mesmo provedor. Numa avaliação, isto viraria NO_RESPONSE (nenhum veredito é inventado).'
    },
    desconhecida: {
        estados: { chave: 'indefinido', modelo: 'indefinido', provedor: 'ok' },
        detalhes: {
            chave: 'não dá para saber pelo que o provedor respondeu',
            modelo: 'não dá para saber pelo que o provedor respondeu',
            provedor: 'respondeu, mas recusou o pedido por um motivo que não é chave, modelo, cota nem sobrecarga'
        },
        acao: 'Leia a mensagem do provedor acima: ela diz o que ele recusou.'
    }
};

/**
 * O diagnóstico do resultado de um teste. Sucesso é o caso simples: as três
 * peças passaram, porque a ida e volta inteira aconteceu. Falha olha só a
 * `causa`; sem ela (servidor antigo, pedido mal formado), cai no caso
 * `desconhecida`, que não afirma nada sobre chave nem modelo.
 */
export function diagnosticoDoTeste(resultado: ResultadoTesteJuiz): DiagnosticoTeste {
    const pecas: PecaTeste[] = ['chave', 'modelo', 'provedor'];

    if (resultado.ok) {
        return {
            linhas: pecas.map(peca => ({ peca, rotulo: ROTULO[peca], estado: 'ok' as const, detalhe: SUCESSO[peca] })),
            acao: 'Nada a corrigir: pode usar este juiz na avaliação.'
        };
    }

    const mapa = POR_CAUSA[resultado.causa ?? 'desconhecida'] ?? POR_CAUSA.desconhecida;
    return {
        linhas: pecas.map(peca => ({
            peca,
            rotulo: ROTULO[peca],
            estado: mapa.estados[peca],
            detalhe: mapa.detalhes[peca]
        })),
        acao: mapa.acao
    };
}

/** O resumo de uma linha do que falhou, para o título do resultado. */
export function tituloDaFalha(resultado: ResultadoTesteJuiz): string {
    const status = resultado.status !== undefined ? ` (HTTP ${resultado.status})` : '';
    switch (resultado.causa) {
        case 'chave':
            return `A chave de API foi recusada${status}`;
        case 'modelo':
            return `O modelo não existe para esta chave${status}`;
        case 'cota':
            return `Limite de uso estourado${status} — chave e modelo estão certos`;
        case 'provedor':
            return `O provedor está sobrecarregado ou fora do ar${status} — não é a sua configuração`;
        case 'rede':
            return 'O servidor da avaliação não chegou ao provedor';
        case 'formato':
            return 'O modelo respondeu fora do formato que o juiz exige';
        default:
            return `O provedor recusou o pedido${status}`;
    }
}
