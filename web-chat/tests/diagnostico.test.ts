/**
 * Tela do diagnóstico da indeterminação do LLM Judge (DiagnosticoJuiz.vue,
 * dentro de AvaliacaoLado.vue).
 * Executar (da raiz): npm run test:web-diagnostico
 *
 * O painel REAL é renderizado no servidor pelo Vite (SFC + TypeScript) e pelo
 * `vue/server-renderer`, e o HTML é conferido. Os diagnósticos vêm do backend
 * de verdade (`validarDiagnostico` / `diagnosticarIndeterminacao`, com o
 * diagnosticador dublê), serializados como a API e o JSONL os entregam.
 *
 * O que se cobra:
 *   1. diagnóstico completo: as cinco seções, com evidência observada separada
 *      da alegação do pedido e cada informação ausente ligada à regra;
 *   2. campos ausentes, listas vazias ou malformadas: a seção não quebra;
 *   3. avaliação antiga (sem diagnóstico): nada muda no painel;
 *   4. UNRESOLVED preservado no cabeçalho e no resultado; o oráculo intacto;
 *   5. caminhos VALID e INVALID separados e marcados como condicionais;
 *   6. falha do diagnóstico: aviso na seção, avaliação original visível;
 *   7. o contrato do backend cabe no da tela (tipo, verificado pelo vue-tsc,
 *      e valores: nenhum item do backend se perde na vista).
 */

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { createServer } from 'vite';

import { parseRegistrosAvaliacao } from '../../src/inference/avaliacao-jsonl.js';
import type { JulgamentoLLM as JulgamentoDoBackend } from '../../src/inference/avaliar-grafo.js';
import {
    catalogoDeFundamentacao,
    diagnosticarIndeterminacao,
    validarDiagnostico,
    type DiagnosticoIndeterminacao as DiagnosticoDoBackend
} from '../../src/inference/diagnostico-juiz.js';
import type { RegraValidada } from '../../src/knowledge/recuperacao-cypher.js';
import type { DetalheLado, DiagnosticoIndeterminacao, JulgamentoLLM } from '../src/api';
import { vistaDoDiagnostico } from '../src/diagnostico';

// 7 (tipo): o que o backend grava cabe no que a tela lê. Quebrou o contrato, o vue-tsc acusa aqui.
type Atribuivel<A, B> = [A] extends [B] ? true : false;
const diagnosticoCabeNaTela: Atribuivel<DiagnosticoDoBackend, DiagnosticoIndeterminacao> = true;
const julgamentoCabeNaTela: Atribuivel<JulgamentoDoBackend, JulgamentoLLM> = true;

let falhas = 0;
let contagem = 0;
async function teste(nome: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        contagem++;
        console.log(`  ok   ${nome}`);
    } catch (erro) {
        contagem++;
        falhas++;
        console.log(`  FALHA ${nome}\n       ${(erro as Error).message}`);
    }
}

// ---------------------------------------------------------------------------
// Diagnósticos de verdade, do backend, num catálogo clínico com os quatro graus
// ---------------------------------------------------------------------------

