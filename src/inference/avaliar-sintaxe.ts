/**
 * Validação SINTÁTICA de um plano já gerado — a primeira etapa do avaliador
 * (ver `avaliarPlano` em avaliar-grafo.ts). Nenhum LLM participa.
 *
 * A pergunta é objetiva: o texto pertence à linguagem da DSL? Respondem as duas
 * peças oficiais que o projeto já tem, e nenhuma outra:
 *
 *   GRAMÁTICA G  a BNF que `export-bnf*.ts` deriva da regra do artefato na
 *                gramática Langium mais o modelo do especialista
 *                (python_engine/grammar/*.bnf) — a MESMA que a decodificação
 *                restrita mascara. Conferida pelo `/verify` do motor com
 *                subgrafo VAZIO: `_gramatica_efetiva` cai então em G completa,
 *                sem poda (main.py). É mais estrita que a Langium: justificativa
 *                e `regra` do alerta obrigatórias, texto entre aspas simples,
 *                unidades e meios só os que o modelo declara.
 *   PARSER       o parser Langium da própria DSL (dsl.langium, agrodrone.langium,
 *                futebol.langium), com a ligação de referências contra o modelo
 *                do especialista — o mesmo `DocumentBuilder.build` de
 *                `cli/validate.ts` e `loadModel`. Produz o AST OFICIAL
 *                (`PlanCommand` | `MissionCommand` | `DecisionCommand`, de
 *                src/generated/ast.ts). Nenhum segundo AST é criado.
 *
 * VALID só quando as duas aceitam. Os erros guardam a fonte (gramática,
 * parser, ligação), a posição (linha e coluna), a regra e o que era esperado,
 * quando o parser os informa. Os códigos são os dos próprios parsers: as classes
 * de erro do Lark (`UnexpectedToken`, `UnexpectedCharacters`, `UnexpectedEOF`)
 * e os códigos de diagnóstico do Langium (`lexing-error`, `parsing-error`,
 * `linking-error`). Os códigos de `lerSaidaPIAgent` (`campo_ausente`,
 * `cabecalho_ausente`, ...) NÃO se aplicam: são do protocolo de saída do PI
 * Agent (`PI n | ... FIM`), não da DSL do artefato composto.
 *
 * O AST GUARDADO É O AST JULGADO. O parser devolve o AST serializado pelo
 * `JsonSerializer` do Langium, e a semântica lê SÓ esse objeto
 * (`projetarAst`): o que vai para o JSONL e para a tela é exatamente o que a
 * semântica recebeu. Cada `Quantity` leva, além de `value` (número), o
 * `$literal` como está no texto (`0.0`), tirado da CST — o retículo de valores
 * compara strings, e reconstruir o literal a partir do número perderia a forma
 * (`formatarNumero` arredonda a 3 casas).
 *
 * `/verify` com a POLÍTICA (L(Ĝ)) não é sintaxe: é a política efetiva escrita
 * como gramática, e entra na validação semântica.
 */

import * as fs from 'node:fs';
import { AstUtils, EmptyFileSystem, GrammarUtils, type AstNode, type LangiumCoreServices, type LangiumSharedCoreServices } from 'langium';
import { URI } from 'vscode-uri';

import { createAgroServices } from '../language/agro-module.js';
import { createDSLServices } from '../language/dsl-module.js';
import { createFutServices } from '../language/fut-module.js';
import {
    isDecisionCommand,
    isMissionCommand,
    isPlanCommand,
    isQuantity,
    type DecisionCommand,
    type MissionCommand,
    type PlanCommand
} from '../generated/ast.js';
import type { ArtefatoLido } from '../knowledge/contrato.js';
import type { SubgrafoPodado } from '../knowledge/politica.js';
import type { Dominio } from '../knowledge/recuperacao.js';
import type { VerificacaoGramatical, VerificadorGramatical } from './ciclo-global.js';

// =============================================================================
// Contrato
// =============================================================================

export interface ErroSintatico {
    /** Código do próprio parser (classe do Lark, diagnóstico do Langium) ou `artefato_vazio` do contrato. */
    codigo: string;
    mensagem: string;
    /** Quem recusou: G (`/verify`), o parser Langium, a ligação de referências ou a ausência de texto. */
    fonte: 'gramatica' | 'parser' | 'ligacao' | 'artefato';
    linha?: number;
    coluna?: number;
    /** A regra da gramática em que o parser estava (Langium). */
    regra?: string;
    /** O campo do AST, na ligação (`OrderStmt.drug`). */
    campo?: string;
    /** O que foi encontrado no lugar. */
    encontrado?: string;
    /** Os terminais que a gramática aceitaria ali. */
    esperado?: string[];
}

