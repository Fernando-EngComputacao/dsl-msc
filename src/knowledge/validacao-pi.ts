/**
 * Validacao DETERMINISTICA do resultado de UM PI.
 *
 *     ResultadoPI (proposta do PI Agent)  x  ContextoGeracaoItem daquele PI
 *        -> ResultadoValidacao: VALID | INVALID | UNRESOLVED
 *
 * O Qwen PROPOE a acao e a justificativa; quem decide e isto. A entrada e so o
 * contexto do PI — o mesmo que o agente recebeu —, nada da politica global, de
 * outro PI ou do artefato: a validacao de um PI roda isolada, como a geracao.
 *
 * E UMA CAMADA DE ORQUESTRACAO, como `validacao-sequencia.ts`. O que ja tinha
 * criterio e reusado:
 *
 *   forma e identidade      validarResultadoPI (contrato-pi.ts): ordem, item e
 *                           conduta iguais aos do PI (`pi_divergente`)
 *   decisao, meio, valor    verificarClausulas (contrato.ts) sobre a politica do
 *                           PI, via comoClausulaLida — o MESMO criterio do
 *                           artefato: `decisao_inadmissivel`, `meio_inadmissivel`,
 *                           `valor_inadmissivel` (o valor por decisao)
 *   decisao x conduta       decisoesDaConduta, ja no contexto (`conduta.decisoes`)
 *   telemetria sem medida   classificar (recuperacao-politica.ts) + `Lacuna`
 *   itens citados           casamentoLexical (foco.ts)
 *
 * E acrescenta o que nao tinha criterio, so onde o conhecimento permite concluir:
 *
 *   telemetria_incompativel     a decisao e de incremento e foi tirada do item
 *                               por um bloqueio com condicao medida (a evidencia
 *                               e a condicao e o valor observado)
 *   pedido_incompativel         o pedido cita SO este item e nomeia uma decisao
 *                               admissivel dele, e o PI escolheu outra
 *   justificativa_*             a justificativa so pode afirmar o que o contexto
 *                               sustenta: numero sem fonte, medida com valor
 *                               diferente do observado, identificador que o
 *                               contexto nao tem; e, quando a conduta declara
 *                               `justificativa_obrigatoria sim`, precisa citar
 *                               alguma evidencia do contexto
 *
 * Nenhum LLM julga nada aqui. A justificativa e conferida por fatos verificaveis
 * (numeros, medidas, identificadores, ancoras de evidencia), nao por sentido: uma
 * justificativa fraca que so cita fatos verdadeiros passa; uma que afirma um fato
 * que o contexto nao tem, nao.
 *
 * INVALID x UNRESOLVED, com o mesmo criterio da validacao da sequencia: INVALID
 * quando o conhecimento basta e o resultado viola uma regra; UNRESOLVED quando
 * falta dado para decidir (medida que a regra exige, evidencia para justificar).
 * Havendo erro comprovado, INVALID prevalece.
 */

import {
    montarContrato,
    restringirADecisoes,
    verificarClausulas,
    type TipoViolacao
} from './contrato.js';
import {
    comoClausulaLida,
    validarResultadoPI,
    type CodigoContratoPI,
    type ResultadoPI
} from './contrato-pi.js';
import { comoDadoPuro, montarPromptPI } from './decompositor.js';
import { casamentoLexical, contemPalavra, normalizar, tokensDoNome } from './foco.js';
import { itensDaRelacao, type ContextoGeracaoItem } from './item-geracao.js';
import type { PoliticaItem, ValorAdmissivel } from './politica.js';
import type { RegraValidada } from './recuperacao-cypher.js';
import { explicarRegra } from './recuperacao-hibrida.js';
import { classificar } from './recuperacao-politica.js';
import {
    deViolacoes,
    invalido,
    naoResolvido,
    valido,
    type ProblemaValidacao,
    type ResultadoValidacao
} from './validacao.js';

// =============================================================================
// Codigos
// =============================================================================

