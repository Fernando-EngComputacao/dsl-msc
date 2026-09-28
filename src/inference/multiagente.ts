/**
 * Estado de UMA execucao no modo multiagente (`SPC_CML_DECODIFICACAO=multiagente`).
 *
 *     pedido + telemetria
 *       -> recuperacao (recuperarConhecimento)  -> Prompt Semantico global
 *       -> Planner -> sequencia de PIs -> validacao
 *       -> Decompositor -> PI Agents -> validacao individual
 *       -> composicao -> validacao global
 *
 * Aqui estao os contratos da execucao — status, transicoes permitidas (com a
 * guarda do laco do Planner), orcamento de tentativas e o contexto — e nenhuma
 * chamada a LLM. Quem chama o modelo e o Planner (`planner.ts`), orquestrado
 * por `decodificarMultiagente` (`decodificacao.ts`) com validacao
 * deterministica da sequencia (`validacao-sequencia.ts`) e retry dentro do
 * orcamento, pelo Decompositor (`decomporSequencia`, sobre
 * `knowledge/decompositor.ts`), que recorta a sequencia validada em um
 * `ContextoGeracaoItem` por PI, e monta o DAG dos PIs e as ondas de execucao
 * (`pi-scheduler.ts`), pelos PI Agents (`resolverPIs`, em `pi-agent.ts`), onda
 * por onda e um PI por vez, com validacao individual e retry so daquele PI, e
 * pela composicao e validacao global (`ciclo-global.ts`). Um plano globalmente
 * INVALID reinicia o ciclo no Planner (`reiniciarCicloGlobal`), dentro de
 * `orcamento.ciclosGlobais`. Paralelismo fisico ainda NAO existe: as ondas dizem
 * quem PODERIA rodar junto, e rodam em serie.
 *
 * NADA DAQUI E ESTRUTURA PARALELA. O contexto referencia os tipos que ja
 * existem: `AuditoriaRecuperacao`, `SubgrafoPodado`, `RegraValidada`,
 * `EvidenciaRegra`, `PIPlanejado`, `ResultadoPI`, `ResultadoValidacao`. O
 * `requestId` e o MESMO id da auditoria da recuperacao.
 */

import type { PlanoComposto } from '../knowledge/composicao.js';
import type { ContratoArtefato } from '../knowledge/contrato.js';
import type { PIPlanejado, ResultadoPI } from '../knowledge/contrato-pi.js';
import {
    decomporPIs,
    medirDecomposicao,
    type ConhecimentoDaDecomposicao,
    type MetricasDecomposicao
} from '../knowledge/decompositor.js';
import { numeroDeEnv } from '../knowledge/foco.js';
import { evidenciasDe, type ContextoGeracaoItem, type EvidenciaRegra } from '../knowledge/item-geracao.js';
import type { EsquemaDeclarado, SubgrafoPodado } from '../knowledge/politica.js';
import type { ContextoDominio, Dominio } from '../knowledge/recuperacao.js';
import type { RegraValidada } from '../knowledge/recuperacao-cypher.js';
import { novoIdRecuperacao, type AuditoriaRecuperacao } from '../knowledge/recuperacao-hibrida.js';
import type { ResultadoValidacao } from '../knowledge/validacao.js';
import {
    planejarExecucaoPI,
    registrosDeOndas,
    type MetricasDAG,
    type PlanoExecucaoPI,
    type RegistroOndaPI
} from './pi-scheduler.js';
import type { ConhecimentoRecuperado } from './recuperacao-conhecimento.js';

// =============================================================================
// Status
// =============================================================================

/**
 * Os estados de uma execucao. O projeto nao tinha maquina de estados; os nomes
 * sao os da especificacao da arquitetura multiagente, mais PI_DECOMPOSED: a
 * decomposicao (deterministica, sem modelo) terminou e nenhum PI Agent rodou.
 * Sem ele, o unico estado depois de PI_DECOMPOSING seria PI_EXECUTING, e a
 * execucao anunciaria execucao cognitiva que nao aconteceu. E PI_ALL_VALID:
 * todo PI tem um `ResultadoPI` validado e nada foi composto — sem ele, a
 * execucao pararia em PI_VALIDATING, que diz que ainda ha validacao em curso,
 * ou em COMPOSING, que diz que ha composicao.
 */
export const STATUS_MULTIAGENTE = [
    'RECEIVED',
    'KNOWLEDGE_RETRIEVED',
    'SEMANTIC_PROMPT_READY',
    'PLANNING',
    'SEQUENCE_VALIDATING',
    'SEQUENCE_VALID',
    'PI_DECOMPOSING',
    'PI_DECOMPOSED',
    'PI_EXECUTING',
    'PI_VALIDATING',
    'PI_ALL_VALID',
    'COMPOSING',
    'GLOBAL_VALIDATING',
    'COMPLETED',
    'UNRESOLVED',
    'FAILED'
] as const;

export type StatusMultiagente = (typeof STATUS_MULTIAGENTE)[number];

/**
 * Terminais. `UNRESOLVED` e diferente de `FAILED`: a execucao terminou sem
 * defeito, mas sem artefato valido — orcamento esgotado, politica sem item
 * exprimivel, dado faltante. `FAILED` e defeito: excecao, motor fora do ar,
 * refinamento que tentou ampliar a politica.
 */
export const STATUS_TERMINAIS: readonly StatusMultiagente[] = ['COMPLETED', 'UNRESOLVED', 'FAILED'];

/**
 * Transicoes permitidas. `FAILED` e alcancavel de todo estado nao terminal.
 * Os tres retornos a `PLANNING` sao os laços da arquitetura:
 *   SEQUENCE_VALIDATING -> PLANNING   sequencia invalida, com realimentacao
 *   PI_VALIDATING       -> PLANNING   um PI esgotou as tentativas
 *   GLOBAL_VALIDATING   -> PLANNING   reinicio global
 * O reinicio global volta ao Planner, e nao a recuperacao: a recuperacao e
 * deterministica, e refaze-la com a mesma entrada devolveria o mesmo resultado.
 * Quem limita esses lacos e o `OrcamentoTentativas`, nao este mapa.
 */
export const TRANSICOES_MULTIAGENTE: Readonly<Record<StatusMultiagente, readonly StatusMultiagente[]>> = {
    RECEIVED: ['KNOWLEDGE_RETRIEVED', 'FAILED'],
    KNOWLEDGE_RETRIEVED: ['SEMANTIC_PROMPT_READY', 'UNRESOLVED', 'FAILED'],
    // UNRESOLVED: o pedido nao tem alvo determinavel — decidido antes do Planner.
    SEMANTIC_PROMPT_READY: ['PLANNING', 'UNRESOLVED', 'FAILED'],
    PLANNING: ['SEQUENCE_VALIDATING', 'UNRESOLVED', 'FAILED'],
    SEQUENCE_VALIDATING: ['SEQUENCE_VALID', 'PLANNING', 'UNRESOLVED', 'FAILED'],
    SEQUENCE_VALID: ['PI_DECOMPOSING', 'FAILED'],
    PI_DECOMPOSING: ['PI_DECOMPOSED', 'FAILED'],
    PI_DECOMPOSED: ['PI_EXECUTING', 'FAILED'],
    PI_EXECUTING: ['PI_VALIDATING', 'FAILED'],
    PI_VALIDATING: ['PI_EXECUTING', 'PI_ALL_VALID', 'PLANNING', 'UNRESOLVED', 'FAILED'],
    PI_ALL_VALID: ['COMPOSING', 'FAILED'],
    // UNRESOLVED: sem contexto em foco, o cabecalho do artefato nao e exprimivel.
    COMPOSING: ['GLOBAL_VALIDATING', 'UNRESOLVED', 'FAILED'],
    GLOBAL_VALIDATING: ['COMPLETED', 'PLANNING', 'UNRESOLVED', 'FAILED'],
    COMPLETED: [],
    UNRESOLVED: [],
    FAILED: []
};

