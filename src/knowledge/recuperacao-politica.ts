/**
 * Das regras validadas para a Politica por Item.
 *
 *     RegraValidada[]  ->  agrupa por item  ->  estreita PoliticaItem  ->  SubgrafoPodado
 *
 * ---------------------------------------------------------------------------
 * POR QUE ISTO ESTREITA EM VEZ DE CONSTRUIR
 *
 * A tentacao seria montar `PoliticaItem` direto das regras validadas. Nao da, e
 * a razao esta no schema real: a consulta de validacao (`recuperacao-cypher.ts`)
 * so alcanca nos com `parametro` — RegraSeguranca, AjusteRenal, Gatilho,
 * Escalonamento e Limiar. `RegraValidada` e, portanto, evidencia PARCIAL, e boa
 * parte do que define uma politica NAO e um no com parametro:
 *
 *   - `VETA` (contexto -> item), `PROIBE` (populacao/area/contexto -> item) e
 *     `AJUSTA` (populacao/area/contexto -> item, com `fator`) sao ARESTAS entre
 *     dois nos sem `parametro`. Quem as ativa e o cenario — o gatilho do
 *     contexto, a pertinencia a populacao/area/contexto —, nao uma condicao
 *     numerica que o Cypher possa avaliar. Conferido no grafo real: nenhuma
 *     delas toca no com `parametro` (`restricoes-hibridas.test.ts` confere de
 *     novo sempre que o Neo4j esta no ar). Montar a politica so com o que o
 *     Cypher devolve apagaria todos os vetos e todos os ajustes.
 *   - as UNIDADES, os VALORES e o reticulo por decisao vem da bula do item na
 *     AST (`valoresOf`, `dosesPorDecisao`), nao do grafo — e e nesse reticulo
 *     que o AJUSTA vive: a dose escalada pelo fator entra ao lado da cheia;
 *   - o ESTADO DE CURSO vem do cenario (`farmacosEmUso` e equivalentes);
 *   - as DECISOES BASE vem do `esquema_dados`.
 *
 * Por isso a politica deterministica continua sendo a base, e as regras
 * validadas entram como uma passada de ESTREITAMENTO por cima. O silencio do
 * Cypher sobre um item nao diz nada sobre ele: nao confirma nem revoga restricao.
 *
 * INVARIANTE: esta passada so pode TIRAR decisao e ACRESCENTAR restricao. Nao
 * devolve decisao, nao desmarca item restrito, nao apaga motivo e nao mexe em
 * meios, unidades nem valores. `apenasEstreitou` confere isso em runtime, campo
 * a campo, e a passada lanca excecao em vez de entregar uma politica mais
 * permissiva — um erro de recuperacao pode empobrecer a politica, jamais
 * afrouxa-la.
 *
 * O RESULTADO ESPERADO E CONCORDANCIA. Os dois caminhos leem a MESMA DSL: a AST,
 * via `retrieve*Constraints`, e o grafo, via Cypher. Quando o grafo esta
 * sincronizado, esta passada nao muda nada e `concordam` sai `true`. O valor
 * dela e justamente detectar quando isso deixa de ser verdade — tipicamente um
 * `graph:sync` que nao rodou depois de uma mudanca no modelo.
 * ---------------------------------------------------------------------------
 *
 * NAO HA TIPO NOVO DE POLITICA. A saida e o mesmo `SubgrafoPodado`, com os
 * mesmos `PoliticaItem`. A evidencia estruturada (escore, condicoes, no do
 * grafo) fica na trilha de auditoria; aqui so entra o que `PoliticaItem.motivos`
 * ja carrega hoje: a justificativa legivel da restricao, no mesmo formato que
 * `retrieve*Constraints` escreve.
 */

import type { PoliticaItem, SubgrafoPodado, ValorAdmissivel } from './politica.js';
import type { RegraValidada } from './recuperacao-cypher.js';

