/**
 * Extrator da gramatica G do Esquema de Dados.
 *
 * PROBLEMA QUE ESTE MODULO RESOLVE
 * --------------------------------
 * Ate aqui a BNF (`grammar/advanced_icu.bnf`) era mantida a mao, em paralelo a DSL
 * Langium. Duas fontes de verdade para a mesma linguagem significam que qualquer
 * evolucao do dominio (um farmaco novo, uma decisao nova) pode dessincronizar o
 * motor de decodificacao restrita do modelo clinico — e o Fechamento Semantico
 * Mutuo deixa de valer justamente onde ele importa.
 *
 * Aqui a BNF passa a ser DERIVADA de duas fontes locais, ambas ja validadas:
 *
 *   1. `src/language/dsl.langium`  -> a ESTRUTURA da saida (regra `PlanCommand` e
 *      as regras que ela alcanca) e os VOCABULARIOS FECHADOS (Decision, Route,
 *      AlertLevel, Unit), lidos da AST da gramatica Langium.
 *
 *   2. `src/examples/med/uti.dsl`  -> as INSTANCIAS permitidas (nomes de farmacos,
 *      condutas, protocolos), lidas do modelo do especialista. Um farmaco que nao
 *      existe no modelo nao existe na gramatica: citar `Dopamina` deixa de ser um
 *      erro semantico a ser detectado depois e passa a ser sintaticamente
 *      inexprimivel.
 *
 * ESTREITAMENTOS DELIBERADOS (L(G_saida) ⊂ L(DSL))
 * ------------------------------------------------
 * A gramatica de saida e mais restrita que a DSL de autoria, por decisao de projeto:
 *   - `justificativa` e `regra` deixam de ser opcionais: toda ordem gerada
 *     automaticamente carrega rastreabilidade (invariante de auditoria do modelo);
 *   - `texto` aceita apenas aspas simples, evitando ambiguidade de escape na
 *     serializacao BNF consumida pelo motor Python.
 * Todo plano gerado continua sendo um programa valido da DSL — a reciproca nao vale.
 */

import { GrammarAST, type Grammar } from 'langium';

// --------------------------------------------------------------------------
// Nomes do dialeto BNF (snake_case em portugues, alinhado ao motor Python)
// --------------------------------------------------------------------------

/**
 * Regras de parser da DSL -> nao-terminais da BNF de saida.
 *
 * As tres DSLs (clinica, agricola e de arbitragem) compartilham este extrator:
 * os nomes comuns — AlertStmt, Quantity, Decision, AlertLevel, Unit — sao
 * deliberadamente iguais nas tres gramaticas, e os especificos nao colidem
 * porque cada dominio e extraido a partir do seu proprio objeto Grammar.
 */
const RULE_ALIAS: Record<string, string> = {
    // dominio clinico
    PlanCommand: 'plano',
    OrderStmt: 'ordem',
    Route: 'via',
    // dominio agricola
    MissionCommand: 'missao',
    ApplicationStmt: 'aplicacao',
    SprayMode: 'modo',
    // dominio de arbitragem
    DecisionCommand: 'arbitragem',
    MarkingStmt: 'marcacao',
    Restart: 'reinicio',
    // comuns aos tres
    AlertStmt: 'alerta',
    Quantity: 'quantidade',
    Decision: 'decisao',
    AlertLevel: 'nivel_alerta',
    Unit: 'unidade'
};

/** Alvos de referencia cruzada -> vocabularios de instancias vindos do modelo. */
const XREF_ALIAS: Record<string, string> = {
    // dominio clinico
    DrugDef: 'farmaco',
    ProtocolDef: 'protocolo',
    // dominio agricola
    ProductDef: 'produto',
    CultureDef: 'cultura',
    AgroConductDef: 'conduta',
    AgroSchemaDef: 'esquema',
    // dominio de arbitragem
    InfractionDef: 'infracao',
    SituationDef: 'lance',
    FutSchemaDef: 'esquema',
    FutConductDef: 'conduta',
    // comuns aos tres
    ConductDef: 'conduta',
    DataSchemaDef: 'esquema'
};

/** Terminais lexicos -> folhas regex da BNF. */
const TERMINAL_ALIAS: Record<string, string> = {
    ID: 'identificador',
    STRING: 'texto',
    NUMBER: 'numero'
};

const TERMINAL_REGEX: Record<string, string> = {
    identificador: '[A-Za-z_][A-Za-z_0-9]*',
    // Apenas aspas simples: o leitor BNF do motor Python trata `|` como separador
    // de alternativas, o que quebraria um padrao com as duas formas de aspas.
    texto: "'[^']*'",
    numero: '[0-9]+(\\.[0-9]+)?'
};

/**
 * Grupos opcionais da DSL promovidos a obrigatorios na gramatica de saida,
 * identificados pela palavra-chave que os inicia.
 */
const FORCE_REQUIRED = new Set(['justificativa', 'regra']);

// --------------------------------------------------------------------------