export function statusTerminal(status: StatusMultiagente): boolean {
    return STATUS_TERMINAIS.includes(status);
}

export function transicaoPermitida(de: StatusMultiagente, para: StatusMultiagente): boolean {
    return TRANSICOES_MULTIAGENTE[de].includes(para);
}

// =============================================================================
// Orcamento de tentativas
// =============================================================================

/**
 * Tetos de tentativas. Cada um conta a PRIMEIRA tentativa: `planner: 1`
 * significa uma proposta e nenhuma nova.
 */
export interface OrcamentoTentativas {
    /** Propostas do Planner por ciclo global. */
    planner: number;
    /** Geracoes por PI, por ciclo global. */
    porPI: number;
    /** Ciclos globais: quantas vezes o processo pode recomecar no Planner. */
    ciclosGlobais: number;
}

/**
 * Teto absoluto de qualquer entrada do orcamento. Os lacos sao aninhados — no
 * pior caso, `ciclosGlobais x (planner + PIs x porPI)` chamadas ao modelo —, e
 * na borda cada chamada custa segundos. Um valor digitado errado (1000 no lugar
 * de 10) nao pode virar um laco sem fim na pratica.
 */
export const TETO_TENTATIVAS = 10;

/** Os mesmos 3 de `SPC_CML_MAX_TENTATIVAS` e `SPC_CML_MAX_TENTATIVAS_ELEMENTO`; 2 ciclos globais. */
export const ORCAMENTO_PADRAO: Readonly<OrcamentoTentativas> = { planner: 3, porPI: 3, ciclosGlobais: 2 };

/**
 * Inteiro em [1, TETO_TENTATIVAS]. Nao numerico cai no padrao. Zero ou negativo
 * vira 1: nenhuma tentativa nao e um orcamento, e a menor execucao que faz
 * sentido e uma. Fracao e truncada.
 */
export function limitarTentativas(valor: number, padrao: number): number {
    if (!Number.isFinite(valor)) return padrao;
    return Math.min(TETO_TENTATIVAS, Math.max(1, Math.trunc(valor)));
}

/**
 * Le o orcamento do ambiente, na convencao do projeto (`numeroDeEnv`, variavel
 * com padrao no codigo):
 *
 *   SPC_CML_MAX_TENTATIVAS_PLANNER   propostas do Planner por ciclo    (3)
 *   SPC_CML_MAX_TENTATIVAS_PI        geracoes por PI por ciclo         (3)
 *   SPC_CML_MAX_CICLOS_GLOBAIS       reinicios globais, contando o 1o  (2)
 */
export function orcamentoDeEnv(env: NodeJS.ProcessEnv = process.env): OrcamentoTentativas {
    const ler = (nome: string, padrao: number): number =>
        limitarTentativas(numeroDeEnv(env[nome], padrao), padrao);
    return {
        planner: ler('SPC_CML_MAX_TENTATIVAS_PLANNER', ORCAMENTO_PADRAO.planner),
        porPI: ler('SPC_CML_MAX_TENTATIVAS_PI', ORCAMENTO_PADRAO.porPI),
        ciclosGlobais: ler('SPC_CML_MAX_CICLOS_GLOBAIS', ORCAMENTO_PADRAO.ciclosGlobais)
    };
}

/**
 * Maximo de chamadas ao modelo que uma execucao pode fazer com este orcamento e
 * `numeroDePIs` PIs por sequencia. E finito por construcao — e o numero que o
 * orquestrador vai usar para recusar um orcamento incompativel com o tempo
 * disponivel na borda.
 */
export function piorCasoDeChamadas(orcamento: OrcamentoTentativas, numeroDePIs: number): number {
    return orcamento.ciclosGlobais * (orcamento.planner + Math.max(0, numeroDePIs) * orcamento.porPI);
}

// =============================================================================
// Contexto da execucao
// =============================================================================

/** O que se mede numa chamada do Planner, para avaliacao posterior. */
export interface MetricasPlanner {
    /** Tamanho do prompt enviado ao modelo. */
    caracteresPrompt: number;
    /** Tokens do prompt, como o motor os contou. Ausente quando o motor nao informa. */
    tokensPrompt?: number;
    itensCandidatos: number;
    condutasCandidatas: number;
    /** Tempo da chamada ao motor, de ponta a ponta (fila do `_LLAMA_LOCK` incluida). */
    duracaoMs: number;
    /** PIs na sequencia lida. Zero quando a saida nao passou na leitura. */
    pisProduzidos: number;
    /** O reparse do proprio motor contra a gramatica do Planner, quando informado. */
    validaNaGramatica?: boolean;
    /** Tamanho do feedback que esta tentativa recebeu no prompt. Ausente na primeira. */
    caracteresFeedback?: number;
    /** Tempo da validacao deterministica da sequencia (so na fase semantica). */
    duracaoValidacaoMs?: number;
}

/** Onde a tentativa falhou ou passou: na forma da saida ou no conteudo do plano. */
export type FasePlanner = 'protocolo' | 'semantica';

/** Uma proposta do Planner e o que a validacao disse dela. Nenhuma e sobrescrita. */
export interface TentativaPlanner {
    /** Ciclo global em que a proposta foi feita (a partir de 1). */
    ciclo: number;
    /** Tentativa dentro do ciclo (a partir de 1). */
    tentativa: number;
    /** A proposta como o Planner a devolveu, antes de qualquer conferencia. */
    proposta: unknown;
    /**
     * O veredito DESTA tentativa: o da leitura, se a saida ficou fora do
     * protocolo; senao, o da validacao contra o conhecimento.
     */
    validacao: ResultadoValidacao<PIPlanejado[]>;
    metricas?: MetricasPlanner;
    /** O prompt exato enviado ao modelo — com o feedback, a partir da segunda. */
    prompt?: string;
    /** `protocolo`: a leitura reprovou; `semantica`: a leitura passou e o conhecimento julgou. */
    fase?: FasePlanner;
    /** A sequencia lida, quando a saida respeitou o protocolo. */
    sequencia?: PIPlanejado[];
    /** O feedback que esta tentativa gerou para a seguinte, quando houve seguinte. */
    realimentacao?: string;
}

/** O que se mede numa tentativa do PI Agent — o par de `MetricasPlanner`, para comparar os dois. */
export interface MetricasPI {
    /** Tamanho do prompt enviado ao modelo. */
    caracteresPrompt: number;
    /** Tokens do prompt, como o motor os contou. Ausente quando o motor nao informa. */
    tokensPrompt?: number;
    /** Tempo da chamada ao motor, de ponta a ponta (fila do `_LLAMA_LOCK` incluida). */
    duracaoMs: number;
    /** Tamanho do feedback que esta tentativa recebeu no prompt. Ausente na primeira. */
    caracteresFeedback?: number;
    /** Tempo da validacao deterministica (so na fase semantica). */
    duracaoValidacaoMs?: number;
    /** O reparse do proprio motor contra a gramatica do PI, quando informado. */
    validaNaGramatica?: boolean;
}

