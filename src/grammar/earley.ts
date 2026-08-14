/**
 * Tokenizador + reconhecedor de Earley sobre a gramatica BNF derivada da DSL.
 *
 * E a peca que torna a decodificacao restrita possivel (Wang et al., 2023, secao 3.2):
 *   - `analyze(texto)` diz se `y ∈ L(G)`;
 *   - em caso negativo, devolve o **maior prefixo valido** `y_prefix` e o conjunto de
 *     terminais admissiveis `Sigma[y_prefix]` — exatamente as duas quantidades das
 *     linhas 8-9 do Algoritmo 1 do artigo;
 *   - `derive()` reconstroi a arvore de derivacao, base da gramatica especializada G[y].
 *
 * O reconhecedor implementa a correcao de Aycock & Horspool (2002) para regras
 * anulaveis, indispensavel porque a conversao EBNF->BNF introduz auxiliares `ε`.
 */

import type { BnfGrammar, BnfProduction } from './bnf.js';

export interface Token {
    /** Chave do terminal (`kw:cultura`, `ID`, ...). */
    type: string;
    image: string;
    start: number;
    end: number;
}

export interface LexResult {
    tokens: Token[];
    /** Offset em que a tokenizacao falhou, se houver caractere invalido. */
    errorOffset?: number;
}

export interface ParseAnalysis {
    /** `true` quando o texto completo pertence a L(G). */
    accepted: boolean;
    tokens: Token[];
    /** Numero de tokens do maior prefixo que ainda pode levar a um programa valido. */
    validPrefixLength: number;
    /** Texto correspondente ao maior prefixo valido (`y_prefix`). */
    validPrefix: string;
    /** Sigma[y_prefix]: terminais que podem seguir o prefixo valido. */
    expectedTerminals: string[];
    /** Mensagem diagnostica quando `accepted` e falso. */
    error?: string;
    /** Offset de caractere onde a analise parou. */
    errorOffset?: number;
}

interface EarleyItem {
    production: BnfProduction;
    dot: number;
    origin: number;
}

interface ItemSet {
    items: EarleyItem[];
    keys: Set<string>;
}

const itemKey = (prodId: number, dot: number, origin: number) => `${prodId}|${dot}|${origin}`;

export class EarleyParser {
    private readonly anchored = new Map<string, RegExp>();

    constructor(readonly grammar: BnfGrammar) {
        for (const t of grammar.terminals.values()) {
            if (t.kind === 'regex' && t.pattern) {
                const flags = t.pattern.flags.replace(/[gy]/g, '') + 'y';
                this.anchored.set(t.name, new RegExp(t.pattern.source, flags));
            }
        }
    }

    // ------------------------------------------------------------------- lexer

    /**
     * Tokenizacao por "maior casamento": entre todos os terminais candidatos vence o
     * de maior comprimento; em caso de empate, a palavra-chave prevalece sobre o
     * terminal regex (mesma disciplina do lexer gerado pelo Langium/Chevrotain).
     */
    tokenize(input: string): LexResult {
        const tokens: Token[] = [];
        let offset = 0;

        while (offset < input.length) {
            let bestLength = 0;
            let bestType: string | undefined;
            let bestIsKeyword = false;
            let bestHidden = false;

            for (const terminal of this.grammar.terminals.values()) {
                let length = 0;
                if (terminal.kind === 'keyword') {
                    const literal = terminal.literal!;
                    if (input.startsWith(literal, offset)) length = literal.length;
                } else {
                    const re = this.anchored.get(terminal.name);
                    if (!re) continue;
                    re.lastIndex = offset;
                    const m = re.exec(input);
                    if (m && m[0].length > 0) length = m[0].length;
                }
                if (length === 0) continue;

                const isKeyword = terminal.kind === 'keyword';
                const better =
                    length > bestLength || (length === bestLength && isKeyword && !bestIsKeyword);
                if (better) {
                    bestLength = length;
                    bestType = terminal.name;
                    bestIsKeyword = isKeyword;
                    bestHidden = terminal.hidden === true;
                }
            }

            if (!bestType) {
                return { tokens, errorOffset: offset };
            }
            if (!bestHidden) {
                tokens.push({
                    type: bestType,
                    image: input.slice(offset, offset + bestLength),
                    start: offset,
                    end: offset + bestLength
                });
            }
            offset += bestLength;
        }

        return { tokens };
    }

    // ------------------------------------------------------------------ Earley

