/**
 * As tres analises de tempo da tela de avaliacao (web-chat/src/tempos-plano.ts).
 * Executar (da raiz): npm run test:web-tempos
 *
 * O foco e a NORMALIZACAO e a MONTAGEM: as contas em si estao testadas em
 * src/test/estatistica-tempos.test.ts. Aqui se cobra que as duas formas de
 * arquivo chegam ao mesmo lugar, que agregado e soma por plano nao se
 * contradizem e que medida ausente continua ausente.
 *
 * O que se cobra:
 *   1. registro da avaliacao (bloco `geracao`) e registro do lote (campos soltos)
 *      produzem o MESMO bloco normalizado;
 *   2. tamanhos em caracteres saem do proprio registro quando nao vieram prontos;
 *   3. registro sem nada disso nao vira bloco vazio: vira `undefined`;
 *   4. a pilha prefere os agregados do arquivo e so soma por plano na falta deles;
 *   5. a validacao do gate fica FORA do total pedido (geracao + avaliacao);
 *   6. total so existe com as duas etapas medidas — soma parcial nao vira total;
 *   7. tempo por tamanho: pares usaveis, taxa agregada e regressao por lado;
 *   8. tempo por plano: a amostra principal e geracao + validacao do gate;
 *   9. sem medida nenhuma, cada secao se declara vazia em vez de mostrar zeros.
 */

import assert from 'node:assert/strict';

import type { RegistroAvaliacaoImportado } from '../../src/inference/avaliacao-jsonl.js';
import type { DetalheLado, DetalheLinha, RespostaAvaliacao } from '../src/api';
import {
    geracaoDoRegistroImportado,
    medidasDoPlano,
    pilhaDeTempos,
    tempoPorPlano,
    tempoPorTamanho
} from '../src/tempos-plano';

let falhas = 0;
function teste(nome: string, fn: () => void): void {
    try {
        fn();
        console.log(`  ok   ${nome}`);
    } catch (erro) {
        falhas++;
        console.log(`  FALHA ${nome}\n       ${(erro as Error).message}`);
    }
}

function perto(obtido: number | null | undefined, esperado: number, tolerancia = 1e-6, rotulo = ''): void {
    assert.ok(
        typeof obtido === 'number' && Math.abs(obtido - esperado) < tolerancia,
        `${rotulo || 'valor'}: esperado ~${esperado}, obtido ${obtido}`
    );
}

/** Um plano avaliado, como a resposta da API o entrega. */
function plano(opcoes: {
    texto?: string;
    geracaoMs?: number;
    validacaoGateMs?: number;
    descartadaMs?: number;
    cenarioMs?: number;
    avaliacaoMs?: number;
    charsPrompt?: number;
    tokensPrompt?: number;
    tokensPlano?: number;
}): DetalheLado {
    const texto = opcoes.texto ?? 'PLANO';
    return {
        plano: texto,
        naoAvaliado: false,
        geracao: {
            ...(opcoes.geracaoMs !== undefined ? { tempoTotalMs: opcoes.geracaoMs } : {}),
            ...(opcoes.validacaoGateMs !== undefined ? { tempoValidacaoMs: opcoes.validacaoGateMs } : {}),
            ...(opcoes.descartadaMs !== undefined ? { tempoGeracaoDescartadaMs: opcoes.descartadaMs } : {}),
            ...(opcoes.cenarioMs !== undefined ? { tempoCenarioMs: opcoes.cenarioMs } : {}),
            ...(opcoes.charsPrompt !== undefined ? { charsPrompt: opcoes.charsPrompt } : {}),
            ...(opcoes.tokensPrompt !== undefined ? { tokensPrompt: opcoes.tokensPrompt } : {}),
            ...(opcoes.tokensPlano !== undefined ? { tokensPlano: opcoes.tokensPlano } : {}),
            charsPlano: texto.length
        },
        ...(opcoes.avaliacaoMs !== undefined
            ? { tempos: { sintaxeMs: 1, oraculoMs: 2, llmJudgeMs: 3, totalMs: opcoes.avaliacaoMs } }
            : {})
    };
}

