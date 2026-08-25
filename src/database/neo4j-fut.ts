/**
 * Ancoragem do modelo de arbitragem de futebol no Grafo de Conhecimento (Neo4j).
 *
 * Espelha src/database/neo4j.ts (clinico) e src/database/neo4j-agro.ts (agricola)
 * no dominio da arbitragem. O grafo e a materializacao do Esquema de Controle:
 * infracoes, lances, contextos e as invariantes que ligam uns aos outros. A
 * recuperacao (graphrag-fut.ts) le esta mesma estrutura a partir da AST, de modo
 * que o banco e a fonte inspecionavel do que a decodificacao restrita usa.
 *
 * Uso:
 *   npx tsx src/database/neo4j-fut.ts [futebol.fut]
 */

import neo4j, { type Driver, type Session } from 'neo4j-driver';
import { EmptyFileSystem } from 'langium';
import { URI } from 'vscode-uri';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createFutServices } from '../language/fut-module.js';
import { embedOpcional, EMBED_DIMENSOES } from '../knowledge/embeddings.js';
import {
    isAgravanteAttr,
    isConfusaoAttr,
    isContextAdjust,
    isContextDef,
    isContextForbid,
    isContextRequire,
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
    isSancaoAttr,
    isSituationDef,
    isTriggerAttr,
    isZonaAttr,
    type FutModel
} from '../generated/ast.js';

export interface FutSyncStats {
    infracoes: number;
    lances: number;
    contextos: number;
    regras: number;
    condutas: number;
    relacoes: number;
}

