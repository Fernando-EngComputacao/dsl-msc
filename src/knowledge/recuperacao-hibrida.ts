/**
 * Recuperacao hibrida: RAG + Cypher, atras de uma chave de modo.
 *
 * O pipeline passa a ter dois modos, e o padrao continua sendo o atual:
 *
 *   SPC_CML_RECUPERACAO=deterministica        (padrao) o caminho de hoje, intacto
 *   SPC_CML_RECUPERACAO=hibrida_rag_cypher    consulta semantica -> RAG -> Cypher
 *
 * ---------------------------------------------------------------------------
 * O QUE O MODO HIBRIDO MUDA, E O QUE ELE NAO MUDA
 *
 * Muda a ORIGEM DO SINAL VETORIAL do foco. Hoje `retrieverFoco*` embute a fala
 * crua; no modo hibrido quem embute e o RAG, sobre a consulta semantica
 * enriquecida (ver `recuperacao.ts`), e o foco reaproveita esse resultado.
 *
 * NAO muda quem decide o que e permitido. `retrieve*Constraints` continua
 * calculando bloqueios, vetos, ajustes, escalonamentos, invariantes e estado de
 * curso a partir da AST da DSL, exatamente como antes; `filtrarPorFoco*` so
 * estreita essa politica, e `refinarPolitica` so a estreita mais. A saida final
 * e o mesmo `SubgrafoPodado`, com os mesmos `PoliticaItem`, `PapeisDominio` e
 * `ConstantesCenario` — nao ha estrutura paralela.
 *
 * Por que as `RegraValidada` do Cypher NAO sobrescrevem a politica: ha hoje dois
 * avaliadores deterministicos que leem a mesma DSL por caminhos diferentes — o
 * `compare()` de `retrieve*Constraints`, sobre a AST, e o `CASE` de
 * `recuperacao-cypher.ts`, sobre o grafo. Deixar o segundo reescrever o que o
 * primeiro concluiu criaria duas fontes de verdade sobre seguranca, que e
 * exatamente o que esta arquitetura existe para impedir. E o segundo enxerga
 * menos: so nos com `parametro`, entao nunca VETA, PROIBE nem AJUSTA. O veredito
 * do Cypher entra como EVIDENCIA AUDITAVEL e como ESTREITAMENTO
 * (`refinarPolitica`): um bloqueio que ele confirma tira decisao, e o que ele
 * nao ve continua exatamente como a politica deterministica deixou. Convergir
 * os dois avaliadores e uma decisao para uma etapa propria.
 * ---------------------------------------------------------------------------
 *
 * EVITAR DUAS BUSCAS VETORIAIS. O foco e o RAG consultam os MESMOS dois indices.
 * Rodar os dois custaria dois embeddings e quatro consultas por requisicao. Por
 * isso o preparo devolve um `SinalVetorial`, que `retrieverFoco*` aceita como
 * parametro opcional: uma busca so, dois consumidores.
 */

import { type Session } from 'neo4j-driver';

import { numeroDeEnv, type ItemPontuado, type SinalVetorial } from './foco.js';
import {
    buscaPorSessao,
    recuperarCandidatos,
    INDICES_POR_DOMINIO,
    type BuscaVetorial,
    type CandidatoRegra,
    type Embutidor
} from './recuperacao-rag.js';
import {
    executorPorSessao,
    validarCandidatos,
    type ExecutorCypher,
    type RegraValidada
} from './recuperacao-cypher.js';
import type { AjustePolitica, DivergenciaPolitica } from './recuperacao-politica.js';
import {
    construirContextoRecuperacao,
    type ContextoDominio,
    type ContextoRecuperacao,
    type Dominio
} from './recuperacao.js';

// =============================================================================
// Modo
// =============================================================================

export type ModoRecuperacao = 'deterministica' | 'hibrida_rag_cypher';

export const MODO_PADRAO: ModoRecuperacao = 'deterministica';

/**
 * Le `SPC_CML_RECUPERACAO`, seguindo a convencao do projeto (variavel de
 * ambiente com padrao no codigo, como `SPC_CML_DECODIFICACAO` em
 * `decodificacao.ts` ja faz).
 *
 * Um valor desconhecido cai no padrao em vez de quebrar: uma variavel digitada
 * errado nao deve derrubar o servico, e o modo escolhido aparece na auditoria de
 * toda requisicao.
 */
export function modoRecuperacao(bruto = process.env.SPC_CML_RECUPERACAO): ModoRecuperacao {
    return bruto === 'hibrida_rag_cypher' ? 'hibrida_rag_cypher' : MODO_PADRAO;
}

