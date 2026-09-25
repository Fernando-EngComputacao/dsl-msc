/**
 * VETA, PROIBE e AJUSTA atravessam o caminho hibrido intactos.
 *
 * `CYPHER_VALIDACAO` so alcanca nos com `parametro`. VETA, PROIBE e AJUSTA sao
 * arestas entre nos sem `parametro`, entao nunca aparecem em `RegraValidada[]`.
 * O que estes testes cobram e a consequencia disso para a politica:
 *
 *     o silencio do RAG e do Cypher sobre uma restricao nao a revoga.
 *
 * Cada caso percorre a MESMA sequencia de `server.ts::processar*` no modo
 * hibrido — `retrieve*Constraints` -> `prepararHibrido` (RAG + Cypher) ->
 * `retrieverFoco*` -> `filtrarPorFoco*` -> poda -> `refinarPolitica` -> politica
 * efetiva — e compara a politica efetiva com a deterministica.
 *
 * Roda OFFLINE. O embedding e a busca vetorial sao dublados. O Cypher tambem,
 * por um GEMEO do grafo: as regras com `parametro` que `database/neo4j*.ts`
 * grava, lidas da mesma AST, penduradas no mesmo no e avaliadas com a mesma
 * comparacao do `CASE`. Com o Neo4j no ar, o ultimo bloco confere que o gemeo
 * devolve, no a no, o que o grafo real devolve, e que VETA, PROIBE e AJUSTA de
 * fato nao tocam no com `parametro`.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';

import neo4j, { type Driver, type Session } from 'neo4j-driver';

import { loadModel } from '../database/neo4j.js';
import { loadAgroModel } from '../database/neo4j-agro.js';
import { loadFutModel } from '../database/neo4j-fut.js';
import {
    isAgroBlockRule,
    isAgroForbidAttr,
    isAreaAdjust,
    isAreaDef,
    isAreaForbid,
    isBlockRule,
    isContextAdjust,
    isContextDef,
    isContextForbid,
    isCultureDef,
    isDrugDef,
    isEscalationAttr,
    isForbidAttr,
    isFutBlockRule,
    isFutForbidAttr,
    isInfractionDef,
    isLimiarAttr,
    isPopAdjust,
    isPopForbid,
    isPopulationDef,
    isProtocolDef,
    isRenalAdjustAttr,
    isSituationDef,
    isTriggerAttr,
    type AgroModel,
    type FutModel,
    type MedicalModel
} from '../generated/ast.js';
import {
    filtrarPorFoco,
    pruningPayload,
    retrieveConstraints,
    retrieverFoco,
    type ClinicalContext,
    type Foco,
    type RetrievedConstraints
} from '../knowledge/graphrag.js';
import {
    agroPruningPayload,
    filtrarPorFocoAgro,
    retrieveAgroConstraints,
    retrieverFocoAgro,
    type AgroContext,
    type AgroFoco
} from '../knowledge/graphrag-agro.js';
import {
    filtrarPorFocoFut,
    futPruningPayload,
    retrieveFutConstraints,
    retrieverFocoFut,
    type FutContext,
    type FutFoco
} from '../knowledge/graphrag-fut.js';
import { nomesAgro, nomesFut, nomesMed } from '../knowledge/documentos.js';
import { prepararHibrido } from '../knowledge/recuperacao-hibrida.js';
import {
    consultaPara,
    executorPorSessao,
    type ExecutorCypher,
    type LinhaRegra,
    type RegraValidada
} from '../knowledge/recuperacao-cypher.js';
import { INDICES_POR_DOMINIO, type BuscaVetorial } from '../knowledge/recuperacao-rag.js';
import type { ContextoDominio, Dominio } from '../knowledge/recuperacao.js';
import {
    apenasEstreitou,
    classificar,
    foraDoEstreitamento,
    refinarPolitica
} from '../knowledge/recuperacao-politica.js';
import { montarContrato, verificarClausulas, type ClausulaLida } from '../knowledge/contrato.js';
import { escalar, escalarMapa, type PoliticaItem, type SubgrafoPodado } from '../knowledge/politica.js';
import { montarPromptSemantico } from '../inference/llm-client.js';
import type { ItemPontuado, SinalVetorial } from '../knowledge/foco.js';

let falhas = 0;
function teste(nome: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok   ${nome}`))
        .catch((erro: Error) => {
            falhas++;
            console.log(`  FALHA ${nome}\n       ${erro.message}`);
        });
}

/** Com `sinal` e executor injetados, nada aqui consulta o banco. */
const SEM_SESSAO = undefined as unknown as Session;

type Modelo = MedicalModel | AgroModel | FutModel;

// =============================================================================
// Gemeo do grafo: o que CYPHER_VALIDACAO alcanca, lido da AST
// =============================================================================

type RegraDoGrafo = Omit<LinhaRegra, 'observado' | 'satisfeita'>;

/** As arestas que a consulta de validacao alcanca: as de no com `parametro`. */
const RELACOES_ALCANCAVEIS = new Set([
    'BLOQUEIA_INCREMENTO', 'BLOQUEIA', 'EXIGE_AJUSTE', 'DISPARA', 'ESCALONA', 'TEM_LIMIAR'
]);

function regraDeSeguranca(
    relacao: string,
    r: { parameter: string; operator: string; threshold: { value: number; unit: string }; reason: string }
): Omit<RegraDoGrafo, 'nodeId'> {
    return {
        tipoRegra: 'RegraSeguranca', relacao, parametro: r.parameter, operador: r.operator,
        esperado: r.threshold.value, unidade: r.threshold.unit, razao: r.reason, acao: null, detalhe: null
    };
}

/**
 * As regras com `parametro` que `database/neo4j*.ts` grava, penduradas no no
 * em que o sync as pendura. Chave: `Rotulo:nome`, a ancora do MATCH.
 */
