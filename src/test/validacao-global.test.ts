/**
 * Composicao, validacao global e reinicio global do modo multiagente.
 *
 *     ResultadoPI[] -> comporPlano (montarArtefato) -> /verify + validarPlanoGlobal
 *        VALID      -> COMPLETED
 *        INVALID    -> feedback global -> PLANNING (ciclo seguinte), ate ciclosGlobais
 *        UNRESOLVED -> UNRESOLVED
 *
 * O que se cobra:
 *   - a composicao reusa montarArtefato, preserva a ordem do Planner e nao
 *     muda item, conduta, decisao, valor nem justificativa; inconsistencia e
 *     defeito (FAILED), nunca corrigida;
 *   - PIs individualmente validos podem compor um plano invalido — conflito
 *     entre PIs, cobertura, telemetria, pedido —, e a validacao global o acusa
 *     de forma deterministica, sem LLM;
 *   - o reinicio volta ao Planner com feedback, dentro de ciclosGlobais, sem
 *     refazer a recuperacao, e o ciclo anterior fica intacto no historico.
 *
 * Roda OFFLINE: modelo da DSL e recuperacao deterministica reais; Planner, PI
 * Agent e /verify sao dubles (ou um motor falso HTTP que registra as rotas).
 */

import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Session } from 'neo4j-driver';

import { loadModel } from '../database/neo4j.js';
import {
    condutasPorDecisaoMed,
    esquemaDeDadosMed,
    esquemaDeclaradoMed,
    pruningPayload,
    retrieveConstraints,
    type ClinicalContext,
    type RetrievedConstraints
} from '../knowledge/graphrag.js';
import { lerArtefato, montarContrato, type ContratoArtefato } from '../knowledge/contrato.js';
import { comoClausulaLida, type PIPlanejado, type ResultadoPI } from '../knowledge/contrato-pi.js';
import { comporPlano, InconsistenciaComposicao, type PlanoComposto } from '../knowledge/composicao.js';
import { decomporPIs, relacionalDeRisco, type ConhecimentoDaDecomposicao } from '../knowledge/decompositor.js';
import type { RegraValidada } from '../knowledge/recuperacao-cypher.js';
import { auditoriaVazia } from '../knowledge/recuperacao-hibrida.js';
import type { ResultadoValidacao } from '../knowledge/validacao.js';
import { partesDaRelacao, validarPlanoGlobal } from '../knowledge/validacao-global.js';
import { alvoDoPedido, validarSequencia } from '../knowledge/validacao-sequencia.js';
import { validarPI } from '../knowledge/validacao-pi.js';
import { montarEntradaGeracao, montarPromptSemantico } from '../inference/llm-client.js';
import { decodificar, type MotorFragmento, type ResultadoMultiagente } from '../inference/decodificacao.js';
import { montarFeedbackGlobal, type VerificadorGramatical } from '../inference/ciclo-global.js';
import { incoerenciasDoContexto, resumoExecucao, type ContextoExecucaoMultiagente } from '../inference/multiagente.js';
import { lerSaidaPIAgent, montarPromptPIAgent, type MotorPIAgent, type PedidoPIAgent } from '../inference/pi-agent.js';
import type { MotorPlanner, PedidoPlanner } from '../inference/planner.js';
import { ADAPTADOR_MED, recuperarConhecimento, type ConhecimentoRecuperado } from '../inference/recuperacao-conhecimento.js';
import { RESPOSTA_VERIFY, piAgentQueObedece, piAgentRoteirizado, respostaQueObedece, saidaPI, verificadorQueAceita } from './dubles-pi-agent.js';

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

const codigos = (r: ResultadoValidacao): string[] => r.erros.map(e => e.codigo);
const avisos = (r: ResultadoValidacao): string[] => r.avisos.map(e => e.codigo);

/** Cenario de referencia: PAM 52 bloqueia o Propofol, FC 145 a Noradrenalina, e dois escalonamentos disparam. */
const REF: ClinicalContext = {
    paciente: 'PT-TESTE-0001',
    intencao: 'A pressao ta despencando (PAM=52), sobe a nora e aprofunda o propofol',
    telemetria: { PAM: 52, FC: 145, lactato: 4.8, RASS: 2, TFG: 28, plaquetas: 45, glicemia: 210 },
    populacoes: ['Renal_Cronico'],
    farmacosEmUso: ['Noradrenalina', 'Propofol', 'Vancomicina']
};
/**
 * Cenario B: nada bloqueia o incremento da Noradrenalina, nenhum escalonamento
 * dispara, e a Noradrenalina + Adrenalina e interacao de gravidade ALTA. Os
 * dois planos abaixo passam na validacao da sequencia; so o conjunto os separa.
 */
const B: ClinicalContext = {
    paciente: 'PT-TESTE-0002',
    intencao: 'sobe a noradrenalina',
    telemetria: { PAM: 58, FC: 110, lactato: 3.0 },
    populacoes: [],
    farmacosEmUso: ['Noradrenalina']
};
const CONFLITO = 'PLANO 1 | Noradrenalina | Titular_Vasopressor | [ ] 2 | Adrenalina | Iniciar_Vasopressor | [ 1 ] FIM';
const SEM_CONFLITO = 'PLANO 1 | Noradrenalina | Titular_Vasopressor | [ ] 2 | Adrenalina | Manter_Bloqueio | [ 1 ] FIM';
const REF_2 = 'PLANO 1 | Propofol | Manter_Bloqueio | [ ] 2 | Noradrenalina | Acionar_Equipe | [ 1 ] FIM';

const pi = (ordem: number, item: string, conduta: string, dependeDe: number[] = []): PIPlanejado => ({ ordem, item, conduta, dependeDe });

