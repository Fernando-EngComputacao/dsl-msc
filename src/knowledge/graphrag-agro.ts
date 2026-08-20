/**
 * Recuperacao no Grafo de Conhecimento agricola (GraphRAG) — etapa 2 da Figura 5.1.
 *
 * Espelha src/knowledge/graphrag.ts no dominio da pulverizacao por drone. Recebe a
 * telemetria dos sensores e devolve o subgrafo de restricoes que incide sobre
 * aquele instante operacional. A avaliacao e DETERMINISTICA: quem decide se o
 * Glifosato esta bloqueado e a comparacao `vento 14 > 10`, nao o LLM.
 *
 * Como no dominio clinico, a saida principal e uma POLITICA POR PRODUTO — quais
 * decisoes, modos e unidades continuam admissiveis para cada defensivo:
 *
 *     "iniciar Glifosato com vento 14 km/h" deixa de ser uma resposta improvavel
 *     e passa a ser uma cadeia que a gramatica nao gera.
 */

import neo4j, { type Session } from 'neo4j-driver';

import {
    isAgroBlockRule,
    isAgroForbidAttr,
    isAgroRecommendAttr,
    isAgroSchemaDef,
    isAreaAdjust,
    isAreaDef,
    isAreaForbid,
    isBanConditionAttr,
    isCultureDef,
    isDoseAttr,
    isEscalationAttr,
    isGlobalRule,
    isIncompatAttr,
    isProductDef,
    isTriggerAttr,
    type AgroModel,
    type Operator,
    type ProductDef
} from '../generated/ast.js';
import { embedTexto } from './embeddings.js';

export interface AgroContext {
    /** Telemetria corrente dos sensores: parametro -> valor observado. */
    telemetria: Record<string, number>;
    /** Areas especiais em que o talhao se enquadra (ex.: Faixa_Manancial). */
    areas?: string[];
    /** Produtos ja carregados no tanque, usados para avaliar incompatibilidade. */
    produtosEmUso?: string[];
    /** Fala do operador, preservada para compor o Prompt Semantico. */
    intencao?: string;
    /** Identificacao do talhao para o registro de auditoria. */
    talhao?: string;
}

/** Politica de saida admissivel para um produto, dado o contexto. */
export interface ProductPolicy {
    produto: string;
    decisoes: string[];
    modos: string[];
    unidades: string[];
    motivos: string[];
    bloqueado: boolean;
}

export interface RetrievedAgroConstraints {
    culturasAtivas: { nome: string; ciclo: string; gatilhos: string[] }[];
    bloqueios: { produto: string; regra: string; razao: string }[];
    ajustes: { produto: string; acao: string; detalhe: string; origem: string }[];
    recomendados: { produto: string; indicacao: string; cultura: string }[];
    vetados: { produto: string; motivo: string; origem: string }[];
    escalonamentos: { destino: string; detalhe: string; cultura: string }[];
    incompatibilidades: { entre: string; gravidade: string; mecanismo: string; conduta: string }[];
    proibicoes: { produto: string; condicao: string; excecao: string }[];
    regrasGlobais: { descricao: string; severidade: string }[];
    politicas: Map<string, ProductPolicy>;
}

/** Decisoes que representam aumento de exposicao ao produto. */
const DECISOES_DE_INCREMENTO = new Set(['INICIAR_APLICACAO', 'AUMENTAR_VAZAO']);

/** Decisoes admissiveis quando o produto esta integralmente vetado. */
const DECISOES_DE_RETIRADA = [
    'SUSPENDER',
    'BLOQUEAR_APLICACAO',
    'ACIONAR_AGRONOMO',
    'AGUARDAR_JANELA'
];

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

function unitsOf(product: ProductDef): string[] {
    const units = new Set<string>();
    for (const attr of product.attributes) {
        if (isDoseAttr(attr)) units.add(attr.value.unit);
    }
    return [...units];
}

/**
 * Percorre o grafo derivado do modelo e devolve as restricoes ativas.
 * Regras cujo parametro nao esta na telemetria sao ignoradas: sensor ausente nao
 * e evidencia de condicao segura, mas tambem nao autoriza bloquear.
 */
