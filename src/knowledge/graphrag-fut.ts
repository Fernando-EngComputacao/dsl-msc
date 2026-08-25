/**
 * Recuperacao no Grafo de Conhecimento de arbitragem (GraphRAG) — etapa 2 da
 * Figura 5.1, dominio futebol.
 *
 * Espelha src/knowledge/graphrag.ts (clinico) e src/knowledge/graphrag-agro.ts
 * (agricola) no dominio da arbitragem de futebol. Recebe a leitura da partida
 * (minuto, cartoes acumulados, distancias) e devolve o subgrafo de restricoes
 * que incide sobre aquele instante do jogo. A avaliacao e DETERMINISTICA: quem
 * decide se uma segunda advertencia esta bloqueada e a comparacao
 * `cartoes_amarelos_jogador 0 < 1`, nao o LLM.
 *
 * Como nos outros dois dominios, a saida principal e uma POLITICA POR INFRACAO —
 * quais decisoes, reinicios e unidades continuam admissiveis para cada infracao:
 *
 *     "marca a segunda amarela do jogador" deixa de ser uma resposta improvavel
 *     e passa a ser uma cadeia que a gramatica nao gera, quando nao ha primeira
 *     amarela registrada.
 */

import { type Session } from 'neo4j-driver';

import {
    isAgravanteAttr,
    isContextAdjust,
    isContextDef,
    isContextForbid,
    isEscalationAttr,
    isFutBlockRule,
    isFutForbidAttr,
    isFutRecommendAttr,
    isFutSchemaDef,
    isGlobalRule,
    isInfractionDef,
    isIsencaoAttr,
    isLimiarAttr,
    isMonitorAttr,
    isSituationDef,
    isTriggerAttr,
    type FutModel,
    type InfractionDef,
    type Operator,
    type SituationDef
} from '../generated/ast.js';
import { nomesFut } from './documentos.js';
import {
    formatarNumero,
    montarSubgrafo,
    type ConstantesCenario,
    type PapeisDominio,
    type PoliticaItem,
    type SubgrafoPodado,
    type ValorAdmissivel
} from './politica.js';
import { embedTexto } from './embeddings.js';
import {
    casamentoLexical,
    ladoMaisDecidido,
    dedup,
    selecionarPorSimilaridade,
    topKParaGrafo,
    topKPorVetor
} from './foco.js';

export interface FutContext {
    /** Leitura corrente da partida: parametro -> valor observado. */
    telemetria: Record<string, number>;
    /** Contextos especiais em que a partida se enquadra (ex.: Acrescimos). */
    contextos?: string[];
    /** Infracoes ja marcadas na partida, usadas para avaliar agravantes. */
    infracoesEmUso?: string[];
    /** Fala do arbitro/observador, preservada para compor o Prompt Semantico. */
    intencao?: string;
    /** Identificacao da partida para o registro de auditoria. */
    partida?: string;
}

/** Politica de saida admissivel para uma infracao, dado o contexto. */
export interface InfractionPolicy {
    infracao: string;
    decisoes: string[];
    reinicios: string[];
    unidades: string[];
    /** Minuto admissivel na marcacao — o da leitura corrente, nao um qualquer. */
    valores: ValorAdmissivel[];
    motivos: string[];
    bloqueado: boolean;
}

export interface RetrievedFutConstraints {
    lancesAtivos: { nome: string; lei: string; gatilhos: string[] }[];
    bloqueios: { infracao: string; regra: string; razao: string }[];
    ajustes: { infracao: string; acao: string; detalhe: string; origem: string }[];
    recomendados: { infracao: string; indicacao: string; lance: string }[];
    /** `lance` presente quando o veto vem de um lance; ausente quando vem de um contexto de partida. */
    vetados: { infracao: string; motivo: string; origem: string; lance?: string }[];
    escalonamentos: { destino: string; detalhe: string; lance: string }[];
    agravantes: { entre: string; gravidade: string; mecanismo: string; conduta: string }[];
    isencoes: { infracao: string; condicao: string; excecao: string }[];
    regrasGlobais: { descricao: string; severidade: string }[];
    politicas: Map<string, InfractionPolicy>;
}

