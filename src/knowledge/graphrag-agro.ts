/**
 * Recuperacao no Grafo de Conhecimento agricola (GraphRAG) — etapa 2 da Figura 5.1.
 *
 * Espelha src/knowledge/graphrag.ts no dominio da pulverizacao por drone. Recebe a
 * telemetria dos sensores e devolve o subgrafo de restricoes que incide sobre
 * aquele instante operacional. A avaliacao e DETERMINISTICA: quem decide se o
 * Glifosato esta bloqueado e a comparacao `vento 14 > 10`, nao o LLM.
 *
 * Como no dominio clinico, a saida principal e uma POLITICA POR PRODUTO — quais
 * decisoes, modos e unidades continuam admissiveis para cada defensivo:
 *
 *     "iniciar Glifosato com vento 14 km/h" deixa de ser uma resposta improvavel
 *     e passa a ser uma cadeia que a gramatica nao gera.
 */

import { type Session } from 'neo4j-driver';

import {
    isAgroBlockRule,
    isAgroForbidAttr,
    isAgroRecommendAttr,
    isAgroSchemaDef,
    isAreaAdjust,
    isAreaDef,
    isAreaForbid,
    isBanConditionAttr,
    isCultureDef,
    isDoseAttr,
    isEscalationAttr,
    isGlobalRule,
    isIncompatAttr,
    isProductDef,
    isTriggerAttr,
    type AgroModel,
    type CultureDef,
    type Operator,
    type ProductDef
} from '../generated/ast.js';
import { nomesAgro } from './documentos.js';
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

export interface AgroContext {
    /** Telemetria corrente dos sensores: parametro -> valor observado. */
    telemetria: Record<string, number>;
    /** Areas especiais em que o talhao se enquadra (ex.: Faixa_Manancial). */
    areas?: string[];
    /** Produtos ja carregados no tanque, usados para avaliar incompatibilidade. */
    produtosEmUso?: string[];
    /** Fala do operador, preservada para compor o Prompt Semantico. */
    intencao?: string;
    /** Identificacao do talhao para o registro de auditoria. */
    talhao?: string;
}

/** Politica de saida admissivel para um produto, dado o contexto. */
export interface ProductPolicy {
    produto: string;
    decisoes: string[];
    modos: string[];
    unidades: string[];
    /** Vazoes que o modelo declara admissiveis; vazio = sem limite declarado. */
    valores: ValorAdmissivel[];
    /** Vazoes por decisao — ver `PoliticaItem.valoresPorDecisao`. */
    valoresPorDecisao?: Record<string, ValorAdmissivel[]>;
    motivos: string[];
    bloqueado: boolean;
}

export interface RetrievedAgroConstraints {
    culturasAtivas: { nome: string; ciclo: string; gatilhos: string[] }[];
    bloqueios: { produto: string; regra: string; razao: string }[];
    ajustes: { produto: string; acao: string; detalhe: string; origem: string }[];
    recomendados: { produto: string; indicacao: string; cultura: string }[];
    /** `cultura` presente quando o veto vem de uma cultura; ausente quando vem de uma area. */
    vetados: { produto: string; motivo: string; origem: string; cultura?: string }[];
    escalonamentos: { destino: string; detalhe: string; cultura: string }[];
    incompatibilidades: { entre: string; gravidade: string; mecanismo: string; conduta: string }[];
    proibicoes: { produto: string; condicao: string; excecao: string }[];
    regrasGlobais: { descricao: string; severidade: string }[];
    politicas: Map<string, ProductPolicy>;
}

/** Decisoes que representam aumento de exposicao ao produto. */
const DECISOES_DE_INCREMENTO = new Set(['INICIAR_APLICACAO', 'AUMENTAR_VAZAO']);

/** Decisoes admissiveis quando o produto esta integralmente vetado. */
const DECISOES_DE_RETIRADA = [
    'SUSPENDER',
    'BLOQUEAR_APLICACAO',
    'ACIONAR_AGRONOMO',
    'AGUARDAR_JANELA'
];

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

function unitsOf(product: ProductDef): string[] {
    const units = new Set<string>();
    for (const attr of product.attributes) {
        if (isDoseAttr(attr)) units.add(attr.value.unit);
    }
    return [...units];
}

