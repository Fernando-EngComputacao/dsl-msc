/**
 * Scheduler dos PIs: a sequencia validada vista como DAG, e as ONDAS de execucao.
 *
 *     PIPlanejado[] (SEQUENCE_VALID)
 *        -> planejarExecucaoPI   grafo: predecessores, sucessores, validacao estrutural
 *        -> ondas                camadas do DAG (Kahn por camadas), na ordem do Planner
 *        -> executarOndas        onda por onda; um PI so entra com TODOS os
 *                                predecessores VALID
 *
 * O Planner e a autoridade sobre ordem, item, conduta e dependencias: o grafo
 * tem exatamente as arestas de `dependeDe`, nenhuma inventada. A ordem do PI nao
 * e dependencia — PIs posteriores sem dependencia entre si ficam na mesma onda.
 * Dentro de uma onda, a ordem e a do Planner; a composicao continua na ordem do
 * Planner, qualquer que tenha sido a da execucao.
 *
 * Deterministico e sem modelo: nao conhece o Qwen, o motor nem o prompt. Quem
 * resolve um PI (com o seu retry) e o `resolver` que o PI Agent entrega; o
 * scheduler so decide QUEM pode rodar e QUANDO.
 *
 * SEM CONCORRENCIA FISICA. `executarOndas` resolve os PIs de uma onda um por
 * vez (`for ... await`): o scheduler diz que PI 1, 2 e 3 sao independentes; se
 * eles podem rodar ao mesmo tempo e problema da infraestrutura, de outra etapa.
 * Nada de `Promise.all`, worker ou processo; o `_LLAMA_LOCK` do motor nao muda.
 */

import type { CodigoContratoPI, PIPlanejado } from '../knowledge/contrato-pi.js';
import { comoDadoPuro } from '../knowledge/decompositor.js';
import { invalido, valido, type ProblemaValidacao, type ResultadoValidacao } from '../knowledge/validacao.js';
import type { StatusPI } from './multiagente.js';

// =============================================================================
// Contrato
// =============================================================================

/**
 * O que o scheduler le de um PI: a ordem e as dependencias — o proprio
 * `PIPlanejado`, sem copia de tipo.
 */
export type NoPI = Pick<PIPlanejado, 'ordem' | 'dependeDe'>;

/**
 * Os codigos do grafo: os mesmos da forma da sequencia (`validarSequenciaPlanejada`),
 * que ja os confere — o scheduler confere de novo, sobre o grafo —, e o ciclo,
 * que so o grafo ve.
 */
export type CodigoGrafoPI =
    | Extract<CodigoContratoPI, 'ordem_repetida' | 'dependencia_propria' | 'dependencia_inexistente' | 'dependencia_posterior' | 'dependencia_repetida'>
    | 'ciclo_de_dependencias';

/** Uma onda: PIs cujos predecessores estao todos em ondas anteriores. */
export interface OndaPI {
    indice: number;
    /** As ordens da onda, na ordem do Planner. */
    ordens: number[];
}

/** O formato do DAG — para medir, adiante, o paralelismo possivel. Sem speedup. */
export interface MetricasDAG {
    pis: number;
    /** Arestas de dependencia, sem repeticao. */
    arestas: number;
    ondas: number;
    /** A maior onda: quantos PIs poderiam, no maximo, rodar juntos. */
    larguraMaxima: number;
    /** PIs no caminho de dependencias mais longo. Com ondas por camada, e o numero de ondas. */
    profundidade: number;
    pisPorOnda: number[];
}

/** O DAG dos PIs e as ondas. Dado puro e congelado: decidido uma vez por ciclo. */
export interface PlanoExecucaoPI {
    /** As ordens, na ordem do Planner. */
    ordens: number[];
    /** De quem cada PI depende (sem repeticao), na ordem do Planner. */
    predecessores: Record<number, number[]>;
    /** Quem depende de cada PI, na ordem do Planner. */
    sucessores: Record<number, number[]>;
    ondas: OndaPI[];
    /** O indice da onda de cada PI. */
    ondaDoPI: Record<number, number>;
    metricas: MetricasDAG;
    /** O que foi normalizado (dependencia repetida). */
    avisos: ProblemaValidacao<CodigoGrafoPI>[];
}

/** Onde cada onda esta na execucao. */
export type StatusOndaPI = 'PENDENTE' | 'EM_EXECUCAO' | 'CONCLUIDA' | 'INTERROMPIDA' | 'NAO_EXECUTADA';

