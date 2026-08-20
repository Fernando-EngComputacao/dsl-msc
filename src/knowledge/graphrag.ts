/**
 * Recuperacao no Grafo de Conhecimento (GraphRAG) — etapa 2 da Figura 5.1.
 *
 * Recebe a telemetria do leito e devolve o subgrafo de restricoes que incide sobre
 * aquele instante clinico. Toda a avaliacao e DETERMINISTICA: quem decide se o
 * Propofol esta bloqueado e a comparacao `PAM 52 < 60`, nao o LLM.
 *
 * A saida nao e apenas um bloco de texto para o prompt. E, sobretudo, uma POLITICA
 * POR FARMACO — quais decisoes, vias e unidades continuam admissiveis para cada
 * medicamento — que a etapa seguinte converte em gramatica. Essa e a diferenca
 * entre pedir ao modelo que respeite uma regra e tornar a violacao inexprimivel:
 *
 *     "aumentar Propofol com PAM 52" deixa de ser uma resposta improvavel
 *     e passa a ser uma cadeia que a gramatica nao gera.
 */

import neo4j, { type Session } from 'neo4j-driver';

import {
    isBlockRule,
    isDataSchemaDef,
    isDoseLimitAttr,
    isDrugDef,
    isEscalationAttr,
    isForbidAttr,
    isGlobalRule,
    isInteractionAttr,
    isPopAdjust,
    isPopForbid,
    isPopulationDef,
    isProtocolDef,
    isPumpLimitAttr,
    isRecommendAttr,
    isRenalAdjustAttr,
    isRouteAttr,
    isTitrationAttr,
    isTriggerAttr,
    type DrugDef,
    type MedicalModel,
    type Operator
} from '../generated/ast.js';
import { embedTexto } from './embeddings.js';

export interface ClinicalContext {
    /** Telemetria corrente: parametro clinico -> valor observado. */
    telemetria: Record<string, number>;
    /** Populacoes especiais as quais o paciente pertence (ex.: Renal_Cronico). */
    populacoes?: string[];
    /** Farmacos ja em infusao, usados para avaliar interacoes. */
    farmacosEmUso?: string[];
    /** Fala do profissional, preservada para compor o Prompt Semantico. */
    intencao?: string;
    /** Identificacao do paciente para o registro de auditoria. */
    paciente?: string;
}

/** Politica de saida admissivel para um farmaco, dado o contexto. */
export interface DrugPolicy {
    farmaco: string;
    decisoes: string[];
    vias: string[];
    unidades: string[];
    /** Justificativas legiveis das restricoes aplicadas. */
    motivos: string[];
    bloqueado: boolean;
}

export interface RetrievedConstraints {
    protocolosAtivos: { nome: string; cid: string; gatilhos: string[] }[];
    bloqueios: { farmaco: string; regra: string; razao: string }[];
    ajustes: { farmaco: string; acao: string; detalhe: string; origem: string }[];
    recomendados: { farmaco: string; indicacao: string; protocolo: string }[];
    vetados: { farmaco: string; motivo: string; origem: string }[];
    escalonamentos: { destino: string; detalhe: string; protocolo: string }[];
    interacoes: { entre: string; gravidade: string; mecanismo: string; conduta: string }[];
    regrasGlobais: { descricao: string; severidade: string }[];
    politicas: Map<string, DrugPolicy>;
}

/** Decisoes que representam aumento de exposicao ao farmaco. */
const DECISOES_DE_INCREMENTO = new Set(['INICIAR_INFUSAO', 'AUMENTAR_VAZAO', 'AJUSTAR_DOSE']);

/** Decisoes admissiveis quando o farmaco esta integralmente vetado. */
const DECISOES_DE_RETIRADA = ['SUSPENDER', 'BLOQUEAR_ORDEM', 'ESCALAR_EQUIPE'];

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

function routesOf(drug: DrugDef): string[] {
    for (const attr of drug.attributes) {
        if (isRouteAttr(attr)) return [...attr.routes];
    }
    return [];
}

function unitsOf(drug: DrugDef): string[] {
    const units = new Set<string>();
    for (const attr of drug.attributes) {
        if (isDoseLimitAttr(attr)) units.add(attr.value.unit);
        else if (isTitrationAttr(attr)) units.add(attr.step.unit);
        else if (isPumpLimitAttr(attr)) {
            units.add(attr.soft.unit);
            units.add(attr.hard.unit);
        }
    }
    return [...units];
}

/**
 * Percorre o grafo derivado do modelo e devolve as restricoes ativas.
 * Regras cujo parametro nao esta presente na telemetria sao ignoradas: ausencia de
 * medida nao e evidencia de normalidade, mas tambem nao autoriza bloquear.
 */
