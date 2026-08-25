/**
 * Recuperacao no Grafo de Conhecimento de arbitragem (GraphRAG) — etapa 2 da
 * Figura 5.1, dominio futebol.
 *
 * Espelha src/knowledge/graphrag.ts (clinico) e src/knowledge/graphrag-agro.ts
 * (agricola) no dominio da arbitragem de futebol. Recebe a leitura da partida
 * (minuto, cartoes acumulados, distancias) e devolve o subgrafo de restricoes
 * que incide sobre aquele instante do jogo. A avaliacao e DETERMINISTICA: quem
 * decide se uma segunda advertencia esta bloqueada e a comparacao
 * `cartoes_amarelos_jogador 0 < 1`, nao o LLM.
 *
 * Como nos outros dois dominios, a saida principal e uma POLITICA POR INFRACAO —
 * quais decisoes, reinicios e unidades continuam admissiveis para cada infracao:
 *
 *     "marca a segunda amarela do jogador" deixa de ser uma resposta improvavel
 *     e passa a ser uma cadeia que a gramatica nao gera, quando nao ha primeira
 *     amarela registrada.
 */

import neo4j, { type Session } from 'neo4j-driver';

import {
    isAgravanteAttr,
    isContextAdjust,
    isContextDef,
    isContextForbid,
    isEscalationAttr,
    isFutBlockRule,
    isFutForbidAttr,
    isFutRecommendAttr,
    isFutSchemaDef,
    isGlobalRule,
    isInfractionDef,
    isIsencaoAttr,
    isLimiarAttr,
    isMonitorAttr,
    isSituationDef,
    isTriggerAttr,
    type FutModel,
    type InfractionDef,
    type Operator
} from '../generated/ast.js';
import { embedTexto } from './embeddings.js';

export interface FutContext {
    /** Leitura corrente da partida: parametro -> valor observado. */
    telemetria: Record<string, number>;
    /** Contextos especiais em que a partida se enquadra (ex.: Acrescimos). */
    contextos?: string[];
    /** Infracoes ja marcadas na partida, usadas para avaliar agravantes. */
    infracoesEmUso?: string[];
    /** Fala do arbitro/observador, preservada para compor o Prompt Semantico. */
    intencao?: string;
    /** Identificacao da partida para o registro de auditoria. */
    partida?: string;
}

/** Politica de saida admissivel para uma infracao, dado o contexto. */
export interface InfractionPolicy {
    infracao: string;
    decisoes: string[];
    reinicios: string[];
    unidades: string[];
    motivos: string[];
    bloqueado: boolean;
}

export interface RetrievedFutConstraints {
    lancesAtivos: { nome: string; lei: string; gatilhos: string[] }[];
    bloqueios: { infracao: string; regra: string; razao: string }[];
    ajustes: { infracao: string; acao: string; detalhe: string; origem: string }[];
    recomendados: { infracao: string; indicacao: string; lance: string }[];
    vetados: { infracao: string; motivo: string; origem: string }[];
    escalonamentos: { destino: string; detalhe: string; lance: string }[];
    agravantes: { entre: string; gravidade: string; mecanismo: string; conduta: string }[];
    isencoes: { infracao: string; condicao: string; excecao: string }[];
    regrasGlobais: { descricao: string; severidade: string }[];
    politicas: Map<string, InfractionPolicy>;
}

/** Decisoes que representam agravamento da sancao sobre a infracao. */
const DECISOES_DE_INCREMENTO = new Set(['CARTAO_VERMELHO', 'EXPULSAR', 'PENALTI']);

/** Decisoes admissiveis quando a infracao esta integralmente vetada. */
const DECISOES_DE_RETIRADA = ['MANTER_JOGO', 'BLOQUEAR_DECISAO', 'ACIONAR_VAR'];

