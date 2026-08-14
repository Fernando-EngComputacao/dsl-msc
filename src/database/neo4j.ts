import neo4j from 'neo4j-driver';
import { createDSLServices } from '../language/dsl-module.js';
import { EmptyFileSystem } from 'langium';
import { URI } from 'vscode-uri';
import { MedicalModel, isDrugDef, isSafetyRule } from '../generated/ast.js';
import * as fs from 'fs';
import * as path from 'path';

// ⚠️ Lembre de verificar se esta é a senha correta do seu ambiente local
const driver = neo4j.driver(
    'bolt://localhost:7687',
    neo4j.auth.basic('neo4j', '#UFG2026')
);

async function run() {
    const { shared } = createDSLServices(EmptyFileSystem);
    
    // Captura o arquivo da linha de comando ou vai no padrão
    const filePath = path.join(process.cwd(), 'src', 'examples', 'uti.dsl');
    
    if (!fs.existsSync(filePath)) {
        console.error(`❌ Erro: Arquivo físico não encontrado em: ${filePath}`);
        process.exit(1);
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');

    const document = shared.workspace.LangiumDocumentFactory.fromString(
        fileContent,
        URI.parse(`file:///${filePath.replace(/\\/g, '/')}`)
    );

    // Proteção essencial: Evita popular o banco de dados se a DSL estiver mal escrita
    if (document.parseResult.parserErrors.length > 0) {
        console.error('❌ Erros de sintaxe encontrados na DSL! Abortando injeção no Neo4j.');
        document.parseResult.parserErrors.forEach(err => console.error(` - ${err.message}`));
        process.exit(1);
    }

    // ✅ Type casting rigoroso graças aos tipos gerados pelo Langium
    const model = document.parseResult.value as MedicalModel; 
    const session = driver.session();

    try {
        console.log(`🗄️ Lendo arquivo: ${path.basename(filePath)} e injetando no Neo4j...`);
        
        for (const e of model.elements) {
            
            if (isDrugDef(e)) {
                await session.run(
                    `MERGE (f:Farmaco { nome: $name })
                     SET f.tipo = $type, 
                         f.maxDose = $maxDose, 
                         f.maxDoseUnit = $maxDoseUnit, 
                         f.step = $safeStep, 
                         f.stepUnit = $safeStepUnit`,
                    { 
                        name: e.name, 
                        type: e.type, 
                        maxDose: e.maxDose, 
                        maxDoseUnit: e.maxDoseUnit, 
                        safeStep: e.safeStep, 
                        safeStepUnit: e.safeStepUnit 
                    }
                );
                console.log(`  💊 Fármaco registrado/atualizado: ${e.name}`);
                
            } else if (isSafetyRule(e)) {
                await session.run(
                    `MATCH (f:Farmaco {nome: $drugName})
                     MERGE (r:RegraSeguranca { condicao: $condition, razao: $reason })
                     MERGE (r)-[:BLOQUEIA_INCREMENTO]->(f)`,
                    { 
                        drugName: e.drug.$refText, 
                        condition: e.condition, 
                        reason: e.reason 
                    }
                );
                console.log(`  🛑 Regra registrada: bloqueio de ${e.drug.$refText} (Condição: ${e.condition})`);
            }
        }
        console.log("🚀 Sincronização do Conhecimento Médico concluída com sucesso!");
    } catch (error) {
        console.error("❌ Falha crítica na transação com Neo4j:", error);
    } finally {
        await session.close();
        await driver.close();
    }
}

run();