/** Onde a tentativa do PI falhou ou passou: na forma da saida ou no conteudo da acao. */
export type FasePI = 'protocolo' | 'semantica';

/** Uma tentativa do PI Agent para UM PI e o que a validacao disse dela. Nenhuma e sobrescrita. */
export interface TentativaPI {
    /** O PI a que a tentativa pertence. */
    ordem: number;
    /** Tentativa dentro do PI (a partir de 1). */
    tentativa: number;
    /** O prompt exato enviado — com o feedback, a partir da segunda. */
    prompt: string;
    /** A saida como o PI Agent a devolveu. */
    saida: string;
    fase: FasePI;
    /** O resultado lido, quando a saida respeitou o protocolo. */
    resultado?: ResultadoPI;
    /** O veredito DESTA tentativa: o da leitura, se a saida ficou fora do protocolo; senao, o da validacao individual. */
    validacao: ResultadoValidacao<ResultadoPI>;
    /** As decisoes admissiveis NESTA tentativa, depois da restricao progressiva. */
    admissiveis: string[];
    /** O feedback que esta tentativa gerou para a seguinte, quando houve seguinte. */
    realimentacao?: string;
    metricas?: MetricasPI;
}

/**
 * Onde cada PI esta. `VALID` e o unico que libera os dependentes (ver
 * `liberados`, pi-scheduler.ts). `FAILED`: falha tecnica do motor naquele PI.
 * Um PI cujo predecessor terminou sem ser VALID fica PENDENTE — nunca roda — e
 * aparece em `bloqueados` na onda dele.
 */
export type StatusPI = 'PENDENTE' | 'EM_EXECUCAO' | 'VALID' | 'INVALID' | 'UNRESOLVED' | 'FAILED';

/** A historia de UM PI: as tentativas dele e so dele. */
export interface ExecucaoPI {
    ordem: number;
    item: string;
    conduta: string;
    status: StatusPI;
    tentativas: TentativaPI[];
    /** Decisoes que a validacao reprovou com evidencia e a restricao progressiva tirou do PI. */
    proibidas: string[];
    /** O resultado validado, quando `status` e VALID. */
    resultado?: ResultadoPI;
}

/** O que se mede num ciclo global — Planner, PIs e validacao global, para comparar custos. */
export interface MetricasCiclo {
    duracaoMs: number;
    /** Chamadas ao Planner neste ciclo (cada proposta e uma). */
    chamadasPlanner: number;
    tokensPlanner: number;
    caracteresPromptPlanner: number;
    duracaoPlannerMs: number;
    pis: number;
    /** Chamadas ao PI Agent neste ciclo, somando os retries. */
    chamadasPI: number;
    retriesPI: number;
    tokensPI: number;
    caracteresPromptPI: number;
    duracaoPIMs: number;
    duracaoComposicaoMs?: number;
    duracaoValidacaoGlobalMs?: number;
    errosGlobais: number;
    codigosGlobais: string[];
    /** O formato do DAG dos PIs do ciclo (PIs, ondas, largura, profundidade), quando houve decomposicao. */
    dag?: MetricasDAG;
}

/**
 * Um ciclo global: Planner -> sequencia -> PIs -> composicao -> validacao
 * global. Os campos sao os objetos DAQUELE ciclo: um reinicio da ao contexto
 * arrays novos, e o registro do ciclo anterior fica como estava.
 */
export interface CicloGlobal {
    ciclo: number;
    /** O status em que o ciclo terminou: COMPLETED, PLANNING (reinicio), UNRESOLVED ou FAILED. */
    desfecho: StatusMultiagente;
    motivo?: string;
    tentativasPlanner: TentativaPlanner[];
    sequenciaValidada?: PIPlanejado[];
    contextosPI?: ContextoGeracaoItem[];
    /** O DAG e as ondas do ciclo. */
    planoExecucaoPI?: PlanoExecucaoPI;
    /** O que cada onda executou, bloqueou e durou. */
    ondasPI: RegistroOndaPI[];
    execucoesPI: ExecucaoPI[];
    resultadosPI: ResultadoPI[];
    plano?: PlanoComposto;
    artefato?: string;
    validacaoGlobal?: ResultadoValidacao<PlanoComposto>;
    /** O feedback global que este ciclo mandou ao Planner do seguinte. */
    realimentacao?: string;
    metricas: MetricasCiclo;
}

/** O custo da execucao inteira, somado dos ciclos. */
export interface MetricasExecucao {
    requestId: string;
    ciclos: number;
    resultado: StatusMultiagente;
    duracaoTotalMs: number;
    planner: { chamadas: number; tokens: number; caracteresPrompt: number; duracaoMs: number };
    pi: { pis: number; chamadas: number; retries: number; tokens: number; caracteresPrompt: number; duracaoMs: number };
    validacaoGlobal: { execucoes: number; erros: number; codigos: string[]; duracaoMs: number };
}

export interface TransicaoStatus {
    de: StatusMultiagente;
    para: StatusMultiagente;
    motivo?: string;
}

/**
 * O contexto GLOBAL de uma execucao multiagente. `C` e o contexto do cenario
 * (ClinicalContext | AgroContext | FutContext) e `R` as restricoes recuperadas.
 *
 * Os campos marcados como "a partir de X" so existem depois daquele status;
 * `incoerenciasDoContexto` confere isso.
 */
export interface ContextoExecucaoMultiagente<C extends ContextoDominio = ContextoDominio, R = unknown> {
    /** Id da execucao — o mesmo da auditoria da recuperacao. */
    requestId: string;
    dominio: Dominio;
    /** O pedido original, como foi digitado. */
    pedido: string;
    /** O cenario: telemetria, sujeito, enquadramentos e o que esta em curso. */
    contexto: C;

    /** A partir de KNOWLEDGE_RETRIEVED: a trilha completa da recuperacao. */
    auditoriaRecuperacao?: AuditoriaRecuperacao;
    /** A partir de KNOWLEDGE_RETRIEVED: as restricoes depois do foco (escalonamentos, fatos do prompt). */
    constraints?: R;
    /** A partir de KNOWLEDGE_RETRIEVED: a unica politica da execucao. */
    politicaEfetiva?: SubgrafoPodado;
    /** A partir de SEMANTIC_PROMPT_READY: o Prompt Semantico global, entrada do Planner. */
    promptSemantico?: string;
    /** As regras recuperadas: `auditoriaRecuperacao.validacao`. Vazio no modo deterministico. */
    regras: RegraValidada[];
    /** A evidencia de cada regra (ver `evidenciasDe`). */
    evidencias: EvidenciaRegra[];