export interface ValidacaoSintatica {
    veredito: 'VALID' | 'INVALID';
    erros: ErroSintatico[];
    /** O que cada peça disse. Ausente quando nenhuma foi chamada (artefato vazio). */
    pecas?: { gramatica: 'ACEITO' | 'RECUSADO'; parser: 'ACEITO' | 'RECUSADO' };
}

/**
 * O AST oficial, como o `JsonSerializer` do Langium o escreve: `$type`, os
 * campos do nó, referências por `$refText`, e `$literal` em cada `Quantity`.
 */
export type AstArtefato = { $type: string } & Record<string, unknown>;

/** O que a etapa sintática entrega: o veredito e, só em VALID, o AST. */
export interface ResultadoSintaxe {
    sintaxe: ValidacaoSintatica;
    ast?: AstArtefato;
}

/** Quem confere G: `/verify` sem política. Injetável para teste. */
export type VerificadorDaDsl = (texto: string) => Promise<VerificacaoGramatical>;

/**
 * Subgrafo vazio: `/verify` recebe `subgrafo_regras: {}` e `_gramatica_efetiva`
 * devolve G completa (`if not subgrafo: return RULES`, main.py). É a única
 * forma de pedir ao motor a gramática da DSL sem a poda da política.
 */
const SEM_POLITICA = {} as SubgrafoPodado;

/** O `/verify` da geração, apontado para G em vez de Ĝ. */
export function verificadorDaDsl(verificador: VerificadorGramatical): VerificadorDaDsl {
    return texto => verificador(texto, SEM_POLITICA);
}

// =============================================================================
// AST oficial -> vocabulário do contrato
// =============================================================================

type NoArtefato = PlanCommand | MissionCommand | DecisionCommand;

/**
 * Onde cada domínio guarda os papéis do artefato no AST. Os nomes são os
 * campos das regras Langium (`PlanCommand`, `MissionCommand`,
 * `DecisionCommand` e as cláusulas deles), checados pelo compilador.
 */
interface CamposArtefato<A extends NoArtefato, C> {
    contexto: keyof A & string;
    sujeito: keyof A & string;
    clausulas: keyof A & string;
    item: keyof C & string;
    quantidade: keyof C & string;
    meio: keyof C & string;
}

type CamposGenericos = Record<keyof CamposArtefato<NoArtefato, unknown>, string>;

/** Os campos de um domínio, conferidos contra os tipos do AST gerado. */
const camposDe = <A extends NoArtefato, C>(c: CamposArtefato<A, C>): CamposGenericos => c;

interface Linguagem {
    extensao: string;
    criar(): { shared: LangiumSharedCoreServices; servicos: LangiumCoreServices };
    ehArtefato(no: unknown): no is NoArtefato;
    campos: CamposGenericos;
}

const LINGUAGENS: Record<Dominio, Linguagem> = {
    med: {
        extensao: '.dsl',
        criar: () => { const s = createDSLServices(EmptyFileSystem); return { shared: s.shared, servicos: s.DSL }; },
        ehArtefato: (no): no is PlanCommand => isPlanCommand(no),
        campos: camposDe<PlanCommand, PlanCommand['orders'][number]>({ contexto: 'protocol', sujeito: 'patient', clausulas: 'orders', item: 'drug', quantidade: 'dose', meio: 'route' })
    },
    agro: {
        extensao: '.agro',
        criar: () => { const s = createAgroServices(EmptyFileSystem); return { shared: s.shared, servicos: s.Agro }; },
        ehArtefato: (no): no is MissionCommand => isMissionCommand(no),
        campos: camposDe<MissionCommand, MissionCommand['applications'][number]>({ contexto: 'culture', sujeito: 'plot', clausulas: 'applications', item: 'product', quantidade: 'rate', meio: 'mode' })
    },
    fut: {
        extensao: '.fut',
        criar: () => { const s = createFutServices(EmptyFileSystem); return { shared: s.shared, servicos: s.Fut }; },
        ehArtefato: (no): no is DecisionCommand => isDecisionCommand(no),
        campos: camposDe<DecisionCommand, DecisionCommand['markings'][number]>({ contexto: 'situation', sujeito: 'match', clausulas: 'markings', item: 'infraction', quantidade: 'minute', meio: 'restart' })
    }
};

type Campo = Record<string, unknown>;
const refText = (v: unknown): string => String((v as { $refText?: unknown } | undefined)?.$refText ?? '');

/**
 * O AST GUARDADO no vocabulário do contrato (`ArtefatoLido`) — a ENTRADA da
 * validação semântica. Lê só o objeto serializado: nada do texto, nada do nó
 * vivo do Langium. Lança se o AST não for do artefato do domínio ou se uma
 * quantidade vier sem `$literal` (AST que não saiu de `criarAnalisadorDsl`).
 */
