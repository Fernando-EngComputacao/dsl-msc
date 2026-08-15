/**
 * Reconhecedor de Earley sem scanner sobre a BNF gerada (`advanced_icu.bnf`).
 *
 * POR QUE ESTE MODULO EXISTE
 * --------------------------
 * O motor Python garante validade sintatica por mascaramento de logits, mas isso
 * so e possivel com modelo local (Outlines/llama.cpp). Nenhum provedor de API
 * (Claude, GPT, Gemini) expoe a mascara de logits, e a arquitetura CML e explicita
 * em ser agnostica de provedor. Para esse caminho vale a estrategia do Algoritmo 1
 * de Wang et al. (2023, sec. 3.2): decodificar livremente, PARSEAR, e em caso de
 * falha extrair o maior prefixo valido `y_prefix` e o conjunto de terminais
 * admissiveis `Sigma[y_prefix]` para corrigir a continuacao.
 *
 * O reconhecedor opera sobre CARACTERES, nao sobre tokens de um lexer previo.
 * Essa escolha e deliberada: um lexer separado decidiria, por exemplo, que
 * "Noradrenalina" e uma palavra reservada antes de o parser dizer se ali cabia um
 * identificador livre, e a analise de prefixo herdaria esse erro. Sem scanner, a
 * unica autoridade sobre o que e admissivel em cada ponto e a gramatica.
 *
 * Regras anulaveis (introduzidas pela expansao de `*` e `?`) sao tratadas pela
 * correcao de Aycock & Horspool (2002).
 */
import * as fs from 'node:fs';
/** Instancias usadas pelo reparo deterministico ao materializar um terminal regex. */
const TERMINAL_SAMPLES = {
    identificador: 'Plano_Gerado',
    texto: "'gerado sob restricao gramatical'",
    numero: '0.0'
};
export class Grammar {
    constructor(start, productions, terminals) {
        this.byLhs = new Map();
        this.start = start;
        this.productions = productions;
        this.terminals = terminals;
        for (const p of productions) {
            const bucket = this.byLhs.get(p.lhs);
            if (bucket)
                bucket.push(p);
            else
                this.byLhs.set(p.lhs, [p]);
        }
    }
    productionsFor(lhs) {
        return this.byLhs.get(lhs) ?? [];
    }
    /** Nao-terminais que derivam a cadeia vazia. */
    nullable() {
        if (this.nullableSet)
            return this.nullableSet;
        const nullable = new Set();
        let changed = true;
        while (changed) {
            changed = false;
            for (const p of this.productions) {
                if (nullable.has(p.lhs))
                    continue;
                if (p.rhs.every(s => s.kind === 'nonterminal' && nullable.has(s.value))) {
                    nullable.add(p.lhs);
                    changed = true;
                }
            }
        }
        this.nullableSet = nullable;
        return nullable;
    }
    /** Custo minimo, em terminais, para fechar cada nao-terminal. */
    minCost() {
        if (this.costMap)
            return this.costMap;
        const cost = new Map();
        for (const lhs of this.byLhs.keys())
            cost.set(lhs, Number.POSITIVE_INFINITY);
        let changed = true;
        while (changed) {
            changed = false;
            for (const p of this.productions) {
                let total = 0;
                for (const s of p.rhs) {
                    total +=
                        s.kind === 'nonterminal'
                            ? (cost.get(s.value) ?? Number.POSITIVE_INFINITY)
                            : 1;
                    if (!Number.isFinite(total))
                        break;
                }
                if (total < (cost.get(p.lhs) ?? Number.POSITIVE_INFINITY)) {
                    cost.set(p.lhs, total);
                    changed = true;
                }
            }
        }
        this.costMap = cost;
        return cost;
    }
    suffixCost(production, dot) {
        const cost = this.minCost();
        let total = 0;
        for (let i = dot; i < production.rhs.length; i++) {
            const s = production.rhs[i];
            total += s.kind === 'nonterminal' ? (cost.get(s.value) ?? Infinity) : 1;
            if (!Number.isFinite(total))
                return Number.POSITIVE_INFINITY;
        }
        return total;
    }
    /** Texto concreto de um terminal, para o reparo deterministico. */
    sampleOf(symbol) {
        if (symbol.kind === 'literal')
            return symbol.value;
        return TERMINAL_SAMPLES[symbol.value] ?? symbol.value.toUpperCase();
    }
    describe(symbol) {
        if (symbol.kind === 'literal')
            return JSON.stringify(symbol.value);
        const t = this.terminals.get(symbol.value);
        return t ? `<${symbol.value}: ${t.pattern.source}>` : symbol.value;
    }
}
// --------------------------------------------------------------------------
// Leitura da BNF (mesmo dialeto de python_engine/bnf.py)
// --------------------------------------------------------------------------
const SYMBOL_RE = /"[^"]*"|\/(?:[^/\\]|\\.)*\/|[A-Za-z_][A-Za-z_0-9]*[*+?]?/g;
/**
 * Le a BNF e expande as cardinalidades para BNF pura:
 *   `x*` -> X ::= x X | ε        `x+` -> X ::= x X | x        `x?` -> X ::= x | ε
 */
