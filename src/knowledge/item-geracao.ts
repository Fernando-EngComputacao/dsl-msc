/**
 * Contexto de geracao POR ITEM — a unidade operacional da arquitetura PI, e a
 * entrada do futuro PI Agent (ver `inference/multiagente.ts`).
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
 * reinterpretar nada. Os campos derivados (`decisoes`, `valores`, `restricoes`)
 * sao VISTAS da politica: nenhum deles e autoridade, e nenhum a contradiz.
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
 *   - as `RegraValidada` que incidem sobre ele (ver `agruparPorItem`) e a
 *     telemetria que essas regras leram;
 *   - as regras RELACIONAIS que o citam (interacao, incompatibilidade,
 *     agravante): envolvem outro item, mas sao o que o PI precisa saber dele;
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
 * DUAS ORIGENS, UM TIPO:
 *   - `contextosPorItem`: um contexto por item da poda, sem Planner. `pi`,
 *     `conduta` e `relacoes` ficam ausentes/vazios, `fatos` vazio, e `item` e o
 *     MESMO objeto da poda.
 *   - `decomporPIs` (`decompositor.ts`): um contexto por PI da sequencia
 *     VALIDADA. Recorta tudo para o par (item, conduta) — decisoes, valores,
 *     regras, fatos, telemetria — e devolve dado puro e congelado: cada
 *     contexto e uma copia independente, sem `subgrafo` global, e e exatamente
 *     a sua propria forma serializada.
 * No modo deterministico (padrao) `regras` sai vazio: as `RegraValidada` so
 * existem no modo hibrido. O que sustenta o PI nesse modo sao os `fatos`, que
 * o Decompositor recorta das restricoes do dominio.
 *
 * ESTA ETAPA NAO PARALELIZA. Nao ha `Promise.all`, worker, processo extra nem
 * mudanca no lock do motor. A ordem original de cada item e preservada em
 * `metadata.ordemOriginal` justamente para que uma execucao futura fora de ordem
 * possa ser remontada de forma deterministica.
 */

import type { PIPlanejado } from './contrato-pi.js';
import type { RetrievedConstraints } from './graphrag.js';
import type { PoliticaItem, SubgrafoPodado, ValorAdmissivel } from './politica.js';
import type { RegraValidada } from './recuperacao-cypher.js';
import { agruparPorItem } from './recuperacao-politica.js';
import type { Dominio } from './recuperacao.js';

/** A evidencia de uma regra, achatada para leitura: o que foi observado e o que era exigido. */
export interface EvidenciaRegra {
    regraId: string;
    campo: string;
    observado: number;
    esperado: string;
}

/**
 * Regra que liga um item a OUTRO: interacao (med), incompatibilidade (agro),
 * agravante (fut). Os tres dominios ja declaram exatamente este formato em
 * `RetrievedConstraints.interacoes`, `RetrievedAgroConstraints.incompatibilidades`
 * e `RetrievedFutConstraints.agravantes`; o tipo e esse, nao um novo.
 * `entre` e `"<item> + <item>"`.
 */
export type RegraRelacional = RetrievedConstraints['interacoes'][number];

/**
 * Fato DETERMINISTICO do cenario, como `retrieve*Constraints` o registrou —
 * as listas `bloqueios`, `vetados`, `ajustes`, `recomendados`, `proibicoes`
 * (agro), `isencoes` (fut) e `escalonamentos`, sem o nome de dominio nos
 * campos. E o que sustenta um PI no modo deterministico, em que nao ha
 * `RegraValidada`. Nada aqui e avaliado de novo nem reescrito: os textos sao
 * os da recuperacao.
 */
export interface FatoRecuperado {
    tipo: 'bloqueio' | 'veto' | 'ajuste' | 'recomendacao' | 'proibicao' | 'isencao' | 'escalonamento';
    /** O que o fato diz, com as palavras da recuperacao. */
    descricao: string;
    /** De onde veio, como a recuperacao escreveu: `populacao Renal_Cronico`, `TFG 28 < 30 ml/min`, `protocolo X`. */
    origem?: string;
    /** O no de contexto (protocolo | cultura | lance) que declara o fato, quando ha um. */
    contexto?: string;
    /**
     * O que foi OBSERVADO e sustenta o fato, como a recuperacao escreveu: a
     * condicao da propria regra (bloqueio: `PAM 52 < 60 mmHg`) ou os gatilhos
     * que ativaram o contexto de origem (recomendacao, veto e escalonamento de
     * protocolo/cultura/lance). Vazio quando o fato nao depende de medida
     * (veto por populacao, proibicao declarada).
     */
    condicoes: string[];
}

/**
 * A conduta do PI como o conhecimento a declara. `decisoes` e o mapa do
 * `esquema_dados` (`decisoesDaConduta`); `atributos`, o que a DSL escreveu na
 * conduta (ver `EsquemaDeclarado`) — preservados, nunca interpretados.
 */