function regraCypher(r: Partial<RegraValidada> & Pick<RegraValidada, 'regraId' | 'item'>): RegraValidada {
    return {
        tipo: 'RegraSeguranca', relacao: 'BLOQUEIA_INCREMENTO', dominio: 'med', aplicavel: false,
        condicoesSatisfeitas: [], condicoesFalhas: [], lacunas: [], evidencia: {},
        validacaoCypher: { valida: false, motivo: '', consulta: '' }, efeito: {},
        rag: { candidatoId: `Farmaco:${r.item}`, escore: 0.9, cosseno: 0.8, papel: 'item', posicao: 0 },
        ...r
    };
}
const R_PAM = 'Farmaco:Propofol/RegraSeguranca/PAM<60';
const R_TFG = 'Farmaco:Vancomicina/AjusteRenal/TFG<30';
const R_INTERACAO = 'relacional:Noradrenalina + Propofol';
const R_GLOBAL = 'regra_global#1';
const CATALOGO = catalogoDeFundamentacao(
    'med',
    { PAM: 52, FC: 145 },
    {
        interacoes: [{ entre: 'Noradrenalina + Propofol', gravidade: 'alta', mecanismo: 'hipotensao aditiva', conduta: 'monitorar PAM' }],
        regrasGlobais: [{ descricao: 'toda titulacao exige reavaliacao clinica registrada', severidade: 'alta' }]
    },
    [
        regraCypher({ regraId: R_PAM, item: 'Propofol', aplicavel: true, condicoesSatisfeitas: [{ campo: 'PAM', observado: 52, esperado: '< 60', operador: '<', limite: 60, unidade: 'mmHg', satisfeita: true }] }),
        regraCypher({ regraId: R_TFG, item: 'Vancomicina', lacunas: [{ campo: 'TFG', esperado: '< 30', motivo: "o cenario nao mediu 'TFG'" }] })
    ]
);
/** Só regra em texto: o catálogo tem limitações determinísticas (nenhuma regra formal, nenhum campo sem valor). */
const CATALOGO_SO_TEXTO = catalogoDeFundamentacao('med', { PAM: 52 }, { regrasGlobais: [{ descricao: 'toda titulacao exige reavaliacao clinica registrada', severidade: 'alta' }] }, []);
const PEDIDO = 'A pressao ta despencando (PAM=52), sobe a nora e aprofunda o propofol';
const PLANO = "plano P para Choque_Septico { esquema_referencia AssistenteUTI_v2 paciente 'PT-TESTE-0001' sequencia [ Titular_Vasopressor ] ordem Propofol decisao MANTER_BLOQUEADO dose 0.0 mg/kg/h via ACESSO_CENTRAL auditoria 'a' }";
const FONTES = { pedido: PEDIDO, plano: PLANO, julgamento: 'falta a TFG para concluir' };

const RESPOSTA_DO_MODELO = {
    evidenciasDisponiveis: [
        { fonte: 'telemetria', referencia: 'PAM', descricao: 'PAM 52 mmHg medida no cenario' },
        { fonte: 'pedido', referencia: 'aprofunda o propofol', descricao: 'o pedido quer aprofundar a sedacao' },
        { fonte: 'regra', referencia: R_PAM, descricao: 'o bloqueio por PAM < 60 incide' }
    ],
    regrasAfetadas: [
        { regra: R_TFG, motivo: 'o ajuste renal depende da TFG' },
        { regra: R_GLOBAL, motivo: 'a reavaliacao exigida so existe como texto' }
    ],
    informacoesAusentes: [
        { tipo: 'campo_sem_valor', referencia: 'TFG', regra: R_TFG, descricao: 'sem a TFG nao se sabe se o ajuste renal incide' },
        { tipo: 'evidencia_insuficiente', referencia: 'PAM', regra: R_PAM, descricao: 'uma unica medida nao mostra a tendencia' },
        { tipo: 'fato_nao_observado', referencia: 'resposta a reposicao volemica', regra: R_PAM, descricao: 'nenhum campo registra a reposicao' },
        { tipo: 'regra_nao_formalizada', referencia: R_GLOBAL, regra: R_GLOBAL, descricao: 'a reavaliacao nao tem condicao estruturada' }
    ],
    motivo: 'sem a TFG, o juiz nao decide se o ajuste renal da vancomicina incide',
    caminhosPossiveis: [
        { resultado: 'VALID', condicoes: 'TFG medida >= 30 e o Propofol mantido bloqueado', regras: [R_TFG, R_PAM] },
        { resultado: 'INVALID', condicoes: 'risco da combinacao com a noradrenalina demonstrado', regras: [R_INTERACAO] },
        { resultado: 'UNRESOLVED', condicoes: 'mesmo com a TFG, a reavaliacao clinica so existe como texto', regras: [R_GLOBAL] },
        { resultado: 'VALID', condicoes: 'se a regra inventada valesse', regras: ['Farmaco:Inventado/Regra'] }
    ],
    incertezaRemanescente: 'a reavaliacao clinica continua sem criterio formal',
    limitacoes: ['a tendencia da PAM nao esta no cenario']
};

/** Como a API e o JSONL entregam: JSON serializado e lido de volta. */
const serializado = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const COMPLETO = serializado(validarDiagnostico({ respostaBruta: JSON.stringify(RESPOSTA_DO_MODELO) }, CATALOGO, FONTES));
const MALFORMADO = serializado(validarDiagnostico({ respostaBruta: 'o plano esta indeterminado porque falta a TFG' }, CATALOGO, FONTES));