/** Decisoes que representam agravamento da sancao sobre a infracao. */
const DECISOES_DE_INCREMENTO = new Set(['CARTAO_VERMELHO', 'EXPULSAR', 'PENALTI']);

/** Decisoes admissiveis quando a infracao esta integralmente vetada. */
const DECISOES_DE_RETIRADA = ['MANTER_JOGO', 'BLOQUEAR_DECISAO', 'ACIONAR_VAR'];

function compare(value: number, operator: Operator, threshold: number): boolean {
    switch (operator) {
        case '>':
            return value > threshold;
        case '<':
            return value < threshold;
        case '>=':
            return value >= threshold;
        case '<=':
            return value <= threshold;
        case '==':
            return value === threshold;
        case '!=':
            return value !== threshold;
    }
}

function unitsOf(infraction: InfractionDef): string[] {
    const units = new Set<string>();
    for (const attr of infraction.attributes) {
        if (isLimiarAttr(attr)) units.add(attr.threshold.unit);
        else if (isMonitorAttr(attr)) units.add(attr.interval.unit);
    }
    return [...units];
}

/**
 * Minuto admissivel de uma marcacao.
 *
 * Diferente de dose e vazao, o minuto nao e uma escolha do arbitro: e a leitura
 * do cronometro, que o cenario ja informa. Entao o "reticulo" aqui tem um
 * elemento so — e escrever outro minuto na sumula deixa de ser exprimivel.
 * Sem `minuto_partida` na leitura, volta vazio e o campo segue livre.
 */
function valoresDaLeitura(telemetria: Record<string, number>): ValorAdmissivel[] {
    const minuto = telemetria['minuto_partida'];
    if (minuto === undefined) return [];
    const acrescimo = telemetria['acrescimo'] ?? 0;
    const valores = new Set([formatarNumero(minuto)]);
    // Nos acrescimos, tanto o minuto corrido quanto o regulamentar sao a mesma
    // marcacao para a sumula; o modelo aceita os dois.
    if (acrescimo > 0) valores.add(formatarNumero(minuto - acrescimo));
    return [...valores].map(valor => ({ valor, unidade: 'min' }));
}

/** Papeis da gramatica de arbitragem — ver `PapeisDominio`. */
export const PAPEIS_FUT: PapeisDominio = {
    artefato: 'arbitragem',
    clausula: 'marcacao',
    item: 'infracao',
    decisao: 'decisao',
    meio: 'reinicio',
    quantidade: 'quantidade',
    campoQuantidade: 'minuto',
    campoSujeito: 'partida',
    contexto: 'lance',
    conduta: 'conduta',
    // Uma sancao mais grave e o analogo do incremento: expoe mais o jogador.
    decisoesDeIncremento: ['CARTAO_AMARELO', 'CARTAO_VERMELHO', 'EXPULSAR', 'PENALTI'],
    decisaoDeEscalonamento: 'ACIONAR_VAR'
    // Sem estado de curso: uma infracao nao "esta em andamento" como uma infusao.
};

/** decisao -> conduta declarada no `esquema_dados`. */
/** Nome do `esquema_dados` do modelo — o cabecalho do artefato o cita. */
export function esquemaDeDadosFut(model: FutModel): string | undefined {
    return model.elements.filter(isFutSchemaDef)[0]?.name;
}

export function condutasPorDecisaoFut(model: FutModel): Record<string, string> {
    const schema = model.elements.filter(isFutSchemaDef)[0];
    const mapa: Record<string, string> = {};
    if (!schema) return mapa;
    for (const conduta of schema.conducts) mapa[conduta.decision] = conduta.name;
    return mapa;
}

/**
 * Percorre o grafo derivado do modelo e devolve as restricoes ativas.
 * Regras cujo parametro nao esta na leitura da partida sao ignoradas: leitura
 * ausente nao e evidencia de condicao segura, mas tambem nao autoriza bloquear.
 */