    /** Todas as propostas do Planner, de todos os ciclos, na ordem em que vieram. */
    tentativasPlanner: TentativaPlanner[];
    /** A ultima proposta que passou pela conferencia de forma. */
    sequenciaCandidata?: PIPlanejado[];
    /**
     * A partir de SEQUENCE_VALID: a sequencia aceita pela validacao contra o
     * conhecimento. As regras de cada PI sao associadas na etapa seguinte.
     */
    sequenciaValidada?: PIPlanejado[];
    /**
     * A partir de PI_DECOMPOSED: um contexto por PI da sequencia validada, na
     * ordem dela (ver `decomporSequencia`). Dado puro e congelado.
     */
    contextosPI?: ContextoGeracaoItem[];
    /** A partir de PI_DECOMPOSED: tamanho dos contextos e tempo da decomposicao. */
    metricasDecomposicao?: MetricasDecomposicao;
    /**
     * A partir de PI_DECOMPOSED: o DAG da sequencia validada — so ela — e as
     * ondas de execucao (`planejarExecucaoPI`). Dado puro e congelado.
     */
    planoExecucaoPI?: PlanoExecucaoPI;
    /** A partir de PI_DECOMPOSED: um registro por onda, preenchido pelos PI Agents. */
    ondasPI: RegistroOndaPI[];
    /**
     * A partir de PI_EXECUTING: uma entrada por PI, na ordem da sequencia, com
     * as tentativas daquele PI. O historico de um PI nunca entra no de outro.
     */
    execucoesPI: ExecucaoPI[];
    /**
     * Os PIs que ja passaram na validacao individual, na ordem da SEQUENCIA —
     * nao na da execucao: a composicao le daqui.
     */
    resultadosPI: ResultadoPI[];
    /** A partir de COMPOSING: o plano composto do ciclo corrente. */
    planoComposto?: PlanoComposto;
    /** A partir de COMPLETED: o artefato aceito pela validacao global. */
    artefatoFinal?: string;
    /** A partir de GLOBAL_VALIDATING: o veredito do plano composto do ciclo corrente. */
    validacaoGlobal?: ResultadoValidacao<PlanoComposto>;
    /** Um registro por ciclo global encerrado, na ordem. Nenhum e sobrescrito. */
    historicoGlobal: CicloGlobal[];
    /** Ao final: o custo da execucao inteira. */
    metricasExecucao?: MetricasExecucao;
    /** Toda validacao reprovada ou sem decisao, em qualquer fase, para auditoria. */
    errosValidacao: ResultadoValidacao[];

    /** Ciclo global corrente, a partir de 1. */
    tentativaGlobal: number;
    status: StatusMultiagente;
    historicoStatus: TransicaoStatus[];
    orcamento: OrcamentoTentativas;
}

/**
 * O que a decodificacao precisa receber para rodar o modo multiagente: a
 * recuperacao que o servidor ja fez para esta requisicao. `montarEntradaGeracao*`
 * a repassa quando recebe o `ConhecimentoRecuperado`; os demais modos a ignoram.
 */
export interface EntradaMultiagente {
    dominio: Dominio;
    contexto: ContextoDominio;
    conhecimento: ConhecimentoRecuperado<unknown>;
    /**
     * O que o `esquema_dados` declara (universo de decisoes, atributos das
     * condutas). Le-se do modelo da DSL; sem ele o Decompositor nao conclui
     * decisao bloqueada nem informa atributo de conduta.
     */
    esquema?: EsquemaDeclarado;
}

export interface NovaExecucao<C extends ContextoDominio> {
    dominio: Dominio;
    pedido: string;
    contexto: C;
    /** Ausente: um id novo, no formato da auditoria (`novoIdRecuperacao`). */
    requestId?: string;
    /** Ausente: `orcamentoDeEnv()`. */
    orcamento?: OrcamentoTentativas;
}

export function novoContextoExecucao<C extends ContextoDominio, R = unknown>(
    entrada: NovaExecucao<C>
): ContextoExecucaoMultiagente<C, R> {
    return {
        requestId: entrada.requestId ?? novoIdRecuperacao(),
        dominio: entrada.dominio,
        pedido: entrada.pedido,
        contexto: entrada.contexto,
        regras: [],
        evidencias: [],
        tentativasPlanner: [],
        ondasPI: [],
        execucoesPI: [],
        resultadosPI: [],
        historicoGlobal: [],
        errosValidacao: [],
        tentativaGlobal: 1,
        status: 'RECEIVED',
        historicoStatus: [],
        orcamento: entrada.orcamento ?? orcamentoDeEnv()
    };
}

/**
 * Por que a execucao NAO pode voltar de SEQUENCE_VALIDATING ao Planner, ou
 * `undefined` quando pode. O laco so abre com a ultima proposta do ciclo
 * reprovada (INVALID — nem VALID, nem UNRESOLVED, que nao se resolve pedindo
 * outra proposta) e com orcamento para mais uma. `PLANNING -> PLANNING` nunca
 * e permitido: toda volta passa pela validacao.
 */
export function impedimentoDeReplanejar(ctx: ContextoExecucaoMultiagente<ContextoDominio, unknown>): string | undefined {
    const doCiclo = ctx.tentativasPlanner.filter(t => t.ciclo === ctx.tentativaGlobal);
    const ultima = doCiclo[doCiclo.length - 1];
    if (!ultima) return 'nenhuma proposta do Planner neste ciclo';
    if (ultima.validacao.veredito !== 'INVALID') {
        return `a ultima proposta saiu ${ultima.validacao.veredito}: so uma sequencia INVALID volta ao Planner`;
    }
    if (doCiclo.length >= ctx.orcamento.planner) {
        return `orcamento do Planner esgotado (${doCiclo.length}/${ctx.orcamento.planner})`;
    }
    return undefined;
}

/**
 * Por que a sequencia da execucao NAO pode ser decomposta, ou `undefined`
 * quando pode. So se decompoe o que a validacao contra o conhecimento aprovou:
 * status SEQUENCE_VALID, e a ultima proposta do ciclo com veredito VALID na
 * fase SEMANTICA, cujo valor e a propria `sequenciaValidada`. Candidata (so
 * leitura), INVALID e UNRESOLVED sao recusados — o Decompositor vem DEPOIS do
 * validador, nunca no lugar dele.
 */
export function impedimentoDeDecompor(ctx: ContextoExecucaoMultiagente<ContextoDominio, unknown>): string | undefined {
    if (ctx.status !== 'SEQUENCE_VALID') return `status ${ctx.status}: so uma sequencia SEQUENCE_VALID e decomposta`;
    if (!ctx.sequenciaValidada) return 'SEQUENCE_VALID sem sequencia validada';
    const doCiclo = ctx.tentativasPlanner.filter(t => t.ciclo === ctx.tentativaGlobal);
    const ultima = doCiclo[doCiclo.length - 1];
    if (!ultima || ultima.validacao.veredito !== 'VALID' || ultima.fase !== 'semantica') {
        return 'a sequencia nao saiu VALID da validacao semantica deste ciclo';
    }
    if (ultima.validacao.valor !== ctx.sequenciaValidada) {
        return 'a sequencia validada nao e a que a ultima validacao aprovou';
    }
    return undefined;
}