export interface BnfRule {
    name: string;
    /** Alternativas; cada alternativa e uma sequencia de simbolos. */
    alts: string[][];
    /** Folha lexica: quando definida, a regra e `nome ::= /regex/`. */
    regex?: string;
}

export interface BnfDocument {
    rules: BnfRule[];
    /** Serializa uma regra por linha, no dialeto lido por `python_engine/bnf.py`. */
    serialize(header?: string): string;
}

/** Vocabularios de instancia extraidos do modelo clinico. */
export type Vocabularies = Map<string, string[]>;

class OutputGrammarExtractor {
    private readonly rules = new Map<string, BnfRule>();
    private readonly order: string[] = [];
    private readonly pending: string[] = [];
    private helperCount = 0;

    constructor(
        private readonly grammar: Grammar,
        private readonly vocabularies: Vocabularies
    ) {}

    extract(entryRule = 'PlanCommand'): BnfDocument {
        this.pending.push(entryRule);
        while (this.pending.length > 0) {
            const ruleName = this.pending.shift()!;
            const alias = this.aliasFor(ruleName);
            if (this.rules.has(alias)) continue;
            this.convertRule(this.parserRule(ruleName));
        }
        this.emitVocabularies();
        this.emitTerminals();
        return this.document();
    }

    // ------------------------------------------------------------- utilidades

    private parserRule(name: string): GrammarAST.ParserRule {
        const rule = this.grammar.rules.find(
            r => GrammarAST.isParserRule(r) && r.name === name
        ) as GrammarAST.ParserRule | undefined;
        if (!rule) throw new Error(`Regra de parser \`${name}\` ausente na gramatica Langium.`);
        return rule;
    }

    private aliasFor(ruleName: string): string {
        return RULE_ALIAS[ruleName] ?? ruleName.toLowerCase();
    }

    private define(name: string, alts: string[][], regex?: string): void {
        if (!this.rules.has(name)) this.order.push(name);
        this.rules.set(name, { name, alts, regex });
    }

    private helper(base: string): string {
        return `${base}_g${++this.helperCount}`;
    }

    /** Uma regra de parser que so produz palavras-chave e um vocabulario fechado. */
    private isClosedVocabulary(rule: GrammarAST.ParserRule): boolean {
        return this.collectKeywords(rule.definition).length > 0 && !this.hasNonKeyword(rule.definition);
    }

    private hasNonKeyword(element: GrammarAST.AbstractElement): boolean {
        if (GrammarAST.isKeyword(element)) return false;
        if (GrammarAST.isAlternatives(element) || GrammarAST.isGroup(element)) {
            return element.elements.some(e => this.hasNonKeyword(e));
        }
        return true;
    }

    private collectKeywords(element: GrammarAST.AbstractElement): string[] {
        if (GrammarAST.isKeyword(element)) return [element.value];
        if (GrammarAST.isAlternatives(element) || GrammarAST.isGroup(element)) {
            return element.elements.flatMap(e => this.collectKeywords(e));
        }
        return [];
    }

    // -------------------------------------------------------------- conversao

    private convertRule(rule: GrammarAST.ParserRule): void {
        const alias = this.aliasFor(rule.name);
        const alts = this.convertAlternatives(rule.definition, alias);
        this.define(alias, alts);
    }

    /** Converte um elemento tratando o nivel mais externo de alternativas. */
    private convertAlternatives(
        element: GrammarAST.AbstractElement,
        context: string
    ): string[][] {
        if (GrammarAST.isAlternatives(element) && !element.cardinality) {
            return element.elements.map(e => this.convertSequence(e, context));
        }
        return [this.convertSequence(element, context)];
    }