/**
 * Vazoes admissiveis de um produto: {0} U {doses declaradas}, limitadas pela
 * dose maxima. Sem `dose` declarada, devolve vazio e o numero segue livre.
 */
function valoresOf(product: ProductDef): ValorAdmissivel[] {
    const nomeadas: number[] = [];
    let maxima: number | undefined;
    let unidade: string | undefined;

    for (const attr of product.attributes) {
        if (!isDoseAttr(attr)) continue;
        unidade ??= attr.value.unit;
        if (attr.kind === 'maxima') maxima = attr.value.value;
        else nomeadas.push(attr.value.value);
    }

    if (!unidade) return [];
    if (maxima !== undefined) nomeadas.push(maxima);
    return reticuloDeValores(unidade, nomeadas, undefined, maxima);
}

/**
 * Vazoes por decisao: quem aplica leva a vazao declarada (e a ajustada pela
 * area); quem bloqueia, aguarda ou escala leva 0.0 — uma missao que "aguarda
 * janela" com vazao de 2 L/ha e uma contradicao que a gramatica passa a nao
 * gerar.
 */
function vazoesPorDecisao(product: ProductDef, decisoes: string[]): Record<string, ValorAdmissivel[]> {
    let unidade: string | undefined;
    const taxas: number[] = [];

    for (const attr of product.attributes) {
        if (!isDoseAttr(attr)) continue;
        unidade ??= attr.value.unit;
        taxas.push(attr.value.value);
    }
    if (!unidade) return {};

    const u = unidade;
    const zero = [{ valor: formatarNumero(0), unidade: u }];
    const aplicaveis = taxas.map(v => ({ valor: formatarNumero(v), unidade: u }));

    return valoresPorDecisao(
        decisoes,
        [
            {
                decisoes: ['INICIAR_APLICACAO', 'AUMENTAR_VAZAO', 'REDUZIR_VAZAO', 'MANTER_VAZAO', 'SUBSTITUIR'],
                valores: aplicaveis
            }
        ],
        zero
    );
}

/** Papeis da gramatica agricola — ver `PapeisDominio`. */
export const PAPEIS_AGRO: PapeisDominio = {
    artefato: 'missao',
    clausula: 'aplicacao',
    item: 'produto',
    decisao: 'decisao',
    meio: 'modo',
    quantidade: 'quantidade',
    campoQuantidade: 'vazao',
    campoSujeito: 'talhao',
    contexto: 'cultura',
    conduta: 'conduta',
    decisoesDeIncremento: ['INICIAR_APLICACAO', 'AUMENTAR_VAZAO'],
    decisaoDeEscalonamento: 'ACIONAR_AGRONOMO',
    decisoesQueIniciam: ['INICIAR_APLICACAO'],
    decisoesQueContinuam: ['AUMENTAR_VAZAO', 'REDUZIR_VAZAO', 'MANTER_VAZAO', 'SUSPENDER']
};

/** decisao -> conduta declarada no `esquema_dados`. */
/** Nome do `esquema_dados` do modelo — o cabecalho do artefato o cita. */
export function esquemaDeDadosAgro(model: AgroModel): string | undefined {
    return model.elements.filter(isAgroSchemaDef)[0]?.name;
}

export function condutasPorDecisaoAgro(model: AgroModel): Record<string, string> {
    const schema = model.elements.filter(isAgroSchemaDef)[0];
    const mapa: Record<string, string> = {};
    if (!schema) return mapa;
    for (const conduta of schema.conducts) mapa[conduta.decision] = conduta.name;
    return mapa;
}

/**
 * Remove das politicas as decisoes incompativeis com o estado de curso do item
 * (produto ja carregado no tanque nao se "inicia" de novo). Ver o gemeo em
 * graphrag.ts — as duas listas vem dos papeis, nao de nomes de dominio.
 */
function aplicarEstadoDeCurso(politicas: Map<string, ProductPolicy>, emUso: Set<string>): void {
    const iniciam = new Set(PAPEIS_AGRO.decisoesQueIniciam ?? []);
    const continuam = new Set(PAPEIS_AGRO.decisoesQueContinuam ?? []);
    if (iniciam.size === 0 && continuam.size === 0) return;

    for (const [nome, policy] of politicas) {
        const emCurso = emUso.has(nome);
        const proibidas = emCurso ? iniciam : continuam;
        const antes = policy.decisoes.length;
        policy.decisoes = policy.decisoes.filter(d => !proibidas.has(d));
        if (policy.decisoes.length !== antes) {
            policy.motivos.push(
                emCurso
                    ? 'ja na calda: nao cabe iniciar de novo'
                    : 'nao esta na calda: so cabe iniciar, substituir ou escalar'
            );
        }
    }
}