/** Os codigos que esta validacao acrescenta — so onde nao havia equivalente. */
export type CodigoPI =
    /** A decisao nao e nenhuma das que realizam a conduta do PI. */
    | 'decisao_nao_realiza_conduta'
    /** A decisao e de incremento e um bloqueio com condicao medida a tirou do item. */
    | 'telemetria_incompativel'
    /** O pedido cita so este item, nomeia uma decisao admissivel dele, e o PI escolheu outra. */
    | 'pedido_incompativel'
    /** A conduta exige justificativa, e ela nao cita nenhuma evidencia do contexto. */
    | 'justificativa_sem_suporte'
    /** A justificativa afirma um numero que nao aparece em lugar nenhum do contexto. */
    | 'justificativa_valor_inexistente'
    /** A justificativa da a uma medida um valor diferente do observado, ou uma unidade que nao e a dela no contexto. */
    | 'justificativa_telemetria_divergente'
    /** A justificativa cita regra, protocolo, item, decisao ou unidade que o contexto nao tem. */
    | 'justificativa_referencia_inexistente'
    /** UNRESOLVED: uma regra que bloquearia a decisao nao pode ser avaliada sem uma medida. */
    | 'telemetria_insuficiente'
    /** UNRESOLVED: a justificativa e obrigatoria e o contexto nao tem evidencia alguma. */
    | 'evidencia_insuficiente'
    /** Aviso: o pedido cita o item, mas nao permite concluir qual decisao ele pede. */
    | 'pedido_indeterminado'
    /** Aviso: o modelo nao declara valor para a decisao — o numero segue livre. */
    | 'valor_livre';

/** Todos os codigos que a validacao de um PI pode devolver. */
export type CodigoValidacaoPI =
    | CodigoPI
    | CodigoContratoPI
    | Extract<TipoViolacao, 'item_fora_da_poda' | 'decisao_inadmissivel' | 'meio_inadmissivel' | 'valor_inadmissivel'>;

type Problema = ProblemaValidacao<CodigoValidacaoPI>;

/** Os codigos que provam que a DECISAO — e nao o valor, o meio ou o texto — nao serve a este PI. */
export const CODIGOS_DE_DECISAO: readonly CodigoValidacaoPI[] = [
    'decisao_nao_realiza_conduta',
    'decisao_inadmissivel',
    'telemetria_incompativel',
    'pedido_incompativel'
];

// =============================================================================
// Apoio
// =============================================================================

/** O contrato de UM PI: a politica dele e o mapa decisao -> conduta so da conduta dele. */
function contratoDoPI(c: ContextoGeracaoItem) {
    const conduta = c.conduta!;
    return montarContrato(
        c.subgrafoDoItem,
        Object.fromEntries(conduta.decisoes.map(d => [d, conduta.nome])),
        conduta.obrigatoriaPor
    );
}

/** O que a gramatica deixa escrever para a decisao: `por_decisao.get(d) or valores`. */
function valoresDaDecisao(politica: PoliticaItem, decisao: string): ValorAdmissivel[] {
    const mapa = politica.valoresPorDecisao ?? {};
    if (Object.keys(mapa).length === 0) return politica.valores;
    return mapa[decisao] && mapa[decisao].length > 0 ? mapa[decisao] : politica.valores;
}

/** Numeros de um texto, em valor absoluto (`4,8` e `4.8`); o sinal e ignorado, porque o hifen de um identificador nao e sinal. */
export function numerosDe(texto: string): number[] {
    return [...texto.matchAll(/(?<![A-Za-z0-9_.,])(\d+(?:[.,]\d+)?)(?!\d)/g)].map(m => Number(m[1].replace(',', '.')));
}

