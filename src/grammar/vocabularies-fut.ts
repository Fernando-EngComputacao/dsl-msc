/**
 * Extracao dos vocabularios de instancia a partir do modelo de arbitragem de
 * futebol validado.
 *
 * Espelha src/grammar/vocabularies.ts (clinico) e src/grammar/vocabularies-agro.ts
 * (agricola) no dominio da arbitragem: os nomes que o modelo declara viram as
 * unicas alternativas possiveis nos terminais da gramatica de saida. Uma
 * infracao sem registro no modelo e inexprimivel.
 */

import {
    isFutSchemaDef,
    isInfractionDef,
    isLimiarAttr,
    isMonitorAttr,
    isSituationDef,
    isDecisionCommand,
    type FutSchemaDef,
    type InfractionDef,
    type FutModel,
    type Quantity
} from '../generated/ast.js';
import type { Vocabularies } from './extract-bnf.js';

export interface FutVocabularyOptions {
    /** Restringe a saida a um `esquema_dados` especifico. Por omissao, usa o primeiro. */
    schemaName?: string;
    /**
     * Restringe as infracoes citaveis (subgrafo recuperado do Grafo de Conhecimento).
     * Sem restricao, todas as infracoes do modelo entram na gramatica.
     */
    allowedInfractions?: string[];
    /** Restringe as decisoes admissiveis (poda vinda das regras do grafo). */
    allowedDecisions?: string[];
    /** Restringe os reinicios de jogo admissiveis. */
    allowedRestarts?: string[];
}

export interface FutVocabularyResult {
    vocabularies: Vocabularies;
    schema: FutSchemaDef;
    infractions: InfractionDef[];
}

/** Unidades efetivamente usadas nos limiares e monitoramentos das infracoes citaveis. */
function timeUnitsOf(infractions: InfractionDef[]): string[] {
    const units = new Set<string>();
    const add = (q: Quantity | undefined) => {
        if (q) units.add(q.unit);
    };
    for (const infraction of infractions) {
        for (const attr of infraction.attributes) {
            if (isLimiarAttr(attr)) add(attr.threshold);
            else if (isMonitorAttr(attr)) add(attr.interval);
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
 * Constroi os vocabularios da gramatica de saida a partir do modelo de arbitragem.
 * Lanca se o modelo nao declarar nenhum `esquema_dados` — sem Esquema de Dados
 * nao ha universo fechado de respostas e a decodificacao restrita perde sentido.
 */
export function buildFutVocabularies(
    model: FutModel,
    options: FutVocabularyOptions = {}
): FutVocabularyResult {
    const schemas = model.elements.filter(isFutSchemaDef);
    if (schemas.length === 0) {
        throw new Error('O modelo nao declara nenhum `esquema_dados` (Esquema de Dados ausente).');
    }
    const schema = options.schemaName
        ? schemas.find(s => s.name === options.schemaName)
        : schemas[0];
    if (!schema) {
        throw new Error(`Esquema de dados \`${options.schemaName}\` nao encontrado no modelo.`);
    }

    const allInfractions = model.elements.filter(isInfractionDef);
    const infractions = options.allowedInfractions?.length
        ? allInfractions.filter(i => options.allowedInfractions!.includes(i.name))
        : allInfractions;
    const effectiveInfractions = infractions.length > 0 ? infractions : allInfractions;

    const situations = model.elements.filter(isSituationDef).map(s => s.name);
    // Decisoes arbitrais ja existentes no modelo servem de exemplar few-shot, nao de vocabulario.
    void model.elements.filter(isDecisionCommand);

    const vocabularies: Vocabularies = new Map([
        ['infracao', effectiveInfractions.map(i => i.name)],
        ['lance', situations],
        ['esquema', [schema.name]],
        ['conduta', schema.conducts.map(c => c.name)],
        ['decisao', intersect(schema.decisions, options.allowedDecisions)],
        ['reinicio', intersect(schema.restarts, options.allowedRestarts)],
        ['nivel_alerta', [...schema.alerts]],
        ['unidade', timeUnitsOf(effectiveInfractions)]
    ]);

    return { vocabularies, schema, infractions: effectiveInfractions };
}
