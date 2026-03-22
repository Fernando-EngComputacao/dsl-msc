"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const dsl_module_1 = require("../language/dsl-module");
const langium_1 = require("langium");
async function run() {
    const services = (0, dsl_module_1.createDSLServices)(langium_1.EmptyFileSystem);
    const text = `reserve sala1 at "10:00"`;
    const document = services.shared.workspace.LangiumDocumentFactory.fromString(text, services.DSL.LanguageMetaData.fileExtensions[0]);
    await services.shared.workspace.DocumentBuilder.build([document]);
    const model = document.parseResult.value;
    console.log("AST:");
    console.dir(model, { depth: null });
    for (const r of model.elements) {
        console.log(`📅 Reserva: ${r.resource} às ${r.time}`);
    }
}
run();