/**
 * Arestas que, quando a regra INCIDE, bloqueiam o incremento sobre o item.
 *
 * Vem do sync, nao de convencao inventada: `database/neo4j.ts` grava
 * `(RegraSeguranca)-[:BLOQUEIA_INCREMENTO]->(Farmaco)` para `isBlockRule`, e
 * `neo4j-agro.ts` / `neo4j-fut.ts` gravam `[:BLOQUEIA]` para os equivalentes.
 * E o mesmo elemento do modelo que `retrieve*Constraints` trata retirando as
 * decisoes de incremento.
 */
const RELACOES_DE_BLOQUEIO = new Set(['BLOQUEIA_INCREMENTO', 'BLOQUEIA']);

/**
 * Acoes de ajuste que bloqueiam o incremento. Mesmo criterio literal de
 * `retrieveConstraints`: `attr.action === 'suspender' || attr.action === 'bloquear'`.
 */
const ACOES_QUE_BLOQUEIAM = new Set(['suspender', 'bloquear']);

/**
 * Classificacao de uma regra validada, ANTES de qualquer refinamento.
 *
 * Classificar primeiro e o que impede o erro central desta etapa: tratar tudo
 * que o Cypher devolve como "restricao sobre o item". So `bloqueio_condicional`
 * refina a politica. As demais classes existem para deixar registrado que foram
 * RECONHECIDAS e deliberadamente nao aplicadas — e nao esquecidas.
 */
export type ClasseRegra =
    /** RegraSeguranca / AjusteRenal que suspende: retira decisoes de incremento. */
    | 'bloqueio_condicional'
    /** Gatilho: ativa contexto. Quem trata e `retrieve*Constraints`. */
    | 'ativacao_de_contexto'
    /**
     * AjusteRenal que NAO suspende (reduzir dose, estender intervalo). Mesma
     * semantica de `retrieveConstraints`, que so o registra em `ajustes` para o
     * prompt: um ajuste nao retira nem autoriza decisao.
     */
    | 'ajuste'
    /** Escalonamento: dispara acionamento. Vira obrigacao no contrato, nao poda. */
    | 'escalonamento'
    /** Limiar (fut): descreve a SANCAO da infracao, nao restricao sobre ela. */
    | 'sancao'
    /**
     * Relacao que esta camada nao conhece. Nenhuma chega hoje (ver o cabecalho),
     * mas se a consulta de validacao passar a devolver outra aresta — `VETA`,
     * `PROIBE`, `AJUSTA` —, ela cai aqui: registrada, nunca aplicada, ate que
     * alguem decida o que ela significa para a politica.
     */
    | 'nao_reconhecida'
    /** A regra existe mas nao incide neste cenario. Nao refina nada. */
    | 'nao_incidente'
    /** Faltou dado para avaliar. Nao incide e nao autoriza concluir nada. */
    | 'sem_evidencia';

/**
 * Em que classe cai uma regra validada.
 *
 * Veto, proibicao, ajuste por fator, invariante global, valor/unidade e estado
 * de curso nao tem classe propria porque nao chegam a esta camada: nenhum deles
 * e um no com `parametro`, entao o Cypher de validacao nao os devolve. Eles
 * vivem so na politica deterministica, e e exatamente por isso que esta passada
 * refina em vez de reconstruir. Ver o cabecalho do arquivo.
 */
export function classificar(r: RegraValidada): ClasseRegra {
    if (r.lacunas.length > 0) return 'sem_evidencia';
    if (!r.aplicavel) return 'nao_incidente';
    if (RELACOES_DE_BLOQUEIO.has(r.relacao)) return 'bloqueio_condicional';
    if (r.relacao === 'EXIGE_AJUSTE') {
        return ACOES_QUE_BLOQUEIAM.has(r.efeito.acao ?? '') ? 'bloqueio_condicional' : 'ajuste';
    }
    if (r.relacao === 'DISPARA') return 'ativacao_de_contexto';
    if (r.relacao === 'ESCALONA') return 'escalonamento';
    if (r.relacao === 'TEM_LIMIAR') return 'sancao';
    return 'nao_reconhecida';
}