function compare(value: number, operator: Operator, threshold: number): boolean {
    switch (operator) {
        case '>':
            return value > threshold;
        case '<':
            return value < threshold;
        case '>=':
            return value >= threshold;
        case '<=':
            return value <= threshold;
        case '==':
            return value === threshold;
        case '!=':
            return value !== threshold;
    }
}

function unitsOf(infraction: InfractionDef): string[] {
    const units = new Set<string>();
    for (const attr of infraction.attributes) {
        if (isLimiarAttr(attr)) units.add(attr.threshold.unit);
        else if (isMonitorAttr(attr)) units.add(attr.interval.unit);
    }
    return [...units];
}

/**
 * Percorre o grafo derivado do modelo e devolve as restricoes ativas.
 * Regras cujo parametro nao esta na leitura da partida sao ignoradas: leitura
 * ausente nao e evidencia de condicao segura, mas tambem nao autoriza bloquear.
 */
export function retrieveFutConstraints(
    model: FutModel,
    context: FutContext
): RetrievedFutConstraints {
    const telemetria = context.telemetria;
    const contextos = new Set(context.contextos ?? []);
    const emUso = new Set(context.infracoesEmUso ?? []);

    const infractions = model.elements.filter(isInfractionDef);
    const schema = model.elements.filter(isFutSchemaDef)[0];
    if (!schema) throw new Error('Modelo sem `esquema_dados`: nao ha universo de respostas.');

    const result: RetrievedFutConstraints = {
        lancesAtivos: [],
        bloqueios: [],
        ajustes: [],
        recomendados: [],
        vetados: [],
        escalonamentos: [],
        agravantes: [],
        isencoes: [],
        regrasGlobais: [],
        politicas: new Map()
    };

    // ------------------------------------------------- politica inicial (aberta)
    for (const infraction of infractions) {
        result.politicas.set(infraction.name, {
            infracao: infraction.name,
            decisoes: [...schema.decisions],
            reinicios: [...schema.restarts],
            unidades: unitsOf(infraction),
            motivos: [],
            bloqueado: false
        });
    }

    // ------------------------------------------------------- lances e gatilhos
    for (const situation of model.elements.filter(isSituationDef)) {
        const gatilhos: string[] = [];
        for (const attr of situation.attributes) {
            if (!isTriggerAttr(attr)) continue;
            const observado = telemetria[attr.parameter];
            if (observado === undefined) continue;
            if (compare(observado, attr.operator, attr.value.value)) {
                gatilhos.push(
                    `${attr.parameter} ${observado} ${attr.operator} ${attr.value.value} ${attr.value.unit} -> ${attr.action}`
                );
            }
        }
        if (gatilhos.length === 0) continue;

        result.lancesAtivos.push({ nome: situation.name, lei: situation.lawRef, gatilhos });

        for (const attr of situation.attributes) {
            if (isFutRecommendAttr(attr)) {
                result.recomendados.push({
                    infracao: attr.infraction.$refText,
                    indicacao: attr.indication ?? '',
                    lance: situation.name
                });
            } else if (isFutForbidAttr(attr)) {
                result.vetados.push({
                    infracao: attr.infraction.$refText,
                    motivo: attr.reason,
                    origem: `lance ${situation.name}`
                });
            } else if (isEscalationAttr(attr)) {
                const observado = telemetria[attr.parameter];
                if (observado !== undefined && compare(observado, attr.operator, attr.value.value)) {
                    result.escalonamentos.push({
                        destino: attr.target,
                        detalhe: attr.detail,
                        lance: situation.name
                    });
                }
            }
        }
    }

    // ------------------------------------------- invariantes de seguranca ativas
    for (const element of model.elements) {
        if (!isFutBlockRule(element)) continue;
        const observado = telemetria[element.parameter];
        if (observado === undefined) continue;
        if (!compare(observado, element.operator, element.threshold.value)) continue;

        const infracao = element.infraction.$refText;
        const regra = `${element.parameter} ${observado} ${element.operator} ${element.threshold.value} ${element.threshold.unit}`;
        result.bloqueios.push({ infracao, regra, razao: element.reason });

        const policy = result.politicas.get(infracao);
        if (policy) {
            // Bloqueio de decisao: a infracao continua citavel, mas nenhuma
            // decisao que agrave a sancao permanece na gramatica.
            policy.decisoes = policy.decisoes.filter(d => !DECISOES_DE_INCREMENTO.has(d));
            policy.bloqueado = true;
            policy.motivos.push(`decisao bloqueada (${regra}): ${element.reason}`);
        }
    }

    // ------------------------------------------------------- contextos especiais
    for (const contextDef of model.elements.filter(isContextDef)) {
        if (!contextos.has(contextDef.name)) continue;
        for (const restriction of contextDef.restrictions) {
            if (isContextForbid(restriction)) {
                result.vetados.push({
                    infracao: restriction.infraction.$refText,
                    motivo: restriction.reason,
                    origem: `contexto ${contextDef.name}`
                });
            } else if (isContextAdjust(restriction)) {
                result.ajustes.push({
                    infracao: restriction.infraction.$refText,
                    acao: `multiplicar gravidade por ${restriction.factor}`,
                    detalhe: restriction.reason ?? '',
                    origem: `contexto ${contextDef.name}`
                });
            }
        }
    }

    // ------------------------------------ vetos aplicados as politicas de saida
    for (const veto of result.vetados) {
        const policy = result.politicas.get(veto.infracao);
        if (!policy) continue;
        policy.decisoes = policy.decisoes.filter(d => DECISOES_DE_RETIRADA.includes(d));
        policy.bloqueado = true;
        policy.motivos.push(`vetado por ${veto.origem}: ${veto.motivo}`);
    }

    // -------------------------------------------- agravantes e isencoes
    for (const infraction of infractions) {
        for (const attr of infraction.attributes) {
            if (isAgravanteAttr(attr)) {
                const outro = attr.other.$refText;
                // So interessa o agravante entre infracoes efetivamente marcadas na partida.
                if (!emUso.has(infraction.name) && !emUso.has(outro)) continue;
                result.agravantes.push({
                    entre: `${infraction.name} + ${outro}`,
                    gravidade: attr.severity,
                    mecanismo: attr.mechanism,
                    conduta: attr.conduct ?? ''
                });
            } else if (isIsencaoAttr(attr)) {
                result.isencoes.push({
                    infracao: infraction.name,
                    condicao: attr.condition,
                    excecao: attr.exception ?? ''
                });
            }
        }
    }

    for (const element of model.elements) {
        if (isGlobalRule(element)) {
            result.regrasGlobais.push({
                descricao: element.description,
                severidade: element.severity ?? 'nao especificada'
            });
        }
    }

    return result;
}