/** Identificadores no formato da DSL com sublinhado (`Choque_Septico`, `AUMENTAR_VAZAO`). */
function identificadoresDe(texto: string): string[] {
    return [...new Set([...texto.matchAll(/(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+(?![A-Za-z0-9_])/g)].map(m => m[0]))];
}

/** Numeros citados com unidade composta (`0.01 U/min`, `30 mL/kg`): o par numero + unidade, e onde o numero comeca. */
function quantidadesCitadasDe(texto: string): { numero: number; unidade: string; posicao: number }[] {
    return [...texto.matchAll(/(?<![A-Za-z0-9_.,])(\d+(?:[.,]\d+)?)\s*([A-Za-z%µ]+(?:\/[A-Za-z]+)+)(?![A-Za-z0-9_/])/g)]
        .map(m => ({ numero: Number(m[1].replace(',', '.')), unidade: m[2], posicao: m.index! }));
}

const escapar = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NUMERO = '-?\\d+(?:[.,]\\d+)?';
const OPERADOR = '(?:<=|>=|==|!=|<|>|=)';
const UNIDADE = '[A-Za-z%µ][A-Za-z0-9%µ]*(?:\\/[A-Za-z0-9%µ]+)*';

/**
 * A unidade de cada medida, como o CONTEXTO do PI a escreve: nas condicoes
 * avaliadas das regras (`campo` + `unidade`), nas lacunas (`> 2 mg/dL`) e nas
 * condicoes que a recuperacao gera, sempre no formato `<parametro> <observado>
 * <operador> <limite> <unidade>` (`PAM 52 < 60 mmHg`, `lactato 4.8 > 2 mmol/L`;
 * a unidade e obrigatoria nas tres gramaticas). So esse formato conta, e com o
 * observado igual ao da telemetria: texto livre da DSL nao declara unidade.
 * Chave em minusculas. Medida sem unidade no contexto fica de fora: nao ha
 * contra o que julgar.
 */
function unidadesDasMedidas(telemetria: Record<string, number>, visto: string, regras: RegraValidada[]): Map<string, Set<string>> {
    const parametros = Object.keys(telemetria);
    const unidades = new Map<string, Set<string>>();
    const anotar = (parametro: string, unidade: string | undefined): void => {
        const chave = parametro.toLowerCase();
        if (!unidade || !parametros.some(p => p.toLowerCase() === chave)) return;
        if (!unidades.has(chave)) unidades.set(chave, new Set());
        unidades.get(chave)!.add(unidade.toLowerCase());
    };
    for (const r of regras) {
        for (const c of [...r.condicoesSatisfeitas, ...r.condicoesFalhas]) anotar(c.campo, c.unidade);
        for (const l of r.lacunas) anotar(l.campo, new RegExp(`^\\s*${OPERADOR}?\\s*${NUMERO}\\s+(${UNIDADE})`).exec(l.esperado)?.[1]);
    }
    for (const p of parametros) {
        const condicao = new RegExp(`(?<![A-Za-z0-9_])${escapar(p)}\\s+(${NUMERO})\\s*${OPERADOR}\\s*${NUMERO}\\s+(${UNIDADE})`, 'gi');
        for (const m of visto.matchAll(condicao)) {
            if (iguais(Number(m[1].replace(',', '.')), telemetria[p])) anotar(p, m[2]);
        }
    }
    return unidades;
}

/**
 * As medidas citadas com unidade que nao e a delas: `<parametro> <numero>
 * <unidade>` (tambem `=` e `:`), com o parametro da telemetria do PI, a unidade
 * dele conhecida no contexto e a citada fora dela. A unidade da MEDIDA e
 * comparada com a da medida — nunca com a da acao ("lactato 2.6 mmol/L" com
 * dose em U/min e correto). O que vem depois do numero so e unidade se tiver
 * barra ou `%`, ou se for uma unidade que o contexto usa (`vocabulario`): "RASS 2
 * no protocolo" nao cita unidade. Sem NLP; caixa ignorada (`mmhg` = `mmHg`).
 * Devolve tambem onde cada numero citado comeca, para a conferencia do valor da
 * acao nao julgar de novo uma medida.
 */
function unidadesDivergentes(
    texto: string,
    parametros: string[],
    unidades: Map<string, Set<string>>,
    vocabulario: Set<string>
): { divergentes: { parametro: string; citadas: string[]; esperadas: string[] }[]; posicoesDeMedida: Set<number> } {
    const divergentes: { parametro: string; citadas: string[]; esperadas: string[] }[] = [];
    const posicoesDeMedida = new Set<number>();
    for (const p of parametros) {
        const citacao = new RegExp(`(?<![A-Za-z0-9_])${escapar(p)}\\s*(?:[=:]\\s*)?(\\d+(?:[.,]\\d+)?)(?:\\s*(${UNIDADE}))?`, 'gi');
        const citadas: string[] = [];
        for (const m of texto.matchAll(citacao)) {
            // A citacao comeca pelo parametro; o numero e o primeiro digito depois dele.
            posicoesDeMedida.add(m.index! + p.length + m[0].slice(p.length).search(/\d/));
            const unidade = m[2];
            if (!unidade) continue;
            const eUnidade = /[/%]/.test(unidade) || vocabulario.has(unidade.toLowerCase());
            const esperadas = unidades.get(p.toLowerCase());
            if (eUnidade && esperadas && !esperadas.has(unidade.toLowerCase())) citadas.push(unidade);
        }
        if (citadas.length > 0) {
            divergentes.push({ parametro: p, citadas: [...new Set(citadas)], esperadas: [...unidades.get(p.toLowerCase())!] });
        }
    }
    return { divergentes, posicoesDeMedida };
}

/** Ids de regra no formato do Cypher (`Farmaco:Propofol/RegraSeguranca/PAM<60`). */
function idsDeRegraDe(texto: string): string[] {
    return [...texto.matchAll(/[A-Z][A-Za-z]*:[A-Za-z0-9_]+\/[A-Za-z]+\/[^\s,;)]+/g)].map(m => m[0]);
}

