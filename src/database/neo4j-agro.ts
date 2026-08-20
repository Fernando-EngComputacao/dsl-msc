/**
 * Ancoragem do modelo agricola no Grafo de Conhecimento (Neo4j).
 *
 * Espelha src/database/neo4j.ts no dominio da pulverizacao por drone. O grafo e
 * a materializacao do Esquema de Controle: produtos, culturas, areas e as
 * invariantes que ligam uns aos outros. A recuperacao (graphrag-agro.ts) le esta
 * mesma estrutura a partir da AST, de modo que o banco e a fonte inspecionavel do
 * que a decodificacao restrita usa.
 *
 * Uso:
 *   npx tsx src/database/neo4j-agro.ts [lavoura.agro]
 */

import neo4j, { type Driver, type Session } from 'neo4j-driver';
import { EmptyFileSystem } from 'langium';
import { URI } from 'vscode-uri';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createAgroServices } from '../language/agro-module.js';
import { embedOpcional, EMBED_DIMENSOES } from '../knowledge/embeddings.js';
import {
    isAgroBlockRule,
    isAgroForbidAttr,
    isAgroRecommendAttr,
    isAgroSchemaDef,
    isAreaAdjust,
    isAreaDef,
    isAreaForbid,
    isAreaRequire,
    isBanConditionAttr,
    isCarencyAttr,
    isCultureDef,
    isDoseAttr,
    isEscalationAttr,
    isGlobalRule,
    isIncompatAttr,
    isProductDef,
    isTriggerAttr,
    type AgroModel
} from '../generated/ast.js';

export interface AgroSyncStats {
    produtos: number;
    culturas: number;
    areas: number;
    regras: number;
    condutas: number;
    relacoes: number;
}

