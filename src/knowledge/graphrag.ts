/**
 * Recuperacao no Grafo de Conhecimento (GraphRAG) — etapa 2 da Figura 5.1.
 *
 * Recebe a telemetria do leito e devolve o subgrafo de restricoes que incide sobre
 * aquele instante clinico. Toda a avaliacao e DETERMINISTICA: quem decide se o
 * Propofol esta bloqueado e a comparacao `PAM 52 < 60`, nao o LLM.
 *
 * A saida nao e apenas um bloco de texto para o prompt. E, sobretudo, uma POLITICA
 * POR FARMACO — quais decisoes, vias e unidades continuam admissiveis para cada
 * medicamento — que a etapa seguinte converte em gramatica. Essa e a diferenca
 * entre pedir ao modelo que respeite uma regra e tornar a violacao inexprimivel:
 *
 *     "aumentar Propofol com PAM 52" deixa de ser uma resposta improvavel
 *     e passa a ser uma cadeia que a gramatica nao gera.
 */

import { type Session } from 'neo4j-driver';

import {
    isBlockRule,
    isDataSchemaDef,
    isDoseLimitAttr,
    isDrugDef,
    isEscalationAttr,
    isForbidAttr,
    isGlobalRule,
    isInteractionAttr,
    isPopAdjust,
    isPopForbid,
    isPopulationDef,
    isProtocolDef,
    isPumpLimitAttr,
    isRecommendAttr,
    isRenalAdjustAttr,
    isRouteAttr,
    isTitrationAttr,
    isTriggerAttr,
    type DrugDef,
    type MedicalModel,
    type Operator,
    type ProtocolDef
} from '../generated/ast.js';
import { nomesMed } from './documentos.js';
import {
    escalar,
    escalarMapa,
    formatarNumero,
    montarSubgrafo,
    reticuloDeValores,
    valoresPorDecisao,
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

export interface ClinicalContext {
    /** Telemetria corrente: parametro clinico -> valor observado. */
    telemetria: Record<string, number>;
    /** Populacoes especiais as quais o paciente pertence (ex.: Renal_Cronico). */
    populacoes?: string[];
    /** Farmacos ja em infusao, usados para avaliar interacoes. */
    farmacosEmUso?: string[];
    /** Fala do profissional, preservada para compor o Prompt Semantico. */
    intencao?: string;
    /** Identificacao do paciente para o registro de auditoria. */
    paciente?: string;
}

/** Politica de saida admissivel para um farmaco, dado o contexto. */
export interface DrugPolicy {
    farmaco: string;
    decisoes: string[];
    vias: string[];
    unidades: string[];
    /** Doses admissiveis por decisao — ver `PoliticaItem.valoresPorDecisao`. */
    valoresPorDecisao?: Record<string, ValorAdmissivel[]>;
    /** Doses que o modelo declara admissiveis (reticulo de `valoresOf`). Lista
     *  vazia significa que o farmaco nao declara limite e o numero segue livre. */
    valores: ValorAdmissivel[];
    /** Justificativas legiveis das restricoes aplicadas. */
    motivos: string[];
    bloqueado: boolean;
}

export interface RetrievedConstraints {
    protocolosAtivos: { nome: string; cid: string; gatilhos: string[] }[];
    bloqueios: { farmaco: string; regra: string; razao: string }[];
    ajustes: { farmaco: string; acao: string; detalhe: string; origem: string }[];
    recomendados: { farmaco: string; indicacao: string; protocolo: string }[];
    /** `protocolo` presente quando o veto vem de um protocolo; ausente quando vem de uma populacao. */
    vetados: { farmaco: string; motivo: string; origem: string; protocolo?: string }[];
    escalonamentos: { destino: string; detalhe: string; protocolo: string }[];
    interacoes: { entre: string; gravidade: string; mecanismo: string; conduta: string }[];
    regrasGlobais: { descricao: string; severidade: string }[];
    politicas: Map<string, DrugPolicy>;
}

/** Decisoes que representam aumento de exposicao ao farmaco. */
const DECISOES_DE_INCREMENTO = new Set(['INICIAR_INFUSAO', 'AUMENTAR_VAZAO', 'AJUSTAR_DOSE']);

/** Decisoes admissiveis quando o farmaco esta integralmente vetado. */
const DECISOES_DE_RETIRADA = ['SUSPENDER', 'BLOQUEAR_ORDEM', 'ESCALAR_EQUIPE'];

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

function routesOf(drug: DrugDef): string[] {
    for (const attr of drug.attributes) {
        if (isRouteAttr(attr)) return [...attr.routes];
    }
    return [];
}

function unitsOf(drug: DrugDef): string[] {
    const units = new Set<string>();
    for (const attr of drug.attributes) {
        if (isDoseLimitAttr(attr)) units.add(attr.value.unit);
        else if (isTitrationAttr(attr)) units.add(attr.step.unit);
        else if (isPumpLimitAttr(attr)) {
            units.add(attr.soft.unit);
            units.add(attr.hard.unit);
        }
    }
    return [...units];
}

/**
 * Doses admissiveis de um farmaco, lidas da bula do proprio modelo.
 *
 * O plano de referencia do uti.dsl reporta o DEGRAU (titulacao) num incremento e
 * 0.0 numa decisao de nao-incremento — entao o reticulo e {0} U {doses nomeadas}
 * U {multiplos do degrau}, tudo limitado pelo limite leve da bomba (ou, na
 * falta dele, pela dose maxima). Farmaco sem nenhum desses atributos devolve
 * lista vazia: o modelo nao declarou limite, e inventar um aqui seria a
 * arquitetura decidindo no lugar do especialista.
 */
function valoresOf(drug: DrugDef): ValorAdmissivel[] {
    const nomeadas: number[] = [];
    let passo: number | undefined;
    let teto: number | undefined;
    let maxima: number | undefined;
    let unidade: string | undefined;

    for (const attr of drug.attributes) {
        if (isDoseLimitAttr(attr)) {
            unidade ??= attr.value.unit;
            if (attr.kind === 'maxima') maxima = attr.value.value;
            else nomeadas.push(attr.value.value);
        } else if (isTitrationAttr(attr)) {
            unidade ??= attr.step.unit;
            passo = attr.step.value;
        } else if (isPumpLimitAttr(attr)) {
            unidade ??= attr.soft.unit;
            teto = attr.soft.value;
        }
    }

    if (!unidade) return [];
    return reticuloDeValores(unidade, nomeadas, passo, teto ?? maxima);
}

/**
 * Remove das politicas as decisoes incompativeis com o estado de curso do item:
 * quem ja esta em uso nao pode ser iniciado, quem nao esta nao pode ser titulado,
 * reduzido nem suspenso. As duas listas vem dos papeis do dominio — dominio sem
 * estado de curso nao declara nenhuma e nada e filtrado.
 */
function aplicarEstadoDeCurso(politicas: Map<string, DrugPolicy>, emUso: Set<string>): void {
    const iniciam = new Set(PAPEIS_MED.decisoesQueIniciam ?? []);
    const continuam = new Set(PAPEIS_MED.decisoesQueContinuam ?? []);
    if (iniciam.size === 0 && continuam.size === 0) return;

    for (const [nome, policy] of politicas) {
        const emCurso = emUso.has(nome);
        const proibidas = emCurso ? iniciam : continuam;
        const antes = policy.decisoes.length;
        policy.decisoes = policy.decisoes.filter(d => !proibidas.has(d));
        if (policy.decisoes.length !== antes) {
            policy.motivos.push(
                emCurso
                    ? 'ja em curso: nao cabe iniciar de novo'
                    : 'nao esta em curso: so cabe iniciar, substituir ou escalar'
            );
        }
    }
}

/**
 * Doses por decisao. O plano de referencia do proprio uti.dsl mostra a
 * convencao: `AUMENTAR_VAZAO dose 0.05` (o DEGRAU da titulacao) e
 * `MANTER_BLOQUEADO dose 0.0`. Aqui essa convencao deixa de ser convencao e
 * vira gramatica.
 */
function dosesPorDecisao(drug: DrugDef, decisoes: string[]): Record<string, ValorAdmissivel[]> {
    let unidade: string | undefined;
    const iniciais: number[] = [];
    let passo: number | undefined;

    for (const attr of drug.attributes) {
        if (isDoseLimitAttr(attr)) {
            unidade ??= attr.value.unit;
            if (attr.kind === 'inicial' || attr.kind === 'ataque' || attr.kind === 'manutencao') {
                iniciais.push(attr.value.value);
            }
        } else if (isTitrationAttr(attr)) {
            unidade ??= attr.step.unit;
            passo = attr.step.value;
        }
    }

    if (!unidade) return {};
    const u = unidade;
    const zero = [{ valor: formatarNumero(0), unidade: u }];
    const deInicio = iniciais.map(v => ({ valor: formatarNumero(v), unidade: u }));
    const deDegrau = passo !== undefined ? [{ valor: formatarNumero(passo), unidade: u }] : deInicio;

    return valoresPorDecisao(
        decisoes,
        [
            { decisoes: ['INICIAR_INFUSAO'], valores: deInicio.length > 0 ? deInicio : deDegrau },
            { decisoes: ['AUMENTAR_VAZAO', 'REDUZIR_VAZAO', 'AJUSTAR_DOSE'], valores: deDegrau }
        ],
        zero
    );
}

/** Papeis da gramatica clinica — ver `PapeisDominio`. */
export const PAPEIS_MED: PapeisDominio = {
    artefato: 'plano',
    clausula: 'ordem',
    item: 'farmaco',
    decisao: 'decisao',
    meio: 'via',
    quantidade: 'quantidade',
    campoQuantidade: 'dose',
    campoSujeito: 'paciente',
    contexto: 'protocolo',
    decisoesDeIncremento: ['INICIAR_INFUSAO', 'AUMENTAR_VAZAO', 'AJUSTAR_DOSE'],
    decisaoDeEscalonamento: 'ESCALAR_EQUIPE',
    decisoesQueIniciam: ['INICIAR_INFUSAO'],
    decisoesQueContinuam: ['AUMENTAR_VAZAO', 'REDUZIR_VAZAO', 'MANTER_VAZAO', 'SUSPENDER', 'AJUSTAR_DOSE']
};

/** decisao -> conduta declarada no `esquema_dados`, para o contrato ligar a
 *  `sequencia` do cabecalho as clausulas emitidas. */
export function condutasPorDecisaoMed(model: MedicalModel): Record<string, string> {
    const schema = model.elements.filter(isDataSchemaDef)[0];
    const mapa: Record<string, string> = {};
    if (!schema) return mapa;
    for (const conduta of schema.conducts) mapa[conduta.decision] = conduta.name;
    return mapa;
}

/**
 * Percorre o grafo derivado do modelo e devolve as restricoes ativas.
 * Regras cujo parametro nao esta presente na telemetria sao ignoradas: ausencia de
 * medida nao e evidencia de normalidade, mas tambem nao autoriza bloquear.
 */
export function retrieveConstraints(
    model: MedicalModel,
    context: ClinicalContext
): RetrievedConstraints {
    const telemetria = context.telemetria;
    const populacoes = new Set(context.populacoes ?? []);
    const emUso = new Set(context.farmacosEmUso ?? []);

    const drugs = model.elements.filter(isDrugDef);
    const schema = model.elements.filter(isDataSchemaDef)[0];
    if (!schema) throw new Error('Modelo sem `esquema_dados`: nao ha universo de respostas.');

    const result: RetrievedConstraints = {
        protocolosAtivos: [],
        bloqueios: [],
        ajustes: [],
        recomendados: [],
        vetados: [],
        escalonamentos: [],
        interacoes: [],
        regrasGlobais: [],
        politicas: new Map()
    };

    // ------------------------------------------------- politica inicial (aberta)
    for (const drug of drugs) {
        const vias = routesOf(drug).filter(v => schema.routes.includes(v as never));
        result.politicas.set(drug.name, {
            farmaco: drug.name,
            decisoes: [...schema.decisions],
            vias: vias.length > 0 ? vias : [...schema.routes],
            valores: valoresOf(drug),
            valoresPorDecisao: dosesPorDecisao(drug, [...schema.decisions]),
            unidades: unitsOf(drug),
            motivos: [],
            bloqueado: false
        });
    }

    // ------------------------------------------------ estado de curso do item
    // Fato que o contexto sempre soube e a gramatica nunca soube: o que ja esta
    // infundindo. Sem isto, "iniciar" um farmaco em curso e uma cadeia licita.
    aplicarEstadoDeCurso(result.politicas, emUso);

    // --------------------------------------------------- protocolos e gatilhos
    for (const protocol of model.elements.filter(isProtocolDef)) {
        const gatilhos: string[] = [];
        for (const attr of protocol.attributes) {
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

        result.protocolosAtivos.push({ nome: protocol.name, cid: protocol.icd, gatilhos });

        for (const attr of protocol.attributes) {
            if (isRecommendAttr(attr)) {
                result.recomendados.push({
                    farmaco: attr.drug.$refText,
                    indicacao: attr.indication ?? '',
                    protocolo: protocol.name
                });
            } else if (isForbidAttr(attr)) {
                result.vetados.push({
                    farmaco: attr.drug.$refText,
                    motivo: attr.reason,
                    origem: `protocolo ${protocol.name}`,
                    protocolo: protocol.name
                });
            } else if (isEscalationAttr(attr)) {
                const observado = telemetria[attr.parameter];
                if (observado !== undefined && compare(observado, attr.operator, attr.value.value)) {
                    result.escalonamentos.push({
                        destino: attr.target,
                        detalhe: attr.detail,
                        protocolo: protocol.name
                    });
                }
            }
        }
    }

    // ------------------------------------------- invariantes de seguranca ativas
    for (const element of model.elements) {
        if (!isBlockRule(element)) continue;
        const observado = telemetria[element.parameter];
        if (observado === undefined) continue;
        if (!compare(observado, element.operator, element.threshold.value)) continue;

        const farmaco = element.drug.$refText;
        const regra = `${element.parameter} ${observado} ${element.operator} ${element.threshold.value} ${element.threshold.unit}`;
        result.bloqueios.push({ farmaco, regra, razao: element.reason });

        const policy = result.politicas.get(farmaco);
        if (policy) {
            // Bloqueio de incremento: o farmaco continua citavel, mas nenhuma
            // decisao que aumente a exposicao permanece na gramatica.
            policy.decisoes = policy.decisoes.filter(d => !DECISOES_DE_INCREMENTO.has(d));
            policy.bloqueado = true;
            policy.motivos.push(`incremento bloqueado (${regra}): ${element.reason}`);
        }
    }

    // ------------------------------------------------------ populacoes especiais
    for (const population of model.elements.filter(isPopulationDef)) {
        if (!populacoes.has(population.name)) continue;
        for (const restriction of population.restrictions) {
            if (isPopForbid(restriction)) {
                const farmaco = restriction.drug.$refText;
                result.vetados.push({
                    farmaco,
                    motivo: restriction.reason,
                    origem: `populacao ${population.name}`
                });
            } else if (isPopAdjust(restriction)) {
                const farmaco = restriction.drug.$refText;
                result.ajustes.push({
                    farmaco,
                    acao: `multiplicar dose por ${restriction.factor}`,
                    detalhe: restriction.reason ?? '',
                    origem: `populacao ${population.name}`
                });
                // A dose ajustada e tao licita quanto a cheia: entra no reticulo
                // para o fator do modelo ser exprimivel, nao so recomendavel.
                const politica = result.politicas.get(farmaco);
                if (politica) {
                    politica.valores = escalar(politica.valores, restriction.factor);
                    politica.valoresPorDecisao = escalarMapa(politica.valoresPorDecisao, restriction.factor);
                }
            }
        }
    }

    // ------------------------------------ vetos aplicados as politicas de saida
    for (const veto of result.vetados) {
        const policy = result.politicas.get(veto.farmaco);
        if (!policy) continue;
        policy.decisoes = policy.decisoes.filter(d => DECISOES_DE_RETIRADA.includes(d));
        policy.bloqueado = true;
        policy.motivos.push(`vetado por ${veto.origem}: ${veto.motivo}`);
    }

    // ------------------------------------------- ajustes renais e interacoes
    for (const drug of drugs) {
        for (const attr of drug.attributes) {
            if (isRenalAdjustAttr(attr)) {
                const observado = telemetria[attr.parameter];
                if (observado === undefined) continue;
                if (!compare(observado, attr.operator, attr.threshold.value)) continue;
                result.ajustes.push({
                    farmaco: drug.name,
                    acao: attr.action,
                    detalhe: attr.detail,
                    origem: `${attr.parameter} ${observado} ${attr.operator} ${attr.threshold.value} ${attr.threshold.unit}`
                });
                if (attr.action === 'suspender' || attr.action === 'bloquear') {
                    const policy = result.politicas.get(drug.name);
                    if (policy) {
                        policy.decisoes = policy.decisoes.filter(d => !DECISOES_DE_INCREMENTO.has(d));
                        policy.bloqueado = true;
                        policy.motivos.push(`ajuste renal: ${attr.detail}`);
                    }
                }
            } else if (isInteractionAttr(attr)) {
                const outro = attr.other.$refText;
                // So interessa a interacao entre farmacos efetivamente envolvidos.
                if (!emUso.has(drug.name) && !emUso.has(outro)) continue;
                result.interacoes.push({
                    entre: `${drug.name} + ${outro}`,
                    gravidade: attr.severity,
                    mecanismo: attr.mechanism,
                    conduta: attr.conduct ?? ''
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
 * Mantido para compatibilidade com o motor de decodificacao local; a poda por
 * farmaco (mais estrita) e feita por `src/grammar/constrain.ts`.
 */
export function pruningPayload(
    constraints: RetrievedConstraints,
    contexto?: ClinicalContext
): SubgrafoPodado {
    const politicas: PoliticaItem[] = [...constraints.politicas.values()].map(p => ({
        item: p.farmaco,
        decisoes: p.decisoes,
        meios: p.vias,
        unidades: p.unidades,
        valores: p.valores,
        valoresPorDecisao: p.valoresPorDecisao,
        bloqueado: p.bloqueado,
        motivos: p.motivos
    }));

    const constantes: ConstantesCenario = {
        sujeito: contexto?.paciente,
        contextos: constraints.protocolosAtivos.map(p => p.nome)
    };

    return montarSubgrafo(politicas, PAPEIS_MED, constantes);
}

/**
 * Recuperacao do subgrafo em foco — etapa OPCIONAL antes de `retrieveConstraints`,
 * usada quando o comando vem digitado em vez de vir de um cenario pronto (ver
 * `src/inference/cli.ts`). So decide QUAIS farmacos/protocolos entram no Prompt
 * Semantico; a avaliacao de bloqueio em si continua inteiramente deterministica
 * em `retrieveConstraints` — o embedding nunca decide o que e permitido, so o que
 * e mostrado.
 *
 * Combina os tres sinais descritos em `knowledge/foco.ts`: o nome escrito na
 * fala (lexical), a proximidade no indice vetorial (vetorial) e as arestas do
 * grafo a partir do que os dois primeiros acharam (estrutural).
 */
export interface Foco {
    farmacos: Set<string>;
    protocolos: Set<string>;
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
 * Sem isto, "aumenta a nora" traria o farmaco e nenhuma das restricoes do protocolo em que ele e usado.
 * Seguir tambem `veta` seria errado aqui: seguir `veta` traria de volta protocolos que nao tem a ver com o pedido, so porque proibem aquele farmaco.
 */
function expandirFarmacosParaProtocolos(
    model: MedicalModel,
    farmacos: Set<string>,
    protocolos: Set<string>,
    origem: Map<string, OrigemFoco>
): void {
    for (const protocol of model.elements.filter(isProtocolDef)) {
        if (protocolos.has(protocol.name)) continue;
        for (const attr of protocol.attributes) {
            if (isRecommendAttr(attr) && farmacos.has(attr.drug.$refText)) {
                protocolos.add(protocol.name);
                registrar(origem, [protocol.name], 'grafo');
                break;
            }
        }
    }
}

/**
 * Expansao estrutural, sentido contexto -> item, seguindo `recomenda` E `veta`:
 * com o protocolo em foco, o que ele proibe e tao pertinente quanto o que indica.
 */
function expandirProtocolosParaFarmacos(
    model: MedicalModel,
    farmacos: Set<string>,
    protocolos: Set<string>,
    origem: Map<string, OrigemFoco>
): void {
    for (const protocol of model.elements.filter(isProtocolDef)) {
        if (!protocolos.has(protocol.name)) continue;
        for (const attr of protocol.attributes) {
            const vizinho = isRecommendAttr(attr) || isForbidAttr(attr) ? attr.drug.$refText : undefined;
            if (vizinho && !farmacos.has(vizinho)) {
                farmacos.add(vizinho);
                registrar(origem, [vizinho], 'grafo');
            }
        }
    }
}

export async function retrieverFoco(
    session: Session,
    intencao: string,
    model: MedicalModel
): Promise<Foco> {
    const nomes = nomesMed(model);
    const origem = new Map<string, OrigemFoco>();

    const lexFarmacos = casamentoLexical(intencao, nomes.farmacos);
    const lexProtocolos = casamentoLexical(intencao, nomes.protocolos);
    registrar(origem, lexFarmacos, 'lexical');
    registrar(origem, lexProtocolos, 'lexical');

    const vetor = await embedTexto(intencao);
    // Sequencial, nao Promise.all: uma Session do driver nao roda duas queries
    // concorrentes ("Queries cannot be run directly on a session with an open
    // transaction").
    const vetFarmacos = selecionarPorSimilaridade(
        await topKPorVetor(session, 'farmaco_embedding', vetor, topKParaGrafo(nomes.farmacos.length))
    );
    const vetProtocolos = selecionarPorSimilaridade(
        await topKPorVetor(session, 'protocolo_embedding', vetor, topKParaGrafo(nomes.protocolos.length))
    );

    const farmacos = new Set(lexFarmacos);
    const protocolos = new Set(lexProtocolos);
    // Ancorado pelo nome escrito, ou semeado pelo indice logo adiante.
    let contextoDeliberado = protocolos.size > 0;

    // Sem nome escrito no pedido, o vetor semeia UM lado so — aquele em que ele
    // se compromete mais (ver `ladoMaisDecidido`). O outro vem das arestas.
    if (farmacos.size === 0 && protocolos.size === 0) {
        if (ladoMaisDecidido(vetFarmacos, vetProtocolos) === 'contexto') {
            // So o primeiro colocado: um contexto ja arrasta o subgrafo inteiro
            // dele, e semear dois duplica o Prompt Semantico.
            if (vetProtocolos.melhor) {
                protocolos.add(vetProtocolos.melhor);
                contextoDeliberado = true;
            }
        } else {
            for (const nome of vetFarmacos.nomes) farmacos.add(nome);
        }
    }

    // Registrado so agora: o lexical ja esta na tabela e vence pelo criterio de
    // primeira origem, entao o que recebe 'vetorial' aqui veio mesmo do indice.
    registrar(origem, farmacos, 'vetorial');
    registrar(origem, protocolos, 'vetorial');

    expandirFarmacosParaProtocolos(model, farmacos, protocolos, origem);
    // O indice so escolhe contexto quando nenhuma aresta o alcancou.
    if (protocolos.size === 0) {
        if (vetProtocolos.melhor) {
            registrar(origem, [vetProtocolos.melhor], 'vetorial');
            protocolos.add(vetProtocolos.melhor);
            contextoDeliberado = true;
        }
    }
    // Contexto ancorado ou semeado foi escolha deliberada e expande sempre.
    // Contexto apenas DERIVADO de um item so expande se for unico: varios
    // contextos derivados significam pedido ambiguo, e devolver o catalogo de
    // cada um reconstroi o grafo inteiro dentro do Prompt Semantico.
    if (contextoDeliberado || protocolos.size === 1) {
        expandirProtocolosParaFarmacos(model, farmacos, protocolos, origem);
    }

    return { farmacos, protocolos, origem };
}

/**
 * Restricoes que um protocolo impoe independentemente de gatilho numerico.
 *
 * `retrieveConstraints` so coleta `recomenda`/`veta`/`escalonar` de protocolos
 * cujo gatilho disparou — o que descreve bem o INSTANTE, mas elimina o protocolo
 * que o profissional acabou de nomear quando nenhum parametro dele cruzou o
 * limiar. O Prompt Semantico entao se enche do protocolo errado.
 *
 * Com o protocolo em foco, essas arestas voltam. O escalonamento continua
 * avaliado contra a telemetria — ele descreve um evento, nao uma propriedade do
 * protocolo.
 */
function arestasDoProtocolo(
    protocol: ProtocolDef,
    telemetria: Record<string, number>
): {
    recomendados: RetrievedConstraints['recomendados'];
    vetados: RetrievedConstraints['vetados'];
    escalonamentos: RetrievedConstraints['escalonamentos'];
} {
    const recomendados: RetrievedConstraints['recomendados'] = [];
    const vetados: RetrievedConstraints['vetados'] = [];
    const escalonamentos: RetrievedConstraints['escalonamentos'] = [];

    for (const attr of protocol.attributes) {
        if (isRecommendAttr(attr)) {
            recomendados.push({
                farmaco: attr.drug.$refText,
                indicacao: attr.indication ?? '',
                protocolo: protocol.name
            });
        } else if (isForbidAttr(attr)) {
            vetados.push({
                farmaco: attr.drug.$refText,
                motivo: attr.reason,
                origem: `protocolo ${protocol.name}`,
                protocolo: protocol.name
            });
        } else if (isEscalationAttr(attr)) {
            const observado = telemetria[attr.parameter];
            if (observado !== undefined && compare(observado, attr.operator, attr.value.value)) {
                escalonamentos.push({
                    destino: attr.target,
                    detalhe: attr.detail,
                    protocolo: protocol.name
                });
            }
        }
    }

    return { recomendados, vetados, escalonamentos };
}

/**
 * Restringe as restricoes ja recuperadas ao foco semantico, e traz as arestas
 * dos protocolos em foco que `retrieveConstraints` deixou de fora por falta de
 * gatilho ativo (ver `arestasDoProtocolo`).
 *
 * INVARIANTE DE SEGURANCA: o foco so pode TIRAR decisoes admissiveis, nunca
 * acrescentar. Os vetos trazidos aqui estreitam a politica do farmaco; nenhum
 * caminho neste arquivo devolve a um farmaco uma decisao que a avaliacao
 * deterministica havia retirado.
 *
 * Invariantes globais ficam sempre fora do filtro — sao regras que valem
 * independente do que foi pedido, nao "sobre" um farmaco ou protocolo especifico.
 */
export function filtrarPorFoco(
    constraints: RetrievedConstraints,
    foco: Foco,
    model: MedicalModel,
    context: ClinicalContext
): RetrievedConstraints {
    const noFoco = (farmaco: string) => foco.farmacos.has(farmaco);
    const protocoloNoFoco = (protocolo: string) => foco.protocolos.has(protocolo);
    const interacaoNoFoco = (entre: string) => entre.split(' + ').some(noFoco);

    const protocolosAtivos = [...constraints.protocolosAtivos.filter(p => protocoloNoFoco(p.nome))];
    const recomendados = [...constraints.recomendados];
    const vetados = [...constraints.vetados];
    const escalonamentos = [...constraints.escalonamentos];

    const jaListado = new Set(protocolosAtivos.map(p => p.nome));
    for (const protocol of model.elements.filter(isProtocolDef)) {
        if (!protocoloNoFoco(protocol.name) || jaListado.has(protocol.name)) continue;

        // gatilhos vazio marca "em foco, mas sem gatilho ativo" — o Prompt
        // Semantico distingue os dois casos ao renderizar.
        protocolosAtivos.push({ nome: protocol.name, cid: protocol.icd, gatilhos: [] });

        const arestas = arestasDoProtocolo(protocol, context.telemetria);
        recomendados.push(...arestas.recomendados);
        escalonamentos.push(...arestas.escalonamentos);

        // A politica nao e estreitada aqui: `recomputarPoliticasMed` a reconstroi
        // ao final, a partir da lista de vetos que de fato sobreviveu ao filtro.
        vetados.push(...arestas.vetados);
    }

    const bloqueiosNoFoco = constraints.bloqueios.filter(b => noFoco(b.farmaco));
    const ajustesNoFoco = constraints.ajustes.filter(a => noFoco(a.farmaco));
    // Uma recomendacao e uma ARESTA: so pertence ao foco se as duas pontas
    // pertencerem. Aceitar so pelo protocolo reintroduz o protocolo errado pela
    // porta dos fundos; aceitar so pelo farmaco faz o prompt indicar o que a
    // gramatica nao gera.
    const recomendadosNoFoco = dedup(
        recomendados.filter(r => noFoco(r.farmaco) && protocoloNoFoco(r.protocolo)),
        r => `${r.farmaco}|${r.protocolo}`
    );
    // Vetos de populacao valem pelo paciente, independem do foco; vetos de
    // protocolo so valem se o protocolo estiver em foco.
    const vetadosNoFoco = dedup(
        vetados.filter(v => noFoco(v.farmaco) && (!v.protocolo || protocoloNoFoco(v.protocolo))),
        v => `${v.farmaco}|${v.origem}`
    );

    return {
        protocolosAtivos,
        bloqueios: bloqueiosNoFoco,
        ajustes: ajustesNoFoco,
        recomendados: recomendadosNoFoco,
        vetados: vetadosNoFoco,
        escalonamentos: dedup(
            escalonamentos.filter(e => protocoloNoFoco(e.protocolo)),
            e => `${e.destino}|${e.protocolo}|${e.detalhe}`
        ),
        interacoes: constraints.interacoes.filter(i => interacaoNoFoco(i.entre)),
        regrasGlobais: constraints.regrasGlobais,
        politicas: recomputarPoliticasMed(
            model,
            constraints.politicas,
            foco,
            bloqueiosNoFoco,
            vetadosNoFoco,
            ajustesNoFoco
        )
    };
}

/**
 * Reconstroi a politica de cada farmaco em foco a partir das restricoes que
 * sobreviveram ao filtro — e nao das que `retrieveConstraints` tinha aplicado
 * sobre o grafo inteiro.
 *
 * Sem isto, um veto descartado do Prompt Semantico (porque vinha de um protocolo
 * fora do foco) continuava estreitando a gramatica: o modelo recebia uma
 * proibicao sem nenhuma linha no prompt que a justificasse. Aqui o que a
 * gramatica proibe volta a ser exatamente o que o prompt explica.
 */
function recomputarPoliticasMed(
    model: MedicalModel,
    politicasOriginais: Map<string, DrugPolicy>,
    foco: Foco,
    bloqueios: RetrievedConstraints['bloqueios'],
    vetados: RetrievedConstraints['vetados'],
    ajustes: RetrievedConstraints['ajustes']
): Map<string, DrugPolicy> {
    const schema = model.elements.filter(isDataSchemaDef)[0];
    const politicas = new Map<string, DrugPolicy>();

    for (const [farmaco, original] of politicasOriginais) {
        if (!foco.farmacos.has(farmaco)) continue;
        politicas.set(farmaco, {
            farmaco,
            decisoes: [...schema.decisions],
            // vias, unidades e doses vem da bula do farmaco: nao dependem de contexto.
            vias: original.vias,
            unidades: original.unidades,
            valores: original.valores,
            valoresPorDecisao: original.valoresPorDecisao,
            motivos: [],
            bloqueado: false
        });
    }

    for (const bloqueio of bloqueios) {
        const policy = politicas.get(bloqueio.farmaco);
        if (!policy) continue;
        policy.decisoes = policy.decisoes.filter(d => !DECISOES_DE_INCREMENTO.has(d));
        policy.bloqueado = true;
        policy.motivos.push(`incremento bloqueado (${bloqueio.regra}): ${bloqueio.razao}`);
    }

    // Ajuste renal que manda suspender ou bloquear tambem retira o incremento.
    for (const ajuste of ajustes) {
        if (ajuste.acao !== 'suspender' && ajuste.acao !== 'bloquear') continue;
        const policy = politicas.get(ajuste.farmaco);
        if (!policy) continue;
        policy.decisoes = policy.decisoes.filter(d => !DECISOES_DE_INCREMENTO.has(d));
        policy.bloqueado = true;
        policy.motivos.push(`ajuste renal: ${ajuste.detalhe}`);
    }

    for (const veto of vetados) {
        const policy = politicas.get(veto.farmaco);
        if (!policy) continue;
        policy.decisoes = policy.decisoes.filter(d => DECISOES_DE_RETIRADA.includes(d));
        policy.bloqueado = true;
        policy.motivos.push(`vetado por ${veto.origem}: ${veto.motivo}`);
    }

    return politicas;
}
