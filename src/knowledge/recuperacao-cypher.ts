/**
 * Validacao DETERMINISTICA dos candidatos do RAG, por Cypher.
 *
 *     CandidatoRegra[] (RAG, aproximado)
 *            +
 *     ContextoEstruturado (telemetria exata)
 *            |
 *            v
 *          Cypher            <- avalia parametro/operador/limiar NO BANCO
 *            |
 *            v
 *     RegraValidada[]
 *
 * REGRA ABSOLUTA: nenhum escore de embedding sobrescreve condicao estrutural ou
 * numerica. O escore do RAG viaja no campo `rag` e NUNCA entra no calculo de
 * `aplicavel` — que sai exclusivamente da comparacao feita pelo Cypher contra a
 * telemetria. Um candidato com escore 0.99 e condicao falsa e rejeitado; um com
 * 0.70 e condicao verdadeira pode ser aceito.
 *
 * ---------------------------------------------------------------------------
 * ATENCAO AO SENTIDO DE `aplicavel` — e o ponto em que e mais facil errar:
 *
 *     `aplicavel` significa "as condicoes desta regra INCIDEM neste cenario".
 *     NAO significa "o item esta permitido". Para uma RegraSeguranca e o
 *     OPOSTO: a regra incidir quer dizer que o item esta BLOQUEADO.
 *
 * Esta camada nao converte incidencia em permissao — isso pertence a
 * `retrieve*Constraints`, que sabe o que cada tipo de regra faz com a politica.
 * Aqui so se responde: esta regra vale para este cenario, e com que evidencia?
 * ---------------------------------------------------------------------------
 *
 * DE ONDE VEM CADA CONDICAO. Nenhuma e inventada. O sync (`database/neo4j*.ts`)
 * grava, a partir da DSL, cinco tipos de no que carregam condicao numerica —
 * e sao exatamente estes cinco que possuem a propriedade `parametro`:
 *
 *   tipo              dono            valor       relacao
 *   RegraSeguranca    farmaco/produto/infracao   limiar   BLOQUEIA_INCREMENTO | BLOQUEIA
 *   AjusteRenal       farmaco                    limiar   EXIGE_AJUSTE
 *   Gatilho           protocolo/cultura/lance    valor    DISPARA
 *   Escalonamento     protocolo/cultura/lance    valor    ESCALONA
 *   Limiar            infracao                   valor    TEM_LIMIAR
 *
 * Conferido contra o grafo real: `MATCH (n) WHERE n.parametro IS NOT NULL`
 * devolve Gatilho, RegraSeguranca, Escalonamento, Limiar e AjusteRenal, e mais
 * nada — Dose, Contraindicacao, Monitoramento, Carencia e afins nao tem
 * `parametro` e ficam de fora sem precisar de lista de excecao.
 *
 * LACUNA, NAO INVENCAO. Quando a telemetria do cenario nao traz o parametro que
 * a regra exige, a condicao nao e dada por falsa nem por verdadeira: vira uma
 * `Lacuna`, e a regra sai como nao aplicavel por falta de evidencia. E a mesma
 * postura que `retrieveConstraints` ja documenta — "ausencia de medida nao e
 * evidencia de normalidade, mas tambem nao autoriza bloquear".
 */

import { type Session } from 'neo4j-driver';

import { INDICES_POR_DOMINIO, type CandidatoRegra, type PapelCandidato } from './recuperacao-rag.js';
import type { ContextoRecuperacao, Dominio } from './recuperacao.js';

// =============================================================================
// A consulta
// =============================================================================

/**
 * Avalia, NO BANCO, toda regra condicional ligada ao no candidato.
 *
 * A comparacao acontece aqui dentro, no `CASE` sobre `regra.operador`, e nao em
 * TypeScript: os operadores sao dados que vieram da DSL pelo sync, e quem os
 * interpreta e o mesmo lugar que os le. `coalesce(regra.limiar, regra.valor)`
 * cobre os dois nomes que o schema real usa para o valor de referencia.
 *
 * `$telemetria[regra.parametro]` e acesso dinamico a mapa: devolve `null` quando
 * o cenario nao mediu aquele parametro, e e esse `null` que vira lacuna.
 *
 * A aresta e casada sem direcao (`-[rel]-`) de proposito: o sync grava
 * `(RegraSeguranca)-[:BLOQUEIA]->(item)` mas `(item)-[:EXIGE_AJUSTE]->(AjusteRenal)`.
 * `type(rel)` preserva qual foi, para a evidencia.
 */