export interface CondutaDoPI {
    nome: string;
    /** As decisoes que realizam a conduta, pelo `esquema_dados`. */
    decisoes: string[];
    /** Atributos declarados: `requer_dupla_checagem`, `justificativa_obrigatoria`, `requer_var`, `via`... */
    atributos: Record<string, string>;
    /**
     * Os escalonamentos disparados que tornam esta conduta obrigatoria
     * (`condutasObrigatorias`). Vazio quando ela nao e obrigatoria.
     */
    obrigatoriaPor: string[];
}

/** Como um PI se relaciona com outro da mesma sequencia. */
export interface RelacaoPI {
    /**
     * `depende_de`: este PI declarou depender do outro.
     * `dependente`: o outro declarou depender deste.
     * `relacional`: os itens dos dois estao ligados por uma `RegraRelacional`.
     */
    tipo: 'depende_de' | 'dependente' | 'relacional';
    /** `ordem` do outro PI. */
    ordem: number;
    /** Item do outro PI. */
    item: string;
    /**
     * Conduta do outro PI. Com `ordem` e `item`, e TUDO que um PI sabe do outro:
     * nem a acao, nem o contexto, nem o resultado — que nao existem quando os
     * PIs sao decompostos, e nao podem ser requisito para gera-los.
     */
    conduta: string;
    /** A regra que liga os dois, quando `tipo` e `relacional`. */
    regra?: RegraRelacional;
}

/**
 * Tudo que o processamento de UM item precisa.
 *
 * `subgrafo` e `subgrafoDoItem`: o primeiro e a poda completa, e so existe no
 * contexto por item (`contextosPorItem`). O contexto de PI nao o carrega: o PI
 * Agent nao recebe a politica global, e tudo que a clausula dele precisa —
 * papeis, constantes, a politica do item ja restrita a conduta — esta em
 * `subgrafoDoItem`, o payload que vai ao motor. As verificacoes que so existem
 * em relacao ao conjunto ficam com a execucao (`ContextoExecucaoMultiagente`).
 */
export interface ContextoGeracaoItem {
    /**
     * A unidade normativa — a politica do item. Em `contextosPorItem`, e o
     * mesmo objeto da poda. No contexto de PI, e uma copia congelada RESTRITA
     * ao PI: `decisoes` sao as admissiveis e os valores, so os que elas
     * alcancam; `meios`, `unidades`, `bloqueado` e `motivos` ficam intactos,
     * porque valem para o item. O que o item admite fora da conduta nao some:
     * esta em `decisoes.foraDaConduta`.
     */
    item: PoliticaItem;
    /** A poda completa do cenario. Ausente no contexto de PI (ver acima). */
    subgrafo?: SubgrafoPodado;
    /** A poda reduzida a este item — e, no PI, as decisoes da conduta: e o payload que gera Ĝ_i no motor. */
    subgrafoDoItem: SubgrafoPodado;
    /**
     * Regras do Cypher RELEVANTES: as que incidem sobre este item (ver
     * `agruparPorItem`) e, no PI, os gatilhos e escalonamentos dos contextos
     * que os `fatos` dele citam. Vazio no modo deterministico.
     */
    regras: RegraValidada[];
    /** Evidencia por regra: o que foi observado e o que era exigido. */
    evidencias: EvidenciaRegra[];
    /** Fatos deterministicos do cenario sobre este item (e, no PI, sobre a conduta). Vazio fora do Decompositor. */
    fatos: FatoRecuperado[];
    metadata: {
        itemId: string;
        dominio?: Dominio;
        /** A execucao de onde o contexto saiu. So no contexto de PI. */
        requestId?: string;
        /**
         * Posicao na FONTE do contexto, para remontagem deterministica: na poda
         * (`contextosPorItem`) ou na sequencia validada (`decomporPIs`, onde e
         * `pi.ordem - 1`). `ordenarPorOrigem` serve aos dois.
         */
        ordemOriginal: number;
    };