/** Candidatos por indice no modo hibrido — ver `SPC_CML_RAG_TOP_K`. */
const TOP_K = numeroDeEnv(process.env.SPC_CML_RAG_TOP_K, 10);

// =============================================================================
// Auditoria
// =============================================================================

/**
 * Trilha completa de uma recuperacao, da fala ate a politica.
 *
 * Registra so o que o projeto ja registra em outros pontos (o cenario sorteado e
 * o Prompt Semantico ja saem no log e na resposta da API): identificadores de
 * no, escores e valores de telemetria. Nada e acrescentado ao que ja circula.
 */
export interface AuditoriaRecuperacao {
    /** (1) Identificador desta execucao, para correlacionar log e resposta. */
    id: string;
    modo: ModoRecuperacao;
    dominio: Dominio;
    /** (1) A fala, como chegou. */
    intencao: string;
    /** (2) O que foi ao embedding — vazio no modo deterministico. */
    consultaSemantica: string;
    /** (3) Parametros da recuperacao vetorial. */
    topK: number;
    indices: string[];
    /** (9) A telemetria que o lado deterministico usou, exatamente como medida. */
    telemetria: Record<string, number>;
    /** (4)(5) Candidatos do RAG, com o escore que o indice devolveu. */
    candidatos: {
        regraId: string;
        escore: number;
        cosseno: number;
        papel: string;
        posicao: number;
    }[];
    /**
     * (6)(7)(8)(10) O veredito do Cypher, ESTRUTURADO.
     *
     * Guarda a propria `RegraValidada` em vez de um resumo dela: a versao
     * anterior achatava as condicoes num `motivo` de texto e, pior, so
     * preservava `evidencia` nas regras ACEITAS. Uma regra rejeitada ficava sem
     * o valor observado — justamente o dado que a auditoria de uma rejeicao
     * precisa ("R17 rejeitada: PAM observado 82, exigido < 60"). Aqui aceita e
     * rejeitada carregam exatamente a mesma evidencia.
     *
     * Nao ha estrutura paralela: e o mesmo objeto que `recuperacao-cypher.ts`
     * produz, sem copia nem reinterpretacao.
     */
    validacao: RegraValidada[];
    foco?: { itens: string[]; contextos: string[] };
    /** (10) Politica final, como o `SubgrafoPodado` a entrega. */
    politicas?: { item: string; decisoes: string[]; bloqueado: boolean }[];
    /**
     * (10) O que as regras validadas estreitaram na politica — ver
     * `recuperacao-politica.ts`. A politica que sai dessa passada e a politica
     * efetiva: o servidor a entrega ao prompt, a gramatica e ao contrato.
     * `concordam: true` (o esperado) diz que grafo e AST batem nas regras
     * condicionais; VETA, PROIBE e AJUSTA ficam fora da comparacao.
     */
    reconciliacaoPolitica?: {
        concordam: boolean;
        ajustes: AjustePolitica[];
        divergencias: DivergenciaPolitica[];
    };
    /** Preenchido quando o modo hibrido falha e o pipeline cai no baseline. */
    degradou?: string;
}

// ---------------------------------------------------------------------------
// Leitura da trilha
//
// Views sobre `validacao`, para ninguem precisar reimplementar o criterio de
// "aceita" / "rejeitada" / "sem evidencia" em cada consumidor.
// ---------------------------------------------------------------------------

/** Regras cujas condicoes o Cypher confirmou. */
export function regrasAceitas(a: AuditoriaRecuperacao): RegraValidada[] {
    return a.validacao.filter(r => r.aplicavel);
}

/** Regras que o Cypher reprovou por condicao FALSA (nao por falta de dado). */
export function regrasRejeitadas(a: AuditoriaRecuperacao): RegraValidada[] {
    return a.validacao.filter(r => !r.aplicavel && r.condicoesFalhas.length > 0);
}

/** Regras que nao puderam ser avaliadas: o cenario nao mediu o parametro. */
export function regrasSemEvidencia(a: AuditoriaRecuperacao): RegraValidada[] {
    return a.validacao.filter(r => r.lacunas.length > 0);
}

/**
 * Frase de auditoria de UMA regra: o veredito e o porque, com valor observado e
 * valor exigido. Nunca devolve so "aceita"/"rejeitada".
 */
export function explicarRegra(r: RegraValidada): string {
    const condicao = (c: { campo: string; observado: number; esperado: string }): string =>
        `${c.campo} observado ${c.observado}, exigido ${c.esperado}`;

    if (r.aplicavel) {
        return `${r.regraId} ACEITA porque ${r.condicoesSatisfeitas.map(condicao).join(' e ')}`;
    }
    if (r.condicoesFalhas.length > 0) {
        return (
            `${r.regraId} REJEITADA (escore RAG ${r.rag.escore}) porque ` +
            r.condicoesFalhas.map(condicao).join(' e ')
        );
    }
    return (
        `${r.regraId} SEM EVIDENCIA: ` +
        r.lacunas.map(l => `${l.campo} nao medido, exigido ${l.esperado}`).join('; ')
    );
}

