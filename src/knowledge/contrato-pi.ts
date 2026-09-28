/**
 * Contratos do PI (Politica por Item) na arquitetura multiagente.
 *
 *     Planner --PIPlanejado[]--> validacao --> Decompositor --> PI Agent --ResultadoPI--> validacao
 *
 * Dois contratos, e a fronteira entre eles e a decisao arquitetural desta etapa:
 *
 *   PIPlanejado  o que o Planner escolhe: o PAR (item, conduta), a posicao na
 *                sequencia e as dependencias. NAO carrega acao nem
 *                justificativa. Decidir o que fazer com o item e trabalho do PI
 *                Agent, sob a gramatica daquele item; um Planner que devolve
 *                acao esta decidindo no lugar errado, e o contrato o recusa.
 *   ResultadoPI  o que o PI Agent devolve para o par que o Planner fixou: a acao
 *                (decisao, meio, valor) e a justificativa.
 *
 * NENHUM DOS DOIS E ESTRUTURA PARALELA:
 *   - `item` e `PoliticaItem.item` (farmaco | produto | infracao);
 *   - `conduta` e o nome de uma `conduta` do `esquema_dados` — o valor que entra
 *     em `sequencia [ ... ]` e que `ContratoArtefato.condutaPorDecisao`
 *     devolve (ex.: `Aplicar_Cartao_Amarelo`). NAO e o literal da clausula
 *     (`ordem` | `aplicacao` | `marcacao`), que e `PapeisDominio.clausula`;
 *   - `ResultadoPI` converte 1:1 para `ClausulaLida` (`comoClausulaLida`), para
 *     a validacao individual reaproveitar `verificarClausulas` em vez de
 *     reescrever o criterio;
 *   - o valor e `ValorAdmissivel`, o mesmo par valor+unidade do reticulo.
 *
 * O QUE ESTE MODULO VALIDA: so a FORMA — campos presentes, tipos, dependencias
 * coerentes com a ordem, PI respondido e o PI pedido. Se o item esta na
 * politica, se a conduta e realizavel, se a decisao e admissivel: isso e a
 * validacao contra o grafo, em outra etapa. Os validadores recebem `unknown` de
 * proposito: a entrada deles vai ser saida de LLM.
 */

import type { ClausulaLida } from './contrato.js';
import type { PapeisDominio, ValorAdmissivel } from './politica.js';
import type { RegraValidada } from './recuperacao-cypher.js';
import { invalido, valido, type ProblemaValidacao, type ResultadoValidacao } from './validacao.js';

// =============================================================================
// Contratos
// =============================================================================

/** Um elemento da sequencia que o Planner propoe. */
export interface PIPlanejado {
    /** Posicao na sequencia, a partir de 1. E a ordem das clausulas no artefato. */
    ordem: number;
    /** Nome do item: `PoliticaItem.item`. */
    item: string;
    /** Nome de uma `conduta` do `esquema_dados`. */
    conduta: string;
    /** `ordem` dos PIs de que este depende. So para tras: ver `validarSequenciaPlanejada`. */
    dependeDe: number[];
    /** Relacao semantica que o Planner declarou. Texto livre: registrado, nunca lido como regra. */
    motivo?: string;
    /** Associadas DEPOIS da validacao da sequencia. O Planner nunca as fornece. */
    regras?: RegraValidada[];
    /** Proibidos por construcao: sao do PI Agent. */
    acao?: never;
    justificativa?: never;
}

/** A acao que o PI Agent escolheu para o par (item, conduta). */
export interface AcaoPI {
    decisao: string;
    meio: string;
    valor: ValorAdmissivel;
}

export interface ResultadoPI {
    /** O PI a que este resultado responde. */
    ordem: number;
    item: string;
    conduta: string;
    acao: AcaoPI;
    justificativa: string;
}

// =============================================================================
// Codigos
// =============================================================================

export type CodigoContratoPI =
    | 'pi_nao_e_objeto'
    | 'resultado_nao_e_objeto'
    | 'campo_nao_permitido'
    | 'ordem_invalida'
    | 'item_ausente'
    | 'conduta_ausente'
    | 'dependencias_invalidas'
    | 'motivo_invalido'
    | 'regras_invalidas'
    | 'sequencia_nao_e_lista'
    | 'sequencia_vazia'
    | 'ordem_repetida'
    | 'ordem_fora_de_sequencia'
    | 'ordem_fora_de_posicao'
    | 'dependencia_propria'
    | 'dependencia_inexistente'
    | 'dependencia_posterior'
    | 'dependencia_repetida'
    | 'acao_ausente'
    | 'decisao_ausente'
    | 'meio_ausente'
    | 'valor_invalido'
    | 'justificativa_ausente'
    | 'justificativa_invalida'
    | 'pi_divergente';

