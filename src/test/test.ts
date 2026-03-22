import { createDSLServices } from '../language/dsl-module.js';
import { EmptyFileSystem } from 'langium';
import { URI } from 'vscode-uri';
import { Model } from '../generated/ast.js';

async function run() {
    const { shared, DSL } = createDSLServices(EmptyFileSystem);

    const document = shared.workspace.LangiumDocumentFactory.fromString(
        `reserve Sala01 at "20:00"`,
        URI.parse('file:///tmp/test.dsl')
    );

    // ✅ cast para o tipo gerado pelo langium
    const result = document.parseResult;
    const model = document.parseResult.value as Model;

    console.log('=== PARSE RESULT ===');
    console.log(result);
    console.log('=== MODEL ===');
    console.log('Tipo:', model.$type);
    console.log('Quantidade de reservas:', model.elements.length);

    console.log('\n=== RESERVAS ===');
    for (const el of model.elements) {
        console.log(`- Recurso: ${el.resource}`);
        console.log(`  Horário: ${el.time}`);
    }
}

run();