/** Agrupa as regras validadas pelo item sobre o qual incidem. */
export function agruparPorItem(validadas: RegraValidada[]): Map<string, RegraValidada[]> {
    const grupos = new Map<string, RegraValidada[]>();
    for (const regra of validadas) {
        const atual = grupos.get(regra.item);
        if (atual) atual.push(regra);
        else grupos.set(regra.item, [regra]);
    }
    return grupos;
}

/**
 * Das regras de um item, as que INCIDEM e restringem a politica dele.
 *
 * Gatilho, Escalonamento e Limiar ficam de fora de proposito: eles nao falam
 * sobre o que o item admite. Gatilho e Escalonamento ativam contexto e disparam
 * acionamento — ja tratados por `retrieve*Constraints` —, e `Limiar` descreve a
 * sancao de uma infracao, nao uma restricao sobre ela. O ajuste renal que nao
 * suspende tambem fica: ajustar a dose nao e proibir a decisao. Atribuir a
 * qualquer um deles um efeito sobre a politica seria inventar semantica para o
 * grafo.
 */
export function regrasRestritivas(regras: RegraValidada[]): RegraValidada[] {
    return regras.filter(r => classificar(r) === 'bloqueio_condicional');
}

export interface AjustePolitica {
    item: string;
    /** Decisoes que saíram da politica deste item por causa das regras. */
    decisoesRetiradas: string[];
    /** As regras que causaram o estreitamento. */
    regras: { regraId: string; motivo: string }[];
}

export interface DivergenciaPolitica {
    regraId: string;
    item: string;
    detalhe: string;
}

export interface ReconciliacaoPolitica {
    /** O MESMO tipo de sempre. Nao existe politica "hibrida". */
    subgrafo: SubgrafoPodado;
    /** Por item, o que as regras validadas estreitaram. Vazio quando nada muda. */
    ajustes: AjustePolitica[];
    /**
     * Regras restritivas que INCIDEM sobre um item que a politica nao contem.
     *
     * A causa mais comum NAO e defeito: e o FOCO. `filtrarPorFoco*` restringe a
     * politica aos itens em foco, e o grafo continua sabendo de restricoes sobre
     * os que ficaram de fora. Medido no cenario de referencia deste projeto:
     * `plaquetas 45 < 50` incide sobre Heparina, que o foco nao trouxe.
     *
     * Isso e informacao util — significa que existe uma restricao real que o
     * Prompt Semantico nao vai mencionar — mas NAO e motivo para mexer na
     * politica: o item nao esta em jogo neste artefato. A outra causa possivel,
     * mais rara, e o grafo estar dessincronizado da AST (um `graph:sync` que nao
     * rodou). As duas se distinguem olhando se o item pertence ao modelo.
     */
    divergencias: DivergenciaPolitica[];
    /**
     * `true` quando o grafo e a AST concordam — o resultado esperado. A
     * comparacao so cobre as regras condicionais (nos com `parametro`): VETA,
     * PROIBE e AJUSTA ficam fora dela, porque o Cypher nao os alcanca, e passam
     * por esta camada exatamente como a politica deterministica os deixou.
     */
    concordam: boolean;
}

/** Recalcula as chaves agregadas a partir das politicas, como `montarSubgrafo`. */
function reagregar(subgrafo: SubgrafoPodado, politicas: PoliticaItem[]): SubgrafoPodado {
    const acoes = new Set<string>();
    const meios = new Set<string>();
    for (const p of politicas) {
        for (const d of p.decisoes) acoes.add(d);
        for (const m of p.meios) meios.add(m);
    }
    return {
        ...subgrafo,
        politicas,
        acoes_permitidas: [...acoes],
        farmacos_liberados: politicas.map(p => p.item),
        vias_disponiveis: [...meios]
    };
}

/**
 * Aplica as regras validadas sobre a politica ja calculada.
 *
 * `decisoesDeIncremento` sai de `subgrafo.papeis` — a declaracao PUBLICA do
 * dominio sobre o que aumenta exposicao, que e a mesma que o contrato usa. O
 * modulo nao conhece nome de farmaco, produto nem infracao.
 */