const JULGAMENTO_BASE: JulgamentoLLM = {
    status: 'UNRESOLVED',
    justificativa: 'falta a TFG para concluir sobre a Vancomicina',
    evidencias: ['PAM = 52'],
    respostaBruta: 'evidencias: PAM = 52\njustificativa: falta a TFG para concluir sobre a Vancomicina\nveredito: UNRESOLVED'
};

function ladoCom(julgamento: JulgamentoLLM, diagnosticoMs?: number): DetalheLado {
    return {
        plano: PLANO,
        sujeito: 'PT-TESTE-0001',
        naoAvaliado: false,
        validacaoSintatica: { veredito: 'VALID', erros: [], pecas: { gramatica: 'ACEITO', parser: 'ACEITO' } },
        validacaoSemantica: { veredito: 'VALID', erros: [], avisos: [], dadosFaltantes: [], etapas: [], naoFormalizado: [] },
        oraculo: { veredito: 'VALID', origem: 'semantica' },
        julgamentoLLM: julgamento,
        concordancia: false,
        classificacao: 'DISCORDANCIA_LLM',
        tempos: { sintaxeMs: 1, recuperacaoMs: 2, oraculoMs: 3, llmJudgeMs: 40, ...(diagnosticoMs !== undefined ? { diagnosticoMs } : {}), paraleloMs: 121, totalMs: 130 }
    };
}
const comDiagnostico = (diagnostico: unknown, ms?: number): DetalheLado => ladoCom({ ...JULGAMENTO_BASE, diagnostico: diagnostico as DiagnosticoIndeterminacao }, ms);

/** O trecho do HTML da seção de diagnóstico (vazio se não há). */
function secao(html: string): string {
    const inicio = html.indexOf('data-diagnostico');
    if (inicio < 0) return '';
    const abre = html.lastIndexOf('<section', inicio);
    let profundidade = 0;
    const re = /<section\b|<\/section>/g;
    re.lastIndex = abre;
    for (let m = re.exec(html); m; m = re.exec(html)) {
        profundidade += m[0] === '</section>' ? -1 : 1;
        if (profundidade === 0) return html.slice(abre, re.lastIndex);
    }
    throw new Error('secao de diagnostico sem fechamento');
}
/** O HTML sem a seção de diagnóstico, para comparar com o painel sem ela (o Vue deixa `<!---->` no lugar de um v-if falso). */
const semSecao = (html: string): string => (secao(html) ? html.replace(secao(html), '<!---->') : html);
/** Texto visível, sem tags e com as entidades do SSR desfeitas. */
const texto = (html: string): string =>
    html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

