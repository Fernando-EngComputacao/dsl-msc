/**
 * Contexto de geracao POR ITEM — a unidade operacional da arquitetura PI.
 *
 * Hoje a decodificacao e orientada ao ARTEFATO: um prefixo textual que cresce, a
 * sequencia de condutas ditando a ordem das clausulas, e o estado acumulado
 * entrando na gramatica de cada passo. Este modulo nao muda esse fluxo. Ele
 * isola, como dado, o que cada item precisa para ser processado SOZINHO — que e
 * a condicao para, mais adiante, processa-los em paralelo.
 *
 * NAO E UMA POLITICA NOVA. `PoliticaItem` continua sendo a unidade normativa, e
 * `SubgrafoPodado` o tipo operacional. `ContextoGeracaoItem` e uma PROJECAO: ele
 * aponta para o item e carrega um subgrafo de UMA politica, sem copiar nem
 * reinterpretar nada.
 *
 * ---------------------------------------------------------------------------
 * O QUE E LOCAL E O QUE E GLOBAL — a separacao que este modulo materializa
 *
 * LOCAL ao item (cabe em `ContextoGeracaoItem`):
 *   - o proprio `PoliticaItem`: decisoes, meios, unidades, valores,
 *     valoresPorDecisao, bloqueado, motivos;
 *   - a gramatica especializada dele. Conferido contra o motor real: com UMA
 *     politica no payload, `especializar_por_item` emite
 *     `ordem ::= ordem_<item>` e nenhum outro item aparece na BNF. O lado
 *     Python nao precisa de alteracao alguma para gerar por item;
 *   - as `RegraValidada` que incidem sobre ele (ver `agruparPorItem`);
 *   - a validacao de UMA clausula: item na poda, decisao admissivel, meio,
 *     valor no reticulo. `verificarClausulas` com lista de um elemento ja faz
 *     exatamente isso — `vistos` nasce vazio, entao a unicidade nao dispara.
 *
 * GLOBAL (fica no `SubgrafoPodado` e no `ContratoArtefato`, e e apenas
 * REFERENCIADO aqui):
 *   - `papeis`, `constantes` (sujeito, contextos), `esquema`;
 *   - `condutaPorDecisao`, `escalonamentos`, `unicidade`;
 *   - o Prompt Semantico.
 *
 * E as validacoes que NAO cabem por item, e por isso continuam depois de todos:
 * unicidade, coerencia sequencia/clausulas, escalonamento disparado e artefato
 * vazio. Ver `verificarArtefato`.
 * ---------------------------------------------------------------------------
 *
 * ESTA ETAPA NAO PARALELIZA. Nao ha `Promise.all`, worker, processo extra nem
 * mudanca no lock do motor. A ordem original de cada item e preservada em
 * `metadata.ordemOriginal` justamente para que uma execucao futura fora de ordem
 * possa ser remontada de forma deterministica.
 */

import type { PoliticaItem, SubgrafoPodado } from './politica.js';
import type { RegraValidada } from './recuperacao-cypher.js';
import { agruparPorItem } from './recuperacao-politica.js';
import type { Dominio } from './recuperacao.js';

/**
 * Tudo que o processamento de UM item precisa.
 *
 * `subgrafo` e `subgrafoDoItem` convivem de proposito: o primeiro e a poda
 * completa, necessaria para ler papeis e constantes e para as verificacoes que
 * so existem em relacao ao conjunto; o segundo e o payload que vai ao motor
 * quando se quer gerar a clausula DESTE item e de mais nenhum.
 */
export interface ContextoGeracaoItem {
    /** A unidade normativa. Nao e copiada: e o mesmo objeto da poda. */
    item: PoliticaItem;
    /** A poda completa do cenario — papeis, constantes e os demais itens. */
    subgrafo: SubgrafoPodado;
    /** A poda reduzida a este item: e o payload que gera Ĝ_i no motor. */
    subgrafoDoItem: SubgrafoPodado;
    /** Regras do Cypher que incidem sobre este item (ver `agruparPorItem`). */
    regras: RegraValidada[];
    /** Evidencia por regra: o que foi observado e o que era exigido. */
    evidencias: { regraId: string; campo: string; observado: number; esperado: string }[];
    metadata: {
        itemId: string;
        dominio?: Dominio;
        /** Posicao do item na poda de origem, para remontagem deterministica. */
        ordemOriginal: number;
    };
}