async function main(): Promise<void> {
    const modelo = await loadModel(path.join('src', 'examples', 'med', 'uti.dsl'));
    const esquema = esquemaDeclaradoMed(modelo);

    /** O conhecimento de um cenario, como a recuperacao deterministica o entrega. */
    function cenario(ctx: ClinicalContext) {
        const constraints = retrieveConstraints(modelo, ctx);
        const poda = pruningPayload(constraints, ctx);
        const contrato = montarContrato(poda, condutasPorDecisaoMed(modelo), constraints.escalonamentos.map(e => `${e.destino}: ${e.detalhe}`), esquemaDeDadosMed(modelo));
        const k = (extra: Partial<ConhecimentoDaDecomposicao> = {}): ConhecimentoDaDecomposicao => ({
            requestId: 'req-global', dominio: 'med', pedido: ctx.intencao!, telemetria: ctx.telemetria,
            contrato, politica: poda, regras: [], restricoes: constraints, esquema, ...extra
        });
        return { ctx, constraints, poda, contrato, k };
    }
    const ref = cenario(REF);
    const cb = cenario(B);

    /** Os resultados que o PI Agent (duble que obedece) produziria — cada um VALIDO individualmente. */
    function resultadosValidos(seq: PIPlanejado[], k: ConhecimentoDaDecomposicao): ResultadoPI[] {
        return decomporPIs(seq, k).map(c => {
            const leitura = lerSaidaPIAgent(saidaPI({ prompt: montarPromptPIAgent(c), subgrafo_regras: c.subgrafoDoItem, ordem: c.pi!.ordem, conduta: c.pi!.conduta }), c);
            const v = validarPI(leitura.valor!, c);
            assert.equal(v.veredito, 'VALID', `PI ${c.pi!.ordem} (${c.pi!.item}) deveria ser valido sozinho: ${JSON.stringify(v.erros)}`);
            return v.valor!;
        });
    }
    function compor(seq: PIPlanejado[], resultados: ResultadoPI[], contrato: ContratoArtefato, ciclo = 1): PlanoComposto {
        const r = comporPlano(seq, resultados, contrato, { requestId: 'req-global', ciclo });
        assert.equal(r.veredito, 'VALID', JSON.stringify(r));
        return r.valor!;
    }
    const SEQ_REF = [pi(1, 'Propofol', 'Manter_Bloqueio'), pi(2, 'Noradrenalina', 'Acionar_Equipe', [1])];
    const SEQ_REF_3 = [...SEQ_REF, pi(3, 'Vancomicina', 'Solicitar_Exame_Controle')];
    const resRef3 = resultadosValidos(SEQ_REF_3, ref.k());

    // =========================================================================
    console.log('\nComposicao');
    // =========================================================================

    await teste('caso 1 — um PI: cabecalho da composicao (identificador, contexto, esquema, sujeito, sequencia, auditoria) e uma clausula', () => {
        const p = compor([SEQ_REF[0]], [resRef3[0]], ref.contrato);
        assert.match(p.texto, /^plano plano_req_global_c1 para Choque_Septico \{ esquema_referencia AssistenteUTI_v2 paciente 'PT-TESTE-0001' sequencia \[ Manter_Bloqueio \] ordem Propofol /);
        assert.match(p.texto, /auditoria 'artefato composto de 1 PI\(s\) validado\(s\) individualmente, na ordem do Planner \(execucao req-global, ciclo 1\)' \}$/);
        assert.equal(p.lido.clausulas.length, 1);
        assert.match(p.identificador, /^[A-Za-z_][A-Za-z_0-9]*$/, 'identificador da gramatica');
    });

    await teste('casos 2-3 — dois e tres PIs: uma clausula por PI', () => {
        assert.equal(compor(SEQ_REF, resRef3.slice(0, 2), ref.contrato).lido.clausulas.length, 2);
        assert.equal(compor(SEQ_REF_3, resRef3, ref.contrato).lido.clausulas.length, 3);
    });

    await teste('casos 4-9 — ordem do Planner e item, conduta, decisao, valor, meio e justificativa preservados', () => {
        const p = compor(SEQ_REF_3, resRef3, ref.contrato);
        assert.deepEqual(p.lido.clausulas.map(c => c.item), ['Propofol', 'Noradrenalina', 'Vancomicina'], 'nao reordena (Noradrenalina < Propofol no alfabeto)');
        p.lido.clausulas.forEach((c, i) => {
            assert.deepEqual(c, comoClausulaLida(resRef3[i], i), `clausula ${i + 1}`);
            assert.equal(ref.contrato.condutaPorDecisao[c.decisao], SEQ_REF_3[i].conduta, 'a decisao realiza a conduta do PI');
        });
        assert.deepEqual(p.lido.sequencia, ['Manter_Bloqueio', 'Acionar_Equipe', 'Solicitar_Exame_Controle']);
        assert.deepEqual(p.resultados, resRef3);
        assert.ok(Object.isFrozen(p) && Object.isFrozen(p.resultados[0]), 'o plano e dado congelado');
        assert.ok(!Object.isFrozen(resRef3[0]), 'a entrada nao e congelada nem alterada');
    });

    await teste('caso 10 — dependencias preservadas: cada PI vem depois dos PIs de que depende', () => {
        const p = compor(SEQ_REF_3, resRef3, ref.contrato);
        assert.deepEqual(p.pis, SEQ_REF_3);
        assert.deepEqual(p.pis[1].dependeDe, [1]);
        assert.ok(p.lido.clausulas.findIndex(c => c.item === 'Propofol') < p.lido.clausulas.findIndex(c => c.item === 'Noradrenalina'));
    });

    await teste('caso 11 — artefato invalido: o contrato o reprova (escalonamento obrigatorio sem clausula)', () => {
        const p = compor([SEQ_REF[0]], [resRef3[0]], ref.contrato);
        const v = validarPlanoGlobal(p, ref.k());
        assert.equal(v.veredito, 'INVALID');
        assert.ok(codigos(v).includes('escalonamento_ignorado'));
    });

    await teste('caso 12 — resultado inconsistente com o PI ou contagem errada: InconsistenciaComposicao, nada e corrigido', () => {
        const trocado = { ...resRef3[1], item: 'Vasopressina' };
        assert.throws(() => comporPlano(SEQ_REF, [resRef3[0], trocado], ref.contrato, { requestId: 'r', ciclo: 1 }),
            (e: Error) => e instanceof InconsistenciaComposicao && /nao responde ao PI 2/.test(e.message));
        assert.throws(() => comporPlano(SEQ_REF, [resRef3[0]], ref.contrato, { requestId: 'r', ciclo: 1 }), /1 resultado\(s\) para 2 PI\(s\)/);
        assert.throws(() => comporPlano([], [], ref.contrato, { requestId: 'r', ciclo: 1 }), /sequencia vazia/);
        const aspas = { ...resRef3[0], justificativa: "com 'aspa'" };
        assert.throws(() => comporPlano([SEQ_REF[0]], [aspas], ref.contrato, { requestId: 'r', ciclo: 1 }), InconsistenciaComposicao);
    });

    await teste('sem contexto em foco o cabecalho nao e exprimivel: UNRESOLVED, nao artefato parcial', () => {
        const semContexto = { ...ref.contrato, contextos: [] };
        const r = comporPlano(SEQ_REF, resRef3.slice(0, 2), semContexto, { requestId: 'r', ciclo: 1 });
        assert.equal(r.veredito, 'UNRESOLVED');
        assert.equal(r.valor, undefined);
    });

    // =========================================================================
    console.log('\nValidacao global');
    // =========================================================================

    await teste('caso A — todos os PIs validos e plano globalmente valido: VALID, o proprio plano', () => {
        const p = compor(SEQ_REF_3, resRef3, ref.contrato);
        const v = validarPlanoGlobal(p, ref.k());
        assert.equal(v.veredito, 'VALID', JSON.stringify(v.erros));
        assert.equal(v.valor, p);
        // O pedido cita o Propofol mas nao nomeia decisao; as regra_global do cenario sao so texto e nao foram conferidas.
        assert.deepEqual(avisos(v), ['pedido_indeterminado', 'regras_globais_textuais']);
    });

    await teste('caso B — PI 1 e PI 2 validos sozinhos (e a sequencia valida), mas o par e incompativel: INVALID', () => {
        const seq = [pi(1, 'Noradrenalina', 'Titular_Vasopressor'), pi(2, 'Adrenalina', 'Iniciar_Vasopressor', [1])];
        assert.equal(validarSequencia(seq, { contrato: cb.contrato, politica: cb.poda, regras: [], pedido: B.intencao! }).veredito, 'VALID');
        const res = resultadosValidos(seq, cb.k());
        assert.deepEqual(res.map(r => r.acao.decisao), ['AUMENTAR_VAZAO', 'INICIAR_INFUSAO']);
        const v = validarPlanoGlobal(compor(seq, res, cb.contrato), cb.k());
        assert.deepEqual(codigos(v), ['incompatibilidade_global']);
        const e = v.erros[0];
        assert.deepEqual(e.pis, [1, 2]);
        assert.equal(e.regra, 'Noradrenalina + Adrenalina [alta]: efeito adrenergico aditivo com risco de arritmia');
        assert.ok(e.evidencias!.includes('PI 1 (Noradrenalina -> Titular_Vasopressor): AUMENTAR_VAZAO'));
        assert.ok(e.evidencias!.some(x => /nao associar sem indicacao de choque refratario/.test(x)), 'a condicao em texto vai como evidencia');
        assert.match(e.alternativas![0], /nao incrementar os dois/);

        // O mesmo par sem incremento duplo passa.
        const seq2 = [pi(1, 'Noradrenalina', 'Titular_Vasopressor'), pi(2, 'Adrenalina', 'Manter_Bloqueio', [1])];
        assert.equal(validarPlanoGlobal(compor(seq2, resultadosValidos(seq2, cb.k()), cb.contrato), cb.k()).veredito, 'VALID');
    });

    await teste('duplicidade: mesma conduta para itens diferentes e valida; o mesmo item duas vezes nao', () => {
        const seq = [pi(1, 'Propofol', 'Manter_Bloqueio'), pi(2, 'Noradrenalina', 'Manter_Bloqueio'), pi(3, 'Vasopressina', 'Acionar_Equipe')];
        const v = validarPlanoGlobal(compor(seq, resultadosValidos(seq, ref.k()), ref.contrato), ref.k());
        assert.equal(v.veredito, 'VALID', JSON.stringify(v.erros));
        const dup = [pi(1, 'Propofol', 'Manter_Bloqueio'), pi(2, 'Propofol', 'Manter_Bloqueio'), pi(3, 'Noradrenalina', 'Acionar_Equipe')];
        const r = resultadosValidos([dup[0], { ...dup[2], ordem: 2 }], ref.k());
        const resDup = [r[0], { ...r[0], ordem: 2 }, { ...r[1], ordem: 3 }];
        assert.ok(codigos(validarPlanoGlobal(compor(dup, resDup, ref.contrato), ref.k())).includes('item_repetido'));
    });

    await teste('caso C — cobertura insuficiente: item citado no pedido sem clausula; nenhum citado tratado', () => {
        const seq = [pi(1, 'Propofol', 'Manter_Bloqueio'), pi(2, 'Vasopressina', 'Acionar_Equipe')];
        const p = compor(seq, resultadosValidos(seq, ref.k()), ref.contrato);
        const pedido = 'mantem o propofol e ve a noradrenalina';
        const v = validarPlanoGlobal(p, ref.k({ pedido }));
        assert.deepEqual(codigos(v), ['cobertura_insuficiente']);
        assert.equal(v.erros[0].item, 'Noradrenalina');
        const seq2 = [pi(1, 'Noradrenalina', 'Acionar_Equipe')];
        const v2 = validarPlanoGlobal(compor(seq2, resultadosValidos(seq2, ref.k()), ref.contrato), ref.k());
        assert.deepEqual(codigos(v2), ['pedido_incompativel'], 'o pedido de referencia cita o Propofol');
    });

    await teste('caso D — telemetria global incompativel: incremento que a PAM medida bloqueia, com a evidencia', () => {
        const seq = [pi(1, 'Propofol', 'Titular_Vasopressor'), pi(2, 'Noradrenalina', 'Acionar_Equipe')];
        const [, nora] = resultadosValidos(SEQ_REF, ref.k());
        const propofol: ResultadoPI = {
            ordem: 1, item: 'Propofol', conduta: 'Titular_Vasopressor',
            acao: { decisao: 'AUMENTAR_VAZAO', meio: 'ACESSO_CENTRAL', valor: { valor: '0.5', unidade: 'mg/kg/h' } }, justificativa: 'PAM 52'
        };
        const v = validarPlanoGlobal(compor(seq, [propofol, nora], ref.contrato), ref.k());
        assert.ok(codigos(v).includes('telemetria_global_incompativel'));
        assert.ok(!codigos(v).includes('decisao_inadmissivel'), 'a mesma clausula nao e acusada duas vezes');
        const e = v.erros.find(x => x.codigo === 'telemetria_global_incompativel')!;
        assert.deepEqual([e.pi, e.item], [1, 'Propofol']);
        assert.ok(e.evidencias!.includes('PAM 52 < 60 mmHg') && e.evidencias!.includes('PAM = 52'));
    });

    await teste('caso E — conhecimento insuficiente: UNRESOLVED, nao INVALID', () => {
        const p = compor(SEQ_REF_3, resRef3, ref.contrato);
        const v = validarPlanoGlobal(p, ref.k({ pedido: 'o paciente piorou, o que faco agora?' }));
        assert.equal(v.veredito, 'UNRESOLVED');
        assert.deepEqual(v.dadosFaltantes, ['item do pedido identificavel no conhecimento']);
        assert.ok(avisos(v).includes('pedido_global_indeterminado'));
        assert.match(v.promptRecomendado!, /nao cita pelo nome nenhum item/);

        // Medida que falta para uma regra que bloquearia um incremento do plano (hibrido).
        const lacuna: RegraValidada = {
            regraId: 'Farmaco:Noradrenalina/RegraSeguranca/SvO2<65', tipo: 'RegraSeguranca', relacao: 'BLOQUEIA_INCREMENTO', item: 'Noradrenalina',
            dominio: 'med', aplicavel: false, condicoesSatisfeitas: [], condicoesFalhas: [],
            lacunas: [{ campo: 'SvO2', esperado: '< 65 %', motivo: 'nao medido' }], evidencia: {},
            validacaoCypher: { valida: false, motivo: 'sem evidencia', consulta: '' }, efeito: {},
            rag: { candidatoId: 'Farmaco:Noradrenalina', escore: 0.9, cosseno: 0.8, papel: 'item', posicao: 0 }
        };
        const seq = [pi(1, 'Noradrenalina', 'Titular_Vasopressor'), pi(2, 'Adrenalina', 'Manter_Bloqueio', [1])];
        const v2 = validarPlanoGlobal(compor(seq, resultadosValidos(seq, cb.k()), cb.contrato), cb.k({ regras: [lacuna] }));
        assert.equal(v2.veredito, 'UNRESOLVED');
        assert.deepEqual(v2.dadosFaltantes, ['telemetria.SvO2']);
    });

    await teste('caso F — pedido incompativel: INVALID com evidencia; sem como atender, so aviso; sem item, UNRESOLVED', () => {
        const seq = [pi(1, 'Noradrenalina', 'Acionar_Equipe')];
        const p = compor(seq, resultadosValidos(seq, ref.k()), ref.contrato);
        const v = validarPlanoGlobal(p, ref.k({ pedido: 'reduzir a noradrenalina agora' }));
        assert.deepEqual(codigos(v), ['pedido_global_incompativel']);
        assert.deepEqual(v.erros[0].alternativas, ['dar a Noradrenalina a conduta Reduzir_Infusao']);
        // O pedido atendido passa.
        const seqOk = [pi(1, 'Noradrenalina', 'Reduzir_Infusao'), pi(2, 'Vasopressina', 'Acionar_Equipe')];
        const vOk = validarPlanoGlobal(compor(seqOk, resultadosValidos(seqOk, ref.k()), ref.contrato), ref.k({ pedido: 'reduzir a noradrenalina agora' }));
        assert.equal(vOk.veredito, 'VALID', JSON.stringify(vOk.erros));
        // Pedido de algo que a politica bloqueia (FC 145 tira o AUMENTAR_VAZAO): o plano nao podia; aviso, nao erro.
        const vBloq = validarPlanoGlobal(p, ref.k({ pedido: 'aumentar a noradrenalina' }));
        assert.equal(vBloq.veredito, 'VALID');
        assert.ok(avisos(vBloq).includes('pedido_nao_atendivel'));
    });

    await teste('dependencia que o artefato nao respeita: dependencia_global_invalida', () => {
        const seq = [pi(1, 'Propofol', 'Manter_Bloqueio', [2]), pi(2, 'Noradrenalina', 'Acionar_Equipe')];
        const res = resultadosValidos(SEQ_REF, ref.k());
        const v = validarPlanoGlobal(compor(seq, res, ref.contrato), ref.k());
        assert.deepEqual(codigos(v), ['dependencia_global_invalida']);
        assert.deepEqual(v.erros[0].pis, [1, 2]);
    });

    await teste('justificativa que afirma medida diferente da observada no cenario inteiro: INVALID', () => {
        const res = resultadosValidos(SEQ_REF, ref.k());
        const trocada = { ...res[1], justificativa: `${res[1].justificativa}; FC 120` };
        const v = validarPlanoGlobal(compor(SEQ_REF, [res[0], trocada], ref.contrato), ref.k());
        assert.deepEqual(codigos(v), ['justificativa_telemetria_divergente']);
        assert.equal(v.erros[0].pi, 2);
    });

    await teste('so a relacao de RISCO reprova combinacao: interacao (med) e incompatibilidade (agro) sim, agravante (fut) nao', () => {
        assert.deepEqual(['med', 'agro', 'fut'].map(d => relacionalDeRisco(d as 'med')), [true, true, false]);
    });

    // -------------------------------------------------------------------------
    // Fronteira: so o estruturado decide; texto e evidencia
    // -------------------------------------------------------------------------
    const SEQ_PAR = [pi(1, 'Noradrenalina', 'Titular_Vasopressor'), pi(2, 'Adrenalina', 'Iniciar_Vasopressor', [1])];
    const PAR = (r: { entre: string }): boolean => /Noradrenalina/.test(r.entre) && /(^|[^o])Adrenalina/.test(r.entre.replace('Noradrenalina', ''));
    /** O cenario B com a regra relacional Noradrenalina + Adrenalina trocada. */
    function comRelacao(mudanca: Partial<{ gravidade: string; mecanismo: string; conduta: string }>): ConhecimentoDaDecomposicao {
        const interacoes = cb.constraints.interacoes.map(r => (PAR(r) ? { ...r, ...mudanca } : r));
        assert.equal(interacoes.filter(PAR).length, 1, 'pre-condicao: uma relacao do par');
        return cb.k({ restricoes: { ...cb.constraints, interacoes } });
    }
    const validarPar = (k: ConhecimentoDaDecomposicao) => validarPlanoGlobal(compor(SEQ_PAR, resultadosValidos(SEQ_PAR, k), cb.contrato), k);

    await teste('fronteira — a condicao em TEXTO de uma relacao nao estruturada de risco nao produz INVALID', () => {
        // "nao associar sem indicacao de choque refratario documentada" esta ai, em
        // texto; a gravidade estruturada e moderada: aviso, nunca erro.
        const v = validarPar(comRelacao({ gravidade: 'moderada', conduta: 'nao associar sem indicacao de choque refratario documentada' }));
        assert.equal(v.veredito, 'VALID', JSON.stringify(v.erros));
        assert.ok(avisos(v).includes('interacao_entre_pis'));
        const aviso = v.avisos.find(a => a.codigo === 'interacao_entre_pis')!;
        assert.ok(aviso.evidencias!.includes('o conhecimento orienta (texto, nao avaliado): nao associar sem indicacao de choque refratario documentada'));
        // Nem mesmo uma proibicao explicita em texto decide.
        const proibe = validarPar(comRelacao({ gravidade: 'baixa', mecanismo: 'PROIBIDO associar', conduta: 'nunca associar; contraindicado' }));
        assert.equal(proibe.veredito, 'VALID', 'texto sozinho nao produz INVALID');
    });

    await teste('fronteira — incompatibilidade ESTRUTURADA continua INVALID, qualquer que seja o texto', () => {
        // O caso B original (gravidade alta, incremento nos dois): INVALID.
        assert.deepEqual(codigos(validarPar(cb.k())), ['incompatibilidade_global']);
        // O texto permissivo nao absolve; o texto vazio nao impede.
        const permissivo = validarPar(comRelacao({ mecanismo: 'associacao segura', conduta: 'pode associar livremente' }));
        assert.deepEqual(codigos(permissivo), ['incompatibilidade_global']);
        assert.equal(permissivo.erros[0].regra, 'Noradrenalina + Adrenalina [alta]: associacao segura');
        assert.deepEqual(codigos(validarPar(comRelacao({ mecanismo: '', conduta: '' }))), ['incompatibilidade_global']);
        // O que decide: o par, a gravidade — e o texto separado.
        const regra = cb.constraints.interacoes.find(PAR)!;
        assert.deepEqual(partesDaRelacao(regra), {
            estruturado: { itens: ['Noradrenalina', 'Adrenalina'], gravidade: 'alta' },
            texto: { mecanismo: regra.mecanismo, conduta: regra.conduta }
        });
    });

    await teste('regra_global textual — contexto e evidencia, nunca INVALID', () => {
        // A regra textual "Vasopressor em acesso periferico so e admissivel por ate
        // 6 h" nao e avaliada: o plano com Noradrenalina via ACESSO_PERIFERICO, que
        // o contrato admite, e VALID.
        const seq = [pi(1, 'Noradrenalina', 'Titular_Vasopressor'), pi(2, 'Adrenalina', 'Manter_Bloqueio', [1])];
        const [nora, adr] = resultadosValidos(seq, cb.k());
        const periferico = { ...nora, acao: { ...nora.acao, meio: 'ACESSO_PERIFERICO' } };
        const p = compor(seq, [periferico, adr], cb.contrato);
        assert.match(p.texto, /via ACESSO_PERIFERICO/);
        const v = validarPlanoGlobal(p, cb.k());
        assert.equal(v.veredito, 'VALID', JSON.stringify(v.erros));
        const aviso = v.avisos.find(a => a.codigo === 'regras_globais_textuais')!;
        assert.ok(aviso.evidencias!.includes('[moderada] Vasopressor em acesso periferico so e admissivel por ate 6 h como ponte para acesso central'));
        assert.match(aviso.mensagem, /so texto: contexto e evidencia, nao conferidas/);

        // Uma regra global que, em texto, proibe exatamente o plano: continua VALID.
        const proibe = { descricao: 'Noradrenalina nunca pode ser titulada para cima', severidade: 'contraindicada' };
        const kProibe = cb.k({ restricoes: { ...cb.constraints, regrasGlobais: [...cb.constraints.regrasGlobais, proibe] } });
        const v2 = validarPlanoGlobal(p, kProibe);
        assert.equal(v2.veredito, 'VALID');
        assert.ok(v2.avisos.find(a => a.codigo === 'regras_globais_textuais')!.evidencias!.includes('[contraindicada] Noradrenalina nunca pode ser titulada para cima'));
        // Sem regra global, sem aviso.
        const v3 = validarPlanoGlobal(p, cb.k({ restricoes: { ...cb.constraints, regrasGlobais: [] } }));
        assert.ok(!avisos(v3).includes('regras_globais_textuais'));
    });

    await teste('alvo do pedido — deterministico: o item citado pelo nome inteiro, ou UNRESOLVED', () => {
        const ks = (pedido: string) => ({ contrato: cb.contrato, politica: cb.poda, regras: [], pedido });
        assert.deepEqual(alvoDoPedido(ks('sobe a noradrenalina')).valor, ['Noradrenalina']);
        assert.deepEqual([...alvoDoPedido(ks('noradrenalina e adrenalina juntas?')).valor!].sort(), ['Adrenalina', 'Noradrenalina']);
        const sem = alvoDoPedido(ks('a pressao esta caindo, o que faco?'));
        assert.equal(sem.veredito, 'UNRESOLVED');
        assert.deepEqual(avisos(sem), ['pedido_sem_alvo']);
        assert.equal(alvoDoPedido(ks('sobe a nora')).veredito, 'UNRESOLVED', 'apelido nao e o nome: nada aproximado (o mesmo criterio da validacao global)');
        // Politica vazia nao e falta de alvo: e lacuna do conhecimento, decidida em lacunasDoConhecimento.
        assert.equal(alvoDoPedido({ ...ks('qualquer coisa'), politica: { ...cb.poda, politicas: [] } }).veredito, 'VALID');
        // A validacao global usa o mesmo criterio: o plano mais correto nao muda o veredito.
        const seq = [pi(1, 'Noradrenalina', 'Titular_Vasopressor'), pi(2, 'Adrenalina', 'Manter_Bloqueio', [1])];
        const p = compor(seq, resultadosValidos(seq, cb.k()), cb.contrato);
        assert.equal(validarPlanoGlobal(p, cb.k({ pedido: 'a pressao esta caindo, o que faco?' })).veredito, 'UNRESOLVED');
    });

    await teste('feedback global: PIs envolvidos, o que cada um decidiu, regra, evidencia e reparo — para o Planner', () => {
        const seq = [pi(1, 'Noradrenalina', 'Titular_Vasopressor'), pi(2, 'Adrenalina', 'Iniciar_Vasopressor', [1])];
        const p = compor(seq, resultadosValidos(seq, cb.k()), cb.contrato);
        const f = montarFeedbackGlobal(validarPlanoGlobal(p, cb.k()), p, 1);
        for (const trecho of [
            'PLANO GLOBAL REJEITADO pela validacao do plano completo (ciclo 1).',
            'plano anterior: PLANO 1 | Noradrenalina | Titular_Vasopressor | [ ] 2 | Adrenalina | Iniciar_Vasopressor | [ 1 ] FIM',
            '- PI 1 (Noradrenalina -> Titular_Vasopressor): AUMENTAR_VAZAO',
            '- PI 2 (Adrenalina -> Iniciar_Vasopressor): INICIAR_INFUSAO',
            '- incompatibilidade_global:', '  PIs: 1, 2', '  regra: Noradrenalina + Adrenalina [alta]', '  evidencia: ', '  reparo possivel: ',
            'Gere novamente SOMENTE a sequencia de PIs.'
        ]) assert.ok(f.includes(trecho), trecho);
        assert.ok(!f.includes("justificativa '"), 'nada de clausula nem justificativa no feedback ao Planner');
    });

    // =========================================================================
    console.log('\nReinicio global (fluxo multiagente com dubles)');
    // =========================================================================

    const originais = {
        modo: process.env.SPC_CML_DECODIFICACAO,
        ciclos: process.env.SPC_CML_MAX_CICLOS_GLOBAIS,
        planner: process.env.SPC_CML_MAX_TENTATIVAS_PLANNER,
        porPI: process.env.SPC_CML_MAX_TENTATIVAS_PI
    };
    const restaurar = (): void => {
        for (const [chave, valor] of [
            ['SPC_CML_DECODIFICACAO', originais.modo], ['SPC_CML_MAX_CICLOS_GLOBAIS', originais.ciclos],
            ['SPC_CML_MAX_TENTATIVAS_PLANNER', originais.planner], ['SPC_CML_MAX_TENTATIVAS_PI', originais.porPI]
        ] as const) {
            if (valor === undefined) delete process.env[chave];
            else process.env[chave] = valor;
        }
    };
    const conhecimentoDe = (s: ReturnType<typeof cenario>, id: string): ConhecimentoRecuperado<RetrievedConstraints> => ({
        constraints: s.constraints, foco: null, auditoriaRecuperacao: auditoriaVazia('deterministica', 'med', s.ctx.intencao!, id),
        poda: s.poda, politicaEfetiva: s.poda, promptSemantico: montarPromptSemantico(s.constraints, s.ctx, s.poda)
    });

    interface Rodada { ctx: ContextoExecucaoMultiagente; r: ResultadoMultiagente; planner: PedidoPlanner[]; pis: PedidoPIAgent[]; verificados: string[]; fragmentos: number }
    async function fluxo(
        s: ReturnType<typeof cenario>,
        planos: string[],
        opcoes: { piAgent?: MotorPIAgent; verificador?: VerificadorGramatical; conhecimento?: ConhecimentoRecuperado<RetrievedConstraints>; pis?: PedidoPIAgent[] } = {}
    ): Promise<Rodada> {
        const planner: PedidoPlanner[] = [];
        const pis = opcoes.pis ?? [];
        const verificados: string[] = [];
        let fragmentos = 0;
        const motor: MotorFragmento = async () => { fragmentos++; return { fragmento: '', encerrou: true }; };
        const motorPlanner: MotorPlanner = async pedido => {
            planner.push(pedido);
            return { saida: planos[Math.min(planner.length, planos.length) - 1], tokens_prompt: 4000 };
        };
        process.env.SPC_CML_DECODIFICACAO = 'multiagente';
        for (const v of ['SPC_CML_MAX_CICLOS_GLOBAIS', 'SPC_CML_MAX_TENTATIVAS_PLANNER', 'SPC_CML_MAX_TENTATIVAS_PI']) delete process.env[v];
        try {
            const k = opcoes.conhecimento ?? conhecimentoDe(s, `req-${Math.random().toString(36).slice(2)}`);
            const r = (await decodificar({
                ...montarEntradaGeracao(s.ctx, s.constraints, modelo, k.politicaEfetiva, k),
                endpoint: 'http://127.0.0.1:9', motor, motorPlanner,
                motorPIAgent: opcoes.piAgent ?? piAgentQueObedece(pis),
                verificadorGramatical: opcoes.verificador ?? verificadorQueAceita(verificados)
            })) as ResultadoMultiagente;
            return { ctx: r.execucao, r, planner, pis, verificados, fragmentos };
        } finally {
            restaurar();
        }
    }
    const caminho = (ctx: ContextoExecucaoMultiagente): string[] => [ctx.historicoStatus[0].de, ...ctx.historicoStatus.map(t => t.para)];

    await teste('integracao — RECEIVED ... PI_ALL_VALID -> COMPOSING -> GLOBAL_VALIDATING -> COMPLETED, com o artefato como resultado', async () => {
        const x = await fluxo(ref, [REF_2]);
        assert.deepEqual(caminho(x.ctx), [
            'RECEIVED', 'KNOWLEDGE_RETRIEVED', 'SEMANTIC_PROMPT_READY', 'PLANNING', 'SEQUENCE_VALIDATING', 'SEQUENCE_VALID',
            'PI_DECOMPOSING', 'PI_DECOMPOSED', 'PI_EXECUTING', 'PI_VALIDATING', 'PI_EXECUTING', 'PI_VALIDATING', 'PI_ALL_VALID',
            'COMPOSING', 'GLOBAL_VALIDATING', 'COMPLETED'
        ]);
        assert.equal(x.r.resultado, x.ctx.artefatoFinal);
        assert.equal(x.r.valido, true);
        assert.equal(x.r.conforme, true);
        assert.deepEqual(x.verificados, [x.ctx.artefatoFinal], 'o artefato composto foi a /verify, uma vez');
        assert.equal(x.ctx.validacaoGlobal!.veredito, 'VALID');
        assert.deepEqual(x.ctx.resultadosPI.map(r => r.item), ['Propofol', 'Noradrenalina']);
        assert.deepEqual(lerArtefato(x.ctx.artefatoFinal!, ref.contrato.papeis).clausulas.map(c => c.decisao), ['MANTER_BLOQUEADO', 'ESCALAR_EQUIPE']);
        assert.equal(x.ctx.historicoGlobal.length, 1);
        assert.equal(x.ctx.historicoGlobal[0].desfecho, 'COMPLETED');
        assert.equal(x.fragmentos, 0, 'nem incremental nem monolitica');
        assert.deepEqual(incoerenciasDoContexto(x.ctx), []);
    });

    await teste('caso A (reinicio) — ciclo 1 globalmente INVALID, ciclo 2 VALID: COMPLETED em exatamente 2 ciclos', async () => {
        const x = await fluxo(cb, [CONFLITO, SEM_CONFLITO]);
        assert.equal(x.ctx.status, 'COMPLETED');
        assert.equal(x.planner.length, 2, 'uma proposta do Planner por ciclo');
        assert.deepEqual(x.pis.map(p => p.ordem), [1, 2, 1, 2], 'cada ciclo gera os seus ResultadoPI');
        assert.deepEqual(x.ctx.historicoGlobal.map(c => [c.ciclo, c.desfecho]), [[1, 'PLANNING'], [2, 'COMPLETED']]);
        assert.deepEqual(x.ctx.tentativasPlanner.map(t => t.ciclo), [1, 2]);
        assert.match(x.planner[1].prompt, /\[FEEDBACK DA VALIDACAO ANTERIOR\]\nPLANO GLOBAL REJEITADO/, 'o feedback global vai ao Planner');
        assert.ok(!x.pis.some(p => p.prompt.includes('PLANO GLOBAL REJEITADO')), 'e nao aos PI Agents');
        assert.equal(x.ctx.historicoGlobal[0].realimentacao, x.planner[1].prompt.match(/\[FEEDBACK DA VALIDACAO ANTERIOR\]\n([\s\S]*?)\n\nformato:/)![1]);
        const reinicio = [
            'PI_ALL_VALID', 'COMPOSING', 'GLOBAL_VALIDATING', 'PLANNING', 'SEQUENCE_VALIDATING', 'SEQUENCE_VALID',
            'PI_DECOMPOSING', 'PI_DECOMPOSED', 'PI_EXECUTING', 'PI_VALIDATING', 'PI_EXECUTING', 'PI_VALIDATING', 'PI_ALL_VALID',
            'COMPOSING', 'GLOBAL_VALIDATING', 'COMPLETED'
        ];
        assert.deepEqual(caminho(x.ctx).slice(-reinicio.length), reinicio, 'GLOBAL_VALIDATING -> INVALID -> PLANNING -> ... -> COMPLETED');
        assert.deepEqual(incoerenciasDoContexto(x.ctx), []);
    });

    await teste('caso B (reinicio) — INVALID nos 2 ciclos: UNRESOLVED, nunca um terceiro', async () => {
        const x = await fluxo(cb, [CONFLITO, CONFLITO, CONFLITO]);
        assert.equal(x.ctx.status, 'UNRESOLVED');
        assert.equal(x.planner.length, 2, 'ciclosGlobais padrao = 2');
        assert.deepEqual(x.ctx.historicoGlobal.map(c => [c.ciclo, c.desfecho]), [[1, 'PLANNING'], [2, 'UNRESOLVED']]);
        const ultimo = x.ctx.errosValidacao[x.ctx.errosValidacao.length - 1];
        assert.deepEqual([ultimo.veredito, avisos(ultimo)], ['UNRESOLVED', ['orcamento_esgotado']]);
        assert.match(ultimo.promptRecomendado!, /PLANO GLOBAL REJEITADO/);
        assert.match(x.ctx.historicoStatus[x.ctx.historicoStatus.length - 1].motivo!, /orcamento de ciclos globais esgotado \(2\/2\)/);
        assert.equal(x.r.resultado, '', 'sem artefato');
        assert.equal(x.ctx.artefatoFinal, undefined);
        assert.deepEqual(incoerenciasDoContexto(x.ctx), []);
    });

    // O pedido sem item citado (antes: 'caso C (reinicio)', que chegava a 1 Planner
    // e a validacao global UNRESOLVED) agora termina ANTES do Planner: nenhum plano
    // o tornaria determinavel, e a validacao global usa o mesmo criterio.
    await teste('caso C (reinicio) / pedido sem alvo determinavel — UNRESOLVED ANTES do Planner: nenhum Planner, nenhum PI Agent, nenhum ciclo', async () => {
        const semItem = cenario({ ...B, intencao: 'a pressao esta caindo, o que faco?' });
        let recuperacoes = 0;
        const adaptador = { ...ADAPTADOR_MED, recuperar: (m: Parameters<typeof ADAPTADOR_MED.recuperar>[0], c: ClinicalContext) => { recuperacoes++; return ADAPTADOR_MED.recuperar(m, c); } };
        const sessao = { run: async () => { throw new Error('sem Neo4j no teste'); }, close: async () => {} } as unknown as Session;
        const k = await recuperarConhecimento(adaptador, modelo, semItem.ctx, semItem.ctx.intencao!, async () => {}, () => sessao);
        const x = await fluxo(semItem, [SEM_CONFLITO], { conhecimento: k });

        assert.equal(x.ctx.status, 'UNRESOLVED');
        assert.deepEqual(caminho(x.ctx), ['RECEIVED', 'KNOWLEDGE_RETRIEVED', 'SEMANTIC_PROMPT_READY', 'UNRESOLVED'], 'nunca entra em PLANNING');
        assert.equal(x.planner.length, 0, 'o Planner nao foi chamado');
        assert.equal(x.pis.length, 0, 'nenhum PI Agent foi chamado');
        assert.deepEqual(x.verificados, [], 'nem /verify');
        assert.equal(x.fragmentos, 0, 'nem incremental nem monolitica');
        assert.equal(recuperacoes, 1, 'a recuperacao deterministica aconteceu, exatamente uma vez');
        assert.equal(x.ctx.auditoriaRecuperacao, k.auditoriaRecuperacao);

        // O motivo e o dado que falta dizem que o alvo nao foi determinado.
        const ultimo = x.ctx.errosValidacao[x.ctx.errosValidacao.length - 1];
        assert.equal(ultimo.veredito, 'UNRESOLVED');
        assert.deepEqual(ultimo.dadosFaltantes, ['alvo do pedido: nenhum item da politica efetiva citado pelo nome']);
        assert.deepEqual(avisos(ultimo), ['pedido_sem_alvo']);
        assert.match(x.ctx.historicoStatus[x.ctx.historicoStatus.length - 1].motivo!, /^o alvo do pedido nao e determinavel: /);
        assert.match(x.r.erro!, /terminou em UNRESOLVED — o alvo do pedido nao e determinavel/);
        assert.equal(x.r.resultado, '', 'sem artefato');

        // Um prompt recomendado util: o pedido, os itens trataveis com as condutas, e o que fazer.
        const prompt = ultimo.promptRecomendado!;
        assert.ok(prompt.startsWith('[ALVO DO PEDIDO NAO DETERMINAVEL]\npedido: a pressao esta caindo, o que faco?'), prompt);
        assert.match(prompt, /\n- Noradrenalina: Titular_Vasopressor, /);
        assert.match(prompt, /\n- Adrenalina: Iniciar_Vasopressor, /);
        assert.match(prompt, /Reformule o pedido citando o item a tratar\.$/);
        assert.ok(ultimo.avisos[0].alternativas!.includes('Noradrenalina') && ultimo.avisos[0].alternativas!.includes('Adrenalina'));

        // Historico e metricas: nada inventado.
        assert.deepEqual(x.ctx.historicoGlobal, [], 'nenhum CicloGlobal inexistente');
        assert.deepEqual([x.ctx.tentativasPlanner.length, x.ctx.execucoesPI.length, x.ctx.resultadosPI.length], [0, 0, 0]);
        assert.equal(x.ctx.validacaoGlobal, undefined);
        const m = x.ctx.metricasExecucao!;
        assert.deepEqual(
            [m.requestId, m.resultado, m.ciclos, m.planner.chamadas, m.planner.tokens, m.pi.pis, m.pi.chamadas, m.validacaoGlobal.execucoes],
            [x.ctx.requestId, 'UNRESOLVED', 0, 0, 0, 0, 0, 0]
        );
        assert.ok(m.duracaoTotalMs >= 0, 'a duracao real e medida');
        assert.deepEqual(incoerenciasDoContexto(x.ctx), []);
    });

    await teste('pedido com item citado — entra em PLANNING normalmente; com decisao ambigua, o comportamento e o de antes', async () => {
        const x = await fluxo(cb, [SEM_CONFLITO]);
        assert.deepEqual(caminho(x.ctx).slice(0, 5), ['RECEIVED', 'KNOWLEDGE_RETRIEVED', 'SEMANTIC_PROMPT_READY', 'PLANNING', 'SEQUENCE_VALIDATING']);
        assert.equal(x.planner.length, 1);
        assert.equal(x.ctx.status, 'COMPLETED');

        // Item citado, nenhuma decisao nomeada: nao e falta de alvo — o Planner e
        // chamado, e a validacao global so avisa que o pedido nao nomeia decisao.
        const ambiguo = cenario({ ...B, intencao: 'e a noradrenalina, o que faco?' });
        const y = await fluxo(ambiguo, [SEM_CONFLITO]);
        assert.ok(y.ctx.historicoStatus.some(t => t.para === 'PLANNING'));
        assert.equal(y.planner.length, 1);
        assert.equal(y.ctx.status, 'COMPLETED', y.r.erro ?? '');
        assert.ok(avisos(y.ctx.validacaoGlobal!).includes('pedido_indeterminado'));
    });

    await teste('orcamentos separados: o do Planner e o de cada PI sao por ciclo; retry de PI nao consome ciclo', async () => {
        const invalida = 'PLANO 1 | Adrenalina | Titular_Vasopressor | [ ] FIM';
        const pis: PedidoPIAgent[] = [];
        const x = await fluxo(cb, [invalida, CONFLITO, SEM_CONFLITO], {
            piAgent: piAgentRoteirizado({ 1: [p => saidaPI(p, { justificativa: 'Conforme solicitado pelo plantao' })] }, pis)
        });
        assert.equal(x.ctx.status, 'COMPLETED');
        assert.deepEqual(x.ctx.tentativasPlanner.map(t => [t.ciclo, t.validacao.veredito]), [[1, 'INVALID'], [1, 'VALID'], [2, 'VALID']]);
        assert.equal(x.ctx.historicoGlobal.length, 2);
        assert.deepEqual(x.ctx.historicoGlobal.map(c => c.execucoesPI[0].tentativas.length), [2, 1], 'o retry do PI 1 ficou no ciclo 1 e nao gastou ciclo');
    });

    await teste('recuperacao nao repetida: o reinicio reusa politica, regras e evidencias da unica recuperacao', async () => {
        let recuperacoes = 0;
        const adaptador = { ...ADAPTADOR_MED, recuperar: (m: Parameters<typeof ADAPTADOR_MED.recuperar>[0], c: ClinicalContext) => { recuperacoes++; return ADAPTADOR_MED.recuperar(m, c); } };
        const sessao = { run: async () => { throw new Error('sem Neo4j no teste'); }, close: async () => {} } as unknown as Session;
        const k = await recuperarConhecimento(adaptador, modelo, B, B.intencao!, async () => {}, () => sessao);
        assert.equal(recuperacoes, 1);
        const x = await fluxo(cb, [CONFLITO, SEM_CONFLITO], { conhecimento: k });
        assert.equal(x.ctx.status, 'COMPLETED');
        assert.equal(x.ctx.historicoGlobal.length, 2);
        assert.equal(recuperacoes, 1, 'nenhuma recuperacao a mais no ciclo 2');
        assert.equal(x.ctx.auditoriaRecuperacao, k.auditoriaRecuperacao);
        assert.equal(x.ctx.politicaEfetiva, k.politicaEfetiva);
        assert.equal(x.planner[0].prompt.includes(k.promptSemantico) && x.planner[1].prompt.includes(k.promptSemantico), true, 'o mesmo Prompt Semantico nos dois ciclos');
    });

    await teste('isolamento dos ciclos: o ciclo 2 nao toca resultados, artefato nem validacao do ciclo 1', async () => {
        const x = await fluxo(cb, [CONFLITO, SEM_CONFLITO]);
        const [c1, c2] = x.ctx.historicoGlobal;
        assert.deepEqual(c1.resultadosPI.map(r => r.acao.decisao), ['AUMENTAR_VAZAO', 'INICIAR_INFUSAO']);
        assert.deepEqual(c2.resultadosPI.map(r => r.acao.decisao), ['AUMENTAR_VAZAO', 'MANTER_BLOQUEADO']);
        assert.notEqual(c1.resultadosPI, c2.resultadosPI);
        assert.equal(x.ctx.resultadosPI, c2.resultadosPI);
        assert.match(c1.artefato!, /decisao INICIAR_INFUSAO/);
        assert.ok(!x.ctx.artefatoFinal!.includes('INICIAR_INFUSAO'));
        assert.equal(c1.validacaoGlobal!.veredito, 'INVALID');
        assert.deepEqual(codigos(c1.validacaoGlobal!), ['incompatibilidade_global']);
        assert.equal(c2.validacaoGlobal!.veredito, 'VALID');
        assert.deepEqual(c1.sequenciaValidada!.map(p => p.conduta), ['Titular_Vasopressor', 'Iniciar_Vasopressor']);
        assert.deepEqual(c2.sequenciaValidada!.map(p => p.conduta), ['Titular_Vasopressor', 'Manter_Bloqueio']);
        assert.ok(Object.isFrozen(c1.plano) && Object.isFrozen(c1.contextosPI![0]));
        const resumo = JSON.parse(JSON.stringify(resumoExecucao(x.ctx)));
        assert.deepEqual(resumo.historicoGlobal[0].resultadosPI, c1.resultadosPI, 'o historico atravessa JSON');
    });

    await teste('observabilidade — custo por ciclo e da execucao: Planner, PIs e validacao global', async () => {
        const x = await fluxo(cb, [CONFLITO, SEM_CONFLITO]);
        const m = x.ctx.metricasExecucao!;
        assert.deepEqual([m.requestId, m.ciclos, m.resultado], [x.ctx.requestId, 2, 'COMPLETED']);
        assert.deepEqual([m.planner.chamadas, m.planner.tokens], [2, 8000]);
        assert.deepEqual([m.pi.pis, m.pi.chamadas, m.pi.retries], [4, 4, 0]);
        assert.ok(m.pi.caracteresPrompt > 0 && m.planner.caracteresPrompt > m.pi.caracteresPrompt / 4);
        assert.deepEqual([m.validacaoGlobal.execucoes, m.validacaoGlobal.erros, m.validacaoGlobal.codigos], [2, 1, ['incompatibilidade_global']]);
        assert.ok(m.duracaoTotalMs >= 0);
        for (const c of x.ctx.historicoGlobal) {
            assert.equal(c.metricas.chamadasPlanner, 1);
            assert.equal(c.metricas.chamadasPI, 2);
            assert.ok(c.metricas.duracaoComposicaoMs! >= 0 && c.metricas.duracaoValidacaoGlobalMs! >= 0);
        }
    });

    await teste('artefato fora de L(Ĝ) segundo /verify: FAILED com o motivo, sem novo ciclo', async () => {
        const x = await fluxo(ref, [REF_2, REF_2], { verificador: async () => ({ valido: false, erro: "Unexpected token 'x'" }) });
        assert.equal(x.ctx.status, 'FAILED');
        assert.equal(x.planner.length, 1);
        assert.match(x.ctx.historicoStatus[x.ctx.historicoStatus.length - 1].motivo!, /nao pertence a L\(Ĝ\).*Unexpected token/);
        assert.deepEqual(x.ctx.historicoGlobal.map(c => c.desfecho), ['FAILED']);
    });

    await teste('PI UNRESOLVED: nao ha composicao nem artefato parcial', async () => {
        const pis: PedidoPIAgent[] = [];
        const x = await fluxo(ref, [REF_2], { piAgent: piAgentRoteirizado({ 1: ['a', 'b', 'c'] }, pis) });
        assert.equal(x.ctx.status, 'UNRESOLVED');
        assert.ok(!x.ctx.historicoStatus.some(t => t.para === 'COMPOSING'));
        assert.equal(x.ctx.planoComposto, undefined);
        assert.deepEqual(x.verificados, []);
    });

    await teste('pelo cliente HTTP real: /generate-planner, /generate-pi por PI e /verify — nada de /generate-fragment', async () => {
        const recebidas: string[] = [];
        let planos = 0;
        const servidor = http.createServer((req, res) => {
            recebidas.push(req.url ?? '');
            let corpo = '';
            req.on('data', parte => (corpo += parte));
            req.on('end', () => {
                const resposta = req.url === '/generate-planner'
                    ? { saida: planos++ === 0 ? CONFLITO : SEM_CONFLITO, tokens_prompt: 4000 }
                    : req.url === '/generate-pi' ? respostaQueObedece(JSON.parse(corpo) as PedidoPIAgent)
                        : req.url === '/verify' ? RESPOSTA_VERIFY : undefined;
                res.writeHead(resposta ? 200 : 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(resposta ?? { detail: `rota inesperada: ${req.url}` }));
            });
        });
        await new Promise<void>(resolve => servidor.listen(0, '127.0.0.1', resolve));
        process.env.SPC_CML_DECODIFICACAO = 'multiagente';
        for (const v of ['SPC_CML_MAX_CICLOS_GLOBAIS', 'SPC_CML_MAX_TENTATIVAS_PLANNER', 'SPC_CML_MAX_TENTATIVAS_PI']) delete process.env[v];
        try {
            const k = conhecimentoDe(cb, 'req-http-global');
            const r = (await decodificar({
                ...montarEntradaGeracao(B, cb.constraints, modelo, cb.poda, k),
                endpoint: `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`
            })) as ResultadoMultiagente;
            assert.equal(r.execucao.status, 'COMPLETED');
            assert.deepEqual(recebidas, [
                '/generate-planner', '/generate-pi', '/generate-pi', '/verify',
                '/generate-planner', '/generate-pi', '/generate-pi', '/verify'
            ]);
            assert.equal(r.resultado, r.execucao.artefatoFinal);
        } finally {
            restaurar();
            servidor.closeAllConnections();
            servidor.close();
        }
    });

    await teste('baseline: sem SPC_CML_DECODIFICACAO=multiagente, nada disto roda (incremental intacto)', async () => {
        let planner = 0;
        const verificados: string[] = [];
        let fragmentos = 0;
        delete process.env.SPC_CML_DECODIFICACAO;
        try {
            const r = await decodificar({
                ...montarEntradaGeracao(REF, ref.constraints, modelo, ref.poda, conhecimentoDe(ref, 'req-base')),
                endpoint: 'http://127.0.0.1:9',
                motor: async p => { fragmentos++; return p.encerramento ? { fragmento: '', encerrou: true } : { fragmento: 'Plano_Teste', encerrou: false }; },
                motorPlanner: async () => { planner++; return { saida: REF_2 }; },
                verificadorGramatical: verificadorQueAceita(verificados)
            });
            assert.ok('passos' in r, 'o resultado e o do incremental');
            assert.ok(fragmentos > 0);
            assert.equal(planner, 0);
            assert.deepEqual(verificados, []);
        } finally {
            restaurar();
        }
    });

    // Exemplo legivel.
    const exemplo = await fluxo(cb, [CONFLITO, SEM_CONFLITO]);
    console.log('\n  --- exemplo: reinicio global no cenario B ---');
    for (const c of exemplo.ctx.historicoGlobal) {
        console.log(`    ciclo ${c.ciclo}: ${c.sequenciaValidada!.map(p => `${p.item}/${p.conduta}`).join(' + ')} -> ${c.validacaoGlobal!.veredito} -> ${c.desfecho}`);
    }
    console.log('    feedback global enviado ao Planner do ciclo 2:');
    console.log(exemplo.ctx.historicoGlobal[0].realimentacao!.split('\n').map(l => `      ${l}`).join('\n'));
    console.log('    artefato final:');
    console.log(`      ${exemplo.ctx.artefatoFinal}`);
    console.log(`    custo: ${JSON.stringify(exemplo.ctx.metricasExecucao)}`);

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
