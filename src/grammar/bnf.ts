/**
 * Representacao BNF (Backus-Naur Form) usada pelo motor de Grammar Prompting.
 *
 * A arquitetura CML exige que o *Esquema de Controle* (a gramatica da DSL) seja
 * exposto ao LLM em uma metalinguagem que ele reconhece. Wang et al. (2023,
 * "Grammar Prompting for Domain-Specific Language Generation with Large Language
 * Models") mostram que BNF e a escolha certa: LLMs raramente viram strings da DSL
 * durante o pre-treino, mas viram muitas *metalinguagens*.
 *
 * Este modulo define G (a gramatica completa), a serializacao no formato do artigo
 * e as operacoes de suporte (nullable, custo minimo de completude) consumidas pelo
 * parser Earley e pela decodificacao restrita.
 */

/** Um simbolo do lado direito de uma producao. */
export interface BnfSymbol {
    /** Chave unica: nome do nao-terminal, ou chave do terminal (`kw:cultura`, `ID`). */
    name: string;
    terminal: boolean;
}

/** Uma producao `lhs ::= rhs`. Alternativas sao producoes distintas com o mesmo lhs. */
export interface BnfProduction {
    id: number;
    lhs: string;
    rhs: BnfSymbol[];
    /** Regra da DSL que originou esta producao (rastreabilidade DSL -> BNF). */
    origin?: string;
}

export type BnfTerminalKind = 'keyword' | 'regex';

export interface BnfTerminal {
    /** Chave unica do terminal. */
    name: string;
    kind: BnfTerminalKind;
    /** Literal exato, para terminais do tipo keyword. */
    literal?: string;
    /** Padrao lexico, para terminais do tipo regex. */
    pattern?: RegExp;
    /** Terminais ocultos (espacos, comentarios) sao descartados na tokenizacao. */
    hidden?: boolean;
    /** Nome legivel exibido na serializacao BNF (ex.: `ID`). */
    display: string;
}

export interface SerializeOptions {
    /** Restringe a serializacao a um subconjunto de producoes (gramatica especializada). */
    productionIds?: Set<number>;
    /** Inclui a secao de terminais lexicos ao final. */
    includeTerminals?: boolean;
    /** Alinha os `::=` em coluna fixa. */
    align?: boolean;
}

export class BnfGrammar {
    readonly start: string;
    readonly productions: BnfProduction[];
    readonly terminals: Map<string, BnfTerminal>;

    private readonly byLhs = new Map<string, BnfProduction[]>();
    private readonly byId = new Map<number, BnfProduction>();
    private nullableCache?: Set<string>;
    private minCostCache?: Map<string, number>;

    constructor(start: string, productions: BnfProduction[], terminals: Map<string, BnfTerminal>) {
        this.start = start;
        this.productions = productions;
        this.terminals = terminals;
        for (const p of productions) {
            this.byId.set(p.id, p);
            let bucket = this.byLhs.get(p.lhs);
            if (!bucket) {
                bucket = [];
                this.byLhs.set(p.lhs, bucket);
            }
            bucket.push(p);
        }
    }

    productionsFor(lhs: string): BnfProduction[] {
        return this.byLhs.get(lhs) ?? [];
    }

    production(id: number): BnfProduction | undefined {
        return this.byId.get(id);
    }

    isNonTerminal(name: string): boolean {
        return this.byLhs.has(name);
    }

    terminal(name: string): BnfTerminal | undefined {
        return this.terminals.get(name);
    }

    /** Terminais visiveis (nao ocultos), usados pela tokenizacao e por Sigma[y_prefix]. */
    visibleTerminals(): BnfTerminal[] {
        return [...this.terminals.values()].filter(t => !t.hidden);
    }

    /**
     * Conjunto de nao-terminais anulaveis. Necessario para a correcao do parser
     * Earley na presenca de cardinalidades `?` e `*` (Aycock & Horspool, 2002).
     */
    nullable(): Set<string> {
        if (this.nullableCache) return this.nullableCache;
        const nullable = new Set<string>();
        let changed = true;
        while (changed) {
            changed = false;
            for (const p of this.productions) {
                if (nullable.has(p.lhs)) continue;
                if (p.rhs.every(s => !s.terminal && nullable.has(s.name))) {
                    nullable.add(p.lhs);
                    changed = true;
                }
            }
        }
        this.nullableCache = nullable;
        return nullable;
    }