function resposta(planos: DetalheLado[], agregados: Partial<RespostaAvaliacao> = {}): RespostaAvaliacao {
    const linhas: DetalheLinha[] = planos.map((p, i) => ({
        linha: i + 1,
        intencao: `intencao ${i + 1}`,
        arquitetura: p,
        temDivergencia: false,
        temDiscordancia: false
    }));
    return {
        arquitetura: {
            total: planos.length,
            sintaxe: { VALID: planos.length, INVALID: 0 },
            semantica: { VALID: planos.length, INVALID: 0, UNRESOLVED: 0, NOT_EVALUATED: 0 },
            oraculo: { VALID: planos.length, INVALID: 0, UNRESOLVED: 0 },
            juiz: { VALID: 0, INVALID: 0, UNRESOLVED: 0, NOT_CALLED: planos.length, NO_RESPONSE: 0 },
            concordantes: 0,
            discordantes: 0,
            pares: {},
            violacoes: 0
        },
        naoAvaliados: 0,
        linhas,
        ...agregados
    };
}

// ---------------------------------------------------------------------------

teste('as duas formas de arquivo produzem o mesmo bloco normalizado', () => {
    // Forma da avaliacao (evalueted_*.jsonl): bloco `geracao` pronto.
    const daAvaliacao: RegistroAvaliacaoImportado = {
        plano: 'PLANO',
        geracao: { tempoTotalMs: 1000, tempoValidacaoMs: 500, tempoCenarioMs: 1600, tentativasGeracao: 2, charsPrompt: 300, charsPedido: 40, charsPlano: 5 }
    };
    // Forma do lote (results_*.jsonl): os mesmos numeros no nivel de cima.
    const doLote: RegistroAvaliacaoImportado = {
        plano: 'PLANO',
        intencao: '0123456789012345678901234567890123456789',
        promptSemantico: 'p'.repeat(300),
        tempoTotalMs: 1000,
        tempoValidacaoMs: 500,
        tempoCenarioMs: 1600,
        tentativasGeracao: 2
    };
    assert.deepEqual(geracaoDoRegistroImportado(daAvaliacao), geracaoDoRegistroImportado(doLote));
    const bloco = geracaoDoRegistroImportado(doLote)!;
    assert.equal(bloco.tempoTotalMs, 1000);
    assert.equal(bloco.tempoValidacaoMs, 500);
    assert.equal(bloco.tentativasGeracao, 2);
});

teste('tamanhos em caracteres saem do proprio registro quando nao vieram prontos', () => {
    const bloco = geracaoDoRegistroImportado({
        plano: 'ABCDE',
        intencao: 'oito!!!!',
        promptSemantico: 'x'.repeat(42)
    })!;
    assert.equal(bloco.charsPlano, 5);
    assert.equal(bloco.charsPedido, 8);
    assert.equal(bloco.charsPrompt, 42);
    assert.equal(bloco.tokensPrompt, undefined, 'token nao se deduz de caractere');
});

teste('registro sem tempo nem texto nao vira bloco vazio', () => {
    assert.equal(geracaoDoRegistroImportado({}), undefined);
    assert.equal(geracaoDoRegistroImportado({ oraculo: { veredito: 'VALID' } }), undefined);
});

teste('medidasDoPlano: le o bloco e cai no texto do plano para o tamanho', () => {
    const m = medidasDoPlano(plano({ texto: 'ABC', geracaoMs: 900, validacaoGateMs: 100, avaliacaoMs: 50 }));
    assert.deepEqual(
        [m.tempoGeracaoMs, m.tempoValidacaoGateMs, m.tempoAvaliacaoMs, m.charsPlano],
        [900, 100, 50, 3]
    );
    const semBloco = medidasDoPlano({ plano: 'ABCDEF', naoAvaliado: false });
    assert.equal(semBloco.charsPlano, 6, 'sem bloco, o texto do plano ainda e mensuravel');
    assert.equal(semBloco.tempoGeracaoMs, undefined, 'e o tempo continua ausente');
});

