/**
 * Avaliador de planos (POST /api/avaliar): SINTAXE -> AST -> SEMANTICA ->
 * ORACULO -> LLM JUDGE.
 * Executar: npx tsx src/test/avaliar-oraculo.test.ts
 *
 * O que se cobra:
 *   - a cascata: texto vazio e texto fora da DSL param na sintaxe (semantica
 *     NOT_EVALUATED, juiz NOT_CALLED); DSL valida chega a semantica e ao juiz;
 *   - sintaxe pela DSL (G + parser Langium -> AST oficial), com os erros das
 *     duas pecas, e falha tecnica de cada uma como "nao avaliado";
 *   - semantica sobre o AST GUARDADO (o mesmo que vai ao JSONL), sem texto,
 *     com os validadores da geracao (L(Ĝ), validarSequencia, decomporPIs +
 *     validarPI, validarPlanoGlobal);
 *   - UNRESOLVED nunca vira INVALID, e o juiz nunca muda o oraculo;
 *   - dependencias: presentes, invalidas, ausentes (com o efeito real da perda)
 *     e divergentes;
 *   - regressoes permanentes: incremento proibido com FC 138 (oraculo INVALID
 *     mesmo com o juiz dizendo VALID) e planos REAIS COMPLETED (VALID).
 *
 * Roda OFFLINE: modelo da DSL, parser Langium e recuperacao deterministica
 * reais (sem Neo4j o foco falha e a recuperacao segue com o grafo completo, como
 * no servidor). G e conferida pelo reconhecedor Earley do projeto sobre a MESMA
 * BNF que o /verify carrega (src/grammar/earley.ts); L(Ĝ), Planner, PI Agent e
 * o juiz sao dubles.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Session } from 'neo4j-driver';

import { loadModel } from '../database/neo4j.js';
import { EarleyRecognizer, loadBnf } from '../grammar/earley.js';
import { verificarContrato } from '../knowledge/contrato.js';
import type { PIPlanejado } from '../knowledge/contrato-pi.js';
import { pruningPayload, type ClinicalContext, type RetrievedConstraints } from '../knowledge/graphrag.js';
import type { SubgrafoPodado } from '../knowledge/politica.js';
import type { RegraValidada } from '../knowledge/recuperacao-cypher.js';
import type { Veredito } from '../knowledge/validacao.js';
import { validarPlanoGlobal, type ConhecimentoGlobal } from '../knowledge/validacao-global.js';
import {
    agregarMetricas,
    avaliarPlano,
    compararAvaliacoes,
    juizLLMHttp,
    montarLinha,
    oraculoDe,
    planoDoArtefato,
    registrosJsonl,
    validarSemantica,
    type DetalheLado,
    type JuizLLM,
    type PedidoJuiz,
    type RegistroAvaliarGrafo,
    type StatusJuiz
} from '../inference/avaliar-grafo.js';
import {
    criarAnalisadorDsl,
    erroDaGramatica,
    projetarAst,
    validarSintaxePlano,
    type AnalisadorDsl,
    type AstArtefato,
    type VerificadorDaDsl
} from '../inference/avaliar-sintaxe.js';
import type { VerificadorGramatical } from '../inference/ciclo-global.js';
import { decodificar, type ResultadoMultiagente } from '../inference/decodificacao.js';
import { montarEntradaGeracao } from '../inference/llm-client.js';
import { ADAPTADOR_MED, recuperarConhecimento, type ConhecimentoRecuperado } from '../inference/recuperacao-conhecimento.js';
import { piAgentQueObedece, verificadorQueAceita } from './dubles-pi-agent.js';

let falhas = 0;
let contagem = 0;
function teste(nome: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => { contagem++; console.log(`  ok   ${nome}`); })
        .catch((erro: Error) => {
            contagem++;
            falhas++;
            console.log(`  FALHA ${nome}\n       ${erro.message}`);
        });
}

/** Mesmo cenario de referencia de validacao-global.test.ts: PAM 52 bloqueia o Propofol, FC 145 a Noradrenalina. */
const REF: ClinicalContext = {
    paciente: 'PT-TESTE-0001',
    intencao: 'A pressao ta despencando (PAM=52), sobe a nora e aprofunda o propofol',
    telemetria: { PAM: 52, FC: 145, lactato: 4.8, RASS: 2, TFG: 28, plaquetas: 45, glicemia: 210 },
    populacoes: ['Renal_Cronico'],
    farmacosEmUso: ['Noradrenalina', 'Propofol', 'Vancomicina']
};
const REF_2 = 'PLANO 1 | Propofol | Manter_Bloqueio | [ ] 2 | Noradrenalina | Acionar_Equipe | [ 1 ] FIM';
const B: ClinicalContext = {
    paciente: 'PT-TESTE-0002',
    intencao: 'sobe a noradrenalina',
    telemetria: { PAM: 58, FC: 110, lactato: 3.0 },
    populacoes: [],
    farmacosEmUso: ['Noradrenalina']
};
const SEM_CONFLITO = 'PLANO 1 | Noradrenalina | Titular_Vasopressor | [ ] 2 | Adrenalina | Manter_Bloqueio | [ 1 ] FIM';

/**
 * Planos REAIS: gerados em 2026-09-28 pelo Qwen2.5-7B no modo multiagente
 * (POST /api/comando, cenarios 1 e 2 de src/examples/med/cenarios.jsonl, Neo4j
 * com foco); os dois terminaram COMPLETED com a validacao global VALID. O texto
 * e a sequencia validada sao os da resposta, sem edicao.
 */
const PLANO_REAL_1 = "plano plano_rec_mulh0i7t_3_c1 para Choque_Septico { esquema_referencia AssistenteUTI_v2 paciente 'PT-2026-4001' sequencia [ Acionar_Equipe , Iniciar_Vasopressor ] ordem Noradrenalina decisao ESCALAR_EQUIPE dose 0.0 mcg/kg/min via ACESSO_CENTRAL justificativa 'Segundo o protocolo Choque_Septico, a hipoperfusao grave persistente e lactato > 2 mmol/L exigem a escalonamento da equipe para intervencao rapida.' ordem Vasopressina decisao INICIAR_INFUSAO dose 0.01 U/min via ACESSO_CENTRAL justificativa 'Segundo o protocolo Choque_Septico, com lactato > 4.2 mmol/L e PAM < 65 mmHg, deve-se iniciar um vasopressor após reposição volemica inicial.' auditoria 'artefato composto de 2 PI(s) validado(s) individualmente, na ordem do Planner (execucao rec-mulh0i7t-3, ciclo 1)' }";
const SEQUENCIA_REAL_1: PIPlanejado[] = [
    { ordem: 1, item: 'Noradrenalina', conduta: 'Acionar_Equipe', dependeDe: [] },
    { ordem: 2, item: 'Vasopressina', conduta: 'Iniciar_Vasopressor', dependeDe: [1] }
];
const PLANO_REAL_2 = "plano plano_rec_mulh3lyn_5_c1 para Choque_Septico { esquema_referencia AssistenteUTI_v2 paciente 'PT-2026-4002' sequencia [ Reduzir_Infusao , Iniciar_Vasopressor ] ordem Noradrenalina decisao REDUZIR_VAZAO dose 0.05 mcg/kg/min via ACESSO_CENTRAL justificativa 'Telemetria mostra PAM <65 mmHg e FC >130 bpm, indicando necessidade de ajuste na infusão de noradrenalina para evitar risco de taquiarritmia.' ordem Vasopressina decisao INICIAR_INFUSAO dose 0.01 U/min via ACESSO_CENTRAL justificativa 'Segundo o protocolo Choque_Septico, com lactato > 2 mmol/L e PAM < 65 mmHg, deve-se iniciar um vasopressor após reposição volemica inicial.' auditoria 'artefato composto de 2 PI(s) validado(s) individualmente, na ordem do Planner (execucao rec-mulh3lyn-5, ciclo 1)' }";
const SEQUENCIA_REAL_2: PIPlanejado[] = [
    { ordem: 1, item: 'Noradrenalina', conduta: 'Reduzir_Infusao', dependeDe: [] },
    { ordem: 2, item: 'Vasopressina', conduta: 'Iniciar_Vasopressor', dependeDe: [1] }
];
/**
 * O caso encontrado ao vivo: o plano real do cenario 2 com a Noradrenalina
 * AUMENTADA (e a conduta coerente no cabecalho). FC 138 > 130 bloqueia o
 * incremento. DSL valida; semanticamente proibido.
 */
