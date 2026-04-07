import neo4j from 'neo4j-driver';
import { createDSLServices } from '../language/dsl-module.js';
import { EmptyFileSystem } from 'langium';
import { URI } from 'vscode-uri';
import { AgroModel, isCropDef, isGlobalRule, isMissionCommand } from '../generated/ast.js';
import { pipeline } from '@xenova/transformers';

// Conexão com o Grafo de Conhecimento
const driver = neo4j.driver(
    'bolt://localhost:7687',
    neo4j.auth.basic('neo4j', '#Infufg2025') 
);

async function run() {
    const { shared } = createDSLServices(EmptyFileSystem);

    // 1. Código DSL baseado nas regras do diagrama do Agrônomo
    const dslCode = `
        cultura Soja {
            herbicida Glifosato - "1.5-2.0 L/ha" - "pós-emergência"
            fungicida Mancozebe - "1.5 kg/ha" - "preventivo ferrugem"
            inseticida Acefato - "0.6 kg/ha" - "lagartas"

            regra: nao_misturar Glifosato + "Mancozebe" ("precipitação")
            regra: nao_misturar Acefato + "Nicosulfuron" ("fitotoxicidade")
            regra_clima: "06h-09h ou 17h-19h (T < 30C, vento < 10 km/h)"
            regra_varredura: "Indice NDVI" < 0.4 -> "alerta pragas"
            informar: "Area afetada (ha), produto aplicado, hora, sensor NDVI"
        }

        cultura Cana_de_Acucar {
            herbicida Dois_Quatro_D - "1.0-2.0 L/ha" - "pós-emergência"
            fungicida Azoxistrobina - "0.2 L/ha" - "ferrugem laranja"
            inseticida Imidacloprido - "0.5 L/ha" - "broca-da-cana"

            regra: nao_misturar Dois_Quatro_D + "Atrazina" ("deriva hormonal")
            regra: proibido "perto de culturas sensíveis (uva, maçã, oliveira)"
            regra_clima: "Vento < 10 km/h; T < 32C; umidade > 55%; sem previsão de chuva 8h"
            regra_varredura: "Sensor temperatura foliar" > 38.0 -> "estresse hídrico"
            informar: "Coordenada GPS, produto, vazão (L/ha), condição climática"
        }

        regra_global: "Limpar tanque do drone entre culturas diferentes"
        regra_global: "Nunca aplicar simultaneamente em talhões adjacentes com ventos > 8 km/h se culturas diferentes"

        comando aplicar Soja, Cana_de_Acucar usando DroneAgricola01
    `;

    const document = shared.workspace.LangiumDocumentFactory.fromString(dslCode, URI.parse('file:///tmp/agro.dsl'));
    await shared.workspace.DocumentBuilder.build([document], { validation: true });

    if (document.parseResult.lexerErrors.length > 0 || document.parseResult.parserErrors.length > 0) {
        console.error('❌ Erro de sintaxe na DSL Agrícola.');
        return; 
    }

    const model = document.parseResult.value as AgroModel;
    const session = driver.session();

    console.log('⏳ Carregando modelo IA para vetores (Embeddings)...');
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

    try {
        console.log('🔄 Sincronizando Grafo de Conhecimento Agrícola no Neo4j...\n');

        // Cria índice vetorial para buscas semânticas nas regras
        await session.run(`
            CREATE VECTOR INDEX agro_rules_index IF NOT EXISTS
            FOR (r:Rule)
            ON (r.embedding)
            OPTIONS {indexConfig: {
                \`vector.dimensions\`: 384,
                \`vector.similarity_function\`: 'cosine'
            }}
        `);

        // Percorre a AST
        for (const el of model.elements || []) {
            
            // --- A) SALVANDO SUBGRAFOS DE CULTURAS E SEUS PRODUTOS ---
            if (isCropDef(el)) {
                await session.run('MERGE (c:Crop {name: $name})', { name: el.name });
                console.log(`🌱 Cultura registrada: ${el.name}`);

                // Produtos Químicos da Cultura
                for (const chem of el.chemicals || []) {
                    await session.run(`
                        MATCH (c:Crop {name: $cropName})
                        MERGE (chem:Chemical {name: $chemName, type: $type})
                        SET chem.dosage = $dosage, chem.timing = $timing
                        MERGE (c)-[:USES_CHEMICAL]->(chem)
                    `, { cropName: el.name, chemName: chem.name, type: chem.type, dosage: chem.dosage, timing: chem.timing });
                }

                // Regras Locais da Cultura (Com Embedding)
                for (const rule of el.rules || []) {
                    let ruleDescription = `Regra para ${el.name}: `;
                    
                    if (rule.$type === 'MixingRule') ruleDescription += `Não misturar ${rule.chem1.ref?.name} com ${rule.chem2} devido a ${rule.reason}`;
                    if (rule.$type === 'BanRule') ruleDescription += `Proibido aplicar ${rule.condition}`;
                    if (rule.$type === 'WeatherRule') ruleDescription += `Condições climáticas exigidas: ${rule.conditions}`;
                    if (rule.$type === 'SweepRule') ruleDescription += `Se ${rule.sensor} ${rule.operator} ${rule.value}, indica ${rule.action}`;
                    
                    // Gera o Embedding Matemático
                    const output = await extractor(ruleDescription, { pooling: 'mean', normalize: true });
                    const vetor = Array.from(output.data);

                    await session.run(`
                        MATCH (c:Crop {name: $cropName})
                        CREATE (r:Rule {
                            type: $ruleType,
                            description: $desc,
                            embedding: $vetor
                        })
                        MERGE (c)-[:HAS_RULE]->(r)
                    `, { cropName: el.name, ruleType: rule.$type, desc: ruleDescription, vetor: vetor });
                }
            } 
            
            // --- B) SALVANDO REGRAS GLOBAIS ---
            else if (isGlobalRule(el)) {
                const output = await extractor(el.description, { pooling: 'mean', normalize: true });
                const vetor = Array.from(output.data);

                await session.run(`
                    CREATE (r:Rule:GlobalRule {
                        description: $desc,
                        embedding: $vetor
                    })
                `, { desc: el.description, vetor: vetor });
                console.log(`🌍 Regra Global registrada e vetorizada.`);
            }

            // --- C) SALVANDO O COMANDO DE MISSÃO ---
            else if (isMissionCommand(el)) {
                for (const cropRef of el.crops) {
                    if (cropRef.ref?.name) {
                        await session.run(`
                            MERGE (d:Drone {name: $drone})
                            MATCH (c:Crop {name: $crop})
                            MERGE (d)-[:ASSIGNED_TO_APPLY]->(c)
                        `, { drone: el.drone, crop: cropRef.ref.name });
                        console.log(`🚁 Drone [${el.drone}] assinalado para [${cropRef.ref.name}]`);
                    }
                }
            }
        }

        console.log('\n✅ Grafo Agrícola e Embeddings construídos com sucesso no Neo4j!');

    } catch (error) {
        console.error('❌ Erro ao salvar no Neo4j:', error);
    } finally {
        await session.close();
        await driver.close();
    }
}

run();