/** Por que a decomposicao registrada nao corresponde a sequencia validada, ou `undefined`. */
export function impedimentoDeConcluirDecomposicao(ctx: ContextoExecucaoMultiagente<ContextoDominio, unknown>): string | undefined {
    const sequencia = ctx.sequenciaValidada ?? [];
    const contextos = ctx.contextosPI;
    if (!contextos) return 'nenhum contexto de PI registrado';
    if (contextos.length !== sequencia.length) {
        return `${contextos.length} contexto(s) para ${sequencia.length} PI(s)`;
    }
    for (const [i, p] of sequencia.entries()) {
        const c = contextos[i].pi;
        if (!c || c.ordem !== p.ordem || c.item !== p.item || c.conduta !== p.conduta) {
            return `o contexto na posicao ${i + 1} nao e o do PI ${p.ordem} (${p.item}, ${p.conduta})`;
        }
    }
    const plano = ctx.planoExecucaoPI;
    if (!plano) return 'nenhum plano de execucao (DAG) dos PIs registrado';
    if (plano.ordens.join() !== sequencia.map(p => p.ordem).join()) {
        return `o DAG tem os PIs ${plano.ordens.join(', ')}, e a sequencia validada ${sequencia.map(p => p.ordem).join(', ')}`;
    }
    for (const p of sequencia) {
        if (plano.predecessores[p.ordem].join() !== [...new Set(p.dependeDe)].join()) {
            return `o DAG da ao PI ${p.ordem} as dependencias [${plano.predecessores[p.ordem].join(', ')}], e a sequencia validada [${p.dependeDe.join(', ')}]`;
        }
    }
    return undefined;
}

/**
 * O PI em que a execucao esta: o primeiro que ainda nao e VALID na ordem do
 * scheduler — onda por onda e, dentro da onda, na do Planner. Sem plano de
 * execucao, na ordem da sequencia.
 */
export function piCorrente(ctx: ContextoExecucaoMultiagente<ContextoDominio, unknown>): ExecucaoPI | undefined {
    const plano = ctx.planoExecucaoPI;
    if (!plano) return ctx.execucoesPI.find(e => e.status !== 'VALID');
    const porOrdem = new Map(ctx.execucoesPI.map(e => [e.ordem, e]));
    return plano.ondas.flatMap(o => o.ordens).map(o => porOrdem.get(o)).find(e => e !== undefined && e.status !== 'VALID');
}

/**
 * Por que a execucao NAO pode (re)entrar em PI_EXECUTING, ou `undefined`. Entra
 * para o PI corrente (`piCorrente`, na ordem das ondas — um predecessor que nao
 * e VALID seria ele mesmo o corrente) quando ele ainda tem tentativa no
 * orcamento e nao ficou UNRESOLVED. E a mesma guarda para o proximo PI e para a
 * nova tentativa do mesmo PI: nos dois casos, quem executa e o PI corrente, e
 * so ele.
 */
export function impedimentoDeExecutarPI(ctx: ContextoExecucaoMultiagente<ContextoDominio, unknown>): string | undefined {
    if (!ctx.contextosPI) return 'nenhum contexto de PI registrado';
    if (!ctx.planoExecucaoPI) return 'nenhum plano de execucao (DAG) dos PIs registrado';
    if (ctx.execucoesPI.length !== ctx.contextosPI.length) {
        return `${ctx.execucoesPI.length} execucao(oes) de PI para ${ctx.contextosPI.length} contexto(s)`;
    }
    const e = piCorrente(ctx);
    if (!e) return 'todos os PIs ja sao VALID';
    if (e.status === 'UNRESOLVED') return `o PI ${e.ordem} ficou UNRESOLVED: outra tentativa nao supre o que falta`;
    if (e.tentativas.length >= ctx.orcamento.porPI) {
        return `orcamento do PI ${e.ordem} esgotado (${e.tentativas.length}/${ctx.orcamento.porPI})`;
    }
    return undefined;
}

/** Por que a execucao NAO pode declarar todos os PIs validos, ou `undefined`. */
export function impedimentoDeConcluirPIs(ctx: ContextoExecucaoMultiagente<ContextoDominio, unknown>): string | undefined {
    const sequencia = ctx.sequenciaValidada ?? [];
    if (ctx.resultadosPI.length !== sequencia.length) {
        return `${ctx.resultadosPI.length} resultado(s) valido(s) para ${sequencia.length} PI(s)`;
    }
    for (const [i, p] of sequencia.entries()) {
        const r = ctx.resultadosPI[i];
        const e = ctx.execucoesPI[i];
        if (r.ordem !== p.ordem || r.item !== p.item || r.conduta !== p.conduta) {
            return `o resultado na posicao ${i + 1} nao responde ao PI ${p.ordem} (${p.item}, ${p.conduta})`;
        }
        if (!e || e.status !== 'VALID' || e.resultado !== r) return `o PI ${p.ordem} nao terminou VALID`;
    }
    return undefined;
}

/** Por que o plano do ciclo NAO pode ser dado por concluido, ou `undefined`. */
export function impedimentoDeConcluir(ctx: ContextoExecucaoMultiagente<ContextoDominio, unknown>): string | undefined {
    if (!ctx.validacaoGlobal) return 'o plano nao passou pela validacao global';
    if (ctx.validacaoGlobal.veredito !== 'VALID') return `a validacao global saiu ${ctx.validacaoGlobal.veredito}`;
    if (!ctx.planoComposto || ctx.validacaoGlobal.valor !== ctx.planoComposto) return 'o plano validado nao e o plano composto';
    return undefined;
}

/**
 * Por que a execucao NAO pode reiniciar no Planner depois da validacao global,
 * ou `undefined`. So com o plano globalmente INVALID — UNRESOLVED nao se
 * resolve pedindo outro plano — e com ciclo global sobrando no orcamento.
 */
export function impedimentoDeReiniciar(ctx: ContextoExecucaoMultiagente<ContextoDominio, unknown>): string | undefined {
    if (!ctx.validacaoGlobal) return 'o plano nao passou pela validacao global';
    if (ctx.validacaoGlobal.veredito !== 'INVALID') {
        return `a validacao global saiu ${ctx.validacaoGlobal.veredito}: so um plano INVALID volta ao Planner`;
    }
    if (ctx.tentativaGlobal >= ctx.orcamento.ciclosGlobais) {
        return `orcamento de ciclos globais esgotado (${ctx.tentativaGlobal}/${ctx.orcamento.ciclosGlobais})`;
    }
    return undefined;
}

/** Guardas das transicoes que so valem sob condicao. */
const GUARDAS: Partial<Record<string, (ctx: ContextoExecucaoMultiagente<ContextoDominio, unknown>) => string | undefined>> = {
    'SEQUENCE_VALIDATING->PLANNING': impedimentoDeReplanejar,
    'SEQUENCE_VALID->PI_DECOMPOSING': impedimentoDeDecompor,
    'PI_DECOMPOSING->PI_DECOMPOSED': impedimentoDeConcluirDecomposicao,
    'PI_DECOMPOSED->PI_EXECUTING': impedimentoDeExecutarPI,
    'PI_VALIDATING->PI_EXECUTING': impedimentoDeExecutarPI,
    'PI_VALIDATING->PI_ALL_VALID': impedimentoDeConcluirPIs,
    'PI_ALL_VALID->COMPOSING': impedimentoDeConcluirPIs,
    'GLOBAL_VALIDATING->COMPLETED': impedimentoDeConcluir,
    'GLOBAL_VALIDATING->PLANNING': impedimentoDeReiniciar
};

/** Muda o status, registrando a transicao. Lanca se ela nao for permitida ou se a guarda dela recusar. */
export function avancarStatus(
    ctx: ContextoExecucaoMultiagente<ContextoDominio, unknown>,
    para: StatusMultiagente,
    motivo?: string
): void {
    if (!transicaoPermitida(ctx.status, para)) {
        throw new Error(`transicao de status nao permitida: ${ctx.status} -> ${para}`);
    }
    const impedimento = GUARDAS[`${ctx.status}->${para}`]?.(ctx);
    if (impedimento) {
        throw new Error(`transicao ${ctx.status} -> ${para} recusada: ${impedimento}`);
    }
    ctx.historicoStatus.push(motivo === undefined ? { de: ctx.status, para } : { de: ctx.status, para, motivo });
    ctx.status = para;
}

