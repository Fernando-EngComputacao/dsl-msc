/**
 * Gera `src/python_engine/grammar/advanced_icu.bnf` a partir da DSL local.
 *
 * Uso:
 *   npx tsx src/cli/export-bnf.ts [modelo.dsl] [saida.bnf]
 *
 * Depois deste passo, a BNF deixa de ser um artefato mantido a mao: ela e um
 * derivado verificavel da gramatica Langium mais o modelo do especialista.
 */

import { EmptyFileSystem } from 'langium';
import { URI } from 'vscode-uri';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDSLServices } from '../language/dsl-module.js';
import type { MedicalModel } from '../generated/ast.js';
import { extractOutputBnf } from '../grammar/extract-bnf.js';
import { buildVocabularies, type VocabularyOptions } from '../grammar/vocabularies.js';

export interface ExportResult {
    bnf: string;
    ruleCount: number;
    drugCount: number;
    conductCount: number;
}

export async function exportBnf(
    modelPath: string,
    options: VocabularyOptions = {}
): Promise<ExportResult> {
    const { shared, DSL } = createDSLServices(EmptyFileSystem);
    const content = fs.readFileSync(modelPath, 'utf-8');
    const document = shared.workspace.LangiumDocumentFactory.fromString<MedicalModel>(
        content,
        URI.file(path.resolve(modelPath))
    );
    await shared.workspace.DocumentBuilder.build([document], { validation: true });

    const errors = [
        ...document.parseResult.lexerErrors.map(e => e.message),
        ...document.parseResult.parserErrors.map(e => e.message)
    ];
    if (errors.length > 0) {
        throw new Error(
            `O modelo \`${modelPath}\` tem erros de sintaxe; a BNF nao foi gerada:\n  - ` +
                errors.join('\n  - ')
        );
    }

    const model = document.parseResult.value;
    const { vocabularies, schema, drugs } = buildVocabularies(model, options);
    const doc = extractOutputBnf(DSL.Grammar, vocabularies, 'PlanCommand');

    const header = [
        'GRAMATICA G — Esquema de Dados da DSL clinica (SPC-CML).',
        '',
        'ARQUIVO GERADO AUTOMATICAMENTE — NAO EDITAR A MAO.',
        `Gerado por: src/cli/export-bnf.ts`,
        `Gramatica:  src/language/dsl.langium (regra PlanCommand)`,
        `Modelo:     ${path.basename(modelPath)} (esquema_dados ${schema.name})`,
        '',
        `Farmacos citaveis: ${drugs.length} | Condutas: ${schema.conducts.length} |` +
            ` Decisoes: ${vocabularies.get('decisao')!.length} | Vias: ${vocabularies.get('via')!.length}`,
        '',
        'Toda alternativa desta gramatica corresponde a uma entidade declarada no',
        'modelo do especialista. O que nao esta aqui e inexprimivel pelo LLM.'
    ].join('\n');

    return {
        bnf: doc.serialize(header),
        ruleCount: doc.rules.length,
        drugCount: drugs.length,
        conductCount: schema.conducts.length
    };
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
    const modelPath = process.argv[2] ?? path.join('src', 'examples', 'uti.dsl');
    const outPath =
        process.argv[3] ?? path.join('src', 'python_engine', 'grammar', 'advanced_icu.bnf');

    exportBnf(modelPath)
        .then(result => {
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, result.bnf, 'utf-8');
            console.log(`BNF gerada a partir de ${modelPath}`);
            console.log(
                `  ${result.ruleCount} regras | ${result.drugCount} farmacos | ${result.conductCount} condutas`
            );
            console.log(`  Escrita em: ${outPath}`);
            console.log('\n--- conteudo ---\n');
            console.log(result.bnf);
        })
        .catch(err => {
            console.error('Falha ao gerar a BNF:', err.message);
            process.exit(1);
        });
}