    /** Constroi a tabela de Earley, parando no primeiro token nao escaneavel. */
    private chartFor(tokens: Token[]): { chart: ItemSet[]; stoppedAt: number } {
        const nullable = this.grammar.nullable();
        const chart: ItemSet[] = [{ items: [], keys: new Set() }];

        const add = (set: ItemSet, item: EarleyItem): void => {
            const key = itemKey(item.production.id, item.dot, item.origin);
            if (set.keys.has(key)) return;
            set.keys.add(key);
            set.items.push(item);
        };

        for (const p of this.grammar.productionsFor(this.grammar.start)) {
            add(chart[0], { production: p, dot: 0, origin: 0 });
        }

        let position = 0;
        for (; position <= tokens.length; position++) {
            const set = chart[position];
            // O worklist cresce durante a iteracao (predicao/completude sao fechadas
            // por ponto fixo dentro do mesmo conjunto).
            for (let i = 0; i < set.items.length; i++) {
                const item = set.items[i];
                const next = item.production.rhs[item.dot];

                if (!next) {
                    // COMPLETER
                    const origin = chart[item.origin];
                    for (let j = 0; j < origin.items.length; j++) {
                        const parent = origin.items[j];
                        const sym = parent.production.rhs[parent.dot];
                        if (sym && !sym.terminal && sym.name === item.production.lhs) {
                            add(set, { production: parent.production, dot: parent.dot + 1, origin: parent.origin });
                        }
                    }
                    continue;
                }

                if (!next.terminal) {
                    // PREDICTOR
                    for (const p of this.grammar.productionsFor(next.name)) {
                        add(set, { production: p, dot: 0, origin: position });
                    }
                    // Correcao de Aycock & Horspool para nao-terminais anulaveis.
                    if (nullable.has(next.name)) {
                        add(set, { production: item.production, dot: item.dot + 1, origin: item.origin });
                    }
                }
            }

            if (position === tokens.length) break;

            // SCANNER
            const token = tokens[position];
            const nextSet: ItemSet = { items: [], keys: new Set() };
            for (const item of set.items) {
                const sym = item.production.rhs[item.dot];
                if (sym && sym.terminal && sym.name === token.type) {
                    add(nextSet, { production: item.production, dot: item.dot + 1, origin: item.origin });
                }
            }
            if (nextSet.items.length === 0) {
                return { chart, stoppedAt: position };
            }
            chart.push(nextSet);
        }

        return { chart, stoppedAt: tokens.length };
    }

    /** Terminais que podem ser escaneados a partir de um conjunto de itens. */
    private expectedAt(set: ItemSet): string[] {
        const expected = new Set<string>();
        for (const item of set.items) {
            const sym = item.production.rhs[item.dot];
            if (sym?.terminal) expected.add(sym.name);
        }
        return [...expected];
    }

    private isComplete(set: ItemSet): boolean {
        return set.items.some(
            item =>
                item.origin === 0 &&
                item.dot === item.production.rhs.length &&
                item.production.lhs === this.grammar.start
        );
    }

    /**
     * Analise completa de uma string candidata `y`.
     * Nao lanca excecoes: qualquer entrada — inclusive alucinacoes do LLM — produz um
     * diagnostico estruturado consumivel pelo laco de decodificacao restrita.
     */
    analyze(input: string): ParseAnalysis {
        const { tokens, errorOffset } = this.tokenize(input);
        const { chart, stoppedAt } = this.chartFor(tokens);

        const accepted =
            errorOffset === undefined &&
            stoppedAt === tokens.length &&
            this.isComplete(chart[tokens.length]);

        // O maior prefixo valido termina no ultimo token efetivamente escaneado.
        const validPrefixLength = Math.min(stoppedAt, tokens.length);
        const validPrefix =
            validPrefixLength === 0 ? '' : input.slice(0, tokens[validPrefixLength - 1].end);

        const set = chart[Math.min(validPrefixLength, chart.length - 1)];
        const expectedTerminals = this.expectedAt(set);

        let error: string | undefined;
        let errAt: number | undefined;
        if (!accepted) {
            if (errorOffset !== undefined && stoppedAt === tokens.length) {
                error = `Caractere lexicamente invalido no offset ${errorOffset}.`;
                errAt = errorOffset;
            } else if (stoppedAt < tokens.length) {
                const bad = tokens[stoppedAt];
                error = `Token inesperado \`${bad.image}\` no offset ${bad.start}.`;
                errAt = bad.start;
            } else {
                error = 'Entrada incompleta: a derivacao do simbolo inicial nao foi concluida.';
                errAt = input.length;
            }
        }

        return {
            accepted,
            tokens,
            validPrefixLength,
            validPrefix,
            expectedTerminals,
            error,
            errorOffset: errAt
        };
    }

    /** Atalho booleano: `y ∈ L(G)`. */
    accepts(input: string): boolean {
        return this.analyze(input).accepted;
    }

    // --------------------------------------------------------------- derivacao