export const CYPHER_VALIDACAO = `
MATCH (alvo:\`{{ROTULO}}\` { nome: $nome })
MATCH (alvo)-[rel]-(regra)
WHERE regra.parametro IS NOT NULL
WITH regra, rel,
     coalesce(regra.limiar, regra.valor) AS esperado,
     $telemetria[regra.parametro] AS observado
RETURN labels(regra)[0] AS tipoRegra,
       type(rel)        AS relacao,
       elementId(regra) AS nodeId,
       regra.parametro  AS parametro,
       regra.operador   AS operador,
       esperado         AS esperado,
       regra.unidade    AS unidade,
       regra.razao      AS razao,
       regra.acao       AS acao,
       regra.detalhe    AS detalhe,
       observado        AS observado,
       CASE WHEN observado IS NULL THEN NULL
            WHEN regra.operador = '<'  THEN observado <  esperado
            WHEN regra.operador = '>'  THEN observado >  esperado
            WHEN regra.operador = '<=' THEN observado <= esperado
            WHEN regra.operador = '>=' THEN observado >= esperado
            WHEN regra.operador = '==' THEN observado =  esperado
            WHEN regra.operador = '!=' THEN observado <> esperado
            ELSE NULL END AS satisfeita
ORDER BY tipoRegra, parametro`;

/**
 * O label nao pode ser parametro em Cypher, entao e interpolado. Seguro por
 * construcao: o valor sai de `INDICES_POR_DOMINIO`, um mapa fechado no codigo,
 * e nunca de entrada do usuario. `consultaPara` e a unica porta de entrada.
 */
export function consultaPara(rotulo: string): string {
    return CYPHER_VALIDACAO.replace('{{ROTULO}}', rotulo);
}

/** Uma linha crua da consulta acima. */
export interface LinhaRegra {
    tipoRegra: string;
    relacao: string;
    nodeId: string;
    parametro: string;
    operador: string;
    esperado: number;
    unidade?: string | null;
    razao?: string | null;
    acao?: string | null;
    detalhe?: string | null;
    observado: number | null;
    /** `null` quando o parametro nao foi medido — nao e falso, e desconhecido. */
    satisfeita: boolean | null;
}

// =============================================================================
// Resultado
// =============================================================================

export interface CondicaoAvaliada {
    /** Parametro observado: PAM, TFG, vento, minuto... */
    campo: string;
    /** Valor medido no cenario, exatamente como veio do contexto estruturado. */
    observado: number;
    /** Forma legivel do que a regra exige: "< 60". */
    esperado: string;
    operador: string;
    limite: number;
    unidade?: string;
    satisfeita: boolean;
}

/** Condicao que NAO pode ser avaliada: o dado necessario nao existe. */
export interface Lacuna {
    campo: string;
    esperado: string;
    motivo: string;
}

export interface RegraValidada {
    /** Chave estavel e legivel: `Farmaco:Propofol/RegraSeguranca/PAM<60`. */
    regraId: string;
    /** Label do no de regra: RegraSeguranca | Gatilho | Escalonamento | ... */
    tipo: string;
    /** Aresta que liga a regra ao item, como o sync a gravou. */
    relacao: string;
    /** Nome do no candidato (farmaco, protocolo, produto...). */
    item: string;
    dominio: Dominio;
    /**
     * As condicoes desta regra incidem neste cenario. Ver a nota no topo: NAO e
     * sinonimo de "permitido". Sai so da comparacao do Cypher; o escore do RAG
     * nao participa.
     */
    aplicavel: boolean;
    condicoesSatisfeitas: CondicaoAvaliada[];
    condicoesFalhas: CondicaoAvaliada[];
    lacunas: Lacuna[];
    /** Valores da telemetria efetivamente usados nesta decisao. */
    evidencia: Record<string, number>;
    validacaoCypher: {
        valida: boolean;
        motivo: string;
        /** A consulta que produziu o veredito — auditavel. */
        consulta: string;
        /** O no do grafo que fundamentou a validacao. */
        nodeId?: string;
    };
    /** O que a regra faz quando incide, como a DSL declarou. Nao interpretado aqui. */
    efeito: { razao?: string; acao?: string; detalhe?: string };
    /**
     * A procedencia semantica do candidato. Presente para auditoria e ordenacao;
     * NUNCA lido por `aplicavel`.
     */
    rag: {
        candidatoId: string;
        escore: number;
        cosseno: number;
        papel: PapelCandidato;
        posicao: number;
    };
}

