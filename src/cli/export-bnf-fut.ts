/**
 * Gera `src/python_engine/grammar/futebol.bnf` a partir da DSL de arbitragem.
 *
 * Uso:
 *   npx tsx src/cli/export-bnf-fut.ts [futebol.fut] [saida.bnf]
 *
 * Mesmo papel de src/cli/export-bnf.ts e src/cli/export-bnf-agro.ts nos outros
 * dois dominios: a BNF nao e mantida a mao, e um derivado verificavel da
 * gramatica Langium mais o modelo do arbitro.
 */

import { EmptyFileSystem } from 'langium';
import { URI } from 'vscode-uri';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createFutServices } from '../language/fut-module.js';
import type { FutModel } from '../generated/ast.js';
import { extractOutputBnf } from '../grammar/extract-bnf.js';
import { buildFutVocabularies, type FutVocabularyOptions } from '../grammar/vocabularies-fut.js';

export interface FutExportResult {
    bnf: string;
    ruleCount: number;
    infractionCount: number;
    conductCount: number;
}

export async function exportFutBnf(
    modelPath: string,
    options: FutVocabularyOptions = {}
): Promise<FutExportResult> {
    const { shared, Fut } = createFutServices(EmptyFileSystem);
    const content = fs.readFileSync(modelPath, 'utf-8');
    const document = shared.workspace.LangiumDocumentFactory.fromString<FutModel>(
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
    const { vocabularies, schema, infractions } = buildFutVocabularies(model, options);
    const doc = extractOutputBnf(Fut.Grammar, vocabularies, 'DecisionCommand');

    const header = [
        'GRAMATICA G — Esquema de Dados da DSL de arbitragem (SPC-CML).',
        '',
        'ARQUIVO GERADO AUTOMATICAMENTE — NAO EDITAR A MAO.',
        `Gerado por: src/cli/export-bnf-fut.ts`,
        `Gramatica:  src/language/futebol.langium (regra DecisionCommand)`,
        `Modelo:     ${path.basename(modelPath)} (esquema_dados ${schema.name})`,
        '',
        `Infracoes citaveis: ${infractions.length} | Condutas: ${schema.conducts.length} |` +
            ` Decisoes: ${vocabularies.get('decisao')!.length} | Reinicios: ${vocabularies.get('reinicio')!.length}`,
        '',
        'Toda alternativa desta gramatica corresponde a uma entidade declarada no',
        'modelo do arbitro. O que nao esta aqui e inexprimivel pelo LLM.'
    ].join('\n');

    return {
        bnf: doc.serialize(header),
        ruleCount: doc.rules.length,
        infractionCount: infractions.length,
        conductCount: schema.conducts.length
    };
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
    const modelPath = process.argv[2] ?? path.join('src', 'examples', 'fut', 'futebol.fut');
    const outPath =
        process.argv[3] ?? path.join('src', 'python_engine', 'grammar', 'futebol.bnf');

    exportFutBnf(modelPath)
        .then(result => {
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, result.bnf, 'utf-8');
            console.log(`BNF de arbitragem gerada a partir de ${modelPath}`);
            console.log(
                `  ${result.ruleCount} regras | ${result.infractionCount} infracoes | ${result.conductCount} condutas`
            );
            console.log(`  Escrita em: ${outPath}`);
            console.log('\n--- conteudo ---\n');
            console.log(result.bnf);
        })
        .catch(err => {
            console.error('Falha ao gerar a BNF de arbitragem:', err.message);
            process.exit(1);
        });
}