/**
 * Payload de poda no formato consumido por `python_engine/grammar_from_kg.py`.
 *
 * ATENCAO — mesma limitacao dos outros dois dominios (ver graphrag.ts e
 * graphrag-agro.ts): as tres listas sao independentes e perdem a associacao
 * (infracao, decisao, reinicio) que `politicas` calcula corretamente. Uma
 * infracao sobrevive a poda enquanto tiver QUALQUER decisao admissivel, e a
 * uniao das decisoes de todas as infracoes passa a valer para todas — o que
 * devolve o produto cartesiano ao decodificador.
 */
export function futPruningPayload(constraints: RetrievedFutConstraints): {
    acoes_permitidas: string[];
    farmacos_liberados: string[];
    vias_disponiveis: string[];
} {
    const acoes = new Set<string>();
    const infracoes: string[] = [];
    const reinicios = new Set<string>();

    for (const policy of constraints.politicas.values()) {
        if (policy.decisoes.length === 0) continue;
        infracoes.push(policy.infracao);
        for (const d of policy.decisoes) acoes.add(d);
        for (const r of policy.reinicios) reinicios.add(r);
    }

    // As chaves seguem os nomes do motor Python (MAPA_PODA em grammar_from_kg.py),
    // que sao os mesmos nos tres dominios: o motor e agnostico de dominio.
    return {
        acoes_permitidas: [...acoes],
        farmacos_liberados: infracoes,
        vias_disponiveis: [...reinicios]
    };
}