    /**
     * Reconstroi uma arvore de derivacao para uma entrada aceita.
     * Devolve o conjunto de ids de producoes utilizadas — insumo direto para a
     * gramatica especializada minimal G[y] (Wang et al., secao 3.1).
     */
    derive(input: string): { productionIds: Set<number> } | undefined {
        const { tokens, errorOffset } = this.tokenize(input);
        if (errorOffset !== undefined) return undefined;
        const { chart, stoppedAt } = this.chartFor(tokens);
        if (stoppedAt < tokens.length || !this.isComplete(chart[tokens.length])) return undefined;

        // Indice (lhs, origem) -> posicoes finais das derivacoes completas.
        const completions = new Map<string, Map<number, Set<number>>>();
        for (let end = 0; end < chart.length; end++) {
            for (const item of chart[end].items) {
                if (item.dot !== item.production.rhs.length) continue;
                let byOrigin = completions.get(item.production.lhs);
                if (!byOrigin) {
                    byOrigin = new Map();
                    completions.set(item.production.lhs, byOrigin);
                }
                let ends = byOrigin.get(item.origin);
                if (!ends) {
                    ends = new Set();
                    byOrigin.set(item.origin, ends);
                }
                ends.add(end);
            }
        }

        const used = new Set<number>();
        const memo = new Map<string, boolean>();

        const deriveSymbol = (lhs: string, from: number, to: number): boolean => {
            const key = `${lhs}|${from}|${to}`;
            const cached = memo.get(key);
            if (cached !== undefined) return cached;
            memo.set(key, false); // corta recursao esquerda ciclica

            for (const production of this.grammar.productionsFor(lhs)) {
                const local = new Set<number>();
                if (matchRhs(production, 0, from, to, local)) {
                    used.add(production.id);
                    for (const id of local) used.add(id);
                    memo.set(key, true);
                    return true;
                }
            }
            return false;
        };

        const matchRhs = (
            production: BnfProduction,
            index: number,
            from: number,
            to: number,
            acc: Set<number>
        ): boolean => {
            if (index === production.rhs.length) return from === to;
            const sym = production.rhs[index];

            if (sym.terminal) {
                if (from >= to || tokens[from].type !== sym.name) return false;
                return matchRhs(production, index + 1, from + 1, to, acc);
            }

            const ends = completions.get(sym.name)?.get(from);
            if (!ends) return false;
            // Prefere a derivacao mais longa: acelera a convergencia em regras `*`.
            for (const mid of [...ends].sort((a, b) => b - a)) {
                if (mid > to) continue;
                if (!matchRhs(production, index + 1, mid, to, acc)) continue;
                const before = new Set(used);
                if (deriveSymbol(sym.name, from, mid)) {
                    for (const id of used) acc.add(id);
                    return true;
                }
                used.clear();
                for (const id of before) used.add(id);
            }
            return false;
        };

        if (!deriveSymbol(this.grammar.start, 0, tokens.length)) return undefined;
        return { productionIds: used };
    }

    // -------------------------------------------------- reparo deterministico

    /**
     * A partir do maior prefixo valido, devolve uma sequencia de terminais que conduz
     * o parser a um programa sintaticamente completo, escolhendo sempre o item de menor
     * custo residual. Garante que o laco de decodificacao restrita termine com
     * `y ∈ L(G)` mesmo que o LLM nunca produza uma continuacao aceitavel.
     */
    completionPath(prefixTokens: Token[], limit = 512): Token[] | undefined {
        const path: Token[] = [];
        let current = [...prefixTokens];

        for (let step = 0; step < limit; step++) {
            const { chart, stoppedAt } = this.chartFor(current);
            if (stoppedAt < current.length) return undefined;
            const set = chart[current.length];
            if (this.isComplete(set)) return path;

            // Escolhe o terminal que minimiza o custo residual da producao pendente.
            let best: { terminal: string; cost: number } | undefined;
            for (const item of set.items) {
                const sym = item.production.rhs[item.dot];
                if (!sym?.terminal) continue;
                const cost = this.grammar.suffixCost(item.production, item.dot);
                if (!best || cost < best.cost) best = { terminal: sym.name, cost };
            }
            if (!best) return undefined;

            const token = this.sampleToken(best.terminal);
            if (!token) return undefined;
            path.push(token);
            current = [...current, token];
        }
        return undefined;
    }

    /** Constroi um token concreto para um terminal (literal ou instancia do regex). */
    sampleToken(terminalName: string): Token | undefined {
        const t = this.grammar.terminal(terminalName);
        if (!t) return undefined;
        const image =
            t.kind === 'keyword'
                ? t.literal!
                : terminalName === 'STRING'
                  ? '"gerado_sob_restricao"'
                  : terminalName === 'FLOAT'
                    ? '0'
                    : 'Auto_' + terminalName;
        return { type: terminalName, image, start: -1, end: -1 };
    }

    /** Representacao legivel de Sigma[y_prefix] para o prompt de reparo. */
    describeTerminals(names: string[]): string[] {
        return names.map(name => {
            const t = this.grammar.terminal(name);
            if (!t) return name;
            return t.kind === 'keyword' ? t.literal! : `<${t.display}: ${t.pattern}>`;
        });
    }
}
