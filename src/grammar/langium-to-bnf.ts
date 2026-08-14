/**
 * Extrator BNF: converte a gramatica Langium *local* (`src/language/agrodrone.langium`,
 * carregada a partir da AST gerada) na gramatica BNF G consumida pelo Grammar Prompting.
 *
 * Este e o elo "DSL -> Esquema de Controle / Esquema de Dados" da Figura 5.1: nada e
 * escrito a mao. Se o agronomo alterar a DSL, o BNF, o parser Earley e as restricoes de
 * decodificacao mudam junto, preservando o Fechamento Semantico Mutuo.
 *
 * Conversao EBNF -> BNF:
 *   Alternatives  -> multiplas producoes com o mesmo lhs
 *   Group         -> concatenacao
 *   Assignment    -> transparente (nao afeta a sintaxe concreta)
 *   Keyword       -> terminal literal
 *   RuleCall      -> nao-terminal (ParserRule) ou terminal (TerminalRule)
 *   CrossReference-> o terminal usado na referencia (tipicamente ID)
 *   `?`           -> X ::= inner | ε
 *   `*`           -> X ::= inner X | ε
 *   `+`           -> X ::= inner X | inner
 */

import { GrammarAST, terminalRegex, type Grammar } from 'langium';
import { BnfGrammar, type BnfProduction, type BnfSymbol, type BnfTerminal } from './bnf.js';

/** Chave interna de um terminal do tipo keyword. */
export function keywordKey(literal: string): string {
    return `kw:${literal}`;
}

class BnfBuilder {
    private readonly productions: BnfProduction[] = [];
    private readonly terminals = new Map<string, BnfTerminal>();
    private nextId = 0;
    private readonly helperCounters = new Map<string, number>();

    constructor(private readonly grammar: Grammar) {}

    build(): BnfGrammar {
        // 1) Terminais lexicos declarados na DSL.
        for (const rule of this.grammar.rules) {
            if (GrammarAST.isTerminalRule(rule)) {
                this.registerRegexTerminal(rule);
            }
        }

        // 2) Regras de parser (incluindo data type rules como DroneState/Operator).
        const entry = this.grammar.rules.find(r => GrammarAST.isParserRule(r) && r.entry) as
            | GrammarAST.ParserRule
            | undefined;
        if (!entry) {
            throw new Error('A gramatica Langium nao declara uma regra `entry`.');
        }

        for (const rule of this.grammar.rules) {
            if (!GrammarAST.isParserRule(rule)) continue;
            if (rule.fragment) continue;
            this.convertParserRule(rule);
        }

        return new BnfGrammar(entry.name, this.productions, this.terminals);
    }

    // ---------------------------------------------------------------- terminais

    private registerRegexTerminal(rule: GrammarAST.TerminalRule): void {
        let pattern: RegExp;
        try {
            pattern = terminalRegex(rule);
        } catch {
            return;
        }
        this.terminals.set(rule.name, {
            name: rule.name,
            kind: 'regex',
            pattern,
            hidden: rule.hidden === true,
            display: rule.name
        });
    }

    private registerKeyword(literal: string): BnfSymbol {
        const key = keywordKey(literal);
        if (!this.terminals.has(key)) {
            this.terminals.set(key, {
                name: key,
                kind: 'keyword',
                literal,
                display: JSON.stringify(literal)
            });
        }
        return { name: key, terminal: true };
    }

    // ---------------------------------------------------------------- producoes

    private addProduction(lhs: string, rhs: BnfSymbol[], origin?: string): void {
        this.productions.push({ id: this.nextId++, lhs, rhs, origin });
    }

    private helperName(base: string, suffix: string): string {
        const key = `${base}_${suffix}`;
        const n = (this.helperCounters.get(key) ?? 0) + 1;
        this.helperCounters.set(key, n);
        return `${base}_${suffix}${n}`;
    }

    private convertParserRule(rule: GrammarAST.ParserRule): void {
        const alternatives = this.expand(rule.definition, rule.name);
        for (const alt of alternatives) {
            this.addProduction(rule.name, alt, rule.name);
        }
    }