const PLANO_PROIBIDO_FC138 = PLANO_REAL_2.replace('decisao REDUZIR_VAZAO', 'decisao AUMENTAR_VAZAO').replace('sequencia [ Reduzir_Infusao', 'sequencia [ Titular_Vasopressor');

/** Sem Neo4j: o foco falha, e a recuperacao segue com o grafo completo (o mesmo tratamento do servidor). */
function sessaoContada(contador: { aberturas: number }): () => Session {
    return () => {
        contador.aberturas++;
        return { run: async () => { throw new Error('sem Neo4j no teste'); }, close: async () => {} } as unknown as Session;
    };
}

/** Juiz duble: devolve o veredito dado e guarda o que leu. */
function juizQueResponde(veredito: Veredito, lidos: PedidoJuiz[] = []): JuizLLM {
    return async pedido => {
        lidos.push(pedido);
        return { veredito, justificativa: `duble respondeu ${veredito}`, evidencias: ['evidencia do duble'], respostaBruta: `evidencias: x\njustificativa: y\nveredito: ${veredito}` };
    };
}

/** L(Ĝ) duble que conta as chamadas e aceita (ou recusa). */
function gHat(aceita = true, chamadas = { n: 0 }): VerificadorGramatical {
    return async () => {
        chamadas.n++;
        return aceita ? { valido: true, erro: null } : { valido: false, erro: "Unexpected token Token('IDENTIFICADOR', 'Propofol') at line 1, column 200.\nExpected one of: \n\t* NORADRENALINA\n" };
    };
}

/** A politica que a recuperacao entrega, transformada — o conhecimento do cenario com uma lacuna. */
function comPoda(f: (p: SubgrafoPodado) => SubgrafoPodado): typeof ADAPTADOR_MED {
    return { ...ADAPTADOR_MED, podar: (c: RetrievedConstraints, ctx: ClinicalContext) => f(pruningPayload(c, ctx)) };
}
function semDecisao(decisao: string): (p: SubgrafoPodado) => SubgrafoPodado {
    return p => ({
        ...p,
        politicas: p.politicas.map(x => ({ ...x, decisoes: x.decisoes.filter(d => d !== decisao) })).filter(x => x.decisoes.length > 0),
        acoes_permitidas: p.acoes_permitidas.filter(d => d !== decisao)
    });
}

function regraSemMedida(item: string, campo: string): RegraValidada {
    return {
        regraId: `Farmaco:${item}/RegraSeguranca/${campo}<65`, tipo: 'RegraSeguranca', relacao: 'BLOQUEIA_INCREMENTO',
        item, dominio: 'med', aplicavel: false, condicoesSatisfeitas: [], condicoesFalhas: [],
        lacunas: [{ campo, esperado: '< 65 %', motivo: `o cenario nao mediu '${campo}'` }],
        evidencia: {}, validacaoCypher: { valida: false, motivo: 'sem evidencia', consulta: '' }, efeito: {},
        rag: { candidatoId: `Farmaco:${item}`, escore: 0.9, cosseno: 0.8, papel: 'item', posicao: 0 }
    };
}

