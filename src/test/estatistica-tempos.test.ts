/**
 * Estatistica descritiva dos tempos por plano (src/inference/estatistica-tempos.ts).
 * Executar: npx tsx src/test/estatistica-tempos.test.ts
 *
 * Amostra de referencia [2,4,4,4,5,5,7,9]: media 5, variancia amostral 32/7,
 * dp 2,13809 — conferida a mao, para que o teste pegue troca de n por n−1
 * (o erro classico) e nao apenas "roda sem quebrar".
 *
 * O que se cobra:
 *   1. media, soma, dp AMOSTRAL (n−1), erro padrao, mediana e quartis;
 *   2. IC da media pela t de Student, com o t do grau de liberdade certo;
 *   3. n = 1 tem media e mediana, mas nao tem dp nem IC — e `null`, nao 0;
 *   4. n = 0 devolve `null`: nada e inventado;
 *   5. valor nao finito, null e undefined ficam fora da conta;
 *   6. tempo por unidade: taxa agregada != media das razoes por plano;
 *   7. correlacao e regressao: sinal, r2 e inclinacao em casos exatos;
 *   8. variancia nula ou tamanho <= 0 nao viram NaN/Infinity.
 */

import assert from 'node:assert/strict';

import {
    FORMULAS_TEMPO,
    resumirAmostra,
    tCritico95,
    tempoPorUnidade
} from '../inference/estatistica-tempos.js';

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

/** Compara com tolerancia: as contas sao em ponto flutuante. */
function perto(obtido: number | null | undefined, esperado: number, tolerancia = 1e-6, rotulo = ''): void {
    assert.ok(
        typeof obtido === 'number' && Math.abs(obtido - esperado) < tolerancia,
        `${rotulo || 'valor'}: esperado ~${esperado}, obtido ${obtido}`
    );
}

const REFERENCIA = [2, 4, 4, 4, 5, 5, 7, 9];

teste('media, soma, dp amostral, erro padrao, mediana e quartis', () => {
    const r = resumirAmostra(REFERENCIA)!;
    assert.equal(r.n, 8);
    perto(r.soma, 40, 1e-9, 'soma');
    perto(r.media, 5, 1e-9, 'media');
    // dp AMOSTRAL: √(32/7) = 2.13809. Com o divisor n (populacional) daria 2 —
    // e esta asserção e justamente a que separa os dois.
    perto(r.desvioPadrao, Math.sqrt(32 / 7), 1e-9, 'dp');
    perto(r.desvioPadrao, 2.138089935, 1e-6, 'dp (valor conferido a mao)');
    perto(r.erroPadrao, Math.sqrt(32 / 7) / Math.sqrt(8), 1e-9, 'erro padrao');
    perto(r.mediana, 4.5, 1e-9, 'mediana');
    perto(r.q1, 4, 1e-9, 'q1');
    perto(r.q3, 5.5, 1e-9, 'q3');
    assert.equal(r.minimo, 2);
    assert.equal(r.maximo, 9);
    perto(r.coeficienteVariacao, Math.sqrt(32 / 7) / 5, 1e-9, 'CV');
});

teste('IC da media pela t de Student, com o t do grau de liberdade certo', () => {
    const r = resumirAmostra(REFERENCIA)!;
    assert.ok(r.ic, 'com n = 8 ha IC');
    assert.equal(r.ic!.nivel, 0.95);
    perto(r.ic!.t, 2.365, 1e-9, 't(df=7)');
    perto(r.ic!.margem, 2.365 * (Math.sqrt(32 / 7) / Math.sqrt(8)), 1e-9, 'margem');
    perto(r.ic!.inferior, 5 - r.ic!.margem, 1e-9, 'inferior');
    perto(r.ic!.superior, 5 + r.ic!.margem, 1e-9, 'superior');
    // O intervalo e da MEDIA: estreito, e contem a media por construcao.
    assert.ok(r.ic!.inferior < 5 && 5 < r.ic!.superior);
});

teste('t critico: tabela ate df 30, normal acima disso', () => {
    perto(tCritico95(1), 12.706, 1e-9);
    perto(tCritico95(7), 2.365, 1e-9);
    perto(tCritico95(30), 2.042, 1e-9);
    perto(tCritico95(31), 1.96, 1e-9, 'acima de 30 usa z');
    perto(tCritico95(5000), 1.96, 1e-9);
    assert.ok(Number.isNaN(tCritico95(0)), 'df 0 nao tem t');
});

teste('n = 1: tem media e mediana, nao tem dp nem IC (null, nao 0)', () => {
    const r = resumirAmostra([42])!;
    assert.equal(r.n, 1);
    perto(r.media, 42, 1e-9);
    perto(r.mediana, 42, 1e-9);
    perto(r.q1, 42, 1e-9);
    perto(r.q3, 42, 1e-9);
    assert.equal(r.desvioPadrao, null);
    assert.equal(r.erroPadrao, null);
    assert.equal(r.ic, null);
    assert.equal(r.coeficienteVariacao, null);
});

teste('n = 0 devolve null: nada e inventado', () => {
    assert.equal(resumirAmostra([]), null);
    assert.equal(resumirAmostra([null, undefined]), null);
    assert.equal(resumirAmostra([Number.NaN, Number.POSITIVE_INFINITY]), null);
});