export function retrieveFutConstraints(
    model: FutModel,
    context: FutContext
): RetrievedFutConstraints {
    const telemetria = context.telemetria;
    const contextos = new Set(context.contextos ?? []);
    const emUso = new Set(context.infracoesEmUso ?? []);

    const infractions = model.elements.filter(isInfractionDef);
    const schema = model.elements.filter(isFutSchemaDef)[0];
    if (!schema) throw new Error('Modelo sem `esquema_dados`: nao ha universo de respostas.');

    const result: RetrievedFutConstraints = {
        lancesAtivos: [],
        bloqueios: [],
        ajustes: [],
        recomendados: [],
        vetados: [],
        escalonamentos: [],
        agravantes: [],
        isencoes: [],
        regrasGlobais: [],
        politicas: new Map()
    };

    // ------------------------------------------------- politica inicial (aberta)
    for (const infraction of infractions) {
        result.politicas.set(infraction.name, {
            infracao: infraction.name,
            decisoes: [...schema.decisions],
            reinicios: [...schema.restarts],
            unidades: unitsOf(infraction),
            valores: valoresDaLeitura(telemetria),
            motivos: [],
            bloqueado: false
        });
    }

    // ------------------------------------------------------- lances e gatilhos
    for (const situation of model.elements.filter(isSituationDef)) {
        const gatilhos: string[] = [];
        for (const attr of situation.attributes) {
            if (!isTriggerAttr(attr)) continue;
            const observado = telemetria[attr.parameter];
            if (observado === undefined) continue;
            if (compare(observado, attr.operator, attr.value.value)) {
                gatilhos.push(
                    `${attr.parameter} ${observado} ${attr.operator} ${attr.value.value} ${attr.value.unit} -> ${attr.action}`
                );
            }
        }
        if (gatilhos.length === 0) continue;

        result.lancesAtivos.push({ nome: situation.name, lei: situation.lawRef, gatilhos });

        for (const attr of situation.attributes) {
            if (isFutRecommendAttr(attr)) {
                result.recomendados.push({
                    infracao: attr.infraction.$refText,
                    indicacao: attr.indication ?? '',
                    lance: situation.name
                });
            } else if (isFutForbidAttr(attr)) {
                result.vetados.push({
                    infracao: attr.infraction.$refText,
                    motivo: attr.reason,
                    origem: `lance ${situation.name}`,
                    lance: situation.name
                });
            } else if (isEscalationAttr(attr)) {
                const observado = telemetria[attr.parameter];
                if (observado !== undefined && compare(observado, attr.operator, attr.value.value)) {
                    result.escalonamentos.push({
                        destino: attr.target,
                        detalhe: attr.detail,
                        lance: situation.name
                    });
                }
            }
        }
    }

    // ------------------------------------------- invariantes de seguranca ativas
    for (const element of model.elements) {
        if (!isFutBlockRule(element)) continue;
        const observado = telemetria[element.parameter];
        if (observado === undefined) continue;
        if (!compare(observado, element.operator, element.threshold.value)) continue;

        const infracao = element.infraction.$refText;
        const regra = `${element.parameter} ${observado} ${element.operator} ${element.threshold.value} ${element.threshold.unit}`;
        result.bloqueios.push({ infracao, regra, razao: element.reason });

        const policy = result.politicas.get(infracao);
        if (policy) {
            // Bloqueio de decisao: a infracao continua citavel, mas nenhuma
            // decisao que agrave a sancao permanece na gramatica.
            policy.decisoes = policy.decisoes.filter(d => !DECISOES_DE_INCREMENTO.has(d));
            policy.bloqueado = true;
            policy.motivos.push(`decisao bloqueada (${regra}): ${element.reason}`);
        }
    }

    // ------------------------------------------------------- contextos especiais
    for (const contextDef of model.elements.filter(isContextDef)) {
        if (!contextos.has(contextDef.name)) continue;
        for (const restriction of contextDef.restrictions) {
            if (isContextForbid(restriction)) {
                result.vetados.push({
                    infracao: restriction.infraction.$refText,
                    motivo: restriction.reason,
                    origem: `contexto ${contextDef.name}`
                });
            } else if (isContextAdjust(restriction)) {
                result.ajustes.push({
                    infracao: restriction.infraction.$refText,
                    acao: `multiplicar gravidade por ${restriction.factor}`,
                    detalhe: restriction.reason ?? '',
                    origem: `contexto ${contextDef.name}`
                });
            }
        }
    }

    // ------------------------------------ vetos aplicados as politicas de saida
    for (const veto of result.vetados) {
        const policy = result.politicas.get(veto.infracao);
        if (!policy) continue;
        policy.decisoes = policy.decisoes.filter(d => DECISOES_DE_RETIRADA.includes(d));
        policy.bloqueado = true;
        policy.motivos.push(`vetado por ${veto.origem}: ${veto.motivo}`);
    }

    // -------------------------------------------- agravantes e isencoes
    for (const infraction of infractions) {
        for (const attr of infraction.attributes) {
            if (isAgravanteAttr(attr)) {
                const outro = attr.other.$refText;
                // So interessa o agravante entre infracoes efetivamente marcadas na partida.
                if (!emUso.has(infraction.name) && !emUso.has(outro)) continue;
                result.agravantes.push({
                    entre: `${infraction.name} + ${outro}`,
                    gravidade: attr.severity,
                    mecanismo: attr.mechanism,
                    conduta: attr.conduct ?? ''
                });
            } else if (isIsencaoAttr(attr)) {
                result.isencoes.push({
                    infracao: infraction.name,
                    condicao: attr.condition,
                    excecao: attr.exception ?? ''
                });
            }
        }
    }

    for (const element of model.elements) {
        if (isGlobalRule(element)) {
            result.regrasGlobais.push({
                descricao: element.description,
                severidade: element.severity ?? 'nao especificada'
            });
        }
    }

    return result;
}