/**
 * A trilha de UMA regra, do input ate o veredito — os dez pontos, em ordem, para
 * uma regra so. E o que se le quando alguem pergunta "por que esta regra entrou
 * (ou nao entrou) neste cenario?".
 */
export function rastrearRegra(
    a: AuditoriaRecuperacao,
    regraId: string
): {
    id: string;
    intencao: string;
    consultaSemantica: string;
    topK: number;
    candidato?: AuditoriaRecuperacao['candidatos'][number];
    regra?: RegraValidada;
    telemetriaUsada: Record<string, number>;
    explicacao: string;
} | undefined {
    const regra = a.validacao.find(r => r.regraId === regraId);
    // O candidato e o NO recuperado; a regra e uma das que pendem dele.
    const candidatoId = regra?.rag.candidatoId ?? regraId;
    const candidato = a.candidatos.find(c => c.regraId === candidatoId);
    if (!regra && !candidato) return undefined;

    return {
        id: a.id,
        intencao: a.intencao,
        consultaSemantica: a.consultaSemantica,
        topK: a.topK,
        candidato,
        regra,
        telemetriaUsada: regra?.evidencia ?? {},
        explicacao: regra ? explicarRegra(regra) : `${regraId}: candidato recuperado, sem regra condicional ligada`
    };
}

/** Identificador da execucao. Monotonico e legivel; nao carrega dado do cenario. */
let sequencia = 0;
export function novoIdRecuperacao(): string {
    sequencia += 1;
    return `rec-${Date.now().toString(36)}-${sequencia}`;
}

export function auditoriaVazia(
    modo: ModoRecuperacao,
    dominio: Dominio,
    intencao: string,
    id: string = novoIdRecuperacao()
): AuditoriaRecuperacao {
    return {
        id,
        modo,
        dominio,
        intencao,
        consultaSemantica: '',
        topK: 0,
        indices: [],
        telemetria: {},
        candidatos: [],
        validacao: []
    };
}

/** Linha unica e legivel para o log — o mesmo estilo dos estagios do servidor. */
export function resumoAuditoria(a: AuditoriaRecuperacao): string {
    if (a.modo === 'deterministica') return `recuperacao ${a.modo} [${a.id}]`;
    return (
        `recuperacao ${a.modo} [${a.id}]: ${a.candidatos.length} candidato(s) topK=${a.topK}, ` +
        `${regrasAceitas(a).length} aceita(s), ${regrasRejeitadas(a).length} rejeitada(s), ` +
        `${regrasSemEvidencia(a).length} sem evidencia` +
        (a.degradou ? ` [degradou: ${a.degradou}]` : '')
    );
}

/**
 * A trilha inteira em texto, uma regra por linha, com o porque de cada veredito.
 * Feita para o log e para inspecao manual — nao entra em artefato nenhum.
 */
export function relatorioAuditoria(a: AuditoriaRecuperacao): string {
    const linhas = [
        `[${a.id}] ${a.modo} / ${a.dominio}`,
        `  input:     ${a.intencao}`,
        `  query:     ${a.consultaSemantica}`,
        `  rag:       topK=${a.topK} indices=[${a.indices.join(', ')}] ` +
            `${a.candidatos.length} candidato(s)`
    ];
    for (const c of a.candidatos) {
        linhas.push(`    candidato ${c.regraId} escore=${c.escore} (${c.papel}, pos ${c.posicao})`);
    }
    linhas.push(`  telemetria: ${JSON.stringify(a.telemetria)}`);
    linhas.push(`  validacao: ${a.validacao.length} regra(s)`);
    for (const r of a.validacao) linhas.push(`    ${explicarRegra(r)}`);
    if (a.politicas) {
        linhas.push(`  politica:  ${a.politicas.map(p => p.item + (p.bloqueado ? '*' : '')).join(', ')}`);
    }
    if (a.degradou) linhas.push(`  degradou:  ${a.degradou}`);
    return linhas.join('\n');
}

// =============================================================================
// Preparo hibrido
// =============================================================================

export interface OpcoesHibrida {
    topK?: number;
    /** Identificador da execucao. Injetavel para o teste nao depender do relogio. */
    id?: string;
    /** Injetaveis para teste sem Neo4j nem GPU. */
    embutir?: Embutidor;
    busca?: BuscaVetorial;
    executor?: ExecutorCypher;
}