/** Le e valida o modelo antes de qualquer escrita no banco. */
export async function loadAgroModel(filePath: string): Promise<AgroModel> {
    const { shared } = createAgroServices(EmptyFileSystem);
    const content = fs.readFileSync(filePath, 'utf-8');
    const document = shared.workspace.LangiumDocumentFactory.fromString<AgroModel>(
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
 * Sincroniza o modelo agricola no grafo. Idempotente: usa MERGE em todos os nos e
 * arestas, de modo que reexecutar apos editar a DSL converge o grafo ao modelo.
 */
export async function syncAgroModel(
    session: Session,
    model: AgroModel
): Promise<AgroSyncStats> {
    const stats: AgroSyncStats = {
        produtos: 0,
        culturas: 0,
        areas: 0,
        regras: 0,
        condutas: 0,
        relacoes: 0
    };

    const q = async (cypher: string, params: Record<string, unknown>) => {
        await session.run(cypher, params);
    };

    // ----------------------------------------------------------------- produtos
    for (const product of model.elements.filter(isProductDef)) {
        await q(
            `MERGE (p:Produto { nome: $nome })
             SET p.classe = $classe, p.registroMapa = $mapa, p.toxicologica = $tox`,
            {
                nome: product.name,
                classe: product.productClass,
                mapa: product.mapa,
                tox: product.toxicity
            }
        );
        stats.produtos++;

        // Vetor para a recuperacao por similaridade (ver graphrag-agro.ts::retrieverFocoAgro).
        const vetorProduto = await embedOpcional(`${product.name}, classe ${product.productClass ?? ''}`.trim());
        if (vetorProduto) {
            await q(`MATCH (p:Produto { nome: $nome }) SET p.embedding = $vetor`, {
                nome: product.name,
                vetor: vetorProduto
            });
        }

        for (const attr of product.attributes) {
            if (isDoseAttr(attr)) {
                await q(
                    `MATCH (p:Produto { nome: $nome })
                     MERGE (d:Dose { produto: $nome, tipo: $tipo })
                     SET d.valor = $valor, d.unidade = $unidade
                     MERGE (p)-[:TEM_DOSE]->(d)`,
                    {
                        nome: product.name,
                        tipo: attr.kind,
                        valor: attr.value.value,
                        unidade: attr.value.unit
                    }
                );
                stats.relacoes++;
            } else if (isCarencyAttr(attr)) {
                await q(
                    `MATCH (p:Produto { nome: $nome })
                     MERGE (c:Carencia { produto: $nome })
                     SET c.periodo = $periodo, c.unidade = $unidade, c.reentrada = $reentrada
                     MERGE (p)-[:EXIGE_CARENCIA]->(c)`,
                    {
                        nome: product.name,
                        periodo: attr.period.value,
                        unidade: attr.period.unit,
                        reentrada: attr.reentry ? `${attr.reentry.value} ${attr.reentry.unit}` : null
                    }
                );
                stats.relacoes++;
            } else if (isIncompatAttr(attr)) {
                await q(
                    `MATCH (a:Produto { nome: $de })
                     MERGE (b:Produto { nome: $para })
                     MERGE (a)-[i:INCOMPATIVEL_COM]->(b)
                     SET i.gravidade = $gravidade, i.mecanismo = $mecanismo, i.conduta = $conduta`,
                    {
                        de: product.name,
                        para: attr.other.$refText,
                        gravidade: attr.severity,
                        mecanismo: attr.mechanism,
                        conduta: attr.conduct ?? null
                    }
                );
                stats.relacoes++;
            } else if (isBanConditionAttr(attr)) {
                await q(
                    `MATCH (p:Produto { nome: $nome })
                     MERGE (c:Proibicao { produto: $nome, condicao: $condicao })
                     SET c.excecao = $excecao
                     MERGE (p)-[:PROIBIDO_EM]->(c)`,
                    {
                        nome: product.name,
                        condicao: attr.condition,
                        excecao: attr.exception ?? null
                    }
                );
                stats.relacoes++;
            }
        }
    }

    // ----------------------------------------------------------------- culturas
    for (const culture of model.elements.filter(isCultureDef)) {
        await q(`MERGE (c:Cultura { nome: $nome }) SET c.ciclo = $ciclo`, {
            nome: culture.name,
            ciclo: culture.cycle
        });
        stats.culturas++;

        const vetorCultura = await embedOpcional(`${culture.name}, ciclo ${culture.cycle ?? ''}`.trim());
        if (vetorCultura) {
            await q(`MATCH (c:Cultura { nome: $nome }) SET c.embedding = $vetor`, {
                nome: culture.name,
                vetor: vetorCultura
            });
        }

        for (const attr of culture.attributes) {
            if (isAgroRecommendAttr(attr)) {
                await q(
                    `MATCH (c:Cultura { nome: $cultura })
                     MERGE (p:Produto { nome: $produto })
                     MERGE (c)-[r:RECOMENDA]->(p) SET r.indicacao = $indicacao`,
                    {
                        cultura: culture.name,
                        produto: attr.product.$refText,
                        indicacao: attr.indication ?? null
                    }
                );
                stats.relacoes++;
            } else if (isAgroForbidAttr(attr)) {
                await q(
                    `MATCH (c:Cultura { nome: $cultura })
                     MERGE (p:Produto { nome: $produto })
                     MERGE (c)-[r:VETA]->(p) SET r.motivo = $motivo`,
                    {
                        cultura: culture.name,
                        produto: attr.product.$refText,
                        motivo: attr.reason
                    }
                );
                stats.relacoes++;
            } else if (isTriggerAttr(attr)) {
                await q(
                    `MATCH (c:Cultura { nome: $cultura })
                     MERGE (g:Gatilho { cultura: $cultura, parametro: $parametro,
                                        operador: $operador, valor: $valor })
                     SET g.acao = $acao, g.unidade = $unidade
                     MERGE (c)-[:DISPARA]->(g)`,
                    {
                        cultura: culture.name,
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
                    `MATCH (c:Cultura { nome: $cultura })
                     MERGE (e:Escalonamento { cultura: $cultura, parametro: $parametro,
                                              operador: $operador, valor: $valor })
                     SET e.destino = $destino, e.detalhe = $detalhe
                     MERGE (c)-[:ESCALONA]->(e)`,
                    {
                        cultura: culture.name,
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

    // -------------------------------------------------------------------- areas
    for (const area of model.elements.filter(isAreaDef)) {
        await q(`MERGE (a:Area { nome: $nome }) SET a.criterio = $criterio`, {
            nome: area.name,
            criterio: area.criterion
        });
        stats.areas++;

        for (const restriction of area.restrictions) {
            if (isAreaForbid(restriction)) {
                await q(
                    `MATCH (a:Area { nome: $area })
                     MERGE (p:Produto { nome: $produto })
                     MERGE (a)-[r:PROIBE]->(p) SET r.motivo = $motivo`,
                    {
                        area: area.name,
                        produto: restriction.product.$refText,
                        motivo: restriction.reason
                    }
                );
                stats.relacoes++;
            } else if (isAreaAdjust(restriction)) {
                await q(
                    `MATCH (a:Area { nome: $area })
                     MERGE (p:Produto { nome: $produto })
                     MERGE (a)-[r:AJUSTA]->(p) SET r.fator = $fator, r.motivo = $motivo`,
                    {
                        area: area.name,
                        produto: restriction.product.$refText,
                        fator: restriction.factor,
                        motivo: restriction.reason ?? null
                    }
                );
                stats.relacoes++;
            } else if (isAreaRequire(restriction)) {
                await q(
                    `MATCH (a:Area { nome: $area })
                     MERGE (e:Exigencia { texto: $texto })
                     MERGE (a)-[:EXIGE]->(e)`,
                    { area: area.name, texto: restriction.requirement }
                );
                stats.relacoes++;
            }
        }
    }

    // ------------------------------------------------ invariantes de seguranca
    for (const element of model.elements) {
        if (isAgroBlockRule(element)) {
            await q(
                `MERGE (p:Produto { nome: $produto })
                 MERGE (r:RegraSeguranca { produto: $produto, parametro: $parametro,
                                           operador: $operador, limiar: $limiar })
                 SET r.razao = $razao, r.unidade = $unidade
                 MERGE (r)-[:BLOQUEIA]->(p)`,
                {
                    produto: element.product.$refText,
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
        if (!isAgroSchemaDef(element)) continue;
        await q(
            `MERGE (e:EsquemaDados { nome: $nome })
             SET e.decisoes = $decisoes, e.modos = $modos, e.alertas = $alertas`,
            {
                nome: element.name,
                decisoes: [...element.decisions],
                modos: [...element.modes],
                alertas: [...element.alerts]
            }
        );
        for (const conduct of element.conducts) {
            await q(
                `MATCH (e:EsquemaDados { nome: $esquema })
                 MERGE (c:Conduta { nome: $nome })
                 SET c.decisao = $decisao, c.modo = $modo, c.duplaChecagem = $duplaChecagem
                 MERGE (e)-[:PERMITE]->(c)`,
                {
                    esquema: element.name,
                    nome: conduct.name,
                    decisao: conduct.decision,
                    modo: conduct.mode ?? null,
                    duplaChecagem: conduct.doubleCheck === 'sim'
                }
            );
            stats.condutas++;
            stats.relacoes++;
        }
    }

    // Indice vetorial para a recuperacao por embedding (ver graphrag-agro.ts::retrieverFocoAgro).
    try {
        await q(
            `CREATE VECTOR INDEX produto_embedding IF NOT EXISTS
             FOR (p:Produto) ON (p.embedding)
             OPTIONS { indexConfig: { \`vector.dimensions\`: ${EMBED_DIMENSOES}, \`vector.similarity_function\`: 'cosine' } }`,
            {}
        );
        await q(
            `CREATE VECTOR INDEX cultura_embedding IF NOT EXISTS
             FOR (c:Cultura) ON (c.embedding)
             OPTIONS { indexConfig: { \`vector.dimensions\`: ${EMBED_DIMENSOES}, \`vector.similarity_function\`: 'cosine' } }`,
            {}
        );
    } catch (error) {
        console.warn(`   (indice vetorial nao pode ser criado: ${(error as Error).message})`);
    }

    return stats;
}

async function main(): Promise<void> {
    const modelPath = process.argv[2] ?? path.join('src', 'examples', 'lavoura.agro');
    const model = await loadAgroModel(modelPath);

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
        const stats = await syncAgroModel(session, model);
        console.log('Sincronizacao concluida:');
        console.log(`  Produtos:  ${stats.produtos}`);
        console.log(`  Culturas:  ${stats.culturas}`);
        console.log(`  Areas:     ${stats.areas}`);
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
