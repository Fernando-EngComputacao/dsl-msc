import { createDSLServices } from '../language/dsl-module';
import { EmptyFileSystem } from 'langium';

async function run() {
    const services = createDSLServices(EmptyFileSystem);

    const text = `reserve sala1 at "10:00"`;

    const document = services.shared.workspace.LangiumDocumentFactory.fromString(
        text,
        services.DSL.LanguageMetaData.fileExtensions[0]
    );

    await services.shared.workspace.DocumentBuilder.build([document]);

    const model = document.parseResult.value;

    console.log("AST:");
    console.dir(model, { depth: null });

    for (const r of model.elements) {
        console.log(`📅 Reserva: ${r.resource} às ${r.time}`);
    }
}

run();