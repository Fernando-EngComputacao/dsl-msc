/**
 * Mapeador AST -> Grafo de Conhecimento (Neo4j).
 *
 * Traduz o Esquema de Controle da DSL clinica em uma topologia relacional. O que
 * na DSL e texto estruturado vira, aqui, no e aresta tipada: e essa direcionalidade
 * ("Propofol --BLOQUEADO_POR--> PAM < 60") que um banco vetorial puro nao retem e
 * que sustenta a ancoragem factual da recuperacao (GraphRAG).
 *
 * Uso:
 *   npx tsx src/database/neo4j.ts [modelo.dsl]
 *
 * Variaveis de ambiente: NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD.
 */

import neo4j, { type Driver, type Session } from 'neo4j-driver';
import { EmptyFileSystem } from 'langium';
import { URI } from 'vscode-uri';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createDSLServices } from '../language/dsl-module.js';
import {
    isBlockRule,
    isContraindicationAttr,
    isDataSchemaDef,
    isDoseLimitAttr,
    isDrugDef,
    isEscalationAttr,
    isForbidAttr,
    isGlobalRule,
    isInteractionAttr,
    isLasaAttr,
    isMonitorAttr,
    isPopAdjust,
    isPopForbid,
    isPopRequire,
    isPopulationDef,
    isProtocolDef,
    isPumpLimitAttr,
    isRecommendAttr,
    isRenalAdjustAttr,
    isTitrationAttr,
    isTriggerAttr,
    type MedicalModel
} from '../generated/ast.js';

export interface SyncStats {
    farmacos: number;
    protocolos: number;
    populacoes: number;
    regras: number;
    condutas: number;
    relacoes: number;
}

/** Le e valida o modelo antes de qualquer escrita no banco. */
export async function loadModel(filePath: string): Promise<MedicalModel> {
    const { shared } = createDSLServices(EmptyFileSystem);
    const content = fs.readFileSync(filePath, 'utf-8');
    const document = shared.workspace.LangiumDocumentFactory.fromString<MedicalModel>(
        content,
        URI.file(path.resolve(filePath))
    );
    await shared.workspace.DocumentBuilder.build([document], { validation: true });

    const errors = [
        ...document.parseResult.lexerErrors.map(e => e.message),
        ...document.parseResult.parserErrors.map(e => e.message)
    ];
    if (errors.length > 0) {
        throw new Error(
            `Modelo com erros de sintaxe — nada foi gravado no grafo:\n  - ${errors.join('\n  - ')}`
        );
    }
    return document.parseResult.value;
}

/**
 * Sincroniza o modelo no grafo. Idempotente: usa MERGE em todos os nos e arestas,
 * de modo que reexecutar apos editar a DSL converge o grafo ao modelo atual.
 */
