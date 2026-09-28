/**
 * Resultado de validacao COMUM aos validadores da arquitetura multiagente
 * (sequencia do Planner, PI individual, artefato composto).
 *
 * Tres vereditos, e o terceiro e o que o projeto ainda nao tinha como resposta
 * de um validador:
 *
 *   VALID       conferido, e passou. Sem erro e sem dado faltante.
 *   INVALID     conferido, e falhou: pelo menos um erro, cada um com codigo,
 *               mensagem e, quando se sabe, o PI e o item afetados.
 *   UNRESOLVED  NAO deu para conferir, porque falta dado. Nao e aprovacao nem
 *               reprovacao. E a postura de `Lacuna` (recuperacao-cypher.ts) e
 *               de `retrieveConstraints` — "ausencia de medida nao e evidencia
 *               de normalidade, mas tambem nao autoriza bloquear" — levada ao
 *               veredito de um validador.
 *
 * `Violacao` (contrato.ts) continua sendo a moeda do contrato do artefato.
 * `deViolacoes` a converte sem perda — o `reparo` viaja junto — e usa
 * `relatorioDeViolacoes` como prompt recomendado, em vez de redigir outro texto.
 *
 * O codigo e generico (`K`): cada validador declara a sua uniao fechada de
 * codigos (`TipoViolacao`, `CodigoContratoPI`, ...) e o tipo carrega isso, sem
 * que este modulo precise conhecer todos.
 */

import { relatorioDeViolacoes, type TipoViolacao, type Violacao } from './contrato.js';

export type Veredito = 'VALID' | 'INVALID' | 'UNRESOLVED';

export const VEREDITOS: readonly Veredito[] = ['VALID', 'INVALID', 'UNRESOLVED'];

export interface ProblemaValidacao<K extends string = string> {
    codigo: K;
    mensagem: string;
    /** `ordem` do PI afetado. Ausente quando o problema e do conjunto. */
    pi?: number;
    /** Os PIs envolvidos, quando o problema nasce da combinacao de mais de um (validacao global). */
    pis?: number[];
    /** Item afetado, quando se sabe. */
    item?: string;
    /** O que retirar da politica antes de tentar de novo — o mesmo de `Violacao`. */
    reparo?: Violacao['reparo'];
    /** Conduta afetada, quando se sabe (validacao da sequencia do Planner). */
    conduta?: string;
    /** A regra do conhecimento que sustenta o veredito, em forma legivel. */
    regra?: string;
    /** O que foi observado: motivos da politica, condicoes avaliadas pelo Cypher. */
    evidencias?: string[];
    /** O que o conhecimento admite no lugar — nunca escolhido pelo validador, so informado. */
    alternativas?: string[];
}

export interface ResultadoValidacao<T = unknown, K extends string = string> {
    veredito: Veredito;
    /** Nao vazio se e somente se INVALID. */
    erros: ProblemaValidacao<K>[];
    /** Nao bloqueiam: registram o que foi aceito com ressalva. */
    avisos: ProblemaValidacao<K>[];
    /** Dados que faltaram para decidir. Nao vazio se e somente se UNRESOLVED. */
    dadosFaltantes: string[];
    /** Texto para reentrar no prompt da proxima tentativa, quando aplicavel. */
    promptRecomendado?: string;
    /** O valor ja conferido e tipado. So em VALID. */
    valor?: T;
}

export interface OpcoesResultado<K extends string> {
    avisos?: ProblemaValidacao<K>[];
    promptRecomendado?: string;
}

export function valido<T, K extends string = string>(
    valor?: T,
    avisos: ProblemaValidacao<K>[] = []
): ResultadoValidacao<T, K> {
    return { veredito: 'VALID', erros: [], avisos, dadosFaltantes: [], valor };
}