export function retrieveAgroConstraints(
    model: AgroModel,
    context: AgroContext
): RetrievedAgroConstraints {
    const telemetria = context.telemetria;
    const areas = new Set(context.areas ?? []);
    const emUso = new Set(context.produtosEmUso ?? []);

    const products = model.elements.filter(isProductDef);
    const schema = model.elements.filter(isAgroSchemaDef)[0];
    if (!schema) throw new Error('Modelo sem `esquema_dados`: nao ha universo de respostas.');

    const result: RetrievedAgroConstraints = {
        culturasAtivas: [],
        bloqueios: [],
        ajustes: [],
        recomendados: [],
        vetados: [],
        escalonamentos: [],
        incompatibilidades: [],
        proibicoes: [],
        regrasGlobais: [],
        politicas: new Map()
    };

    // ------------------------------------------------- politica inicial (aberta)
    for (const product of products) {
        result.politicas.set(product.name, {
            produto: product.name,
            decisoes: [...schema.decisions],
            modos: [...schema.modes],
            unidades: unitsOf(product),
            motivos: [],
            bloqueado: false
        });
    }

    // ----------------------------------------------------- culturas e gatilhos
    for (const culture of model.elements.filter(isCultureDef)) {
        const gatilhos: string[] = [];
        for (const attr of culture.attributes) {
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

        result.culturasAtivas.push({ nome: culture.name, ciclo: culture.cycle, gatilhos });

        for (const attr of culture.attributes) {
            if (isAgroRecommendAttr(attr)) {
                result.recomendados.push({
                    produto: attr.product.$refText,
                    indicacao: attr.indication ?? '',
                    cultura: culture.name
                });
            } else if (isAgroForbidAttr(attr)) {
                result.vetados.push({
                    produto: attr.product.$refText,
                    motivo: attr.reason,
                    origem: `cultura ${culture.name}`
                });
            } else if (isEscalationAttr(attr)) {
                const observado = telemetria[attr.parameter];
                if (observado !== undefined && compare(observado, attr.operator, attr.value.value)) {
                    result.escalonamentos.push({
                        destino: attr.target,
                        detalhe: attr.detail,
                        cultura: culture.name
                    });
                }
            }
        }
    }

    // ------------------------------------------- invariantes de seguranca ativas
    for (const element of model.elements) {
        if (!isAgroBlockRule(element)) continue;
        const observado = telemetria[element.parameter];
        if (observado === undefined) continue;
        if (!compare(observado, element.operator, element.threshold.value)) continue;

        const produto = element.product.$refText;
        const regra = `${element.parameter} ${observado} ${element.operator} ${element.threshold.value} ${element.threshold.unit}`;
        result.bloqueios.push({ produto, regra, razao: element.reason });

        const policy = result.politicas.get(produto);
        if (policy) {
            // Bloqueio de aplicacao: o produto continua citavel, mas nenhuma
            // decisao que aumente a exposicao permanece na gramatica.
            policy.decisoes = policy.decisoes.filter(d => !DECISOES_DE_INCREMENTO.has(d));
            policy.bloqueado = true;
            policy.motivos.push(`aplicacao bloqueada (${regra}): ${element.reason}`);
        }
    }

    // ---------------------------------------------------------- areas especiais
    for (const area of model.elements.filter(isAreaDef)) {
        if (!areas.has(area.name)) continue;
        for (const restriction of area.restrictions) {
            if (isAreaForbid(restriction)) {
                result.vetados.push({
                    produto: restriction.product.$refText,
                    motivo: restriction.reason,
                    origem: `area ${area.name}`
                });
            } else if (isAreaAdjust(restriction)) {
                result.ajustes.push({
                    produto: restriction.product.$refText,
                    acao: `multiplicar vazao por ${restriction.factor}`,
                    detalhe: restriction.reason ?? '',
                    origem: `area ${area.name}`
                });
            }
        }
    }

    // ------------------------------------ vetos aplicados as politicas de saida
    for (const veto of result.vetados) {
        const policy = result.politicas.get(veto.produto);
        if (!policy) continue;
        policy.decisoes = policy.decisoes.filter(d => DECISOES_DE_RETIRADA.includes(d));
        policy.bloqueado = true;
        policy.motivos.push(`vetado por ${veto.origem}: ${veto.motivo}`);
    }

    // -------------------------------------- incompatibilidades e proibicoes
    for (const product of products) {
        for (const attr of product.attributes) {
            if (isIncompatAttr(attr)) {
                const outro = attr.other.$refText;
                // So interessa a incompatibilidade entre produtos efetivamente no tanque.
                if (!emUso.has(product.name) && !emUso.has(outro)) continue;
                result.incompatibilidades.push({
                    entre: `${product.name} + ${outro}`,
                    gravidade: attr.severity,
                    mecanismo: attr.mechanism,
                    conduta: attr.conduct ?? ''
                });
            } else if (isBanConditionAttr(attr)) {
                result.proibicoes.push({
                    produto: product.name,
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
 * ATENCAO — mesma limitacao do dominio clinico (ver graphrag.ts): as tres listas
 * sao independentes e perdem a associacao (produto, decisao, modo) que
 * `politicas` calcula corretamente. Um produto sobrevive a poda enquanto tiver
 * QUALQUER decisao admissivel, e a uniao das decisoes de todos os produtos passa
 * a valer para todos — o que devolve o produto cartesiano ao decodificador.
 */
export function agroPruningPayload(constraints: RetrievedAgroConstraints): {
    acoes_permitidas: string[];
    farmacos_liberados: string[];
    vias_disponiveis: string[];
} {
    const acoes = new Set<string>();
    const produtos: string[] = [];
    const modos = new Set<string>();

    for (const policy of constraints.politicas.values()) {
        if (policy.decisoes.length === 0) continue;
        produtos.push(policy.produto);
        for (const d of policy.decisoes) acoes.add(d);
        for (const m of policy.modos) modos.add(m);
    }

    // As chaves seguem os nomes do motor Python (MAPA_PODA em grammar_from_kg.py),
    // que sao os mesmos nos dois dominios: o motor e agnostico de dominio.
    return {
        acoes_permitidas: [...acoes],
        farmacos_liberados: produtos,
        vias_disponiveis: [...modos]
    };
}

/**
 * Recuperacao por embedding no Neo4j — espelha `graphrag.ts::retrieverFoco` no
 * dominio agricola. So decide QUAIS produtos/culturas entram no Prompt
 * Semantico; a avaliacao de bloqueio continua 100% deterministica em
 * `retrieveAgroConstraints`.
 */
export interface AgroFoco {
    produtos: Set<string>;
    culturas: Set<string>;
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

export async function retrieverFocoAgro(
    session: Session,
    intencao: string,
    topK = FOCO_TOP_K
): Promise<AgroFoco> {
    const vetor = await embedTexto(intencao);
    // Sequencial, nao Promise.all: uma Session do driver nao roda duas queries
    // concorrentes ("Queries cannot be run directly on a session with an open
    // transaction").
    const produtos = await topKPorVetor(session, 'produto_embedding', vetor, topK);
    const culturas = await topKPorVetor(session, 'cultura_embedding', vetor, topK);
    return { produtos: acimaDoLimiar(produtos), culturas: acimaDoLimiar(culturas) };
}

/**
 * Restringe as restricoes ja recuperadas ao foco semantico. Invariantes globais
 * ficam sempre de fora do filtro — valem independente do que foi pedido.
 */
export function filtrarPorFocoAgro(
    constraints: RetrievedAgroConstraints,
    foco: AgroFoco
): RetrievedAgroConstraints {
    const noFoco = (produto: string) => foco.produtos.has(produto);
    const culturaNoFoco = (cultura: string) => foco.culturas.has(cultura);
    const incompatNoFoco = (entre: string) => entre.split(' + ').some(noFoco);

    return {
        culturasAtivas: constraints.culturasAtivas.filter(c => culturaNoFoco(c.nome)),
        bloqueios: constraints.bloqueios.filter(b => noFoco(b.produto)),
        ajustes: constraints.ajustes.filter(a => noFoco(a.produto)),
        recomendados: constraints.recomendados.filter(r => noFoco(r.produto) || culturaNoFoco(r.cultura)),
        vetados: constraints.vetados.filter(v => noFoco(v.produto)),
        escalonamentos: constraints.escalonamentos.filter(e => culturaNoFoco(e.cultura)),
        incompatibilidades: constraints.incompatibilidades.filter(i => incompatNoFoco(i.entre)),
        proibicoes: constraints.proibicoes.filter(p => noFoco(p.produto)),
        regrasGlobais: constraints.regrasGlobais,
        politicas: new Map([...constraints.politicas].filter(([produto]) => noFoco(produto)))
    };
}
