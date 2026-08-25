/**
 * Documentos de indexacao dos nos do Grafo de Conhecimento.
 *
 * O que entra aqui e o texto que vai ao indice vetorial do Neo4j na
 * sincronizacao (`database/neo4j*.ts`) e contra o qual a fala do usuario e
 * comparada na consulta (`knowledge/graphrag*.ts`). Como os dois lados usam o
 * mesmo modelo (bge-m3), a qualidade da recuperacao e decidida inteiramente pelo
 * que se escreve neste arquivo.
 *
 * A versao anterior indexava so `"<nome>, classe <classe>"`. Um pedido sobre
 * cana media 0.51 de cosseno contra Imidacloprido e 0.44 contra Glifosato — sete
 * centesimos separando o produto certo de um herbicida sem nenhuma relacao com o
 * pedido. Nao ha limiar que sobreviva a essa compressao.
 *
 * O documento agora carrega, alem do nome:
 *
 *   - VARIANTES DE ESCRITA — `Cana_de_Acucar` tokeniza mal; "Cana de Acucar" e o
 *     que o operador digita.
 *   - O ALVO BIOLOGICO/CLINICO — "broca-da-cana", "ferrugem asiatica", "choque
 *     septico": e por aqui que uma fala sem nenhum nome proprio ("a folha ta
 *     fervendo") ainda alcanca o no certo.
 *   - A VIZINHANCA NO GRAFO — as culturas que recomendam o produto, os
 *     protocolos que vetam o farmaco, os lances que pedem a infracao. E o que
 *     faz o vetor do no carregar o subgrafo dele, e nao so a propria ficha.
 *
 * Medido no mesmo pedido sobre cana, a mudanca leva Imidacloprido de 0.51 para
 * 0.59 e o afasta do segundo colocado o suficiente para o corte por margem
 * funcionar.
 */

import {
    isAgroForbidAttr,
    isAgroRecommendAttr,
    isAreaAdjust,
    isAreaDef,
    isAreaForbid,
    isBanConditionAttr,
    isConfusaoAttr,
    isContextAdjust,
    isContextDef,
    isContextForbid,
    isContraindicationAttr,
    isCultureDef,
    isDrugDef,
    isForbidAttr,
    isFutForbidAttr,
    isFutRecommendAttr,
    isInfractionDef,
    isIsencaoAttr,
    isLasaAttr,
    isMonitorAttr,
    isOutcomeAttr,
    isPopAdjust,
    isPopForbid,
    isPopulationDef,
    isProductDef,
    isProtocolDef,
    isRecommendAttr,
    isReinicioAttr,
    isRouteAttr,
    isSancaoAttr,
    isSituationDef,
    isSnomedAttr,
    isStepAttr,
    isTargetAttr,
    isTriggerAttr,
    isWindowAttr,
    isZonaAttr,
    type AgroModel,
    type CultureDef,
    type DrugDef,
    type FutModel,
    type InfractionDef,
    type MedicalModel,
    type ProductDef,
    type ProtocolDef,
    type SituationDef
} from '../generated/ast.js';
import { montarDocumento, variantesDoNome } from './foco.js';

/** Junta itens numa clausula so quando ha algo a dizer. */
function clausula(rotulo: string, itens: string[]): string | undefined {
    const limpos = itens.map(i => i.trim()).filter(i => i.length > 0);
    return limpos.length > 0 ? `${rotulo}: ${[...new Set(limpos)].join(', ')}` : undefined;
}

/** `Cana_de_Acucar` -> "Cana de Acucar", para citar vizinhos de forma legivel. */
function legivel(nome: string): string {
    return nome.replace(/_/g, ' ');
}

// =============================================================================
// Dominio agricola
// =============================================================================

