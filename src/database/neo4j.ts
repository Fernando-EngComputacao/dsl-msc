import neo4j from 'neo4j-driver';
import { createDSLServices } from '../language/dsl-module.js';
import { EmptyFileSystem } from 'langium';
import { URI } from 'vscode-uri';
import {
    DirtEvent,
    MessageAction,
    MissionControl,
    Rule,
    SimpleAction,
    SmokeEvent,
    WeatherEvent,
    isDroneDef,
    isFarmDef,
    isScanCommand
} from '../generated/ast.js';

const driver = neo4j.driver(
    'bolt://localhost:7687',
    neo4j.auth.basic('neo4j', '#Infufg2025')
);

type GraphNodeData = {
    label: 'DirtEvent' | 'SmokeEvent' | 'WeatherEvent' | 'MessageAction' | 'SimpleAction';
    description: string;
    properties: Record<string, string | number | boolean>;
};

function buildEventData(rule: Rule): GraphNodeData {
    const event = rule.event;

    if (event.$type === 'WeatherEvent') {
        const weatherEvent = event as WeatherEvent;
        return {
            label: 'WeatherEvent',
            description: `weather ${weatherEvent.condition}`,
            properties: {
                condition: weatherEvent.condition
            }
        };
    }

    if (event.$type === 'SmokeEvent') {
        const smokeEvent = event as SmokeEvent;
        return {
            label: 'SmokeEvent',
            description: `smoke_detected ${smokeEvent.type}`,
            properties: {
                smoke_type: smokeEvent.type
            }
        };
    }

    const dirtEvent = event as DirtEvent;
    return {
        label: 'DirtEvent',
        description: `dirt_level ${dirtEvent.operator} ${dirtEvent.level}%`,
        properties: {
            operator: dirtEvent.operator,
            level: dirtEvent.level
        }
    };
}

function buildActionData(rule: Rule): GraphNodeData {
    const action = rule.action;

    if (action.$type === 'MessageAction') {
        const messageAction = action as MessageAction;
        return {
            label: 'MessageAction',
            description: `send_5G_alert${messageAction.includePhoto ? ' with_photo' : ''}`,
            properties: {
                include_photo: messageAction.includePhoto
            }
        };
    }

    const simpleAction = action as SimpleAction;
    return {
        label: 'SimpleAction',
        description: simpleAction.command,
        properties: {
            command: simpleAction.command
        }
    };
}

async function run() {
    const { shared } = createDSLServices(EmptyFileSystem);

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

    await shared.workspace.DocumentBuilder.build([document], { validation: true });

    if (document.parseResult.lexerErrors.length > 0 || document.parseResult.parserErrors.length > 0) {
        console.error('Erro de sintaxe na DSL. Corrija o codigo antes de executar.');
        return;
    }

    const model = document.parseResult.value as MissionControl;
    const session = driver.session();

    try {
        console.log('Sincronizando com o Neo4j...');

        await session.run(`
            CREATE CONSTRAINT rule_node_id IF NOT EXISTS
            FOR (r:Rule)
            REQUIRE r.node_id IS UNIQUE
        `);
        await session.run(`
            CREATE CONSTRAINT event_node_id IF NOT EXISTS
            FOR (e:Event)
            REQUIRE e.node_id IS UNIQUE
        `);
        await session.run(`
            CREATE CONSTRAINT action_node_id IF NOT EXISTS
            FOR (a:Action)
            REQUIRE a.node_id IS UNIQUE
        `);
        await session.run(`
            CREATE INDEX rule_index IF NOT EXISTS
            FOR (r:Rule)
            ON (r.rule_index)
        `);

        for (const def of model.definitions || []) {
            if (isDroneDef(def)) {
                await session.run(
                    `
                    MERGE (d:Drone {name: $name})
                    SET d.node_id = $nodeId,
                        d.energy_limit = $battery
                    `,
                    {
                        name: def.name,
                        nodeId: `drone:${def.name}`,
                        battery: def.battery
                    }
                );
                console.log(`Drone salvo: ${def.name}`);
            } else if (isFarmDef(def)) {
                await session.run(
                    `
                    MERGE (f:Farm {name: $name})
                    SET f.node_id = $nodeId
                    `,
                    {
                        name: def.name,
                        nodeId: `farm:${def.name}`
                    }
                );
                console.log(`Farm salva: ${def.name}`);
            } else if (isScanCommand(def)) {
                const droneName = def.drone.ref?.name;

                if (droneName) {
                    for (const farmRef of def.farms) {
                        const farmName = farmRef.ref?.name;
                        if (farmName) {
                            await session.run(
                                `
                                MATCH (d:Drone {name: $drone})
                                MATCH (f:Farm {name: $farm})
                                MERGE (d)-[:ASSIGNED_TO_SCAN]->(f)
                                `,
                                { drone: droneName, farm: farmName }
                            );
                            console.log(`Missao ligada: [${droneName}] -> [${farmName}]`);
                        }
                    }
                }
            }
        }

        console.log('Salvando regras autonomas...');

        for (const [index, rule] of (model.rules || []).entries()) {
            const ruleIndex = index + 1;
            const ruleNodeId = `rule:${ruleIndex}`;
            const eventNodeId = `${ruleNodeId}:event`;
            const actionNodeId = `${ruleNodeId}:action`;
            const eventData = buildEventData(rule);
            const actionData = buildActionData(rule);

            await session.run(
                `
                MERGE (r:Rule {node_id: $ruleNodeId})
                SET r.rule_index = $ruleIndex,
                    r.name = $ruleName,
                    r.event_type = $eventType,
                    r.event_description = $eventDescription,
                    r.action_type = $actionType,
                    r.action_description = $actionDescription
                MERGE (e:Event {node_id: $eventNodeId})
                SET e.name = $eventName,
                    e.label = $eventLabel,
                    e.kind = $eventType,
                    e.description = $eventDescription
                SET e += $eventProperties
                MERGE (a:Action {node_id: $actionNodeId})
                SET a.name = $actionName,
                    a.label = $actionLabel,
                    a.kind = $actionType,
                    a.description = $actionDescription
                SET a += $actionProperties
                MERGE (r)-[:TRIGGERS_ON]->(e)
                MERGE (r)-[:EXECUTES]->(a)
                MERGE (e)-[:LEADS_TO]->(a)
                `,
                {
                    ruleNodeId,
                    ruleIndex,
                    ruleName: `Rule ${ruleIndex}`,
                    eventNodeId,
                    eventLabel: eventData.label,
                    eventName: `Event ${ruleIndex}`,
                    eventType: rule.event.$type,
                    eventDescription: eventData.description,
                    eventProperties: eventData.properties,
                    actionNodeId,
                    actionLabel: actionData.label,
                    actionName: `Action ${ruleIndex}`,
                    actionType: rule.action.$type,
                    actionDescription: actionData.description,
                    actionProperties: actionData.properties
                }
            );

            console.log(`Regra ${ruleIndex} salva: SE [${rule.event.$type}] ENTAO [${rule.action.$type}]`);
        }

        console.log('Grafo construido com sucesso no Neo4j.');
    } catch (error) {
        console.error('Erro ao salvar no Neo4j:', error);
    } finally {
        await session.close();
        await driver.close();
    }
}

run();
