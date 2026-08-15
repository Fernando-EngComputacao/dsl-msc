/**
 * Extracao dos vocabularios de instancia a partir do modelo agricola validado.
 *
 * Espelha src/grammar/vocabularies.ts no dominio da pulverizacao por drone: os
 * nomes que o modelo declara viram as unicas alternativas possiveis nos terminais
 * da gramatica de saida. Um produto sem registro no modelo e inexprimivel.
 */

import {
    isAgroSchemaDef,
    isProductDef,
    isDoseAttr,
    isCultureDef,
    isMissionCommand,
    type AgroSchemaDef,
    type ProductDef,
    type AgroModel,
    type Quantity
} from '../generated/ast.js';
import type { Vocabularies } from './extract-bnf.js';

export interface AgroVocabularyOptions {
    /** Restringe a saida a um `esquema_dados` especifico. Por omissao, usa o primeiro. */
    schemaName?: string;
    /** Restringe os produtos citaveis (subgrafo recuperado do Grafo de Conhecimento). */
    allowedProducts?: string[];
    /** Restringe as decisoes admissiveis (poda vinda das regras do grafo). */
    allowedDecisions?: string[];
    /** Restringe os modos de pulverizacao admissiveis. */
    allowedModes?: string[];
}

export interface AgroVocabularyResult {
    vocabularies: Vocabularies;
    schema: AgroSchemaDef;
    products: ProductDef[];
}

/** Unidades efetivamente usadas nas doses dos produtos citaveis. */
function rateUnitsOf(products: ProductDef[]): string[] {
    const units = new Set<string>();
    const add = (q: Quantity | undefined) => {
        if (q) units.add(q.unit);
    };
    for (const product of products) {
        for (const attr of product.attributes) {
            if (isDoseAttr(attr)) add(attr.value);
        }
    }
    return [...units];
}

function intersect(declared: string[], allowed?: string[]): string[] {
    if (!allowed || allowed.length === 0) return declared;
    const set = new Set(allowed);
    const kept = declared.filter(d => set.has(d));
    return kept.length > 0 ? kept : declared;
}

/**
 * Constroi os vocabularios da gramatica de saida a partir do modelo agricola.
 * Lanca se o modelo nao declarar nenhum `esquema_dados`: sem Esquema de Dados nao
 * ha universo fechado de respostas e a decodificacao restrita perde sentido.
 */
export function buildAgroVocabularies(
    model: AgroModel,
    options: AgroVocabularyOptions = {}
): AgroVocabularyResult {
    const schemas = model.elements.filter(isAgroSchemaDef);
    if (schemas.length === 0) {
        throw new Error('O modelo nao declara nenhum `esquema_dados` (Esquema de Dados ausente).');
    }
    const schema = options.schemaName
        ? schemas.find(s => s.name === options.schemaName)
        : schemas[0];
    if (!schema) {
        throw new Error(`Esquema de dados \`${options.schemaName}\` nao encontrado no modelo.`);
    }

    const allProducts = model.elements.filter(isProductDef);
    const products = options.allowedProducts?.length
        ? allProducts.filter(p => options.allowedProducts!.includes(p.name))
        : allProducts;
    const effectiveProducts = products.length > 0 ? products : allProducts;

    const cultures = model.elements.filter(isCultureDef).map(c => c.name);
    // Missoes ja existentes no modelo servem de exemplar few-shot, nao de vocabulario.
    void model.elements.filter(isMissionCommand);

    const vocabularies: Vocabularies = new Map([
        ['produto', effectiveProducts.map(p => p.name)],
        ['cultura', cultures],
        ['esquema', [schema.name]],
        ['conduta', schema.conducts.map(c => c.name)],
        ['decisao', intersect(schema.decisions, options.allowedDecisions)],
        ['modo', intersect(schema.modes, options.allowedModes)],
        ['nivel_alerta', [...schema.alerts]],
        ['unidade', rateUnitsOf(effectiveProducts)]
    ]);

    return { vocabularies, schema, products: effectiveProducts };
}