const iguais = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

/**
 * As medidas que o texto afirma com valor diferente do observado: cada
 * `<parametro> <numero>` (ou `<parametro>=<numero>`, `<parametro>: <numero>`)
 * cujo numero nao e o da telemetria. So a forma adjacente conta — "PAM abaixo
 * de 60" fala do limiar, nao da medida.
 */
export function medidasDivergentes(
    texto: string,
    telemetria: Record<string, number>
): { parametro: string; observado: number; citados: number[] }[] {
    const saida: { parametro: string; observado: number; citados: number[] }[] = [];
    for (const [parametro, observado] of Object.entries(telemetria)) {
        const escapado = parametro.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const citados = [...texto.matchAll(new RegExp(`(?<![A-Za-z0-9_])${escapado}\\s*(?:[=:]\\s*)?(\\d+(?:[.,]\\d+)?)`, 'gi'))]
            .map(m => Number(m[1].replace(',', '.')))
            .filter(n => !iguais(n, Math.abs(observado)));
        if (citados.length > 0) saida.push({ parametro, observado, citados });
    }
    return saida;
}

/**
 * Decisoes que o pedido nomeia. Pelo nome inteiro (`casamentoLexical`, o mesmo
 * criterio do foco); sem nenhuma assim, pela primeira palavra do nome, inteira
 * (`reduzir` -> REDUZIR_VAZAO). Nada aproximado: `reduz` nao e `reduzir`, e
 * quando o pedido nao usa a palavra, nada se conclui.
 */
export function decisoesCitadasNoPedido(pedido: string, universo: string[]): string[] {
    const inteiras = casamentoLexical(pedido, universo);
    if (inteiras.size > 0) return [...inteiras];
    const texto = normalizar(pedido);
    return universo.filter(d => {
        const primeira = tokensDoNome(d)[0];
        return primeira !== undefined && primeira.length >= 4 && contemPalavra(texto, primeira);
    });
}

/**
 * As ancoras de evidencia do PI: o que uma justificativa pode citar para ter
 * suporte minimo — parametros da telemetria relevante, contextos e regras que
 * sustentam os fatos, outros itens das regras relacionais, e as palavras
 * distintivas (6+ letras) do pedido, das restricoes e dos fatos, fora os nomes
 * do proprio par. O pedido conta: o que o usuario relatou e evidencia do caso
 * (em fut, muitas vezes a unica). Normalizadas, para o casamento por palavra
 * inteira.
 */
function ancorasDeEvidencia(c: ContextoGeracaoItem): string[] {
    const doPar = new Set(
        [c.pi!.item, c.pi!.conduta, ...c.decisoes.admissiveis, ...c.conduta!.decisoes].flatMap(tokensDoNome)
    );
    const nomes = [
        ...Object.keys(c.telemetriaRelevante),
        ...c.fatos.map(f => f.contexto).filter((x): x is string => Boolean(x)),
        ...c.regras.flatMap(r => [r.regraId, r.item]),
        ...c.regrasRelacionais.flatMap(itensDaRelacao).filter(i => i !== c.pi!.item)
    ].map(n => tokensDoNome(n).join(' ')).filter(n => n.length > 0);
    const palavras = [c.pedido, ...c.restricoes, ...c.fatos.map(f => f.descricao)]
        .flatMap(t => normalizar(t).split(' '))
        .filter(p => p.length >= 6 && !/^\d/.test(p) && !doPar.has(p));
    return [...new Set([...nomes, ...palavras])];
}

// =============================================================================
// Validacao
// =============================================================================

/**
 * Julga o resultado de UM PI contra o contexto DAQUELE PI. Todos os erros vao
 * juntos — o feedback ao PI Agent precisa de todos —, cada um com o PI, o item,
 * a conduta, a regra e, quando ha, a evidencia e o que o contexto admite. Nada
 * e corrigido: o valor, quando VALID, e o proprio resultado.
 *
 * Lanca se o contexto nao for de um PI (sem `pi` ou `conduta`): e erro de uso.
 */