function regrasDoGrafo(dominio: Dominio, model: Modelo): Map<string, RegraDoGrafo[]> {
    const { item, contexto } = INDICES_POR_DOMINIO[dominio];
    const mapa = new Map<string, RegraDoGrafo[]>();
    const pendurar = (rotulo: string, dono: string, r: Omit<RegraDoGrafo, 'nodeId'>): void => {
        const chave = `${rotulo}:${dono}`;
        // A identidade do no e a chave do MERGE do sync: dono + condicao.
        const nodeId = `${r.tipoRegra}:${dono}:${r.parametro}${r.operador}${r.esperado}`;
        mapa.set(chave, [...(mapa.get(chave) ?? []), { ...r, nodeId }]);
    };
    const vazio = { unidade: null, razao: null, acao: null, detalhe: null };

    for (const el of model.elements as unknown[]) {
        if (isBlockRule(el)) {
            pendurar(item.rotulo, el.drug.$refText, regraDeSeguranca('BLOQUEIA_INCREMENTO', el));
        } else if (isAgroBlockRule(el)) {
            pendurar(item.rotulo, el.product.$refText, regraDeSeguranca('BLOQUEIA', el));
        } else if (isFutBlockRule(el)) {
            pendurar(item.rotulo, el.infraction.$refText, regraDeSeguranca('BLOQUEIA', el));
        } else if (isDrugDef(el)) {
            for (const a of el.attributes) {
                if (!isRenalAdjustAttr(a)) continue;
                pendurar(item.rotulo, el.name, {
                    ...vazio, tipoRegra: 'AjusteRenal', relacao: 'EXIGE_AJUSTE', parametro: a.parameter,
                    operador: a.operator, esperado: a.threshold.value, unidade: a.threshold.unit,
                    acao: a.action, detalhe: a.detail
                });
            }
        } else if (isInfractionDef(el)) {
            for (const a of el.attributes) {
                if (!isLimiarAttr(a)) continue;
                pendurar(item.rotulo, el.name, {
                    ...vazio, tipoRegra: 'Limiar', relacao: 'TEM_LIMIAR', parametro: a.parameter,
                    operador: a.operator, esperado: a.threshold.value, unidade: a.threshold.unit,
                    acao: a.action, detalhe: a.detail
                });
            }
        } else if (isProtocolDef(el) || isCultureDef(el) || isSituationDef(el)) {
            for (const a of el.attributes as unknown[]) {
                if (isTriggerAttr(a)) {
                    pendurar(contexto.rotulo, el.name, {
                        ...vazio, tipoRegra: 'Gatilho', relacao: 'DISPARA', parametro: a.parameter,
                        operador: a.operator, esperado: a.value.value, unidade: a.value.unit, acao: a.action
                    });
                } else if (isEscalationAttr(a)) {
                    pendurar(contexto.rotulo, el.name, {
                        ...vazio, tipoRegra: 'Escalonamento', relacao: 'ESCALONA', parametro: a.parameter,
                        operador: a.operator, esperado: a.value.value, detalhe: a.detail
                    });
                }
            }
        }
    }
    return mapa;
}

function comparar(observado: number, operador: string, limite: number): boolean | null {
    switch (operador) {
        case '<': return observado < limite;
        case '>': return observado > limite;
        case '<=': return observado <= limite;
        case '>=': return observado >= limite;
        case '==': return observado === limite;
        case '!=': return observado !== limite;
        default: return null;
    }
}