/**
 * Payload de poda no formato consumido por `python_engine/grammar_from_kg.py`.
 *
 * ATENCAO — mesma limitacao dos outros dois dominios (ver graphrag.ts e
 * graphrag-agro.ts): as tres listas sao independentes e perdem a associacao
 * (infracao, decisao, reinicio) que `politicas` calcula corretamente. Uma
 * infracao sobrevive a poda enquanto tiver QUALQUER decisao admissivel, e a
 * uniao das decisoes de todas as infracoes passa a valer para todas — o que
 * devolve o produto cartesiano ao decodificador.
 */
export function futPruningPayload(
    constraints: RetrievedFutConstraints,
    contexto?: FutContext
): SubgrafoPodado {
    const politicas: PoliticaItem[] = [...constraints.politicas.values()].map(p => ({
        item: p.infracao,
        decisoes: p.decisoes,
        meios: p.reinicios,
        unidades: p.unidades,
        valores: p.valores,
        // Sem mapa por decisao: o minuto e o da leitura, qualquer que seja a sancao.
        bloqueado: p.bloqueado,
        motivos: p.motivos
    }));

    const constantes: ConstantesCenario = {
        sujeito: contexto?.partida,
        contextos: constraints.lancesAtivos.map(l => l.nome)
    };

    return montarSubgrafo(politicas, PAPEIS_FUT, constantes);
}

/**
 * Recuperacao do subgrafo em foco — espelha `graphrag.ts::retrieverFoco` e
 * `graphrag-agro.ts::retrieverFocoAgro` no dominio da arbitragem. So decide
 * QUAIS infracoes/lances entram no Prompt Semantico; a avaliacao de bloqueio
 * continua 100% deterministica em `retrieveFutConstraints`.
 *
 * Combina os tres sinais descritos em `knowledge/foco.ts`: o nome escrito na
 * fala (lexical), a proximidade no indice vetorial (vetorial) e as arestas do
 * grafo a partir do que os dois primeiros acharam (estrutural).
 */
export interface FutFoco {
    infracoes: Set<string>;
    lances: Set<string>;
    /** Como cada no entrou no foco — para o log da interface e para auditoria. */
    origem: Map<string, OrigemFoco>;
}


export type OrigemFoco = 'lexical' | 'vetorial' | 'grafo';

function registrar(origem: Map<string, OrigemFoco>, nomes: Iterable<string>, tipo: OrigemFoco): void {
    for (const nome of nomes) {
        // Primeira origem vence: lexical e mais informativo que "veio junto".
        if (!origem.has(nome)) origem.set(nome, tipo);
    }
}

/**
 * Expansao estrutural, sentido item -> contexto, seguindo apenas `recomenda`.
 *
 * Sem isto, "foi mao dele" traria a infracao e nenhuma das restricoes do lance em que ela e julgada.
 * Seguir tambem `veta` seria errado aqui: seguir `veta` traria de volta lances que nao tem a ver com a chamada, so porque descartam aquela infracao.
 */