    /** Converte um elemento em uma sequencia plana de simbolos BNF. */
    private convertSequence(element: GrammarAST.AbstractElement, context: string): string[] {
        const cardinality = element.cardinality;

        if (cardinality) {
            const bare = { ...element, cardinality: undefined } as GrammarAST.AbstractElement;

            // Estreitamento: grupos opcionais de rastreabilidade viram obrigatorios.
            if (cardinality === '?' && this.startsWithForcedKeyword(bare)) {
                return this.convertSequence(bare, context);
            }

            const inner = this.convertAlternatives(bare, context);
            const name = this.helper(context);
            this.define(name, inner);
            return [`${name}${cardinality}`];
        }

        if (GrammarAST.isGroup(element) || GrammarAST.isUnorderedGroup(element)) {
            return element.elements.flatMap(e => this.convertSequence(e, context));
        }

        if (GrammarAST.isAlternatives(element)) {
            const name = this.helper(context);
            this.define(name, element.elements.map(e => this.convertSequence(e, context)));
            return [name];
        }

        if (GrammarAST.isAssignment(element)) {
            return this.convertSequence(element.terminal, context);
        }

        if (GrammarAST.isKeyword(element)) {
            return [JSON.stringify(element.value)];
        }

        if (GrammarAST.isCrossReference(element)) {
            const target = element.type.ref?.name;
            const alias = target ? XREF_ALIAS[target] : undefined;
            if (!alias) {
                throw new Error(
                    `Referencia cruzada para \`${target}\` sem vocabulario mapeado em XREF_ALIAS.`
                );
            }
            return [alias];
        }

        if (GrammarAST.isRuleCall(element)) {
            const ref = element.rule.ref;
            if (!ref) throw new Error(`Chamada de regra nao resolvida em \`${context}\`.`);

            if (GrammarAST.isTerminalRule(ref)) {
                const alias = TERMINAL_ALIAS[ref.name];
                if (!alias) throw new Error(`Terminal \`${ref.name}\` sem alias BNF.`);
                return [alias];
            }

            if (!GrammarAST.isParserRule(ref)) {
                throw new Error(
                    `Chamada para \`${ref.name}\` (${ref.$type}) nao suportada na extracao.`
                );
            }
            const alias = this.aliasFor(ref.name);
            // Vocabularios fechados sao emitidos na secao de vocabularios, ja
            // filtrados pelo Esquema de Dados do modelo.
            if (!this.isClosedVocabulary(ref) && !this.rules.has(alias)) {
                this.pending.push(ref.name);
            }
            return [alias];
        }

        if (GrammarAST.isAction(element)) return [];

        throw new Error(`Elemento nao suportado na extracao: ${element.$type}`);
    }

    private startsWithForcedKeyword(element: GrammarAST.AbstractElement): boolean {
        if (GrammarAST.isKeyword(element)) return FORCE_REQUIRED.has(element.value);
        if (GrammarAST.isGroup(element) && element.elements.length > 0) {
            return this.startsWithForcedKeyword(element.elements[0]);
        }
        return false;
    }

    // ------------------------------------------------------------ vocabularios

    /**
     * Emite os vocabularios fechados. A precedencia e intencional: o que o modelo
     * clinico declara no `esquema_dados` prevalece sobre o que a gramatica permite,
     * porque o Esquema de Dados e quem delimita as respostas admissiveis.
     */
    private emitVocabularies(): void {
        const referenced = new Set<string>();
        for (const rule of this.rules.values()) {
            for (const alt of rule.alts) {
                for (const sym of alt) {
                    if (!sym.startsWith('"')) referenced.add(sym.replace(/[*+?]$/, ''));
                }
            }
        }

        for (const name of referenced) {
            if (this.rules.has(name)) continue;
            if (TERMINAL_REGEX[name]) continue;

            const fromModel = this.vocabularies.get(name);
            if (fromModel && fromModel.length > 0) {
                this.define(name, fromModel.map(v => [JSON.stringify(v)]));
                continue;
            }

            // Sem instancia no modelo: recorre ao vocabulario declarado na gramatica.
            const ruleName = Object.keys(RULE_ALIAS).find(k => RULE_ALIAS[k] === name);
            const rule = ruleName
                ? (this.grammar.rules.find(
                      r => GrammarAST.isParserRule(r) && r.name === ruleName
                  ) as GrammarAST.ParserRule | undefined)
                : undefined;
            if (rule) {
                const keywords = this.collectKeywords(rule.definition);
                if (keywords.length > 0) {
                    this.define(name, keywords.map(k => [JSON.stringify(k)]));
                    continue;
                }
            }

            throw new Error(`Vocabulario \`${name}\` vazio: nem o modelo nem a gramatica o definem.`);
        }
    }

    private emitTerminals(): void {
        const referenced = new Set<string>();
        for (const rule of this.rules.values()) {
            for (const alt of rule.alts) {
                for (const sym of alt) {
                    if (!sym.startsWith('"')) referenced.add(sym.replace(/[*+?]$/, ''));
                }
            }
        }
        for (const [name, regex] of Object.entries(TERMINAL_REGEX)) {
            if (referenced.has(name)) this.define(name, [], regex);
        }
    }

    // -------------------------------------------------------------- serializacao

    private document(): BnfDocument {
        const rules = this.order.map(n => this.rules.get(n)!);
        return {
            rules,
            serialize(header?: string): string {
                const lines: string[] = [];
                if (header) {
                    for (const line of header.split('\n')) lines.push(`# ${line}`);
                    lines.push('');
                }
                for (const rule of rules) {
                    if (rule.regex !== undefined) {
                        lines.push(`${rule.name} ::= /${rule.regex}/`);
                    } else {
                        lines.push(
                            `${rule.name} ::= ` + rule.alts.map(a => a.join(' ')).join(' | ')
                        );
                    }
                }
                return lines.join('\n') + '\n';
            }
        };
    }
}

/**
 * Deriva a gramatica BNF de saida a partir da gramatica Langium e dos vocabularios
 * extraidos do modelo clinico.
 */
export function extractOutputBnf(
    grammar: Grammar,
    vocabularies: Vocabularies,
    entryRule = 'PlanCommand'
): BnfDocument {
    return new OutputGrammarExtractor(grammar, vocabularies).extract(entryRule);
}