/**
 * Registra o resultado de `recuperarConhecimento` e avanca
 * RECEIVED -> KNOWLEDGE_RETRIEVED -> SEMANTIC_PROMPT_READY.
 *
 * Referencia, nao copia: `regras` e o mesmo array de
 * `auditoriaRecuperacao.validacao`. Lanca se a auditoria for de outra
 * requisicao — `recuperarConhecimento` precisa ter recebido `{ id: requestId }`.
 */
export function registrarConhecimento<C extends ContextoDominio, R>(
    ctx: ContextoExecucaoMultiagente<C, R>,
    conhecimento: ConhecimentoRecuperado<R>
): void {
    const id = conhecimento.auditoriaRecuperacao.id;
    if (id !== ctx.requestId) {
        throw new Error(`a recuperacao ${id} nao pertence a execucao ${ctx.requestId}`);
    }
    avancarStatus(ctx, 'KNOWLEDGE_RETRIEVED');
    ctx.auditoriaRecuperacao = conhecimento.auditoriaRecuperacao;
    ctx.constraints = conhecimento.constraints;
    ctx.politicaEfetiva = conhecimento.politicaEfetiva;
    ctx.regras = conhecimento.auditoriaRecuperacao.validacao;
    ctx.evidencias = evidenciasDe(ctx.regras);
    avancarStatus(ctx, 'SEMANTIC_PROMPT_READY');
    ctx.promptSemantico = conhecimento.promptSemantico;
}

/** O que a decomposicao le alem do contexto da execucao. */
export interface EntradaDecomposicao {
    /** O mesmo contrato que validou a sequencia. */
    contrato: ContratoArtefato;
    /** Ver `EntradaMultiagente.esquema`. */
    esquema?: EsquemaDeclarado;
}

/**
 * SEQUENCE_VALID -> PI_DECOMPOSING -> PI_DECOMPOSED: o DAG da sequencia
 * validada e as ondas de execucao (`planejarExecucaoPI`, em
 * `ctx.planoExecucaoPI` e `ctx.ondasPI`) e um `ContextoGeracaoItem` por PI, em
 * `ctx.contextosPI`, com as metricas em `ctx.metricasDecomposicao`. O DAG nasce
 * so da sequencia validada; um erro estrutural nele (dependencia inexistente,
 * posterior, propria, ciclo) e defeito — a validacao ja devia te-lo barrado —, e
 * a execucao vai a FAILED.
 *
 * Nao chama modelo, motor nem grafo: tudo vem do que a execucao ja registrou
 * (politica efetiva, regras, restricoes, pedido, telemetria). A sequencia
 * validada nao e alterada — cada contexto carrega uma copia do seu PI.
 *
 * Recusa (lanca, sem mudar o contexto) o que nao passou na validacao — ver
 * `impedimentoDeDecompor`. Uma inconsistencia descoberta no meio (item fora da
 * politica, par sem decisao em comum) e defeito: a execucao vai a FAILED com o
 * motivo e o erro e relancado. Nao ha fallback.
 */
export function decomporSequencia(
    ctx: ContextoExecucaoMultiagente<ContextoDominio, unknown>,
    entrada: EntradaDecomposicao
): ContextoGeracaoItem[] {
    const impedimento = impedimentoDeDecompor(ctx);
    if (impedimento) throw new Error(`o Decompositor recusou a execucao ${ctx.requestId}: ${impedimento}`);
    avancarStatus(ctx, 'PI_DECOMPOSING');
    let etapa = 'Scheduler de PIs';
    try {
        const grafo = planejarExecucaoPI(ctx.sequenciaValidada!);
        if (grafo.veredito !== 'VALID') {
            throw new Error(`DAG da sequencia validada recusado: ${grafo.erros.map(e => `${e.codigo}: ${e.mensagem}`).join('; ')}`);
        }
        ctx.planoExecucaoPI = grafo.valor!;
        ctx.ondasPI = registrosDeOndas(grafo.valor!);
        etapa = 'Decompositor';
        const k: ConhecimentoDaDecomposicao = {
            requestId: ctx.requestId,
            dominio: ctx.dominio,
            pedido: ctx.pedido,
            telemetria: ctx.contexto.telemetria,
            contrato: entrada.contrato,
            politica: ctx.politicaEfetiva!,
            regras: ctx.regras,
            restricoes: ctx.constraints,
            esquema: entrada.esquema
        };
        const inicio = performance.now();
        const contextos = decomporPIs(ctx.sequenciaValidada!, k);
        const duracaoMs = Math.round((performance.now() - inicio) * 1000) / 1000;
        ctx.contextosPI = contextos;
        ctx.metricasDecomposicao = medirDecomposicao(contextos, k, duracaoMs, ctx.promptSemantico);
        const m = ctx.planoExecucaoPI.metricas;
        avancarStatus(ctx, 'PI_DECOMPOSED', `${contextos.length} contexto(s) de PI em ${m.ondas} onda(s), largura maxima ${m.larguraMaxima}`);
        return contextos;
    } catch (erro) {
        if (!statusTerminal(ctx.status)) avancarStatus(ctx, 'FAILED', `${etapa}: ${(erro as Error).message}`);
        throw erro;
    }
}

// =============================================================================
// Ciclos globais
// =============================================================================

const soma = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** Duracoes medidas pela composicao e pela validacao global do ciclo, quando houve. */
export interface DuracoesGlobais {
    composicaoMs?: number;
    validacaoGlobalMs?: number;
}

/**
 * Registra o ciclo corrente em `historicoGlobal`, com os objetos DELE e as
 * metricas. Chamado uma vez por ciclo, quando ele termina — em COMPLETED, no
 * reinicio, em UNRESOLVED ou FAILED. No reinicio, o ciclo e registrado antes
 * da volta ao Planner, e `reinicio` diz como ele terminou: em PLANNING, com o
 * feedback global que o ciclo seguinte recebe.
 */