function expandirInfracoesParaLances(
    model: FutModel,
    infracoes: Set<string>,
    lances: Set<string>,
    origem: Map<string, OrigemFoco>
): void {
    for (const situation of model.elements.filter(isSituationDef)) {
        if (lances.has(situation.name)) continue;
        for (const attr of situation.attributes) {
            if (isFutRecommendAttr(attr) && infracoes.has(attr.infraction.$refText)) {
                lances.add(situation.name);
                registrar(origem, [situation.name], 'grafo');
                break;
            }
        }
    }
}

/**
 * Expansao estrutural, sentido contexto -> item, seguindo `recomenda` E `veta`:
 * com o lance em foco, o que ele proibe e tao pertinente quanto o que indica.
 */
function expandirLancesParaInfracoes(
    model: FutModel,
    infracoes: Set<string>,
    lances: Set<string>,
    origem: Map<string, OrigemFoco>
): void {
    for (const situation of model.elements.filter(isSituationDef)) {
        if (!lances.has(situation.name)) continue;
        for (const attr of situation.attributes) {
            const vizinho = isFutRecommendAttr(attr) || isFutForbidAttr(attr) ? attr.infraction.$refText : undefined;
            if (vizinho && !infracoes.has(vizinho)) {
                infracoes.add(vizinho);
                registrar(origem, [vizinho], 'grafo');
            }
        }
    }
}

export async function retrieverFocoFut(
    session: Session,
    intencao: string,
    model: FutModel
): Promise<FutFoco> {
    const nomes = nomesFut(model);
    const origem = new Map<string, OrigemFoco>();

    const lexInfracoes = casamentoLexical(intencao, nomes.infracoes);
    const lexLances = casamentoLexical(intencao, nomes.lances);
    registrar(origem, lexInfracoes, 'lexical');
    registrar(origem, lexLances, 'lexical');

    const vetor = await embedTexto(intencao);
    // Sequencial, nao Promise.all: uma Session do driver nao roda duas queries
    // concorrentes ("Queries cannot be run directly on a session with an open
    // transaction").
    const vetInfracoes = selecionarPorSimilaridade(
        await topKPorVetor(session, 'infracao_embedding', vetor, topKParaGrafo(nomes.infracoes.length))
    );
    const vetLances = selecionarPorSimilaridade(
        await topKPorVetor(session, 'lance_embedding', vetor, topKParaGrafo(nomes.lances.length))
    );

    const infracoes = new Set(lexInfracoes);
    const lances = new Set(lexLances);
    // Ancorado pelo nome escrito, ou semeado pelo indice logo adiante.
    let contextoDeliberado = lances.size > 0;

    // Sem nome escrito no pedido, o vetor semeia UM lado so — aquele em que ele
    // se compromete mais (ver `ladoMaisDecidido`). O outro vem das arestas.
    if (infracoes.size === 0 && lances.size === 0) {
        if (ladoMaisDecidido(vetInfracoes, vetLances) === 'contexto') {
            // So o primeiro colocado: um contexto ja arrasta o subgrafo inteiro
            // dele, e semear dois duplica o Prompt Semantico.
            if (vetLances.melhor) {
                lances.add(vetLances.melhor);
                contextoDeliberado = true;
            }
        } else {
            for (const nome of vetInfracoes.nomes) infracoes.add(nome);
        }
    }

    // Registrado so agora: o lexical ja esta na tabela e vence pelo criterio de
    // primeira origem, entao o que recebe 'vetorial' aqui veio mesmo do indice.
    registrar(origem, infracoes, 'vetorial');
    registrar(origem, lances, 'vetorial');

    expandirInfracoesParaLances(model, infracoes, lances, origem);
    // O indice so escolhe contexto quando nenhuma aresta o alcancou.
    if (lances.size === 0) {
        if (vetLances.melhor) {
            registrar(origem, [vetLances.melhor], 'vetorial');
            lances.add(vetLances.melhor);
            contextoDeliberado = true;
        }
    }
    // Contexto ancorado ou semeado foi escolha deliberada e expande sempre.
    // Contexto apenas DERIVADO de um item so expande se for unico: varios
    // contextos derivados significam pedido ambiguo, e devolver o catalogo de
    // cada um reconstroi o grafo inteiro dentro do Prompt Semantico.
    if (contextoDeliberado || lances.size === 1) {
        expandirLancesParaInfracoes(model, infracoes, lances, origem);
    }

    return { infracoes, lances, origem };
}