teste('a pilha prefere os agregados do arquivo', () => {
    const r = resposta([plano({ geracaoMs: 1000, avaliacaoMs: 500 })], {
        tempoGeracaoTotalSegundos: 12.5,
        tempoTotalSegundos: 7.5
    });
    const p = pilhaDeTempos(r);
    perto(p.parcelas.find(x => x.rotulo === 'Geração dos planos')!.segundos, 12.5, 1e-9);
    perto(p.parcelas.find(x => x.rotulo === 'Avaliação dos planos')!.segundos, 7.5, 1e-9);
    perto(p.totalSegundos, 20, 1e-9, 'total = geracao + avaliacao');
});

teste('sem agregado, a pilha soma o que cada plano trouxe', () => {
    const p = pilhaDeTempos(resposta([plano({ geracaoMs: 1000, avaliacaoMs: 400 }), plano({ geracaoMs: 2000, avaliacaoMs: 600 })]));
    perto(p.parcelas.find(x => x.rotulo === 'Geração dos planos')!.segundos, 3, 1e-9);
    perto(p.parcelas.find(x => x.rotulo === 'Avaliação dos planos')!.segundos, 1, 1e-9);
    perto(p.totalSegundos, 4, 1e-9);
});

teste('a validacao do gate fica FORA do total pedido, com o total ampliado a parte', () => {
    const p = pilhaDeTempos(
        resposta([plano({ geracaoMs: 1000, validacaoGateMs: 500, descartadaMs: 2000, avaliacaoMs: 1000 })])
    );
    const gate = p.parcelas.find(x => x.rotulo === 'Validação no gate')!;
    assert.equal(gate.extra, true, 'o gate e parcela extra');
    perto(gate.segundos, 0.5, 1e-9);
    perto(p.totalSegundos, 2, 1e-9, 'geracao (1 s) + avaliacao (1 s) — sem o gate');
    perto(p.totalComGateSegundos, 2.5, 1e-9);
    const descartada = p.parcelas.find(x => x.rotulo === 'Gerações descartadas')!;
    assert.equal(descartada.extra, true);
    perto(descartada.segundos, 2, 1e-9);
});

teste('total so existe com as duas etapas: soma parcial nao vira total', () => {
    const soGeracao = pilhaDeTempos(resposta([plano({ geracaoMs: 1000 })]));
    assert.equal(soGeracao.totalSegundos, null, 'sem avaliacao medida nao ha total');
    assert.equal(soGeracao.algumaMedida, true, 'mas a parcela medida aparece');
    const nada = pilhaDeTempos(resposta([plano({})]));
    assert.equal(nada.algumaMedida, false, 'sem medida nenhuma a secao se declara vazia');
    assert.equal(nada.totalSegundos, null);
});

teste('sem gate, a pilha nao inventa parcela de validacao', () => {
    const p = pilhaDeTempos(resposta([plano({ geracaoMs: 1000, avaliacaoMs: 500 })]));
    assert.equal(p.parcelas.some(x => x.rotulo === 'Validação no gate'), false);
    assert.equal(p.totalComGateSegundos, null);
});

teste('tempo por tamanho: pares usaveis, taxa agregada e regressao', () => {
    const r = resposta([
        plano({ texto: 'A'.repeat(10), geracaoMs: 100, charsPrompt: 100, tokensPrompt: 25 }),
        plano({ texto: 'B'.repeat(20), geracaoMs: 300, charsPrompt: 300, tokensPrompt: 75 })
    ]);
    const t = tempoPorTamanho(r, 'arquitetura');
    assert.equal(t.n, 2);
    perto(t.geracao?.media, 200, 1e-9, 'tempo medio de geracao');

    const porCharPlano = t.itens.find(i => i.rotulo === 'Caracteres do plano')!;
    assert.equal(porCharPlano.analise.n, 2);
    perto(porCharPlano.analise.agregada, 400 / 30, 1e-9, 'Σtempo/Σchars');
    perto(porCharPlano.analise.porPlano?.media, 12.5, 1e-9, 'media das razoes por plano');

    const porCharInput = t.itens.find(i => i.rotulo === 'Caracteres do input (Prompt Semântico)')!;
    perto(porCharInput.analise.tamanho?.media, 200, 1e-9, 'tamanho medio do input');
    perto(porCharInput.analise.regressao?.r, 1, 1e-9, 'input e tempo crescem juntos neste exemplo');

    const porTokenInput = t.itens.find(i => i.rotulo === 'Tokens do input (Prompt Semântico)')!;
    assert.equal(porTokenInput.analise.n, 2);
    assert.equal(t.semTokens, false);
});

