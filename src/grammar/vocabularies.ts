/**
 * Extracao dos vocabularios de instancia a partir do modelo clinico validado.
 *
 * E aqui que o Esquema de Controle (o que existe no dominio) e o Esquema de Dados
 * (o que o LLM pode responder) se encontram: os nomes que o modelo declara viram
 * as unicas alternativas possiveis nos terminais da gramatica de saida.
 */

import {
    isDataSchemaDef,
    isDrugDef,
    isDoseLimitAttr,
    isPlanCommand,
    isProtocolDef,
    isPumpLimitAttr,
    isTitrationAttr,
    type DataSchemaDef,
    type DrugDef,
    type MedicalModel,
    type Quantity
} from '../generated/ast.js';
import type { Vocabularies } from './extract-bnf.js';

export interface VocabularyOptions {
    /** Restringe a saida a um `esquema_dados` especifico. Por omissao, usa o primeiro. */
    schemaName?: string;
    /**
     * Restringe os farmacos citaveis (subgrafo recuperado do Grafo de Conhecimento).
     * Sem restricao, todos os farmacos do modelo entram na gramatica.
     */
    allowedDrugs?: string[];
    /** Restringe as decisoes admissiveis (poda vinda das regras do grafo). */
    allowedDecisions?: string[];
    /** Restringe as vias de administracao admissiveis. */
    allowedRoutes?: string[];
}

export interface VocabularyResult {
    vocabularies: Vocabularies;
    schema: DataSchemaDef;
    drugs: DrugDef[];
}

/** Unidades efetivamente usadas nas doses e limites de bomba dos farmacos citaveis. */
function doseUnitsOf(drugs: DrugDef[]): string[] {
    const units = new Set<string>();
    const add = (q: Quantity | undefined) => {
        if (q) units.add(q.unit);
    };
    for (const drug of drugs) {
        for (const attr of drug.attributes) {
            if (isDoseLimitAttr(attr)) add(attr.value);
            else if (isTitrationAttr(attr)) add(attr.step);
            else if (isPumpLimitAttr(attr)) {
                add(attr.soft);
                add(attr.hard);
            }
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
 * Constroi os vocabularios da gramatica de saida a partir do modelo.
 * Lanca se o modelo nao declarar nenhum `esquema_dados` — sem Esquema de Dados
 * nao ha universo fechado de respostas e a decodificacao restrita perde sentido.
 */
export function buildVocabularies(
    model: MedicalModel,
    options: VocabularyOptions = {}
): VocabularyResult {
    const schemas = model.elements.filter(isDataSchemaDef);
    if (schemas.length === 0) {
        throw new Error('O modelo nao declara nenhum `esquema_dados` (Esquema de Dados ausente).');
    }
    const schema = options.schemaName
        ? schemas.find(s => s.name === options.schemaName)
        : schemas[0];
    if (!schema) {
        throw new Error(`Esquema de dados \`${options.schemaName}\` nao encontrado no modelo.`);
    }

    const allDrugs = model.elements.filter(isDrugDef);
    const drugs = options.allowedDrugs?.length
        ? allDrugs.filter(d => options.allowedDrugs!.includes(d.name))
        : allDrugs;
    const effectiveDrugs = drugs.length > 0 ? drugs : allDrugs;

    const protocols = model.elements.filter(isProtocolDef).map(p => p.name);
    // Planos ja existentes no modelo servem de exemplar few-shot, nao de vocabulario.
    void model.elements.filter(isPlanCommand);

    const vocabularies: Vocabularies = new Map([
        ['farmaco', effectiveDrugs.map(d => d.name)],
        ['protocolo', protocols],
        ['esquema', [schema.name]],
        ['conduta', schema.conducts.map(c => c.name)],
        ['decisao', intersect(schema.decisions, options.allowedDecisions)],
        ['via', intersect(schema.routes, options.allowedRoutes)],
        ['nivel_alerta', [...schema.alerts]],
        ['unidade', doseUnitsOf(effectiveDrugs)]
    ]);

    return { vocabularies, schema, drugs: effectiveDrugs };
}
