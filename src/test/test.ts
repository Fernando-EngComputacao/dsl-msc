import { createDSLServices } from '../language/dsl-module.js';
import { EmptyFileSystem } from 'langium';
import { URI } from 'vscode-uri';
// ✅ Importamos o novo nó raiz e os Type Guards da nova gramática agrícola
import { AgroModel, isCropDef, isGlobalRule, isMissionCommand } from '../generated/ast.js';

async function run() {
    const { shared } = createDSLServices(EmptyFileSystem);

    // 1. O código na nova linguagem do Drone Agrícola (baseado no PDF)
    const dslCode = `
        cultura Soja {
            herbicida Glifosato - "1.5-2.0 L/ha" - "pós-emergência"
            fungicida Mancozebe - "1.5 kg/ha" - "preventivo ferrugem"
            inseticida Acefato - "0.6 kg/ha" - "lagartas"

            regra: nao_misturar Glifosato + "Mancozebe" ("precipitação")
            regra_clima: "06h-09h ou 17h-19h (T < 30C, vento < 10 km/h)"
        }

        cultura Cana_de_Acucar {
            herbicida Dois_Quatro_D - "1.0-2.0 L/ha" - "pós-emergência"
            fungicida Azoxistrobina - "0.2 L/ha" - "ferrugem laranja"
            
            regra: proibido "perto de culturas sensíveis (uva, maçã, oliveira)"
            regra_varredura: "Sensor temperatura foliar" > 38.0 -> "estresse hídrico"
        }

        regra_global: "Limpar tanque do drone entre culturas diferentes"

        comando aplicar Soja, Cana_de_Acucar usando DroneAgricola01
    `;

    const document = shared.workspace.LangiumDocumentFactory.fromString(
        dslCode,
        URI.parse('file:///tmp/agro_test.dsl')
    );

    // 2. Constrói o documento para o Langium ligar as referências cruzadas
    await shared.workspace.DocumentBuilder.build([document], { validation: true });

    // 3. Verificação de erros na DSL
    const errors = (document.diagnostics ?? []).filter(e => e.severity === 1);
    if (errors.length > 0) {
        console.error('❌ Erros encontrados no código da DSL Agrícola:');
        for (const err of errors) {
            console.error(`   - Linha ${err.range.start.line + 1}: ${err.message}`);
        }
        process.exit(1);
    }

    // 4. Cast para o novo nó raiz: AgroModel
    const model = document.parseResult.value as AgroModel;

    console.log('=== MODELO AST (AGRO DRONE) ===');
    console.log('Tipo Raiz:', model.$type);
    console.log(`Quantidade Total de Elementos: ${model.elements?.length ?? 0}`);

    console.log('\n=== CULTURAS E REGRAS GLOBAIS CADASTRADAS ===');
    
    // Iteramos sobre todos os elementos da raiz (Culturas, Regras Globais, Comandos)
    for (const el of model.elements || []) {
        
        if (isCropDef(el)) {
            console.log(`\n🌱 CULTURA REGISTRADA: ${el.name}`);
            
            console.log('   🧪 Produtos Químicos:');
            for (const chem of el.chemicals || []) {
                console.log(`      - [${chem.type.toUpperCase()}] ${chem.name}: Dose ${chem.dosage} (${chem.timing})`);
            }

            console.log('   ⚠️ Regras da Cultura:');
            for (const rule of el.rules || []) {
                console.log(`      - Regra do tipo [${rule.$type}] identificada.`);
            }
        } 
        
        else if (isGlobalRule(el)) {
            console.log(`\n🌍 REGRA GLOBAL: "${el.description}"`);
        } 
        
        else if (isMissionCommand(el)) {
            // Como as culturas são referências cruzadas ([CropDef:ID]), acessamos o nome real usando '.ref?.name'
            const nomesCulturas = el.crops.map(c => c.ref?.name).join(', ');
            console.log(`\n🚁 COMANDO DE MISSÃO:`);
            console.log(`   - Drone designado: ${el.drone}`);
            console.log(`   - Aplicar nas culturas: [${nomesCulturas}]`);
        }
    }
}

run();