async function main(): Promise<void> {
    const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const vite = await createServer({
        root: raiz, configFile: false, plugins: [vue()], logLevel: 'error', appType: 'custom',
        server: { middlewareMode: true, hmr: false, ws: false }
    });
    try {
        const { renderizarLado } = (await vite.ssrLoadModule('/tests/renderizar.ts')) as typeof import('./renderizar');

        console.log('\nDiagnostico na tela (AvaliacaoLado.vue -> DiagnosticoJuiz.vue)');

        await teste('7 — o contrato do backend cabe no da tela: tipo (vue-tsc) e valores (nenhum item do backend some na vista)', () => {
            assert.equal(diagnosticoCabeNaTela && julgamentoCabeNaTela, true);
            assert.equal(COMPLETO.status, 'DIAGNOSED', JSON.stringify(COMPLETO.referenciasRejeitadas));
            const v = vistaDoDiagnostico({ ...JULGAMENTO_BASE, diagnostico: COMPLETO })!;
            assert.equal(v.regrasAfetadas.length, COMPLETO.regrasAfetadas!.length);
            assert.equal(v.evidencias.flatMap(g => g.itens).length, COMPLETO.evidenciasDisponiveis!.length);
            assert.equal(v.informacoesAusentes.length, COMPLETO.informacoesAusentes!.length);
            assert.equal(v.caminhos.flatMap(c => c.itens).length, COMPLETO.caminhosPossiveis!.length);
            assert.equal(v.limitacoesConhecimento.length + v.limitacoesModelo.length, COMPLETO.limitacoes.length);
            assert.equal(v.referenciasRejeitadas.length, COMPLETO.referenciasRejeitadas!.length);
        });

        await teste('1 — diagnostico completo: as cinco secoes, evidencia observada separada da alegacao do pedido, cada ausencia ligada a regra', async () => {
            const html = await renderizarLado(comDiagnostico(COMPLETO, 80));
            const s = secao(html);
            assert.ok(s, 'a secao aparece');
            assert.match(s, /data-status="DIAGNOSED"/);
            for (const nome of ['motivo', 'evidencias', 'ausentes', 'caminhos', 'limitacoes', 'auditoria']) assert.match(s, new RegExp(`data-secao="${nome}"`), nome);
            const t = texto(s);
            assert.match(t, /Diagnóstico da indeterminação experimental · explicativo/);
            assert.match(t, /Não é decisão do oráculo, não muda nenhum veredito/);
            assert.match(t, /Motivo da indeterminação sem a TFG, o juiz nao decide/);
            assert.match(t, new RegExp(`${R_TFG.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} regra formal — o ajuste renal depende da TFG`));
            assert.match(t, /regra_global#1 só texto — a reavaliacao exigida/);
            // Evidências: observado, conhecimento e alegação em grupos distintos, nessa ordem.
            const observado = t.indexOf('Observado na leitura do cenário PAM — PAM 52 mmHg');
            const conhecimento = t.indexOf('Do conhecimento recuperado Farmaco:Propofol');
            const alegado = t.indexOf('Alegado no pedido — não é leitura do cenário “aprofunda o propofol”');
            assert.ok(observado >= 0 && conhecimento > observado && alegado > conhecimento, `${observado} ${conhecimento} ${alegado}`);
            // O que falta: os quatro tipos, com o porquê e a regra associada.
            assert.match(t, /Campo sem valor TFG Por que importa: sem a TFG nao se sabe se o ajuste renal incide .*associado a Farmaco:Vancomicina\/AjusteRenal\/TFG<30 \(regra formal\)/);
            for (const rotulo of ['Evidência insuficiente PAM', 'Fato não observado resposta a reposicao volemica', 'Regra não formalizada regra_global#1']) assert.ok(t.includes(rotulo), rotulo);
            assert.match(t, /Incertezas e limitações a reavaliacao clinica continua sem criterio formal/);
            assert.match(t, /Do conhecimento recuperado \(determinístico\) .*regra\(s\) so em texto livre/);
            assert.match(t, /Apontadas pelo modelo a tendencia da PAM nao esta no cenario/);
            // Auditoria: tempo, a referência rejeitada e a resposta bruta, recolhidos num <details>.
            assert.match(s, /<details[^>]*data-secao="auditoria"/);
            assert.match(t, /Tempo do diagnóstico: 80 ms \(fora do tempo do LLM Judge\)/);
            assert.match(t, /Farmaco:Inventado\/Regra \(caminhosPossiveis\)/);
            assert.ok(t.indexOf('"evidenciasDisponiveis"') > t.indexOf('Resposta bruta do diagnóstico'), 'o JSON bruto so aparece na auditoria');
            assert.ok(!t.slice(0, t.indexOf('Auditoria do diagnóstico')).includes('"evidenciasDisponiveis"'), 'o JSON bruto nao e a apresentacao principal');
        });

        await teste('5 — caminhos VALID, INVALID e UNRESOLVED em blocos separados, cada um marcado como condicional', async () => {
            const s = secao(await renderizarLado(comDiagnostico(COMPLETO)));
            const blocos = [...s.matchAll(/<div[^>]*class="([^"]*)"[^>]*data-caminho="([A-Z]+)"/g)].map(m => [m[2], m[1]]);
            assert.deepEqual(blocos.map(b => b[0]), ['VALID', 'INVALID', 'UNRESOLVED']);
            const tem = (classes: string, ...prefixos: string[]): boolean => prefixos.every(p => classes.split(/\s+/).some(c => c.startsWith(p)));
            assert.ok(tem(blocos[0][1], 'border-dashed', 'border-emerald'), blocos[0][1]);
            assert.ok(tem(blocos[1][1], 'border-dashed', 'border-rose'), blocos[1][1]);
            assert.ok(tem(blocos[2][1], 'border-dashed', 'border-sky'), blocos[2][1]);
            const t = texto(s);
            assert.match(t, /Caminho para VÁLIDO condicional condições que precisariam ser satisfeitas TFG medida >= 30 .*sustentado por .*TFG<30 , .*PAM<60 regra formal/);
            assert.match(t, /Caminho para INVÁLIDO condicional violação formal que precisaria ser demonstrada risco da combinacao .*sustentado por relacional:Noradrenalina \+ Propofol parcialmente estruturada/);
            assert.match(t, /Permanência em INDETERMINADO condicional por que a informação adicional pode não bastar/);
            const caminhos = texto(s.slice(s.indexOf('data-secao="caminhos"'), s.indexOf('data-secao="limitacoes"')));
            assert.ok(!caminhos.includes('se a regra inventada valesse'), 'o caminho sem fundamentacao (rejeitado no backend) nao e desenhado como caminho');
            assert.match(texto(s.slice(s.indexOf('data-secao="auditoria"'))), /se a regra inventada valesse/, '...mas continua auditavel na resposta bruta');
        });

        await teste('4 — UNRESOLVED preservado no cabecalho e no resultado; oraculo e classificacao intactos; o painel fora da secao e o mesmo de sem diagnostico', async () => {
            const html = await renderizarLado(comDiagnostico(COMPLETO, 80));
            const semDiag = await renderizarLado(ladoCom(JULGAMENTO_BASE, 80));
            const fora = texto(semSecao(html));
            assert.match(fora, /oráculo VÁLIDO · LLM INDETERMINADO · ⚠ discordância/);
            assert.match(fora, /Oráculo \(normativo\): VÁLIDO/);
            assert.match(fora, /LLM Judge \(experimental\): INDETERMINADO/);
            assert.match(fora, /Classificação: DISCORDANCIA_LLM \(discordância do LLM\)/);
            assert.match(fora, /LLM Judge INDETERMINADO independente/);
            assert.ok(!fora.includes('LLM VÁLIDO') && !fora.includes('LLM INVÁLIDO'), 'nenhum caminho vira veredito');
            assert.equal(semSecao(html), semDiag, 'fora da secao, o painel e identico ao de sem diagnostico');
            assert.match(texto(secao(html)), /ficou INDETERMINADO — e ele continua INDETERMINADO/);
        });

        await teste('2 — campos ausentes, listas vazias ou malformadas (JSONL editado): a secao aparece e nao quebra', async () => {
            const parcial = { status: 'DIAGNOSED', limitacoes: [], regrasAfetadas: [{ regra: R_TFG, formalizacao: 'formal', motivo: 'x' }] };
            const t = texto(secao(await renderizarLado(comDiagnostico(parcial))));
            assert.match(t, /O diagnóstico não trouxe o motivo\./);
            assert.match(t, /Nenhuma evidência citada\./);
            assert.match(t, /O diagnóstico não apontou informação específica a registrar\./);
            assert.match(t, /Nenhum caminho condicional fundamentado no conhecimento recuperado\./);
            assert.ok(!t.includes('Incertezas e limitações') && !t.includes('Auditoria do diagnóstico'), 'secoes sem conteudo nao aparecem vazias');

            const lixo = {
                status: 'DIAGNOSED', motivoIndeterminacao: 42, regrasAfetadas: 'R', evidenciasDisponiveis: [null, { fonte: 'boato', referencia: 'x' }, { fonte: 'telemetria' }],
                informacoesAusentes: [{ tipo: 'palpite', referencia: 'x' }, { tipo: 'campo_sem_valor' }], caminhosPossiveis: [{ resultado: 'PROVAVEL', condicoes: 'x' }, { resultado: 'VALID', regras: 3 }],
                limitacoes: 'nenhuma', referenciasRejeitadas: {}
            };
            const tl = texto(secao(await renderizarLado(comDiagnostico(lixo))));
            assert.match(tl, /Nenhuma evidência citada\. .*não apontou informação específica .*Nenhum caminho condicional/);
            assert.ok(!tl.includes('PROVAVEL') && !tl.includes('boato') && !tl.includes('palpite'), 'nada fora do contrato e desenhado');
        });

        await teste('3 — avaliacao antiga (JSONL sem diagnostico): painel identico, sem secao; e o juiz VALID nunca mostra diagnostico', async () => {
            const linha = JSON.stringify({ dominio: 'med', lado: 'arquitetura', linha: 1, intencao: PEDIDO, ...ladoCom(JULGAMENTO_BASE) });
            const [registro] = parseRegistrosAvaliacao(linha);
            // O mesmo repasse de ResultadosImportados.vue (`detalhe`): o registro espalhado no lado.
            const antigo = { ...(registro as unknown as DetalheLado), tempos: { ...ladoCom(JULGAMENTO_BASE).tempos!, diagnosticoMs: undefined } };
            const html = await renderizarLado(antigo);
            assert.equal(secao(html), '');
            assert.ok(!html.includes('Diagnóstico da indeterminação'));
            assert.match(texto(html), /LLM Judge INDETERMINADO .*Resposta bruta/);
            assert.equal(vistaDoDiagnostico(antigo.julgamentoLLM), null);

            const valid = await renderizarLado(ladoCom({ status: 'VALID', justificativa: 'ok', diagnostico: COMPLETO }));
            assert.equal(secao(valid), '', 'diagnostico so com UNRESOLVED');
            const naoChamado = await renderizarLado(ladoCom({ status: 'NOT_CALLED', motivo: 'sintaxe INVALID' }));
            assert.equal(secao(naoChamado), '');
            assert.equal(secao(await renderizarLado(comDiagnostico({ status: 'OUTRO' }))), '', 'status desconhecido: sem secao');
        });

        await teste('6 — falha do diagnostico (NO_RESPONSE, MALFORMED): aviso na secao, sem conteudo inventado; a avaliacao original continua toda visivel', async () => {
            const semResposta = serializado(await diagnosticarIndeterminacao(
                { juiz: { plano: PLANO, pedido: PEDIDO, telemetria: '- PAM = 52', conhecimento: '[CENARIO]', evidencias: '' }, julgamento: { justificativa: 'falta a TFG', evidencias: [] }, catalogo: CATALOGO_SO_TEXTO },
                async () => { throw new Error('motor (http://127.0.0.1:8000) inacessivel: sem resposta em 600s'); },
                new AbortController().signal
            ));
            const referencia = await renderizarLado(ladoCom(JULGAMENTO_BASE, 12));
            for (const [nome, diag] of [['NO_RESPONSE', semResposta], ['MALFORMED', MALFORMADO]] as const) {
                assert.equal(diag.status, nome);
                const html = await renderizarLado(comDiagnostico(diag, 12));
                const s = secao(html);
                const t = texto(s);
                assert.match(s, new RegExp(`data-status="${nome}"`), nome);
                assert.match(t, /O julgamento do juiz e o resultado do oráculo acima não são afetados\./, nome);
                for (const conteudo of ['motivo', 'evidencias', 'ausentes', 'caminhos']) assert.ok(!s.includes(`data-secao="${conteudo}"`), `${nome}: sem ${conteudo}`);
                // As limitações do conhecimento são determinísticas: valem mesmo sem resposta, quando o catálogo as tem.
                if (diag.limitacoes.length > 0) assert.match(t, /Do conhecimento recuperado \(determinístico\) .*nenhuma regra formal/, nome);
                else assert.ok(!s.includes('data-secao="limitacoes"'), `${nome}: sem limitacao, sem a secao`);
                assert.equal(semSecao(html), referencia, `${nome}: o painel original nao muda (borda, oraculo, juiz, resposta bruta)`);
                assert.ok(!/rose-|INVÁLIDO/.test(s), `${nome}: a falha nao e pintada como erro nem como veredito`);
            }
            assert.match(texto(secao(await renderizarLado(comDiagnostico(semResposta)))), /não disponível: Falha ao diagnosticar com o modelo local: .*sem resposta em 600s/);
            const malformado = texto(secao(await renderizarLado(comDiagnostico(MALFORMADO))));
            assert.match(malformado, /resposta fora do formato: diagnostico fora do formato: a resposta nao e JSON/);
            assert.match(malformado, /Resposta bruta do diagnóstico o plano esta indeterminado porque falta a TFG/);
        });

        console.log(falhas === 0 ? `\nTodos os ${contagem} testes passaram.` : `\n${falhas} de ${contagem} teste(s) falharam.`);
    } finally {
        await vite.close();
    }
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(erro => {
    console.error('Falha ao executar os testes:', erro);
    process.exit(1);
});
