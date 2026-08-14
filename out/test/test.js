import { createDSLServices } from '../language/dsl-module.js';
import { EmptyFileSystem } from 'langium';
import { URI } from 'vscode-uri';
import { isDrugDef, isSafetyRule } from '../generated/ast.js';
async function run() {
    const { shared } = createDSLServices(EmptyFileSystem);
    // ✅ Teste rápido embutido simulando o cenário da UTI
    const document = shared.workspace.LangiumDocumentFactory.fromString(`farmaco Propofol { tipo "Sedativo" dose_maxima 4.0 "mg/kg/h" incremento_seguro 0.5 "mg/kg/h" }
         regra_seguranca: bloquear_incremento Propofol se "PAM < 60" ("Risco de Hipotensao Severa")`, URI.parse('file:///tmp/test.dsl'));
    // 🛑 Validação para garantir que não existam erros de sintaxe
    if (document.parseResult.parserErrors.length > 0) {
        console.error('❌ Erros de parsing encontrados:');
        for (const err of document.parseResult.parserErrors) {
            console.error(` - ${err.message}`);
        }
        return;
    }
    // ✅ Cast rígido para o tipo gerado pelo langium (Sem "any")
    const model = document.parseResult.value;
    console.log('=== MODELO MÉDICO (AST) ===');
    console.log('Tipo da Raiz:', model.$type);
    console.log('Quantidade de instâncias lidas:', model.elements.length);
    console.log('\n=== DETALHES DAS REGRAS ===');
    for (const el of model.elements) {
        if (isDrugDef(el)) {
            console.log(`💊 Fármaco: ${el.name} | Tipo: ${el.type}`);
            console.log(`   Dose Máxima: ${el.maxDose} ${el.maxDoseUnit}`);
            console.log(`   Incremento:  ${el.safeStep} ${el.safeStepUnit}`);
        }
        else if (isSafetyRule(el)) {
            console.log(`🛑 Regra de Segurança para: ${el.drug.$refText}`);
            console.log(`   Condição de bloqueio: ${el.condition}`);
            console.log(`   Motivo: ${el.reason}`);
        }
    }
}
run();