export function loadBnf(bnfPath, start = 'plano') {
    return parseBnf(fs.readFileSync(bnfPath, 'utf-8'), start);
}
/** Mesma leitura, a partir de texto — usada com a Ĝ gerada em memoria. */
export function parseBnf(text, start = 'plano') {
    const productions = [];
    const terminals = new Map();
    let nextId = 0;
    const helpers = new Map();
    const emit = (lhs, rhs) => productions.push({ id: nextId++, lhs, rhs });
    const symbolFor = (raw) => {
        if (raw.startsWith('"'))
            return { kind: 'literal', value: JSON.parse(raw) };
        const cardinality = /[*+?]$/.test(raw) ? raw.slice(-1) : '';
        const base = cardinality ? raw.slice(0, -1) : raw;
        if (!cardinality)
            return { kind: 'nonterminal', value: base };
        const helperName = `${base}__${cardinality === '*' ? 'star' : cardinality === '+' ? 'plus' : 'opt'}`;
        if (!helpers.has(helperName)) {
            helpers.set(helperName, base);
            const inner = { kind: 'nonterminal', value: base };
            const self = { kind: 'nonterminal', value: helperName };
            if (cardinality === '*') {
                emit(helperName, [inner, self]);
                emit(helperName, []);
            }
            else if (cardinality === '+') {
                emit(helperName, [inner, self]);
                emit(helperName, [inner]);
            }
            else {
                emit(helperName, [inner]);
                emit(helperName, []);
            }
        }
        return { kind: 'nonterminal', value: helperName };
    };
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.split('#')[0].trim();
        if (!line || !line.includes('::='))
            continue;
        const [head, body] = line.split('::=');
        const name = head.trim();
        const rhs = body.trim();
        // Folha lexica: `nome ::= /regex/`
        if (rhs.startsWith('/') && rhs.endsWith('/') && !rhs.slice(1, -1).includes('|')) {
            terminals.set(name, { name, pattern: new RegExp(rhs.slice(1, -1)) });
            continue;
        }
        for (const alt of rhs.split('|')) {
            const symbols = (alt.trim().match(SYMBOL_RE) ?? []).map(symbolFor);
            emit(name, symbols);
        }
    }
    // Um simbolo so e terminal regex se houver uma folha lexica com esse nome.
    for (const p of productions) {
        for (const s of p.rhs) {
            if (s.kind === 'nonterminal' && terminals.has(s.value))
                s.kind = 'terminal';
        }
    }
    return new Grammar(start, productions, terminals);
}
export class EarleyRecognizer {
    constructor(grammar) {
        this.grammar = grammar;
        this.anchored = new Map();
        for (const t of grammar.terminals.values()) {
            this.anchored.set(t.name, new RegExp(t.pattern.source, 'y'));
        }
    }
    skipWhitespace(input, offset) {
        let i = offset;
        while (i < input.length && /\s/.test(input[i]))
            i++;
        return i;
    }
    /** Casa um terminal no offset dado; devolve o offset final ou -1. */
    matchTerminal(symbol, input, offset) {
        const start = this.skipWhitespace(input, offset);
        if (symbol.kind === 'literal') {
            return input.startsWith(symbol.value, start) ? start + symbol.value.length : -1;
        }
        const re = this.anchored.get(symbol.value);
        if (!re)
            return -1;
        re.lastIndex = start;
        const m = re.exec(input);
        return m && m[0].length > 0 ? start + m[0].length : -1;
    }
    /** Constroi a tabela de Earley indexada por offset de caractere. */
    chart(input) {
        const nullable = this.grammar.nullable();
        const sets = new Array(input.length + 1);
        const ensure = (i) => {
            let s = sets[i];
            if (!s) {
                s = { items: [], keys: new Set() };
                sets[i] = s;
            }
            return s;
        };
        const add = (i, item) => {
            const set = ensure(i);
            const key = `${item.production.id}|${item.dot}|${item.origin}`;
            if (set.keys.has(key))
                return;
            set.keys.add(key);
            set.items.push(item);
        };
        for (const p of this.grammar.productionsFor(this.grammar.start)) {
            add(0, { production: p, dot: 0, origin: 0 });
        }
        for (let i = 0; i <= input.length; i++) {
            const set = sets[i];
            if (!set)
                continue;
            for (let k = 0; k < set.items.length; k++) {
                const item = set.items[k];
                const next = item.production.rhs[item.dot];
                if (!next) {
                    // COMPLETER — a origem sempre foi processada (origin <= i).
                    const origin = sets[item.origin];
                    if (!origin)
                        continue;
                    for (let j = 0; j < origin.items.length; j++) {
                        const parent = origin.items[j];
                        const sym = parent.production.rhs[parent.dot];
                        if (sym?.kind === 'nonterminal' && sym.value === item.production.lhs) {
                            add(i, {
                                production: parent.production,
                                dot: parent.dot + 1,
                                origin: parent.origin
                            });
                        }
                    }
                    continue;
                }
                if (next.kind === 'nonterminal') {
                    // PREDICTOR
                    for (const p of this.grammar.productionsFor(next.value)) {
                        add(i, { production: p, dot: 0, origin: i });
                    }
                    if (nullable.has(next.value)) {
                        add(i, {
                            production: item.production,
                            dot: item.dot + 1,
                            origin: item.origin
                        });
                    }
                    continue;
                }
                // SCANNER — avanca para o offset apos o terminal casado.
                const end = this.matchTerminal(next, input, i);
                if (end >= 0) {
                    add(end, {
                        production: item.production,
                        dot: item.dot + 1,
                        origin: item.origin
                    });
                }
            }
        }
        return sets;
    }
    isComplete(set) {
        return (set?.items.some(item => item.origin === 0 &&
            item.dot === item.production.rhs.length &&
            item.production.lhs === this.grammar.start) ?? false);
    }
    expectedAt(set) {
        const seen = new Set();
        const out = [];
        for (const item of set.items) {
            const sym = item.production.rhs[item.dot];
            if (!sym || sym.kind === 'nonterminal')
                continue;
            const key = `${sym.kind}:${sym.value}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            out.push(sym);
        }
        return out;
    }
    /**
     * Analisa um candidato `y`. Nunca lanca: qualquer saida de LLM, por mais
     * malformada, produz um diagnostico consumivel pelo laco de reparo.
     */
    analyze(raw) {
        const input = raw.trim();
        const sets = this.chart(input);
        // Offset mais avancado alcancado pelo reconhecedor.
        let furthest = 0;
        for (let i = 0; i <= input.length; i++) {
            if (sets[i])
                furthest = i;
        }
        const accepted = this.isComplete(sets[input.length]);
        const set = sets[furthest];
        const expected = this.expectedAt(set);
        let error;
        if (!accepted) {
            error =
                furthest >= input.length
                    ? 'Entrada incompleta: a derivacao do simbolo inicial nao foi concluida.'
                    : `Desvio sintatico no offset ${furthest}: ${JSON.stringify(input.slice(furthest, furthest + 24))}`;
        }
        return {
            accepted,
            validPrefixLength: furthest,
            validPrefix: input.slice(0, furthest),
            expected,
            error
        };
    }
    accepts(input) {
        return this.analyze(input).accepted;
    }
    /**
     * Custo para fechar tudo que resta DEPOIS de completar cada nao-terminal
     * pendente na tabela, indexado por (nao-terminal, offset de origem).
     *
     * Sem isso, um criterio guloso puramente local nunca fecha uma lista: diante de
     * `sequencia [ Manter_Bloqueio` o simbolo "," pertence a uma producao curta e
     * parece mais barato que "]", e o reparo repete conduta indefinidamente. Medir
     * o custo de fechar a pilha inteira faz o "]" vencer, que e o desejado.
     */
    closeCosts(sets) {
        const key = (nt, origin) => `${nt}|${origin}`;
        const cost = new Map([[key(this.grammar.start, 0), 0]]);
        // Relaxacao ate ponto fixo: os custos so decrescem e sao inteiros limitados.
        let changed = true;
        while (changed) {
            changed = false;
            for (let i = 0; i < sets.length; i++) {
                const set = sets[i];
                if (!set)
                    continue;
                for (const item of set.items) {
                    const base = cost.get(key(item.production.lhs, item.origin));
                    if (base === undefined)
                        continue;
                    const sym = item.production.rhs[item.dot];
                    if (sym?.kind !== 'nonterminal')
                        continue;
                    const candidate = base + this.grammar.suffixCost(item.production, item.dot + 1);
                    const childKey = key(sym.value, i);
                    if (candidate < (cost.get(childKey) ?? Number.POSITIVE_INFINITY)) {
                        cost.set(childKey, candidate);
                        changed = true;
                    }
                }
            }
        }
        return cost;
    }
    /**
     * Reparo deterministico: a partir do maior prefixo valido, completa o programa
     * escolhendo a cada passo o terminal que minimiza o numero de terminais ainda
     * necessarios para fechar a derivacao inteira. Termina sempre, e o resultado e,
     * por construcao, aceito por G.
     *
     * E a rede de seguranca que sustenta a promessa de erro sintatico zero mesmo
     * quando o LLM nunca converge para uma continuacao valida.
     */
    repair(prefix, maxSteps = 512) {
        let current = prefix.trim();
        for (let step = 0; step < maxSteps; step++) {
            const sets = this.chart(current);
            if (this.isComplete(sets[current.length]))
                return current;
            const set = sets[current.length];
            if (!set)
                return undefined; // o prefixo recebido ja nao e valido
            const closing = this.closeCosts(sets);
            let best;
            for (const item of set.items) {
                const sym = item.production.rhs[item.dot];
                if (!sym || sym.kind === 'nonterminal')
                    continue;
                const close = closing.get(`${item.production.lhs}|${item.origin}`);
                if (close === undefined)
                    continue;
                // 1 terminal agora + resto da producao + fechamento dos ancestrais.
                const total = 1 + this.grammar.suffixCost(item.production, item.dot + 1) + close;
                if (!best || total < best.cost)
                    best = { symbol: sym, cost: total };
            }
            if (!best)
                return undefined;
            const text = this.grammar.sampleOf(best.symbol);
            current = current.length > 0 ? `${current} ${text}` : text;
        }
        return undefined;
    }
    /** Sigma[y_prefix] em forma legivel, para injetar no prompt de correcao. */
    describeExpected(expected) {
        return expected.map(s => this.grammar.describe(s));
    }
}
