/**
 * Documentação metodológica da sessão "Avaliação LLM" (src/inference/metodologia-avaliacao.ts).
 * Executar: npx tsx src/test/metodologia-avaliacao.test.ts
 *
 * Garante que a documentação cobre toda métrica exibida, que cada fórmula tem
 * variáveis, numerador e denominador, que os casos especiais (κ indefinido,
 * divisão por zero, UNRESOLVED, NO_RESPONSE, NOT_CALLED) estão tratados, que a
 * documentação acompanha a fonte e os filtros — e, no exemplo didático, que o
 * cálculo implementado bate com o cálculo feito à mão.
 */

import * as assert from 'node:assert/strict';

import { analisar, FORMULAS, METRICAS_POR_FONTE, normalizarLinhas, OPCOES_FONTE, SEM_DADOS_HUMANOS, type FonteAnalise, type LadoEntrada, type LinhaEntrada } from '../inference/analise-avaliacao.js';
import {
    aplicacaoDidatica,
    aplicarMetodologia,
    ASSINATURA_TEX,
    descreverFontes,
    DOCUMENTACAO,
    documentacao,
    EXEMPLO_DIDATICO,
    formatarNumero,
    linhasDoExemploDidatico,
    SECOES_METODOLOGIA,
    TEOREMA_NAO_APLICAVEL,
    TEX,
    type AplicacaoMetodologia
} from '../inference/metodologia-avaliacao.js';

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

/** Conjunto com tudo: as três classes, NOT_CALLED, NO_RESPONSE, não avaliado, dois modelos, avaliação humana. */
const COMPLETO: LinhaEntrada[] = [
    { linha: 1, intencao: 'a', arquitetura: lado('VALID', 'VALID', { avaliacaoHumana: { classe: 'CORRETO' } }), baseline: lado('INVALID', 'INVALID') },
    { linha: 2, intencao: 'b', arquitetura: lado('VALID', 'INVALID'), baseline: lado('INVALID', 'VALID') },
    { linha: 3, intencao: 'c', arquitetura: lado('UNRESOLVED', 'VALID'), baseline: lado('INVALID', 'NO_RESPONSE') },
    { linha: 4, intencao: 'd', arquitetura: lado('INVALID', 'NOT_CALLED') },
    { linha: 5, intencao: 'e', arquitetura: { naoAvaliado: true, julgamentoLLM: { status: 'VALID' } } }
];
const planos = normalizarLinhas(COMPLETO, 'fut');
const semHumano = normalizarLinhas(COMPLETO.map(l => ({ ...l, arquitetura: l.arquitetura && { ...l.arquitetura, avaliacaoHumana: undefined } })), 'fut');

const textoDe = (a: AplicacaoMetodologia) =>
    [a.recorte, ...a.passos.flatMap(p => [p.titulo, ...p.linhas, ...p.dados, ...p.equacoes.flatMap(e => [e.lhs, e.formula, e.substituicao, e.resultado, e.nota ?? ''])])].join('\n');
/** O resultado em LaTeX como texto simples: 0{,}690\;(69{,}0\%) → "0,690 (69,0%)". */
const texParaTexto = (t: string) => t.replace(/\{,\}/g, ',').replace(/\\;/g, ' ').replace(/\\%/g, '%').replace(/\\text\{([^}]*)\}/g, '$1');
const passo = (a: AplicacaoMetodologia, id: string) => a.passos.filter(p => p.id === id).flatMap(p => p.linhas).join('\n');

