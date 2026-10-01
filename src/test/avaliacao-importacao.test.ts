import assert from 'node:assert/strict';
import { parseRegistrosAvaliacao } from '../inference/avaliacao-jsonl.js';

const primeiro = {
    dominio: 'fut', lado: 'arquitetura', linha: 1, intencao: 'Lance de teste', plano: 'plano', sujeito: 'PT-1',
    validacaoSintatica: { veredito: 'VALID', erros: [], pecas: { gramatica: 'ACEITO', parser: 'ACEITO' } },
    ast: { $type: 'DecisionCommand', name: 'Teste' },
    validacaoSemantica: { veredito: 'INVALID', erros: [], avisos: [], dadosFaltantes: [], etapas: [], naoFormalizado: [] },
    oraculo: { veredito: 'INVALID', origem: 'semantica' },
    julgamentoLLM: { status: 'VALID', justificativa: 'justificativa', evidencias: [], respostaBruta: '{}' },
    concordancia: false, classificacao: 'DISCORDANCIA_LLM'
};
const segundo = { dominio: 'fut', lado: 'baseline', linha: 1, intencao: 'Lance antigo', plano: 'plano antigo', oraculo: { veredito: 'VALID' } };

const registros = parseRegistrosAvaliacao(`${JSON.stringify(primeiro)}\r\n${JSON.stringify(segundo)}\r\n`);
assert.equal(registros.length, 2);
assert.deepEqual(registros[0], primeiro);
assert.equal(registros[0].ast?.$type, 'DecisionCommand');
assert.equal(registros[0].classificacao, 'DISCORDANCIA_LLM');
assert.equal(registros[1].tempos, undefined, 'JSONL legado sem tempos permanece válido');
assert.throws(() => parseRegistrosAvaliacao(`${JSON.stringify(primeiro)}\n{inválido}\n`), /linha 2/);
assert.throws(() => parseRegistrosAvaliacao('[]'), /objeto JSON/);

console.log('OK: importação JSONL mantém registros completos, suporta formato antigo e reporta erros de linha.');