export function documentoProduto(product: ProductDef, model: AgroModel): string {
    const alvos: string[] = [];
    const proibicoes: string[] = [];
    for (const attr of product.attributes) {
        if (isTargetAttr(attr)) {
            alvos.push(attr.stage ? `${attr.target} (${attr.stage})` : attr.target);
        } else if (isBanConditionAttr(attr)) {
            proibicoes.push(attr.condition);
        }
    }

    const indicadoEm: string[] = [];
    const vetadoEm: string[] = [];
    for (const culture of model.elements.filter(isCultureDef)) {
        for (const attr of culture.attributes) {
            if (isAgroRecommendAttr(attr) && attr.product.$refText === product.name) {
                indicadoEm.push(
                    attr.indication
                        ? `${legivel(culture.name)} (${attr.indication})`
                        : legivel(culture.name)
                );
            } else if (isAgroForbidAttr(attr) && attr.product.$refText === product.name) {
                vetadoEm.push(`${legivel(culture.name)} (${attr.reason})`);
            }
        }
    }

    const areas: string[] = [];
    for (const area of model.elements.filter(isAreaDef)) {
        for (const restricao of area.restrictions) {
            if (isAreaForbid(restricao) && restricao.product.$refText === product.name) {
                areas.push(`proibido em ${legivel(area.name)} (${restricao.reason})`);
            } else if (isAreaAdjust(restricao) && restricao.product.$refText === product.name) {
                areas.push(`vazao ajustada em ${legivel(area.name)}`);
            }
        }
    }

    return montarDocumento([
        `Produto ${variantesDoNome(product.name)}`,
        `classe ${product.productClass}`,
        `classe toxicologica ${product.toxicity}`,
        clausula('Alvo', alvos),
        clausula('Indicado na cultura', indicadoEm),
        clausula('Vetado na cultura', vetadoEm),
        clausula('Restricoes de area', areas),
        clausula('Proibido em', proibicoes)
    ]);
}

export function documentoCultura(culture: CultureDef, model: AgroModel): string {
    const monitorados: string[] = [];
    const recomendados: string[] = [];
    const vetados: string[] = [];
    const janelas: string[] = [];

    for (const attr of culture.attributes) {
        if (isTriggerAttr(attr)) {
            monitorados.push(`${attr.parameter} (${attr.action})`);
        } else if (isAgroRecommendAttr(attr)) {
            const nome = legivel(attr.product.$refText);
            recomendados.push(attr.indication ? `${nome} (${attr.indication})` : nome);
        } else if (isAgroForbidAttr(attr)) {
            vetados.push(`${legivel(attr.product.$refText)} (${attr.reason})`);
        } else if (isWindowAttr(attr)) {
            janelas.push(attr.description);
        }
    }

    return montarDocumento([
        `Cultura ${variantesDoNome(culture.name)}`,
        `ciclo ${culture.cycle}`,
        clausula('Sinais monitorados', monitorados),
        clausula('Produtos recomendados', recomendados),
        clausula('Produtos vetados', vetados),
        clausula('Janela de aplicacao', janelas)
    ]);
}

// =============================================================================
// Dominio clinico
// =============================================================================