export function refinarPolitica(
    subgrafo: SubgrafoPodado,
    validadas: RegraValidada[]
): ReconciliacaoPolitica {
    const incrementos = new Set(subgrafo.papeis.decisoesDeIncremento ?? []);
    const porItem = agruparPorItem(validadas);
    const ajustes: AjustePolitica[] = [];
    const divergencias: DivergenciaPolitica[] = [];

    const politicas = subgrafo.politicas.map(p => {
        const restritivas = regrasRestritivas(porItem.get(p.item) ?? []);
        if (restritivas.length === 0) return p;

        const retiradas = p.decisoes.filter(d => incrementos.has(d));
        if (retiradas.length === 0 && p.bloqueado) return p;   // a AST ja bloqueara

        const regras = restritivas.map(r => ({
            regraId: r.regraId,
            // Mesmo formato que `retrieveConstraints` escreve em `motivos`.
            motivo:
                `${r.tipo} (${r.condicoesSatisfeitas
                    .map(c => `${c.campo} ${c.observado} ${c.esperado}`)
                    .join('; ')})` + (r.efeito.razao ? `: ${r.efeito.razao}` : '')
        }));

        if (retiradas.length > 0) {
            ajustes.push({ item: p.item, decisoesRetiradas: retiradas, regras });
        }

        return {
            ...p,
            decisoes: p.decisoes.filter(d => !incrementos.has(d)),
            bloqueado: true,
            motivos: [...p.motivos, ...regras.map(r => r.motivo)]
        };
    });

    const itensDaPolitica = new Set(subgrafo.politicas.map(p => p.item));
    for (const [item, regras] of porItem) {
        if (itensDaPolitica.has(item)) continue;
        for (const r of regrasRestritivas(regras)) {
            divergencias.push({
                regraId: r.regraId,
                item,
                detalhe:
                    `regra restritiva incide sobre '${item}', que nao esta na politica ` +
                    'deste cenario — em geral porque o foco nao o trouxe; ' +
                    'so e sinal de dessincronia grafo/AST se o item pertencer ao modelo em foco'
            });
        }
    }

    const refinado = reagregar(subgrafo, politicas);

    // GARANTIA EM RUNTIME, nao so em teste: PolicyRefined subconjunto de
    // PolicyDeterministic. Se algum dia uma alteracao aqui alargar a politica, o
    // sistema para em vez de gerar sob uma gramatica mais permissiva do que a
    // avaliacao deterministica autorizou. Esta e a unica falha desta camada que
    // nao pode degradar silenciosamente.
    if (!apenasEstreitou(subgrafo, refinado)) {
        throw new Error(
            'refinamento da politica ampliou permissoes: ' +
                'a politica refinada precisa ser subconjunto da deterministica (' +
                foraDoEstreitamento(subgrafo, refinado).join('; ') +
                ')'
        );
    }

    return {
        subgrafo: refinado,
        ajustes,
        divergencias,
        concordam: ajustes.length === 0 && divergencias.length === 0
    };
}

/**
 * Compatibilidade com o nome usado na integracao inicial. `refinarPolitica`
 * descreve melhor o que a funcao faz — ela REFINA, nao aplica cegamente.
 */
export const aplicarRegrasValidadas = refinarPolitica;

/**
 * Confere a invariante de que a reconciliacao so estreita.
 *
 * Existe como funcao, e nao so como teste, porque e barata e porque a
 * consequencia de viola-la e a pior possivel: uma decisao que a avaliacao
 * deterministica havia retirado voltar a ser exprimivel, ou uma restricao
 * perder a marca e o motivo que o Prompt Semantico mostra.
 */
export function apenasEstreitou(antes: SubgrafoPodado, depois: SubgrafoPodado): boolean {
    return foraDoEstreitamento(antes, depois).length === 0;
}