/** `CYPHER_VALIDACAO` sobre o gemeo: mesma ancora, mesma comparacao, mesma lacuna. */
function executorGemeo(regras: Map<string, RegraDoGrafo[]>): ExecutorCypher {
    return async (consulta, params) => {
        const rotulo = /MATCH \(alvo:`([^`]+)`/.exec(consulta)?.[1];
        const telemetria = params.telemetria as Record<string, number>;
        return (regras.get(`${rotulo}:${String(params.nome)}`) ?? []).map(r => {
            const observado = telemetria[r.parametro] ?? null;
            return {
                ...r,
                observado,
                satisfeita: observado === null ? null : comparar(observado, r.operador, r.esperado)
            };
        });
    };
}

// =============================================================================
// RAG dublado e o caminho do servidor
// =============================================================================

interface Rag {
    itens: string[];
    contextos: string[];
}
const RAG_VAZIO: Rag = { itens: [], contextos: [] };

/** Busca vetorial dublada: devolve, por indice, os nomes dados, do mais ao menos proximo. */
function buscaDe(dominio: Dominio, rag: Rag): BuscaVetorial {
    const { item, contexto } = INDICES_POR_DOMINIO[dominio];
    const pontuar = (nomes: string[]): ItemPontuado[] =>
        nomes.map((nome, i) => {
            const escore = 0.95 - 0.01 * i;
            return { nome, escore, cosseno: 2 * escore - 1, nodeId: `n-${nome}` };
        });
    return async (indice, _vetor, topK) =>
        (indice === item.indice ? pontuar(rag.itens) : indice === contexto.indice ? pontuar(rag.contextos) : [])
            .slice(0, topK);
}

interface Adaptador<C extends { intencao?: string }, K, F> {
    dominio: Dominio;
    regras: Map<string, RegraDoGrafo[]>;
    recuperar: (cenario: C) => K;
    focar: (fala: string, sinal: SinalVetorial) => Promise<F>;
    filtrar: (constraints: K, foco: F, cenario: C) => K;
    podar: (constraints: K, cenario: C) => SubgrafoPodado;
    escopo: (foco: F) => { itens: Set<string>; contextos: Set<string> };
    /** Os ajustes que o Prompt Semantico mostra, por item. */
    ajustes: (constraints: K) => { item: string; acao: string }[];
}

interface Caminho {
    /** A politica deterministica, ANTES do foco: `retrieve*Constraints` puro. */
    antes: SubgrafoPodado;
    poda: SubgrafoPodado;
    validadas: RegraValidada[];
    /** `subgrafoRefinado ?? poda`, como em `server.ts`. */
    efetiva: SubgrafoPodado;
    itensEmFoco: Set<string>;
    contextosEmFoco: Set<string>;
    ajustes: { item: string; acao: string }[];
}

interface CaminhoDe<K> extends Caminho {
    /** As restricoes depois do foco: o que o Prompt Semantico le. */
    constraints: K;
}

/** A sequencia de `server.ts::processar*` no modo hibrido, sem o SSE e sem o motor. */
async function caminhoHibrido<C extends { intencao?: string }, K, F>(
    a: Adaptador<C, K, F>,
    cenario: C,
    rag: Rag,
    executor: ExecutorCypher = executorGemeo(a.regras)
): Promise<CaminhoDe<K>> {
    const deterministicas = a.recuperar(cenario);
    // Copia profunda: se algum passo alterasse a politica que recebeu, a
    // comparacao contra o original mutado esconderia a perda.
    const antes = structuredClone(a.podar(deterministicas, cenario));
    const preparo = await prepararHibrido(a.dominio, cenario as unknown as ContextoDominio, SEM_SESSAO, {
        id: 'restricoes-hibridas',
        topK: 50,
        embutir: async () => [0.1, 0.2, 0.3],
        busca: buscaDe(a.dominio, rag),
        executor
    });
    const foco = await a.focar(cenario.intencao ?? '', preparo.sinal);
    const constraints = a.filtrar(deterministicas, foco, cenario);
    const poda = a.podar(constraints, cenario);
    const efetiva = preparo.validadas.length > 0 ? refinarPolitica(poda, preparo.validadas).subgrafo : poda;
    const { itens, contextos } = a.escopo(foco);
    return {
        antes, constraints, poda, validadas: preparo.validadas, efetiva,
        itensEmFoco: itens, contextosEmFoco: contextos, ajustes: a.ajustes(constraints)
    };
}

/** Um dominio com os tipos apagados, para os testes que varrem os tres. */
interface Suite {
    nome: Dominio;
    modelo: Modelo;
    regras: Map<string, RegraDoGrafo[]>;
    arquivo: string;
    itens: string[];
    contextos: string[];
    /** Cenario minimo: fala, telemetria e os grupos (populacoes, areas, contextos). */
    caminho: (fala: string, telemetria: Record<string, number>, grupos: string[], rag: Rag) => Promise<Caminho>;
    caminhoDoCenario: (linha: string, rag: Rag) => Promise<Caminho>;
}

function suite<C extends { intencao?: string }, K, F>(
    a: Adaptador<C, K, F>,
    modelo: Modelo,
    arquivo: string,
    nomes: { itens: string[]; contextos: string[] },
    cenario: (fala: string, telemetria: Record<string, number>, grupos: string[]) => C
): Suite {
    return {
        nome: a.dominio, modelo, regras: a.regras, arquivo, ...nomes,
        caminho: (fala, telemetria, grupos, rag) => caminhoHibrido(a, cenario(fala, telemetria, grupos), rag),
        caminhoDoCenario: (linha, rag) => caminhoHibrido(a, JSON.parse(linha) as C, rag)
    };
}

// =============================================================================
// As arestas dos modelos
// =============================================================================

interface Aresta {
    /** O contexto (VETA) ou o grupo — populacao, area, contexto de partida. */
    origem: string;
    item: string;
    fator?: number;
    /** Telemetria minima que ativa o contexto de um VETA. */
    gatilho?: Record<string, number>;
}

function valorQueDispara(operador: string, limite: number): number {
    if (operador === '>' || operador === '!=') return limite + 1;
    if (operador === '<') return limite - 1;
    return limite;
}

function arestasVeta(model: Modelo): Aresta[] {
    const saida: Aresta[] = [];
    for (const el of model.elements as unknown[]) {
        if (!(isProtocolDef(el) || isCultureDef(el) || isSituationDef(el))) continue;
        let gatilho: Record<string, number> | undefined;
        const alvos: string[] = [];
        for (const a of el.attributes as unknown[]) {
            if (isTriggerAttr(a)) gatilho ??= { [a.parameter]: valorQueDispara(a.operator, a.value.value) };
            else if (isForbidAttr(a)) alvos.push(a.drug.$refText);
            else if (isAgroForbidAttr(a)) alvos.push(a.product.$refText);
            else if (isFutForbidAttr(a)) alvos.push(a.infraction.$refText);
        }
        for (const item of alvos) saida.push({ origem: el.name, item, gatilho });
    }
    return saida;
}

function arestasDeGrupo(model: Modelo, tipo: 'PROIBE' | 'AJUSTA'): Aresta[] {
    const saida: Aresta[] = [];
    for (const el of model.elements as unknown[]) {
        if (!(isPopulationDef(el) || isAreaDef(el) || isContextDef(el))) continue;
        for (const r of el.restrictions as unknown[]) {
            if (tipo === 'PROIBE') {
                if (isPopForbid(r)) saida.push({ origem: el.name, item: r.drug.$refText });
                else if (isAreaForbid(r)) saida.push({ origem: el.name, item: r.product.$refText });
                else if (isContextForbid(r)) saida.push({ origem: el.name, item: r.infraction.$refText });
            } else {
                if (isPopAdjust(r)) saida.push({ origem: el.name, item: r.drug.$refText, fator: r.factor });
                else if (isAreaAdjust(r)) saida.push({ origem: el.name, item: r.product.$refText, fator: r.factor });
                else if (isContextAdjust(r)) saida.push({ origem: el.name, item: r.infraction.$refText, fator: r.factor });
            }
        }
    }
    return saida;
}

/** A fala que nomeia o item: e o casamento por nome que o poe em foco. */
const falaDo = (item: string): string => item.replace(/_/g, ' ').toLowerCase();

// =============================================================================
// Asserções
// =============================================================================

function politicaDe(subgrafo: SubgrafoPodado, item: string): PoliticaItem {
    const p = subgrafo.politicas.find(x => x.item === item);
    assert.ok(p, `${item} nao esta na politica (${subgrafo.politicas.map(x => x.item).join(', ') || 'vazia'})`);
    return p;
}

/** O motivo que `retrieve*Constraints` escreve para veto de contexto e de grupo. */
const restritoPor = (origem: string) => (m: string): boolean =>
    /^vetad[oa] por /.test(m) && m.includes(` ${origem}:`);

/**
 * A restricao que `antes` impunha a `item` continua inteira em `depois`: mesmas
 * decisoes, ainda restrito, com o motivo, e nenhuma decisao de incremento.
 */
function restricaoPreservada(
    antes: SubgrafoPodado,
    depois: SubgrafoPodado,
    item: string,
    motivo: (m: string) => boolean
): void {
    const a = politicaDe(antes, item);
    const d = politicaDe(depois, item);
    assert.ok(a.bloqueado && a.motivos.some(motivo),
        `pre-condicao: ${item} restrito na politica deterministica (${a.motivos.join(' | ')})`);
    assert.deepEqual(d.decisoes, a.decisoes, `${item}: as decisoes mudaram`);
    assert.equal(d.bloqueado, true, `${item}: a restricao virou permissao`);
    assert.ok(d.motivos.some(motivo), `${item}: o motivo da restricao sumiu (${d.motivos.join(' | ')})`);
    const incrementos = depois.papeis.decisoesDeIncremento;
    assert.deepEqual(d.decisoes.filter(x => incrementos.includes(x)), [], `${item}: incremento exprimivel`);
}

/**
 * Oraculo independente de `foraDoEstreitamento`, e mais rigido: compara os
 * campos de valor pela serializacao, ordem inclusive.
 */
function afrouxou(antes: SubgrafoPodado, depois: SubgrafoPodado): string[] {
    const porItem = new Map(antes.politicas.map(p => [p.item, p]));
    const achados: string[] = [];
    for (const p of depois.politicas) {
        const o = porItem.get(p.item);
        if (!o) {
            achados.push(`${p.item} apareceu`);
            continue;
        }
        for (const d of p.decisoes) if (!o.decisoes.includes(d)) achados.push(`${p.item} ganhou ${d}`);
        if (o.bloqueado && !p.bloqueado) achados.push(`${p.item} saiu desbloqueado`);
        for (const m of o.motivos) if (!p.motivos.includes(m)) achados.push(`${p.item} perdeu "${m}"`);
        for (const campo of ['meios', 'unidades', 'valores', 'valoresPorDecisao'] as const) {
            if (JSON.stringify(p[campo]) !== JSON.stringify(o[campo])) achados.push(`${p.item}: ${campo} mudou`);
        }
    }
    return achados;
}

function clausula(item: string, decisao: string): ClausulaLida {
    return { indice: 0, item, decisao, valor: '1.0', unidade: 'u', meio: 'm', justificativa: 'j' };
}

// =============================================================================
// Regras validadas sinteticas: tudo o que o Cypher poderia devolver
// =============================================================================

/** As que o Cypher alcanca hoje e as tres que ele nao alcanca, se um dia alcancar. */
const RELACOES = [...RELACOES_ALCANCAVEIS, 'VETA', 'PROIBE', 'AJUSTA'];
const ACOES = [undefined, 'suspender', 'bloquear', 'reduzir_dose', 'aumentar_intervalo'];

function regraValidada(item: string, dominio: Dominio, relacao: string, acao: string | undefined,
    veredito: 'incide' | 'nao_incide' | 'sem_evidencia'): RegraValidada {
    const condicao = { campo: 'x', observado: 1, esperado: '> 0', operador: '>', limite: 0 };
    return {
        regraId: `sintetica:${item}/${relacao}/${acao ?? '-'}/${veredito}`,
        tipo: 'RegraSintetica',
        relacao,
        item,
        dominio,
        aplicavel: veredito === 'incide',
        condicoesSatisfeitas: veredito === 'incide' ? [{ ...condicao, satisfeita: true }] : [],
        condicoesFalhas: veredito === 'nao_incide' ? [{ ...condicao, satisfeita: false }] : [],
        lacunas: veredito === 'sem_evidencia' ? [{ campo: 'x', esperado: '> 0', motivo: 'nao medido' }] : [],
        evidencia: veredito === 'sem_evidencia' ? {} : { x: 1 },
        validacaoCypher: { valida: veredito === 'incide', motivo: 'sintetica', consulta: '' },
        efeito: { acao, razao: 'regra sintetica' },
        rag: { candidatoId: `x:${item}`, escore: 0.99, cosseno: 0.98, papel: 'item', posicao: 0 }
    };
}

/** Toda combinacao de relacao, acao e veredito sobre um item. */
function bateria(item: string, dominio: Dominio): RegraValidada[] {
    const saida: RegraValidada[] = [];
    for (const relacao of RELACOES) {
        for (const acao of ACOES) {
            for (const veredito of ['incide', 'nao_incide', 'sem_evidencia'] as const) {
                saida.push(regraValidada(item, dominio, relacao, acao, veredito));
            }
        }
    }
    return saida;
}

function sorteador(semente: number): () => number {
    let a = semente >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function escolher<T>(xs: readonly T[], r: () => number): T {
    return xs[Math.floor(r() * xs.length)];
}

// =============================================================================

async function main(): Promise<void> {
    const med = await loadModel('src/examples/med/uti.dsl');
    const agro = await loadAgroModel('src/examples/agro/lavoura.agro');
    const fut = await loadFutModel('src/examples/fut/futebol.fut');

    const MED: Adaptador<ClinicalContext, RetrievedConstraints, Foco> = {
        dominio: 'med',
        regras: regrasDoGrafo('med', med),
        recuperar: c => retrieveConstraints(med, c),
        focar: (fala, sinal) => retrieverFoco(SEM_SESSAO, fala, med, sinal),
        filtrar: (k, f, c) => filtrarPorFoco(k, f, med, c),
        podar: (k, c) => pruningPayload(k, c),
        escopo: f => ({ itens: f.farmacos, contextos: f.protocolos }),
        ajustes: k => k.ajustes.map(a => ({ item: a.farmaco, acao: a.acao }))
    };
    const AGRO: Adaptador<AgroContext, ReturnType<typeof retrieveAgroConstraints>, AgroFoco> = {
        dominio: 'agro',
        regras: regrasDoGrafo('agro', agro),
        recuperar: c => retrieveAgroConstraints(agro, c),
        focar: (fala, sinal) => retrieverFocoAgro(SEM_SESSAO, fala, agro, sinal),
        filtrar: (k, f, c) => filtrarPorFocoAgro(k, f, agro, c),
        podar: (k, c) => agroPruningPayload(k, c),
        escopo: f => ({ itens: f.produtos, contextos: f.culturas }),
        ajustes: k => k.ajustes.map(a => ({ item: a.produto, acao: a.acao }))
    };
    const FUT: Adaptador<FutContext, ReturnType<typeof retrieveFutConstraints>, FutFoco> = {
        dominio: 'fut',
        regras: regrasDoGrafo('fut', fut),
        recuperar: c => retrieveFutConstraints(fut, c),
        focar: (fala, sinal) => retrieverFocoFut(SEM_SESSAO, fala, fut, sinal),
        filtrar: (k, f, c) => filtrarPorFocoFut(k, f, fut, c),
        podar: (k, c) => futPruningPayload(k, c),
        escopo: f => ({ itens: f.infracoes, contextos: f.lances }),
        ajustes: k => k.ajustes.map(a => ({ item: a.infracao, acao: a.acao }))
    };

    const nm = nomesMed(med);
    const na = nomesAgro(agro);
    const nf = nomesFut(fut);
    const SUITES: Suite[] = [
        suite(MED, med, 'src/examples/med/cenarios-200-med.jsonl', { itens: nm.farmacos, contextos: nm.protocolos },
            (fala, telemetria, grupos) =>
                ({ paciente: 'PT-TESTE', intencao: fala, telemetria, populacoes: grupos, farmacosEmUso: [] })),
        suite(AGRO, agro, 'src/examples/agro/cenarios-200-agro.jsonl', { itens: na.produtos, contextos: na.culturas },
            (fala, telemetria, grupos) =>
                ({ talhao: 'TL-TESTE', intencao: fala, telemetria, areas: grupos, produtosEmUso: [] })),
        suite(FUT, fut, 'src/examples/fut/cenarios-200-fut.jsonl', { itens: nf.infracoes, contextos: nf.lances },
            (fala, telemetria, grupos) =>
                ({ partida: 'PT-TESTE', intencao: fala, telemetria, contextos: grupos, infracoesEmUso: [] }))
    ];

    /** O cenario de referencia de `llm-client.ts`: Choque_Septico ativo (PAM 52,
     *  lactato 4.8), TFG 28, Renal_Cronico, Vancomicina em curso. */
    const LEITO: ClinicalContext = {
        paciente: 'PT-2026-0031',
        telemetria: { PAM: 52, FC: 145, lactato: 4.8, RASS: 2, TFG: 28, plaquetas: 45, glicemia: 210 },
        populacoes: ['Renal_Cronico'],
        farmacosEmUso: ['Noradrenalina', 'Propofol', 'Vancomicina']
    };

    console.log('\n[premissa: as tres relacoes existem, e o Cypher de validacao nao as devolve]');

    await teste('os modelos declaram VETA, PROIBE e AJUSTA', () => {
        // Sem arestas, os casos sistematicos abaixo passariam sem ter olhado nada.
        // Nao se exige cada relacao em cada modelo: o fut, por exemplo, nao
        // declara AJUSTA, porque la o fator nao tem semantica operacional.
        const contagem = SUITES.map(s => ({
            dominio: s.nome,
            veta: arestasVeta(s.modelo).length,
            proibe: arestasDeGrupo(s.modelo, 'PROIBE').length,
            ajusta: arestasDeGrupo(s.modelo, 'AJUSTA').length
        }));
        const soma = (k: 'veta' | 'proibe' | 'ajusta'): number => contagem.reduce((t, c) => t + c[k], 0);
        for (const k of ['veta', 'proibe', 'ajusta'] as const) {
            assert.ok(soma(k) > 0, `nenhum modelo declara ${k.toUpperCase()}: ${JSON.stringify(contagem)}`);
        }
        console.log(`       ${contagem.map(c => `${c.dominio}: VETA ${c.veta}, PROIBE ${c.proibe}, AJUSTA ${c.ajusta}`).join(' | ')}`);
    });

    await teste('no gemeo do grafo, a Dobutamina nao tem regra nenhuma: so o VETA a restringe', () => {
        assert.equal(MED.regras.get('Farmaco:Dobutamina'), undefined);
        for (const regras of SUITES.flatMap(s => [...s.regras.values()])) {
            for (const r of regras) assert.ok(RELACOES_ALCANCAVEIS.has(r.relacao), r.relacao);
        }
    });

    console.log('\n[1. VETA preservado: Dobutamina com o Choque_Septico ativo]');

    const DOBUTA = { ...LEITO, intencao: 'inicia dobutamina' };
    const VETO_CHOQUE = restritoPor('Choque_Septico');

    await teste('o RAG traz a Dobutamina e o protocolo; o Cypher so fala dos gatilhos do protocolo', async () => {
        const c = await caminhoHibrido(MED, DOBUTA, { itens: ['Dobutamina'], contextos: ['Choque_Septico'] });
        assert.ok(c.contextosEmFoco.has('Choque_Septico'), 'pre-condicao: o RAG pos o protocolo em foco');
        assert.ok(c.validadas.some(r => r.item === 'Choque_Septico' && r.aplicavel),
            'pre-condicao: o Cypher confirmou os gatilhos do protocolo');
        assert.ok(!c.validadas.some(r => r.item === 'Dobutamina'), 'pre-condicao: nada sobre a Dobutamina');
        restricaoPreservada(c.antes, c.efetiva, 'Dobutamina', VETO_CHOQUE);
    });

    await teste('o RAG traz so a Dobutamina: protocolo fora do foco, veto valendo', async () => {
        const c = await caminhoHibrido(MED, DOBUTA, { itens: ['Dobutamina'], contextos: [] });
        assert.ok(!c.contextosEmFoco.has('Choque_Septico'), 'pre-condicao: o protocolo que veta fica fora do foco');
        restricaoPreservada(c.antes, c.efetiva, 'Dobutamina', VETO_CHOQUE);
    });

    await teste('o Prompt Semantico e o contrato continuam cobrando o veto', async () => {
        const c = await caminhoHibrido(MED, DOBUTA, { itens: ['Dobutamina'], contextos: [] });
        const prompt = montarPromptSemantico(c.constraints, DOBUTA, c.efetiva);
        assert.ok(prompt.includes('- Dobutamina (protocolo Choque_Septico):'), 'o fato do veto sumiu do prompt');
        assert.ok(prompt.includes('- Dobutamina [RESTRITO]:'), 'a politica vigente nao marca a Dobutamina');
        assert.ok(prompt.includes('motivo: vetado por protocolo Choque_Septico'), 'a politica vigente perdeu o motivo');

        const [v] = verificarClausulas(montarContrato(c.efetiva, {}, []), [clausula('Dobutamina', 'INICIAR_INFUSAO')]);
        assert.equal(v?.tipo, 'decisao_inadmissivel', JSON.stringify(v));
        assert.match(v.mensagem, /vetado por protocolo Choque_Septico/);
    });

    await teste('cada VETA dos tres modelos, com o contexto ativo, sob tres RAGs', async () => {
        let casos = 0;
        for (const s of SUITES) {
            for (const aresta of arestasVeta(s.modelo)) {
                assert.ok(aresta.gatilho, `${aresta.origem} nao tem gatilho que o ative`);
                const rags: Rag[] = [
                    { itens: [aresta.item], contextos: [] },
                    { itens: [aresta.item], contextos: [aresta.origem] },
                    RAG_VAZIO
                ];
                for (const rag of rags) {
                    const c = await s.caminho(falaDo(aresta.item), aresta.gatilho!, [], rag);
                    assert.ok(c.itensEmFoco.has(aresta.item), `${s.nome}: ${aresta.item} fora do foco`);
                    restricaoPreservada(c.antes, c.efetiva, aresta.item, restritoPor(aresta.origem));
                    casos++;
                }
            }
        }
        console.log(`       ${casos} casos`);
    });

    console.log('\n[2. PROIBE preservado]');

    await teste('Midazolam em gestante: o Cypher ve o bloqueio e o ajuste dele, e nao ve a proibicao', async () => {
        const ctx: ClinicalContext = {
            ...LEITO, populacoes: ['Gestante'], farmacosEmUso: [],
            telemetria: { ...LEITO.telemetria, RASS: -4 }, intencao: 'aprofunda a sedacao com midazolam'
        };
        const c = await caminhoHibrido(MED, ctx, { itens: ['Midazolam'], contextos: [] });
        const doMidazolam = c.validadas.filter(r => r.item === 'Midazolam');
        assert.ok(doMidazolam.some(r => classificar(r) === 'bloqueio_condicional'), 'pre-condicao: RASS -4 < -3 incide');
        assert.ok(doMidazolam.some(r => classificar(r) === 'ajuste'), 'pre-condicao: TFG 28 < 30 incide');
        restricaoPreservada(c.antes, c.efetiva, 'Midazolam', restritoPor('Gestante'));
    });

    await teste('cada PROIBE dos tres modelos, com e sem candidato do RAG', async () => {
        let casos = 0;
        for (const s of SUITES) {
            for (const aresta of arestasDeGrupo(s.modelo, 'PROIBE')) {
                for (const rag of [{ itens: [aresta.item], contextos: [] }, RAG_VAZIO]) {
                    const c = await s.caminho(falaDo(aresta.item), {}, [aresta.origem], rag);
                    assert.ok(c.itensEmFoco.has(aresta.item), `${s.nome}: ${aresta.item} fora do foco`);
                    restricaoPreservada(c.antes, c.efetiva, aresta.item, restritoPor(aresta.origem));
                    casos++;
                }
            }
        }
        console.log(`       ${casos} casos`);
    });

    console.log('\n[3. AJUSTA preservado — e nunca vira autorizacao]');

    await teste('Vancomicina em renal cronico: o reticulo escalado atravessa o refinamento', async () => {
        const ctx = { ...LEITO, intencao: 'ajusta a vancomicina' };
        const c = await caminhoHibrido(MED, ctx, { itens: ['Vancomicina'], contextos: [] });
        const sem = pruningPayload(retrieveConstraints(med, { ...ctx, populacoes: [] }), ctx);

        const deterministica = politicaDe(c.antes, 'Vancomicina');
        const semAjuste = politicaDe(sem, 'Vancomicina');
        assert.deepEqual(deterministica.valores, escalar(semAjuste.valores, 0.5), 'pre-condicao: fator 0.5 no reticulo');
        assert.deepEqual(deterministica.decisoes, semAjuste.decisoes, 'o AJUSTA mexeu nas decisoes');
        assert.ok(c.validadas.some(r => r.item === 'Vancomicina' && classificar(r) === 'ajuste'),
            'pre-condicao: o Cypher confirmou o ajuste renal (TFG 28 < 50)');

        const efetiva = politicaDe(c.efetiva, 'Vancomicina');
        assert.deepEqual(efetiva.valores, deterministica.valores);
        assert.deepEqual(efetiva.valoresPorDecisao, deterministica.valoresPorDecisao);
        assert.deepEqual(efetiva.decisoes, deterministica.decisoes);
        assert.ok(c.ajustes.some(a => a.item === 'Vancomicina' && a.acao === 'multiplicar dose por 0.5'),
            'o prompt perdeu o ajuste');
    });

    await teste('cada AJUSTA dos tres modelos: mesmas decisoes com e sem o grupo, reticulo exato', async () => {
        const proibe = SUITES.flatMap(s => arestasDeGrupo(s.modelo, 'PROIBE'));
        let casos = 0;
        for (const s of SUITES) {
            for (const aresta of arestasDeGrupo(s.modelo, 'AJUSTA')) {
                const rag = { itens: [aresta.item], contextos: [] };
                const com = await s.caminho(falaDo(aresta.item), {}, [aresta.origem], rag);
                const sem = await s.caminho(falaDo(aresta.item), {}, [], rag);
                const pCom = politicaDe(com.efetiva, aresta.item);
                const pSem = politicaDe(sem.efetiva, aresta.item);
                const rotulo = `${s.nome}: ${aresta.origem} ajusta ${aresta.item}`;

                // Ajuste nao e autorizacao: nenhuma decisao entra nem sai por ele.
                if (!proibe.some(p => p.origem === aresta.origem && p.item === aresta.item)) {
                    assert.deepEqual(pCom.decisoes, pSem.decisoes, rotulo);
                    assert.equal(pCom.bloqueado, pSem.bloqueado, rotulo);
                }
                // O reticulo e exatamente o que `retrieve*Constraints` calcula: o
                // fator escala a dose (med) e a vazao (agro); em fut ele so vai
                // para o texto, porque o minuto e leitura do cronometro.
                const fator = s.nome === 'fut' ? 1 : aresta.fator!;
                assert.deepEqual(pCom.valores, escalar(pSem.valores, fator), rotulo);
                assert.deepEqual(pCom.valoresPorDecisao, escalarMapa(pSem.valoresPorDecisao, fator), rotulo);
                assert.deepEqual(pCom.valores, politicaDe(com.antes, aresta.item).valores, `${rotulo}: reticulo alterado`);
                assert.ok(com.ajustes.some(a => a.item === aresta.item && a.acao.endsWith(` ${aresta.fator}`)),
                    `${rotulo}: o texto do ajuste sumiu`);
                casos++;
            }
        }
        console.log(`       ${casos} casos`);
    });

    await teste('ajuste renal que nao suspende nao estreita nem autoriza; o que suspende estreita', async () => {
        const c = await caminhoHibrido(MED, { ...LEITO, intencao: 'inicia fentanil' }, RAG_VAZIO);
        const fentanil = politicaDe(c.poda, 'Fentanil');
        assert.ok(fentanil.decisoes.includes('INICIAR_INFUSAO'), 'pre-condicao: Fentanil pode ser iniciado');

        for (const acao of ['reduzir_dose', 'aumentar_intervalo']) {
            const r = regraValidada('Fentanil', 'med', 'EXIGE_AJUSTE', acao, 'incide');
            assert.equal(classificar(r), 'ajuste');
            assert.deepEqual(politicaDe(refinarPolitica(c.poda, [r]).subgrafo, 'Fentanil'), fentanil, acao);
        }
        const suspende = regraValidada('Fentanil', 'med', 'EXIGE_AJUSTE', 'suspender', 'incide');
        const estreitada = politicaDe(refinarPolitica(c.poda, [suspende]).subgrafo, 'Fentanil');
        assert.ok(!estreitada.decisoes.includes('INICIAR_INFUSAO') && estreitada.bloqueado);
    });

    console.log('\n[4. ausencia de candidato RAG nao remove restricao]');

    await teste('RAG vazio: o veto da Dobutamina e a proibicao do Midazolam continuam', async () => {
        const dobuta = await caminhoHibrido(MED, DOBUTA, RAG_VAZIO);
        assert.equal(dobuta.validadas.length, 0, 'pre-condicao: sem candidato, sem RegraValidada');
        restricaoPreservada(dobuta.antes, dobuta.efetiva, 'Dobutamina', VETO_CHOQUE);

        const gestante: ClinicalContext = { ...LEITO, populacoes: ['Gestante'], intencao: 'inicia midazolam' };
        const midazolam = await caminhoHibrido(MED, gestante, RAG_VAZIO);
        restricaoPreservada(midazolam.antes, midazolam.efetiva, 'Midazolam', restritoPor('Gestante'));
    });

    await teste('RAG vazio e fala sem nome: nenhum item exprimivel — nao "sem restricao"', async () => {
        for (const s of SUITES) {
            const c = await s.caminho('o que eu faco agora?', {}, [], RAG_VAZIO);
            assert.equal(c.itensEmFoco.size, 0, `${s.nome}: pre-condicao, foco vazio`);
            // A chave vai presente e vazia: e assim que o motor sabe que nada e
            // exprimivel (ver o caso [8] de python_engine/test_grammar.py).
            assert.ok(Array.isArray(c.efetiva.politicas) && c.efetiva.politicas.length === 0, s.nome);
            assert.deepEqual(c.efetiva.acoes_permitidas, [], s.nome);

            const qualquer = c.antes.politicas[0];
            const [v] = verificarClausulas(montarContrato(c.efetiva, {}, []), [clausula(qualquer.item, qualquer.decisoes[0])]);
            assert.equal(v?.tipo, 'item_fora_da_poda', `${s.nome}: o contrato aceitou item com a politica vazia`);
        }
    });

    console.log('\n[5. ausencia de RegraValidada nao transforma restricao em permissao]');

    await teste('nenhuma RegraValidada possivel sobre a Dobutamina revoga o veto', async () => {
        const c = await caminhoHibrido(MED, DOBUTA, { itens: ['Dobutamina'], contextos: [] });
        const regras = bateria('Dobutamina', 'med');
        for (const r of regras) {
            restricaoPreservada(c.antes, refinarPolitica(c.poda, [r]).subgrafo, 'Dobutamina', VETO_CHOQUE);
        }
        restricaoPreservada(c.antes, refinarPolitica(c.poda, regras).subgrafo, 'Dobutamina', VETO_CHOQUE);
    });

    await teste('grafo dessincronizado: o Cypher diz que o bloqueio nao incide; vale a AST', async () => {
        // O grafo guardou um limiar antigo (PAM < 50); a DSL ja diz PAM < 60.
        const regras = new Map(MED.regras);
        regras.set('Farmaco:Propofol', MED.regras.get('Farmaco:Propofol')!.map(r =>
            r.parametro === 'PAM' ? { ...r, esperado: 50 } : r));
        const ctx = { ...LEITO, intencao: 'aprofunda o propofol' };
        const c = await caminhoHibrido(MED, ctx, { itens: ['Propofol'], contextos: [] }, executorGemeo(regras));
        const pam = c.validadas.find(r => r.item === 'Propofol' && r.tipo === 'RegraSeguranca');
        assert.equal(pam?.aplicavel, false, 'pre-condicao: o grafo antigo nao ve o bloqueio');
        restricaoPreservada(c.antes, c.efetiva, 'Propofol', m => m.startsWith('incremento bloqueado (PAM 52 < 60'));
    });

    await teste('em 200 cenarios por dominio: item restrito nunca perde a restricao; regra que nao restringe nao muda nada', async () => {
        let restritos = 0;
        const achados: string[] = [];
        for (const s of SUITES) {
            const linhas = fs.readFileSync(s.arquivo, 'utf-8').split('\n').filter(l => l.trim().length > 0);
            for (const [n, linha] of linhas.entries()) {
                const c = await s.caminhoDoCenario(linha, { itens: s.itens, contextos: s.contextos });
                const todas = c.poda.politicas.flatMap(p => bateria(p.item, s.nome));
                const silenciosas = todas.filter(r => classificar(r) !== 'bloqueio_condicional');

                const comTodas = refinarPolitica(c.poda, todas).subgrafo;
                achados.push(...foraDoEstreitamento(c.poda, comTodas).map(x => `${s.nome} ${n + 1}: ${x}`));
                for (const p of c.poda.politicas.filter(x => x.bloqueado)) {
                    restritos++;
                    const q = politicaDe(comTodas, p.item);
                    if (!q.bloqueado || !p.motivos.every(m => q.motivos.includes(m))) {
                        achados.push(`${s.nome} ${n + 1}: ${p.item} perdeu a restricao`);
                    }
                }
                // Silencio, ajuste, relacao desconhecida, regra que nao incide ou
                // sem evidencia: a politica sai identica, item por item.
                const comSilenciosas = refinarPolitica(c.poda, silenciosas).subgrafo;
                if (JSON.stringify(comSilenciosas.politicas) !== JSON.stringify(c.poda.politicas)) {
                    achados.push(`${s.nome} ${n + 1}: regra que nao restringe mudou a politica`);
                }
            }
        }
        assert.ok(restritos >= 600, `so ${restritos} itens restritos examinados`);
        assert.deepEqual(achados.slice(0, 5), [], `${achados.length} achado(s)`);
        console.log(`       ${restritos} itens restritos examinados`);
    });

    console.log('\n[6. nenhuma decisao nova: politica efetiva ⊆ politica deterministica]');

    for (const s of SUITES) {
        await teste(`${s.nome}: 200 cenarios x 3 RAGs + regras adversariais`, async () => {
            const linhas = fs.readFileSync(s.arquivo, 'utf-8').split('\n').filter(l => l.trim().length > 0);
            let comparacoes = 0;
            const achados: string[] = [];
            const conferir = (rotulo: string, antes: SubgrafoPodado, depois: SubgrafoPodado): void => {
                comparacoes++;
                const problemas = [...foraDoEstreitamento(antes, depois), ...afrouxou(antes, depois)];
                if (problemas.length > 0) achados.push(`${rotulo}: ${problemas.join('; ')}`);
            };

            for (const [n, linha] of linhas.entries()) {
                const r = sorteador(n + 1);
                const rags: [string, Rag][] = [
                    ['RAG vazio', RAG_VAZIO],
                    ['RAG com tudo', { itens: s.itens, contextos: s.contextos }],
                    ['RAG sorteado', {
                        itens: s.itens.filter(() => r() < 0.4),
                        contextos: s.contextos.filter(() => r() < 0.4)
                    }]
                ];
                let ultimo: Caminho | undefined;
                for (const [rotulo, rag] of rags) {
                    ultimo = await s.caminhoDoCenario(linha, rag);
                    conferir(`cenario ${n + 1}, ${rotulo}`, ultimo.antes, ultimo.efetiva);
                }

                // O que um Cypher defeituoso ou um grafo divergente poderia devolver.
                const alvos = [...ultimo!.poda.politicas.map(p => p.item), 'Item_Que_Nao_Existe'];
                const adversarias = Array.from({ length: 12 }, () => regraValidada(
                    escolher(alvos, r), s.nome, escolher(RELACOES, r), escolher(ACOES, r),
                    escolher(['incide', 'incide', 'nao_incide', 'sem_evidencia'] as const, r)
                ));
                try {
                    const refinada = refinarPolitica(ultimo!.poda, adversarias).subgrafo;
                    conferir(`cenario ${n + 1}, adversarias x poda`, ultimo!.poda, refinada);
                    conferir(`cenario ${n + 1}, adversarias x deterministica`, ultimo!.antes, refinada);
                } catch (erro) {
                    achados.push(`cenario ${n + 1}: refinarPolitica lancou — ${(erro as Error).message}`);
                }
            }

            assert.ok(comparacoes >= 200 * 5, `so ${comparacoes} comparacoes`);
            assert.deepEqual(achados.slice(0, 5), [], `${achados.length} ampliacao(oes) em ${comparacoes}`);
            console.log(`       ${comparacoes} comparacoes`);
        });
    }

    console.log('\n[a guarda de runtime cobre a restricao inteira, nao so as decisoes]');

    await teste('perder marca, motivo ou reticulo e recusado; estreitar continua passando', async () => {
        const c = await caminhoHibrido(MED, { ...LEITO, intencao: 'inicia dobutamina e ajusta a vancomicina' }, RAG_VAZIO);
        const base = c.efetiva;
        const mexer = (item: string, f: (p: PoliticaItem) => PoliticaItem): SubgrafoPodado =>
            ({ ...base, politicas: base.politicas.map(p => (p.item === item ? f(p) : p)) });

        const casos: [string, SubgrafoPodado, RegExp][] = [
            ['desmarcar o veto', mexer('Dobutamina', p => ({ ...p, bloqueado: false })), /Dobutamina deixou de ser restrito/],
            ['apagar o motivo do veto', mexer('Dobutamina', p => ({ ...p, motivos: [] })), /Dobutamina perdeu o motivo/],
            ['devolver INICIAR_INFUSAO', mexer('Dobutamina', p => ({ ...p, decisoes: [...p.decisoes, 'INICIAR_INFUSAO'] })),
                /Dobutamina ganhou \[INICIAR_INFUSAO\]/],
            ['tirar a dose escalada pelo AJUSTA', mexer('Vancomicina', p => ({
                ...p, valores: p.valores.filter(v => v.valor !== '7.5')
            })), /Vancomicina: valores mudaram/],
            ['soltar o numero', mexer('Vancomicina', p => ({ ...p, valores: [], valoresPorDecisao: {} })),
                /Vancomicina: valores mudaram/],
            ['acrescentar um meio', mexer('Vancomicina', p => ({ ...p, meios: [...p.meios, 'INTRAOSSEO'] })),
                /Vancomicina: meios mudaram/],
            ['acrescentar um item', { ...base, politicas: [...base.politicas, { ...base.politicas[0], item: 'Farmaco_Novo' }] },
                /Farmaco_Novo: item que a politica anterior nao tinha/]
        ];
        assert.ok(politicaDe(base, 'Vancomicina').valores.some(v => v.valor === '7.5'),
            'pre-condicao: 15 mg/kg x 0.5 no reticulo');
        for (const [rotulo, forjada, esperado] of casos) {
            assert.equal(apenasEstreitou(base, forjada), false, rotulo);
            assert.match(foraDoEstreitamento(base, forjada).join(' | '), esperado, rotulo);
        }

        const estreitada = mexer('Vancomicina', p => ({
            ...p, decisoes: p.decisoes.slice(1), bloqueado: true, motivos: [...p.motivos, 'motivo novo']
        }));
        assert.deepEqual(foraDoEstreitamento(base, estreitada), []);
        assert.deepEqual(foraDoEstreitamento(base, { ...base, politicas: [] }), []);
    });

    // ------------------------------------------------------------------ Neo4j
    const uri = process.env.NEO4J_URI ?? 'bolt://localhost:7687';
    const driver: Driver = neo4j.driver(
        uri,
        neo4j.auth.basic(process.env.NEO4J_USER ?? 'neo4j', process.env.NEO4J_PASSWORD ?? '#UFG2026')
    );
    let disponivel = true;
    try {
        await driver.verifyConnectivity();
    } catch {
        disponivel = false;
    }

    if (!disponivel) {
        console.log(`\n[grafo real] pulado — Neo4j indisponivel em ${uri}`);
    } else {
        console.log('\n[grafo real]');
        const session = driver.session();
        const numero = (v: unknown): number =>
            typeof v === 'number' ? v : (v as { toNumber: () => number }).toNumber();
        try {
            await teste('VETA, PROIBE e AJUSTA existem no grafo, e nenhuma aresta toca no com parametro', async () => {
                const r = await session.run(
                    `MATCH (a)-[rel:VETA|PROIBE|AJUSTA]->(b)
                     RETURN type(rel) AS tipo, count(*) AS n,
                            sum(CASE WHEN a.parametro IS NOT NULL OR b.parametro IS NOT NULL THEN 1 ELSE 0 END) AS alcancaveis`
                );
                const porTipo = new Map(r.records.map(x => [x.get('tipo') as string, {
                    n: numero(x.get('n')), alcancaveis: numero(x.get('alcancaveis'))
                }]));
                for (const tipo of ['VETA', 'PROIBE', 'AJUSTA']) {
                    const t = porTipo.get(tipo);
                    assert.ok(t && t.n > 0, `${tipo} ausente do grafo: rode graph:sync`);
                    assert.equal(t.alcancaveis, 0, `${tipo} alcancavel pela consulta de validacao`);
                }
                console.log(`       ${[...porTipo].map(([t, v]) => `${t} ${v.n}`).join(', ')}`);
            });

            await teste('CYPHER_VALIDACAO nao devolve nada sobre a Dobutamina', async () => {
                const linhas = await executorPorSessao(session)(consultaPara('Farmaco'), {
                    nome: 'Dobutamina', telemetria: LEITO.telemetria
                });
                assert.deepEqual(linhas, []);
            });

            await teste('o gemeo do teste devolve, no a no, as mesmas regras que o grafo real', async () => {
                const executar = executorPorSessao(session);
                const assinatura = (r: RegraDoGrafo): string =>
                    `${r.tipoRegra}|${r.relacao}|${r.parametro}|${r.operador}|${r.esperado}`;
                const divergencias: string[] = [];
                let nos = 0;
                for (const s of SUITES) {
                    for (const [papel, nomes] of [['item', s.itens], ['contexto', s.contextos]] as const) {
                        const rotulo = INDICES_POR_DOMINIO[s.nome][papel].rotulo;
                        for (const nome of nomes) {
                            nos++;
                            const real = (await executar(consultaPara(rotulo), { nome, telemetria: {} })).map(assinatura).sort();
                            const gemeo = (s.regras.get(`${rotulo}:${nome}`) ?? []).map(assinatura).sort();
                            if (JSON.stringify(real) !== JSON.stringify(gemeo)) {
                                divergencias.push(`${rotulo}:${nome}: grafo ${JSON.stringify(real)} x gemeo ${JSON.stringify(gemeo)}`);
                            }
                        }
                    }
                }
                assert.deepEqual(divergencias.slice(0, 3), [],
                    `${divergencias.length} no(s) divergente(s): grafo dessincronizado? rode graph:sync`);
                console.log(`       ${nos} nos comparados`);
            });
        } finally {
            await session.close();
        }
    }
    await driver.close();

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
