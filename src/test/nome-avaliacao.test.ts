/**
 * Nome do arquivo da avaliacao: `evalueted_<nome>_<AAAAMMDD-HHmmss>.jsonl`.
 * Executar: npx tsx src/test/nome-avaliacao.test.ts
 */
import assert from 'node:assert/strict';
import { nomeArquivoAvaliacao } from '../inference/avaliacao-jsonl.js';

const agora = new Date(2026, 9, 7, 21, 5, 9); // 2026-10-07 21:05:09, hora local
const casos: [string, string | undefined, string][] = [
    ['sem results_ e sem o carimbo do arquivo de resultados', 'results_cenarios-2-fut_20261007-202028.jsonl', 'evalueted_cenarios-2-fut_20261007-210509.jsonl'],
    ['nome sem o padrao results_', 'meus-cenarios.jsonl', 'evalueted_meus-cenarios_20261007-210509.jsonl'],
    ['results_ sem carimbo', 'results_teste.jsonl', 'evalueted_teste_20261007-210509.jsonl'],
    ['caminho de arquivo', 'C:\\dados\\results_a-b_20260101-000000.jsonl', 'evalueted_a-b_20261007-210509.jsonl'],
    ['caracteres fora de [A-Za-z0-9._-]', 'results_cenários 1 (fut)_20261007-202028.jsonl', 'evalueted_cen-rios-1-fut_20261007-210509.jsonl'],
    ['sem nome de entrada: o dominio', undefined, 'evalueted_fut_20261007-210509.jsonl'],
    ['nada sobra do nome: o dominio', 'results__20261007-202028.jsonl', 'evalueted_fut_20261007-210509.jsonl']
];
let falhas = 0;
for (const [nome, entrada, esperado] of casos) {
    try {
        assert.equal(nomeArquivoAvaliacao(entrada, 'fut', agora), esperado);
        console.log(`  ok   ${nome}`);
    } catch (e) {
        falhas++;
        console.log(`  FALHA ${nome}\n       ${(e as Error).message}`);
    }
}
const regex = /^(evalueted_[A-Za-z0-9._-]+_[0-9]{8}-[0-9]{6}(-[0-9]+)?|[0-9]{8}-[0-9]{6}-(med|agro|fut)(-[0-9]+)?)\.jsonl$/;
for (const [, e, esp] of casos) assert.ok(regex.test(esp), `a rota GET aceita ${esp}`);
assert.ok(regex.test('20261007-034346-fut.jsonl'), 'os nomes antigos continuam acessiveis');
assert.ok(!regex.test('evalueted_../x_20261007-210509.jsonl') && !regex.test('../evalueted_a_20261007-210509.jsonl'), 'sem path traversal');
console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
process.exit(falhas === 0 ? 0 : 1);