export function validarPI(
    resultado: ResultadoPI,
    c: ContextoGeracaoItem
): ResultadoValidacao<ResultadoPI, CodigoValidacaoPI> {
    if (!c.pi || !c.conduta) throw new Error('validarPI recebe o contexto de um PI (saida de decomporPIs)');
    const pi = c.pi;
    const conduta = c.conduta;

    // ------------------------------------------------------------ 1. forma e identidade
    const forma = validarResultadoPI(resultado, pi);
    if (forma.veredito !== 'VALID') {
        return invalido(forma.erros, { avisos: forma.avisos, promptRecomendado: relatorioDoPI(forma.erros) });
    }
    const r = forma.valor!;
    const D = r.acao.decisao;
    const base = { pi: pi.ordem, item: pi.item, conduta: pi.conduta };
    const erros: Problema[] = [];
    const avisos: Problema[] = [];
    const faltas: string[] = [];
    const incrementos = new Set(c.subgrafoDoItem.papeis.decisoesDeIncremento);

    // ------------------------------------------------------------ 2. decisao
    if (!conduta.decisoes.includes(D)) {
        erros.push({
            ...base, codigo: 'decisao_nao_realiza_conduta', reparo: { item: pi.item, decisao: D },
            regra: `${pi.conduta} se realiza por ${conduta.decisoes.join(' ou ')}`,
            mensagem: `${D} nao realiza a conduta ${pi.conduta}, que o Planner fixou para este PI`,
            alternativas: c.decisoes.admissiveis
        });
    } else if (!c.decisoes.admissiveis.includes(D)) {
        const bloqueio = bloqueioPorMedida(c, D);
        if (bloqueio) {
            erros.push({
                ...base, codigo: 'telemetria_incompativel', reparo: { item: pi.item, decisao: D },
                regra: bloqueio.regra,
                mensagem: `${D} aumenta a exposicao a ${pi.item}, e a telemetria observada o bloqueia`,
                evidencias: bloqueio.evidencias,
                alternativas: c.decisoes.admissiveis
            });
        }
    }

    // ------------------------------------------------------------ 3. clausula (so se a decisao passou)
    if (erros.length === 0) {
        const clausula = deViolacoes(verificarClausulas(contratoDoPI(c), [comoClausulaLida(r)]), pi.ordem);
        for (const e of clausula.erros) {
            // Com UMA clausula, verificarClausulas so chega a item_fora_da_poda,
            // decisao_inadmissivel, meio_inadmissivel e valor_inadmissivel:
            // item_repetido exige duas.
            const problema: Problema = { ...e, codigo: e.codigo as CodigoValidacaoPI, conduta: pi.conduta };
            if (e.codigo === 'decisao_inadmissivel') {
                problema.evidencias = [...c.restricoes];
                problema.alternativas = c.decisoes.admissiveis;
            } else if (e.codigo === 'valor_inadmissivel') {
                problema.regra = `${D} admite ${valoresDaDecisao(c.item, D).map(v => `${v.valor} ${v.unidade}`).join(', ')}`;
                problema.alternativas = valoresDaDecisao(c.item, D).map(v => `${v.valor} ${v.unidade}`);
            } else if (e.codigo === 'meio_inadmissivel') {
                problema.alternativas = c.meios.admissiveis;
            }
            erros.push(problema);
        }
        if (c.decisoes.admissiveis.includes(D) && valoresDaDecisao(c.item, D).length === 0) {
            avisos.push({ ...base, codigo: 'valor_livre', mensagem: `o modelo nao declara valor para ${D}: ${r.acao.valor.valor} ${r.acao.valor.unidade} nao e conferido` });
        }
    }

    // ------------------------------------------------------------ 4. telemetria sem medida
    // A mesma pergunta da validacao da sequencia: a decisao e de incremento, e
    // uma regra que a bloquearia nao pode ser avaliada porque a medida nao veio.
    if (erros.length === 0 && incrementos.has(D)) {
        const semMedida = c.regras.filter(
            x => x.item === pi.item && x.lacunas.length > 0 &&
                classificar({ ...x, lacunas: [], aplicavel: true }) === 'bloqueio_condicional'
        );
        for (const x of semMedida) {
            faltas.push(...x.lacunas.map(l => `telemetria.${l.campo}`));
            avisos.push({
                ...base, codigo: 'telemetria_insuficiente', regra: x.regraId, evidencias: [explicarRegra(x)],
                mensagem: `${D} aumenta a exposicao, e a regra ${x.regraId}, que o bloquearia, nao pode ser avaliada sem ${x.lacunas.map(l => l.campo).join(', ')}`
            });
        }
    }

    // ------------------------------------------------------------ 5. pedido
    const pedido = conferirPedido(c, D);
    if (pedido.erro) erros.push({ ...base, ...pedido.erro });
    if (pedido.aviso) avisos.push({ ...base, ...pedido.aviso });

    // ------------------------------------------------------------ 6. justificativa
    const justificativa = conferirJustificativa(c, r);
    erros.push(...justificativa.erros.map(e => ({ ...base, ...e })));
    if (justificativa.falta) {
        faltas.push(justificativa.falta.dado);
        avisos.push({ ...base, ...justificativa.falta.aviso });
    }

    // ------------------------------------------------------------ veredito
    if (erros.length > 0) return invalido(erros, { avisos, promptRecomendado: relatorioDoPI(erros) });
    if (faltas.length > 0) return naoResolvido([...new Set(faltas)], { avisos, promptRecomendado: relatorioDoPI(avisos) });
    return valido(r, avisos);
}

