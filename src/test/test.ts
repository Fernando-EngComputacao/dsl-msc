/**
 * Inspecao do modelo clinico carregado pela DSL.
 * Executar: npx tsx src/test/test.ts [modelo.dsl]
 *
 * Confere que a AST expoe o Esquema de Controle e o Esquema de Dados na forma
 * esperada pelas etapas seguintes (grafo, extracao de BNF e recuperacao).
 */

import * as path from 'node:path';
import {
    isBlockRule,
    isDataSchemaDef,
    isDrugDef,
    isGlobalRule,
    isPopulationDef,
    isProtocolDef,
    isPumpLimitAttr,
    isRouteAttr
} from '../generated/ast.js';
import { loadModel } from '../database/neo4j.js';

async function run(): Promise<void> {
    const modelPath = process.argv[2] ?? path.join('src', 'examples', 'uti.dsl');
    const model = await loadModel(modelPath);

    const drugs = model.elements.filter(isDrugDef);
    const protocols = model.elements.filter(isProtocolDef);
    const populations = model.elements.filter(isPopulationDef);
    const blockRules = model.elements.filter(isBlockRule);
    const globalRules = model.elements.filter(isGlobalRule);
    const schemas = model.elements.filter(isDataSchemaDef);

    console.log('=== ESQUEMA DE CONTROLE ===');
    console.log(
        `${drugs.length} farmacos | ${protocols.length} protocolos | ` +
            `${populations.length} populacoes | ${blockRules.length + globalRules.length} invariantes`
    );

    console.log('\n--- Farmacos de alto risco e limites DERS ---');
    for (const drug of drugs.filter(d => d.highAlert === 'sim')) {
        const pump = drug.attributes.find(isPumpLimitAttr);
        const routes = drug.attributes.find(isRouteAttr);
        const limites = pump
            ? `hard limit ${pump.hard.value} ${pump.hard.unit}`
            : 'sem limite de bomba declarado';
        console.log(`  ${drug.name.padEnd(24)} [${drug.drugClass}] ${limites}`);
        if (routes) console.log(`${' '.repeat(28)}vias: ${routes.routes.join(', ')}`);
    }

    console.log('\n--- Invariantes de bloqueio (condicoes avaliaveis por maquina) ---');
    for (const rule of blockRules) {
        console.log(
            `  ${rule.drug.$refText.padEnd(20)} bloqueado se ` +
                `${rule.parameter} ${rule.operator} ${rule.threshold.value} ${rule.threshold.unit}`
        );
        console.log(`${' '.repeat(22)}razao: ${rule.reason}`);
    }

    console.log('\n=== ESQUEMA DE DADOS ===');
    for (const schema of schemas) {
        console.log(`  esquema ${schema.name}`);
        console.log(`    decisoes: ${schema.decisions.length} | vias: ${schema.routes.length}`);
        console.log(`    condutas: ${schema.conducts.map(c => c.name).join(', ')}`);
    }
}

run().catch(err => {
    console.error('Falha:', err.message ?? err);
    process.exit(1);
});