type Problema = ProblemaValidacao<CodigoContratoPI>;

/** Campos que o Planner pode devolver. Qualquer outro e recusado. */
export const CAMPOS_DO_PLANNER = ['ordem', 'item', 'conduta', 'dependeDe', 'motivo'] as const;

/** Campos que denunciam o Planner decidindo a acao. Recusados com mensagem propria. */
export const CAMPOS_DO_PI_AGENT = ['acao', 'decisao', 'meio', 'valor', 'quantidade', 'unidade', 'justificativa'] as const;

const CAMPOS_DO_RESULTADO = ['ordem', 'item', 'conduta', 'acao', 'justificativa'] as const;
const CAMPOS_DA_ACAO = ['decisao', 'meio', 'valor'] as const;

/** `numero ::= /[0-9]+(\.[0-9]+)?/` — o mesmo formato que a gramatica aceita. */
const NUMERO = /^[0-9]+(\.[0-9]+)?$/;

// =============================================================================
// Leitura
// =============================================================================

function objeto(bruto: unknown): Record<string, unknown> | undefined {
    return typeof bruto === 'object' && bruto !== null && !Array.isArray(bruto)
        ? (bruto as Record<string, unknown>)
        : undefined;
}

function textoPreenchido(v: unknown): v is string {
    return typeof v === 'string' && v.trim().length > 0;
}