/**
 * O bloqueio medido que tirou uma decisao de incremento do item: fato de
 * bloqueio com condicao observada, ou `RegraValidada` restritiva que incide. A
 * evidencia e a condicao e, para cada parametro dela, o valor observado.
 * `undefined` quando a decisao nao e de incremento ou nada medido a bloqueia —
 * ai a decisao foi tirada por outra razao (estado de curso, veto), e o criterio
 * e o de `verificarClausulas`.
 */
function bloqueioPorMedida(c: ContextoGeracaoItem, decisao: string): { regra: string; evidencias: string[] } | undefined {
    if (!c.subgrafoDoItem.papeis.decisoesDeIncremento.includes(decisao)) return undefined;
    const fatos = c.fatos.filter(f => f.tipo === 'bloqueio' && f.condicoes.length > 0);
    const regras = c.regras.filter(x => x.item === c.pi!.item && classificar(x) === 'bloqueio_condicional');
    if (fatos.length === 0 && regras.length === 0) return undefined;

    const condicoes = [...fatos.flatMap(f => f.condicoes), ...regras.map(explicarRegra)];
    const texto = normalizar(condicoes.join(' '));
    const medidas = Object.entries(c.telemetriaRelevante)
        .filter(([p]) => contemPalavra(texto, tokensDoNome(p).join(' ')))
        .map(([p, v]) => `${p} = ${v}`);
    return {
        regra: [...fatos.map(f => f.descricao), ...regras.map(x => x.regraId)].join('; '),
        evidencias: [...condicoes, ...medidas]
    };
}

/** Pedido x decisao — so onde o pedido permite concluir. Ver `decisoesCitadasNoPedido`. */
function conferirPedido(
    c: ContextoGeracaoItem,
    decisao: string
): { erro?: Omit<Problema, 'pi' | 'item' | 'conduta'>; aviso?: Omit<Problema, 'pi' | 'item' | 'conduta'> } {
    const item = c.pi!.item;
    const conhecidos = [...new Set([item, ...c.relacoes.map(x => x.item), ...c.regrasRelacionais.flatMap(itensDaRelacao)])];
    const citados = casamentoLexical(c.pedido, conhecidos);
    if (!citados.has(item)) return {};
    if (citados.size > 1) {
        return { aviso: { codigo: 'pedido_indeterminado', mensagem: `o pedido cita ${[...citados].join(', ')}: nao se conclui qual decisao ele pede para ${item}` } };
    }
    const universo = [...new Set([...c.decisoes.admissiveis, ...c.decisoes.bloqueadas, ...c.decisoes.foraDaConduta, ...c.conduta!.decisoes])];
    const pedidas = decisoesCitadasNoPedido(c.pedido, universo);
    if (pedidas.length === 0 || pedidas.includes(decisao)) {
        return pedidas.length === 0
            ? { aviso: { codigo: 'pedido_indeterminado', mensagem: `o pedido cita ${item}, mas nao nomeia decisao` } }
            : {};
    }
    const atendiveis = pedidas.filter(d => c.decisoes.admissiveis.includes(d));
    if (atendiveis.length === 0) {
        return { aviso: { codigo: 'pedido_indeterminado', mensagem: `o pedido nomeia ${pedidas.join(', ')}, que nao e admissivel neste PI` } };
    }
    return {
        erro: {
            codigo: 'pedido_incompativel', reparo: { item, decisao },
            regra: `o pedido nomeia ${atendiveis.join(', ')} para ${item}, e ${atendiveis.length > 1 ? 'elas sao admissiveis' : 'ela e admissivel'} neste PI`,
            mensagem: `o pedido pede ${atendiveis.join(' ou ')} para ${item}, e o PI decidiu ${decisao}`,
            evidencias: [`pedido: ${c.pedido}`],
            alternativas: atendiveis
        }
    };
}

/**
 * A justificativa so afirma o que o contexto sustenta. O que o agente recebeu e
 * o prompt do PI (`montarPromptPI`, funcao pura do contexto): e contra ele que
 * numeros e identificadores sao conferidos.
 */