/** O registro de UMA onda na execucao: o que rodou, o que ficou bloqueado, quanto durou. */
export interface RegistroOndaPI {
    indice: number;
    ordens: number[];
    /** Os predecessores de cada PI da onda. */
    dependencias: Record<number, number[]>;
    status: StatusOndaPI;
    /** Da primeira chamada ao fim do ultimo PI resolvido (retries incluidos). */
    duracaoMs?: number;
    /** Os PIs que rodaram, na ordem em que rodaram. */
    executados: number[];
    /** Os PIs que nao podem rodar: algum predecessor terminou sem ser VALID. */
    bloqueados: number[];
}

/**
 * Como um PI termina para o scheduler — o `StatusPI` final: VALID, INVALID (o
 * orcamento do PI acabou reprovado) ou UNRESOLVED. Os retries acontecem DENTRO
 * do `resolver`: o scheduler so ve o desfecho.
 */
export type DesfechoPI = Extract<StatusPI, 'VALID' | 'INVALID' | 'UNRESOLVED'>;

/** Resolve UM PI, com o seu retry, e devolve o desfecho. Falha tecnica sobe como excecao. */
export type ResolverPI = (ordem: number, onda: number) => Promise<DesfechoPI>;

export interface ExecucaoDasOndas {
    /** VALID se todo PI terminou VALID; senao, o desfecho do PI que parou a execucao. */
    desfecho: DesfechoPI;
    /** O estado final de cada PI no scheduler. */
    estados: Record<number, StatusPI>;
    /** A ordem em que os PIs rodaram — onda por onda. */
    ordemDeExecucao: number[];
}

// =============================================================================
// Grafo e ondas
// =============================================================================

/**
 * O DAG da sequencia validada e as suas ondas — ou INVALID, com todos os
 * problemas estruturais: ordem repetida, dependencia propria, inexistente ou
 * posterior (pela posicao na sequencia do Planner) e ciclo. Dependencia
 * repetida e normalizada (aviso), como na forma da sequencia. Nada e corrigido
 * alem disso: ciclo e erro, e nao ha a quem pedir outro grafo aqui.
 *
 * Ondas por camada (Kahn): a onda 0 e dos PIs sem dependencia; a onda k, dos
 * PIs cujos predecessores estao todos nas ondas 0..k-1 — a primeira onda em que
 * o PI pode rodar. Dentro da onda, a ordem do Planner.
 */