// =============================================================================
// Porta injetavel
// =============================================================================

export type ExecutorCypher = (
    consulta: string,
    params: Record<string, unknown>
) => Promise<LinhaRegra[]>;

/** Converte um Integer do driver em number; deixa number como esta. */
function comoNumero(valor: unknown): number | null {
    if (valor === null || valor === undefined) return null;
    if (typeof valor === 'number') return valor;
    const talvez = valor as { toNumber?: () => number };
    return typeof talvez.toNumber === 'function' ? talvez.toNumber() : null;
}

/** Executor real, sobre uma `Session` do driver. */
export function executorPorSessao(session: Session): ExecutorCypher {
    return async (consulta, params) => {
        const resultado = await session.run(consulta, params);
        return resultado.records.map(r => ({
            tipoRegra: r.get('tipoRegra') as string,
            relacao: r.get('relacao') as string,
            nodeId: r.get('nodeId') as string,
            parametro: r.get('parametro') as string,
            operador: r.get('operador') as string,
            esperado: comoNumero(r.get('esperado')) ?? Number.NaN,
            unidade: r.get('unidade') as string | null,
            razao: r.get('razao') as string | null,
            acao: r.get('acao') as string | null,
            detalhe: r.get('detalhe') as string | null,
            observado: comoNumero(r.get('observado')),
            satisfeita: r.get('satisfeita') as boolean | null
        }));
    };
}

// =============================================================================
// Validacao
// =============================================================================

function legivel(operador: string, limite: number, unidade?: string | null): string {
    return `${operador} ${limite}${unidade ? ` ${unidade}` : ''}`;
}

/** Os labels que o dominio de fato indexa — ver `INDICES_POR_DOMINIO`. */
function rotulosDoDominio(dominio: Dominio): string[] {
    const indices = INDICES_POR_DOMINIO[dominio];
    return [indices.item.rotulo, indices.contexto.rotulo];
}

/**
 * Rejeicao estrutural: nem chega a consultar o grafo. Usada quando o candidato
 * nao pertence a este contexto — dominio trocado ou label que o dominio nao
 * indexa. Nao e opiniao sobre a regra, e incompatibilidade de cenario.
 */
function rejeicaoEstrutural(
    candidato: CandidatoRegra,
    contexto: ContextoRecuperacao,
    motivo: string
): RegraValidada {
    return {
        regraId: `${candidato.regraId}/incompativel`,
        tipo: candidato.metadados.rotulo,
        relacao: '',
        item: candidato.item,
        dominio: contexto.dominio,
        aplicavel: false,
        condicoesSatisfeitas: [],
        condicoesFalhas: [],
        lacunas: [{ campo: '(candidato)', esperado: `dominio ${contexto.dominio}`, motivo }],
        evidencia: {},
        validacaoCypher: { valida: false, motivo, consulta: '' },
        efeito: {},
        rag: {
            candidatoId: candidato.regraId,
            escore: candidato.escore,
            cosseno: candidato.cosseno,
            papel: candidato.metadados.papel,
            posicao: candidato.metadados.posicao
        }
    };
}

/** Agrupa as linhas por no de regra: um no pode, em tese, trazer mais de uma
 *  condicao, e o veredito e a conjuncao delas. */
function agruparPorRegra(linhas: LinhaRegra[]): Map<string, LinhaRegra[]> {
    const grupos = new Map<string, LinhaRegra[]>();
    for (const linha of linhas) {
        const chave = linha.nodeId;
        const atual = grupos.get(chave);
        if (atual) atual.push(linha);
        else grupos.set(chave, [linha]);
    }
    return grupos;
}

/**
 * Valida UM candidato: consulta as regras ligadas a ele e avalia cada uma contra
 * a telemetria do contexto estruturado.
 *
 * Cada candidato e validado de forma independente — o veredito de um nao
 * influencia o de outro, e a ordem do RAG nao muda nenhum resultado.
 */