export function documentoFarmaco(drug: DrugDef, model: MedicalModel): string {
    const vias: string[] = [];
    const monitorados: string[] = [];
    const contraindicacoes: string[] = [];
    const confundiveis: string[] = [];

    for (const attr of drug.attributes) {
        if (isRouteAttr(attr)) vias.push(...attr.routes);
        else if (isMonitorAttr(attr)) monitorados.push(attr.goal ? `${attr.target} (${attr.goal})` : attr.target);
        else if (isContraindicationAttr(attr)) contraindicacoes.push(attr.condition);
        else if (isLasaAttr(attr)) confundiveis.push(attr.confusable);
    }

    const indicadoEm: string[] = [];
    const vetadoEm: string[] = [];
    for (const protocol of model.elements.filter(isProtocolDef)) {
        for (const attr of protocol.attributes) {
            if (isRecommendAttr(attr) && attr.drug.$refText === drug.name) {
                indicadoEm.push(
                    attr.indication
                        ? `${legivel(protocol.name)} (${attr.indication})`
                        : legivel(protocol.name)
                );
            } else if (isForbidAttr(attr) && attr.drug.$refText === drug.name) {
                vetadoEm.push(`${legivel(protocol.name)} (${attr.reason})`);
            }
        }
    }

    const populacoes: string[] = [];
    for (const population of model.elements.filter(isPopulationDef)) {
        for (const restricao of population.restrictions) {
            if (isPopForbid(restricao) && restricao.drug.$refText === drug.name) {
                populacoes.push(`vetado em ${legivel(population.name)} (${restricao.reason})`);
            } else if (isPopAdjust(restricao) && restricao.drug.$refText === drug.name) {
                populacoes.push(`dose ajustada em ${legivel(population.name)}`);
            }
        }
    }

    return montarDocumento([
        `Farmaco ${variantesDoNome(drug.name)}`,
        `classe ${drug.drugClass}`,
        drug.highAlert === 'sim' ? 'medicamento de alto risco' : undefined,
        clausula('Vias', vias),
        clausula('Indicado no protocolo', indicadoEm),
        clausula('Vetado no protocolo', vetadoEm),
        clausula('Populacoes especiais', populacoes),
        clausula('Monitorar', monitorados),
        clausula('Contraindicado em', contraindicacoes),
        clausula('Confundivel com', confundiveis)
    ]);
}

export function documentoProtocolo(protocol: ProtocolDef, model: MedicalModel): string {
    const monitorados: string[] = [];
    const etapas: string[] = [];
    const recomendados: string[] = [];
    const vetados: string[] = [];
    const desfechos: string[] = [];
    let snomed: string | undefined;

    for (const attr of protocol.attributes) {
        if (isTriggerAttr(attr)) monitorados.push(`${attr.parameter} (${attr.action})`);
        else if (isStepAttr(attr)) etapas.push(attr.description);
        else if (isRecommendAttr(attr)) {
            const nome = legivel(attr.drug.$refText);
            recomendados.push(attr.indication ? `${nome} (${attr.indication})` : nome);
        } else if (isForbidAttr(attr)) {
            vetados.push(`${legivel(attr.drug.$refText)} (${attr.reason})`);
        } else if (isOutcomeAttr(attr)) desfechos.push(attr.description);
        else if (isSnomedAttr(attr)) snomed = attr.code;
    }

    // O modelo declara farmacos com `contraindicado:` citando o protocolo em
    // prosa; nao ha aresta para percorrer, entao o que liga os dois no indice e o
    // texto das indicacoes acima.
    void model;

    return montarDocumento([
        `Protocolo ${variantesDoNome(protocol.name)}`,
        `CID ${protocol.icd}`,
        snomed ? `SNOMED ${snomed}` : undefined,
        clausula('Sinais monitorados', monitorados),
        clausula('Etapas', etapas),
        clausula('Farmacos recomendados', recomendados),
        clausula('Farmacos vetados', vetados),
        clausula('Desfecho', desfechos)
    ]);
}

// =============================================================================
// Dominio da arbitragem
// =============================================================================

