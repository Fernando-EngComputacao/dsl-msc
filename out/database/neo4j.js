import neo4j from 'neo4j-driver';
import { createDSLServices } from '../language/dsl-module.js';
import { EmptyFileSystem } from 'langium';
import { URI } from 'vscode-uri';
// ✅ Conexão com o Neo4j
const driver = neo4j.driver('bolt://localhost:7687', neo4j.auth.basic('neo4j', 'sua_senha_aqui'));
async function run() {
    const { shared } = createDSLServices(EmptyFileSystem);
    const document = shared.workspace.LangiumDocumentFactory.fromString(`reserve SalaA at "2026-03-22 14:00"
         reserve SalaB at "2026-03-22 16:00"`, URI.parse('file:///tmp/test.dsl'));
    const model = document.parseResult.value;
    const session = driver.session();
    try {
        for (const e of model.elements) {
            await session.run('CREATE (r:Reservation { resource: $resource, time: $time })', { resource: e.resource, time: e.time });
            console.log(`✅ Inserido: ${e.resource} às ${e.time}`);
        }
    }
    finally {
        await session.close();
        await driver.close();
    }
}
run();