    /**
     * Custo minimo (em tokens) para derivar uma string terminal a partir de cada
     * nao-terminal. Base do reparo deterministico: a partir de qualquer estado do
     * parser sempre existe um caminho finito e conhecido ate um programa completo.
     */
    minTerminalCost(): Map<string, number> {
        if (this.minCostCache) return this.minCostCache;
        const cost = new Map<string, number>();
        for (const lhs of this.byLhs.keys()) cost.set(lhs, Number.POSITIVE_INFINITY);
        let changed = true;
        while (changed) {
            changed = false;
            for (const p of this.productions) {
                let total = 0;
                for (const s of p.rhs) {
                    total += s.terminal ? 1 : (cost.get(s.name) ?? Number.POSITIVE_INFINITY);
                    if (!Number.isFinite(total)) break;
                }
                if (total < (cost.get(p.lhs) ?? Number.POSITIVE_INFINITY)) {
                    cost.set(p.lhs, total);
                    changed = true;
                }
            }
        }
        this.minCostCache = cost;
        return cost;
    }

    /** Custo minimo do sufixo `rhs[dot..]` de uma producao. */
    suffixCost(production: BnfProduction, dot: number): number {
        const cost = this.minTerminalCost();
        let total = 0;
        for (let i = dot; i < production.rhs.length; i++) {
            const s = production.rhs[i];
            total += s.terminal ? 1 : (cost.get(s.name) ?? Number.POSITIVE_INFINITY);
            if (!Number.isFinite(total)) return Number.POSITIVE_INFINITY;
        }
        return total;
    }

    /** Forma exibida de um simbolo na serializacao BNF. */
    displaySymbol(symbol: BnfSymbol): string {
        if (!symbol.terminal) return symbol.name;
        const t = this.terminals.get(symbol.name);
        if (!t) return symbol.name;
        return t.kind === 'keyword' ? JSON.stringify(t.literal) : t.display;
    }

    /**
     * Serializa a gramatica no formato BNF estendido do artigo:
     *
     *     <simbolo> ::= <expr1> | <expr2> | ...
     */
    serialize(options: SerializeOptions = {}): string {
        const { productionIds, includeTerminals = true, align = true } = options;
        const selected = productionIds
            ? this.productions.filter(p => productionIds.has(p.id))
            : this.productions;

        const order: string[] = [];
        const grouped = new Map<string, BnfProduction[]>();
        for (const p of selected) {
            let bucket = grouped.get(p.lhs);
            if (!bucket) {
                bucket = [];
                grouped.set(p.lhs, bucket);
                order.push(p.lhs);
            }
            bucket.push(p);
        }
        // O simbolo inicial sempre encabeca a gramatica.
        order.sort((a, b) => (a === this.start ? -1 : b === this.start ? 1 : 0));

        const width = align ? Math.max(0, ...order.map(n => n.length)) : 0;
        const lines: string[] = [];
        for (const lhs of order) {
            const alts = grouped.get(lhs)!.map(p =>
                p.rhs.length === 0 ? 'ε' : p.rhs.map(s => this.displaySymbol(s)).join(' ')
            );
            const head = align ? lhs.padEnd(width) : lhs;
            const indent = ' '.repeat(head.length + 5);
            lines.push(`${head} ::= ${alts.join(`\n${indent}| `)}`);
        }

        if (includeTerminals) {
            const used = new Set<string>();
            for (const p of selected) {
                for (const s of p.rhs) {
                    if (s.terminal) used.add(s.name);
                }
            }
            const regexTerminals = [...used]
                .map(n => this.terminals.get(n)!)
                .filter(t => t && t.kind === 'regex');
            if (regexTerminals.length > 0) {
                lines.push('');
                const tw = align ? Math.max(...regexTerminals.map(t => t.display.length)) : 0;
                for (const t of regexTerminals) {
                    lines.push(`${t.display.padEnd(tw)} ::= ${t.pattern}`);
                }
            }
        }

        return lines.join('\n');
    }

    /** Metricas usadas nos relatorios de validacao da dissertacao. */
    stats(): { nonTerminals: number; productions: number; keywords: number; regexTerminals: number } {
        const terms = [...this.terminals.values()].filter(t => !t.hidden);
        return {
            nonTerminals: this.byLhs.size,
            productions: this.productions.length,
            keywords: terms.filter(t => t.kind === 'keyword').length,
            regexTerminals: terms.filter(t => t.kind === 'regex').length
        };
    }
}