/**
 * Percorre o grafo derivado do modelo e devolve as restricoes ativas.
 * Regras cujo parametro nao esta na telemetria sao ignoradas: sensor ausente nao
 * e evidencia de condicao segura, mas tambem nao autoriza bloquear.
 */
export function retrieveAgroConstraints(
    model: AgroModel,
    context: AgroContext
): RetrievedAgroConstraints {
    const telemetria = context.telemetria;
    const areas = new Set(context.areas ?? []);
    const emUso = new Set(context.produtosEmUso ?? []);

    const products = model.elements.filter(isProductDef);
    const schema = model.elements.filter(isAgroSchemaDef)[0];
    if (!schema) throw new Error('Modelo sem `esquema_dados`: nao ha universo de respostas.');

    const result: RetrievedAgroConstraints = {
        culturasAtivas: [],
        bloqueios: [],
        ajustes: [],
        recomendados: [],
        vetados: [],
        escalonamentos: [],
        incompatibilidades: [],
        proibicoes: [],
        regrasGlobais: [],
        politicas: new Map()
    };

    // ------------------------------------------------- politica inicial (aberta)
    for (const product of products) {
        result.politicas.set(product.name, {
            produto: product.name,
            decisoes: [...schema.decisions],
            modos: [...schema.modes],
            unidades: unitsOf(product),
            valores: valoresOf(product),
            valoresPorDecisao: vazoesPorDecisao(product, [...schema.decisions]),
            motivos: [],
            bloqueado: false
        });
    }

    // ------------------------------------------------ estado de curso do item
    aplicarEstadoDeCurso(result.politicas, emUso);

    // ----------------------------------------------------- culturas e gatilhos
    for (const culture of model.elements.filter(isCultureDef)) {
        const gatilhos: string[] = [];
        for (const attr of culture.attributes) {
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

        result.culturasAtivas.push({ nome: culture.name, ciclo: culture.cycle, gatilhos });

        for (const attr of culture.attributes) {
            if (isAgroRecommendAttr(attr)) {
                result.recomendados.push({
                    produto: attr.product.$refText,
                    indicacao: attr.indication ?? '',
                    cultura: culture.name
                });
            } else if (isAgroForbidAttr(attr)) {
                result.vetados.push({
                    produto: attr.product.$refText,
                    motivo: attr.reason,
                    origem: `cultura ${culture.name}`,
                    cultura: culture.name
                });
            } else if (isEscalationAttr(attr)) {
                const observado = telemetria[attr.parameter];
                if (observado !== undefined && compare(observado, attr.operator, attr.value.value)) {
                    result.escalonamentos.push({
                        destino: attr.target,
                        detalhe: attr.detail,
                        cultura: culture.name
                    });
                }
            }
        }
    }

    // ------------------------------------------- invariantes de seguranca ativas
    for (const element of model.elements) {
        if (!isAgroBlockRule(element)) continue;
        const observado = telemetria[element.parameter];
        if (observado === undefined) continue;
        if (!compare(observado, element.operator, element.threshold.value)) continue;

        const produto = element.product.$refText;
        const regra = `${element.parameter} ${observado} ${element.operator} ${element.threshold.value} ${element.threshold.unit}`;
        result.bloqueios.push({ produto, regra, razao: element.reason });

        const policy = result.politicas.get(produto);
        if (policy) {
            // Bloqueio de aplicacao: o produto continua citavel, mas nenhuma
            // decisao que aumente a exposicao permanece na gramatica.
            policy.decisoes = policy.decisoes.filter(d => !DECISOES_DE_INCREMENTO.has(d));
            policy.bloqueado = true;
            policy.motivos.push(`aplicacao bloqueada (${regra}): ${element.reason}`);
        }
    }

    // ---------------------------------------------------------- areas especiais
    for (const area of model.elements.filter(isAreaDef)) {
        if (!areas.has(area.name)) continue;
        for (const restriction of area.restrictions) {
            if (isAreaForbid(restriction)) {
                result.vetados.push({
                    produto: restriction.product.$refText,
                    motivo: restriction.reason,
                    origem: `area ${area.name}`
                });
            } else if (isAreaAdjust(restriction)) {
                const produto = restriction.product.$refText;
                result.ajustes.push({
                    produto,
                    acao: `multiplicar vazao por ${restriction.factor}`,
                    detalhe: restriction.reason ?? '',
                    origem: `area ${area.name}`
                });
                // A vazao reduzida pela area tambem precisa ser exprimivel.
                const politica = result.politicas.get(produto);
                if (politica) {
                    politica.valores = escalar(politica.valores, restriction.factor);
                    politica.valoresPorDecisao = escalarMapa(politica.valoresPorDecisao, restriction.factor);
                }
            }
        }
    }

    // ------------------------------------ vetos aplicados as politicas de saida
    for (const veto of result.vetados) {
        const policy = result.politicas.get(veto.produto);
        if (!policy) continue;
        policy.decisoes = policy.decisoes.filter(d => DECISOES_DE_RETIRADA.includes(d));
        policy.bloqueado = true;
        policy.motivos.push(`vetado por ${veto.origem}: ${veto.motivo}`);
    }

    // -------------------------------------- incompatibilidades e proibicoes
    for (const product of products) {
        for (const attr of product.attributes) {
            if (isIncompatAttr(attr)) {
                const outro = attr.other.$refText;
                // So interessa a incompatibilidade entre produtos efetivamente no tanque.
                if (!emUso.has(product.name) && !emUso.has(outro)) continue;
                result.incompatibilidades.push({
                    entre: `${product.name} + ${outro}`,
                    gravidade: attr.severity,
                    mecanismo: attr.mechanism,
                    conduta: attr.conduct ?? ''
                });
            } else if (isBanConditionAttr(attr)) {
                result.proibicoes.push({
                    produto: product.name,
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
 * ATENCAO — mesma limitacao do dominio clinico (ver graphrag.ts): as tres listas
 * sao independentes e perdem a associacao (produto, decisao, modo) que
 * `politicas` calcula corretamente. Um produto sobrevive a poda enquanto tiver
 * QUALQUER decisao admissivel, e a uniao das decisoes de todos os produtos passa
 * a valer para todos — o que devolve o produto cartesiano ao decodificador.
 */
export function agroPruningPayload(
    constraints: RetrievedAgroConstraints,
    contexto?: AgroContext
): SubgrafoPodado {
    const politicas: PoliticaItem[] = [...constraints.politicas.values()].map(p => ({
        item: p.produto,
        decisoes: p.decisoes,
        meios: p.modos,
        unidades: p.unidades,
        valores: p.valores,
        valoresPorDecisao: p.valoresPorDecisao,
        bloqueado: p.bloqueado,
        motivos: p.motivos
    }));

    const constantes: ConstantesCenario = {
        sujeito: contexto?.talhao,
        contextos: constraints.culturasAtivas.map(c => c.nome)
    };

    return montarSubgrafo(politicas, PAPEIS_AGRO, constantes);
}
/**
 * Recuperacao do subgrafo em foco — espelha `graphrag.ts::retrieverFoco` no
 * dominio agricola. So decide QUAIS produtos/culturas entram no Prompt
 * Semantico; a avaliacao de bloqueio continua 100% deterministica em
 * `retrieveAgroConstraints`.
 *
 * Combina os tres sinais descritos em `knowledge/foco.ts`: o nome escrito na
 * fala (lexical), a proximidade no indice vetorial (vetorial) e as arestas do
 * grafo a partir do que os dois primeiros acharam (estrutural).
 */
export interface AgroFoco {
    produtos: Set<string>;
    culturas: Set<string>;
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
 * Sem isto, "comeca o imidacloprido" traria o produto e nenhuma das restricoes da cultura em que ele e aplicado.
 * Seguir tambem `veta` seria errado aqui: Dois_Quatro_D e vetado no Milho; um pedido sobre cana nao deve reabrir o Milho por causa disso.
 */
function expandirProdutosParaCulturas(
    model: AgroModel,
    produtos: Set<string>,
    culturas: Set<string>,
    origem: Map<string, OrigemFoco>
): void {
    for (const culture of model.elements.filter(isCultureDef)) {
        if (culturas.has(culture.name)) continue;
        for (const attr of culture.attributes) {
            if (isAgroRecommendAttr(attr) && produtos.has(attr.product.$refText)) {
                culturas.add(culture.name);
                registrar(origem, [culture.name], 'grafo');
                break;
            }
        }
    }
}

/**
 * Expansao estrutural, sentido contexto -> item, seguindo `recomenda` E `veta`:
 * com o cultura em foco, o que ele proibe e tao pertinente quanto o que indica.
 */
function expandirCulturasParaProdutos(
    model: AgroModel,
    produtos: Set<string>,
    culturas: Set<string>,
    origem: Map<string, OrigemFoco>
): void {
    for (const culture of model.elements.filter(isCultureDef)) {
        if (!culturas.has(culture.name)) continue;
        for (const attr of culture.attributes) {
            const vizinho = isAgroRecommendAttr(attr) || isAgroForbidAttr(attr) ? attr.product.$refText : undefined;
            if (vizinho && !produtos.has(vizinho)) {
                produtos.add(vizinho);
                registrar(origem, [vizinho], 'grafo');
            }
        }
    }
}

export async function retrieverFocoAgro(
    session: Session,
    intencao: string,
    model: AgroModel
): Promise<AgroFoco> {
    const nomes = nomesAgro(model);
    const origem = new Map<string, OrigemFoco>();

    const lexProdutos = casamentoLexical(intencao, nomes.produtos);
    const lexCulturas = casamentoLexical(intencao, nomes.culturas);
    registrar(origem, lexProdutos, 'lexical');
    registrar(origem, lexCulturas, 'lexical');

    const vetor = await embedTexto(intencao);
    // Sequencial, nao Promise.all: uma Session do driver nao roda duas queries
    // concorrentes ("Queries cannot be run directly on a session with an open
    // transaction").
    const vetProdutos = selecionarPorSimilaridade(
        await topKPorVetor(session, 'produto_embedding', vetor, topKParaGrafo(nomes.produtos.length))
    );
    const vetCulturas = selecionarPorSimilaridade(
        await topKPorVetor(session, 'cultura_embedding', vetor, topKParaGrafo(nomes.culturas.length))
    );

    const produtos = new Set(lexProdutos);
    const culturas = new Set(lexCulturas);
    // Ancorado pelo nome escrito, ou semeado pelo indice logo adiante.
    let contextoDeliberado = culturas.size > 0;

    // Sem nome escrito no pedido, o vetor semeia UM lado so — aquele em que ele
    // se compromete mais (ver `ladoMaisDecidido`). O outro vem das arestas.
    if (produtos.size === 0 && culturas.size === 0) {
        if (ladoMaisDecidido(vetProdutos, vetCulturas) === 'contexto') {
            // So o primeiro colocado: um contexto ja arrasta o subgrafo inteiro
            // dele, e semear dois duplica o Prompt Semantico.
            if (vetCulturas.melhor) {
                culturas.add(vetCulturas.melhor);
                contextoDeliberado = true;
            }
        } else {
            for (const nome of vetProdutos.nomes) produtos.add(nome);
        }
    }

    // Registrado so agora: o lexical ja esta na tabela e vence pelo criterio de
    // primeira origem, entao o que recebe 'vetorial' aqui veio mesmo do indice.
    registrar(origem, produtos, 'vetorial');
    registrar(origem, culturas, 'vetorial');

    expandirProdutosParaCulturas(model, produtos, culturas, origem);
    // O indice so escolhe contexto quando nenhuma aresta o alcancou.
    if (culturas.size === 0) {
        if (vetCulturas.melhor) {
            registrar(origem, [vetCulturas.melhor], 'vetorial');
            culturas.add(vetCulturas.melhor);
            contextoDeliberado = true;
        }
    }
    // Contexto ancorado ou semeado foi escolha deliberada e expande sempre.
    // Contexto apenas DERIVADO de um item so expande se for unico: varios
    // contextos derivados significam pedido ambiguo, e devolver o catalogo de
    // cada um reconstroi o grafo inteiro dentro do Prompt Semantico.
    if (contextoDeliberado || culturas.size === 1) {
        expandirCulturasParaProdutos(model, produtos, culturas, origem);
    }

    return { produtos, culturas, origem };
}

/**
 * Restricoes que uma cultura impoe independentemente de gatilho numerico.
 *
 * `retrieveAgroConstraints` so coleta `recomenda`/`veta`/`escalonar` de culturas
 * cujo gatilho disparou — o que faz sentido para descrever o INSTANTE, mas
 * elimina a cultura que o operador acabou de nomear quando nenhum sensor dela
 * cruzou o limiar. Foi assim que um pedido sobre cana (NDVI 0.81, folha a 36 C:
 * nenhum gatilho ativo) saiu do Prompt Semantico e deu lugar a Soja e Milho.
 *
 * Com a cultura em foco, essas arestas voltam. O escalonamento continua avaliado
 * contra a telemetria — ele descreve um evento, nao uma propriedade da cultura.
 */
function arestasDaCultura(
    culture: CultureDef,
    telemetria: Record<string, number>
): {
    recomendados: RetrievedAgroConstraints['recomendados'];
    vetados: RetrievedAgroConstraints['vetados'];
    escalonamentos: RetrievedAgroConstraints['escalonamentos'];
} {
    const recomendados: RetrievedAgroConstraints['recomendados'] = [];
    const vetados: RetrievedAgroConstraints['vetados'] = [];
    const escalonamentos: RetrievedAgroConstraints['escalonamentos'] = [];

    for (const attr of culture.attributes) {
        if (isAgroRecommendAttr(attr)) {
            recomendados.push({
                produto: attr.product.$refText,
                indicacao: attr.indication ?? '',
                cultura: culture.name
            });
        } else if (isAgroForbidAttr(attr)) {
            vetados.push({
                produto: attr.product.$refText,
                motivo: attr.reason,
                origem: `cultura ${culture.name}`,
                cultura: culture.name
            });
        } else if (isEscalationAttr(attr)) {
            const observado = telemetria[attr.parameter];
            if (observado !== undefined && compare(observado, attr.operator, attr.value.value)) {
                escalonamentos.push({
                    destino: attr.target,
                    detalhe: attr.detail,
                    cultura: culture.name
                });
            }
        }
    }

    return { recomendados, vetados, escalonamentos };
}

/**
 * Restringe as restricoes ja recuperadas ao foco semantico, e traz as arestas
 * das culturas em foco que `retrieveAgroConstraints` deixou de fora por falta de
 * gatilho ativo (ver `arestasDaCultura`).
 *
 * INVARIANTE DE SEGURANCA: o foco so pode TIRAR decisoes admissiveis, nunca
 * acrescentar. Os vetos trazidos aqui estreitam a politica do produto; nenhum
 * caminho neste arquivo devolve a um produto uma decisao que a avaliacao
 * deterministica havia retirado.
 *
 * Invariantes globais ficam sempre fora do filtro — valem independente do que
 * foi pedido.
 */
export function filtrarPorFocoAgro(
    constraints: RetrievedAgroConstraints,
    foco: AgroFoco,
    model: AgroModel,
    context: AgroContext
): RetrievedAgroConstraints {
    const noFoco = (produto: string) => foco.produtos.has(produto);
    const culturaNoFoco = (cultura: string) => foco.culturas.has(cultura);
    const incompatNoFoco = (entre: string) => entre.split(' + ').some(noFoco);

    const culturasAtivas = [...constraints.culturasAtivas.filter(c => culturaNoFoco(c.nome))];
    const recomendados = [...constraints.recomendados];
    const vetados = [...constraints.vetados];
    const escalonamentos = [...constraints.escalonamentos];

    const jaListada = new Set(culturasAtivas.map(c => c.nome));
    for (const culture of model.elements.filter(isCultureDef)) {
        if (!culturaNoFoco(culture.name) || jaListada.has(culture.name)) continue;

        // gatilhos vazio marca "em foco, mas sem gatilho ativo" — o Prompt
        // Semantico distingue os dois casos ao renderizar.
        culturasAtivas.push({ nome: culture.name, ciclo: culture.cycle, gatilhos: [] });

        const arestas = arestasDaCultura(culture, context.telemetria);
        recomendados.push(...arestas.recomendados);
        escalonamentos.push(...arestas.escalonamentos);

        // A politica nao e estreitada aqui: `recomputarPoliticasAgro` a reconstroi
        // ao final, a partir da lista de vetos que de fato sobreviveu ao filtro.
        vetados.push(...arestas.vetados);
    }

    const bloqueiosNoFoco = constraints.bloqueios.filter(b => noFoco(b.produto));
    // Uma recomendacao e uma ARESTA: so pertence ao foco se as duas pontas
    // pertencerem. Aceitar so pela cultura reintroduzia a cultura errada pela
    // porta dos fundos ("Nicosulfuron ... (Milho)" num pedido sobre cana);
    // aceitar so pelo produto faz o prompt indicar o que a gramatica nao gera.
    const recomendadosNoFoco = dedup(
        recomendados.filter(r => noFoco(r.produto) && culturaNoFoco(r.cultura)),
        r => `${r.produto}|${r.cultura}`
    );
    // Vetos de area valem pelo talhao, independem do foco; vetos de cultura so
    // valem se a cultura estiver em foco.
    const vetadosNoFoco = dedup(
        vetados.filter(v => noFoco(v.produto) && (!v.cultura || culturaNoFoco(v.cultura))),
        v => `${v.produto}|${v.origem}`
    );

    return {
        culturasAtivas,
        bloqueios: bloqueiosNoFoco,
        ajustes: constraints.ajustes.filter(a => noFoco(a.produto)),
        recomendados: recomendadosNoFoco,
        vetados: vetadosNoFoco,
        escalonamentos: dedup(
            escalonamentos.filter(e => culturaNoFoco(e.cultura)),
            e => `${e.destino}|${e.cultura}|${e.detalhe}`
        ),
        incompatibilidades: constraints.incompatibilidades.filter(i => incompatNoFoco(i.entre)),
        proibicoes: constraints.proibicoes.filter(p => noFoco(p.produto)),
        regrasGlobais: constraints.regrasGlobais,
        politicas: recomputarPoliticasAgro(model, constraints.politicas, foco, bloqueiosNoFoco, vetadosNoFoco)
    };
}

/**
 * Reconstroi a politica de cada produto em foco a partir das restricoes que
 * sobreviveram ao filtro — e nao das que `retrieveAgroConstraints` tinha
 * aplicado sobre o grafo inteiro.
 *
 * Sem isto, um veto descartado do Prompt Semantico (porque vinha de uma cultura
 * fora do foco) continuava estreitando a gramatica: o modelo recebia uma
 * proibicao sem nenhuma linha no prompt que a justificasse. Aqui o que a
 * gramatica proibe volta a ser exatamente o que o prompt explica.
 */
function recomputarPoliticasAgro(
    model: AgroModel,
    politicasOriginais: Map<string, ProductPolicy>,
    foco: AgroFoco,
    bloqueios: RetrievedAgroConstraints['bloqueios'],
    vetados: RetrievedAgroConstraints['vetados']
): Map<string, ProductPolicy> {
    const schema = model.elements.filter(isAgroSchemaDef)[0];
    const politicas = new Map<string, ProductPolicy>();

    for (const [produto, original] of politicasOriginais) {
        if (!foco.produtos.has(produto)) continue;
        politicas.set(produto, {
            produto,
            decisoes: [...schema.decisions],
            modos: [...schema.modes],
            // unidades vem da bula do produto: nao dependem de contexto nenhum.
            unidades: original.unidades,
            valores: original.valores,
            valoresPorDecisao: original.valoresPorDecisao,
            motivos: [],
            bloqueado: false
        });
    }

    for (const bloqueio of bloqueios) {
        const policy = politicas.get(bloqueio.produto);
        if (!policy) continue;
        policy.decisoes = policy.decisoes.filter(d => !DECISOES_DE_INCREMENTO.has(d));
        policy.bloqueado = true;
        policy.motivos.push(`aplicacao bloqueada (${bloqueio.regra}): ${bloqueio.razao}`);
    }

    for (const veto of vetados) {
        const policy = politicas.get(veto.produto);
        if (!policy) continue;
        policy.decisoes = policy.decisoes.filter(d => DECISOES_DE_RETIRADA.includes(d));
        policy.bloqueado = true;
        policy.motivos.push(`vetado por ${veto.origem}: ${veto.motivo}`);
    }

    return politicas;
}