export function documentoInfracao(infraction: InfractionDef, model: FutModel): string {
    const sancoes: string[] = [];
    const reinicios: string[] = [];
    const zonas: string[] = [];
    const isencoes: string[] = [];
    const confundiveis: string[] = [];

    for (const attr of infraction.attributes) {
        if (isSancaoAttr(attr)) {
            sancoes.push(
                attr.recurrence ? `${attr.card} (reincidencia ${attr.recurrence})` : attr.card
            );
        } else if (isReinicioAttr(attr)) reinicios.push(...attr.restarts);
        else if (isZonaAttr(attr)) zonas.push(`${attr.zone} -> ${attr.detail}`);
        else if (isIsencaoAttr(attr)) isencoes.push(attr.condition);
        else if (isConfusaoAttr(attr)) confundiveis.push(attr.confusable);
    }

    const pedidaEm: string[] = [];
    const vetadaEm: string[] = [];
    for (const situation of model.elements.filter(isSituationDef)) {
        for (const attr of situation.attributes) {
            if (isFutRecommendAttr(attr) && attr.infraction.$refText === infraction.name) {
                pedidaEm.push(
                    attr.indication
                        ? `${legivel(situation.name)} (${attr.indication})`
                        : legivel(situation.name)
                );
            } else if (isFutForbidAttr(attr) && attr.infraction.$refText === infraction.name) {
                vetadaEm.push(`${legivel(situation.name)} (${attr.reason})`);
            }
        }
    }

    const contextos: string[] = [];
    for (const contexto of model.elements.filter(isContextDef)) {
        for (const restricao of contexto.restrictions) {
            if (isContextForbid(restricao) && restricao.infraction.$refText === infraction.name) {
                contextos.push(`vetada em ${legivel(contexto.name)} (${restricao.reason})`);
            } else if (isContextAdjust(restricao) && restricao.infraction.$refText === infraction.name) {
                contextos.push(`gravidade ajustada em ${legivel(contexto.name)}`);
            }
        }
    }

    return montarDocumento([
        `Infracao ${variantesDoNome(infraction.name)}`,
        `classe ${infraction.foulClass}`,
        `lei IFAB ${infraction.lawRef}`,
        infraction.varReviewable === 'sim' ? 'revisavel pelo VAR' : 'nao revisavel pelo VAR',
        clausula('Sancao', sancoes),
        clausula('Reinicios', reinicios),
        clausula('Zona', zonas),
        clausula('Marcada no lance', pedidaEm),
        clausula('Vetada no lance', vetadaEm),
        clausula('Contextos especiais', contextos),
        clausula('Nao se configura quando', isencoes),
        clausula('Confundivel com', confundiveis)
    ]);
}

export function documentoLance(situation: SituationDef, model: FutModel): string {
    const monitorados: string[] = [];
    const etapas: string[] = [];
    const recomendadas: string[] = [];
    const vetadas: string[] = [];
    const desfechos: string[] = [];

    for (const attr of situation.attributes) {
        if (isTriggerAttr(attr)) monitorados.push(`${attr.parameter} (${attr.action})`);
        else if (isStepAttr(attr)) etapas.push(attr.description);
        else if (isFutRecommendAttr(attr)) {
            const nome = legivel(attr.infraction.$refText);
            recomendadas.push(attr.indication ? `${nome} (${attr.indication})` : nome);
        } else if (isFutForbidAttr(attr)) {
            vetadas.push(`${legivel(attr.infraction.$refText)} (${attr.reason})`);
        } else if (isOutcomeAttr(attr)) desfechos.push(attr.description);
    }

    void model;

    return montarDocumento([
        `Lance ${variantesDoNome(situation.name)}`,
        `lei IFAB ${situation.lawRef}`,
        clausula('Sinais monitorados', monitorados),
        clausula('Etapas', etapas),
        clausula('Infracoes recomendadas', recomendadas),
        clausula('Infracoes vetadas', vetadas),
        clausula('Desfecho', desfechos)
    ]);
}

// =============================================================================
// Nomes indexados por dominio — usados pelo casamento lexical do foco.
// =============================================================================

export function nomesAgro(model: AgroModel): { produtos: string[]; culturas: string[] } {
    return {
        produtos: model.elements.filter(isProductDef).map(p => p.name),
        culturas: model.elements.filter(isCultureDef).map(c => c.name)
    };
}

export function nomesMed(model: MedicalModel): { farmacos: string[]; protocolos: string[] } {
    return {
        farmacos: model.elements.filter(isDrugDef).map(d => d.name),
        protocolos: model.elements.filter(isProtocolDef).map(p => p.name)
    };
}

export function nomesFut(model: FutModel): { infracoes: string[]; lances: string[] } {
    return {
        infracoes: model.elements.filter(isInfractionDef).map(i => i.name),
        lances: model.elements.filter(isSituationDef).map(s => s.name)
    };
}
