/**
 * Camada analítica da sessão "Avaliação LLM" (src/inference/analise-avaliacao.ts):
 * o seletor de fonte (Apenas Oráculo, Apenas LLM Judge, Oráculo + LLM Judge,
 * Avaliação Humana) e as métricas de cada um.
 * Executar: npx tsx src/test/analise-avaliacao.test.ts
 *
 * O conjunto de referência tem a matriz Oráculo × Judge calculada à mão:
 *
 *                 Judge VALID  INVALID  UNRESOLVED
 *   Oráculo VALID       2        1         0        (+1 NOT_CALLED)
 *           INVALID     1        2         0        (+1 NO_RESPONSE)
 *           UNRESOLVED  1        0         0
 *   (+1 plano não avaliado, sem oráculo, juiz NOT_CALLED)
 *
 *   comparáveis 7 de 9 elegíveis; concordância 4/7; po = 4/7; pe = 3/7; κ = 0,25;
 *   F1: VALID 4/7, INVALID 2/3, UNRESOLVED 0 → macro F1 = 26/63.
 */

import * as assert from 'node:assert/strict';

import {
    analisar,
    CLASSES_HUMANAS,
    comparar,
    FONTE_ANALISE_INICIAL,
    FONTES,
    METRICAS_POR_FONTE,
    normalizarLinhas,
    OPCOES_FONTE,
    SEM_DADOS_HUMANOS,
    type Analise,
    type FonteAnalise,
    type LadoEntrada,
    type LinhaEntrada
} from '../inference/analise-avaliacao.js';

