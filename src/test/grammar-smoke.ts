/**
 * Verificacao rapida da cadeia DSL -> BNF -> Earley.
 * Executar: npx tsx src/test/grammar-smoke.ts
 */

import { EmptyFileSystem } from 'langium';
import { readFileSync } from 'node:fs';
import { createDSLServices } from '../language/dsl-module.js';
import { grammarToBnf } from '../grammar/langium-to-bnf.js';
import { EarleyParser } from '../grammar/earley.js';
import { specialize } from '../grammar/specializer.js';

const { DSL } = createDSLServices(EmptyFileSystem);
const bnf = grammarToBnf(DSL.Grammar);
const parser = new EarleyParser(bnf);

console.log('=== Estatisticas de G ===');
console.log(bnf.stats());

console.log('\n=== Recorte do BNF gerado ===');
console.log(bnf.serialize({ includeTerminals: true }).split('\n').slice(0, 22).join('\n'));

const model = readFileSync(new URL('../examples/agro.dsl', import.meta.url), 'utf8');
const analysis = parser.analyze(model);
console.log('\n=== Modelo do especialista ===');
console.log('tokens:', analysis.tokens.length, '| aceito:', analysis.accepted, '|', analysis.error ?? '');

const mission = `comando executar Missao_01 para Soja {
    esquema_referencia DroneAgricola01
    sequencia_atuacao [ Pulverizar_Faixa, Encerrar_Aplicacao ]
}`;
const missionAnalysis = parser.analyze(mission);
console.log('\n=== Missao isolada ===');
console.log('aceita:', missionAnalysis.accepted, '|', missionAnalysis.error ?? '');

const spec = specialize(bnf, parser, mission);
console.log('\n=== G[y] (gramatica especializada minimal) ===');
console.log(spec ? spec.bnf : 'falha ao derivar');
console.log('producoes em G[y]:', spec?.productionIds.size, 'de', bnf.productions.length);

console.log('\n=== Deteccao de erro sintatico + Sigma[y_prefix] ===');
const broken = `comando executar Missao_02 para Soja {
    esquema_referencia DroneAgricola01
    sequencia_atuacao [ Acelerar_Drone`;
const bad = parser.analyze(broken);
console.log('aceito:', bad.accepted, '|', bad.error);
console.log('prefixo valido:', JSON.stringify(bad.validPrefix.slice(-40)));
console.log('Sigma[y_prefix]:', parser.describeTerminals(bad.expectedTerminals).join(' | '));

const completion = parser.completionPath(bad.tokens.slice(0, bad.validPrefixLength));
console.log('reparo deterministico:', completion?.map(t => t.image).join(' '));
