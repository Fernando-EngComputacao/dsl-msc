/**
 * Recuperacao de conhecimento POR REQUISICAO — o bloco que `processarMed`,
 * `processarAgro` e `processarFut` (src/web/server.ts) repetiam linha a linha:
 *
 *     retrieve*Constraints
 *       -> [modo hibrido] prepararHibridoTolerante (RAG + Cypher)
 *       -> retrieverFoco* -> filtrarPorFoco*
 *       -> *PruningPayload -> [validacao nao vazia] refinarPolitica
 *       -> politicaEfetiva -> montarPromptSemantico*
 *
 * EXTRACAO SEM MUDANCA DE COMPORTAMENTO. A ordem das chamadas, o texto de cada
 * estagio do SSE, o momento em que a sessao do Neo4j abre e fecha e o
 * tratamento de falha do foco sao os do codigo que estava no servidor.
 * `recuperacao-conhecimento.test.ts` roda uma copia literal do bloco antigo
 * lado a lado com esta funcao, nos tres dominios e nos dois modos de
 * recuperacao, e exige saida identica.
 *
 * O que muda por dominio cabe num ADAPTADOR (`ADAPTADOR_MED/AGRO/FUT`): as
 * funcoes de recuperacao, foco, poda e prompt, e os rotulos com que o foco
 * aparece no estagio e na resposta. A maquinaria e uma so — o mesmo principio
 * de `PapeisDominio` em `knowledge/politica.ts`.
 *
 * E tambem a etapa RECUPERACAO + PROMPT SEMANTICO GLOBAL do modo multiagente
 * (ver `multiagente.ts`): ele reaproveita esta funcao, nao uma segunda copia.
 */

import type { Session } from 'neo4j-driver';

import type { AgroModel, FutModel, MedicalModel } from '../generated/ast.js';
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
    type AgroFoco,
    type RetrievedAgroConstraints
} from '../knowledge/graphrag-agro.js';
import {
    filtrarPorFocoFut,
    futPruningPayload,
    retrieveFutConstraints,
    retrieverFocoFut,
    type FutContext,
    type FutFoco,
    type RetrievedFutConstraints
} from '../knowledge/graphrag-fut.js';
import type { SinalVetorial } from '../knowledge/foco.js';
import type { SubgrafoPodado } from '../knowledge/politica.js';
import type { ContextoDominio, Dominio } from '../knowledge/recuperacao.js';
import {
    auditoriaVazia,
    modoRecuperacao,
    prepararHibridoTolerante,
    resumoAuditoria,
    type AuditoriaRecuperacao
} from '../knowledge/recuperacao-hibrida.js';
import { refinarPolitica } from '../knowledge/recuperacao-politica.js';
import { montarPromptSemantico } from './llm-client.js';
import { montarPromptSemanticoAgro } from './agro-client.js';
import { montarPromptSemanticoFut } from './fut-client.js';

/** Emite um estagio para o front-end (SSE). O servidor faz uma pausa minima em cada um. */
export type EmitirEstagio = (texto: string) => Promise<void>;

/** O foco como a API o devolve: cada dominio com os nomes dos seus nos. */
export type FocoResposta =
    | { farmacos: string[]; protocolos: string[] }
    | { produtos: string[]; culturas: string[] }
    | { infracoes: string[]; lances: string[] };

/** Os dois lados do foco, sem o nome de dominio no campo. */
export interface EscopoFoco {
    itens: Set<string>;
    contextos: Set<string>;
    /** Como cada no entrou no foco: lexical, vetorial ou grafo. */
    origem: Map<string, string>;
}

/**
 * Tudo o que muda entre dominios na recuperacao. `M` e o modelo da DSL, `C` o
 * contexto do cenario, `R` as restricoes recuperadas e `F` o foco.
 */
export interface AdaptadorRecuperacao<M, C extends ContextoDominio, R, F> {
    dominio: Dominio;
    recuperar(modelo: M, contexto: C): R;
    /** Contagens do estagio "Regras recuperadas: ...". */
    resumoRegras(constraints: R): string;
    focar(session: Session, texto: string, modelo: M, sinal?: SinalVetorial): Promise<F>;
    filtrar(constraints: R, foco: F, modelo: M, contexto: C): R;
    escopo(foco: F): EscopoFoco;
    /** Nomes dos dois lados do foco no estagio e na resposta — e a ORDEM das chaves na resposta. */
    rotulos: { itens: string; contextos: string };
    podar(constraints: R, contexto: C): SubgrafoPodado;
    montarPrompt(constraints: R, contexto: C, politica: SubgrafoPodado): string;
}