/** Le e valida o modelo antes de qualquer escrita no banco. */
export async function loadFutModel(filePath: string): Promise<FutModel> {
    const { shared } = createFutServices(EmptyFileSystem);
    const content = fs.readFileSync(filePath, 'utf-8');
    const document = shared.workspace.LangiumDocumentFactory.fromString<FutModel>(
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
 * Sincroniza o modelo de arbitragem no grafo. Idempotente: usa MERGE em todos os
 * nos e arestas, de modo que reexecutar apos editar a DSL converge o grafo ao
 * modelo.
 */
export async function syncFutModel(session: Session, model: FutModel): Promise<FutSyncStats> {
    const stats: FutSyncStats = {
        infracoes: 0,
        lances: 0,
        contextos: 0,
        regras: 0,
        condutas: 0,
        relacoes: 0
    };

    const q = async (cypher: string, params: Record<string, unknown>) => {
        await session.run(cypher, params);
    };

    // --------------------------------------------------------------- infracoes
    for (const infraction of model.elements.filter(isInfractionDef)) {
        await q(
            `MERGE (i:Infracao { nome: $nome })
             SET i.classe = $classe, i.leiIfab = $lei, i.varRevisavel = $varRevisavel`,
            {
                nome: infraction.name,
                classe: infraction.foulClass,
                lei: infraction.lawRef,
                varRevisavel: infraction.varReviewable === 'sim'
            }
        );
        stats.infracoes++;

        // Vetor para a recuperacao por similaridade (ver graphrag-fut.ts::retrieverFocoFut).
        const vetorInfracao = await embedOpcional(
            `${infraction.name}, classe ${infraction.foulClass ?? ''}`.trim()
        );
        if (vetorInfracao) {
            await q(`MATCH (i:Infracao { nome: $nome }) SET i.embedding = $vetor`, {
                nome: infraction.name,
                vetor: vetorInfracao
            });
        }

        for (const attr of infraction.attributes) {
            if (isSancaoAttr(attr)) {
                await q(
                    `MATCH (i:Infracao { nome: $nome })
                     MERGE (s:Sancao { infracao: $nome })
                     SET s.cartao = $cartao, s.reincidencia = $reincidencia
                     MERGE (i)-[:TEM_SANCAO]->(s)`,
                    {
                        nome: infraction.name,
                        cartao: attr.card,
                        reincidencia: attr.recurrence ?? null
                    }
                );
                stats.relacoes++;
            } else if (isLimiarAttr(attr)) {
                await q(
                    `MATCH (i:Infracao { nome: $nome })
                     MERGE (l:Limiar { infracao: $nome, parametro: $parametro,
                                       operador: $operador, valor: $valor })
                     SET l.acao = $acao, l.unidade = $unidade, l.detalhe = $detalhe
                     MERGE (i)-[:TEM_LIMIAR]->(l)`,
                    {
                        nome: infraction.name,
                        parametro: attr.parameter,
                        operador: attr.operator,
                        valor: attr.threshold.value,
                        unidade: attr.threshold.unit,
                        acao: attr.action,
                        detalhe: attr.detail
                    }
                );
                stats.relacoes++;
            } else if (isZonaAttr(attr)) {
                await q(
                    `MATCH (i:Infracao { nome: $nome })
                     MERGE (z:ZonaPenal { infracao: $nome, zona: $zona })
                     SET z.acao = $acao, z.detalhe = $detalhe
                     MERGE (i)-[:TEM_ZONA]->(z)`,
                    {
                        nome: infraction.name,
                        zona: attr.zone,
                        acao: attr.action,
                        detalhe: attr.detail
                    }
                );
                stats.relacoes++;
            } else if (isAgravanteAttr(attr)) {
                await q(
                    `MATCH (a:Infracao { nome: $de })
                     MERGE (b:Infracao { nome: $para })
                     MERGE (a)-[r:AGRAVA_COM]->(b)
                     SET r.gravidade = $gravidade, r.mecanismo = $mecanismo, r.conduta = $conduta`,
                    {
                        de: infraction.name,
                        para: attr.other.$refText,
                        gravidade: attr.severity,
                        mecanismo: attr.mechanism,
                        conduta: attr.conduct ?? null
                    }
                );
                stats.relacoes++;
            } else if (isIsencaoAttr(attr)) {
                await q(
                    `MATCH (i:Infracao { nome: $nome })
                     MERGE (e:Isencao { infracao: $nome, condicao: $condicao })
                     SET e.excecao = $excecao
                     MERGE (i)-[:ISENTO_EM]->(e)`,
                    {
                        nome: infraction.name,
                        condicao: attr.condition,
                        excecao: attr.exception ?? null
                    }
                );
                stats.relacoes++;
            } else if (isConfusaoAttr(attr)) {
                await q(
                    `MATCH (i:Infracao { nome: $nome })
                     MERGE (c:ConfusaoComum { infracao: $nome, confundivel: $confundivel })
                     SET c.mitigacao = $mitigacao
                     MERGE (i)-[:CONFUNDE_COM]->(c)`,
                    {
                        nome: infraction.name,
                        confundivel: attr.confusable,
                        mitigacao: attr.mitigation ?? null
                    }
                );
                stats.relacoes++;
            }
        }
    }

    // ------------------------------------------------------------------ lances
    for (const situation of model.elements.filter(isSituationDef)) {
        await q(`MERGE (l:Lance { nome: $nome }) SET l.leiIfab = $lei`, {
            nome: situation.name,
            lei: situation.lawRef
        });
        stats.lances++;

        const vetorLance = await embedOpcional(`${situation.name}, lei ${situation.lawRef ?? ''}`.trim());
        if (vetorLance) {
            await q(`MATCH (l:Lance { nome: $nome }) SET l.embedding = $vetor`, {
                nome: situation.name,
                vetor: vetorLance
            });
        }

        for (const attr of situation.attributes) {
            if (isFutRecommendAttr(attr)) {
                await q(
                    `MATCH (l:Lance { nome: $lance })
                     MERGE (i:Infracao { nome: $infracao })
                     MERGE (l)-[r:RECOMENDA]->(i) SET r.indicacao = $indicacao`,
                    {
                        lance: situation.name,
                        infracao: attr.infraction.$refText,
                        indicacao: attr.indication ?? null
                    }
                );
                stats.relacoes++;
            } else if (isFutForbidAttr(attr)) {
                await q(
                    `MATCH (l:Lance { nome: $lance })
                     MERGE (i:Infracao { nome: $infracao })
                     MERGE (l)-[r:VETA]->(i) SET r.motivo = $motivo`,
                    {
                        lance: situation.name,
                        infracao: attr.infraction.$refText,
                        motivo: attr.reason
                    }
                );
                stats.relacoes++;
            } else if (isTriggerAttr(attr)) {
                await q(
                    `MATCH (l:Lance { nome: $lance })
                     MERGE (g:Gatilho { lance: $lance, parametro: $parametro,
                                        operador: $operador, valor: $valor })
                     SET g.acao = $acao, g.unidade = $unidade
                     MERGE (l)-[:DISPARA]->(g)`,
                    {
                        lance: situation.name,
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
                    `MATCH (l:Lance { nome: $lance })
                     MERGE (e:Escalonamento { lance: $lance, parametro: $parametro,
                                              operador: $operador, valor: $valor })
                     SET e.destino = $destino, e.detalhe = $detalhe
                     MERGE (l)-[:ESCALONA]->(e)`,
                    {
                        lance: situation.name,
                        parametro: attr.parameter,
                        operador: attr.operator,
                        valor: attr.value.value,
                        destino: attr.target,
                        detalhe: attr.detail
                    }
                );
                stats.relacoes++;
            }
        }
    }

    // --------------------------------------------------------------- contextos
    for (const context of model.elements.filter(isContextDef)) {
        await q(`MERGE (c:Contexto { nome: $nome }) SET c.criterio = $criterio`, {
            nome: context.name,
            criterio: context.criterion
        });
        stats.contextos++;

        for (const restriction of context.restrictions) {
            if (isContextForbid(restriction)) {
                await q(
                    `MATCH (c:Contexto { nome: $contexto })
                     MERGE (i:Infracao { nome: $infracao })
                     MERGE (c)-[r:PROIBE]->(i) SET r.motivo = $motivo`,
                    {
                        contexto: context.name,
                        infracao: restriction.infraction.$refText,
                        motivo: restriction.reason
                    }
                );
                stats.relacoes++;
            } else if (isContextAdjust(restriction)) {
                await q(
                    `MATCH (c:Contexto { nome: $contexto })
                     MERGE (i:Infracao { nome: $infracao })
                     MERGE (c)-[r:AJUSTA]->(i) SET r.fator = $fator, r.motivo = $motivo`,
                    {
                        contexto: context.name,
                        infracao: restriction.infraction.$refText,
                        fator: restriction.factor,
                        motivo: restriction.reason ?? null
                    }
                );
                stats.relacoes++;
            } else if (isContextRequire(restriction)) {
                await q(
                    `MATCH (c:Contexto { nome: $contexto })
                     MERGE (e:Exigencia { texto: $texto })
                     MERGE (c)-[:EXIGE]->(e)`,
                    { contexto: context.name, texto: restriction.requirement }
                );
                stats.relacoes++;
            }
        }
    }

    // ------------------------------------------------ invariantes de seguranca
    for (const element of model.elements) {
        if (isFutBlockRule(element)) {
            await q(
                `MERGE (i:Infracao { nome: $infracao })
                 MERGE (r:RegraSeguranca { infracao: $infracao, parametro: $parametro,
                                           operador: $operador, limiar: $limiar })
                 SET r.razao = $razao, r.unidade = $unidade
                 MERGE (r)-[:BLOQUEIA]->(i)`,
                {
                    infracao: element.infraction.$refText,
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
        }
    }

    // ------------------------------------------------------- Esquema de Dados
    for (const element of model.elements) {
        if (!isFutSchemaDef(element)) continue;
        await q(
            `MERGE (e:EsquemaDados { nome: $nome })
             SET e.decisoes = $decisoes, e.reinicios = $reinicios, e.alertas = $alertas`,
            {
                nome: element.name,
                decisoes: [...element.decisions],
                reinicios: [...element.restarts],
                alertas: [...element.alerts]
            }
        );
        for (const conduct of element.conducts) {
            await q(
                `MATCH (e:EsquemaDados { nome: $esquema })
                 MERGE (c:Conduta { nome: $nome })
                 SET c.decisao = $decisao, c.reinicio = $reinicio, c.requerVar = $requerVar
                 MERGE (e)-[:PERMITE]->(c)`,
                {
                    esquema: element.name,
                    nome: conduct.name,
                    decisao: conduct.decision,
                    reinicio: conduct.restart ?? null,
                    requerVar: conduct.requiresVar === 'sim'
                }
            );
            stats.condutas++;
            stats.relacoes++;
        }
    }

    // Indice vetorial para a recuperacao por embedding (ver graphrag-fut.ts::retrieverFocoFut).
    try {
        await q(
            `CREATE VECTOR INDEX infracao_embedding IF NOT EXISTS
             FOR (i:Infracao) ON (i.embedding)
             OPTIONS { indexConfig: { \`vector.dimensions\`: ${EMBED_DIMENSOES}, \`vector.similarity_function\`: 'cosine' } }`,
            {}
        );
        await q(
            `CREATE VECTOR INDEX lance_embedding IF NOT EXISTS
             FOR (l:Lance) ON (l.embedding)
             OPTIONS { indexConfig: { \`vector.dimensions\`: ${EMBED_DIMENSOES}, \`vector.similarity_function\`: 'cosine' } }`,
            {}
        );
    } catch (error) {
        console.warn(`   (indice vetorial nao pode ser criado: ${(error as Error).message})`);
    }

    return stats;
}

async function main(): Promise<void> {
    const modelPath = process.argv[2] ?? path.join('src', 'examples', 'fut', 'futebol.fut');
    const model = await loadFutModel(modelPath);

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
        const stats = await syncFutModel(session, model);
        console.log('Sincronizacao concluida:');
        console.log(`  Infracoes: ${stats.infracoes}`);
        console.log(`  Lances:    ${stats.lances}`);
        console.log(`  Contextos: ${stats.contextos}`);
        console.log(`  Regras:    ${stats.regras}`);
        console.log(`  Condutas:  ${stats.condutas}`);
        console.log(`  Relacoes:  ${stats.relacoes}`);
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