    /**
     * Expande um elemento da gramatica em uma lista de sequencias alternativas.
     * A explosao combinatoria e contida introduzindo nao-terminais auxiliares para
     * grupos com cardinalidade e para alternativas aninhadas de mais de um simbolo.
     */
    private expand(element: GrammarAST.AbstractElement, base: string): BnfSymbol[][] {
        const cardinality = element.cardinality;
        if (cardinality) {
            const inner = this.expandCore({ ...element, cardinality: undefined } as GrammarAST.AbstractElement, base);
            return [[this.wrapCardinality(inner, cardinality, base)]];
        }
        return this.expandCore(element, base);
    }

    private wrapCardinality(
        alternatives: BnfSymbol[][],
        cardinality: '?' | '*' | '+',
        base: string
    ): BnfSymbol {
        const suffix = cardinality === '?' ? 'opt' : cardinality === '*' ? 'star' : 'plus';
        const name = this.helperName(base, suffix);
        for (const alt of alternatives) {
            switch (cardinality) {
                case '?':
                    this.addProduction(name, alt, base);
                    break;
                case '*':
                    this.addProduction(name, [...alt, { name, terminal: false }], base);
                    break;
                case '+':
                    this.addProduction(name, [...alt, { name, terminal: false }], base);
                    this.addProduction(name, alt, base);
                    break;
            }
        }
        if (cardinality === '?' || cardinality === '*') {
            this.addProduction(name, [], base); // ε
        }
        return { name, terminal: false };
    }

    private expandCore(element: GrammarAST.AbstractElement, base: string): BnfSymbol[][] {
        if (GrammarAST.isAlternatives(element)) {
            const alts: BnfSymbol[][] = [];
            for (const child of element.elements) {
                alts.push(...this.expand(child, base));
            }
            return alts;
        }

        if (GrammarAST.isGroup(element) || GrammarAST.isUnorderedGroup(element)) {
            // UnorderedGroup e aproximado por uma sequencia ordenada: a DSL AgroDrone
            // nao usa `&`, e a aproximacao mantem o reconhecedor conservador.
            let sequences: BnfSymbol[][] = [[]];
            for (const child of element.elements) {
                const childAlts = this.expand(child, base);
                if (childAlts.length === 1) {
                    sequences = sequences.map(seq => [...seq, ...childAlts[0]]);
                } else {
                    // Alternativa aninhada dentro de uma sequencia: extrai um auxiliar
                    // para evitar explosao combinatoria do produto cartesiano.
                    const helper = this.helperName(base, 'alt');
                    for (const alt of childAlts) {
                        this.addProduction(helper, alt, base);
                    }
                    sequences = sequences.map(seq => [...seq, { name: helper, terminal: false }]);
                }
            }
            return sequences;
        }

        if (GrammarAST.isAssignment(element)) {
            // A atribuicao nao altera a sintaxe concreta, apenas a AST.
            return this.expand(element.terminal, base);
        }

        if (GrammarAST.isKeyword(element)) {
            return [[this.registerKeyword(element.value)]];
        }

        if (GrammarAST.isCrossReference(element)) {
            // `[Regra:ID]` consome o terminal da referencia (ID por omissao).
            if (element.terminal) {
                return this.expand(element.terminal, base);
            }
            return [[{ name: 'ID', terminal: true }]];
        }

        if (GrammarAST.isRuleCall(element)) {
            const ref = element.rule.ref;
            if (!ref) {
                throw new Error(`Referencia de regra nao resolvida em ${base}.`);
            }
            if (GrammarAST.isTerminalRule(ref)) {
                return [[{ name: ref.name, terminal: true }]];
            }
            return [[{ name: ref.name, terminal: false }]];
        }

        if (GrammarAST.isAction(element)) {
            return [[]]; // acoes nao consomem tokens
        }

        // Elementos nao suportados (ex.: EndOfFile) sao tratados como vazios.
        return [[]];
    }
}

/** Converte a gramatica Langium carregada em BNF. */
export function grammarToBnf(grammar: Grammar): BnfGrammar {
    return new BnfBuilder(grammar).build();
}