/**
 * Tudo em que `depois` deixa de ser um estreitamento de `antes`, item a item.
 * Vazio quando so estreitou.
 *
 * Estreitar e tirar item ou decisao, ou acrescentar restricao. Cada campo do
 * `PoliticaItem` carrega uma parte da restricao deterministica, e cada um tem a
 * sua regra:
 *
 *   item e decisoes   subconjunto. VETA, PROIBE, bloqueio e estado de curso
 *                     aparecem aqui como as decisoes que eles tiraram.
 *   bloqueado         uma vez marcado, continua: e o que o Prompt Semantico
 *                     mostra como [RESTRITO], com os motivos.
 *   motivos           os de antes continuam. Sao a justificativa legivel de
 *                     cada restricao — o "vetado por ..." do VETA e do PROIBE.
 *   meios, unidades   identicos.
 *   valores           identicos, e tambem os admissiveis de cada decisao que
 *                     ficou. E ai que o AJUSTA vive: a dose escalada pelo fator
 *                     entra ao lado da cheia. Tirar a escalada deixaria so a
 *                     cheia exprimivel, e esvaziar a lista soltaria o numero.
 *                     Nenhuma evidencia do grafo tem semantica de valor, entao
 *                     nenhum refinamento mexe neles.
 */
export function foraDoEstreitamento(antes: SubgrafoPodado, depois: SubgrafoPodado): string[] {
    const porItem = new Map(antes.politicas.map(p => [p.item, p]));
    const achados: string[] = [];

    for (const p of depois.politicas) {
        const original = porItem.get(p.item);
        if (!original) {
            achados.push(`${p.item}: item que a politica anterior nao tinha`);
            continue;
        }

        const novas = p.decisoes.filter(d => !original.decisoes.includes(d));
        if (novas.length > 0) achados.push(`${p.item} ganhou [${novas.join(', ')}]`);
        if (original.bloqueado && !p.bloqueado) achados.push(`${p.item} deixou de ser restrito`);
        const perdidos = original.motivos.filter(m => !p.motivos.includes(m));
        if (perdidos.length > 0) achados.push(`${p.item} perdeu o motivo "${perdidos.join('", "')}"`);

        if (!mesmoConjunto(p.meios, original.meios)) achados.push(`${p.item}: meios mudaram`);
        if (!mesmoConjunto(p.unidades, original.unidades)) achados.push(`${p.item}: unidades mudaram`);
        if (!mesmosValores(p.valores, original.valores)) achados.push(`${p.item}: valores mudaram`);
        const reticulo = p.decisoes.filter(
            d => !mesmosValores(admissiveis(p, d), admissiveis(original, d))
        );
        if (reticulo.length > 0) achados.push(`${p.item}: valores de [${reticulo.join(', ')}] mudaram`);
    }

    return achados;
}

/** Os valores que a gramatica admite para o par (item, decisao): o balde da
 *  decisao, ou a uniao quando nao ha balde — como `grammar_from_kg.py` le. */
function admissiveis(politica: PoliticaItem, decisao: string): ValorAdmissivel[] {
    const balde = politica.valoresPorDecisao?.[decisao];
    return balde && balde.length > 0 ? balde : politica.valores;
}

function mesmoConjunto(a: readonly string[], b: readonly string[]): boolean {
    const x = new Set(a);
    const y = new Set(b);
    return x.size === y.size && [...x].every(v => y.has(v));
}

function mesmosValores(a: ValorAdmissivel[], b: ValorAdmissivel[]): boolean {
    const chave = (v: ValorAdmissivel): string => `${v.valor} ${v.unidade}`;
    return mesmoConjunto(a.map(chave), b.map(chave));
}

/** Linha de log da reconciliacao. */
export function resumoReconciliacao(r: ReconciliacaoPolitica): string {
    if (r.concordam) return 'politica: grafo e AST concordam (nenhum estreitamento)';
    const partes: string[] = [];
    for (const a of r.ajustes) {
        partes.push(`${a.item} perdeu [${a.decisoesRetiradas.join(', ')}]`);
    }
    for (const d of r.divergencias) partes.push(`divergencia em ${d.item}`);
    return `politica: ${partes.join('; ')}`;
}