    /** O PI que este contexto executa — ordem, item, conduta, dependencias. Ausente fora do Planner. */
    pi?: PIPlanejado;
    /** A conduta do PI como o conhecimento a declara. Ausente fora do Planner. */
    conduta?: CondutaDoPI;
    /** O pedido original, como o usuario o escreveu. */
    pedido: string;
    /** A telemetria que as regras deste item leram: parametro -> valor observado. */
    telemetriaRelevante: Record<string, number>;
    /** Regras que ligam este item a outro. */
    regrasRelacionais: RegraRelacional[];
    /**
     * Vista das decisoes. Toda politica parte do universo do `esquema_dados` e
     * as restricoes so TIRAM decisoes dela; por isso:
     *   `admissiveis`   sem PI, `item.decisoes`; no PI, as do item que realizam a
     *                   conduta (`item.decisoes` ∩ `decisoesDaConduta`);
     *   `bloqueadas`    o universo menos `item.decisoes` — o que as restricoes
     *                   (bloqueio, veto, estado de curso) tiraram do item. Vazio
     *                   quando o universo nao foi informado: nao se conclui
     *                   bloqueio sem conhecer o universo;
     *   `foraDaConduta` no PI, as que o item admite mas pertencem a outra
     *                   conduta. Vazio sem PI.
     * As tres sao disjuntas, e juntas cobrem o universo.
     */
    decisoes: { admissiveis: string[]; bloqueadas: string[]; foraDaConduta: string[] };
    /**
     * Vista dos meios, como a gramatica os le: `admissiveis` sao os meios do
     * item; quando o item nao declara nenhum, o meio segue livre no vocabulario
     * do dominio, e `admissiveis` e esse vocabulario (vazio se ele nao foi
     * informado — nao se restringe o que nao se conhece). `foraDoItem` e o resto
     * do vocabulario do dominio: meio que existe, mas nao para este item.
     */
    meios: { admissiveis: string[]; foraDoItem: string[] };
    /**
     * Vista dos valores admissiveis, como a gramatica os le (`grammar_from_kg.py`:
     * `por_decisao.get(d) or valores`): o mapa por decisao e a uniao. No PI, o
     * mapa so tem as decisoes admissiveis, e a uniao so vem quando alguma delas
     * cai nela — do contrario nenhum valor dela e alcancavel pelo PI.
     */
    valores: { gerais: ValorAdmissivel[]; porDecisao: Record<string, ValorAdmissivel[]> };
    /** Relacoes com os outros PIs da sequencia. Vazio fora do Planner. */
    relacoes: RelacaoPI[];
    /** As restricoes legiveis do item: os `motivos` da politica. */
    restricoes: string[];
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
    /** O pedido original. Ausente: texto vazio. */
    pedido?: string;
    /**
     * Regras relacionais do cenario (`interacoes` | `incompatibilidades` |
     * `agravantes`, depois do foco). Cada item recebe as que o citam.
     */
    relacionais?: RegraRelacional[];
    /**
     * Universo de decisoes do dominio (as `decisoes` do `esquema_dados`). Sem
     * ele, `decisoes.bloqueadas` sai vazio.
     */
    decisoesDoDominio?: string[];
}

/** A evidencia de cada regra, achatada para leitura — ver `RegraValidada`. */
export function evidenciasDe(regras: RegraValidada[]): EvidenciaRegra[] {
    return regras.flatMap(r =>
        [...r.condicoesSatisfeitas, ...r.condicoesFalhas].map(c => ({
            regraId: r.regraId,
            campo: c.campo,
            observado: c.observado,
            esperado: c.esperado
        }))
    );
}

/** Os itens que uma regra relacional cita — `entre` e `"<item> + <item>"`. */
export function itensDaRelacao(regra: RegraRelacional): string[] {
    return regra.entre.split(' + ').map(s => s.trim());
}

/**
 * Um `ContextoGeracaoItem` para cada item da poda, na ordem da poda.
 *
 * Funcao pura: nao gera, nao consulta grafo, nao chama motor. E so o recorte
 * que torna cada item processavel isoladamente. O contexto POR PI — com `pi`,
 * `conduta`, `relacoes` e `fatos` — e do Decompositor (`decompositor.ts`).
 */
export function contextosPorItem(
    subgrafo: SubgrafoPodado,
    opcoes: OpcoesContextoItem = {}
): ContextoGeracaoItem[] {
    const porItem = agruparPorItem(opcoes.validadas ?? []);
    const relacionais = opcoes.relacionais ?? [];

    return subgrafo.politicas.map((item, ordemOriginal) => {
        const regras = porItem.get(item.item) ?? [];
        const admissiveis = new Set(item.decisoes);
        return {
            item,
            subgrafo,
            // Nunca `undefined` aqui: o item vem da propria lista de politicas.
            subgrafoDoItem: subgrafoDeItem(subgrafo, item.item)!,
            regras,
            evidencias: evidenciasDe(regras),
            fatos: [],
            metadata: { itemId: item.item, dominio: opcoes.dominio, ordemOriginal },
            pedido: opcoes.pedido ?? '',
            // `evidencia` e exatamente a telemetria que a regra leu.
            telemetriaRelevante: Object.assign({}, ...regras.map(r => r.evidencia)) as Record<string, number>,
            regrasRelacionais: relacionais.filter(r => itensDaRelacao(r).includes(item.item)),
            decisoes: {
                admissiveis: item.decisoes,
                bloqueadas: (opcoes.decisoesDoDominio ?? []).filter(d => !admissiveis.has(d)),
                foraDaConduta: []
            },
            meios: { admissiveis: item.meios, foraDoItem: [] },
            valores: { gerais: item.valores, porDecisao: item.valoresPorDecisao ?? {} },
            relacoes: [],
            restricoes: item.motivos
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