export function retrieveConstraints(
    model: MedicalModel,
    context: ClinicalContext
): RetrievedConstraints {
    const telemetria = context.telemetria;
    const populacoes = new Set(context.populacoes ?? []);
    const emUso = new Set(context.farmacosEmUso ?? []);

    const drugs = model.elements.filter(isDrugDef);
    const schema = model.elements.filter(isDataSchemaDef)[0];
    if (!schema) throw new Error('Modelo sem `esquema_dados`: nao ha universo de respostas.');

    const result: RetrievedConstraints = {
        protocolosAtivos: [],
        bloqueios: [],
        ajustes: [],
        recomendados: [],
        vetados: [],
        escalonamentos: [],
        interacoes: [],
        regrasGlobais: [],
        politicas: new Map()
    };

    // ------------------------------------------------- politica inicial (aberta)
    for (const drug of drugs) {
        const vias = routesOf(drug).filter(v => schema.routes.includes(v as never));
        result.politicas.set(drug.name, {
            farmaco: drug.name,
            decisoes: [...schema.decisions],
            vias: vias.length > 0 ? vias : [...schema.routes],
            unidades: unitsOf(drug),
            motivos: [],
            bloqueado: false
        });
    }

    // --------------------------------------------------- protocolos e gatilhos
    for (const protocol of model.elements.filter(isProtocolDef)) {
        const gatilhos: string[] = [];
        for (const attr of protocol.attributes) {
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

        result.protocolosAtivos.push({ nome: protocol.name, cid: protocol.icd, gatilhos });

        for (const attr of protocol.attributes) {
            if (isRecommendAttr(attr)) {
                result.recomendados.push({
                    farmaco: attr.drug.$refText,
                    indicacao: attr.indication ?? '',
                    protocolo: protocol.name
                });
            } else if (isForbidAttr(attr)) {
                result.vetados.push({
                    farmaco: attr.drug.$refText,
                    motivo: attr.reason,
                    origem: `protocolo ${protocol.name}`
                });
            } else if (isEscalationAttr(attr)) {
                const observado = telemetria[attr.parameter];
                if (observado !== undefined && compare(observado, attr.operator, attr.value.value)) {
                    result.escalonamentos.push({
                        destino: attr.target,
                        detalhe: attr.detail,
                        protocolo: protocol.name
                    });
                }
            }
        }
    }

    // ------------------------------------------- invariantes de seguranca ativas
    for (const element of model.elements) {
        if (!isBlockRule(element)) continue;
        const observado = telemetria[element.parameter];
        if (observado === undefined) continue;
        if (!compare(observado, element.operator, element.threshold.value)) continue;

        const farmaco = element.drug.$refText;
        const regra = `${element.parameter} ${observado} ${element.operator} ${element.threshold.value} ${element.threshold.unit}`;
        result.bloqueios.push({ farmaco, regra, razao: element.reason });

        const policy = result.politicas.get(farmaco);
        if (policy) {
            // Bloqueio de incremento: o farmaco continua citavel, mas nenhuma
            // decisao que aumente a exposicao permanece na gramatica.
            policy.decisoes = policy.decisoes.filter(d => !DECISOES_DE_INCREMENTO.has(d));
            policy.bloqueado = true;
            policy.motivos.push(`incremento bloqueado (${regra}): ${element.reason}`);
        }
    }

    // ------------------------------------------------------ populacoes especiais
    for (const population of model.elements.filter(isPopulationDef)) {
        if (!populacoes.has(population.name)) continue;
        for (const restriction of population.restrictions) {
            if (isPopForbid(restriction)) {
                const farmaco = restriction.drug.$refText;
                result.vetados.push({
                    farmaco,
                    motivo: restriction.reason,
                    origem: `populacao ${population.name}`
                });
            } else if (isPopAdjust(restriction)) {
                result.ajustes.push({
                    farmaco: restriction.drug.$refText,
                    acao: `multiplicar dose por ${restriction.factor}`,
                    detalhe: restriction.reason ?? '',
                    origem: `populacao ${population.name}`
                });
            }
        }
    }

    // ------------------------------------ vetos aplicados as politicas de saida
    for (const veto of result.vetados) {
        const policy = result.politicas.get(veto.farmaco);
        if (!policy) continue;
        policy.decisoes = policy.decisoes.filter(d => DECISOES_DE_RETIRADA.includes(d));
        policy.bloqueado = true;
        policy.motivos.push(`vetado por ${veto.origem}: ${veto.motivo}`);
    }

    // ------------------------------------------- ajustes renais e interacoes
    for (const drug of drugs) {
        for (const attr of drug.attributes) {
            if (isRenalAdjustAttr(attr)) {
                const observado = telemetria[attr.parameter];
                if (observado === undefined) continue;
                if (!compare(observado, attr.operator, attr.threshold.value)) continue;
                result.ajustes.push({
                    farmaco: drug.name,
                    acao: attr.action,
                    detalhe: attr.detail,
                    origem: `${attr.parameter} ${observado} ${attr.operator} ${attr.threshold.value} ${attr.threshold.unit}`
                });
                if (attr.action === 'suspender' || attr.action === 'bloquear') {
                    const policy = result.politicas.get(drug.name);
                    if (policy) {
                        policy.decisoes = policy.decisoes.filter(d => !DECISOES_DE_INCREMENTO.has(d));
                        policy.bloqueado = true;
                        policy.motivos.push(`ajuste renal: ${attr.detail}`);
                    }
                }
            } else if (isInteractionAttr(attr)) {
                const outro = attr.other.$refText;
                // So interessa a interacao entre farmacos efetivamente envolvidos.
                if (!emUso.has(drug.name) && !emUso.has(outro)) continue;
                result.interacoes.push({
                    entre: `${drug.name} + ${outro}`,
                    gravidade: attr.severity,
                    mecanismo: attr.mechanism,
                    conduta: attr.conduct ?? ''
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
 * Mantido para compatibilidade com o motor de decodificacao local; a poda por
 * farmaco (mais estrita) e feita por `src/grammar/constrain.ts`.
 */
export function pruningPayload(constraints: RetrievedConstraints): {
    acoes_permitidas: string[];
    farmacos_liberados: string[];
    vias_disponiveis: string[];
} {
    const acoes = new Set<string>();
    const farmacos: string[] = [];
    const vias = new Set<string>();

    for (const policy of constraints.politicas.values()) {
        if (policy.decisoes.length === 0) continue;
        farmacos.push(policy.farmaco);
        for (const d of policy.decisoes) acoes.add(d);
        for (const v of policy.vias) vias.add(v);
    }

    return {
        acoes_permitidas: [...acoes],
        farmacos_liberados: farmacos,
        vias_disponiveis: [...vias]
    };
}

/**
 * Recuperacao por embedding no Neo4j — etapa OPCIONAL antes de `retrieveConstraints`,
 * usada quando o comando vem digitado em vez de vir de um cenario pronto (ver
 * `src/inference/cli.ts`). So decide QUAIS farmacos/protocolos entram no Prompt
 * Semantico; a avaliacao de bloqueio em si continua inteiramente deterministica
 * em `retrieveConstraints` — o embedding nunca decide o que e permitido, so o que
 * e mostrado.
 */
export interface Foco {
    farmacos: Set<string>;
    protocolos: Set<string>;
}

const FOCO_TOP_K = 5;
// Calibrado com bge-m3: pares claramente relacionados marcaram ~0.6, pares sem
// relacao nenhuma ~0.28 (ver testes ad-hoc do modelo). 0.35 fica no meio.
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

/** Mantem so quem passa do limiar; sem nenhum acima, mantem o mais proximo mesmo assim
 *  — um foco impreciso e melhor que um Prompt Semantico vazio. */
function acimaDoLimiar(itens: { nome: string; score: number }[]): Set<string> {
    const relevantes = itens.filter(i => i.score >= FOCO_LIMIAR_SIMILARIDADE);
    return new Set((relevantes.length > 0 ? relevantes : itens.slice(0, 1)).map(i => i.nome));
}

export async function retrieverFoco(session: Session, intencao: string, topK = FOCO_TOP_K): Promise<Foco> {
    const vetor = await embedTexto(intencao);
    // Sequencial, nao Promise.all: uma Session do driver nao roda duas queries
    // concorrentes ("Queries cannot be run directly on a session with an open
    // transaction").
    const farmacos = await topKPorVetor(session, 'farmaco_embedding', vetor, topK);
    const protocolos = await topKPorVetor(session, 'protocolo_embedding', vetor, topK);
    return { farmacos: acimaDoLimiar(farmacos), protocolos: acimaDoLimiar(protocolos) };
}

/**
 * Restringe as restricoes ja recuperadas ao foco semantico. Invariantes globais
 * ficam sempre de fora do filtro — sao regras que valem independente do que foi
 * pedido, nao "sobre" um farmaco ou protocolo especifico.
 */
export function filtrarPorFoco(constraints: RetrievedConstraints, foco: Foco): RetrievedConstraints {
    const noFoco = (farmaco: string) => foco.farmacos.has(farmaco);
    const protocoloNoFoco = (protocolo: string) => foco.protocolos.has(protocolo);
    const interacaoNoFoco = (entre: string) => entre.split(' + ').some(noFoco);

    return {
        protocolosAtivos: constraints.protocolosAtivos.filter(p => protocoloNoFoco(p.nome)),
        bloqueios: constraints.bloqueios.filter(b => noFoco(b.farmaco)),
        ajustes: constraints.ajustes.filter(a => noFoco(a.farmaco)),
        recomendados: constraints.recomendados.filter(r => noFoco(r.farmaco) || protocoloNoFoco(r.protocolo)),
        vetados: constraints.vetados.filter(v => noFoco(v.farmaco)),
        escalonamentos: constraints.escalonamentos.filter(e => protocoloNoFoco(e.protocolo)),
        interacoes: constraints.interacoes.filter(i => interacaoNoFoco(i.entre)),
        regrasGlobais: constraints.regrasGlobais,
        politicas: new Map([...constraints.politicas].filter(([farmaco]) => noFoco(farmaco)))
    };
}