function ordemValida(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

export interface OpcoesPIPlanejado {
    /**
     * `planner` (padrao): a saida crua do Planner — `regras` e recusado.
     * `associado`: o PI depois da associacao de regras, que aceita `regras`.
     */
    origem?: 'planner' | 'associado';
}

/** Confere a FORMA de um PI planejado. O valor devolvido tem `item` e `conduta` aparados. */
export function validarPIPlanejado(
    bruto: unknown,
    opcoes: OpcoesPIPlanejado = {}
): ResultadoValidacao<PIPlanejado, CodigoContratoPI> {
    const o = objeto(bruto);
    if (!o) return invalido([{ codigo: 'pi_nao_e_objeto', mensagem: 'o PI planejado precisa ser um objeto' }]);

    const pi = ordemValida(o.ordem) ? o.ordem : undefined;
    const erros: Problema[] = [];
    const erro = (codigo: CodigoContratoPI, mensagem: string): void => {
        erros.push({ codigo, mensagem, pi, item: textoPreenchido(o.item) ? o.item.trim() : undefined });
    };

    const aceitos = new Set<string>(CAMPOS_DO_PLANNER);
    if (opcoes.origem === 'associado') aceitos.add('regras');
    for (const campo of Object.keys(o)) {
        if (aceitos.has(campo)) continue;
        if ((CAMPOS_DO_PI_AGENT as readonly string[]).includes(campo)) {
            erro('campo_nao_permitido', `'${campo}' e decisao do PI Agent: o Planner escolhe so o par (item, conduta)`);
        } else if (campo === 'regras') {
            erro('campo_nao_permitido', "'regras' sao associadas depois da validacao da sequencia, nunca pelo Planner");
        } else {
            erro('campo_nao_permitido', `'${campo}' nao pertence ao PI planejado`);
        }
    }

    if (pi === undefined) erro('ordem_invalida', `'ordem' precisa ser inteiro >= 1 (veio ${JSON.stringify(o.ordem)})`);
    if (!textoPreenchido(o.item)) erro('item_ausente', "o PI precisa de 'item'");
    if (!textoPreenchido(o.conduta)) erro('conduta_ausente', "o PI precisa de 'conduta'");
    if (!Array.isArray(o.dependeDe) || !o.dependeDe.every(ordemValida)) {
        erro('dependencias_invalidas', "'dependeDe' precisa ser uma lista de ordens (inteiros >= 1), vazia se nao houver");
    }
    if (o.motivo !== undefined && typeof o.motivo !== 'string') erro('motivo_invalido', "'motivo' precisa ser texto");
    if (o.regras !== undefined && opcoes.origem === 'associado' && !Array.isArray(o.regras)) {
        erro('regras_invalidas', "'regras' precisa ser uma lista");
    }

    if (erros.length > 0) return invalido(erros);

    const valor: PIPlanejado = {
        ordem: pi!,
        item: (o.item as string).trim(),
        conduta: (o.conduta as string).trim(),
        dependeDe: [...(o.dependeDe as number[])]
    };
    if (o.motivo !== undefined) valor.motivo = o.motivo as string;
    if (o.regras !== undefined) valor.regras = o.regras as RegraValidada[];
    return valido(valor);
}

/**
 * Confere a FORMA da sequencia inteira: cada PI, as ordens e as dependencias.
 *
 * As ordens precisam ser exatamente 1..n, sem repeticao (a ordem do array nao
 * importa: o valor devolvido sai ordenado). Uma dependencia so pode apontar
 * para um PI ANTERIOR: e o que faz da propria `ordem` uma ordenacao
 * topologica — sem ciclo possivel, e sem precisar procurar um. Dependencia
 * repetida e so aviso: o valor devolvido vem sem a repeticao.
 *
 * Nao confere unicidade de item nem o grafo: isso e da validacao da sequencia
 * contra o conhecimento, em outra etapa.
 */
export function validarSequenciaPlanejada(
    bruto: unknown
): ResultadoValidacao<PIPlanejado[], CodigoContratoPI> {
    if (!Array.isArray(bruto)) {
        return invalido([{ codigo: 'sequencia_nao_e_lista', mensagem: 'a sequencia do Planner precisa ser uma lista de PIs' }]);
    }
    if (bruto.length === 0) {
        return invalido([{ codigo: 'sequencia_vazia', mensagem: 'a sequencia do Planner nao tem nenhum PI' }]);
    }

    const individuais = bruto.map(b => validarPIPlanejado(b));
    const errosIndividuais = individuais.flatMap(r => r.erros);
    if (errosIndividuais.length > 0) return invalido(errosIndividuais);

    const pis = individuais.map(r => r.valor!).sort((a, b) => a.ordem - b.ordem);
    const erros: Problema[] = [];
    const avisos: Problema[] = [];

    const ordens = pis.map(p => p.ordem);
    const repetidas = ordens.filter((o, i) => ordens.indexOf(o) !== i);
    for (const o of new Set(repetidas)) {
        erros.push({ codigo: 'ordem_repetida', mensagem: `a ordem ${o} aparece em mais de um PI`, pi: o });
    }
    const esperadas = pis.map((_, i) => i + 1);
    if (repetidas.length === 0 && ordens.some((o, i) => o !== esperadas[i])) {
        erros.push({
            codigo: 'ordem_fora_de_sequencia',
            mensagem: `as ordens precisam ser 1..${pis.length}, sem lacuna (vieram ${ordens.join(', ')})`
        });
    }

    const existentes = new Set(ordens);
    for (const p of pis) {
        const vistas = new Set<number>();
        for (const d of p.dependeDe) {
            const base = { pi: p.ordem, item: p.item };
            if (vistas.has(d)) {
                avisos.push({ ...base, codigo: 'dependencia_repetida', mensagem: `PI ${p.ordem} declara a dependencia ${d} mais de uma vez` });
                continue;
            }
            vistas.add(d);
            if (d === p.ordem) {
                erros.push({ ...base, codigo: 'dependencia_propria', mensagem: `PI ${p.ordem} depende de si mesmo` });
            } else if (!existentes.has(d)) {
                erros.push({ ...base, codigo: 'dependencia_inexistente', mensagem: `PI ${p.ordem} depende do PI ${d}, que nao existe na sequencia` });
            } else if (d > p.ordem) {
                erros.push({
                    ...base,
                    codigo: 'dependencia_posterior',
                    mensagem: `PI ${p.ordem} depende do PI ${d}, que vem depois: a ordem da sequencia precisa respeitar as dependencias`
                });
            }
        }
    }

    if (erros.length > 0) return invalido(erros, { avisos });
    return valido(pis.map(p => ({ ...p, dependeDe: [...new Set(p.dependeDe)] })), avisos);
}

/**
 * Confere a FORMA do resultado de um PI. Com `pi`, confere tambem que o
 * resultado responde AQUELE PI: mesma ordem, mesmo item, mesma conduta — o PI
 * Agent nao troca o par que o Planner fixou.
 */
export function validarResultadoPI(
    bruto: unknown,
    pi?: PIPlanejado
): ResultadoValidacao<ResultadoPI, CodigoContratoPI> {
    const o = objeto(bruto);
    if (!o) return invalido([{ codigo: 'resultado_nao_e_objeto', mensagem: 'o resultado do PI precisa ser um objeto', pi: pi?.ordem }]);

    const ordem = ordemValida(o.ordem) ? o.ordem : pi?.ordem;
    const erros: Problema[] = [];
    const erro = (codigo: CodigoContratoPI, mensagem: string): void => {
        erros.push({ codigo, mensagem, pi: ordem, item: textoPreenchido(o.item) ? o.item.trim() : pi?.item });
    };

    for (const campo of Object.keys(o)) {
        if (!(CAMPOS_DO_RESULTADO as readonly string[]).includes(campo)) {
            erro('campo_nao_permitido', `'${campo}' nao pertence ao resultado do PI`);
        }
    }
    if (!ordemValida(o.ordem)) erro('ordem_invalida', `'ordem' precisa ser inteiro >= 1 (veio ${JSON.stringify(o.ordem)})`);
    if (!textoPreenchido(o.item)) erro('item_ausente', "o resultado precisa de 'item'");
    if (!textoPreenchido(o.conduta)) erro('conduta_ausente', "o resultado precisa de 'conduta'");

    const acao = objeto(o.acao);
    if (!acao) {
        erro('acao_ausente', "o resultado precisa de 'acao' com decisao, meio e valor");
    } else {
        for (const campo of Object.keys(acao)) {
            if (!(CAMPOS_DA_ACAO as readonly string[]).includes(campo)) {
                erro('campo_nao_permitido', `'acao.${campo}' nao pertence a acao`);
            }
        }
        if (!textoPreenchido(acao.decisao)) erro('decisao_ausente', "a acao precisa de 'decisao'");
        if (!textoPreenchido(acao.meio)) erro('meio_ausente', "a acao precisa de 'meio'");
        const v = objeto(acao.valor);
        if (!v || typeof v.valor !== 'string' || !NUMERO.test(v.valor) || !textoPreenchido(v.unidade)) {
            erro('valor_invalido', "'acao.valor' precisa ser { valor: numero como a gramatica o escreve (ex.: '0.05'), unidade }");
        }
    }

    if (!textoPreenchido(o.justificativa)) {
        erro('justificativa_ausente', "o resultado precisa de 'justificativa'");
    } else if (o.justificativa.includes("'")) {
        // `texto ::= /'[^']*'/`: a aspa simples fecharia o literal no artefato.
        erro('justificativa_invalida', 'a justificativa nao pode conter aspa simples');
    }

    if (pi && erros.length === 0) {
        const divergentes = (['ordem', 'item', 'conduta'] as const).filter(
            c => (c === 'ordem' ? o.ordem : (o[c] as string).trim()) !== pi[c]
        );
        if (divergentes.length > 0) {
            erro('pi_divergente', `o resultado responde a outro PI: ${divergentes.map(c => `${c} ${JSON.stringify(o[c])} != ${JSON.stringify(pi[c])}`).join(', ')}`);
        }
    }

    if (erros.length > 0) return invalido(erros);

    const a = acao!;
    const v = objeto(a.valor)!;
    return valido({
        ordem: o.ordem as number,
        item: (o.item as string).trim(),
        conduta: (o.conduta as string).trim(),
        acao: {
            decisao: (a.decisao as string).trim(),
            meio: (a.meio as string).trim(),
            valor: { valor: v.valor as string, unidade: (v.unidade as string).trim() }
        },
        justificativa: o.justificativa as string
    });
}

/**
 * O resultado como texto da clausula da DSL — `ordem <item> decisao <D> dose
 * <v> <u> via <m> justificativa '<j>'`, com os literais do dominio. E o que o PI
 * Agent escreve depois do cabecalho do PI, e o que a composicao poe no artefato:
 * um so jeito de escrever uma clausula a partir de um resultado.
 */
export function textoDaClausula(r: ResultadoPI, papeis: PapeisDominio): string {
    return `${papeis.clausula} ${r.item} ${papeis.decisao} ${r.acao.decisao} ${papeis.campoQuantidade} ` +
        `${r.acao.valor.valor} ${r.acao.valor.unidade} ${papeis.meio} ${r.acao.meio} justificativa '${r.justificativa}'`;
}

/**
 * O resultado como `ClausulaLida`, para ser julgado por `verificarClausulas` —
 * o MESMO criterio que julga o artefato inteiro. A conduta nao entra: a
 * clausula fala em decisao, e e o contrato que liga uma a outra
 * (`condutaPorDecisao`).
 */
export function comoClausulaLida(r: ResultadoPI, indice = 0): ClausulaLida {
    return {
        indice,
        item: r.item,
        decisao: r.acao.decisao,
        valor: r.acao.valor.valor,
        unidade: r.acao.valor.unidade,
        meio: r.acao.meio,
        justificativa: r.justificativa
    };
}