async function main(): Promise<void> {
    const modelo = await loadModel(path.join('src', 'examples', 'med', 'uti.dsl'));
    const analisador = criarAnalisadorDsl('med', path.join('src', 'examples', 'med', 'uti.dsl'));

    // G, pela mesma BNF que o /verify carrega; `chamadasG` conta quantas vezes G foi consultada.
    const earley = new EarleyRecognizer(loadBnf(path.join('src', 'python_engine', 'grammar', 'advanced_icu.bnf'), 'plano'));
    let chamadasG = 0;
    const gDaDsl: VerificadorDaDsl = async texto => {
        chamadasG++;
        const a = earley.analyze(texto);
        return { valido: a.accepted, erro: a.error ?? null };
    };

    /** A geracao multiagente real (Planner roteirizado, PI Agent que obedece, /verify que aceita). */
    async function gerar(ctx: ClinicalContext, planoDoPlanner: string): Promise<{ r: ResultadoMultiagente; k: ConhecimentoRecuperado<RetrievedConstraints> }> {
        const k = await recuperarConhecimento(ADAPTADOR_MED, modelo, ctx, ctx.intencao!, async () => {}, sessaoContada({ aberturas: 0 }));
        const anterior = process.env.SPC_CML_DECODIFICACAO;
        process.env.SPC_CML_DECODIFICACAO = 'multiagente';
        try {
            const r = (await decodificar({
                ...montarEntradaGeracao(ctx, k.constraints, modelo, k.politicaEfetiva, k),
                endpoint: 'http://127.0.0.1:9',
                motor: async () => ({ fragmento: '', encerrou: true }),
                motorPlanner: async () => ({ saida: planoDoPlanner, tokens_prompt: 4000 }),
                motorPIAgent: piAgentQueObedece(),
                verificadorGramatical: verificadorQueAceita()
            })) as ResultadoMultiagente;
            return { r, k };
        } finally {
            if (anterior === undefined) delete process.env.SPC_CML_DECODIFICACAO;
            else process.env.SPC_CML_DECODIFICACAO = anterior;
        }
    }

    /** O conhecimento global da avaliacao de um cenario — os mesmos campos que avaliarPlano monta. */
    async function kDe(ctx: ClinicalContext, opcoes: { regras?: RegraValidada[]; adaptador?: typeof ADAPTADOR_MED } = {}): Promise<ConhecimentoGlobal> {
        const c = await recuperarConhecimento(opcoes.adaptador ?? ADAPTADOR_MED, modelo, ctx, ctx.intencao!, async () => {}, sessaoContada({ aberturas: 0 }));
        const e = montarEntradaGeracao(ctx, c.constraints, modelo, c.politicaEfetiva, c);
        return {
            requestId: 'r', dominio: 'med', pedido: e.comando, telemetria: ctx.telemetria, contrato: e.contrato,
            politica: c.politicaEfetiva, regras: opcoes.regras ?? c.auditoriaRecuperacao.validacao, restricoes: c.constraints, esquema: e.execucao?.esquema
        };
    }

    /** O registro como o lote do web-chat o grava (ver `rodarLote` em web-chat/src/chat.ts). */
    function registroDe(ctx: ClinicalContext, plano: string, extra: Partial<RegistroAvaliarGrafo> = {}): RegistroAvaliarGrafo {
        return {
            linha: 1,
            intencao: ctx.intencao,
            valido: true,
            plano,
            telemetria: { paciente: ctx.paciente, telemetria: ctx.telemetria, populacoes: ctx.populacoes, farmacosEmUso: ctx.farmacosEmUso },
            ...extra
        };
    }
    const comSequencia = (sequenciaValidada: PIPlanejado[]): Partial<RegistroAvaliarGrafo> => ({ execucaoMultiagente: { status: 'COMPLETED', sequenciaValidada } });

    interface Opcoes {
        gHat?: VerificadorGramatical; gDsl?: VerificadorDaDsl; analisador?: AnalisadorDsl; adaptador?: typeof ADAPTADOR_MED;
        sinal?: AbortSignal; julgarSintaxeInvalida?: boolean; sessoes?: { aberturas: number };
    }

    /** A avaliacao de uma linha, como o servidor a faz: o cenario vem do registro. */
    function avaliar(registro: RegistroAvaliarGrafo, juiz: JuizLLM, o: Opcoes = {}): Promise<DetalheLado> {
        const b = registro.telemetria!;
        const contexto: ClinicalContext = {
            paciente: b.paciente,
            telemetria: b.telemetria as Record<string, number>,
            populacoes: b.populacoes as string[],
            farmacosEmUso: b.farmacosEmUso as string[],
            intencao: registro.intencao ?? ''
        };
        return avaliarPlano(
            registro,
            { adaptador: o.adaptador ?? ADAPTADOR_MED, modelo, analisador: o.analisador ?? analisador, contexto, montarEntrada: montarEntradaGeracao },
            {
                abrirSessao: sessaoContada(o.sessoes ?? { aberturas: 0 }),
                verificadorDsl: o.gDsl ?? gDaDsl,
                verificador: o.gHat ?? gHat(),
                juiz,
                sinal: o.sinal ?? new AbortController().signal,
                julgarSintaxeInvalida: o.julgarSintaxeInvalida
            }
        );
    }

    const cenario = (linha: number): ClinicalContext => {
        const c = JSON.parse(fs.readFileSync(path.join('src', 'examples', 'med', 'cenarios.jsonl'), 'utf-8').split('\n')[linha - 1]);
        return { paciente: c.paciente, telemetria: c.telemetria, populacoes: c.populacoes, farmacosEmUso: c.farmacosEmUso, intencao: c.intencao };
    };
    const REAL_1 = cenario(1);
    const REAL_2 = cenario(2);

    const ref = await gerar(REF, REF_2);
    assert.equal(ref.r.execucao.status, 'COMPLETED', ref.r.erro ?? '');
    const planoRef = ref.r.resultado;
    const planoProibidoPAM = planoRef.replace(/(ordem Propofol decisao )MANTER_BLOQUEADO/, '$1AUMENTAR_VAZAO');
    assert.notEqual(planoProibidoPAM, planoRef);
    const cb = await gerar(B, SEM_CONFLITO);
    assert.equal(cb.r.execucao.status, 'COMPLETED', cb.r.erro ?? '');

    const astDe = async (texto: string): Promise<AstArtefato> => {
        const s = await validarSintaxePlano(texto, analisador, gDaDsl);
        assert.equal(s.sintaxe.veredito, 'VALID', JSON.stringify(s.sintaxe.erros));
        return s.ast!;
    };
    /** Um plano de UMA clausula, a partir de uma clausula de outro plano valido. */
    const planoDeUmaClausula = async (base: string, indice: number, contexto: ClinicalContext, conduta: string): Promise<string> => {
        const a = projetarAst('med', await astDe(base));
        const c = a.clausulas[indice];
        return `plano Plano_Unico para ${a.contexto} { esquema_referencia AssistenteUTI_v2 paciente '${contexto.paciente}' sequencia [ ${conduta} ] ` +
            `ordem ${c.item} decisao ${c.decisao} dose ${c.valor} ${c.unidade} via ${c.meio} justificativa '${c.justificativa}' auditoria 'a' }`;
    };

    // =========================================================================
    console.log('\nCascata: TEXTO -> SINTAXE -> AST -> SEMANTICA -> ORACULO -> JUIZ');
    // =========================================================================

    await teste('caso 1 — texto vazio: sintaxe INVALID, semantica NOT_EVALUATED, oraculo INVALID, juiz NOT_CALLED (nem com a flag); nada consultado', async () => {
        const lidos: PedidoJuiz[] = [];
        const sessoes = { aberturas: 0 };
        const g0 = chamadasG;
        const d = await avaliar(registroDe(REF, '   '), juizQueResponde('VALID', lidos), { sessoes, julgarSintaxeInvalida: true });
        assert.equal(d.naoAvaliado, false);
        assert.deepEqual([d.validacaoSintatica!.veredito, d.validacaoSintatica!.erros.map(e => e.codigo), d.validacaoSintatica!.pecas], ['INVALID', ['artefato_vazio'], undefined]);
        assert.equal(d.ast, undefined);
        assert.equal(d.validacaoSemantica!.veredito, 'NOT_EVALUATED');
        assert.deepEqual(d.oraculo, { veredito: 'INVALID', origem: 'sintaxe' });
        assert.equal(d.julgamentoLLM!.status, 'NOT_CALLED');
        assert.match(d.julgamentoLLM!.motivo!, /vazio/);
        assert.deepEqual([lidos.length, sessoes.aberturas, chamadasG - g0], [0, 0, 0]);
        assert.deepEqual([d.concordancia, d.classificacao], [undefined, 'INVALIDO_PELO_ORACULO']);
    });

    await teste('caso 2 / teste A — texto fora da DSL: sintaxe INVALID, semantica NOT_EVALUATED, oraculo INVALID, juiz NOT_CALLED, grafo nao consultado', async () => {
        const lidos: PedidoJuiz[] = [];
        const sessoes = { aberturas: 0 };
        const d = await avaliar(registroDe(REF, 'plano P para Choque_Septico { ordem Propofol }'), juizQueResponde('VALID', lidos), { sessoes });
        assert.equal(d.validacaoSintatica!.veredito, 'INVALID');
        assert.deepEqual(d.validacaoSintatica!.pecas, { gramatica: 'RECUSADO', parser: 'RECUSADO' });
        assert.equal(d.ast, undefined);
        assert.equal(d.validacaoSemantica!.veredito, 'NOT_EVALUATED');
        assert.deepEqual(d.oraculo, { veredito: 'INVALID', origem: 'sintaxe' });
        assert.equal(d.julgamentoLLM!.status, 'NOT_CALLED');
        assert.deepEqual([lidos.length, sessoes.aberturas], [0, 0]);
        assert.equal(d.violacao, undefined, 'sem AST, sem metrica de violacao');
    });

    await teste('caso 2 com a flag experimental (julgarSintaxeInvalida): o juiz julga, a semantica continua NOT_EVALUATED e o oraculo INVALID', async () => {
        const lidos: PedidoJuiz[] = [];
        const d = await avaliar(registroDe(REF, 'Aumente a noradrenalina.'), juizQueResponde('VALID', lidos), { julgarSintaxeInvalida: true });
        assert.equal(lidos.length, 1);
        assert.equal(d.validacaoSemantica!.veredito, 'NOT_EVALUATED');
        assert.deepEqual(d.oraculo, { veredito: 'INVALID', origem: 'sintaxe' });
        assert.deepEqual([d.julgamentoLLM!.status, d.concordancia, d.classificacao], ['VALID', false, 'DISCORDANCIA_LLM']);
    });

    await teste('caso 3 / teste B (regressao permanente) — incremento proibido com FC 138: sintaxe VALID, AST, semantica INVALID, oraculo INVALID; juiz VALID -> DISCORDANCIA_LLM', async () => {
        assert.equal(REAL_2.telemetria.FC, 138);
        const d = await avaliar(registroDe(REAL_2, PLANO_PROIBIDO_FC138, comSequencia(SEQUENCIA_REAL_2.map((p, i) => (i === 0 ? { ...p, conduta: 'Titular_Vasopressor' } : p)))), juizQueResponde('VALID'));
        assert.equal(d.validacaoSintatica!.veredito, 'VALID', 'e DSL valida: o erro nao e de sintaxe');
        assert.equal(d.ast!.$type, 'PlanCommand');
        assert.equal(d.validacaoSemantica!.veredito, 'INVALID');
        const codigos = d.validacaoSemantica!.erros.map(e => `${e.etapa}:${e.codigo}`);
        assert.ok(codigos.includes('global:telemetria_global_incompativel'), codigos.join(', '));
        assert.deepEqual(d.oraculo, { veredito: 'INVALID', origem: 'semantica' });
        assert.equal(d.violacao, true);
        assert.deepEqual([d.julgamentoLLM!.status, d.concordancia, d.classificacao], ['VALID', false, 'DISCORDANCIA_LLM']);
        assert.equal(d.oraculo!.veredito, 'INVALID', 'o juiz nao absolve');
    });

    await teste('teste C (regressao permanente) — planos REAIS COMPLETED: sintaxe VALID, AST, as quatro etapas VALID, oraculo VALID', async () => {
        for (const [ctx, plano, seq] of [[REAL_1, PLANO_REAL_1, SEQUENCIA_REAL_1], [REAL_2, PLANO_REAL_2, SEQUENCIA_REAL_2]] as const) {
            for (const extra of [{}, comSequencia([...seq])]) {
                const d = await avaliar(registroDe(ctx, plano, extra), juizQueResponde('VALID'));
                assert.equal(d.validacaoSintatica!.veredito, 'VALID', JSON.stringify(d.validacaoSintatica!.erros));
                assert.equal(d.ast!.name, plano.split(' ')[1]);
                assert.deepEqual(d.validacaoSemantica!.etapas.map(e => e.veredito), ['VALID', 'VALID', 'VALID', 'VALID'], JSON.stringify(d.validacaoSemantica!.erros));
                assert.deepEqual(d.oraculo, { veredito: 'VALID', origem: 'semantica' });
                assert.deepEqual([d.concordancia, d.classificacao], [true, 'VALIDO_PELO_ORACULO']);
            }
        }
    });

    await teste('caso 4 / teste D — semanticamente UNRESOLVED: oraculo UNRESOLVED, e o juiz (VALID, INVALID ou UNRESOLVED) nao o altera', async () => {
        const semAlvo = { ...B, intencao: 'a pressao esta caindo, o que faco?' };
        const esperado: Record<Veredito, [boolean, string]> = {
            UNRESOLVED: [true, 'UNRESOLVIDO_PELO_ORACULO'], VALID: [false, 'DISCORDANCIA_LLM'], INVALID: [false, 'DISCORDANCIA_LLM']
        };
        for (const juiz of ['UNRESOLVED', 'VALID', 'INVALID'] as Veredito[]) {
            const d = await avaliar(registroDe(semAlvo, cb.r.resultado), juizQueResponde(juiz));
            assert.equal(d.validacaoSintatica!.veredito, 'VALID');
            assert.ok(d.ast);
            assert.equal(d.validacaoSemantica!.veredito, 'UNRESOLVED');
            assert.deepEqual(d.oraculo, { veredito: 'UNRESOLVED', origem: 'semantica' }, `juiz ${juiz}`);
            assert.equal(d.julgamentoLLM!.status, juiz);
            assert.deepEqual([d.concordancia, d.classificacao], esperado[juiz]);
        }
    });

    // =========================================================================
    console.log('\nSintaxe: G + parser Langium -> AST');
    // =========================================================================

    await teste('DSL valida: as duas pecas aceitam, e sai o AST oficial (PlanCommand), com o literal de cada quantidade', async () => {
        const s = await validarSintaxePlano(PLANO_REAL_1, analisador, gDaDsl);
        assert.deepEqual([s.sintaxe.veredito, s.sintaxe.erros, s.sintaxe.pecas], ['VALID', [], { gramatica: 'ACEITO', parser: 'ACEITO' }]);
        const ast = s.ast as unknown as { $type: string; name: string; protocol: { $refText: string }; orders: { drug: { $refText: string }; decision: string; dose: { value: number; unit: string; $literal: string } }[] };
        assert.equal(ast.$type, 'PlanCommand');
        assert.equal(ast.name, 'plano_rec_mulh0i7t_3_c1');
        assert.equal(ast.protocol.$refText, 'Choque_Septico');
        assert.deepEqual(ast.orders.map(o => [o.drug.$refText, o.decision, o.dose.value, o.dose.$literal, o.dose.unit]), [
            ['Noradrenalina', 'ESCALAR_EQUIPE', 0, '0.0', 'mcg/kg/min'],
            ['Vasopressina', 'INICIAR_INFUSAO', 0.01, '0.01', 'U/min']
        ]);
    });

    await teste('DSL invalida: erros de quem recusou, com codigo do parser, fonte, linha, coluna e campo/regra', async () => {
        const farmaco = await validarSintaxePlano(PLANO_REAL_1.replace('Vasopressina', 'Dopamina'), analisador, gDaDsl);
        assert.equal(farmaco.sintaxe.veredito, 'INVALID');
        assert.deepEqual(farmaco.sintaxe.erros.map(e => e.fonte).sort(), ['gramatica', 'ligacao']);
        const ligacao = farmaco.sintaxe.erros.find(e => e.fonte === 'ligacao')!;
        assert.deepEqual([ligacao.codigo, ligacao.campo, ligacao.encontrado, ligacao.linha], ['linking-error', 'OrderStmt.drug', 'Dopamina', 1]);
        assert.equal(farmaco.ast, undefined);
        const semAuditoria = await validarSintaxePlano(PLANO_REAL_1.replace(/ auditoria '[^']*'/, ''), analisador, gDaDsl);
        const erroParser = semAuditoria.sintaxe.erros.find(e => e.fonte === 'parser')!;
        assert.deepEqual([erroParser.codigo, erroParser.regra, erroParser.encontrado], ['parsing-error', 'PlanCommand', '}']);
    });

    await teste('o que so G recusa (justificativa ausente, aspas duplas): INVALID pela gramatica, com o parser aceitando', async () => {
        for (const texto of [
            PLANO_REAL_1.replace(/ justificativa 'Segundo o protocolo Choque_Septico, a hipoperfusao[^']*'/, ''),
            PLANO_REAL_1.replace("'Segundo o protocolo Choque_Septico, a hipoperfusao", '"Segundo o protocolo Choque_Septico, a hipoperfusao').replace("intervencao rapida.'", 'intervencao rapida."')
        ]) {
            const s = await validarSintaxePlano(texto, analisador, gDaDsl);
            assert.equal(s.sintaxe.veredito, 'INVALID');
            assert.deepEqual(s.sintaxe.pecas, { gramatica: 'RECUSADO', parser: 'ACEITO' });
            assert.deepEqual(s.sintaxe.erros.map(e => e.fonte), ['gramatica']);
            assert.equal(s.ast, undefined, 'sem as duas pecas, sem AST');
        }
    });

    await teste('o que so o parser recusa (G aceitando): INVALID pelo parser — as duas pecas sao exigidas', async () => {
        const recusa: AnalisadorDsl = { dominio: 'med', analisar: async () => ({ erros: [{ codigo: 'parsing-error', fonte: 'parser', mensagem: 'recusado pelo parser' }] }) };
        const s = await validarSintaxePlano(PLANO_REAL_1, recusa, gDaDsl);
        assert.deepEqual([s.sintaxe.veredito, s.sintaxe.pecas, s.sintaxe.erros.map(e => e.fonte)], ['INVALID', { gramatica: 'ACEITO', parser: 'RECUSADO' }, ['parser']]);
    });

    await teste('erros de G como o /verify os devolve (str() do Lark): classe, linha, coluna, encontrado e esperado', () => {
        const token = erroDaGramatica("Unexpected token Token('AUDITORIA', 'auditoria') at line 1, column 186.\nExpected one of: \n\t* JUSTIFICATIVA\nPrevious tokens: [Token('ACESSO_CENTRAL', 'ACESSO_CENTRAL')]\n");
        assert.deepEqual([token.codigo, token.fonte, token.linha, token.coluna, token.encontrado, token.esperado], ['UnexpectedToken', 'gramatica', 1, 186, 'auditoria', ['JUSTIFICATIVA']]);
        const caractere = erroDaGramatica('No terminal matches \'"\' in the current parser context, at line 2 col 200\n\ng/kg/h via ACESSO_CENTRAL justificativa "j"\n                                        ^\nExpected one of: \n\t* TEXTO\n\nPrevious tokens: Token(\'JUSTIFICATIVA\', \'justificativa\')\n');
        assert.deepEqual([caractere.codigo, caractere.linha, caractere.coluna, caractere.encontrado, caractere.esperado], ['UnexpectedCharacters', 2, 200, '"', ['TEXTO']]);
    });

    await teste('falha tecnica do parser Langium: "nao avaliado", com a peca no motivo — nunca um veredito', async () => {
        const quebra: AnalisadorDsl = { dominio: 'med', analisar: async () => { throw new Error('servicos Langium indisponiveis'); } };
        const lidos: PedidoJuiz[] = [];
        const d = await avaliar(registroDe(REF, planoRef), juizQueResponde('VALID', lidos), { analisador: quebra });
        assert.equal(d.naoAvaliado, true);
        assert.match(d.motivo!, /parser Langium: servicos Langium indisponiveis/);
        assert.deepEqual([d.validacaoSintatica, d.oraculo, lidos.length], [undefined, undefined, 0]);
    });

    await teste('falha tecnica do /verify (G ou Ĝ): "nao avaliado", e o juiz nem e chamado', async () => {
        for (const o of [
            { gDsl: async () => { throw new Error('inacessivel para /verify'); } },
            { gHat: async () => { throw new Error('inacessivel para /verify'); } }
        ] satisfies Opcoes[]) {
            const lidos: PedidoJuiz[] = [];
            const d = await avaliar(registroDe(REF, planoRef), juizQueResponde('INVALID', lidos), o);
            assert.equal(d.naoAvaliado, true);
            assert.match(d.motivo!, /\/verify/);
            assert.deepEqual([d.oraculo, lidos.length], [undefined, 0]);
            assert.equal(agregarMetricas([d]).total, 0);
        }
    });

    // =========================================================================
    console.log('\nUNRESOLVED: falta de dado nunca vira INVALID');
    // =========================================================================

    const confereUnresolved = (nome: string, sem: { veredito: string; erros: unknown[]; dadosFaltantes: string[] }, falta: RegExp): void => {
        assert.equal(sem.veredito, 'UNRESOLVED', `${nome}: ${JSON.stringify(sem.erros)}`);
        assert.deepEqual(sem.erros, [], `${nome}: UNRESOLVED nao tem erro`);
        assert.ok(sem.dadosFaltantes.some(f => falta.test(f)), `${nome}: ${sem.dadosFaltantes.join('; ')}`);
    };

    await teste('falta telemetria necessaria (regra que bloquearia o incremento sem a medida SvO2): UNRESOLVED na sequencia e na global', async () => {
        const ast = await astDe(cb.r.resultado);
        const k = await kDe(B, { regras: [regraSemMedida('Noradrenalina', 'SvO2')] });
        const sem = validarSemantica(projetarAst('med', ast), k, { valido: true });
        confereUnresolved('telemetria', sem, /^telemetria\.SvO2$/);
        assert.deepEqual(sem.etapas.map(e => [e.etapa, e.veredito]), [['gramatica_da_politica', 'VALID'], ['sequencia', 'UNRESOLVED'], ['pis', 'NOT_EVALUATED'], ['global', 'UNRESOLVED']]);
        assert.ok(sem.avisos.some(a => a.codigo === 'telemetria_insuficiente'));
        const oraculo = oraculoDe({ veredito: 'VALID', erros: [] }, sem);
        assert.deepEqual(oraculo, { veredito: 'UNRESOLVED', origem: 'semantica' });
        assert.deepEqual(compararAvaliacoes(oraculo, { status: 'INVALID' }), { concordancia: false, classificacao: 'DISCORDANCIA_LLM' });
        assert.equal(oraculo.veredito, 'UNRESOLVED', 'o juiz nao muda o oraculo');
    });

    await teste('falta conhecimento necessario (politica efetiva vazia): UNRESOLVED; L(Ĝ), PIs e global NOT_EVALUATED; /verify da politica nao e chamado', async () => {
        const vazia = comPoda(p => ({ ...p, politicas: [], acoes_permitidas: [], farmacos_liberados: [], vias_disponiveis: [] }));
        const chamadas = { n: 0 };
        const d = await avaliar(registroDe(REF, planoRef), juizQueResponde('VALID'), { adaptador: vazia, gHat: gHat(true, chamadas) });
        assert.equal(d.naoAvaliado, false, 'nao e falha tecnica (antes, o 422 do /verify virava "nao avaliado")');
        assert.equal(d.validacaoSintatica!.veredito, 'VALID');
        confereUnresolved('politica vazia', d.validacaoSemantica!, /itens na politica efetiva/);
        assert.deepEqual(d.validacaoSemantica!.etapas.map(e => [e.etapa, e.veredito]), [['gramatica_da_politica', 'NOT_EVALUATED'], ['sequencia', 'UNRESOLVED'], ['pis', 'NOT_EVALUATED'], ['global', 'NOT_EVALUATED']]);
        assert.equal(chamadas.n, 0);
        assert.deepEqual(d.oraculo, { veredito: 'UNRESOLVED', origem: 'semantica' });
        assert.deepEqual([d.julgamentoLLM!.status, d.classificacao], ['VALID', 'DISCORDANCIA_LLM']);
    });

    await teste('pedido sem alvo (nenhum item citado pelo nome): UNRESOLVED pela global, sem erro', async () => {
        const d = await avaliar(registroDe({ ...B, intencao: 'a pressao esta caindo, o que faco?' }, cb.r.resultado), juizQueResponde('UNRESOLVED'));
        confereUnresolved('pedido sem alvo', d.validacaoSemantica!, /item do pedido identificavel/);
        assert.ok(d.validacaoSemantica!.avisos.some(a => a.codigo === 'pedido_global_indeterminado'));
    });

    await teste('informacao insuficiente para determinar a decisao (o item citado nao tem decisao que realize conduta alguma): UNRESOLVED na sequencia', async () => {
        const soManterVazao = comPoda(p => ({ ...p, politicas: p.politicas.map(x => (x.item === 'Noradrenalina' ? { ...x, decisoes: ['MANTER_VAZAO'] } : x)) }));
        const plano = await planoDeUmaClausula(cb.r.resultado, 1, B, 'Manter_Bloqueio');
        const d = await avaliar(registroDe(B, plano), juizQueResponde('VALID'), { adaptador: soManterVazao });
        assert.equal(d.validacaoSintatica!.veredito, 'VALID');
        confereUnresolved('conduta para o item citado', d.validacaoSemantica!, /^conduta para Noradrenalina$/);
        assert.deepEqual(d.oraculo, { veredito: 'UNRESOLVED', origem: 'semantica' });
    });

    await teste('regra que obriga o que o conhecimento nao permite (escalonamento sem item que o realize): UNRESOLVED, e o escalonamento_ignorado da global vira lacuna', async () => {
        const semEscalar = comPoda(semDecisao('ESCALAR_EQUIPE'));
        const ctx = { ...REF, intencao: 'mantem o propofol bloqueado' };
        const plano = await planoDeUmaClausula(planoRef, 0, ctx, 'Manter_Bloqueio');
        const d = await avaliar(registroDe(ctx, plano), juizQueResponde('INVALID'), { adaptador: semEscalar });
        confereUnresolved('obrigatoria irrealizavel', d.validacaoSemantica!, /^item que realize Acionar_Equipe$/);
        assert.ok(d.validacaoSemantica!.avisos.some(a => a.etapa === 'global' && a.codigo === 'escalonamento_irrealizavel'));
        // Sem a reconciliacao, a global sozinha reprovaria por um escalonamento que nenhum plano poderia cumprir.
        const k = await kDe(ctx, { adaptador: semEscalar });
        const cru = validarPlanoGlobal(planoDoArtefato(projetarAst('med', d.ast!), k.contrato).plano, k);
        assert.deepEqual(cru.erros.map(e => e.codigo), ['escalonamento_ignorado']);
        assert.deepEqual([d.oraculo!.veredito, d.classificacao], ['UNRESOLVED', 'DISCORDANCIA_LLM'], 'o juiz INVALID nao transforma a lacuna em INVALID');
    });

    await teste('relacao entre itens so em texto (mecanismo, conduta) e regra_global: nao formalizados — nem INVALID, nem UNRESOLVED', async () => {
        const d = await avaliar(registroDe(REF, planoRef), juizQueResponde('VALID'));
        const sem = d.validacaoSemantica!;
        assert.equal(sem.veredito, 'VALID', 'texto nao reprova nem deixa indeterminado');
        assert.ok(sem.naoFormalizado.some(t => t.startsWith('regra_global [')), sem.naoFormalizado.join(' | '));
        assert.ok(sem.avisos.some(a => a.codigo === 'regras_globais_textuais'), 'o aviso do proprio validarPlanoGlobal');
    });

    // =========================================================================
    console.log('\nSemantica sobre o AST');
    // =========================================================================

    await teste('incremento proibido com PAM 52 (Propofol): semantica INVALID pela telemetria', async () => {
        const d = await avaliar(registroDe(REF, planoProibidoPAM), juizQueResponde('INVALID'));
        assert.equal(d.validacaoSintatica!.veredito, 'VALID');
        assert.ok(d.validacaoSemantica!.erros.some(e => e.etapa === 'global' && e.codigo === 'telemetria_global_incompativel'));
        assert.deepEqual([d.oraculo!.veredito, d.violacao, d.classificacao], ['INVALID', true, 'INVALIDO_PELO_ORACULO']);
    });

    await teste('decisao fora da politica (INICIAR_INFUSAO de Vancomicina, que ja esta em curso): semantica INVALID por decisao_inadmissivel', async () => {
        const plano = "plano Plano_Vanco para Choque_Septico { esquema_referencia AssistenteUTI_v2 paciente 'PT-TESTE-0001' sequencia [ Iniciar_Vasopressor ] ordem Vancomicina decisao INICIAR_INFUSAO dose 15.0 mg/kg via ACESSO_CENTRAL justificativa 'TFG 28' auditoria 'a' }";
        const d = await avaliar(registroDe(REF, plano), juizQueResponde('VALID'));
        assert.equal(d.validacaoSintatica!.veredito, 'VALID', JSON.stringify(d.validacaoSintatica!.erros));
        const codigos = d.validacaoSemantica!.erros.map(e => `${e.etapa}:${e.codigo}`);
        assert.ok(codigos.includes('global:decisao_inadmissivel'), codigos.join(', '));
        assert.equal(d.oraculo!.veredito, 'INVALID');
    });

    await teste('L(Ĝ) recusando o artefato reprova so a etapa dela (a politica escrita como gramatica)', async () => {
        const d = await avaliar(registroDe(REF, planoRef), juizQueResponde('VALID'), { gHat: gHat(false) });
        assert.deepEqual(Object.fromEntries(d.validacaoSemantica!.etapas.map(e => [e.etapa, e.veredito])), { gramatica_da_politica: 'INVALID', sequencia: 'VALID', pis: 'VALID', global: 'VALID' });
        assert.deepEqual(d.oraculo, { veredito: 'INVALID', origem: 'semantica' });
    });

    await teste('justificativa equivalente (outras palavras, os mesmos fatos) passa; justificativa sem evidencia, com justificativa_obrigatoria, nao', async () => {
        const a = projetarAst('med', await astDe(planoRef));
        const clausula = (i: number, j: string): string => {
            const c = a.clausulas[i];
            return `ordem ${c.item} decisao ${c.decisao} dose ${c.valor} ${c.unidade} via ${c.meio} justificativa '${j}'`;
        };
        const reescrito = (jNora: string, jPropofol: string): string => [
            `plano Plano_Revisado_Pelo_Plantao para ${a.contexto} { esquema_referencia AssistenteUTI_v2 paciente '${REF.paciente}'`,
            `sequencia [ ${[...a.sequencia].reverse().join(' , ')} ]`, clausula(1, jNora), clausula(0, jPropofol), "auditoria 'redigido de outra forma' }"
        ].join(' ');
        const equivalente = await avaliar(registroDe(REF, reescrito('choque septico com PAM 52 e lactato 4.8: equipe acionada', 'propofol segue bloqueado enquanto a PAM estiver em 52')), juizQueResponde('VALID'));
        assert.equal(equivalente.validacaoSemantica!.veredito, 'VALID', JSON.stringify(equivalente.validacaoSemantica!.erros));
        const semEvidencia = await avaliar(registroDe(REF, reescrito('equipe acionada pelo escalonamento que o protocolo disparou', 'propofol segue bloqueado enquanto a PAM estiver em 52')), juizQueResponde('VALID'));
        assert.deepEqual(semEvidencia.validacaoSemantica!.erros.map(e => `${e.etapa}:${e.codigo}`), ['pis:justificativa_sem_suporte']);
    });

    // =========================================================================
    console.log('\nAST: guardado = julgado; a semantica nao le texto');
    // =========================================================================

    await teste('AST preservado: o AST do resultado atravessa o JSONL e, projetado, da a MESMA semantica', async () => {
        const d = await avaliar(registroDe(REF, planoRef), juizQueResponde('VALID'));
        const doJsonl = JSON.parse(JSON.stringify(registrosJsonl('med', { naoAvaliados: 0, linhas: [montarLinha(1, REF.intencao!, d)] })[0])).ast as AstArtefato;
        assert.deepEqual(doJsonl, d.ast);
        const k = await kDe(REF);
        assert.deepEqual(projetarAst('med', doJsonl), projetarAst('med', d.ast!));
        const refeita = validarSemantica(projetarAst('med', doJsonl), k, { valido: true });
        assert.deepEqual(refeita.etapas, d.validacaoSemantica!.etapas, 'as etapas do resultado sao as do AST guardado');
    });

    await teste('a semantica e baseada no AST: mudar so a forma do texto (quebras, recuo) nao muda o AST nem a semantica', async () => {
        // So o espaco ENTRE tokens: antes de `sequencia [`, de cada `ordem <item> decisao` e de `auditoria '`
        // — nunca dentro de um texto entre aspas (a auditoria diz "na ordem do Planner").
        const reformatado = planoRef
            .replace(/ sequencia \[/, '\n    sequencia [')
            .replace(/ ordem (\w+) decisao /g, '\n    ordem $1 decisao ')
            .replace(/ auditoria '/, '\n    auditoria \'')
            .replace(/ \}$/, '\n}');
        assert.notEqual(reformatado, planoRef);
        const [a, b] = [await avaliar(registroDe(REF, planoRef), juizQueResponde('VALID')), await avaliar(registroDe(REF, reformatado), juizQueResponde('VALID'))];
        assert.deepEqual(b.ast, a.ast, 'o mesmo AST');
        assert.deepEqual(b.validacaoSemantica, a.validacaoSemantica, 'a mesma semantica');
    });

    await teste('isolamento: a semantica recebe um plano SEM texto e decide pelo AST; pela leitura do texto, o contrato seria artefato_vazio', async () => {
        const k = await kDe(REF);
        const { plano } = planoDoArtefato(projetarAst('med', await astDe(planoRef)), k.contrato);
        assert.equal(plano.texto, '', 'nao ha texto para reler');
        assert.equal(validarPlanoGlobal(plano, k).veredito, 'VALID', 'validarPlanoGlobal julga plano.lido (o AST)');
        assert.ok(verificarContrato(k.contrato, plano.texto).violacoes.some(v => v.tipo === 'artefato_vazio'), 'o caminho textual nao teria como aprovar');
        assert.throws(() => projetarAst('med', { $type: 'PlanCommand', name: 'x', orders: [{ decision: 'X', dose: { value: 0, unit: 'mg' } }] }), /sem \$literal/, 'AST que nao saiu do parser e recusado');
    });

    // =========================================================================
    console.log('\nDependencias (dependeDe vem da sequencia do Planner, nao da DSL)');
    // =========================================================================

    await teste('dependencias presentes (sequencia real, PI 2 depende do PI 1): conferidas, e nenhum aviso de dependencia', async () => {
        const d = await avaliar(registroDe(REAL_1, PLANO_REAL_1, comSequencia(SEQUENCIA_REAL_1)), juizQueResponde('VALID'));
        assert.equal(d.validacaoSemantica!.veredito, 'VALID');
        assert.ok(!d.validacaoSemantica!.avisos.some(a => a.codigo === 'dependencias_nao_informadas' || a.codigo === 'sequencia_nao_corresponde'));
    });

    await teste('dependencia invalida (PI 1 depende do PI 2): sintaxe VALID, semantica INVALID', async () => {
        const seq = ref.r.execucao.sequenciaValidada!.map((p, i) => ({ ...p, dependeDe: i === 0 ? [2] : [] }));
        const d = await avaliar(registroDe(REF, planoRef, comSequencia(seq)), juizQueResponde('VALID'));
        assert.equal(d.validacaoSintatica!.veredito, 'VALID');
        const codigos = d.validacaoSemantica!.erros.map(e => `${e.etapa}:${e.codigo}`);
        assert.ok(codigos.includes('sequencia:dependencia_posterior') && codigos.includes('global:dependencia_global_invalida'), codigos.join(', '));
        assert.deepEqual(d.oraculo, { veredito: 'INVALID', origem: 'semantica' });
    });

    await teste('dependencias ausentes mudam o veredito: o PI 2 cita o item do PI 1 de que depende — sem a sequencia, INVALID; com ela, VALID', async () => {
        const ctx = { ...REF, intencao: 'PAM 52 e lactato 4.8: aciona a equipe pela noradrenalina e pede controle da insulina' };
        const plano = "plano P para Choque_Septico { esquema_referencia AssistenteUTI_v2 paciente 'PT-TESTE-0001' sequencia [ Solicitar_Exame_Controle , Acionar_Equipe ] ordem Insulina_Regular decisao SOLICITAR_EXAME dose 0.0 UI/h via ACESSO_CENTRAL justificativa 'glicemia 210 no controle glicemico' ordem Noradrenalina decisao ESCALAR_EQUIPE dose 0.0 mcg/kg/min via ACESSO_CENTRAL justificativa 'lactato 4.8 no Choque_Septico, depois do controle de Insulina_Regular' auditoria 'a' }";
        const sem = await avaliar(registroDe(ctx, plano), juizQueResponde('VALID'));
        assert.equal(sem.validacaoSintatica!.veredito, 'VALID');
        assert.deepEqual(sem.validacaoSemantica!.erros.map(e => `${e.etapa}:${e.codigo}`), ['pis:justificativa_referencia_inexistente']);
        assert.ok(sem.validacaoSemantica!.avisos.some(a => a.codigo === 'dependencias_nao_informadas'));
        const com = await avaliar(registroDe(ctx, plano, comSequencia([
            { ordem: 1, item: 'Insulina_Regular', conduta: 'Solicitar_Exame_Controle', dependeDe: [] },
            { ordem: 2, item: 'Noradrenalina', conduta: 'Acionar_Equipe', dependeDe: [1] }
        ])), juizQueResponde('VALID'));
        assert.equal(com.validacaoSemantica!.veredito, 'VALID', JSON.stringify(com.validacaoSemantica!.erros));
    });

    await teste('sequencia que nao corresponde as clausulas do AST: nao e usada, e o aviso diz isso', async () => {
        const d = await avaliar(registroDe(REF, planoRef, comSequencia([{ ordem: 1, item: 'Adrenalina', conduta: 'Manter_Bloqueio', dependeDe: [] }])), juizQueResponde('VALID'));
        assert.ok(d.validacaoSemantica!.avisos.some(a => a.etapa === 'sequencia' && a.codigo === 'sequencia_nao_corresponde'));
        assert.equal(d.validacaoSemantica!.veredito, 'VALID');
    });

    // =========================================================================
    console.log('\nLLM Judge: experimental e independente');
    // =========================================================================

    await teste('as nove combinacoes: igual -> concordante com a classificacao do oraculo; diferente -> DISCORDANCIA_LLM; sem veredito do juiz, vale o oraculo', () => {
        const vereditos: Veredito[] = ['VALID', 'INVALID', 'UNRESOLVED'];
        const esperado: Record<Veredito, string> = { VALID: 'VALIDO_PELO_ORACULO', INVALID: 'INVALIDO_PELO_ORACULO', UNRESOLVED: 'UNRESOLVIDO_PELO_ORACULO' };
        for (const o of vereditos) {
            for (const j of vereditos) {
                assert.deepEqual(compararAvaliacoes({ veredito: o }, { status: j }), o === j ? { concordancia: true, classificacao: esperado[o] } : { concordancia: false, classificacao: 'DISCORDANCIA_LLM' }, `${o}+${j}`);
            }
            for (const s of ['NOT_CALLED', 'NO_RESPONSE'] as StatusJuiz[]) {
                assert.deepEqual(compararAvaliacoes({ veredito: o }, { status: s }), { classificacao: esperado[o] });
            }
        }
    });

    await teste('juiz INVALID com oraculo VALID (plano real): DISCORDANCIA_LLM, e o oraculo continua VALID', async () => {
        const d = await avaliar(registroDe(REAL_1, PLANO_REAL_1), juizQueResponde('INVALID'));
        assert.deepEqual(d.oraculo, { veredito: 'VALID', origem: 'semantica' });
        assert.equal(d.julgamentoLLM!.status, 'INVALID');
        assert.match(d.julgamentoLLM!.respostaBruta!, /veredito: INVALID/);
        assert.deepEqual([d.concordancia, d.classificacao], [false, 'DISCORDANCIA_LLM']);
        assert.deepEqual([montarLinha(1, '', d).temDivergencia, montarLinha(1, '', d).temDiscordancia], [false, true]);
    });

    await teste('juiz sem resposta: NO_RESPONSE com o motivo; as camadas deterministicas valem sozinhas; nenhum veredito inventado', async () => {
        const d = await avaliar(registroDe(REF, planoRef), async () => { throw new Error('motor respondeu 502: resposta do juiz sem veredito'); });
        assert.equal(d.naoAvaliado, false);
        assert.deepEqual(d.oraculo, { veredito: 'VALID', origem: 'semantica' });
        assert.equal(d.julgamentoLLM!.status, 'NO_RESPONSE');
        assert.match(d.julgamentoLLM!.motivo!, /502/);
        assert.deepEqual([d.concordancia, d.classificacao], [undefined, 'VALIDO_PELO_ORACULO']);
    });

    await teste('avaliacao cancelada: o cancelamento do juiz propaga (nao vira NO_RESPONSE)', async () => {
        const controlador = new AbortController();
        const juiz: JuizLLM = async () => { controlador.abort(); throw new Error('abortado'); };
        await assert.rejects(avaliar(registroDe(REF, planoRef), juiz, { sinal: controlador.signal }), /abortado/);
    });

    await teste('o juiz recebe o plano reconhecido e o contexto completo — e nada de sintaxe, AST, semantica ou oraculo', async () => {
        const lidos: PedidoJuiz[] = [];
        const d = await avaliar(registroDe(REF, planoProibidoPAM, { promptSemantico: ref.k.promptSemantico }), juizQueResponde('VALID', lidos));
        const p = lidos[0];
        assert.equal(p.plano, planoProibidoPAM, 'o mesmo texto que o parser reconheceu');
        assert.ok(p.plano.includes(String(d.ast!.name)));
        assert.equal(p.pedido, REF.intencao);
        assert.match(p.telemetria, /^- PAM = 52$/m);
        assert.match(p.conhecimento, /\[CENARIO\]/);
        assert.match(p.conhecimento, /\[POLITICA VIGENTE/);
        assert.match(p.evidencias, /Propofol \[bloqueio\].*PAM/, p.evidencias);
        const lido = JSON.stringify(p);
        for (const proibido of ['PlanCommand', '$literal', 'VALIDO_PELO', 'INVALIDO_PELO', 'validacao', 'oraculo', 'telemetria_global_incompativel', 'gramatica_da_politica']) {
            assert.ok(!lido.includes(proibido), `o juiz recebeu "${proibido}"`);
        }
    });

    await teste('contexto da geracao diferente do reconstruido: aviso contexto_divergente (e foco_indisponivel, sem Neo4j)', async () => {
        const d = await avaliar(registroDe(REF, planoRef, { promptSemantico: 'outro prompt semantico' }), juizQueResponde('VALID'));
        assert.deepEqual(d.validacaoSemantica!.avisos.filter(a => a.etapa === 'conhecimento').map(a => a.codigo), ['foco_indisponivel', 'contexto_divergente']);
    });

    await teste('juiz real (/validar-plano): envia todas as secoes e le veredito, justificativa, evidencias e resposta bruta', async () => {
        const corpos: Record<string, string>[] = [];
        let status = 200;
        const servidor = http.createServer((req, res) => {
            let corpo = '';
            req.on('data', parte => (corpo += parte));
            req.on('end', () => {
                corpos.push(JSON.parse(corpo));
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(status === 200
                    ? { veredito: 'INVALID', justificativa: 'porque sim', evidencias: ['a', 'b'], resposta_bruta: 'evidencias: a; b\njustificativa: porque sim\nveredito: INVALID' }
                    : { detail: 'resposta do juiz sem veredito' }));
            });
        });
        await new Promise<void>(resolve => servidor.listen(0, '127.0.0.1', resolve));
        try {
            const juiz = juizLLMHttp(`http://127.0.0.1:${(servidor.address() as AddressInfo).port}`, 10_000);
            const pedido: PedidoJuiz = { plano: 'P', pedido: 'Q', telemetria: '- PAM = 52', conhecimento: 'K', evidencias: 'E' };
            const j = await juiz(pedido, new AbortController().signal);
            assert.deepEqual(corpos[0], { plano: 'P', intencao: 'Q', telemetria: '- PAM = 52', contexto_neo4j: 'K', evidencias: 'E' });
            assert.deepEqual(j, { veredito: 'INVALID', justificativa: 'porque sim', evidencias: ['a', 'b'], respostaBruta: 'evidencias: a; b\njustificativa: porque sim\nveredito: INVALID' });
            status = 502;
            await assert.rejects(juiz(pedido, new AbortController().signal), /502.*sem veredito/);
        } finally {
            servidor.closeAllConnections();
            servidor.close();
        }
    });

    // =========================================================================
    console.log('\nMetricas e JSONL experimental');
    // =========================================================================

    await teste('metricas separam sintaxe, semantica, oraculo e juiz (NOT_CALLED, NO_RESPONSE) e contam cada par', async () => {
        const lados = [
            await avaliar(registroDe(REF, planoRef), juizQueResponde('VALID')),
            await avaliar(registroDe(REAL_1, PLANO_REAL_1), juizQueResponde('INVALID')),
            await avaliar(registroDe(REF, planoProibidoPAM), juizQueResponde('INVALID')),
            await avaliar(registroDe(REAL_2, PLANO_PROIBIDO_FC138), juizQueResponde('VALID')),
            await avaliar(registroDe({ ...B, intencao: 'a pressao esta caindo, o que faco?' }, cb.r.resultado), juizQueResponde('UNRESOLVED')),
            await avaliar(registroDe(REF, ''), juizQueResponde('VALID')),
            await avaliar(registroDe(REF, planoRef), async () => { throw new Error('juiz fora'); })
        ];
        const m = agregarMetricas(lados);
        assert.equal(m.total, 7);
        assert.deepEqual(m.sintaxe, { VALID: 6, INVALID: 1 });
        assert.deepEqual(m.semantica, { VALID: 3, INVALID: 2, UNRESOLVED: 1, NOT_EVALUATED: 1 });
        assert.deepEqual(m.oraculo, { VALID: 3, INVALID: 3, UNRESOLVED: 1 });
        assert.deepEqual(m.juiz, { VALID: 2, INVALID: 2, UNRESOLVED: 1, NOT_CALLED: 1, NO_RESPONSE: 1 });
        assert.deepEqual([m.concordantes, m.discordantes, m.violacoes], [3, 2, 2]);
        assert.deepEqual(m.pares, { 'VALID+VALID': 1, 'VALID+INVALID': 1, 'INVALID+INVALID': 1, 'INVALID+VALID': 1, 'UNRESOLVED+UNRESOLVED': 1 });
    });

    await teste('JSONL: um registro por plano, com sintaxe, AST, semantica, oraculo e juiz separados, sem o Prompt Semantico', async () => {
        const arq = await avaliar(registroDe(REAL_1, PLANO_REAL_1), juizQueResponde('INVALID'));
        const base = await avaliar(registroDe(REAL_1, ''), juizQueResponde('VALID'));
        const [a, b] = registrosJsonl('med', { naoAvaliados: 0, linhas: [montarLinha(1, REAL_1.intencao!, arq, base)] }).map(r => JSON.parse(JSON.stringify(r)));
        assert.deepEqual([a.dominio, a.lado, a.linha, a.sujeito], ['med', 'arquitetura', 1, 'PT-2026-4001']);
        assert.deepEqual([a.validacaoSintatica.veredito, a.ast.$type, a.validacaoSemantica.veredito, a.validacaoSemantica.etapas.length], ['VALID', 'PlanCommand', 'VALID', 4]);
        assert.deepEqual(a.oraculo, { veredito: 'VALID', origem: 'semantica' });
        assert.deepEqual([a.julgamentoLLM.status, a.concordancia, a.classificacao], ['INVALID', false, 'DISCORDANCIA_LLM']);
        assert.equal(a.contextoGrafo, undefined);
        assert.deepEqual([b.lado, b.validacaoSintatica.veredito, b.ast, b.validacaoSemantica.veredito, b.julgamentoLLM.status, b.classificacao], ['baseline', 'INVALID', undefined, 'NOT_EVALUATED', 'NOT_CALLED', 'INVALIDO_PELO_ORACULO']);
    });

    // Exemplo legivel: a regressao do incremento proibido (FC 138), com um juiz que discorda.
    const exemplo = await avaliar(registroDe(REAL_2, PLANO_PROIBIDO_FC138), juizQueResponde('VALID'));
    console.log('\n  --- exemplo: incremento proibido com FC 138 (plano real do cenario 2 alterado) ---');
    console.log(`    Sintaxe:       ${exemplo.validacaoSintatica!.veredito} (G ${exemplo.validacaoSintatica!.pecas!.gramatica}, parser ${exemplo.validacaoSintatica!.pecas!.parser})`);
    console.log(`    AST:           ${exemplo.ast!.$type} ${exemplo.ast!.name}`);
    console.log(`    Semantica:     ${exemplo.validacaoSemantica!.veredito} [${exemplo.validacaoSemantica!.etapas.map(e => `${e.etapa}=${e.veredito}`).join(', ')}]`);
    console.log(`    Oraculo:       ${exemplo.oraculo!.veredito} (origem: ${exemplo.oraculo!.origem})`);
    console.log(`    Judge:         ${exemplo.julgamentoLLM!.status}`);
    console.log(`    Classificacao: ${exemplo.classificacao}`);

    console.log(falhas === 0 ? `\nTodos os ${contagem} testes passaram.` : `\n${falhas} de ${contagem} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