export function planejarExecucaoPI(pis: readonly NoPI[]): ResultadoValidacao<PlanoExecucaoPI, CodigoGrafoPI> {
    const erros: ProblemaValidacao<CodigoGrafoPI>[] = [];
    const avisos: ProblemaValidacao<CodigoGrafoPI>[] = [];
    const ordens = pis.map(p => p.ordem);
    const posicao = new Map<number, number>();
    for (const [i, o] of ordens.entries()) {
        if (posicao.has(o)) {
            if (!erros.some(e => e.codigo === 'ordem_repetida' && e.pi === o)) {
                erros.push({ codigo: 'ordem_repetida', pi: o, mensagem: `a ordem ${o} aparece em mais de um PI` });
            }
        } else {
            posicao.set(o, i);
        }
    }
    const naOrdemDoPlanner = (xs: Iterable<number>): number[] => [...xs].sort((a, b) => posicao.get(a)! - posicao.get(b)!);

    // Arestas: exatamente as de `dependeDe`, sem repeticao.
    const predecessores = new Map<number, number[]>();
    for (const [i, p] of pis.entries()) {
        if (posicao.get(p.ordem) !== i) continue; // ordem repetida: ja acusada
        const vistas = new Set<number>();
        for (const d of p.dependeDe) {
            if (vistas.has(d)) {
                if (!avisos.some(a => a.pi === p.ordem && a.evidencias?.[0] === `dependeDe: ${d}`)) {
                    avisos.push({ codigo: 'dependencia_repetida', pi: p.ordem, evidencias: [`dependeDe: ${d}`], mensagem: `PI ${p.ordem} declara a dependencia ${d} mais de uma vez: conta uma` });
                }
                continue;
            }
            vistas.add(d);
            if (d === p.ordem) {
                erros.push({ codigo: 'dependencia_propria', pi: p.ordem, mensagem: `PI ${p.ordem} depende de si mesmo` });
            } else if (!posicao.has(d)) {
                erros.push({ codigo: 'dependencia_inexistente', pi: p.ordem, mensagem: `PI ${p.ordem} depende do PI ${d}, que nao existe na sequencia` });
            } else if (posicao.get(d)! > i) {
                erros.push({
                    codigo: 'dependencia_posterior', pi: p.ordem, pis: [p.ordem, d],
                    mensagem: `PI ${p.ordem} depende do PI ${d}, que vem depois na sequencia do Planner`
                });
            }
        }
        // O grafo leva toda aresta entre PIs que existem — as posteriores tambem:
        // e com elas que um ciclo se fecha, e o ciclo e acusado a parte.
        predecessores.set(p.ordem, naOrdemDoPlanner([...vistas].filter(d => d !== p.ordem && posicao.has(d))));
    }
    const nos = naOrdemDoPlanner(predecessores.keys());

    // Kahn por camadas.
    const ondas: OndaPI[] = [];
    const ondaDoPI = new Map<number, number>();
    let restantes = [...nos];
    while (restantes.length > 0) {
        const camada = restantes.filter(o => predecessores.get(o)!.every(d => ondaDoPI.has(d)));
        if (camada.length === 0) break;
        for (const o of camada) ondaDoPI.set(o, ondas.length);
        ondas.push({ indice: ondas.length, ordens: camada });
        restantes = restantes.filter(o => !ondaDoPI.has(o));
    }
    if (restantes.length > 0) {
        const ciclo = cicloEntre(restantes, predecessores);
        erros.push({
            codigo: 'ciclo_de_dependencias', pi: ciclo[0], pis: ciclo,
            mensagem: `as dependencias formam um ciclo: ${[...ciclo, ciclo[0]].join(' -> ')} (cada PI depende do seguinte)`,
            evidencias: restantes.map(o => `PI ${o} depende de ${predecessores.get(o)!.join(', ')}`)
        });
    }
    if (erros.length > 0) return invalido(erros, { avisos });

    const sucessores = new Map<number, number[]>(nos.map(o => [o, []]));
    for (const o of nos) for (const d of predecessores.get(o)!) sucessores.get(d)!.push(o);
    const profundidade = new Map<number, number>();
    for (const o of nos) profundidade.set(o, 1 + Math.max(0, ...predecessores.get(o)!.map(d => profundidade.get(d)!)));

    return valido(
        comoDadoPuro<PlanoExecucaoPI>({
            ordens: nos,
            predecessores: Object.fromEntries(predecessores),
            sucessores: Object.fromEntries([...sucessores].map(([o, s]) => [o, naOrdemDoPlanner(s)])),
            ondas,
            ondaDoPI: Object.fromEntries(ondaDoPI),
            metricas: {
                pis: nos.length,
                arestas: [...predecessores.values()].reduce((n, ds) => n + ds.length, 0),
                ondas: ondas.length,
                larguraMaxima: Math.max(0, ...ondas.map(o => o.ordens.length)),
                profundidade: Math.max(0, ...profundidade.values()),
                pisPorOnda: ondas.map(o => o.ordens.length)
            },
            avisos
        }),
        avisos
    );
}

/**
 * Um ciclo entre os nos que o Kahn nao conseguiu tirar. Todo no que sobra tem
 * um predecessor que tambem sobra; seguindo sempre o primeiro deles, a partir
 * do primeiro que sobra, um no se repete — o trecho entre as duas visitas e um
 * ciclo. Devolvido na direcao das arestas (cada PI depende do seguinte).
 */
function cicloEntre(restantes: number[], predecessores: Map<number, number[]>): number[] {
    const sobra = new Set(restantes);
    const caminho: number[] = [];
    let no = restantes[0];
    while (!caminho.includes(no)) {
        caminho.push(no);
        no = predecessores.get(no)!.find(d => sobra.has(d))!;
    }
    return caminho.slice(caminho.indexOf(no));
}

// =============================================================================
// Liberacao
// =============================================================================

/** Terminou sem ser VALID: os dependentes nunca podem rodar. */
const TERMINOU_SEM_VALID: readonly StatusPI[] = ['INVALID', 'UNRESOLVED', 'FAILED'];

/**
 * Quem pode rodar agora. Entre os PIs PENDENTES:
 *   prontos     todos os predecessores VALID;
 *   bloqueados  algum predecessor — direto ou por um predecessor ja bloqueado —
 *               terminou sem ser VALID (INVALID com o orcamento esgotado,
 *               UNRESOLVED, FAILED): nunca rodam, e nenhum resultado e inventado
 *               para satisfazer a dependencia;
 *   aguardando  o resto: algum predecessor ainda nao terminou.
 * No scheduler, o estado de um PI so muda quando ele termina (`executarOndas`):
 * INVALID aqui e o PI que esgotou o orcamento, nao uma tentativa reprovada.
 */