teste('valor nao finito, null e undefined ficam fora da conta', () => {
    const r = resumirAmostra([10, null, 20, undefined, Number.NaN, 30, Number.POSITIVE_INFINITY])!;
    assert.equal(r.n, 3, 'so os tres finitos contam');
    perto(r.media, 20, 1e-9);
    perto(r.soma, 60, 1e-9);
});

teste('variancia nula: dp 0, IC degenerado, CV 0 — sem NaN', () => {
    const r = resumirAmostra([7, 7, 7])!;
    perto(r.desvioPadrao, 0, 1e-12);
    perto(r.erroPadrao, 0, 1e-12);
    perto(r.ic!.margem, 0, 1e-12);
    perto(r.ic!.inferior, 7, 1e-12);
    perto(r.coeficienteVariacao, 0, 1e-12);
});

teste('media 0 nao produz CV infinito', () => {
    const r = resumirAmostra([-5, 5])!;
    perto(r.media, 0, 1e-12);
    assert.equal(r.coeficienteVariacao, null, 'media 0: CV nao existe');
});

teste('tempo por unidade: a taxa agregada nao e a media das razoes por plano', () => {
    // 100 ms/10 chars = 10 ms/char; 300 ms/20 chars = 15 ms/char.
    const r = tempoPorUnidade([
        { tempoMs: 100, tamanho: 10 },
        { tempoMs: 300, tamanho: 20 }
    ]);
    assert.equal(r.n, 2);
    perto(r.agregada, 400 / 30, 1e-9, 'agregada (soma/soma)');
    perto(r.porPlano!.media, 12.5, 1e-9, 'media das razoes');
    assert.ok(Math.abs(r.agregada! - r.porPlano!.media) > 0.5, 'as duas respondem perguntas diferentes');
    perto(r.tamanho!.media, 15, 1e-9, 'tamanho medio');
});

teste('tempo por unidade: par incompleto ou tamanho <= 0 nao entra', () => {
    const r = tempoPorUnidade([
        { tempoMs: 100, tamanho: 10 },
        { tempoMs: 200, tamanho: 0 },
        { tempoMs: 200, tamanho: -5 },
        { tempoMs: null, tamanho: 10 },
        { tempoMs: 100, tamanho: undefined }
    ]);
    assert.equal(r.n, 1, 'so o par completo com tamanho > 0');
    perto(r.agregada, 10, 1e-9);
    assert.equal(r.porPlano!.desvioPadrao, null, 'com um par nao ha dispersao');
    assert.equal(r.regressao, null, 'com um ponto nao ha reta');
});

teste('tempo por unidade: sem par usavel, tudo null e n = 0', () => {
    const r = tempoPorUnidade([{ tempoMs: null, tamanho: null }]);
    assert.deepEqual([r.n, r.agregada, r.porPlano, r.tamanho, r.regressao], [0, null, null, null, null]);
});

teste('correlacao: +1, -1 e variancia nula', () => {
    perto(FORMULAS_TEMPO.correlacaoPearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]), 1, 1e-12, 'r = +1');
    perto(FORMULAS_TEMPO.correlacaoPearson([1, 2, 3], [3, 2, 1]), -1, 1e-12, 'r = -1');
    assert.equal(FORMULAS_TEMPO.correlacaoPearson([5, 5, 5], [1, 2, 3]), null, 'x constante: r nao existe');
    assert.equal(FORMULAS_TEMPO.correlacaoPearson([1], [1]), null, 'n < 2');
});

teste('regressao: inclinacao, intercepto e r2 num caso exato', () => {
    const reta = FORMULAS_TEMPO.regressaoLinear([10, 20], [100, 300])!;
    perto(reta.inclinacao, 20, 1e-9, 'ms por unidade de tamanho');
    perto(reta.intercepto, -100, 1e-9, 'intercepto');
    perto(reta.r2, 1, 1e-12, 'r2 de dois pontos e 1');
    assert.equal(reta.n, 2);
    // Ruido real: r2 < 1, e a inclinacao continua positiva.
    const comRuido = FORMULAS_TEMPO.regressaoLinear([1, 2, 3, 4], [2, 5, 4, 9])!;
    assert.ok(comRuido.inclinacao > 0 && comRuido.r2! < 1);
    assert.equal(FORMULAS_TEMPO.regressaoLinear([5, 5], [1, 2]), null, 'x constante: sem reta');
});

teste('as formulas expostas sao as mesmas que o resumo usa', () => {
    const r = resumirAmostra(REFERENCIA)!;
    perto(FORMULAS_TEMPO.media(REFERENCIA), r.media, 1e-12);
    perto(FORMULAS_TEMPO.desvioPadraoAmostral(REFERENCIA), r.desvioPadrao!, 1e-12);
    perto(FORMULAS_TEMPO.erroPadrao(r.desvioPadrao, r.n), r.erroPadrao!, 1e-12);
    const ic = FORMULAS_TEMPO.intervaloConfianca95(r.media, r.erroPadrao, r.n)!;
    perto(ic.inferior, r.ic!.inferior, 1e-12);
    perto(ic.superior, r.ic!.superior, 1e-12);
    assert.equal(FORMULAS_TEMPO.taxaAgregada(400, 0), null, 'tamanho total 0: taxa nao existe');
});

console.log(falhas === 0 ? '\nTodos os testes de estatistica dos tempos passaram.' : `\n${falhas} teste(s) falharam.`);
process.exit(falhas === 0 ? 0 : 1);