export interface PreparoHibrido {
    contexto: ContextoRecuperacao;
    candidatos: CandidatoRegra[];
    validadas: RegraValidada[];
    /**
     * O que `retrieverFoco*` recebe para nao repetir a busca. Reconstruido a
     * partir dos candidatos, separado pelo papel de cada indice.
     */
    sinal: SinalVetorial;
    auditoria: AuditoriaRecuperacao;
}

/** Devolve os candidatos ao formato que o foco consome, por papel. */
export function sinalDosCandidatos(candidatos: CandidatoRegra[]): SinalVetorial {
    const paraItem = (c: CandidatoRegra): ItemPontuado => ({
        nome: c.item,
        cosseno: c.cosseno,
        escore: c.escore,
        nodeId: c.nodeId
    });
    return {
        itens: candidatos.filter(c => c.metadados.papel === 'item').map(paraItem),
        contextos: candidatos.filter(c => c.metadados.papel === 'contexto').map(paraItem)
    };
}

/**
 * Executa a metade nova da recuperacao: contexto -> consulta semantica ->
 * embedding -> busca vetorial -> candidatos -> validacao por Cypher.
 *
 * NAO calcula politica e NAO toca em `retrieve*Constraints`. Devolve o sinal
 * vetorial e a evidencia, para o chamador seguir o fluxo normal a partir dai.
 */
export async function prepararHibrido(
    dominio: Dominio,
    contextoDominio: ContextoDominio,
    session: Session | undefined,
    opcoes: OpcoesHibrida = {}
): Promise<PreparoHibrido> {
    const contexto = construirContextoRecuperacao(dominio, contextoDominio);
    const topK = opcoes.topK ?? TOP_K;

    const busca =
        opcoes.busca ??
        (session
            ? buscaPorSessao(session)
            : () => Promise.reject(new Error('sem sessao Neo4j para a busca vetorial')));
    const executor =
        opcoes.executor ??
        (session
            ? executorPorSessao(session)
            : () => Promise.reject(new Error('sem sessao Neo4j para a validacao Cypher')));

    const candidatos = await recuperarCandidatos(contexto, busca, {
        topK,
        embutir: opcoes.embutir
    });
    const validadas = await validarCandidatos(contexto, candidatos, executor);

    const auditoria: AuditoriaRecuperacao = {
        id: opcoes.id ?? novoIdRecuperacao(),
        modo: 'hibrida_rag_cypher',
        dominio,
        intencao: contexto.intencao,
        consultaSemantica: contexto.consultaSemantica,
        topK,
        indices: indicesConsultados(dominio),
        // A MESMA telemetria que o Cypher recebeu como parametro — nao uma copia
        // reformatada. E o que torna a trilha conferivel contra o veredito.
        telemetria: contexto.contextoEstruturado.telemetria,
        candidatos: candidatos.map(c => ({
            regraId: c.regraId,
            escore: c.escore,
            cosseno: c.cosseno,
            papel: c.metadados.papel,
            posicao: c.metadados.posicao
        })),
        validacao: validadas
    };

    return { contexto, candidatos, validadas, sinal: sinalDosCandidatos(candidatos), auditoria };
}

/**
 * Preparo tolerante a falha, para uso no pipeline.
 *
 * Se a metade nova falhar (motor de embedding fora do ar, indice ausente,
 * Cypher recusado), devolve `undefined` com o motivo na auditoria em vez de
 * derrubar a requisicao: o chamador segue com `sinal` indefinido e
 * `retrieverFoco*` volta a embutir por conta propria — isto e, degrada para o
 * comportamento baseline, que e o mesmo que o projeto ja faz quando o foco por
 * embedding esta indisponivel.
 */
export async function prepararHibridoTolerante(
    dominio: Dominio,
    contextoDominio: ContextoDominio,
    session: Session | undefined,
    opcoes: OpcoesHibrida = {}
): Promise<{ preparo?: PreparoHibrido; auditoria: AuditoriaRecuperacao }> {
    try {
        const preparo = await prepararHibrido(dominio, contextoDominio, session, opcoes);
        return { preparo, auditoria: preparo.auditoria };
    } catch (error) {
        const auditoria = auditoriaVazia(
            'hibrida_rag_cypher',
            dominio,
            contextoDominio.intencao ?? '',
            opcoes.id
        );
        auditoria.degradou = (error as Error).message;
        return { auditoria };
    }
}

/** Os indices que o modo hibrido consulta num dominio — util para log e teste. */
export function indicesConsultados(dominio: Dominio): string[] {
    const i = INDICES_POR_DOMINIO[dominio];
    return [i.item.indice, i.contexto.indice];
}