let falhas = 0;
function teste(nome: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok   ${nome}`))
        .catch((erro: Error) => {
            falhas++;
            console.log(`  FALHA ${nome}\n       ${erro.message}`);
        });
}

const lado = (oraculo?: string, juiz?: string, extra: Partial<LadoEntrada> = {}): LadoEntrada => ({
    naoAvaliado: false,
    ...(oraculo ? { oraculo: { veredito: oraculo } } : {}),
    ...(juiz ? { julgamentoLLM: { status: juiz } } : {}),
    ...extra
});

function referencia(humana = false): LinhaEntrada[] {
    const h = (classe: string): Partial<LadoEntrada> => (humana ? { avaliacaoHumana: { classe } } : {});
    return [
        { linha: 1, intencao: 'c1', dominio: 'fut', arquitetura: lado('VALID', 'VALID', h('CORRETO')), baseline: lado('INVALID', 'INVALID', h('INCOMPLETO')) },
        { linha: 2, intencao: 'c2', dominio: 'fut', arquitetura: lado('VALID', 'INVALID', h('INCORRETO')), baseline: lado('INVALID', 'VALID') },
        { linha: 3, intencao: 'c3', dominio: 'fut', arquitetura: lado('INVALID', 'INVALID'), baseline: lado('VALID', 'VALID') },
        { linha: 4, intencao: 'c4', dominio: 'med', arquitetura: lado('UNRESOLVED', 'VALID'), baseline: lado('INVALID', 'NO_RESPONSE') },
        { linha: 5, intencao: 'c5', dominio: 'med', arquitetura: lado('VALID', 'NOT_CALLED') },
        { linha: 6, intencao: 'c6', dominio: 'med', arquitetura: { naoAvaliado: true, julgamentoLLM: { status: 'NOT_CALLED' } } }
    ];
}

const planos = normalizarLinhas(referencia());
const quase = (a: number | null | undefined, b: number, msg?: string) => {
    assert.ok(a !== null && a !== undefined && Math.abs(a - b) < 1e-12, `${msg ?? ''} esperado ${b}, veio ${a}`);
};

/** Nenhum número do resultado pode ser NaN ou infinito; ausência é null/undefined. */
function semNaN(valor: unknown, caminho = 'analise'): void {
    if (typeof valor === 'number') assert.ok(Number.isFinite(valor), `${caminho} = ${valor}`);
    else if (Array.isArray(valor)) valor.forEach((v, i) => semNaN(v, `${caminho}[${i}]`));
    else if (valor && typeof valor === 'object') for (const [k, v] of Object.entries(valor)) semNaN(v, `${caminho}.${k}`);
}

const COMPARATIVAS = ['comparacao'] as const;
function temComparativas(a: Analise): boolean {
    const blocos = [a.geral, ...Object.values(a.porModelo), ...Object.values(a.porDominio)].filter(Boolean);
    return blocos.some(b => COMPARATIVAS.some(k => b![k] !== undefined)) || a.porLinha.some(l => l.concorda !== undefined);
}

async function main(): Promise<void> {
    console.log('\n[opções e tabela de métricas]');

    await teste('exatamente 4 opções, com os rótulos pedidos; a inicial é Oráculo + LLM Judge', () => {
        assert.deepEqual(OPCOES_FONTE.map(o => o.rotulo), ['Apenas Oráculo', 'Apenas LLM Judge', 'Oráculo + LLM Judge', 'Avaliação Humana']);
        assert.deepEqual(OPCOES_FONTE.map(o => o.id), ['oraculo', 'llm', 'oraculo_llm', 'humana']);
        assert.equal(FONTE_ANALISE_INICIAL, 'oraculo_llm');
        assert.ok(!OPCOES_FONTE.some(o => /ground truth/i.test(o.descricao)), 'o Oráculo não é chamado de ground truth');
    });

    await teste('tabela de métricas por fonte (comparativas só em Oráculo + LLM Judge)', () => {
        const comparativas = ['concordancia', 'matrizConfusao', 'precision', 'recall', 'f1', 'kappa'];
        for (const f of ['oraculo', 'llm', 'humana'] as const) assert.ok(!comparativas.some(m => METRICAS_POR_FONTE[f].includes(m as never)), f);
        assert.ok(comparativas.every(m => METRICAS_POR_FONTE.oraculo_llm.includes(m as never)));
        assert.ok(!METRICAS_POR_FONTE.oraculo.includes('coberturaJuiz') && !METRICAS_POR_FONTE.humana.includes('coberturaJuiz'));
        assert.ok(METRICAS_POR_FONTE.llm.includes('coberturaJuiz') && METRICAS_POR_FONTE.oraculo_llm.includes('coberturaJuiz'));
    });

    console.log('\n[1] Apenas Oráculo');

    await teste('distribuição dos vereditos normativos, sobre os elegíveis; sem comparação nem cobertura do juiz', () => {
        const a = analisar(planos, 'oraculo');
        assert.equal(a.disponivel, true);
        assert.equal(a.geral!.distribuicoes.length, 1);
        const d = a.geral!.distribuicoes[0];
        assert.deepEqual([d.fonte, d.elegiveis, d.semJulgamento], ['oraculo', 9, 1]);
        assert.deepEqual(Object.keys(d.porEstado), ['VALID', 'INVALID', 'UNRESOLVED']);
        assert.deepEqual(['VALID', 'INVALID', 'UNRESOLVED'].map(c => [d.porEstado[c].n, d.porEstado[c].denominador]), [[4, 9], [4, 9], [1, 9]]);
        quase(d.porEstado.VALID.percentual, 400 / 9);
        assert.equal(a.geral!.coberturaJuiz, undefined);
        assert.equal(temComparativas(a), false);
    });

    console.log('\n[2] Apenas LLM Judge');

    await teste('os cinco estados do juiz, cobertura e taxa de resposta; sem comparação com o Oráculo', () => {
        const a = analisar(planos, 'llm');
        const d = a.geral!.distribuicoes[0];
        assert.deepEqual([d.fonte, d.elegiveis], ['llmJudge', 10]);
        assert.deepEqual(Object.keys(d.porEstado), ['VALID', 'INVALID', 'UNRESOLVED', 'NOT_CALLED', 'NO_RESPONSE']);
        assert.deepEqual(Object.values(d.porEstado).map(p => p.n), [4, 3, 0, 2, 1]);
        const c = a.geral!.coberturaJuiz!;
        assert.deepEqual([c.taxaResposta.n, c.taxaResposta.denominador], [7, 8], 'veredito / chamados (exclui NOT_CALLED)');
        assert.deepEqual([c.cobertura.n, c.cobertura.denominador], [7, 10], 'veredito / todos os planos');
        assert.equal(temComparativas(a), false);
        assert.ok(!a.geral!.distribuicoes.some(x => x.fonte === 'oraculo'));
    });

    console.log('\n[3] Oráculo + LLM Judge');

    await teste('matriz, concordância, cobertura e exclusões com denominadores explícitos', () => {
        const c = analisar(planos, 'oraculo_llm').geral!.comparacao!;
        assert.deepEqual([c.referencia, c.avaliador], ['oraculo', 'llmJudge']);
        assert.deepEqual([c.elegiveis, c.comparaveis, c.excluidos.semReferencia, c.excluidos.avaliadorSemVeredito], [9, 7, 1, 2]);
        assert.deepEqual(c.matriz, {
            VALID: { VALID: 2, INVALID: 1, UNRESOLVED: 0 },
            INVALID: { VALID: 1, INVALID: 2, UNRESOLVED: 0 },
            UNRESOLVED: { VALID: 1, INVALID: 0, UNRESOLVED: 0 }
        });
        assert.deepEqual([c.concordancia.n, c.concordancia.denominador, c.discordancia.n], [4, 7, 3]);
        assert.deepEqual([c.cobertura.n, c.cobertura.denominador], [7, 9]);
        assert.deepEqual(Object.fromEntries(Object.entries(c.concordantesPorClasse).map(([k, p]) => [k, p.n])), { VALID: 2, INVALID: 2, UNRESOLVED: 0 });
        assert.deepEqual(c.discordancias.map(d => `${d.de}->${d.para}:${d.proporcao.n}/${d.proporcao.denominador}`).sort(), [
            'INVALID->VALID:1/7', 'UNRESOLVED->VALID:1/7', 'VALID->INVALID:1/7'
        ]);
    });

    await teste('precision, recall, F1, macro F1 e Cohen κ batem com o cálculo à mão', () => {
        const c = analisar(planos, 'oraculo_llm').geral!.comparacao!;
        assert.deepEqual([c.porClasse.VALID.precision.n, c.porClasse.VALID.precision.denominador, c.porClasse.VALID.recall.denominador], [2, 4, 3]);
        quase(c.porClasse.VALID.f1, 4 / 7, 'F1 VALID');
        quase(c.porClasse.INVALID.f1, 2 / 3, 'F1 INVALID');
        assert.equal(c.porClasse.UNRESOLVED.precision.percentual, null, 'o juiz nunca disse UNRESOLVED: precisão sem denominador');
        assert.equal(c.porClasse.UNRESOLVED.f1, 0, 'mas a classe tem suporte: F1 = 0');
        quase(c.macroF1.valor, 26 / 63, 'macro F1');
        assert.deepEqual(c.macroF1.classesConsideradas, ['VALID', 'INVALID', 'UNRESOLVED']);
        quase(c.kappa.po, 4 / 7, 'po');
        quase(c.kappa.pe, 3 / 7, 'pe');
        quase(c.kappa.valor, 0.25, 'κ');
    });

    await teste('κ: concordância perfeita dá 1; uma classe só (pe = 1) dá null, não NaN nem infinito', () => {
        const perfeito = normalizarLinhas([
            { linha: 1, intencao: 'a', arquitetura: lado('VALID', 'VALID') },
            { linha: 2, intencao: 'b', arquitetura: lado('INVALID', 'INVALID') }
        ]);
        assert.equal(comparar(perfeito, FONTES.oraculo, FONTES.llmJudge).kappa.valor, 1);
        const umaClasse = normalizarLinhas([
            { linha: 1, intencao: 'a', arquitetura: lado('VALID', 'VALID') },
            { linha: 2, intencao: 'b', arquitetura: lado('VALID', 'VALID') }
        ]);
        const c = comparar(umaClasse, FONTES.oraculo, FONTES.llmJudge);
        assert.equal(c.kappa.valor, null);
        assert.equal(c.kappa.pe, 1);
        assert.equal(c.porClasse.INVALID.f1, null, 'classe ausente nas duas fontes: F1 indefinido');
        assert.deepEqual(c.macroF1.classesConsideradas, ['VALID']);
        semNaN(c);
    });

    console.log('\n[4, 5, 9] Avaliação Humana');

    await teste('sem dados humanos: indisponível, com a mensagem, sem métricas e sem NaN', () => {
        const a = analisar(planos, 'humana');
        assert.equal(a.disponivel, false);
        assert.equal(a.motivoIndisponivel, SEM_DADOS_HUMANOS);
        assert.equal(a.geral, undefined);
        assert.deepEqual([a.porModelo, a.porDominio, a.porLinha], [{}, {}, []]);
        semNaN(a);
        assert.ok(OPCOES_FONTE.some(o => o.id === 'humana'), 'a opção continua existindo');
    });

    await teste('com dados simulados: distribuição CORRETO/INCORRETO/INCOMPLETO; ausência NÃO conta como INCORRETO', () => {
        const a = analisar(normalizarLinhas(referencia(true)), 'humana');
        assert.equal(a.disponivel, true);
        const d = a.geral!.distribuicoes[0];
        assert.deepEqual(Object.keys(d.porEstado), [...CLASSES_HUMANAS]);
        assert.deepEqual([d.elegiveis, d.semJulgamento], [3, 7]);
        assert.deepEqual(Object.values(d.porEstado).map(p => `${p.n}/${p.denominador}`), ['1/3', '1/3', '1/3']);
        assert.equal(temComparativas(a), false, 'sem outra referência comparável, nada de concordância');
        semNaN(a);
    });

    await teste('nenhuma opção produz NaN, nem sobre dados vazios', () => {
        for (const o of OPCOES_FONTE) {
            semNaN(analisar(planos, o.id), o.id);
            semNaN(analisar([], o.id), `${o.id} vazio`);
            semNaN(analisar(planos, o.id, { lado: 'baseline', dominio: 'inexistente' }), `${o.id} recorte vazio`);
        }
    });

    console.log('\n[6, 7, 8, 10] troca de fonte');

    await teste('Oráculo → LLM → Oráculo + LLM → Humana: cada resultado só tem as métricas da sua fonte', () => {
        const sequencia: FonteAnalise[] = ['oraculo', 'llm', 'oraculo_llm', 'humana', 'oraculo'];
        const resultados = sequencia.map(f => analisar(planos, f));
        const [o, llm, ol, h, oDeNovo] = resultados;
        assert.equal(temComparativas(o), false);
        assert.equal(o.geral!.coberturaJuiz, undefined);
        assert.equal(temComparativas(llm), false);
        assert.ok(llm.geral!.coberturaJuiz);
        assert.ok(ol.geral!.comparacao && ol.geral!.coberturaJuiz);
        assert.equal(h.disponivel, false);
        assert.equal(h.geral, undefined, 'nada de Kappa/concordância da seleção anterior');
        assert.deepEqual(oDeNovo, o, 'voltar a uma fonte dá o mesmo resultado: nada sobrevive da troca');
    });

    await teste('as métricas presentes em cada resultado são as da tabela, e só elas', () => {
        for (const o of OPCOES_FONTE) {
            const a = analisar(normalizarLinhas(referencia(true)), o.id);
            const m = METRICAS_POR_FONTE[o.id];
            assert.equal(a.geral!.coberturaJuiz !== undefined, m.includes('coberturaJuiz'), `${o.id}: cobertura`);
            assert.equal(a.geral!.comparacao !== undefined, m.includes('concordancia'), `${o.id}: comparação`);
            assert.equal(a.geral!.distribuicoes.length > 0, m.includes('distribuicao'), `${o.id}: distribuição`);
        }
    });

    console.log('\n[11, 12, 13, 14] recortes');

    await teste('filtro por modelo recalcula os denominadores', () => {
        const todos = analisar(planos, 'oraculo_llm').geral!.comparacao!;
        const arq = analisar(planos, 'oraculo_llm', { lado: 'arquitetura' });
        const c = arq.geral!.comparacao!;
        assert.equal(arq.totalPlanos, 6);
        assert.deepEqual([c.elegiveis, c.comparaveis, c.concordancia.n, c.concordancia.denominador], [5, 4, 2, 4]);
        assert.notEqual(c.concordancia.denominador, todos.concordancia.denominador);
        assert.ok(arq.porLinha.every(l => l.lado === 'arquitetura'));
        assert.deepEqual(arq.lados, ['arquitetura', 'baseline'], 'as opções do filtro vêm dos dados, não do filtro aplicado');
    });

    await teste('filtro por domínio funciona e se combina com o de modelo', () => {
        const med = analisar(planos, 'oraculo', { dominio: 'med' });
        assert.equal(med.totalPlanos, 4);
        assert.deepEqual(med.dominios, ['fut', 'med']);
        assert.equal(analisar(planos, 'oraculo', { dominio: 'med', lado: 'baseline' }).totalPlanos, 1);
    });

    await teste('análise por domínio: cada domínio com os seus denominadores, somando o geral', () => {
        const a = analisar(planos, 'oraculo_llm');
        assert.deepEqual(Object.keys(a.porDominio).sort(), ['fut', 'med']);
        assert.equal(a.porDominio.fut.comparacao!.comparaveis, 6);
        assert.equal(a.porDominio.med.comparacao!.comparaveis, 1);
        assert.equal(a.porDominio.fut.total + a.porDominio.med.total, a.geral!.total);
        const semDominio = analisar(normalizarLinhas(referencia(), 'agro').map(p => ({ ...p })), 'oraculo');
        assert.deepEqual(Object.keys(semDominio.porDominio).sort(), ['fut', 'med'], 'o domínio da linha vence o padrão');
        const soPadrao = analisar(normalizarLinhas([{ linha: 1, intencao: 'x', arquitetura: lado('VALID', 'VALID') }], 'agro'), 'oraculo');
        assert.deepEqual(Object.keys(soPadrao.porDominio), ['agro']);
    });

    await teste('Arquitetura e Baseline ficam separados (nada se mistura entre os lados)', () => {
        const a = analisar(planos, 'oraculo_llm');
        const arq = a.porModelo.arquitetura!.comparacao!;
        const base = a.porModelo.baseline!.comparacao!;
        assert.deepEqual([arq.comparaveis, base.comparaveis], [4, 3]);
        assert.deepEqual([arq.concordancia.n, base.concordancia.n], [2, 2]);
        assert.equal(arq.comparaveis + base.comparaveis, a.geral!.comparacao!.comparaveis);
        assert.deepEqual([a.porModelo.arquitetura!.total, a.porModelo.baseline!.total], [6, 4]);
    });

    console.log('\n[normalização]');

    await teste('valor fora do vocabulário da fonte é descartado, nunca convertido', () => {
        const p = normalizarLinhas([{ linha: 1, intencao: 'x', arquitetura: lado('TALVEZ', 'SIM', { avaliacaoHumana: { classe: 'OK' } }) }]);
        assert.deepEqual(p[0].julgamentos, {});
        assert.equal(analisar(p, 'oraculo').disponivel, false);
    });

    await teste('por linha: só as fontes da opção, e "concorda" só na comparativa com as duas fontes', () => {
        const ol = analisar(planos, 'oraculo_llm').porLinha;
        assert.deepEqual(ol.find(l => l.linha === 2 && l.lado === 'arquitetura'), {
            linha: 2, lado: 'arquitetura', intencao: 'c2', naoAvaliado: false, dominio: 'fut', julgamentos: { oraculo: 'VALID', llmJudge: 'INVALID' }, concorda: false
        });
        assert.equal(ol.find(l => l.linha === 5)!.concorda, undefined, 'juiz NOT_CALLED: sem concordância');
        assert.deepEqual(Object.keys(analisar(planos, 'oraculo').porLinha[0].julgamentos), ['oraculo']);
    });

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main();
