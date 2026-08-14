/**
 * Verificacao sintatica e de referencias cruzadas de um modelo da DSL clinica.
 *
 * Uso: npx tsx src/cli/validate.ts [caminho.dsl]
 *
 * Este e o primeiro portao de qualidade do SPC-CML: nenhum modelo entra no Grafo
 * de Conhecimento nem alimenta o grammar prompting sem passar por aqui.
 */

import { EmptyFileSystem } from 'langium';
import { URI } from 'vscode-uri';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDSLServices } from '../language/dsl-module.js';
import type { MedicalModel } from '../generated/ast.js';

export interface ValidationReport {
    file: string;
    lexerErrors: string[];
    parserErrors: string[];
    linkingErrors: string[];
    model?: MedicalModel;
}

export async function validateFile(filePath: string): Promise<ValidationReport> {
    const { shared } = createDSLServices(EmptyFileSystem);
    const content = fs.readFileSync(filePath, 'utf-8');

    const document = shared.workspace.LangiumDocumentFactory.fromString<MedicalModel>(
        content,
        URI.file(path.resolve(filePath))
    );

    // build() resolve as referencias cruzadas ([DrugDef:ID], [ConductDef:ID], ...),
    // que sao justamente o que impede o LLM de citar um farmaco inexistente.
    await shared.workspace.DocumentBuilder.build([document], { validation: true });

    const linkingErrors: string[] = [];
    for (const ref of document.references) {
        if (ref.error) linkingErrors.push(ref.error.message);
    }

    return {
        file: filePath,
        lexerErrors: document.parseResult.lexerErrors.map(e => e.message),
        parserErrors: document.parseResult.parserErrors.map(e => e.message),
        linkingErrors,
        model: document.parseResult.value
    };
}

function summarize(report: ValidationReport): number {
    const total =
        report.lexerErrors.length + report.parserErrors.length + report.linkingErrors.length;

    console.log(`\nArquivo: ${report.file}`);
    if (total === 0) {
        const model = report.model!;
        console.log('  Sintaxe: OK — 0 erros lexicos, sintaticos e de referencia.');
        console.log(`  Elementos no modelo: ${model.elements.length}`);
        return 0;
    }

    for (const e of report.lexerErrors) console.error(`  [lexico]    ${e}`);
    for (const e of report.parserErrors) console.error(`  [sintaxe]   ${e}`);
    for (const e of report.linkingErrors) console.error(`  [referencia] ${e}`);
    console.error(`  Total de erros: ${total}`);
    return total;
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
    const target = process.argv[2] ?? path.join('src', 'examples', 'uti.dsl');
    validateFile(target)
        .then(report => process.exit(summarize(report) === 0 ? 0 : 1))
        .catch(err => {
            console.error('Falha ao validar:', err);
            process.exit(2);
        });
}