/**
 * Recuperacao por embedding no Neo4j — espelha `graphrag.ts::retrieverFoco` e
 * `graphrag-agro.ts::retrieverFocoAgro` no dominio da arbitragem. So decide
 * QUAIS infracoes/lances entram no Prompt Semantico; a avaliacao de bloqueio
 * continua 100% deterministica em `retrieveFutConstraints`.
 */
export interface FutFoco {
    infracoes: Set<string>;
    lances: Set<string>;
}

const FOCO_TOP_K = 5;
const FOCO_LIMIAR_SIMILARIDADE = 0.35;

async function topKPorVetor(
    session: Session,
    indice: string,
    vetor: number[],
    topK: number
): Promise<{ nome: string; score: number }[]> {
    const resultado = await session.run(
        `CALL db.index.vector.queryNodes($indice, $topK, $vetor) YIELD node, score
         RETURN node.nome AS nome, score`,
        { indice, topK: neo4j.int(topK), vetor }
    );
    return resultado.records.map(r => ({ nome: r.get('nome') as string, score: r.get('score') as number }));
}

function acimaDoLimiar(itens: { nome: string; score: number }[]): Set<string> {
    const relevantes = itens.filter(i => i.score >= FOCO_LIMIAR_SIMILARIDADE);
    return new Set((relevantes.length > 0 ? relevantes : itens.slice(0, 1)).map(i => i.nome));
}

export async function retrieverFocoFut(
    session: Session,
    intencao: string,
    topK = FOCO_TOP_K
): Promise<FutFoco> {
    const vetor = await embedTexto(intencao);
    // Sequencial, nao Promise.all: uma Session do driver nao roda duas queries
    // concorrentes ("Queries cannot be run directly on a session with an open
    // transaction").
    const infracoes = await topKPorVetor(session, 'infracao_embedding', vetor, topK);
    const lances = await topKPorVetor(session, 'lance_embedding', vetor, topK);
    return { infracoes: acimaDoLimiar(infracoes), lances: acimaDoLimiar(lances) };
}

/**
 * Restringe as restricoes ja recuperadas ao foco semantico. Invariantes globais
 * ficam sempre de fora do filtro — valem independente do que foi pedido.
 */
export function filtrarPorFocoFut(
    constraints: RetrievedFutConstraints,
    foco: FutFoco
): RetrievedFutConstraints {
    const noFoco = (infracao: string) => foco.infracoes.has(infracao);
    const lanceNoFoco = (lance: string) => foco.lances.has(lance);
    const agravanteNoFoco = (entre: string) => entre.split(' + ').some(noFoco);

    return {
        lancesAtivos: constraints.lancesAtivos.filter(l => lanceNoFoco(l.nome)),
        bloqueios: constraints.bloqueios.filter(b => noFoco(b.infracao)),
        ajustes: constraints.ajustes.filter(a => noFoco(a.infracao)),
        recomendados: constraints.recomendados.filter(r => noFoco(r.infracao) || lanceNoFoco(r.lance)),
        vetados: constraints.vetados.filter(v => noFoco(v.infracao)),
        escalonamentos: constraints.escalonamentos.filter(e => lanceNoFoco(e.lance)),
        agravantes: constraints.agravantes.filter(a => agravanteNoFoco(a.entre)),
        isencoes: constraints.isencoes.filter(i => noFoco(i.infracao)),
        regrasGlobais: constraints.regrasGlobais,
        politicas: new Map([...constraints.politicas].filter(([infracao]) => noFoco(infracao)))
    };
}