export function fecharCiclo(
    ctx: ContextoExecucaoMultiagente<ContextoDominio, unknown>,
    duracaoMs: number,
    duracoes: DuracoesGlobais = {},
    reinicio?: { realimentacao: string; motivo: string }
): CicloGlobal {
    const tentativasPlanner = ctx.tentativasPlanner.filter(t => t.ciclo === ctx.tentativaGlobal);
    const tentativasPI = ctx.execucoesPI.flatMap(e => e.tentativas);
    const validacao = ctx.validacaoGlobal;
    const ultima = ctx.historicoStatus[ctx.historicoStatus.length - 1];
    const ciclo: CicloGlobal = {
        ciclo: ctx.tentativaGlobal,
        desfecho: reinicio ? 'PLANNING' : ctx.status,
        ...(reinicio ? { motivo: reinicio.motivo } : ultima?.motivo ? { motivo: ultima.motivo } : {}),
        tentativasPlanner,
        ...(ctx.sequenciaValidada ? { sequenciaValidada: ctx.sequenciaValidada } : {}),
        ...(ctx.contextosPI ? { contextosPI: ctx.contextosPI } : {}),
        ...(ctx.planoExecucaoPI ? { planoExecucaoPI: ctx.planoExecucaoPI } : {}),
        ondasPI: ctx.ondasPI,
        execucoesPI: ctx.execucoesPI,
        resultadosPI: ctx.resultadosPI,
        ...(ctx.planoComposto ? { plano: ctx.planoComposto, artefato: ctx.planoComposto.texto } : {}),
        ...(validacao ? { validacaoGlobal: validacao } : {}),
        ...(reinicio ? { realimentacao: reinicio.realimentacao } : {}),
        metricas: {
            duracaoMs,
            chamadasPlanner: tentativasPlanner.length,
            tokensPlanner: soma(tentativasPlanner.map(t => t.metricas?.tokensPrompt ?? 0)),
            caracteresPromptPlanner: soma(tentativasPlanner.map(t => t.metricas?.caracteresPrompt ?? 0)),
            duracaoPlannerMs: soma(tentativasPlanner.map(t => t.metricas?.duracaoMs ?? 0)),
            pis: ctx.execucoesPI.length,
            chamadasPI: tentativasPI.length,
            retriesPI: soma(ctx.execucoesPI.map(e => Math.max(0, e.tentativas.length - 1))),
            tokensPI: soma(tentativasPI.map(t => t.metricas?.tokensPrompt ?? 0)),
            caracteresPromptPI: soma(tentativasPI.map(t => t.metricas?.caracteresPrompt ?? 0)),
            duracaoPIMs: soma(tentativasPI.map(t => t.metricas?.duracaoMs ?? 0)),
            ...(duracoes.composicaoMs !== undefined ? { duracaoComposicaoMs: duracoes.composicaoMs } : {}),
            ...(duracoes.validacaoGlobalMs !== undefined ? { duracaoValidacaoGlobalMs: duracoes.validacaoGlobalMs } : {}),
            errosGlobais: validacao?.erros.length ?? 0,
            codigosGlobais: validacao?.erros.map(e => e.codigo) ?? [],
            ...(ctx.planoExecucaoPI ? { dag: ctx.planoExecucaoPI.metricas } : {})
        }
    };
    ctx.historicoGlobal.push(ciclo);
    return ciclo;
}

/**
 * GLOBAL_VALIDATING -> PLANNING: o plano inteiro volta ao Planner, com o ciclo
 * seguinte. A guarda (`impedimentoDeReiniciar`) recusa sem plano INVALID ou sem
 * ciclo no orcamento. O ciclo corrente ja deve estar em `historicoGlobal`.
 *
 * PRESERVA o que nao depende do plano: requestId, pedido, cenario, recuperacao,
 * politica efetiva, regras, evidencias, Prompt Semantico, tentativas do Planner
 * (cada uma com o seu ciclo), erros de validacao e historico de status. A
 * recuperacao NAO e refeita: e deterministica, e a entrada e a mesma.
 *
 * SUBSTITUI o que era do plano — com objetos novos, para o registro do ciclo
 * anterior ficar intacto: sequencia candidata e validada, contextos de PI, DAG
 * e ondas, execucoes e resultados de PI, plano composto, artefato e validacao
 * global.
 * O orcamento do Planner e o de cada PI recomecam, porque sao por ciclo.
 */
export function reiniciarCicloGlobal(ctx: ContextoExecucaoMultiagente<ContextoDominio, unknown>, motivo: string): void {
    if (ctx.historicoGlobal[ctx.historicoGlobal.length - 1]?.ciclo !== ctx.tentativaGlobal) {
        throw new Error(`o ciclo ${ctx.tentativaGlobal} precisa estar registrado antes do reinicio`);
    }
    avancarStatus(ctx, 'PLANNING', motivo);
    ctx.tentativaGlobal += 1;
    ctx.sequenciaCandidata = undefined;
    ctx.sequenciaValidada = undefined;
    ctx.contextosPI = undefined;
    ctx.metricasDecomposicao = undefined;
    ctx.planoExecucaoPI = undefined;
    ctx.ondasPI = [];
    ctx.execucoesPI = [];
    ctx.resultadosPI = [];
    ctx.planoComposto = undefined;
    ctx.artefatoFinal = undefined;
    ctx.validacaoGlobal = undefined;
}

/** O custo da execucao inteira, a partir dos ciclos registrados. */
export function medirExecucao(ctx: ContextoExecucaoMultiagente<ContextoDominio, unknown>, duracaoTotalMs: number): MetricasExecucao {
    const m = ctx.historicoGlobal.map(c => c.metricas);
    return {
        requestId: ctx.requestId,
        ciclos: ctx.historicoGlobal.length,
        resultado: ctx.status,
        duracaoTotalMs,
        planner: {
            chamadas: soma(m.map(x => x.chamadasPlanner)),
            tokens: soma(m.map(x => x.tokensPlanner)),
            caracteresPrompt: soma(m.map(x => x.caracteresPromptPlanner)),
            duracaoMs: soma(m.map(x => x.duracaoPlannerMs))
        },
        pi: {
            pis: soma(m.map(x => x.pis)),
            chamadas: soma(m.map(x => x.chamadasPI)),
            retries: soma(m.map(x => x.retriesPI)),
            tokens: soma(m.map(x => x.tokensPI)),
            caracteresPrompt: soma(m.map(x => x.caracteresPromptPI)),
            duracaoMs: soma(m.map(x => x.duracaoPIMs))
        },
        validacaoGlobal: {
            execucoes: ctx.historicoGlobal.filter(c => c.validacaoGlobal).length,
            erros: soma(m.map(x => x.errosGlobais)),
            codigos: m.flatMap(x => x.codigosGlobais),
            duracaoMs: soma(m.map(x => x.duracaoValidacaoGlobalMs ?? 0))
        }
    };
}

/** Status em que o conhecimento ja tem de estar registrado. */
const DEPOIS_DO_CONHECIMENTO: readonly StatusMultiagente[] = STATUS_MULTIAGENTE.filter(
    s => s !== 'RECEIVED' && s !== 'UNRESOLVED' && s !== 'FAILED'
);
/** Status em que ja existe uma sequencia validada. */
const DEPOIS_DA_SEQUENCIA: readonly StatusMultiagente[] = [
    'SEQUENCE_VALID', 'PI_DECOMPOSING', 'PI_DECOMPOSED', 'PI_EXECUTING', 'PI_VALIDATING', 'PI_ALL_VALID',
    'COMPOSING', 'GLOBAL_VALIDATING', 'COMPLETED'
];
/** Status em que a sequencia ja foi decomposta. */
const DEPOIS_DA_DECOMPOSICAO: readonly StatusMultiagente[] = [
    'PI_DECOMPOSED', 'PI_EXECUTING', 'PI_VALIDATING', 'PI_ALL_VALID', 'COMPOSING', 'GLOBAL_VALIDATING', 'COMPLETED'
];
/** Status em que todo PI ja tem resultado valido. */
const DEPOIS_DOS_PIS: readonly StatusMultiagente[] = ['PI_ALL_VALID', 'COMPOSING', 'GLOBAL_VALIDATING', 'COMPLETED'];

/**
 * O que ha de incoerente no contexto. Vazio quando ele esta coerente com o
 * proprio status e com o orcamento. Nao muda nada: e a checagem que o
 * orquestrador (e os testes) vao chamar entre uma fase e outra.
 */
