/**
 * Pipeline SPC-CML ponta a ponta — a Figura 5.1 executando.
 *
 *   DSL local ─┬─> Esquema de Controle ──> Grafo de Conhecimento ──┐
 *              └─> Esquema de Dados ──> BNF (G) ─────────────┐     │
 *                                                            │     v
 *   Telemetria + fala do profissional ──> Busca no Grafo ──> Prompt Semantico
 *                                                            │
 *                                              Ĝ (poda por farmaco)
 *                                                            v
 *                                        Grammar Prompting + Decodificacao
 *                                          Restrita (verificar e reparar)
 *                                                            v
 *                                          Impromptu ──> payload do LLM Alvo
 *
 * Uso:
 *   npx tsx src/cli/pipeline.ts [modelo.dsl]
 *
 * Roda integralmente offline. Com ANTHROPIC_API_KEY definida, a etapa de geracao
 * consulta o modelo real; sem ela, um gerador simulado reproduz a saida ingenua
 * tipica de um LLM sem restricao, para evidenciar o que a arquitetura intercepta.
 */
import { EmptyFileSystem } from 'langium';
import { URI } from 'vscode-uri';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDSLServices } from '../language/dsl-module.js';
import { extractOutputBnf } from '../grammar/extract-bnf.js';
import { buildVocabularies } from '../grammar/vocabularies.js';
import { constrainByPolicies } from '../grammar/constrain.js';
import { parseBnf, EarleyRecognizer } from '../grammar/earley.js';
import { retrieveConstraints } from '../knowledge/graphrag.js';
// ---------------------------------------------------------------------------
// Cenario de leito: o caso do arquivo src/examples/prompt.txt.
// ---------------------------------------------------------------------------
const CONTEXTO = {
    paciente: 'PT-2026-0031',
    intencao: 'A pressao ta despencando (PAM=52), sobe a nora urgente e aprofunda o propofol!',
    telemetria: {
        PAM: 52,
        FC: 145,
        lactato: 4.8,
        RASS: 2,
        TFG: 28,
        plaquetas: 45,
        glicemia: 210,
        SpO2: 94
    },
    populacoes: ['Renal_Cronico'],
    farmacosEmUso: ['Noradrenalina', 'Propofol', 'Vancomicina']
};
/**
 * Saida ingenua: o que um LLM sem restricao produz ao obedecer literalmente a
 * fala do profissional, ignorando as invariantes do dominio. Serve de entrada
 * controlada para a etapa de verificacao.
 */