export function projetarAst(dominio: Dominio, ast: AstArtefato): ArtefatoLido {
    const linguagem = LINGUAGENS[dominio];
    if (!linguagem.ehArtefato(ast)) {
        throw new Error(`o AST nao e o artefato do dominio ${dominio}: $type ${ast.$type}`);
    }
    const c = linguagem.campos;
    const clausulas = (ast[c.clausulas] as Campo[] | undefined) ?? [];
    return {
        identificador: String(ast.name),
        contexto: refText(ast[c.contexto]),
        sujeito: String(ast[c.sujeito]),
        sequencia: ((ast.sequence as unknown[] | undefined) ?? []).map(refText),
        clausulas: clausulas.map((cl, indice) => {
            const q = cl[c.quantidade] as Campo | undefined;
            if (typeof q?.$literal !== 'string') throw new Error(`a quantidade da clausula ${indice + 1} veio sem $literal no AST`);
            return {
                indice,
                item: refText(cl[c.item]),
                decisao: String(cl.decision),
                valor: q.$literal,
                unidade: String(q.unit),
                meio: String(cl[c.meio]),
                justificativa: typeof cl.justification === 'string' ? cl.justification : ''
            };
        })
    };
}

// =============================================================================
// Parser Langium -> AST oficial
// =============================================================================

export interface AnaliseParser {
    erros: ErroSintatico[];
    /** Só quando o parser aceitou: o AST serializado. */
    ast?: AstArtefato;
}

/** O parser oficial de um domínio, com o modelo do especialista para a ligação das referências. */
export interface AnalisadorDsl {
    dominio: Dominio;
    analisar(texto: string): Promise<AnaliseParser>;
}

const numero = (n: number | undefined): number | undefined => (typeof n === 'number' && Number.isFinite(n) ? n : undefined);

/**
 * O parser da DSL do domínio. A cada análise, o modelo e o artefato entram
 * juntos num `DocumentBuilder.build` novo — sem workspace compartilhado entre
 * análises —, e as referências do artefato (contexto, esquema, itens, condutas)
 * se ligam às declarações do modelo, como o artefato de referência do próprio
 * modelo se liga.
 */
export function criarAnalisadorDsl(dominio: Dominio, caminhoModelo: string): AnalisadorDsl {
    const linguagem = LINGUAGENS[dominio];
    const textoModelo = fs.readFileSync(caminhoModelo, 'utf-8');
    const uriModelo = URI.file(caminhoModelo);
    let seq = 0;

    return {
        dominio,
        async analisar(texto) {
            const { shared, servicos } = linguagem.criar();
            const fabrica = shared.workspace.LangiumDocumentFactory;
            const modelo = fabrica.fromString(textoModelo, uriModelo);
            const doc = fabrica.fromString(texto, URI.parse(`memory:///avaliacao/artefato-${++seq}${linguagem.extensao}`));
            await shared.workspace.DocumentBuilder.build([modelo, doc], { validation: false });

            const erros: ErroSintatico[] = [
                ...doc.parseResult.lexerErrors.map(e => ({
                    codigo: 'lexing-error', fonte: 'parser' as const, mensagem: e.message, linha: numero(e.line), coluna: numero(e.column)
                })),
                ...doc.parseResult.parserErrors.map(e => ({
                    codigo: 'parsing-error', fonte: 'parser' as const, mensagem: e.message,
                    linha: numero(e.token.startLine), coluna: numero(e.token.startColumn),
                    // O Langium marca os nomes de regra com um caractere de largura zero.
                    regra: e.context?.ruleStack?.[e.context.ruleStack.length - 1]?.replace(/[​-‍﻿]/g, ''),
                    encontrado: e.token.image || undefined
                }))
            ];

            const raiz = doc.parseResult.value as unknown as { elements?: AstNode[] } & AstNode;
            for (const no of AstUtils.streamAst(raiz)) {
                for (const info of AstUtils.streamReferences(no)) {
                    const ref = info.reference;
                    if (!('error' in ref) || !ref.error) continue;
                    const inicio = ref.$refNode?.range.start;
                    erros.push({
                        codigo: 'linking-error', fonte: 'ligacao', mensagem: ref.error.message,
                        campo: `${no.$type}.${info.property}`, encontrado: ref.$refText,
                        linha: inicio ? inicio.line + 1 : undefined, coluna: inicio ? inicio.character + 1 : undefined
                    });
                }
            }

            const elementos = raiz.elements ?? [];
            if (erros.length > 0) return { erros };
            if (elementos.length !== 1 || !linguagem.ehArtefato(elementos[0])) {
                return {
                    erros: [{
                        codigo: 'parsing-error', fonte: 'parser',
                        mensagem: `o texto nao e exatamente um artefato da DSL: ${elementos.length} elemento(s) (${elementos.map(e => e.$type).join(', ') || 'nenhum'})`
                    }]
                };
            }

            const ast = JSON.parse(
                servicos.serializer.JsonSerializer.serialize(elementos[0], {
                    refText: true,
                    replacer: (chave, valor, padrao) => {
                        // O alvo da referencia e uma URI do arquivo do modelo; o nome ja basta.
                        if (chave === '$ref') return undefined;
                        // O numero E o literal do texto: ver o comentario do topo.
                        if (isQuantity(valor)) {
                            const literal = GrammarUtils.findNodeForProperty(valor.$cstNode, 'value')?.text;
                            return { $type: valor.$type, value: valor.value, unit: valor.unit, $literal: literal ?? String(valor.value) };
                        }
                        return padrao(chave, valor);
                    }
                })
            ) as AstArtefato;
            return { erros: [], ast };
        }
    };
}

