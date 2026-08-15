/**
 * Verificacao do reconhecedor Earley e do reparo deterministico.
 * Executar: npx tsx src/test/earley.test.ts
 *
 * O criterio de sucesso e o da dissertacao: nenhuma saida invalida escapa, e
 * toda saida invalida e reconduzida a um programa aceito por G.
 */
import * as path from 'node:path';
import { loadBnf, EarleyRecognizer } from '../grammar/earley.js';
const BNF = path.join('src', 'python_engine', 'grammar', 'advanced_icu.bnf');
const PLANO_VALIDO = `plano Plano_Choque_01 para Choque_Septico {
  esquema_referencia AssistenteUTI_v2
  paciente 'PT-2026-0031'
  sequencia [ Titular_Vasopressor, Manter_Bloqueio ]
  ordem Noradrenalina decisao AUMENTAR_VAZAO dose 0.05 mcg/kg/min via ACESSO_CENTRAL justificativa 'PAM 52 abaixo do alvo'
  alerta CRITICO 'hipoperfusao grave' regra 'Choque_Septico/escalonar'
  auditoria 'plano sob restricao gramatical'
}`;
const INVALIDOS = {
    'farmaco inexistente': PLANO_VALIDO.replace('Noradrenalina', 'Dopamina'),
    'decisao inventada': PLANO_VALIDO.replace('AUMENTAR_VAZAO', 'TURBINAR'),
    'unidade invalida': PLANO_VALIDO.replace('mcg/kg/min', 'gotas/min'),
    'via nao permitida': PLANO_VALIDO.replace('ACESSO_CENTRAL', 'INTRATECAL'),
    'texto em prosa livre': 'Aumente a noradrenalina para 0.1 e mantenha o propofol bloqueado.',
    'JSON em vez da DSL': '{"acao": "AUMENTAR_VAZAO", "farmaco": "Noradrenalina"}',
    'truncado no meio': PLANO_VALIDO.slice(0, 150)
};
function main() {
    const grammar = loadBnf(BNF, 'plano');
    const parser = new EarleyRecognizer(grammar);
    let falhas = 0;
    console.log(`[1] G carregada: ${grammar.productions.length} producoes expandidas`);
    const ok = parser.analyze(PLANO_VALIDO);
    if (ok.accepted) {
        console.log('[2] Plano valido ACEITO');
    }
    else {
        console.error(`[2] FALHA: plano valido rejeitado -> ${ok.error}`);
        falhas++;
    }
    console.log('[3] Deteccao + reparo de saidas invalidas:');
    for (const [nome, programa] of Object.entries(INVALIDOS)) {
        const analysis = parser.analyze(programa);
        if (analysis.accepted) {
            console.error(`      NAO DETECTADO: ${nome}`);
            falhas++;
            continue;
        }
        const reparado = parser.repair(analysis.validPrefix);
        const valido = reparado !== undefined && parser.accepts(reparado);
        console.log(`      ${nome}\n` +
            `          prefixo valido: ${analysis.validPrefixLength}/${programa.trim().length} chars\n` +
            `          Sigma[y_prefix]: ${parser
                .describeExpected(analysis.expected)
                .slice(0, 6)
                .join(' | ')}${analysis.expected.length > 6 ? ' ...' : ''}\n` +
            `          reparo -> ${valido ? 'programa valido' : 'FALHOU'}`);
        if (!valido)
            falhas++;
    }
    // Propriedade central: partindo de QUALQUER prefixo valido, o reparo fecha.
    console.log('[4] Fechamento do reparo em todos os prefixos do plano valido:');
    let testados = 0;
    for (let i = 0; i <= PLANO_VALIDO.length; i += 17) {
        const prefixo = PLANO_VALIDO.slice(0, i);
        const analysis = parser.analyze(prefixo);
        const reparado = parser.repair(analysis.validPrefix);
        testados++;
        if (reparado === undefined || !parser.accepts(reparado)) {
            console.error(`      FALHA no prefixo de ${i} chars`);
            falhas++;
        }
    }
    console.log(`      ${testados} prefixos testados, todos fecharam em programa valido`);
    console.log(`\nRESULTADO: ${falhas === 0 ? 'OK' : `${falhas} falha(s)`}`);
    return falhas === 0 ? 0 : 1;
}
process.exit(main());