export async function syncModel(session: Session, model: MedicalModel): Promise<SyncStats> {
    const stats: SyncStats = {
        farmacos: 0,
        protocolos: 0,
        populacoes: 0,
        regras: 0,
        condutas: 0,
        relacoes: 0
    };

    const q = async (cypher: string, params: Record<string, unknown>) => {
        await session.run(cypher, params);
    };

    // ---------------------------------------------------------------- farmacos
    for (const drug of model.elements.filter(isDrugDef)) {
        await q(
            `MERGE (f:Farmaco { nome: $nome })
             SET f.classe = $classe, f.rxnorm = $rxnorm, f.atc = $atc,
                 f.altoRisco = $altoRisco`,
            {
                nome: drug.name,
                classe: drug.drugClass,
                rxnorm: drug.rxnorm,
                atc: drug.atc,
                altoRisco: drug.highAlert === 'sim'
            }
        );
        stats.farmacos++;

        for (const attr of drug.attributes) {
            if (isDoseLimitAttr(attr)) {
                await q(
                    `MATCH (f:Farmaco { nome: $nome })
                     MERGE (d:Dose { farmaco: $nome, tipo: $tipo })
                     SET d.valor = $valor, d.unidade = $unidade
                     MERGE (f)-[:TEM_DOSE]->(d)`,
                    {
                        nome: drug.name,
                        tipo: attr.kind,
                        valor: attr.value.value,
                        unidade: attr.value.unit
                    }
                );
                stats.relacoes++;
            } else if (isPumpLimitAttr(attr)) {
                // Limites DERS: o hard limit e o teto que nenhuma ordem pode cruzar.
                await q(
                    `MATCH (f:Farmaco { nome: $nome })
                     SET f.limiteLeve = $leve, f.limiteLeveUnidade = $leveUnidade,
                         f.limiteRigido = $rigido, f.limiteRigidoUnidade = $rigidoUnidade,
                         f.reservatorio = $reservatorio`,
                    {
                        nome: drug.name,
                        leve: attr.soft.value,
                        leveUnidade: attr.soft.unit,
                        rigido: attr.hard.value,
                        rigidoUnidade: attr.hard.unit,
                        reservatorio: attr.reservoir ?? null
                    }
                );
            } else if (isTitrationAttr(attr)) {
                await q(
                    `MATCH (f:Farmaco { nome: $nome })
                     SET f.passoTitulacao = $passo, f.passoUnidade = $passoUnidade,
                         f.intervaloTitulacao = $intervalo, f.intervaloUnidade = $intervaloUnidade,
                         f.alvoTitulacao = $alvo`,
                    {
                        nome: drug.name,
                        passo: attr.step.value,
                        passoUnidade: attr.step.unit,
                        intervalo: attr.interval.value,
                        intervaloUnidade: attr.interval.unit,
                        alvo: attr.target ?? null
                    }
                );
            } else if (isInteractionAttr(attr)) {
                await q(
                    `MATCH (a:Farmaco { nome: $de })
                     MERGE (b:Farmaco { nome: $para })
                     MERGE (a)-[i:INTERAGE_COM]->(b)
                     SET i.gravidade = $gravidade, i.mecanismo = $mecanismo, i.conduta = $conduta`,
                    {
                        de: drug.name,
                        para: attr.other.$refText,
                        gravidade: attr.severity,
                        mecanismo: attr.mechanism,
                        conduta: attr.conduct ?? null
                    }
                );
                stats.relacoes++;
            } else if (isRenalAdjustAttr(attr)) {
                await q(
                    `MATCH (f:Farmaco { nome: $nome })
                     MERGE (a:AjusteRenal { farmaco: $nome, parametro: $parametro,
                                            operador: $operador, limiar: $limiar })
                     SET a.unidade = $unidade, a.acao = $acao, a.detalhe = $detalhe
                     MERGE (f)-[:EXIGE_AJUSTE]->(a)`,
                    {
                        nome: drug.name,
                        parametro: attr.parameter,
                        operador: attr.operator,
                        limiar: attr.threshold.value,
                        unidade: attr.threshold.unit,
                        acao: attr.action,
                        detalhe: attr.detail
                    }
                );
                stats.relacoes++;
            } else if (isContraindicationAttr(attr)) {
                await q(
                    `MATCH (f:Farmaco { nome: $nome })
                     MERGE (c:Contraindicacao { farmaco: $nome, condicao: $condicao })
                     SET c.excecao = $excecao
                     MERGE (f)-[:CONTRAINDICADO_EM]->(c)`,
                    {
                        nome: drug.name,
                        condicao: attr.condition,
                        excecao: attr.exception ?? null
                    }
                );
                stats.relacoes++;
            } else if (isMonitorAttr(attr)) {
                await q(
                    `MATCH (f:Farmaco { nome: $nome })
                     MERGE (m:Monitoramento { farmaco: $nome, alvo: $alvo })
                     SET m.intervalo = $intervalo, m.unidade = $unidade, m.meta = $meta
                     MERGE (f)-[:MONITORA]->(m)`,
                    {
                        nome: drug.name,
                        alvo: attr.target,
                        intervalo: attr.interval.value,
                        unidade: attr.interval.unit,
                        meta: attr.goal ?? null
                    }
                );
                stats.relacoes++;
            } else if (isLasaAttr(attr)) {
                // Par LASA: aresta nao direcionada na pratica, gravada nos dois sentidos.
                await q(
                    `MATCH (a:Farmaco { nome: $nome })
                     MERGE (b:Farmaco { nome: $confundivel })
                     MERGE (a)-[l:LASA]->(b)
                     SET l.mitigacao = $mitigacao`,
                    {
                        nome: drug.name,
                        confundivel: attr.confusable.replace(/^['"]|['"]$/g, ''),
                        mitigacao: attr.mitigation ?? null
                    }
                );
                stats.relacoes++;
            }
        }
    }

    // -------------------------------------------------------------- protocolos
    for (const protocol of model.elements.filter(isProtocolDef)) {
        await q(`MERGE (p:Protocolo { nome: $nome }) SET p.cid = $cid`, {
            nome: protocol.name,
            cid: protocol.icd
        });
        stats.protocolos++;

        for (const attr of protocol.attributes) {
            if (isRecommendAttr(attr)) {
                await q(
                    `MATCH (p:Protocolo { nome: $protocolo })
                     MERGE (f:Farmaco { nome: $farmaco })
                     MERGE (p)-[r:RECOMENDA]->(f) SET r.indicacao = $indicacao`,
                    {
                        protocolo: protocol.name,
                        farmaco: attr.drug.$refText,
                        indicacao: attr.indication ?? null
                    }
                );
                stats.relacoes++;
            } else if (isForbidAttr(attr)) {
                await q(
                    `MATCH (p:Protocolo { nome: $protocolo })
                     MERGE (f:Farmaco { nome: $farmaco })
                     MERGE (p)-[r:VETA]->(f) SET r.motivo = $motivo`,
                    {
                        protocolo: protocol.name,
                        farmaco: attr.drug.$refText,
                        motivo: attr.reason
                    }
                );
                stats.relacoes++;
            } else if (isTriggerAttr(attr)) {
                await q(
                    `MATCH (p:Protocolo { nome: $protocolo })
                     MERGE (g:Gatilho { protocolo: $protocolo, parametro: $parametro,
                                        operador: $operador, valor: $valor })
                     SET g.unidade = $unidade, g.acao = $acao
                     MERGE (p)-[:DISPARA]->(g)`,
                    {
                        protocolo: protocol.name,
                        parametro: attr.parameter,
                        operador: attr.operator,
                        valor: attr.value.value,
                        unidade: attr.value.unit,
                        acao: attr.action
                    }
                );
                stats.relacoes++;
            } else if (isEscalationAttr(attr)) {
                await q(
                    `MATCH (p:Protocolo { nome: $protocolo })
                     MERGE (e:Escalonamento { protocolo: $protocolo, parametro: $parametro,
                                              operador: $operador, valor: $valor })
                     SET e.unidade = $unidade, e.destino = $destino, e.detalhe = $detalhe
                     MERGE (p)-[:ESCALONA]->(e)`,
                    {
                        protocolo: protocol.name,
                        parametro: attr.parameter,
                        operador: attr.operator,
                        valor: attr.value.value,
                        unidade: attr.value.unit,
                        destino: attr.target,
                        detalhe: attr.detail
                    }
                );
                stats.relacoes++;
            }
        }
    }

    // -------------------------------------------------------------- populacoes
    for (const population of model.elements.filter(isPopulationDef)) {
        await q(`MERGE (p:Populacao { nome: $nome }) SET p.criterio = $criterio`, {
            nome: population.name,
            criterio: population.criterion
        });
        stats.populacoes++;

        for (const restriction of population.restrictions) {
            if (isPopForbid(restriction)) {
                await q(
                    `MATCH (p:Populacao { nome: $populacao })
                     MERGE (f:Farmaco { nome: $farmaco })
                     MERGE (p)-[r:PROIBE]->(f) SET r.motivo = $motivo`,
                    {
                        populacao: population.name,
                        farmaco: restriction.drug.$refText,
                        motivo: restriction.reason
                    }
                );
                stats.relacoes++;
            } else if (isPopAdjust(restriction)) {
                await q(
                    `MATCH (p:Populacao { nome: $populacao })
                     MERGE (f:Farmaco { nome: $farmaco })
                     MERGE (p)-[r:AJUSTA]->(f) SET r.fator = $fator, r.motivo = $motivo`,
                    {
                        populacao: population.name,
                        farmaco: restriction.drug.$refText,
                        fator: restriction.factor,
                        motivo: restriction.reason ?? null
                    }
                );
                stats.relacoes++;
            } else if (isPopRequire(restriction)) {
                await q(
                    `MATCH (p:Populacao { nome: $populacao })
                     MERGE (e:Exigencia { texto: $texto })
                     MERGE (p)-[:EXIGE]->(e)`,
                    { populacao: population.name, texto: restriction.requirement }
                );
                stats.relacoes++;
            }
        }
    }

    // ------------------------------------------------------- regras e esquemas
    for (const element of model.elements) {
        if (isBlockRule(element)) {
            await q(
                `MERGE (f:Farmaco { nome: $farmaco })
                 MERGE (r:RegraSeguranca { farmaco: $farmaco, parametro: $parametro,
                                           operador: $operador, limiar: $limiar })
                 SET r.unidade = $unidade, r.razao = $razao
                 MERGE (r)-[:BLOQUEIA_INCREMENTO]->(f)`,
                {
                    farmaco: element.drug.$refText,
                    parametro: element.parameter,
                    operador: element.operator,
                    limiar: element.threshold.value,
                    unidade: element.threshold.unit,
                    razao: element.reason
                }
            );
            stats.regras++;
            stats.relacoes++;
        } else if (isGlobalRule(element)) {
            await q(
                `MERGE (r:RegraGlobal { descricao: $descricao })
                 SET r.severidade = $severidade, r.referencia = $referencia`,
                {
                    descricao: element.description,
                    severidade: element.severity ?? null,
                    referencia: element.reference ?? null
                }
            );
            stats.regras++;
        } else if (isDataSchemaDef(element)) {
            await q(
                `MERGE (e:EsquemaDados { nome: $nome })
                 SET e.decisoes = $decisoes, e.vias = $vias, e.alertas = $alertas`,
                {
                    nome: element.name,
                    decisoes: element.decisions,
                    vias: element.routes,
                    alertas: element.alerts
                }
            );
            for (const conduct of element.conducts) {
                await q(
                    `MATCH (e:EsquemaDados { nome: $esquema })
                     MERGE (c:Conduta { nome: $nome })
                     SET c.decisao = $decisao, c.via = $via,
                         c.duplaChecagem = $duplaChecagem, c.recursoFhir = $fhir
                     MERGE (e)-[:PERMITE]->(c)`,
                    {
                        esquema: element.name,
                        nome: conduct.name,
                        decisao: conduct.decision,
                        via: conduct.route ?? null,
                        duplaChecagem: conduct.doubleCheck === 'sim',
                        fhir: conduct.fhir ?? null
                    }
                );
                stats.condutas++;
                stats.relacoes++;
            }
        }
    }

    return stats;
}

async function main(): Promise<void> {
    const modelPath = process.argv[2] ?? path.join('src', 'examples', 'uti.dsl');
    const model = await loadModel(modelPath);

    const driver: Driver = neo4j.driver(
        process.env.NEO4J_URI ?? 'bolt://localhost:7687',
        neo4j.auth.basic(
            process.env.NEO4J_USER ?? 'neo4j',
            process.env.NEO4J_PASSWORD ?? '#UFG2026'
        )
    );

    const session = driver.session();
    try {
        console.log(`Sincronizando ${path.basename(modelPath)} no Grafo de Conhecimento...`);
        const stats = await syncModel(session, model);
        console.log('Sincronizacao concluida:');
        console.log(`  Farmacos:   ${stats.farmacos}`);
        console.log(`  Protocolos: ${stats.protocolos}`);
        console.log(`  Populacoes: ${stats.populacoes}`);
        console.log(`  Regras:     ${stats.regras}`);
        console.log(`  Condutas:   ${stats.condutas}`);
        console.log(`  Relacoes:   ${stats.relacoes}`);
    } finally {
        await session.close();
        await driver.close();
    }
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
    main().catch(err => {
        console.error('Falha na sincronizacao com o Neo4j:', err.message ?? err);
        process.exit(1);
    });
}