teste('sem tokens, as linhas de token ficam vazias e a secao avisa', () => {
    const t = tempoPorTamanho(resposta([plano({ geracaoMs: 100, charsPrompt: 100 })]), 'arquitetura');
    assert.equal(t.semTokens, true);
    assert.equal(t.itens.find(i => i.unidade === 'token')!.analise.n, 0);
    assert.equal(t.itens.find(i => i.unidade === 'token')!.analise.agregada, null, 'nenhuma taxa estimada');
    assert.equal(t.algumaMedida, true, 'os caracteres continuam valendo');
});

teste('tempo por plano: a amostra principal e geracao + validacao do gate', () => {
    const r = resposta([
        plano({ geracaoMs: 1000, validacaoGateMs: 200, avaliacaoMs: 300 }),
        plano({ geracaoMs: 2000, validacaoGateMs: 400, avaliacaoMs: 500 })
    ]);
    const t = tempoPorPlano(r, 'arquitetura');
    const principal = t.amostras.find(a => a.principal)!;
    assert.equal(principal.rotulo, 'Geração + validação no gate');
    assert.equal(principal.resumo?.n, 2);
    perto(principal.resumo?.media, 1800, 1e-9, '(1200 + 2400) / 2');
    perto(principal.resumo?.desvioPadrao, Math.sqrt(((1200 - 1800) ** 2 + (2400 - 1800) ** 2) / 1), 1e-9, 'dp amostral');
    assert.ok(principal.resumo?.ic, 'com n = 2 ja ha IC (t com 1 grau de liberdade)');
    perto(principal.resumo!.ic!.t, 12.706, 1e-9, 't(df=1)');

    const geracao = t.amostras.find(a => a.rotulo === 'Geração (parcela)')!;
    perto(geracao.resumo?.media, 1500, 1e-9);
    const validacao = t.amostras.find(a => a.rotulo === 'Validação no gate (parcela)')!;
    perto(validacao.resumo?.media, 300, 1e-9);
    perto(geracao.resumo!.media + validacao.resumo!.media, principal.resumo!.media, 1e-9, 'as parcelas somam a principal');

    const avaliacao = t.amostras.find(a => a.rotulo === 'Avaliação nesta tela')!;
    perto(avaliacao.resumo?.media, 400, 1e-9, 'a avaliacao desta tela e outra amostra, nao entra na principal');
});

teste('sem gate, a principal e igual a geracao e as outras linhas ficam vazias', () => {
    const t = tempoPorPlano(resposta([plano({ geracaoMs: 1000 }), plano({ geracaoMs: 3000 })]), 'arquitetura');
    const principal = t.amostras.find(a => a.principal)!;
    perto(principal.resumo?.media, 2000, 1e-9);
    assert.equal(t.amostras.find(a => a.rotulo === 'Validação no gate (parcela)')!.resumo, null);
    assert.equal(t.amostras.find(a => a.rotulo === 'Cenário inteiro (relógio do lote)')!.resumo, null);
});

teste('sem medida nenhuma, a secao de tempo por plano se declara vazia', () => {
    const t = tempoPorPlano(resposta([plano({})]), 'arquitetura');
    assert.equal(t.algumaMedida, false);
    assert.ok(t.amostras.every(a => a.resumo === null));
});

console.log(falhas === 0 ? '\nTodos os testes das analises de tempo passaram.' : `\n${falhas} teste(s) falharam.`);
if (falhas > 0) process.exit(1);