export function liberados(
    plano: PlanoExecucaoPI,
    estados: Readonly<Record<number, StatusPI | undefined>>
): { prontos: number[]; bloqueados: number[]; aguardando: number[] } {
    const estado = (o: number): StatusPI => estados[o] ?? 'PENDENTE';
    const bloqueado = new Set<number>();
    const prontos: number[] = [];
    const aguardando: number[] = [];
    // Na ordem do Planner os predecessores vem antes: o bloqueio se propaga numa passada.
    for (const o of plano.ordens) {
        const preds = plano.predecessores[o];
        if (preds.some(d => TERMINOU_SEM_VALID.includes(estado(d)) || bloqueado.has(d))) {
            if (estado(o) === 'PENDENTE') bloqueado.add(o);
            continue;
        }
        if (estado(o) !== 'PENDENTE') continue;
        if (preds.every(d => estado(d) === 'VALID')) prontos.push(o);
        else aguardando.push(o);
    }
    return { prontos, bloqueados: plano.ordens.filter(o => bloqueado.has(o)), aguardando };
}

// =============================================================================
// Execucao por ondas
// =============================================================================

/** Um registro por onda planejada, tudo PENDENTE. */
export function registrosDeOndas(plano: PlanoExecucaoPI): RegistroOndaPI[] {
    return plano.ondas.map(o => ({
        indice: o.indice,
        ordens: [...o.ordens],
        dependencias: Object.fromEntries(o.ordens.map(x => [x, [...plano.predecessores[x]]])),
        status: 'PENDENTE' as const,
        executados: [],
        bloqueados: []
    }));
}

/**
 * Percorre as ondas, em ordem. Em cada uma, roda os PIs liberados — todos os
 * predecessores VALID —, um por vez, na ordem do Planner: `resolver` resolve o
 * PI inteiro, com o retry dele, e so depois o proximo PI comeca. A onda seguinte
 * so comeca com a anterior terminada.
 *
 * O primeiro PI que termina sem ser VALID encerra a execucao, como antes do
 * scheduler: nenhum resultado de PI faria o plano chegar a COMPLETED. As ondas
 * seguintes ficam NAO_EXECUTADA, com os dependentes dele em `bloqueados`. Falha
 * tecnica do `resolver` marca o PI FAILED, fecha as ondas e e relancada.
 *
 * `registros` (os de `registrosDeOndas`) sao preenchidos aqui: status,
 * duracao, executados e bloqueados de cada onda.
 */
export async function executarOndas(
    plano: PlanoExecucaoPI,
    registros: RegistroOndaPI[],
    resolver: ResolverPI,
    agora: () => number = () => performance.now()
): Promise<ExecucaoDasOndas> {
    const estados: Record<number, StatusPI> = Object.fromEntries(plano.ordens.map(o => [o, 'PENDENTE' as StatusPI]));
    const ordemDeExecucao: number[] = [];
    let desfecho: DesfechoPI = 'VALID';
    let parou = false;
    let falha: { erro: unknown } | undefined;

    for (const registro of registros) {
        const { prontos, bloqueados } = liberados(plano, estados);
        registro.bloqueados = registro.ordens.filter(o => bloqueados.includes(o));
        if (parou) {
            registro.status = 'NAO_EXECUTADA';
            continue;
        }
        const presos = registro.ordens.filter(o => !prontos.includes(o) && !bloqueados.includes(o));
        if (presos.length > 0) {
            // Com as ondas por camada, toda dependencia de uma onda esta nas anteriores, ja terminadas.
            throw new Error(`scheduler: a onda ${registro.indice} tem PI(s) com predecessor sem desfecho: ${presos.join(', ')}`);
        }
        registro.status = 'EM_EXECUCAO';
        const inicio = agora();
        for (const ordem of registro.ordens.filter(o => prontos.includes(o))) {
            estados[ordem] = 'EM_EXECUCAO';
            registro.executados.push(ordem);
            ordemDeExecucao.push(ordem);
            let d: DesfechoPI;
            try {
                d = await resolver(ordem, registro.indice);
            } catch (erro) {
                estados[ordem] = 'FAILED';
                falha = { erro };
                parou = true;
                break;
            }
            estados[ordem] = d;
            if (d !== 'VALID') {
                desfecho = d;
                parou = true;
                break;
            }
        }
        registro.duracaoMs = Math.round((agora() - inicio) * 1000) / 1000;
        registro.status = parou ? 'INTERROMPIDA' : 'CONCLUIDA';
    }

    if (falha) throw falha.erro;
    return { desfecho, estados, ordemDeExecucao };
}