/**
 * Restricoes que um lance impoe independentemente de gatilho numerico.
 *
 * `retrieveFutConstraints` so coleta `recomenda`/`veta`/`escalonar` de lances
 * cujo gatilho disparou — o que descreve bem o INSTANTE da partida, mas elimina
 * o lance que o arbitro acabou de nomear quando nenhuma leitura cruzou o limiar.
 * O Prompt Semantico entao se enche do lance errado.
 *
 * Com o lance em foco, essas arestas voltam. O escalonamento continua avaliado
 * contra a leitura da partida — ele descreve um evento, nao uma propriedade do
 * lance.
 */
function arestasDoLance(
    situation: SituationDef,
    telemetria: Record<string, number>
): {
    recomendados: RetrievedFutConstraints['recomendados'];
    vetados: RetrievedFutConstraints['vetados'];
    escalonamentos: RetrievedFutConstraints['escalonamentos'];
} {
    const recomendados: RetrievedFutConstraints['recomendados'] = [];
    const vetados: RetrievedFutConstraints['vetados'] = [];
    const escalonamentos: RetrievedFutConstraints['escalonamentos'] = [];

    for (const attr of situation.attributes) {
        if (isFutRecommendAttr(attr)) {
            recomendados.push({
                infracao: attr.infraction.$refText,
                indicacao: attr.indication ?? '',
                lance: situation.name
            });
        } else if (isFutForbidAttr(attr)) {
            vetados.push({
                infracao: attr.infraction.$refText,
                motivo: attr.reason,
                origem: `lance ${situation.name}`,
                lance: situation.name
            });
        } else if (isEscalationAttr(attr)) {
            const observado = telemetria[attr.parameter];
            if (observado !== undefined && compare(observado, attr.operator, attr.value.value)) {
                escalonamentos.push({
                    destino: attr.target,
                    detalhe: attr.detail,
                    lance: situation.name
                });
            }
        }
    }

    return { recomendados, vetados, escalonamentos };
}

/**
 * Restringe as restricoes ja recuperadas ao foco semantico, e traz as arestas
 * dos lances em foco que `retrieveFutConstraints` deixou de fora por falta de
 * gatilho ativo (ver `arestasDoLance`).
 *
 * INVARIANTE DE SEGURANCA: o foco so pode TIRAR decisoes admissiveis, nunca
 * acrescentar. Os vetos trazidos aqui estreitam a politica da infracao; nenhum
 * caminho neste arquivo devolve a uma infracao uma decisao que a avaliacao
 * deterministica havia retirado.
 *
 * Invariantes globais ficam sempre fora do filtro — valem independente do que
 * foi pedido.
 */