function conferirJustificativa(
    c: ContextoGeracaoItem,
    r: ResultadoPI
): {
    erros: Omit<Problema, 'pi' | 'item' | 'conduta'>[];
    falta?: { dado: string; aviso: Omit<Problema, 'pi' | 'item' | 'conduta'> };
} {
    const texto = r.justificativa;
    const visto = montarPromptPI(c);
    const erros: Omit<Problema, 'pi' | 'item' | 'conduta'>[] = [];

    // Numero sem fonte: nao aparece no que o agente recebeu.
    const conhecidos = [...numerosDe(visto), ...Object.values(c.telemetriaRelevante).map(Math.abs)];
    const semFonte = [...new Set(numerosDe(texto).filter(n => !conhecidos.some(k => iguais(k, n))))];
    if (semFonte.length > 0) {
        erros.push({
            codigo: 'justificativa_valor_inexistente',
            mensagem: `a justificativa afirma ${semFonte.join(', ')}, que nao aparece(m) em nenhum dado deste PI`,
            evidencias: [`justificativa: ${texto}`]
        });
    }

    // Medida com valor trocado: `<parametro> <numero>` com o numero diferente do observado.
    for (const d of medidasDivergentes(texto, c.telemetriaRelevante)) {
        erros.push({
            codigo: 'justificativa_telemetria_divergente',
            mensagem: `a justificativa da ${d.parametro} ${d.citados.join(', ')}, e o observado e ${d.observado}`,
            evidencias: [`${d.parametro} = ${d.observado}`]
        });
    }

    // Duas conferencias de unidade, cada uma contra a SUA referencia:
    //   - a de uma MEDIDA ("lactato 4.8 mmol/L") contra a unidade daquela medida
    //     no contexto — nunca contra a da acao, o que dava falso positivo no Qwen
    //     real ("lactato 2.6 mmol/L" com dose em U/min);
    //   - a do VALOR da acao (`0.01 U/mL` quando a dose e em U/min, visto no Qwen
    //     real) contra as unidades que o contexto usa.
    const valoresDoPI = [...c.valores.gerais, ...Object.values(c.valores.porDecisao).flat()];
    const parametros = Object.keys(c.telemetriaRelevante);
    const unidadesMedidas = unidadesDasMedidas(c.telemetriaRelevante, visto, c.regras);
    const unidadesVistas = new Set([
        ...valoresDoPI.map(v => v.unidade), ...c.item.unidades,
        ...[...visto.matchAll(/[A-Za-z%µ]+(?:\/[A-Za-z]+)+/g)].map(m => m[0])
    ]);
    const vocabulario = new Set([...unidadesVistas, ...[...unidadesMedidas.values()].flatMap(u => [...u])].map(u => u.toLowerCase()));
    const { divergentes, posicoesDeMedida } = unidadesDivergentes(texto, parametros, unidadesMedidas, vocabulario);
    for (const d of divergentes) {
        erros.push({
            codigo: 'justificativa_telemetria_divergente',
            mensagem: `a justificativa da ${d.parametro} em ${d.citadas.join(', ')}, e o contexto mede ${d.parametro} em ${d.esperadas.join(', ')}`,
            evidencias: d.esperadas.map(u => `${d.parametro}: ${c.telemetriaRelevante[d.parametro]} ${u}`)
        });
    }

    // Referencia que o contexto nao tem: identificador da DSL, id de regra, ou o
    // valor da acao com unidade que o contexto nao usa. O numero de uma medida ja
    // foi julgado acima, pela unidade da medida.
    const idsVistos = new Set(identificadoresDe(visto));
    const regrasVistas = new Set(c.regras.map(x => x.regraId));
    const valorComUnidadeTrocada = quantidadesCitadasDe(texto)
        .filter(q => !posicoesDeMedida.has(q.posicao))
        .filter(q => valoresDoPI.some(v => iguais(Number(v.valor), q.numero)) && !unidadesVistas.has(q.unidade))
        .map(q => `${q.numero} ${q.unidade}`);
    const estranhos = [
        ...identificadoresDe(texto).filter(i => !idsVistos.has(i)),
        ...idsDeRegraDe(texto).filter(i => !regrasVistas.has(i)),
        ...valorComUnidadeTrocada
    ];
    if (estranhos.length > 0) {
        erros.push({
            codigo: 'justificativa_referencia_inexistente',
            mensagem: `a justificativa cita ${[...new Set(estranhos)].join(', ')}, que nao esta(o) no contexto deste PI`,
            evidencias: [`justificativa: ${texto}`]
        });
    }

    // Suporte minimo — so quando a conduta o declara. `justificativa_obrigatoria`
    // nao tinha semantica no projeto; a que se aplica e a minima: citar alguma
    // evidencia do contexto.
    if (c.conduta!.atributos.justificativa_obrigatoria === 'sim') {
        const ancoras = ancorasDeEvidencia(c);
        if (ancoras.length === 0) {
            return {
                erros,
                falta: {
                    dado: `evidencia para justificar ${r.acao.decisao}`,
                    aviso: {
                        codigo: 'evidencia_insuficiente',
                        mensagem: `${c.pi!.conduta} declara justificativa_obrigatoria sim, e o contexto do PI nao tem telemetria, regra nem fato que a sustente`
                    }
                }
            };
        }
        const normalizada = normalizar(texto);
        if (!ancoras.some(a => contemPalavra(normalizada, a))) {
            erros.push({
                codigo: 'justificativa_sem_suporte',
                regra: `${c.pi!.conduta} declara justificativa_obrigatoria sim`,
                mensagem: 'a justificativa nao cita nenhuma evidencia do contexto (telemetria, regra, protocolo ou restricao)',
                evidencias: [`justificativa: ${texto}`],
                alternativas: ancoras.slice(0, 12)
            });
        }
    }
    return { erros };
}