export const ADAPTADOR_MED: AdaptadorRecuperacao<MedicalModel, ClinicalContext, RetrievedConstraints, Foco> = {
    dominio: 'med',
    recuperar: retrieveConstraints,
    resumoRegras: c =>
        `${c.protocolosAtivos.length} protocolos ativos, ` +
        `${c.bloqueios.length} bloqueios, ${c.vetados.length} vetos`,
    focar: retrieverFoco,
    filtrar: filtrarPorFoco,
    escopo: f => ({ itens: f.farmacos, contextos: f.protocolos, origem: f.origem }),
    rotulos: { itens: 'farmacos', contextos: 'protocolos' },
    podar: pruningPayload,
    montarPrompt: montarPromptSemantico
};

export const ADAPTADOR_AGRO: AdaptadorRecuperacao<AgroModel, AgroContext, RetrievedAgroConstraints, AgroFoco> = {
    dominio: 'agro',
    recuperar: retrieveAgroConstraints,
    resumoRegras: c =>
        `${c.culturasAtivas.length} culturas ativas, ` +
        `${c.bloqueios.length} bloqueios, ${c.vetados.length} vetos`,
    focar: retrieverFocoAgro,
    filtrar: filtrarPorFocoAgro,
    escopo: f => ({ itens: f.produtos, contextos: f.culturas, origem: f.origem }),
    rotulos: { itens: 'produtos', contextos: 'culturas' },
    podar: agroPruningPayload,
    montarPrompt: montarPromptSemanticoAgro
};

export const ADAPTADOR_FUT: AdaptadorRecuperacao<FutModel, FutContext, RetrievedFutConstraints, FutFoco> = {
    dominio: 'fut',
    recuperar: retrieveFutConstraints,
    resumoRegras: c =>
        `${c.lancesAtivos.length} lances ativos, ` +
        `${c.bloqueios.length} bloqueios, ${c.vetados.length} vetos`,
    focar: retrieverFocoFut,
    filtrar: filtrarPorFocoFut,
    escopo: f => ({ itens: f.infracoes, contextos: f.lances, origem: f.origem }),
    rotulos: { itens: 'infracoes', contextos: 'lances' },
    podar: futPruningPayload,
    montarPrompt: montarPromptSemanticoFut
};

/**
 * O que a recuperacao entrega a quem gera. `politicaEfetiva` e a UNICA politica
 * da requisicao: prompt, gramatica, contrato e resposta da API leem esta, e
 * nenhuma outra.
 */
export interface ConhecimentoRecuperado<R> {
    /** As restricoes depois do foco — o que o Prompt Semantico e o contrato leem. */
    constraints: R;
    foco: FocoResposta | null;
    /** Motivo da falha do foco, quando o embedding ou o Neo4j nao responderam. */
    focoIndisponivel?: string;
    auditoriaRecuperacao: AuditoriaRecuperacao;
    /** A poda deterministica, antes do refinamento. */
    poda: SubgrafoPodado;
    /** `subgrafoRefinado ?? poda`. */
    politicaEfetiva: SubgrafoPodado;
    promptSemantico: string;
}

export interface OpcoesRecuperacaoConhecimento {
    /**
     * Identificador da requisicao na auditoria. Ausente: `novoIdRecuperacao()`,
     * como sempre foi — o servidor nao passa. O modo multiagente passa o seu
     * `requestId`, para auditoria e execucao terem o mesmo id.
     */
    id?: string;
}

/**
 * Lista o foco anotando de onde cada no veio — lexical (o usuario escreveu o
 * nome), vetorial (similaridade no indice) ou grafo (entrou junto pela aresta).
 * E o que permite auditar, na propria interface, se o subgrafo ativado
 * corresponde ao que foi pedido.
 */
function descreverFoco(nomes: Set<string>, origem: Map<string, string>): string {
    if (nomes.size === 0) return '—';
    return [...nomes].map(n => `${n} (${origem.get(n) ?? 'grafo'})`).join(', ');
}