export function filtrarPorFocoFut(
    constraints: RetrievedFutConstraints,
    foco: FutFoco,
    model: FutModel,
    context: FutContext
): RetrievedFutConstraints {
    const noFoco = (infracao: string) => foco.infracoes.has(infracao);
    const lanceNoFoco = (lance: string) => foco.lances.has(lance);
    const agravanteNoFoco = (entre: string) => entre.split(' + ').some(noFoco);

    const lancesAtivos = [...constraints.lancesAtivos.filter(l => lanceNoFoco(l.nome))];
    const recomendados = [...constraints.recomendados];
    const vetados = [...constraints.vetados];
    const escalonamentos = [...constraints.escalonamentos];

    const jaListado = new Set(lancesAtivos.map(l => l.nome));
    for (const situation of model.elements.filter(isSituationDef)) {
        if (!lanceNoFoco(situation.name) || jaListado.has(situation.name)) continue;

        // gatilhos vazio marca "em foco, mas sem gatilho ativo" — o Prompt
        // Semantico distingue os dois casos ao renderizar.
        lancesAtivos.push({ nome: situation.name, lei: situation.lawRef, gatilhos: [] });

        const arestas = arestasDoLance(situation, context.telemetria);
        recomendados.push(...arestas.recomendados);
        escalonamentos.push(...arestas.escalonamentos);

        // A politica nao e estreitada aqui: `recomputarPoliticasFut` a reconstroi
        // ao final, a partir da lista de vetos que de fato sobreviveu ao filtro.
        vetados.push(...arestas.vetados);
    }

    const bloqueiosNoFoco = constraints.bloqueios.filter(b => noFoco(b.infracao));
    // Uma recomendacao e uma ARESTA: so pertence ao foco se as duas pontas
    // pertencerem. Aceitar so pelo lance reintroduz o lance errado pela porta
    // dos fundos; aceitar so pela infracao faz o prompt indicar o que a
    // gramatica nao gera.
    const recomendadosNoFoco = dedup(
        recomendados.filter(r => noFoco(r.infracao) && lanceNoFoco(r.lance)),
        r => `${r.infracao}|${r.lance}`
    );
    // Vetos de contexto de partida valem pelo jogo, independem do foco; vetos de
    // lance so valem se o lance estiver em foco.
    const vetadosNoFoco = dedup(
        vetados.filter(v => noFoco(v.infracao) && (!v.lance || lanceNoFoco(v.lance))),
        v => `${v.infracao}|${v.origem}`
    );

    return {
        lancesAtivos,
        bloqueios: bloqueiosNoFoco,
        ajustes: constraints.ajustes.filter(a => noFoco(a.infracao)),
        recomendados: recomendadosNoFoco,
        vetados: vetadosNoFoco,
        escalonamentos: dedup(
            escalonamentos.filter(e => lanceNoFoco(e.lance)),
            e => `${e.destino}|${e.lance}|${e.detalhe}`
        ),
        agravantes: constraints.agravantes.filter(a => agravanteNoFoco(a.entre)),
        isencoes: constraints.isencoes.filter(i => noFoco(i.infracao)),
        regrasGlobais: constraints.regrasGlobais,
        politicas: recomputarPoliticasFut(model, constraints.politicas, foco, bloqueiosNoFoco, vetadosNoFoco)
    };
}

/**
 * Reconstroi a politica de cada infracao em foco a partir das restricoes que
 * sobreviveram ao filtro — e nao das que `retrieveFutConstraints` tinha aplicado
 * sobre o grafo inteiro.
 *
 * Sem isto, um veto descartado do Prompt Semantico (porque vinha de um lance fora
 * do foco) continuava estreitando a gramatica: o modelo recebia uma proibicao sem
 * nenhuma linha no prompt que a justificasse. Aqui o que a gramatica proibe volta
 * a ser exatamente o que o prompt explica.
 */
function recomputarPoliticasFut(
    model: FutModel,
    politicasOriginais: Map<string, InfractionPolicy>,
    foco: FutFoco,
    bloqueios: RetrievedFutConstraints['bloqueios'],
    vetados: RetrievedFutConstraints['vetados']
): Map<string, InfractionPolicy> {
    const schema = model.elements.filter(isFutSchemaDef)[0];
    const politicas = new Map<string, InfractionPolicy>();

    for (const [infracao, original] of politicasOriginais) {
        if (!foco.infracoes.has(infracao)) continue;
        politicas.set(infracao, {
            infracao,
            decisoes: [...schema.decisions],
            // reinicios e unidades vem da propria infracao: nao dependem do contexto.
            reinicios: original.reinicios,
            unidades: original.unidades,
            valores: original.valores,
            motivos: [],
            bloqueado: false
        });
    }

    for (const bloqueio of bloqueios) {
        const policy = politicas.get(bloqueio.infracao);
        if (!policy) continue;
        policy.decisoes = policy.decisoes.filter(d => !DECISOES_DE_INCREMENTO.has(d));
        policy.bloqueado = true;
        policy.motivos.push(`decisao bloqueada (${bloqueio.regra}): ${bloqueio.razao}`);
    }

    for (const veto of vetados) {
        const policy = politicas.get(veto.infracao);
        if (!policy) continue;
        policy.decisoes = policy.decisoes.filter(d => DECISOES_DE_RETIRADA.includes(d));
        policy.bloqueado = true;
        policy.motivos.push(`vetada por ${veto.origem}: ${veto.motivo}`);
    }

    return politicas;
}