// =============================================================================
// Realimentacao
// =============================================================================

function linhasDoProblema(e: Problema): string[] {
    const linhas = [`- ${e.codigo}: ${e.mensagem}`];
    if (e.regra) linhas.push(`  regra: ${e.regra}`);
    for (const ev of e.evidencias ?? []) linhas.push(`  evidencia: ${ev}`);
    if (e.alternativas && e.alternativas.length > 0) linhas.push(`  permitido: ${e.alternativas.join(', ')}`);
    return linhas;
}

/** Os problemas de um PI em texto — a parte factual do feedback ao PI Agent. */
export function relatorioDoPI(problemas: Problema[]): string {
    return problemas.flatMap(linhasDoProblema).join('\n');
}

/**
 * A restricao da proxima tentativa do MESMO PI: cada decisao que a validacao
 * comprovadamente reprovou (`CODIGOS_DE_DECISAO`) sai das admissiveis. So ela:
 * erro de valor, de meio ou de texto nao e culpa da decisao, e nenhuma outra e
 * tirada. Nunca esvazia o PI — se tirar a decisao nao deixaria nenhuma, ela
 * fica, e o orcamento decide.
 *
 * O contexto original nao muda: a vista restrita e uma copia congelada, com a
 * decisao passada de `admissiveis` para `bloqueadas` (a particao do universo se
 * mantem) e o motivo acrescentado as `restricoes` — que a proxima tentativa ve
 * no prompt e a validacao usa como evidencia.
 */
export function restringirAposErrosPI(
    c: ContextoGeracaoItem,
    validacao: ResultadoValidacao
): { contexto: ContextoGeracaoItem; proibidas: string[] } {
    const reprovadas = new Map<string, string>();
    for (const e of validacao.erros) {
        const d = e.reparo?.decisao;
        if (d && (CODIGOS_DE_DECISAO as readonly string[]).includes(e.codigo) && c.decisoes.admissiveis.includes(d)) {
            reprovadas.set(d, `${d} reprovada pela validacao deste PI (${e.codigo}): ${e.mensagem}`);
        }
    }
    const restantes = c.decisoes.admissiveis.filter(d => !reprovadas.has(d));
    if (reprovadas.size === 0 || restantes.length === 0) return { contexto: c, proibidas: [] };

    const fica = (d: string): boolean => restantes.includes(d);
    const porDecisao = Object.fromEntries(Object.entries(c.valores.porDecisao).filter(([d]) => fica(d)));
    const mapaDoItem = Object.fromEntries(Object.entries(c.item.valoresPorDecisao ?? {}).filter(([d]) => fica(d)));
    const item: PoliticaItem = { ...c.item, decisoes: restantes, valoresPorDecisao: mapaDoItem };
    return {
        contexto: comoDadoPuro({
            ...c,
            item,
            subgrafoDoItem: { ...restringirADecisoes(c.subgrafoDoItem, restantes), politicas: [item] },
            decisoes: { ...c.decisoes, admissiveis: restantes, bloqueadas: [...c.decisoes.bloqueadas, ...reprovadas.keys()] },
            valores: { ...c.valores, porDecisao },
            restricoes: [...c.restricoes, ...reprovadas.values()]
        }),
        proibidas: [...reprovadas.keys()]
    };
}