export async function recuperarConhecimento<M, C extends ContextoDominio, R, F>(
    adaptador: AdaptadorRecuperacao<M, C, R, F>,
    modelo: M,
    contexto: C,
    texto: string,
    estagio: EmitirEstagio,
    /** Chamada no mesmo ponto em que o servidor chamava `driver.session()`. */
    abrirSessao: () => Session,
    opcoes: OpcoesRecuperacaoConhecimento = {}
): Promise<ConhecimentoRecuperado<R>> {
    await estagio('Buscando regras no grafo de conhecimento…');
    let constraints = adaptador.recuperar(modelo, contexto);
    await estagio(`Regras recuperadas: ${adaptador.resumoRegras(constraints)}`);

    let foco: FocoResposta | null = null;
    let focoIndisponivel: string | undefined;

    // Modo de recuperacao: o padrao continua sendo o caminho deterministico.
    // No modo hibrido, o RAG embute a consulta semantica e consulta os dois
    // indices UMA vez; o foco reaproveita esse sinal em vez de buscar de novo.
    const modo = modoRecuperacao();
    let auditoriaRecuperacao: AuditoriaRecuperacao = auditoriaVazia(modo, adaptador.dominio, texto, opcoes.id);
    let sinal: SinalVetorial | undefined;

    await estagio('Calculando foco por embedding no subgrafo…');
    const session = abrirSessao();
    try {
        if (modo === 'hibrida_rag_cypher') {
            const hibrido = await prepararHibridoTolerante(
                adaptador.dominio,
                contexto,
                session,
                opcoes.id === undefined ? undefined : { id: opcoes.id }
            );
            auditoriaRecuperacao = hibrido.auditoria;
            sinal = hibrido.preparo?.sinal;
            await estagio(resumoAuditoria(auditoriaRecuperacao));
        }
        const f = await adaptador.focar(session, texto, modelo, sinal);
        constraints = adaptador.filtrar(constraints, f, modelo, contexto);
        const { itens, contextos, origem } = adaptador.escopo(f);
        auditoriaRecuperacao.foco = { itens: [...itens], contextos: [...contextos] };
        foco = {
            [adaptador.rotulos.itens]: [...itens],
            [adaptador.rotulos.contextos]: [...contextos]
        } as FocoResposta;
        await estagio(
            `Foco recuperado: ${adaptador.rotulos.itens} [${descreverFoco(itens, origem)}], ` +
                `${adaptador.rotulos.contextos} [${descreverFoco(contextos, origem)}]`
        );
    } catch (error) {
        focoIndisponivel = (error as Error).message;
        await estagio('Foco por embedding indisponível — seguindo com o grafo completo');
    } finally {
        await session.close();
    }

    const poda = adaptador.podar(constraints, contexto);
    // Refinamento: as regras que o Cypher confirmou estreitam a politica
    // deterministica. `refinarPolitica` barra com excecao qualquer resultado que
    // nao seja subconjunto dela — fail-closed, sem fallback para a politica mais
    // ampla. A excecao sobe ate o chamador e a geracao NAO acontece.
    let subgrafoRefinado: SubgrafoPodado | undefined;
    if (auditoriaRecuperacao.validacao.length > 0) {
        const rec = refinarPolitica(poda, auditoriaRecuperacao.validacao);
        auditoriaRecuperacao.reconciliacaoPolitica = {
            concordam: rec.concordam, ajustes: rec.ajustes, divergencias: rec.divergencias
        };
        subgrafoRefinado = rec.subgrafo;
    }
    // A POLITICA EFETIVA desta requisicao: a que alimenta o prompt, a
    // gramatica, o contrato e a resposta da API. Uma variavel so, consumida
    // por todos — sem ela cada consumidor escolhia a sua, e a API chegou a
    // anunciar decisoes que a geracao ja nao admitia.
    const politicaEfetiva = subgrafoRefinado ?? poda;
    auditoriaRecuperacao.politicas = politicaEfetiva.politicas.map(pi => ({
        item: pi.item, decisoes: pi.decisoes, bloqueado: pi.bloqueado
    }));
    const promptSemantico = adaptador.montarPrompt(constraints, contexto, politicaEfetiva);

    return { constraints, foco, focoIndisponivel, auditoriaRecuperacao, poda, politicaEfetiva, promptSemantico };
}
