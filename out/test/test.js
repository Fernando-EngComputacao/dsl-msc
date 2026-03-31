import { createDSLServices } from '../language/dsl-module.js'; // Mantenha o nome do seu módulo
import { EmptyFileSystem } from 'langium';
import { URI } from 'vscode-uri';
// ✅ Importamos o novo nó raiz e os Type Guards (verificadores de tipo) que o Langium gerou
import { isDroneDef, isFarmDef, isScanCommand } from '../generated/ast.js';
async function run() {
    const { shared, DSL } = createDSLServices(EmptyFileSystem);
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
    const document = shared.workspace.LangiumDocumentFactory.fromString(dslCode, URI.parse('file:///tmp/missao.dsl'));
    // 2. ⚠️ IMPORTANTE: Precisamos "construir" o documento para o Langium ligar as referências cruzadas
    await shared.workspace.DocumentBuilder.build([document], { validation: true });
    // 3. Verificação de erros na DSL
    const errors = (document.diagnostics ?? []).filter(e => e.severity === 1);
    if (errors.length > 0) {
        console.error('❌ Erros encontrados no código do drone:');
        for (const err of errors) {
            console.error(`   - Linha ${err.range.start.line + 1}: ${err.message}`);
        }
        process.exit(1);
    }
    // 4. Cast para o novo nó raiz: MissionControl
    const model = document.parseResult.value;
    console.log('=== MODELO AST (DRONE) ===');
    console.log('Tipo Raiz:', model.$type);
    console.log(`Quantidade de Definições: ${model.definitions?.length ?? 0}`);
    console.log(`Quantidade de Regras: ${model.rules?.length ?? 0}`);
    console.log('\n=== ENTIDADES E COMANDOS CADASTRADOS ===');
    // Iteramos sobre a lista de definições (Drones, Fazendas e Comandos)
    for (const def of model.definitions || []) {
        if (isDroneDef(def)) {
            console.log(`🚁 Drone Registrado: ${def.name} | Bateria mínima: ${def.battery}%`);
        }
        else if (isFarmDef(def)) {
            console.log(`🌾 Fazenda Registrada: ${def.name}`);
        }
        else if (isScanCommand(def)) {
            // Como as fazendas e drones são referências ([FarmDef:ID]), acessamos o objeto real usando '.ref'
            const nomesFazendas = def.farms.map(f => f.ref?.name).join(', ');
            const nomeDrone = def.drone.ref?.name;
            console.log(`📡 COMANDO DE MISSÃO: Drone [${nomeDrone}] fará varredura em: [${nomesFazendas}]`);
        }
    }
    console.log('\n=== REGRAS DE VOO AUTÔNOMO ===');
    // Iteramos sobre as regras de sensores
    for (const rule of model.rules || []) {
        const evento = rule.event;
        const acao = rule.action;
        // O Langium salva o tipo exato do nó no atributo $type
        console.log(`⚠️  Regra configurada:`);
        console.log(`   - SE identificar: [${evento.$type}]`);
        console.log(`   - ENTÃO executar: [${acao.$type}]`);
    }
}
run();