export function incoerenciasDoContexto(ctx: ContextoExecucaoMultiagente<ContextoDominio, unknown>): string[] {
    const achados: string[] = [];

    if (!STATUS_MULTIAGENTE.includes(ctx.status)) achados.push(`status desconhecido: ${String(ctx.status)}`);
    if (!Number.isInteger(ctx.tentativaGlobal) || ctx.tentativaGlobal < 1) {
        achados.push(`tentativaGlobal invalida: ${ctx.tentativaGlobal}`);
    } else if (ctx.tentativaGlobal > ctx.orcamento.ciclosGlobais) {
        achados.push(`tentativaGlobal ${ctx.tentativaGlobal} passou do orcamento de ${ctx.orcamento.ciclosGlobais} ciclo(s)`);
    }

    for (let ciclo = 1; ciclo <= ctx.tentativaGlobal; ciclo++) {
        const doCiclo = ctx.tentativasPlanner.filter(t => t.ciclo === ciclo).length;
        if (doCiclo > ctx.orcamento.planner) {
            achados.push(`ciclo ${ciclo}: ${doCiclo} propostas do Planner, orcamento de ${ctx.orcamento.planner}`);
        }
    }

    if (DEPOIS_DO_CONHECIMENTO.includes(ctx.status)) {
        if (!ctx.auditoriaRecuperacao) achados.push(`${ctx.status} sem auditoria da recuperacao`);
        if (!ctx.politicaEfetiva) achados.push(`${ctx.status} sem politica efetiva`);
        if (ctx.status !== 'KNOWLEDGE_RETRIEVED' && ctx.promptSemantico === undefined) {
            achados.push(`${ctx.status} sem Prompt Semantico`);
        }
    }
    if (ctx.auditoriaRecuperacao && ctx.auditoriaRecuperacao.id !== ctx.requestId) {
        achados.push(`auditoria ${ctx.auditoriaRecuperacao.id} nao e da execucao ${ctx.requestId}`);
    }

    if (DEPOIS_DA_SEQUENCIA.includes(ctx.status) && !ctx.sequenciaValidada) {
        achados.push(`${ctx.status} sem sequencia validada`);
    }
    if (DEPOIS_DA_DECOMPOSICAO.includes(ctx.status)) {
        const impedimento = impedimentoDeConcluirDecomposicao(ctx);
        if (impedimento) achados.push(`${ctx.status}: ${impedimento}`);
    }
    if (DEPOIS_DOS_PIS.includes(ctx.status)) {
        const impedimento = impedimentoDeConcluirPIs(ctx);
        if (impedimento) achados.push(`${ctx.status}: ${impedimento}`);
    }
    if (ctx.status === 'COMPLETED') {
        const impedimento = impedimentoDeConcluir(ctx);
        if (impedimento) achados.push(`COMPLETED: ${impedimento}`);
        if (ctx.artefatoFinal === undefined || ctx.artefatoFinal !== ctx.planoComposto?.texto) achados.push('COMPLETED sem o artefato do plano validado');
    }
    if (ctx.historicoGlobal.length > ctx.orcamento.ciclosGlobais) {
        achados.push(`${ctx.historicoGlobal.length} ciclos globais registrados, orcamento de ${ctx.orcamento.ciclosGlobais}`);
    }
    ctx.historicoGlobal.forEach((c, i) => {
        if (c.ciclo !== i + 1) achados.push(`o registro ${i + 1} do historico global e do ciclo ${c.ciclo}`);
    });
    for (const e of ctx.execucoesPI) {
        if (e.tentativas.length > ctx.orcamento.porPI) {
            achados.push(`PI ${e.ordem}: ${e.tentativas.length} tentativas, orcamento de ${ctx.orcamento.porPI}`);
        }
        if (e.tentativas.some(t => t.ordem !== e.ordem)) achados.push(`PI ${e.ordem}: tentativa de outro PI no historico`);
        // Um dependente so roda com todos os predecessores VALID.
        const preds = ctx.planoExecucaoPI?.predecessores[e.ordem] ?? [];
        const naoValidos = preds.filter(d => ctx.execucoesPI.find(x => x.ordem === d)?.status !== 'VALID');
        if (e.tentativas.length > 0 && naoValidos.length > 0) {
            achados.push(`PI ${e.ordem} executou sem o(s) predecessor(es) ${naoValidos.join(', ')} VALID`);
        }
    }
    for (const r of ctx.resultadosPI) {
        const pi = ctx.sequenciaValidada?.find(p => p.ordem === r.ordem);
        if (!pi) achados.push(`resultado do PI ${r.ordem} sem PI correspondente na sequencia validada`);
        else if (pi.item !== r.item || pi.conduta !== r.conduta) {
            achados.push(`resultado do PI ${r.ordem} responde (${r.item}, ${r.conduta}), mas o PI e (${pi.item}, ${pi.conduta})`);
        }
    }

    return achados;
}

/** A execucao como a API a devolve: o que ela decidiu, sem repetir o cenario e a recuperacao. */
export interface ResumoExecucao {
    requestId: string;
    status: StatusMultiagente;
    historicoStatus: TransicaoStatus[];
    tentativaGlobal: number;
    orcamento: OrcamentoTentativas;
    tentativasPlanner: TentativaPlanner[];
    sequenciaCandidata?: PIPlanejado[];
    sequenciaValidada?: PIPlanejado[];
    contextosPI?: ContextoGeracaoItem[];
    metricasDecomposicao?: MetricasDecomposicao;
    planoExecucaoPI?: PlanoExecucaoPI;
    ondasPI: RegistroOndaPI[];
    execucoesPI: ExecucaoPI[];
    resultadosPI: ResultadoPI[];
    artefatoFinal?: string;
    validacaoGlobal?: ResultadoValidacao<PlanoComposto>;
    historicoGlobal: CicloGlobal[];
    metricasExecucao?: MetricasExecucao;
    errosValidacao: ResultadoValidacao[];
}

/**
 * Serializavel e sem o que a resposta ja carrega em outro campo: cenario,
 * politica, Prompt Semantico e auditoria da recuperacao ficam de fora — e as
 * restricoes do dominio, que tem `Map`, nao passariam pelo JSON.
 */
export function resumoExecucao(ctx: ContextoExecucaoMultiagente<ContextoDominio, unknown>): ResumoExecucao {
    return {
        requestId: ctx.requestId,
        status: ctx.status,
        historicoStatus: ctx.historicoStatus,
        tentativaGlobal: ctx.tentativaGlobal,
        orcamento: ctx.orcamento,
        tentativasPlanner: ctx.tentativasPlanner,
        sequenciaCandidata: ctx.sequenciaCandidata,
        sequenciaValidada: ctx.sequenciaValidada,
        contextosPI: ctx.contextosPI,
        metricasDecomposicao: ctx.metricasDecomposicao,
        planoExecucaoPI: ctx.planoExecucaoPI,
        ondasPI: ctx.ondasPI,
        execucoesPI: ctx.execucoesPI,
        resultadosPI: ctx.resultadosPI,
        artefatoFinal: ctx.artefatoFinal,
        validacaoGlobal: ctx.validacaoGlobal,
        historicoGlobal: ctx.historicoGlobal,
        metricasExecucao: ctx.metricasExecucao,
        errosValidacao: ctx.errosValidacao
    };
}