/** Lanca se `erros` vier vazio: INVALID sem motivo nao e um veredito, e um defeito do validador. */
export function invalido<T = never, K extends string = string>(
    erros: ProblemaValidacao<K>[],
    opcoes: OpcoesResultado<K> = {}
): ResultadoValidacao<T, K> {
    if (erros.length === 0) throw new Error('resultado INVALID exige pelo menos um erro');
    return {
        veredito: 'INVALID',
        erros,
        avisos: opcoes.avisos ?? [],
        dadosFaltantes: [],
        promptRecomendado: opcoes.promptRecomendado
    };
}

/** Lanca se `dadosFaltantes` vier vazio: UNRESOLVED precisa dizer o que faltou. */
export function naoResolvido<T = never, K extends string = string>(
    dadosFaltantes: string[],
    opcoes: OpcoesResultado<K> = {}
): ResultadoValidacao<T, K> {
    if (dadosFaltantes.length === 0) throw new Error('resultado UNRESOLVED exige pelo menos um dado faltante');
    return {
        veredito: 'UNRESOLVED',
        erros: [],
        avisos: opcoes.avisos ?? [],
        dadosFaltantes,
        promptRecomendado: opcoes.promptRecomendado
    };
}

/**
 * O que ha de errado com um resultado. Vazio quando ele e coerente. Existe
 * porque o resultado vai cruzar fronteiras (auditoria, API, testes) e pode ser
 * montado a mao; os construtores acima ja o produzem coerente.
 */
export function incoerencias(r: ResultadoValidacao): string[] {
    const achados: string[] = [];
    if (!VEREDITOS.includes(r.veredito)) achados.push(`veredito desconhecido: ${String(r.veredito)}`);
    if (r.veredito === 'INVALID' && r.erros.length === 0) achados.push('INVALID sem erro');
    if (r.veredito !== 'INVALID' && r.erros.length > 0) achados.push(`${r.veredito} com erro`);
    if (r.veredito === 'UNRESOLVED' && r.dadosFaltantes.length === 0) achados.push('UNRESOLVED sem dado faltante');
    if (r.veredito !== 'UNRESOLVED' && r.dadosFaltantes.length > 0) achados.push(`${r.veredito} com dado faltante`);
    if (r.veredito !== 'VALID' && r.valor !== undefined) achados.push(`${r.veredito} com valor`);
    return achados;
}

/**
 * Junta os vereditos de validadores independentes. Um INVALID reprova o
 * conjunto; sem INVALID, um UNRESOLVED o deixa sem decisao; so todos VALID
 * aprovam. O `valor` de cada parte nao sobrevive: o conjunto nao e nenhuma
 * delas.
 */
export function combinar<K extends string>(resultados: ResultadoValidacao<unknown, K>[]): ResultadoValidacao<never, K> {
    const erros = resultados.flatMap(r => r.erros);
    const avisos = resultados.flatMap(r => r.avisos);
    const dadosFaltantes = [...new Set(resultados.flatMap(r => r.dadosFaltantes))];
    const prompts = resultados.map(r => r.promptRecomendado).filter((p): p is string => Boolean(p));
    const promptRecomendado = prompts.length > 0 ? prompts.join('\n\n') : undefined;

    if (erros.length > 0) return invalido(erros, { avisos, promptRecomendado });
    if (dadosFaltantes.length > 0) return naoResolvido(dadosFaltantes, { avisos, promptRecomendado });
    return { ...valido<never, K>(undefined, avisos), promptRecomendado };
}

/**
 * `Violacao[]` do contrato do artefato no formato comum. Vazio -> VALID.
 * `pi` e a ordem do PI a quem as violacoes pertencem, quando o chamador sabe.
 */
export function deViolacoes(violacoes: Violacao[], pi?: number): ResultadoValidacao<never, TipoViolacao> {
    if (violacoes.length === 0) return valido();
    return invalido(
        violacoes.map(v => ({
            codigo: v.tipo,
            mensagem: v.mensagem,
            pi,
            item: v.reparo?.item,
            reparo: v.reparo
        })),
        { promptRecomendado: relatorioDeViolacoes(violacoes) }
    );
}