async function main(): Promise<void> {
    console.log('\n[1-4] cobertura e forma da documentação');

    await teste('1. toda métrica exibida (em qualquer fonte) tem documentação ativa', () => {
        for (const o of OPCOES_FONTE) {
            const analise = analisar(planos, o.id);
            const ap = aplicarMetodologia(analise);
            for (const m of analise.metricas) {
                assert.ok(ap.ativas.some(id => documentacao(id).metricas.includes(m)), `${o.id}: métrica ${m} sem documentação ativa`);
            }
            for (const p of ap.passos) {
                const d = documentacao(p.id);
                assert.ok(d.implementada, `${o.id}: passo ${p.id} aplica uma documentação não implementada`);
                assert.ok(ap.ativas.includes(p.id), `${o.id}: passo ${p.id} fora das documentações ativas`);
            }
        }
    });

    await teste('2. toda documentação tem fórmula, e toda função citada existe em FORMULAS', () => {
        for (const d of DOCUMENTACAO) {
            assert.ok(d.formula.length > 0 && d.formula.every(f => f.trim().length > 0), `${d.id} sem fórmula`);
            if (d.funcao) assert.equal(typeof FORMULAS[d.funcao], 'function', `${d.id}: FORMULAS.${d.funcao} não existe`);
        }
        const comCalculo = DOCUMENTACAO.filter(d => d.implementada && d.id !== 'matrizConfusao');
        assert.ok(comCalculo.every(d => d.funcao), 'toda métrica implementada (exceto a matriz, que é contagem) aponta a função que a calcula');
    });

    await teste('3. toda fórmula tem as variáveis descritas, e cada variável aparece na fórmula ou na definição de outra', () => {
        for (const d of DOCUMENTACAO) {
            assert.ok(d.variaveis.length > 0, `${d.id} sem variáveis`);
            const contexto = [...d.formula, ...(d.formaImplementada ?? []), ...d.variaveis.map(v => v.significado)].join(' ');
            for (const v of d.variaveis) {
                assert.ok(v.significado.trim().length > 0, `${d.id}: ${v.simbolo} sem significado`);
                const simbolo = v.simbolo.split(',')[0].trim();
                assert.ok(contexto.includes(simbolo), `${d.id}: a variável ${simbolo} não aparece na fórmula`);
            }
        }
        const kappa = documentacao('kappa').variaveis.map(v => v.simbolo);
        assert.ok(kappa.includes('P_o') && kappa.includes('P_e'));
    });

    await teste('4. todo cálculo tem numerador e denominador documentados', () => {
        for (const d of DOCUMENTACAO) {
            assert.ok(d.numerador && d.numerador.length > 0, `${d.id} sem numerador`);
            assert.ok(d.denominador && d.denominador.length > 0, `${d.id} sem denominador`);
            assert.ok(d.entram.length > 0 && d.ficamFora.length > 0, `${d.id} sem quem entra e quem sai`);
        }
    });

    console.log('\n[5, 11, 13] fonte selecionada');

    await teste('5. métricas sem significado na fonte não aparecem como ativas nem são aplicadas', () => {
        const o = aplicarMetodologia(analisar(planos, 'oraculo'));
        for (const id of ['kappa', 'matrizConfusao', 'precision', 'recall', 'f1', 'macroF1', 'concordancia', 'taxaRespostaJuiz', 'coberturaJuiz'] as const) {
            assert.ok(!o.ativas.includes(id), `oraculo: ${id} ativo`);
            assert.ok(o.semSignificado.includes(id), `oraculo: ${id} deveria estar em semSignificado`);
            assert.equal(passo(o, id), '', `oraculo: ${id} aplicado`);
        }
        const l = aplicarMetodologia(analisar(planos, 'llm'));
        assert.ok(!l.ativas.includes('matrizConfusao') && !l.ativas.includes('kappa'));
        const fontes = descreverFontes();
        assert.ok(fontes.find(f => f.id === 'oraculo')!.metricasSemSignificado.includes("Cohen's κ (kappa)"));
        assert.ok(fontes.find(f => f.id === 'oraculo_llm')!.metricasSemSignificado.length === 0);
    });

    await teste('11. trocar a fonte troca a documentação aplicável', () => {
        const ativas = (f: FonteAnalise) => aplicarMetodologia(analisar(planos, f)).ativas;
        assert.deepEqual(ativas('oraculo'), ['distribuicao', 'recortes']);
        assert.deepEqual(ativas('llm'), ['distribuicao', 'recortes', 'taxaRespostaJuiz', 'coberturaJuiz']);
        assert.ok(ativas('oraculo_llm').includes('kappa') && ativas('oraculo_llm').includes('matrizConfusao'));
        assert.deepEqual(ativas('humana'), ['distribuicao', 'recortes']);
        const o = aplicarMetodologia(analisar(planos, 'oraculo'));
        assert.ok(!textoDe(o).includes('LLM Judge') && !textoDe(o).includes('κ'), 'Apenas Oráculo não aplica nada do Judge nem κ');
    });

    await teste('13. Avaliação Humana sem dados: indisponível, sem passos e sem números inventados', () => {
        const h = aplicarMetodologia(analisar(semHumano, 'humana'));
        assert.equal(h.disponivel, false);
        assert.equal(h.motivoIndisponivel, SEM_DADOS_HUMANOS);
        assert.deepEqual(h.passos, []);
        assert.equal(h.contagens.nAvaliavel, null);
        assert.ok(SECOES_METODOLOGIA.find(s => s.id === 'avaliacaoHumana')!.itens.some(i => /nenhum valor humano/.test(i.texto)));
        const comDados = aplicarMetodologia(analisar(planos, 'humana'));
        assert.equal(comDados.disponivel, true);
        assert.match(passo(comDados, 'distribuicao'), /p_CORRETO = n_CORRETO \/ N_f = 1 \/ 1/);
        assert.match(passo(comDados, 'distribuicao'), /p_INCORRETO = n_INCORRETO \/ N_f = 0 \/ 1/, 'ausência não vira INCORRETO');
    });

    console.log('\n[6, 7] casos especiais');

    await teste('6. κ indefinido: P_e = 1 e N_comp = 0 explicados, sem NaN', () => {
        const umaClasse = normalizarLinhas([
            { linha: 1, intencao: 'a', arquitetura: lado('VALID', 'VALID') },
            { linha: 2, intencao: 'b', arquitetura: lado('VALID', 'VALID') }
        ]);
        const k1 = passo(aplicarMetodologia(analisar(umaClasse, 'oraculo_llm')), 'kappa');
        assert.match(k1, /κ não pode ser estimado neste conjunto porque P_e = 1/);
        const semPares = normalizarLinhas([{ linha: 1, intencao: 'a', arquitetura: lado('VALID', 'NOT_CALLED') }]);
        const k2 = passo(aplicarMetodologia(analisar(semPares, 'oraculo_llm')), 'kappa');
        assert.match(k2, /não há pares comparáveis \(N_comp = 0\)/);
        assert.ok(!/NaN|Infinity/.test(k1 + k2));
    });

    await teste('7. divisão por zero nunca vira NaN/Infinity; aparece como indefinido', () => {
        const cenarios = [planos, normalizarLinhas([]), normalizarLinhas([{ linha: 1, intencao: 'a', arquitetura: lado('VALID', 'VALID') }])];
        for (const p of cenarios) {
            for (const o of OPCOES_FONTE) {
                for (const filtro of [{}, { lado: 'baseline' as const }, { dominio: 'inexistente' }]) {
                    const t = textoDe(aplicarMetodologia(analisar(p, o.id, filtro), filtro));
                    assert.ok(!/NaN|Infinity|undefined/.test(t), `${o.id} ${JSON.stringify(filtro)}: ${t.match(/.*(NaN|Infinity|undefined).*/)?.[0]}`);
                }
            }
        }
        const precisao = passo(aplicarMetodologia(analisar(planos, 'oraculo_llm')), 'precision');
        assert.match(precisao, /Precision\(UNRESOLVED\) = n\(UNRESOLVED,UNRESOLVED\) \/ coluna_UNRESOLVED = 0 \/ 0 → indefinido/);
    });

    console.log('\n[8, 9, 10] UNRESOLVED, NO_RESPONSE, NOT_CALLED');

    const tratamento = SECOES_METODOLOGIA.find(s => s.id === 'tratamento')!.itens.map(i => i.texto).join('\n');

    await teste('8. UNRESOLVED: classe própria, nunca convertida em INVALID — na documentação e no cálculo', () => {
        assert.match(tratamento, /UNRESOLVED é uma classe própria: nunca é convertido em INVALID/);
        for (const id of ['concordancia', 'matrizConfusao', 'precision', 'recall', 'f1'] as const) {
            assert.ok(documentacao(id).casosEspeciais.some(c => c.includes('UNRESOLVED')), `${id} não trata UNRESOLVED`);
        }
        const m = passo(aplicarMetodologia(analisar(planos, 'oraculo_llm')), 'matrizConfusao');
        assert.match(m, /Oráculo UNRESOLVED: n\(UNRESOLVED,VALID\) = 1/, 'UNRESOLVED do Oráculo vira uma linha própria, não INVALID');
    });

    await teste('9. NO_RESPONSE: chamado e sem veredito — no denominador da taxa de resposta, fora da matriz', () => {
        assert.match(tratamento, /Falha do Judge: NO_RESPONSE/);
        assert.ok(documentacao('taxaRespostaJuiz').casosEspeciais.some(c => /NO_RESPONSE entra no denominador e não no numerador/.test(c)));
        const a = aplicarMetodologia(analisar(planos, 'oraculo_llm'));
        // estados do Judge: VALID x4 (inclui o não avaliado), INVALID x2, NO_RESPONSE x1, NOT_CALLED x1
        assert.match(passo(a, 'taxaRespostaJuiz'), /TR = V_J \/ C_J = 6 \/ 7/);
        assert.match(passo(a, 'coberturaComparacao'), /saem 2 com NOT_CALLED ou NO_RESPONSE/);
    });

    await teste('10. NOT_CALLED: não chamado — fora da taxa de resposta, dentro da cobertura, fora da matriz', () => {
        assert.match(tratamento, /Plano vazio: Oráculo INVALID \(origem: sintaxe\); Judge NOT_CALLED/);
        assert.ok(documentacao('taxaRespostaJuiz').ficamFora.includes('NOT_CALLED'));
        const a = aplicarMetodologia(analisar(planos, 'oraculo_llm'));
        assert.match(passo(a, 'coberturaJuiz'), /Cob_J = V_J \/ N = 6 \/ 8/, 'N = todos os planos do recorte');
        assert.match(passo(a, 'distribuicao'), /p_NOT_CALLED = n_NOT_CALLED \/ N_f = 1 \/ 8/);
    });

    console.log('\n[12] filtros');

    await teste('12. filtros mudam N, a frase do recorte e os denominadores', () => {
        const todos = aplicarMetodologia(analisar(planos, 'oraculo_llm'));
        const filtro = { lado: 'baseline' as const };
        const base = aplicarMetodologia(analisar(planos, 'oraculo_llm', filtro), filtro);
        assert.match(todos.recorte, /sobre 8 plano\(s\) sem filtros/);
        assert.match(base.recorte, /sobre 3 plano\(s\) após os filtros atuais \(Modelo: Baseline\)/);
        assert.deepEqual([todos.contagens.nBruto, base.contagens.nBruto], [8, 3]);
        assert.match(passo(base, 'concordancia'), /\/ 2 = /, 'denominador do recorte: 2 pares comparáveis na Baseline');
        assert.notEqual(passo(base, 'kappa'), passo(todos, 'kappa'));
    });

    console.log('\n[34, 36] consistência com o cálculo e exemplo didático');

    await teste('os números aplicados são os da análise exibida (mesmas funções, mesmos valores)', () => {
        const analise = analisar(planos, 'oraculo_llm');
        const c = analise.geral!.comparacao!;
        const a = aplicarMetodologia(analise);
        assert.ok(passo(a, 'kappa').includes(`= ${formatarNumero(c.kappa.valor)}`), 'κ aplicado = κ da análise');
        assert.ok(passo(a, 'macroF1').includes(`= ${formatarNumero(c.macroF1.valor)}`), 'macro F1 aplicado = da análise');
        assert.ok(passo(a, 'concordancia').includes(`${c.concordancia.n} / ${c.concordancia.denominador}`));
        assert.equal(FORMULAS.kappa(c.kappa.po, c.kappa.pe), c.kappa.valor);
    });

    await teste('36. exemplo didático: o implementado bate com o cálculo à mão', () => {
        assert.deepEqual(EXEMPLO_DIDATICO.map(e => `${e.oraculo}/${e.judge}`), ['VALID/VALID', 'VALID/INVALID', 'INVALID/INVALID', 'INVALID/VALID', 'UNRESOLVED/UNRESOLVED']);
        // À mão: diagonal 1+1+1 = 3 de 5; linhas V2 I2 U1; colunas V2 I2 U1.
        const manual = {
            accuracy: 3 / 5,
            precision: { VALID: 1 / 2, INVALID: 1 / 2, UNRESOLVED: 1 },
            recall: { VALID: 1 / 2, INVALID: 1 / 2, UNRESOLVED: 1 },
            f1: { VALID: (2 * 0.5 * 0.5) / (0.5 + 0.5), INVALID: 0.5, UNRESOLVED: 1 },
            macroF1: (0.5 + 0.5 + 1) / 3,
            po: 3 / 5,
            pe: (2 / 5) * (2 / 5) + (2 / 5) * (2 / 5) + (1 / 5) * (1 / 5),
            kappa: (3 / 5 - 9 / 25) / (1 - 9 / 25)
        };
        const c = analisar(normalizarLinhas(linhasDoExemploDidatico()), 'oraculo_llm').geral!.comparacao!;
        const perto = (a: number | null, b: number, nome: string) => assert.ok(a !== null && Math.abs(a - b) < 1e-12, `${nome}: implementado ${a}, à mão ${b}`);
        perto(c.concordancia.percentual! / 100, manual.accuracy, 'Accuracy');
        for (const k of ['VALID', 'INVALID', 'UNRESOLVED'] as const) {
            perto(c.porClasse[k].precision.percentual! / 100, manual.precision[k], `Precision ${k}`);
            perto(c.porClasse[k].recall.percentual! / 100, manual.recall[k], `Recall ${k}`);
            perto(c.porClasse[k].f1, manual.f1[k], `F1 ${k}`);
        }
        perto(c.macroF1.valor, manual.macroF1, 'Macro F1');
        perto(c.kappa.po, manual.po, 'P_o');
        perto(c.kappa.pe, manual.pe, 'P_e');
        perto(c.kappa.valor, manual.kappa, 'κ');
        assert.equal(manual.kappa, 0.375);
        const t = textoDe(aplicacaoDidatica());
        for (const esperado of ['A = Σ n(c,c) / N_comp = (1 + 1 + 1) / 5 = 3 / 5 = 0,600', 'MacroF1 = (F1(VALID) + F1(INVALID) + F1(UNRESOLVED)) / 3 = (0,500 + 0,500 + 1,000) / 3 = 0,667', '= 0,1600 + 0,1600 + 0,0400 = 0,3600', '= 0,375']) {
            assert.ok(t.includes(esperado), `exemplo didático sem: ${esperado}`);
        }
    });

    console.log('\n[3, 32] rigor dos fundamentos');

    await teste('nada de "ground truth"; teorema só onde há um teorema de verdade; todo item tem natureza ou é texto corrido', () => {
        const tudo = JSON.stringify({ DOCUMENTACAO, SECOES_METODOLOGIA });
        assert.ok(!/ground truth/i.test(tudo), 'o Oráculo não é chamado de ground truth');
        for (const d of DOCUMENTACAO) {
            assert.ok(d.teorema.length > 0, `${d.id} sem campo teorema`);
            for (const f of d.fundamentos.filter(x => x.natureza === 'teorema')) assert.match(f.texto, /[Dd]esigualdade entre as médias/, `${d.id}: teorema sem nome real`);
        }
        const semTeorema = DOCUMENTACAO.filter(d => d.id !== 'f1' && d.id !== 'kappa');
        assert.ok(semTeorema.every(d => d.teorema === TEOREMA_NAO_APLICAVEL), 'métricas definidas declaram "Teorema específico: não aplicável"');
        assert.match(documentacao('kappa').teorema, /^Teorema específico: não aplicável/);
        assert.ok(documentacao('kappa').fundamentos.some(f => f.natureza === 'convencao' && /não classifica o \$\\kappa\$ em faixas/.test(f.texto)));
        assert.ok(!METRICAS_POR_FONTE.oraculo_llm.includes('microF1' as never), 'micro-F1 não é métrica da análise');
        assert.ok(!documentacao('microF1').implementada && !documentacao('balancedAccuracy').implementada);
    });

    console.log('\n[LaTeX] fórmula exibida = fórmula calculada');

    await teste('a fórmula de cada métrica contém a assinatura LaTeX da função de FORMULAS que a calcula', () => {
        for (const d of DOCUMENTACAO) {
            // Os recortes aplicam uma métrica M genérica a um subconjunto: não têm fórmula própria.
            if (!d.funcao || d.id === 'recortes') continue;
            const tex = [...d.formula, ...(d.formaImplementada ?? [])].join('\n');
            assert.ok(tex.includes(ASSINATURA_TEX[d.funcao]), `${d.id}: a fórmula não contém a assinatura de FORMULAS.${d.funcao}`);
        }
        const kappa = documentacao('kappa').formula.join('\n');
        assert.ok(kappa.includes(String.raw`\frac{P_o - P_e}{1 - P_e}`), 'κ exibido = (P_o − P_e)/(1 − P_e), como em FORMULAS.kappa');
        assert.ok(kappa.includes(ASSINATURA_TEX.acordoEsperado), 'P_e exibido = Σ (linha_c/N)(coluna_c/N), como em FORMULAS.acordoEsperado');
        assert.ok(documentacao('macroF1').formula.join('').includes(String.raw`C^{*}`), 'Macro F1 sobre C* (classes com F1 definido), como em mediaDosDefinidos');
    });

    await teste('a substituição com os dados usa a MESMA fórmula da documentação (construtores de TEX)', () => {
        const a = aplicarMetodologia(analisar(planos, 'oraculo_llm'));
        const formulas = (id: string) => a.passos.filter(p => p.id === id).flatMap(p => p.equacoes.map(e => e.formula));
        assert.ok(formulas('kappa').includes(TEX.kappa.rhs) && formulas('kappa').includes(TEX.pe.rhs) && formulas('kappa').includes(TEX.po.rhs));
        assert.ok(formulas('precision').includes(TEX.precision(String.raw`\text{VALID}`).rhs));
        assert.ok(formulas('recall').includes(TEX.recall(String.raw`\text{UNRESOLVED}`).rhs));
        assert.ok(formulas('f1').includes(TEX.f1(String.raw`\text{INVALID}`).rhs));
        assert.ok(formulas('macroF1').includes(TEX.macroF1.rhs));
        assert.ok(formulas('concordancia').includes(TEX.concordancia.rhs));
        assert.ok(documentacao('f1').formaImplementada!.join('').includes(TEX.f1().rhs), 'a forma implementada documentada é a usada na substituição');
    });

    await teste('cada resultado em LaTeX repete o número da versão textual do mesmo passo', () => {
        const cenarios = [planos, normalizarLinhas(linhasDoExemploDidatico()), normalizarLinhas([{ linha: 1, intencao: 'a', arquitetura: lado('VALID', 'VALID') }])];
        let conferidos = 0;
        for (const p of cenarios) {
            for (const o of OPCOES_FONTE) {
                for (const passoAplicado of aplicarMetodologia(analisar(p, o.id)).passos) {
                    const texto = passoAplicado.linhas.join('\n');
                    for (const e of passoAplicado.equacoes) {
                        const r = texParaTexto(e.resultado);
                        if (r === 'indefinido') assert.ok(/indefinido|não pode ser estimado/.test(texto), `${passoAplicado.id}: indefinido sem explicação textual`);
                        else assert.ok(texto.includes(r), `${passoAplicado.id}: resultado ${r} ausente da versão textual:\n${texto}`);
                        conferidos++;
                    }
                }
            }
        }
        assert.ok(conferidos > 50, `poucas equações conferidas: ${conferidos}`);
    });

    await teste('todo passo aplicado traz os dados; só os casos indefinidos ficam sem equação', () => {
        for (const o of OPCOES_FONTE) {
            for (const p of aplicarMetodologia(analisar(planos, o.id)).passos) {
                assert.ok(p.dados.length > 0, `${o.id}/${p.id} sem dados`);
                assert.ok(p.equacoes.length > 0, `${o.id}/${p.id} sem equação`);
            }
        }
        const semPares = aplicarMetodologia(analisar(normalizarLinhas([{ linha: 1, intencao: 'a', arquitetura: lado('VALID', 'NOT_CALLED') }]), 'oraculo_llm'));
        assert.deepEqual(semPares.passos.find(p => p.id === 'kappa')!.equacoes, [], 'sem pares comparáveis, nenhuma equação de κ é inventada');
    });

    await teste('exemplo didático em LaTeX: A = 0,600; MacroF1 = 0,667; P_e = 0,3600; κ = 0,375', () => {
        const eq = (id: string, lhs: string) => aplicacaoDidatica().passos.find(p => p.id === id)!.equacoes.find(e => e.lhs === lhs)!.resultado;
        assert.equal(eq('concordancia', 'A'), String.raw`0{,}600\;(60{,}0\%)`);
        assert.equal(eq('macroF1', TEX.macroF1.lhs), '0{,}667');
        assert.equal(eq('kappa', 'P_e'), '0{,}3600');
        assert.equal(eq('kappa', TEX.kappa.lhs), '0{,}375');
    });

    await teste('delimitadores de matemática em linha balanceados em todo texto corrido', () => {
        const textos = [
            ...DOCUMENTACAO.flatMap(d => [
                d.oQueMede, d.numerador ?? '', d.denominador ?? '', d.entram, d.ficamFora, d.teorema, d.justificativa,
                ...d.casosEspeciais, ...d.pressupostos, ...d.limitacoes, ...d.fundamentos.map(f => f.texto), ...d.variaveis.map(v => v.significado)
            ]),
            ...SECOES_METODOLOGIA.flatMap(s => s.itens.map(i => i.texto)),
            ...aplicarMetodologia(analisar(planos, 'oraculo_llm')).passos.flatMap(p => [...p.dados, ...p.equacoes.map(e => e.nota ?? '')])
        ];
        for (const t of textos) assert.equal((t.replace(/\$\$[\s\S]*?\$\$/g, '').match(/\$/g) ?? []).length % 2, 0, `$ desbalanceado: ${t}`);
    });

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main();
