import neo4j from 'neo4j-driver';
import { createDSLServices } from '../language/dsl-module.js';
import { EmptyFileSystem } from 'langium';
import { URI } from 'vscode-uri';
import { MissionControl, isDroneDef, isFarmDef, isScanCommand } from '../generated/ast.js';

// ✅ Conexão com o Neo4j
const driver = neo4j.driver(
    'bolt://localhost:7687',
    neo4j.auth.basic('neo4j', '#Infufg2025') // Coloque sua senha correta
);

async function run() {
    const { shared } = createDSLServices(EmptyFileSystem);

    // 1. O código na nova linguagem do Drone
    const dslCode = `
        drone Alpha01 energy_limit 80%
        farm Fazenda_Vale_Verde
        farm Fazenda_Sol_Nascente

        command scan Fazenda_Vale_Verde, Fazenda_Sol_Nascente using Alpha01

        on_sensor_input dirt_level > 35 % do clean_panels
        on_sensor_input weather storm do return_to_base
        on_sensor_input smoke_detected fire do send_5G_alert to_current_farm urgency_high with_photo
    `;

    const document = shared.workspace.LangiumDocumentFactory.fromString(
        dslCode,
        URI.parse('file:///tmp/missao.dsl')
    );

    // 2. ⚠️ IMPORTANTE: Constrói o documento para o Langium ligar as referências cruzadas (ex: "using Alpha01")
    await shared.workspace.DocumentBuilder.build([document], { validation: true });

    // 3. Verificação de erros sintáticos
    if (document.parseResult.lexerErrors.length > 0 || document.parseResult.parserErrors.length > 0) {
        console.error('❌ Erro de sintaxe na sua DSL. Corrija o código antes de rodar.');
        return; 
    }

    // 4. Cast para o novo nó raiz da nossa AST
    const model = document.parseResult.value as MissionControl;

    // 5. Iniciando a sessão do Neo4j
    const session = driver.session();

    try {
        console.log('🔄 Sincronizando com o Neo4j...\n');

        // --- A) SALVANDO DEFINIÇÕES (DRONES E FAZENDAS) ---
        for (const def of model.definitions || []) {
            if (isDroneDef(def)) {
                await session.run(
                    'MERGE (d:Drone {name: $name}) SET d.energy_limit = $battery',
                    { name: def.name, battery: def.battery }
                );
                console.log(`🚁 Drone salvo: ${def.name}`);
            } 
            else if (isFarmDef(def)) {
                await session.run(
                    'MERGE (f:Farm {name: $name})',
                    { name: def.name }
                );
                console.log(`🌾 Fazenda salva: ${def.name}`);
            } 
            else if (isScanCommand(def)) {
                // --- B) SALVANDO O RELACIONAMENTO DE MISSÃO ---
                const droneName = def.drone.ref?.name;
                
                if (droneName) {
                    for (const farmRef of def.farms) {
                        const farmName = farmRef.ref?.name;
                        if (farmName) {
                            // Cria uma seta no grafo ligando o Drone à Fazenda
                            await session.run(`
                                MATCH (d:Drone {name: $drone})
                                MATCH (f:Farm {name: $farm})
                                MERGE (d)-[:ASSIGNED_TO_SCAN]->(f)
                            `, { drone: droneName, farm: farmName });
                            console.log(`🔗 Missão ligada: [${droneName}] -> [${farmName}]`);
                        }
                    }
                }
            }
        }

        // --- C) SALVANDO AS REGRAS DE VOO AUTÔNOMO ---
        console.log('\n🧠 Salvando regras autônomas...');
        for (const rule of model.rules || []) {
            const eventoType = rule.event.$type;
            const acaoType = rule.action.$type;

            // Cria um nó de Regra Genérica no Neo4j para o nosso Semantic Engine consultar depois
            await session.run(`
                CREATE (r:Rule {
                    event_type: $evento,
                    action_type: $acao
                })
            `, { evento: eventoType, acao: acaoType });
            
            console.log(`⚡ Regra salva: SE [${eventoType}] ENTÃO [${acaoType}]`);
        }

        console.log('\n✅ Grafo construído com sucesso no Neo4j!');

    } catch (error) {
        console.error('❌ Erro ao salvar no Neo4j:', error);
    } finally {
        await session.close();
        await driver.close();
    }
}

run();