export async function validarCandidato(
    contexto: ContextoRecuperacao,
    candidato: CandidatoRegra,
    executor: ExecutorCypher
): Promise<RegraValidada[]> {
    if (candidato.dominio !== contexto.dominio) {
        return [
            rejeicaoEstrutural(
                candidato,
                contexto,
                `candidato do dominio '${candidato.dominio}' num contexto '${contexto.dominio}'`
            )
        ];
    }

    const rotulo = candidato.metadados.rotulo;
    if (!rotulosDoDominio(contexto.dominio).includes(rotulo)) {
        return [
            rejeicaoEstrutural(
                candidato,
                contexto,
                `o dominio '${contexto.dominio}' nao indexa nos '${rotulo}'`
            )
        ];
    }

    const consulta = consultaPara(rotulo);
    const linhas = await executor(consulta, {
        nome: candidato.item,
        // A telemetria vai INTEIRA e sem conversao: e o lado deterministico do
        // ContextoRecuperacao, exatamente como foi medido.
        telemetria: contexto.contextoEstruturado.telemetria
    });

    const validadas: RegraValidada[] = [];

    for (const [nodeId, doGrupo] of agruparPorRegra(linhas)) {
        const condicoesSatisfeitas: CondicaoAvaliada[] = [];
        const condicoesFalhas: CondicaoAvaliada[] = [];
        const lacunas: Lacuna[] = [];
        const evidencia: Record<string, number> = {};

        const primeira = doGrupo[0];

        for (const linha of doGrupo) {
            const esperado = legivel(linha.operador, linha.esperado, linha.unidade);

            if (linha.observado === null || linha.satisfeita === null) {
                lacunas.push({
                    campo: linha.parametro,
                    esperado,
                    motivo:
                        linha.observado === null
                            ? `o cenario nao mediu '${linha.parametro}': sem esse valor a condicao nao pode ser afirmada nem negada`
                            : `operador '${linha.operador}' nao reconhecido para '${linha.parametro}'`
                });
                continue;
            }

            evidencia[linha.parametro] = linha.observado;
            const condicao: CondicaoAvaliada = {
                campo: linha.parametro,
                observado: linha.observado,
                esperado,
                operador: linha.operador,
                limite: linha.esperado,
                unidade: linha.unidade ?? undefined,
                satisfeita: linha.satisfeita
            };
            (linha.satisfeita ? condicoesSatisfeitas : condicoesFalhas).push(condicao);
        }

        const aplicavel =
            condicoesFalhas.length === 0 &&
            lacunas.length === 0 &&
            condicoesSatisfeitas.length > 0;

        const motivo = aplicavel
            ? `${condicoesSatisfeitas.map(c => `${c.campo} ${c.observado} ${c.esperado}`).join(' e ')}: condicao satisfeita`
            : condicoesFalhas.length > 0
              ? `${condicoesFalhas
                    .map(c => `${c.campo} ${c.observado} nao satisfaz ${c.esperado}`)
                    .join('; ')}`
              : lacunas.length > 0
                ? `sem evidencia: ${lacunas.map(l => l.motivo).join('; ')}`
                : 'nenhuma condicao avaliavel nesta regra';

        validadas.push({
            regraId: `${candidato.regraId}/${primeira.tipoRegra}/${doGrupo
                .map(l => `${l.parametro}${l.operador}${l.esperado}`)
                .join('&')}`,
            tipo: primeira.tipoRegra,
            relacao: primeira.relacao,
            item: candidato.item,
            dominio: contexto.dominio,
            aplicavel,
            condicoesSatisfeitas,
            condicoesFalhas,
            lacunas,
            evidencia,
            validacaoCypher: { valida: aplicavel, motivo, consulta, nodeId },
            efeito: {
                razao: primeira.razao ?? undefined,
                acao: primeira.acao ?? undefined,
                detalhe: primeira.detalhe ?? undefined
            },
            rag: {
                candidatoId: candidato.regraId,
                escore: candidato.escore,
                cosseno: candidato.cosseno,
                papel: candidato.metadados.papel,
                posicao: candidato.metadados.posicao
            }
        });
    }

    return validadas;
}

/**
 * Valida TODOS os candidatos, um a um.
 *
 * Sequencial, nao `Promise.all`: uma `Session` do driver nao roda duas queries
 * concorrentes — mesma restricao que `retrieverFoco*` ja documenta.
 *
 * A saida NAO e reordenada por escore. Ordenar o resultado da validacao pela
 * relevancia semantica sugeriria que o escore pesa no veredito, e ele nao pesa.
 */
export async function validarCandidatos(
    contexto: ContextoRecuperacao,
    candidatos: CandidatoRegra[],
    executor: ExecutorCypher
): Promise<RegraValidada[]> {
    const validadas: RegraValidada[] = [];
    for (const candidato of candidatos) {
        validadas.push(...(await validarCandidato(contexto, candidato, executor)));
    }
    return validadas;
}
