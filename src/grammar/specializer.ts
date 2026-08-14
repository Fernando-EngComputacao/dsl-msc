/**
 * Gramatica especializada minimal G[y] (Wang et al., 2023, secao 3.1).
 *
 * Definicao do artigo: G[y] e uma gramatica BNF tal que (1) y ∈ L(G[y]) e (2) para
 * toda regra r ∈ G[y], y ∉ L(G[y] \ {r}) — ou seja, o subconjunto minimo de regras de
 * G efetivamente usado na derivacao de y. Obtem-se G[y] parseando y com G e tomando
 * a uniao das producoes aplicadas.
 *
 * No pipeline SPC-CML, G[y] cumpre dois papeis:
 *   - constroi os exemplares few-shot (x, G[y], y) do prompt de Grammar Prompting;
 *   - serve de gramatica prevista Ĝ quando se quer confinar ainda mais o espaco de
 *     geracao a um recorte da DSL relevante ao contexto recuperado do grafo.
 */

import type { BnfGrammar } from './bnf.js';
import type { EarleyParser } from './earley.js';

export interface SpecializedGrammar {
    /** Ids das producoes de G efetivamente usadas. */
    productionIds: Set<number>;
    /** Serializacao BNF do recorte, no formato do artigo. */
    bnf: string;
    /** Programa que originou a especializacao. */
    program: string;
}

/**
 * Deriva G[y] para um programa `y` valido na DSL.
 * Retorna `undefined` quando `y ∉ L(G)` — condicao verificada por Earley.
 */
export function specialize(
    grammar: BnfGrammar,
    parser: EarleyParser,
    program: string
): SpecializedGrammar | undefined {
    const derivation = parser.derive(program);
    if (!derivation) return undefined;
    return {
        productionIds: derivation.productionIds,
        bnf: grammar.serialize({ productionIds: derivation.productionIds, includeTerminals: true }),
        program
    };
}

/**
 * Uniao de gramaticas especializadas: util para montar uma gramatica prevista Ĝ ⊆ G
 * a partir de varios exemplares, ou para restringir a decodificacao ao subconjunto da
 * DSL exercitado pelas regras recuperadas do Grafo de Conhecimento.
 */
export function unionOf(
    grammar: BnfGrammar,
    specializations: SpecializedGrammar[]
): { productionIds: Set<number>; bnf: string } {
    const productionIds = new Set<number>();
    for (const s of specializations) {
        for (const id of s.productionIds) productionIds.add(id);
    }
    return {
        productionIds,
        bnf: grammar.serialize({ productionIds, includeTerminals: true })
    };
}

/**
 * Verifica a propriedade (2) da definicao: nenhuma regra de G[y] e dispensavel.
 * Usado nos testes de validacao da dissertacao para atestar a minimalidade.
 */
export function isMinimal(
    grammar: BnfGrammar,
    parser: EarleyParser,
    specialized: SpecializedGrammar
): boolean {
    const { BnfGrammar: Ctor } = grammar.constructor as unknown as { BnfGrammar: unknown };
    void Ctor;
    for (const id of specialized.productionIds) {
        const reduced = new Set(specialized.productionIds);
        reduced.delete(id);
        const sub = subGrammar(grammar, reduced);
        const subParser = new (parser.constructor as new (g: BnfGrammar) => EarleyParser)(sub);
        if (subParser.accepts(specialized.program)) return false;
    }
    return true;
}

/** Projeta G sobre um subconjunto de producoes, preservando terminais e simbolo inicial. */
export function subGrammar(grammar: BnfGrammar, productionIds: Set<number>): BnfGrammar {
    const productions = grammar.productions.filter(p => productionIds.has(p.id));
    const Ctor = grammar.constructor as new (
        start: string,
        productions: typeof productions,
        terminals: typeof grammar.terminals
    ) => BnfGrammar;
    return new Ctor(grammar.start, productions, grammar.terminals);
}
