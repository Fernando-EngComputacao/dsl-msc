/**
 * Smoke test REAL do modo multiagente: Qwen Planner -> PIPlanejado[] -> validacao
 * -> decomposicao -> Qwen PI Agent por PI -> ResultadoPI -> validacao individual.
 *
 * Uso:
 *   npx tsx src/cli/smoke-planner.ts [med|agro|fut] [linha do cenario] [url do motor] [pedido]
 *   npm run smoke:planner -- fut 0 http://127.0.0.1:8012
 *
 * O `pedido`, quando dado, substitui a intencao do cenario (mesma telemetria):
 * serve para ver, por exemplo, o pedido sem alvo terminar antes do Planner.
 * Com `SPC_CML_SMOKE_PLANO` (a saida exata do Planner, `PLANO ... FIM`), o
 * Planner e roteirizado e o resto e real: serve para exercitar um DAG que o
 * Qwen nao propos (PIs independentes numa onda so).
 *
 * Faz o caminho do servidor para UM cenario do arquivo de exemplos do dominio:
 * recuperacao (`recuperarConhecimento`, com Neo4j para o foco) -> entrada da
 * geracao -> `decodificar` com SPC_CML_DECODIFICACAO=multiagente. O motor
 * precisa expor /generate-planner (main.py atual); sem a url, vale o endpoint
 * do dominio (SPC_CML_ENDPOINT, _AGRO, _FUT).
 *
 * Registra, por tentativa do laco do Planner, o que o modelo recebeu e
 * devolveu, o veredito (leitura ou validacao contra o conhecimento), os erros
 * e o feedback enviado a tentativa seguinte. Nada e mascarado: saida fora do
 * protocolo aparece como falha do Planner. Com a sequencia validada, mostra a
 * decomposicao (deterministica, sem modelo), o DAG e as ondas do scheduler de
 * PIs, por PI cada tentativa do PI Agent (saida bruta, veredito, erros,
 * feedback), e por ciclo global a validacao do plano composto; ao final, o
 * artefato e o custo. O motor precisa
 * expor tambem /generate-pi e /verify. Sai com codigo 0 so em COMPLETED.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import neo4j from 'neo4j-driver';

import { loadModel } from '../database/neo4j.js';
import { loadAgroModel } from '../database/neo4j-agro.js';
import { loadFutModel } from '../database/neo4j-fut.js';
import type { ClinicalContext } from '../knowledge/graphrag.js';
import type { AgroContext } from '../knowledge/graphrag-agro.js';
import type { FutContext } from '../knowledge/graphrag-fut.js';
import type { Dominio } from '../knowledge/recuperacao.js';
import { montarEntradaGeracao } from '../inference/llm-client.js';
import { montarEntradaGeracaoAgro } from '../inference/agro-client.js';
import { montarEntradaGeracaoFut } from '../inference/fut-client.js';
import {
    ADAPTADOR_AGRO,
    ADAPTADOR_FUT,
    ADAPTADOR_MED,
    recuperarConhecimento,
    type EmitirEstagio
} from '../inference/recuperacao-conhecimento.js';
import {
    decodificar,
    ehResultadoMultiagente,
    type OpcoesDecodificacao
} from '../inference/decodificacao.js';
import type { MotorPlanner } from '../inference/planner.js';

const ARQUIVO: Record<Dominio, string> = {
    med: path.join('src', 'examples', 'med', 'cenarios.jsonl'),
    agro: path.join('src', 'examples', 'agro', 'cenarios-agro.jsonl'),
    fut: path.join('src', 'examples', 'fut', 'cenarios-fut.jsonl')
};

async function main(): Promise<void> {
    const dominio = (process.argv[2] ?? 'fut') as Dominio;
    if (!(dominio in ARQUIVO)) throw new Error(`dominio deve ser med, agro ou fut (veio ${dominio})`);
    const indice = Number(process.argv[3] ?? 0);
    const motor = process.argv[4] || undefined;
    const pedido = process.argv[5];

    const linhas = fs.readFileSync(ARQUIVO[dominio], 'utf-8').split('\n').filter(l => l.trim().length > 0);
    const b = JSON.parse(linhas[indice]) as Record<string, unknown>;
    const texto = String(pedido ?? b.intencao ?? '').trim();
    const telemetria = (b.telemetria as Record<string, number>) ?? {};

    const estagio: EmitirEstagio = async t => console.log(`  · ${t}`);
    const driver = neo4j.driver(
        process.env.NEO4J_URI ?? 'bolt://localhost:7687',
        neo4j.auth.basic(process.env.NEO4J_USER ?? 'neo4j', process.env.NEO4J_PASSWORD ?? '#UFG2026')
    );

    console.log(`\n=== SMOKE DO PLANNER — ${dominio}, cenario ${indice} ===`);
    console.log(`pedido: ${texto}\n`);

    let entrada: OpcoesDecodificacao;
    try {
        if (dominio === 'med') {
            const contexto: ClinicalContext = {
                paciente: b.paciente as string | undefined, populacoes: (b.populacoes as string[]) ?? [],
                farmacosEmUso: (b.farmacosEmUso as string[]) ?? [], telemetria, intencao: texto
            };
            const modelo = await loadModel(path.join('src', 'examples', 'med', 'uti.dsl'));
            const k = await recuperarConhecimento(ADAPTADOR_MED, modelo, contexto, texto, estagio, () => driver.session());
            entrada = montarEntradaGeracao(contexto, k.constraints, modelo, k.politicaEfetiva, k);
        } else if (dominio === 'agro') {
            const contexto: AgroContext = {
                talhao: b.talhao as string | undefined, areas: (b.areas as string[]) ?? [],
                produtosEmUso: (b.produtosEmUso as string[]) ?? [], telemetria, intencao: texto
            };
            const modelo = await loadAgroModel(path.join('src', 'examples', 'agro', 'lavoura.agro'));
            const k = await recuperarConhecimento(ADAPTADOR_AGRO, modelo, contexto, texto, estagio, () => driver.session());
            entrada = montarEntradaGeracaoAgro(contexto, k.constraints, modelo, k.politicaEfetiva, k);
        } else {
            const contexto: FutContext = {
                partida: b.partida as string | undefined, contextos: (b.contextos as string[]) ?? [],
                infracoesEmUso: (b.infracoesEmUso as string[]) ?? [], telemetria, intencao: texto
            };
            const modelo = await loadFutModel(path.join('src', 'examples', 'fut', 'futebol.fut'));
            const k = await recuperarConhecimento(ADAPTADOR_FUT, modelo, contexto, texto, estagio, () => driver.session());
            entrada = montarEntradaGeracaoFut(contexto, k.constraints, modelo, k.politicaEfetiva, k);
        }
    } finally {
        await driver.close();
    }

    if (motor) entrada = { ...entrada, endpoint: motor };
    process.env.SPC_CML_DECODIFICACAO = 'multiagente';
    console.log(`\nmotor do Planner: ${entrada.endpoint}`);
    // Semi-real: com SPC_CML_SMOKE_PLANO, a saida do Planner e essa (roteirizada);
    // validacao, PI Agents, composicao e /verify seguem reais.
    const planoRoteirizado = process.env.SPC_CML_SMOKE_PLANO;
    const motorPlanner: MotorPlanner | undefined = planoRoteirizado ? async () => ({ saida: planoRoteirizado }) : undefined;
    if (planoRoteirizado) console.log(`Planner ROTEIRIZADO (SPC_CML_SMOKE_PLANO): ${planoRoteirizado}`);

    const r = await decodificar({ ...entrada, ...(motorPlanner ? { motorPlanner } : {}) });
    if (!ehResultadoMultiagente(r)) throw new Error('decodificar nao seguiu o modo multiagente');
    const ctx = r.execucao;
    console.log(`\nrequestId:        ${ctx.requestId}`);
    console.log(`status:           ${[ctx.historicoStatus[0]?.de ?? ctx.status, ...ctx.historicoStatus.map(h => h.para)].join(' -> ')}`);
    const motivo = ctx.historicoStatus[ctx.historicoStatus.length - 1]?.motivo;
    if (motivo) console.log(`motivo:           ${motivo}`);
    console.log(`orcamento:        ${ctx.tentativasPlanner.length}/${ctx.orcamento.planner} proposta(s) do Planner`);

    for (const t of ctx.tentativasPlanner) {
        const m = t.metricas;
        console.log(`\n--- tentativa ${t.tentativa} (${t.fase}) ---`);
        if (m) {
            console.log(`prompt:           ${m.caracteresPrompt} caracteres, ${m.tokensPrompt ?? '?'} tokens` +
                (m.caracteresFeedback ? ` (feedback: ${m.caracteresFeedback} caracteres)` : ''));
            console.log(`candidatos:       ${m.itensCandidatos} itens, ${m.condutasCandidatas} condutas`);
            console.log(`inferencia:       ${(m.duracaoMs / 1000).toFixed(1)} s` +
                (m.duracaoValidacaoMs !== undefined ? ` | validacao: ${m.duracaoValidacaoMs} ms` : ''));
            console.log(`reparse do motor: ${m.validaNaGramatica ?? '?'}`);
        }
        console.log(`saida bruta:      ${String(t.proposta)}`);
        console.log(`veredito:         ${t.validacao.veredito}`);
        for (const e of t.validacao.erros) {
            console.log(`  erro  [${e.codigo}]${e.pi ? ` PI ${e.pi}` : ''} ${e.mensagem}`);
        }
        for (const a of t.validacao.avisos) console.log(`  aviso [${a.codigo}] ${a.mensagem}`);
        if (t.validacao.dadosFaltantes.length > 0) console.log(`  faltam: ${t.validacao.dadosFaltantes.join(', ')}`);
        if (t.realimentacao) console.log(`\nfeedback enviado a tentativa seguinte:\n${t.realimentacao}`);
    }
    for (const e of ctx.errosValidacao.filter(v => v.veredito === 'UNRESOLVED' && !ctx.tentativasPlanner.some(t => t.validacao === v))) {
        console.log(`\nUNRESOLVED: faltam ${e.dadosFaltantes.join(', ')}`);
        for (const a of e.avisos) console.log(`  aviso [${a.codigo}] ${a.mensagem}`);
        if (e.promptRecomendado) console.log(`prompt recomendado:\n${e.promptRecomendado}`);
    }
    if (ctx.sequenciaValidada) {
        console.log('\nsequencia VALIDADA (PIPlanejado[]):');
        for (const p of ctx.sequenciaValidada) {
            console.log(`  ${p.ordem}. ${p.item} -> ${p.conduta}  dependeDe [${p.dependeDe.join(', ')}]`);
        }
    }
    const m = ctx.metricasDecomposicao;
    if (m) {
        console.log(`\ndecomposicao (${m.duracaoMs} ms, nenhum PI Agent executado):`);
        console.log(`  global: ${m.global.itens} itens, ${m.global.regras} regras, ${m.global.fatos} fatos, ` +
            `${m.global.telemetria} parametros | conhecimento ${m.global.caracteresConhecimento} car. | ` +
            `Prompt Semantico ${m.global.caracteresPromptSemantico ?? '?'} car.`);
        for (const p of m.porPI) {
            console.log(`  PI ${p.ordem} ${p.item} -> ${p.conduta}: ${p.regras} regras, ${p.fatos} fatos, ` +
                `${p.evidencias} evidencias, ${p.decisoesAdmissiveis} decisao(oes), ${p.telemetria} parametros | ` +
                `contexto ${p.caracteresContexto} car. | prompt ${p.caracteresPrompt} car.`);
        }
    }
    const dag = ctx.planoExecucaoPI;
    if (dag) {
        const d = dag.metricas;
        console.log(`\nPI scheduler (ondas em serie, sem concorrencia):`);
        console.log(`  PIs: ${d.pis} | dependencias: ${d.arestas} | ondas: ${d.ondas} | largura maxima: ${d.larguraMaxima} | ` +
            `profundidade: ${d.profundidade} | PIs por onda: ${d.pisPorOnda.join(', ')}`);
        for (const o of ctx.ondasPI) {
            const deps = o.ordens.map(x => (o.dependencias[x].length > 0 ? `PI ${x} <- ${o.dependencias[x].join(', ')}` : `PI ${x}`)).join('; ');
            console.log(`  onda ${o.indice}: ${deps} [${o.status}` +
                (o.duracaoMs !== undefined ? `, ${(o.duracaoMs / 1000).toFixed(1)} s` : '') + ']' +
                (o.executados.length > 0 ? ` executados ${o.executados.join(', ')}` : '') +
                (o.bloqueados.length > 0 ? ` | bloqueados ${o.bloqueados.join(', ')}` : ''));
        }
    }
    for (const e of ctx.execucoesPI) {
        console.log(`\n=== PI ${e.ordem}: ${e.item} -> ${e.conduta} [${e.status}] ===`);
        for (const t of e.tentativas) {
            const m = t.metricas;
            console.log(`--- tentativa ${t.tentativa} (${t.fase}) ---`);
            if (m) {
                console.log(`prompt:           ${m.caracteresPrompt} caracteres, ${m.tokensPrompt ?? '?'} tokens` +
                    (m.caracteresFeedback ? ` (feedback: ${m.caracteresFeedback} caracteres)` : ''));
                console.log(`inferencia:       ${(m.duracaoMs / 1000).toFixed(1)} s` +
                    (m.duracaoValidacaoMs !== undefined ? ` | validacao: ${m.duracaoValidacaoMs} ms` : '') +
                    ` | reparse do motor: ${m.validaNaGramatica ?? '?'}`);
            }
            console.log(`admissiveis:      ${t.admissiveis.join(', ')}`);
            console.log(`saida bruta:      ${t.saida}`);
            console.log(`veredito:         ${t.validacao.veredito}`);
            for (const x of t.validacao.erros) console.log(`  erro  [${x.codigo}] ${x.mensagem}`);
            for (const a of t.validacao.avisos) console.log(`  aviso [${a.codigo}] ${a.mensagem}`);
            if (t.realimentacao) console.log(`feedback enviado a tentativa seguinte:\n${t.realimentacao}`);
        }
    }
    for (const c of ctx.historicoGlobal) {
        console.log(`
=== CICLO GLOBAL ${c.ciclo} -> ${c.desfecho}${c.motivo ? ` (${c.motivo})` : ''} ===`);
        if (c.sequenciaValidada) console.log(`sequencia: ${c.sequenciaValidada.map(p => `${p.ordem}. ${p.item} -> ${p.conduta}`).join(' | ')}`);
        if (c.validacaoGlobal) {
            console.log(`validacao global: ${c.validacaoGlobal.veredito}`);
            for (const e of c.validacaoGlobal.erros) console.log(`  erro  [${e.codigo}]${e.pis ? ` PIs ${e.pis.join(', ')}` : ''} ${e.mensagem}`);
            for (const a of c.validacaoGlobal.avisos) console.log(`  aviso [${a.codigo}] ${a.mensagem}`);
        }
        if (c.realimentacao) console.log(`feedback global ao Planner do ciclo seguinte:
${c.realimentacao}`);
    }
    if (ctx.artefatoFinal) console.log(`
ARTEFATO FINAL:
${ctx.artefatoFinal}`);
    if (ctx.metricasExecucao) console.log(`
custo: ${JSON.stringify(ctx.metricasExecucao)}`);
    process.exitCode = ctx.status === 'COMPLETED' ? 0 : 1;
}

main().catch(err => {
    console.error('Falha no smoke do Planner:', (err as Error).message ?? err);
    process.exit(1);
});