// =============================================================================
// Erro de G (Lark, via /verify)
// =============================================================================

/**
 * O erro que `/verify` devolve é o `str()` da exceção do Lark. A classe não
 * vem no JSON; a primeira frase a identifica (é o texto fixo de cada classe).
 */
export function erroDaGramatica(erro: string | null | undefined): ErroSintatico {
    const texto = erro ?? '';
    const codigo = /^Unexpected token/.test(texto)
        ? 'UnexpectedToken'
        : /^No terminal matches|^Unexpected character/.test(texto)
          ? 'UnexpectedCharacters'
          : /Unexpected end-of-input/.test(texto)
            ? 'UnexpectedEOF'
            : 'UnexpectedInput';
    const pos = /at line (\d+),? col(?:umn)? (\d+)/.exec(texto);
    const esperado = [...texto.matchAll(/^\t\* (\S+)$/gm)].map(m => m[1]);
    const encontrado =
        codigo === 'UnexpectedToken'
            ? /Token\('[^']*', ['"](.*?)['"]\)/.exec(texto)?.[1]
            : /No terminal matches '(.*?)'/.exec(texto)?.[1];
    return {
        codigo,
        fonte: 'gramatica',
        mensagem: `fora de L(G), a gramatica da DSL: ${texto.split('\n')[0] || 'sem detalhe'}`,
        ...(pos ? { linha: Number(pos[1]), coluna: Number(pos[2]) } : {}),
        ...(encontrado !== undefined ? { encontrado } : {}),
        ...(esperado.length > 0 ? { esperado } : {})
    };
}

// =============================================================================
// A etapa
// =============================================================================

/** Falha técnica de uma peça da sintaxe (parser que lança, motor fora): não é veredito. */
export class FalhaSintaxe extends Error {
    constructor(readonly peca: 'parser Langium' | '/verify de G', causa: unknown) {
        super(`${peca}: ${(causa as Error)?.message ?? String(causa)}`);
        this.name = 'FalhaSintaxe';
    }
}

/**
 * Texto bruto -> G (`/verify` sem política) e parser Langium -> AST. VALID só
 * se as duas peças aceitam; os erros das duas vão juntos. Texto vazio é
 * `artefato_vazio` (o código do contrato para artefato sem cláusula) e nenhuma
 * peça é chamada. Falha técnica de uma peça sobe como `FalhaSintaxe`: não é
 * veredito.
 */
export async function validarSintaxePlano(
    texto: string,
    analisador: AnalisadorDsl,
    verificarDsl: VerificadorDaDsl
): Promise<ResultadoSintaxe> {
    if (texto.trim().length === 0) {
        return {
            sintaxe: {
                veredito: 'INVALID',
                erros: [{ codigo: 'artefato_vazio', fonte: 'artefato', mensagem: 'nenhum texto de artefato: nao ha o que analisar' }]
            }
        };
    }
    let parser: AnaliseParser;
    try {
        parser = await analisador.analisar(texto);
    } catch (erro) {
        throw new FalhaSintaxe('parser Langium', erro);
    }
    let gramatica: VerificacaoGramatical;
    try {
        gramatica = await verificarDsl(texto);
    } catch (erro) {
        throw new FalhaSintaxe('/verify de G', erro);
    }
    const erros = [...(gramatica.valido ? [] : [erroDaGramatica(gramatica.erro)]), ...parser.erros];
    const pecas = { gramatica: gramatica.valido ? 'ACEITO' : 'RECUSADO', parser: parser.ast ? 'ACEITO' : 'RECUSADO' } as const;
    if (erros.length > 0 || !parser.ast) return { sintaxe: { veredito: 'INVALID', erros, pecas } };
    return { sintaxe: { veredito: 'VALID', erros: [], pecas }, ast: parser.ast };
}
