/**
 * Gera `src/python_engine/grammar/agro_drone.bnf` a partir da DSL agricola.
 *
 * Uso:
 *   npx tsx src/cli/export-bnf-agro.ts [lavoura.agro] [saida.bnf]
 *
 * Mesmo papel de src/cli/export-bnf.ts no dominio clinico: a BNF nao e mantida a
 * mao, e um derivado verificavel da gramatica Langium mais o modelo do agronomo.
 */

import { EmptyFileSystem } from 'langium';
import { URI } from 'vscode-uri';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createAgroServices } from '../language/agro-module.js';
import type { AgroModel } from '../generated/ast.js';
import { extractOutputBnf } from '../grammar/extract-bnf.js';
import { buildAgroVocabularies, type AgroVocabularyOptions } from '../grammar/vocabularies-agro.js';

export interface AgroExportResult {
    bnf: string;
    ruleCount: number;
    productCount: number;
    conductCount: number;
}

export async function exportAgroBnf(
    modelPath: string,
    options: AgroVocabularyOptions = {}
): Promise<AgroExportResult> {
    const { shared, Agro } = createAgroServices(EmptyFileSystem);
    const content = fs.readFileSync(modelPath, 'utf-8');
    const document = shared.workspace.LangiumDocumentFactory.fromString<AgroModel>(
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
    const { vocabularies, schema, products } = buildAgroVocabularies(model, options);
    const doc = extractOutputBnf(Agro.Grammar, vocabularies, 'MissionCommand');

    const header = [
        'GRAMATICA G — Esquema de Dados da DSL agricola (SPC-CML).',
        '',
        'ARQUIVO GERADO AUTOMATICAMENTE — NAO EDITAR A MAO.',
        `Gerado por: src/cli/export-bnf-agro.ts`,
        `Gramatica:  src/language/agrodrone.langium (regra MissionCommand)`,
        `Modelo:     ${path.basename(modelPath)} (esquema_dados ${schema.name})`,
        '',
        `Produtos citaveis: ${products.length} | Condutas: ${schema.conducts.length} |` +
            ` Decisoes: ${vocabularies.get('decisao')!.length} | Modos: ${vocabularies.get('modo')!.length}`,
        '',
        'Toda alternativa desta gramatica corresponde a uma entidade declarada no',
        'modelo do agronomo. O que nao esta aqui e inexprimivel pelo LLM.'
    ].join('\n');

    return {
        bnf: doc.serialize(header),
        ruleCount: doc.rules.length,
        productCount: products.length,
        conductCount: schema.conducts.length
    };
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
    const modelPath = process.argv[2] ?? path.join('src', 'examples', 'lavoura.agro');
    const outPath =
        process.argv[3] ?? path.join('src', 'python_engine', 'grammar', 'agro_drone.bnf');

    exportAgroBnf(modelPath)
        .then(result => {
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, result.bnf, 'utf-8');
            console.log(`BNF agricola gerada a partir de ${modelPath}`);
            console.log(
                `  ${result.ruleCount} regras | ${result.productCount} produtos | ${result.conductCount} condutas`
            );
            console.log(`  Escrita em: ${outPath}`);
            console.log('\n--- conteudo ---\n');
            console.log(result.bnf);
        })
        .catch(err => {
            console.error('Falha ao gerar a BNF agricola:', err.message);
            process.exit(1);
        });
}