/**
 * Reduz a poda a UM item, preservando tudo que e global.
 *
 * `papeis` e `constantes` viajam intactos — sao o que permite ao motor montar o
 * cabecalho e fixar sujeito e contexto como literais. As tres chaves legadas sao
 * recalculadas a partir da politica que sobrou, exatamente como `montarSubgrafo`
 * e `restringirADecisoes` ja fazem.
 *
 * Devolve `undefined` quando o item nao esta na poda: um item fora da politica
 * nao tem subgrafo, e inventar um vazio faria o motor responder 422 no lugar de
 * o chamador perceber o erro aqui.
 */
export function subgrafoDeItem(
    subgrafo: SubgrafoPodado,
    item: string
): SubgrafoPodado | undefined {
    const politica = subgrafo.politicas.find(p => p.item === item);
    if (!politica) return undefined;

    return {
        ...subgrafo,
        politicas: [politica],
        acoes_permitidas: [...politica.decisoes],
        farmacos_liberados: [politica.item],
        vias_disponiveis: [...politica.meios]
    };
}

export interface OpcoesContextoItem {
    /** Regras validadas do cenario inteiro; sao distribuidas por item. */
    validadas?: RegraValidada[];
    dominio?: Dominio;
}

/** A evidencia de uma regra, achatada para leitura — ver `RegraValidada`. */
function evidenciasDe(regras: RegraValidada[]): ContextoGeracaoItem['evidencias'] {
    return regras.flatMap(r =>
        [...r.condicoesSatisfeitas, ...r.condicoesFalhas].map(c => ({
            regraId: r.regraId,
            campo: c.campo,
            observado: c.observado,
            esperado: c.esperado
        }))
    );
}

/**
 * Um `ContextoGeracaoItem` para cada item da poda, na ordem da poda.
 *
 * Funcao pura: nao gera, nao consulta grafo, nao chama motor. E so o recorte
 * que torna cada item processavel isoladamente.
 */
export function contextosPorItem(
    subgrafo: SubgrafoPodado,
    opcoes: OpcoesContextoItem = {}
): ContextoGeracaoItem[] {
    const porItem = agruparPorItem(opcoes.validadas ?? []);

    return subgrafo.politicas.map((item, ordemOriginal) => {
        const regras = porItem.get(item.item) ?? [];
        return {
            item,
            subgrafo,
            // Nunca `undefined` aqui: o item vem da propria lista de politicas.
            subgrafoDoItem: subgrafoDeItem(subgrafo, item.item)!,
            regras,
            evidencias: evidenciasDe(regras),
            metadata: { itemId: item.item, dominio: opcoes.dominio, ordemOriginal }
        };
    });
}

/**
 * Remonta a ordem original a partir de contextos processados em qualquer ordem.
 *
 * Nao e usado hoje — a execucao continua sequencial e em ordem. Existe porque e
 * a peca que falta para que uma execucao concorrente futura produza sempre o
 * mesmo artefato: sem uma chave de ordenacao estavel, o resultado passaria a
 * depender de qual item terminou primeiro.
 */
export function ordenarPorOrigem<T extends { metadata: { ordemOriginal: number } }>(
    processados: T[]
): T[] {
    return [...processados].sort((a, b) => a.metadata.ordemOriginal - b.metadata.ordemOriginal);
}

/**
 * Os itens que admitem alguma das decisoes dadas — o recorte que a fase de
 * clausulas faz hoje via `restringirADecisoes`, aqui expresso por item e SEM o
 * acoplamento a unicidade (que e global e nao pertence a esta camada).
 */
export function itensQueAdmitem(
    contextos: ContextoGeracaoItem[],
    decisoes: string[]
): ContextoGeracaoItem[] {
    const permitidas = new Set(decisoes);
    return contextos.filter(c => c.item.decisoes.some(d => permitidas.has(d)));
}