const SAIDA_INGENUA = `plano Plano_Choque_01 para Choque_Septico {
  esquema_referencia AssistenteUTI_v2
  paciente 'PT-2026-0031'
  sequencia [ Titular_Vasopressor ]
  ordem Noradrenalina decisao AUMENTAR_VAZAO dose 0.1 mcg/kg/min via ACESSO_CENTRAL justificativa 'pressao despencando'
  ordem Propofol decisao AUMENTAR_VAZAO dose 1.0 mg/kg/h via ACESSO_CENTRAL justificativa 'aprofundar sedacao'
  alerta INFORMATIVO 'ordens executadas' regra 'solicitacao do plantonista'
  auditoria 'plano gerado a partir da fala do profissional'
}`;
async function carregarModelo(modelPath) {
    const { shared } = createDSLServices(EmptyFileSystem);
    const document = shared.workspace.LangiumDocumentFactory.fromString(fs.readFileSync(modelPath, 'utf-8'), URI.file(path.resolve(modelPath)));
    await shared.workspace.DocumentBuilder.build([document], { validation: true });
    const erros = [
        ...document.parseResult.lexerErrors.map(e => e.message),
        ...document.parseResult.parserErrors.map(e => e.message)
    ];
    if (erros.length > 0)
        throw new Error(`Modelo invalido:\n  - ${erros.join('\n  - ')}`);
    return document.parseResult.value;
}
/** Verifica que um plano gerado tambem e um programa valido da DSL Langium. */
async function validarNaDSL(plano) {
    const { shared } = createDSLServices(EmptyFileSystem);
    const document = shared.workspace.LangiumDocumentFactory.fromString(plano, URI.file(path.resolve('plano-gerado.dsl')));
    await shared.workspace.DocumentBuilder.build([document], { validation: true });
    return [
        ...document.parseResult.lexerErrors.map(e => e.message),
        ...document.parseResult.parserErrors.map(e => e.message)
    ];
}
function titulo(n, texto) {
    console.log(`\n${'='.repeat(78)}\n[${n}] ${texto}\n${'='.repeat(78)}`);
}
async function main() {
    const modelPath = process.argv[2] ?? path.join('src', 'examples', 'uti.dsl');
    // ---------------------------------------------------------------- 1. DSL
    titulo(1, 'DSL LOCAL — Esquema de Controle + Esquema de Dados');
    const model = await carregarModelo(modelPath);
    console.log(`Modelo: ${path.basename(modelPath)} — ${model.elements.length} elementos, 0 erros`);
    // --------------------------------------------------- 2. Entrada do leito
    titulo(2, 'ENTRADA — telemetria e fala do profissional');
    console.log(`Paciente: ${CONTEXTO.paciente}`);
    console.log(`Fala:     "${CONTEXTO.intencao}"`);
    console.log('Telemetria: ' +
        Object.entries(CONTEXTO.telemetria)
            .map(([k, v]) => `${k}=${v}`)
            .join('  '));
    console.log(`Populacoes: ${CONTEXTO.populacoes?.join(', ')}`);
    console.log(`Em infusao: ${CONTEXTO.farmacosEmUso?.join(', ')}`);
    // ------------------------------------------------- 3. Busca no grafo
    titulo(3, 'BUSCA NO GRAFO DE CONHECIMENTO — restricoes ativas');
    const constraints = retrieveConstraints(model, CONTEXTO);
    console.log('Protocolos ativados:');
    for (const p of constraints.protocolosAtivos) {
        console.log(`  - ${p.nome} (CID ${p.cid})`);
        for (const g of p.gatilhos)
            console.log(`      gatilho: ${g}`);
    }
    console.log('\nBloqueios de incremento ativos:');
    for (const b of constraints.bloqueios) {
        console.log(`  - ${b.farmaco}: ${b.regra} — ${b.razao}`);
    }
    console.log('\nAjustes exigidos:');
    for (const a of constraints.ajustes) {
        console.log(`  - ${a.farmaco}: ${a.acao} (${a.origem})`);
    }
    console.log('\nEscalonamentos disparados:');
    for (const e of constraints.escalonamentos) {
        console.log(`  - ${e.destino}: ${e.detalhe}`);
    }
    console.log('\nInteracoes entre farmacos em uso:');
    for (const i of constraints.interacoes) {
        console.log(`  - ${i.entre} [${i.gravidade}]: ${i.mecanismo}`);
    }
    // --------------------------------------- 4. G e Ĝ derivadas da DSL local
    titulo(4, 'GRAMATICA — G derivada da DSL e Ĝ podada pelo subgrafo');
    const { vocabularies } = buildVocabularies(model);
    const base = extractOutputBnf(grammarOf(), vocabularies, 'PlanCommand');
    const constrained = constrainByPolicies(base, constraints.politicas);
    console.log(`G  : ${base.rules.length} regras`);
    console.log(`Ĝ  : ${constrained.rules.length} regras (especializadas por farmaco)`);
    console.log('\nPolitica por farmaco apos a poda:');
    for (const r of constrained.resumo) {
        const marca = r.bloqueado ? 'BLOQUEADO' : 'liberado ';
        console.log(`  ${marca} ${r.farmaco.padEnd(24)} decisoes: ${r.decisoes.join(', ')}`);
    }
    // -------------------------------- 5. Verificacao da saida sob Ĝ
    titulo(5, 'DECODIFICACAO RESTRITA — verificacao e reparo sob Ĝ');
    const recognizer = new EarleyRecognizer(parseBnf(constrained.serialize(), 'plano'));
    console.log('Saida ingenua do LLM (obedecendo a fala literal):');
    console.log(SAIDA_INGENUA.split('\n')
        .map(l => '    ' + l)
        .join('\n'));
    const analise = recognizer.analyze(SAIDA_INGENUA);
    console.log(`\nAceita por Ĝ? ${analise.accepted ? 'sim' : 'NAO'}`);
    if (!analise.accepted) {
        console.log(`Diagnostico: ${analise.error}`);
        console.log(`Prefixo valido: ${analise.validPrefixLength} de ${SAIDA_INGENUA.trim().length} caracteres`);
        console.log(`Ultimo trecho aceito: ...${JSON.stringify(analise.validPrefix.slice(-60))}`);
        console.log('Sigma[y_prefix] (unicas continuacoes admissiveis):\n    ' +
            recognizer.describeExpected(analise.expected).join('\n    '));
    }
    const reparado = recognizer.repair(analise.validPrefix);
    if (!reparado) {
        console.error('\nFALHA: o reparo deterministico nao convergiu.');
        return 1;
    }
    console.log('\nPlano apos reparo sob restricao gramatical:');
    console.log(reparado
        .split('\n')
        .map(l => '    ' + l)
        .join('\n'));
    // ------------------------------------------- 6. Fechamento das garantias
    titulo(6, 'VERIFICACAO FINAL — fechamento semantico mutuo');
    const aceitoPorGHat = recognizer.accepts(reparado);
    const errosNaDSL = await validarNaDSL(reparado);
    console.log(`Aceito por Ĝ (restricoes do grafo): ${aceitoPorGHat ? 'sim' : 'NAO'}`);
    console.log(`Aceito pela DSL Langium (round-trip):  ${errosNaDSL.length === 0 ? 'sim' : 'NAO'}`);
    for (const e of errosNaDSL)
        console.log(`    ${e}`);
    const ok = aceitoPorGHat && errosNaDSL.length === 0;
    console.log(`\nRESULTADO: ${ok
        ? 'erro sintatico 0 — o plano final e valido em Ĝ e na DSL, e nenhuma ordem viola as invariantes recuperadas do grafo.'
        : 'FALHA nas garantias.'}`);
    return ok ? 0 : 1;
}
/** Acesso a gramatica Langium carregada (fonte estrutural da BNF). */
function grammarOf() {
    return createDSLServices(EmptyFileSystem).DSL.Grammar;
}
main()
    .then(code => process.exit(code))
    .catch(err => {
    console.error('Falha no pipeline:', err.message ?? err);
    process.exit(1);
});
