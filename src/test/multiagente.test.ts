/**
 * Contratos da arquitetura multiagente — a etapa de PREPARACAO.
 *
 * Nada aqui gera, planeja nem chama modelo. O que se verifica e que os
 * contratos que o orquestrador vai usar existem, sao coerentes e recusam o que
 * precisam recusar:
 *
 *   - o modo `multiagente` e reconhecido e fica ISOLADO: `decodificar` o recusa
 *     sem tocar no motor, e os modos existentes seguem como estavam;
 *   - `PIPlanejado` e o PAR (item, conduta) — acao e justificativa nao entram;
 *   - dependencias so apontam para tras, e a propria ordem e topologica;
 *   - `ResultadoPI` tem a forma da clausula e e julgado pelo mesmo
 *     `verificarClausulas` do contrato do artefato;
 *   - `ResultadoValidacao` distingue VALID, INVALID e UNRESOLVED;
 *   - a maquina de estados nao tem beco sem saida nem laco fora dos previstos;
 *   - o orcamento de tentativas e sempre finito;
 *   - o contexto da execucao e o `ContextoGeracaoItem` referenciam as
 *     estruturas que ja existem, sem copia-las.
 *
 * Roda OFFLINE: o modelo da DSL e a recuperacao deterministica sao reais; o
 * motor, quando aparece, e um duble — e o endpoint aponta para uma porta sem
 * servico, para que um desvio acidental falhe em vez de gerar.
 */

import assert from 'node:assert/strict';
import * as path from 'node:path';

import { loadModel } from '../database/neo4j.js';
import { isDataSchemaDef } from '../generated/ast.js';
import {
    condutasPorDecisaoMed,
    esquemaDeDadosMed,
    pruningPayload,
    retrieveConstraints,
    type ClinicalContext
} from '../knowledge/graphrag.js';
import { montarEntradaGeracao, montarPromptSemantico } from '../inference/llm-client.js';
import { decodificar, modoDecodificacao, type MotorFragmento, type ResultadoMultiagente } from '../inference/decodificacao.js';
import { montarContrato, relatorioDeViolacoes, verificarClausulas, type Violacao } from '../knowledge/contrato.js';
import {
    comoClausulaLida,
    validarPIPlanejado,
    validarResultadoPI,
    validarSequenciaPlanejada,
    type PIPlanejado,
    type ResultadoPI
} from '../knowledge/contrato-pi.js';
import {
    combinar,
    deViolacoes,
    incoerencias,
    invalido,
    naoResolvido,
    valido,
    type ResultadoValidacao
} from '../knowledge/validacao.js';
import {
    ORCAMENTO_PADRAO,
    STATUS_MULTIAGENTE,
    STATUS_TERMINAIS,
    TETO_TENTATIVAS,
    TRANSICOES_MULTIAGENTE,
    avancarStatus,
    incoerenciasDoContexto,
    limitarTentativas,
    novoContextoExecucao,
    orcamentoDeEnv,
    piorCasoDeChamadas,
    registrarConhecimento,
    statusTerminal,
    transicaoPermitida,
    type StatusMultiagente
} from '../inference/multiagente.js';
import { contextosPorItem, evidenciasDe } from '../knowledge/item-geracao.js';
import { auditoriaVazia } from '../knowledge/recuperacao-hibrida.js';
import type { RegraValidada } from '../knowledge/recuperacao-cypher.js';
import type { ConhecimentoRecuperado } from '../inference/recuperacao-conhecimento.js';
import type { RetrievedConstraints } from '../knowledge/graphrag.js';
import type { PedidoPIAgent } from '../inference/pi-agent.js';
import type { MotorPlanner } from '../inference/planner.js';
import { piAgentQueObedece, verificadorQueAceita } from './dubles-pi-agent.js';

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

/** Porta sem servico: se algo escapar do duble, falha em vez de gerar. */
const SEM_MOTOR = 'http://127.0.0.1:9';

const codigos = (r: ResultadoValidacao): string[] => r.erros.map(e => e.codigo);

/** Cenario de referencia do projeto: choque, renal cronico, tres farmacos em curso. */
const CENARIO: ClinicalContext = {
    paciente: 'PT-TESTE-0001',
    intencao: 'A pressao ta despencando (PAM=52), sobe a nora e aprofunda o propofol',
    telemetria: { PAM: 52, FC: 145, lactato: 4.8, RASS: 2, TFG: 28, plaquetas: 45, glicemia: 210 },
    populacoes: ['Renal_Cronico'],
    farmacosEmUso: ['Noradrenalina', 'Propofol', 'Vancomicina']
};

function regraValidada(item: string, campo: string, observado: number, limite: number): RegraValidada {
    return {
        regraId: `Farmaco:${item}/RegraSeguranca/${campo}<${limite}`,
        tipo: 'RegraSeguranca',
        relacao: 'BLOQUEIA_INCREMENTO',
        item,
        dominio: 'med',
        aplicavel: observado < limite,
        condicoesSatisfeitas: observado < limite
            ? [{ campo, observado, esperado: `< ${limite}`, operador: '<', limite, satisfeita: true }]
            : [],
        condicoesFalhas: observado < limite
            ? []
            : [{ campo, observado, esperado: `< ${limite}`, operador: '<', limite, satisfeita: false }],
        lacunas: [],
        evidencia: { [campo]: observado },
        validacaoCypher: { valida: observado < limite, motivo: 'duble', consulta: '' },
        efeito: { razao: 'duble do teste' },
        rag: { candidatoId: `Farmaco:${item}`, escore: 0.9, cosseno: 0.8, papel: 'item', posicao: 0 }
    };
}

async function main(): Promise<void> {
    const modelo = await loadModel(path.join('src', 'examples', 'med', 'uti.dsl'));
    const universo = [...modelo.elements.filter(isDataSchemaDef)[0].decisions];

    // =========================================================================
    console.log('\nModo de decodificacao');
    // =========================================================================

    await teste('SPC_CML_DECODIFICACAO: multiagente e reconhecido; desconhecido continua caindo no incremental', () => {
        assert.equal(modoDecodificacao(undefined), 'incremental');
        assert.equal(modoDecodificacao(''), 'incremental');
        assert.equal(modoDecodificacao('incremental'), 'incremental');
        assert.equal(modoDecodificacao('monolitica'), 'monolitica');
        assert.equal(modoDecodificacao('multiagente'), 'multiagente');
        // Mesma regra de antes: so o valor exato desvia.
        assert.equal(modoDecodificacao('MULTIAGENTE'), 'incremental');
        assert.equal(modoDecodificacao('qualquer'), 'incremental');
    });

    const constraints = retrieveConstraints(modelo, CENARIO);
    const entrada = montarEntradaGeracao(CENARIO, constraints, modelo);
    const original = process.env.SPC_CML_DECODIFICACAO;
    const restaurar = (): void => {
        if (original === undefined) delete process.env.SPC_CML_DECODIFICACAO;
        else process.env.SPC_CML_DECODIFICACAO = original;
    };

    await teste('multiagente sem a recuperacao da requisicao (CLI, lote) e recusado com erro explicito, sem chamar o motor', async () => {
        let chamadas = 0;
        const motor: MotorFragmento = async () => {
            chamadas++;
            return { fragmento: '', encerrou: true };
        };
        process.env.SPC_CML_DECODIFICACAO = 'multiagente';
        try {
            await assert.rejects(
                decodificar({ ...entrada, endpoint: SEM_MOTOR, motor }),
                /multiagente precisa da recuperacao da requisicao/
            );
        } finally {
            restaurar();
        }
        assert.equal(chamadas, 0, 'o modo multiagente nao pode cair em outro caminho');
    });

    await teste('sem a variavel, decodificar continua sendo o incremental (o motor injetado e chamado)', async () => {
        // Pre-condicao: com contexto e politica, o incremental nao cai no monolitico.
        assert.ok(entrada.contrato.contextos.length > 0, 'o cenario precisa ativar um protocolo');
        assert.ok(entrada.contrato.politicas.size > 0);
        const simbolos: string[] = [];
        const motor: MotorFragmento = async pedido => {
            simbolos.push(pedido.simbolo);
            return pedido.encerramento
                ? { fragmento: '', encerrou: true }
                : { fragmento: 'Plano_Teste', encerrou: false };
        };
        delete process.env.SPC_CML_DECODIFICACAO;
        try {
            const r = await decodificar({ ...entrada, endpoint: SEM_MOTOR, motor });
            assert.equal(simbolos[0], 'identificador', 'o incremental comeca pelo identificador');
            assert.ok('passos' in r, 'o resultado e o do incremental');
        } finally {
            restaurar();
        }
    });

    // =========================================================================
    console.log('\nPIPlanejado');
    // =========================================================================

    await teste('PI planejado valido: o par (item, conduta), a ordem e as dependencias', () => {
        const r = validarPIPlanejado({ ordem: 1, item: 'Carga_Imprudente', conduta: 'Marcar_Tiro_Livre_Direto', dependeDe: [] });
        assert.equal(r.veredito, 'VALID');
        assert.deepEqual(r.valor, { ordem: 1, item: 'Carga_Imprudente', conduta: 'Marcar_Tiro_Livre_Direto', dependeDe: [] });
        assert.deepEqual(incoerencias(r), []);
    });

    await teste('motivo e opcional; item e conduta saem aparados', () => {
        const r = validarPIPlanejado({ ordem: 2, item: ' Propofol ', conduta: ' Manter_Bloqueio', dependeDe: [1], motivo: 'PAM 52 bloqueia o incremento' });
        assert.equal(r.veredito, 'VALID');
        assert.equal(r.valor!.item, 'Propofol');
        assert.equal(r.valor!.conduta, 'Manter_Bloqueio');
        assert.equal(r.valor!.motivo, 'PAM 52 bloqueia o incremento');
    });

    await teste('PI planejado sem item e reprovado', () => {
        for (const item of [undefined, '', '   ', 7]) {
            const r = validarPIPlanejado({ ordem: 1, item, conduta: 'Manter_Bloqueio', dependeDe: [] });
            assert.equal(r.veredito, 'INVALID', `item ${JSON.stringify(item)}`);
            assert.deepEqual(codigos(r), ['item_ausente']);
            assert.equal(r.erros[0].pi, 1, 'o erro aponta o PI pela ordem');
        }
    });

    await teste('PI planejado sem conduta e reprovado', () => {
        for (const conduta of [undefined, '', null]) {
            const r = validarPIPlanejado({ ordem: 1, item: 'Propofol', conduta, dependeDe: [] });
            assert.equal(r.veredito, 'INVALID');
            assert.deepEqual(codigos(r), ['conduta_ausente']);
        }
    });

    await teste('ordem precisa ser inteiro >= 1; dependeDe precisa ser lista de ordens', () => {
        for (const ordem of [0, -1, 1.5, '1', undefined]) {
            assert.deepEqual(codigos(validarPIPlanejado({ ordem, item: 'X', conduta: 'Y', dependeDe: [] })), ['ordem_invalida']);
        }
        for (const dependeDe of [undefined, 1, [0], ['1'], [1.5]]) {
            assert.deepEqual(codigos(validarPIPlanejado({ ordem: 2, item: 'X', conduta: 'Y', dependeDe })), ['dependencias_invalidas']);
        }
    });

    await teste('acao e justificativa sao do PI Agent: o Planner que as devolve e reprovado', () => {
        for (const campo of ['acao', 'justificativa', 'decisao', 'meio', 'valor']) {
            const r = validarPIPlanejado({ ordem: 1, item: 'Propofol', conduta: 'Manter_Bloqueio', dependeDe: [], [campo]: 'x' });
            assert.deepEqual(codigos(r), ['campo_nao_permitido'], campo);
            assert.match(r.erros[0].mensagem, /PI Agent/);
        }
        // E o tipo tambem nao aceita:
        const pi: PIPlanejado = {
            ordem: 1, item: 'Propofol', conduta: 'Manter_Bloqueio', dependeDe: [],
            // @ts-expect-error — acao nao pertence ao PI planejado
            acao: { decisao: 'SUSPENDER' }
        };
        assert.ok(pi);
    });

    await teste('regras: recusadas vindas do Planner, aceitas depois da associacao', () => {
        const bruto = { ordem: 1, item: 'Propofol', conduta: 'Manter_Bloqueio', dependeDe: [], regras: [] };
        assert.deepEqual(codigos(validarPIPlanejado(bruto)), ['campo_nao_permitido']);
        assert.equal(validarPIPlanejado(bruto, { origem: 'associado' }).veredito, 'VALID');
        assert.deepEqual(codigos(validarPIPlanejado({ ...bruto, regras: 'x' }, { origem: 'associado' })), ['regras_invalidas']);
    });

    await teste('campo desconhecido e objeto invalido sao reprovados', () => {
        assert.deepEqual(codigos(validarPIPlanejado({ ordem: 1, item: 'X', conduta: 'Y', dependeDe: [], prioridade: 1 })), ['campo_nao_permitido']);
        for (const bruto of [null, [], 'PI', 3]) {
            assert.deepEqual(codigos(validarPIPlanejado(bruto)), ['pi_nao_e_objeto']);
        }
    });

    await teste('a forma nao julga vocabulario: `conduta: "marcacao"` passa aqui e fica para a validacao no grafo', () => {
        // `marcacao` e o literal da clausula (PapeisDominio.clausula), nao uma
        // conduta do esquema_dados. Recusa-lo e trabalho de quem conhece o
        // dominio — a validacao da sequencia contra o conhecimento.
        assert.equal(validarPIPlanejado({ ordem: 1, item: 'Carga_Imprudente', conduta: 'marcacao', dependeDe: [] }).veredito, 'VALID');
    });

    // =========================================================================
    console.log('\nSequencia e dependencias');
    // =========================================================================

    const pi = (ordem: number, dependeDe: number[] = [], item = `Item_${ordem}`): Record<string, unknown> =>
        ({ ordem, item, conduta: `Conduta_${ordem}`, dependeDe });

    await teste('dependencia valida: so para tras; o valor sai ordenado pela ordem', () => {
        const r = validarSequenciaPlanejada([pi(3, [1, 2]), pi(1), pi(2, [1])]);
        assert.equal(r.veredito, 'VALID');
        assert.deepEqual(r.valor!.map(p => p.ordem), [1, 2, 3]);
        assert.deepEqual(r.valor![2].dependeDe, [1, 2]);
    });

    await teste('dependencia invalida: inexistente, propria e posterior', () => {
        assert.deepEqual(codigos(validarSequenciaPlanejada([pi(1), pi(2, [5])])), ['dependencia_inexistente']);
        assert.deepEqual(codigos(validarSequenciaPlanejada([pi(1, [1])])), ['dependencia_propria']);
        const posterior = validarSequenciaPlanejada([pi(1, [2]), pi(2)]);
        assert.deepEqual(codigos(posterior), ['dependencia_posterior']);
        assert.equal(posterior.erros[0].pi, 1);
        assert.equal(posterior.erros[0].item, 'Item_1');
    });

    await teste('ciclo e impossivel: toda aresta de volta e uma dependencia posterior', () => {
        const r = validarSequenciaPlanejada([pi(1, [2]), pi(2, [1])]);
        assert.equal(r.veredito, 'INVALID');
        assert.deepEqual(codigos(r), ['dependencia_posterior']);
    });

    await teste('dependencia repetida e aviso, nao erro, e sai sem a repeticao', () => {
        const r = validarSequenciaPlanejada([pi(1), pi(2, [1, 1])]);
        assert.equal(r.veredito, 'VALID');
        assert.deepEqual(r.avisos.map(a => a.codigo), ['dependencia_repetida']);
        assert.deepEqual(r.valor![1].dependeDe, [1]);
    });

    await teste('ordens: 1..n, sem repeticao e sem lacuna', () => {
        assert.deepEqual(codigos(validarSequenciaPlanejada([pi(1), pi(1)])), ['ordem_repetida']);
        assert.deepEqual(codigos(validarSequenciaPlanejada([pi(1), pi(3)])), ['ordem_fora_de_sequencia']);
        assert.deepEqual(codigos(validarSequenciaPlanejada([pi(2)])), ['ordem_fora_de_sequencia']);
    });

    await teste('sequencia vazia, nao-lista e PI malformado dentro dela', () => {
        assert.deepEqual(codigos(validarSequenciaPlanejada([])), ['sequencia_vazia']);
        assert.deepEqual(codigos(validarSequenciaPlanejada({ ordem: 1 })), ['sequencia_nao_e_lista']);
        const r = validarSequenciaPlanejada([pi(1), { ordem: 2, item: 'X', dependeDe: [] }]);
        assert.deepEqual(codigos(r), ['conduta_ausente']);
        assert.equal(r.erros[0].pi, 2);
    });

    // =========================================================================
    console.log('\nResultadoPI');
    // =========================================================================

    const resultado = (sobre: Record<string, unknown> = {}): Record<string, unknown> => ({
        ordem: 1,
        item: 'Noradrenalina',
        conduta: 'Titular_Vasopressor',
        acao: { decisao: 'AUMENTAR_VAZAO', meio: 'ACESSO_CENTRAL', valor: { valor: '0.05', unidade: 'mcg/kg/min' } },
        justificativa: 'PAM 52 abaixo do alvo de 65',
        ...sobre
    });
    const piNora: PIPlanejado = { ordem: 1, item: 'Noradrenalina', conduta: 'Titular_Vasopressor', dependeDe: [] };

    await teste('resultado de PI valido: acao (decisao, meio, valor) e justificativa', () => {
        const r = validarResultadoPI(resultado(), piNora);
        assert.equal(r.veredito, 'VALID');
        assert.deepEqual(r.valor, resultado());
    });

    await teste('resultado de PI sem acao, decisao, meio ou valor bem formado e reprovado', () => {
        assert.deepEqual(codigos(validarResultadoPI(resultado({ acao: undefined }))), ['acao_ausente']);
        const acao = (a: Record<string, unknown>): Record<string, unknown> =>
            resultado({ acao: { decisao: 'AUMENTAR_VAZAO', meio: 'ACESSO_CENTRAL', valor: { valor: '0.05', unidade: 'mcg/kg/min' }, ...a } });
        assert.deepEqual(codigos(validarResultadoPI(acao({ decisao: '' }))), ['decisao_ausente']);
        assert.deepEqual(codigos(validarResultadoPI(acao({ meio: undefined }))), ['meio_ausente']);
        for (const valor of [0.05, '0.05', { valor: 0.05, unidade: 'x' }, { valor: 'abc', unidade: 'x' }, { valor: '0.05' }]) {
            assert.deepEqual(codigos(validarResultadoPI(acao({ valor }))), ['valor_invalido'], JSON.stringify(valor));
        }
        assert.deepEqual(codigos(validarResultadoPI(acao({ extra: 1 }))), ['campo_nao_permitido']);
    });

    await teste('justificativa e obrigatoria e nao pode fechar o literal da gramatica', () => {
        assert.deepEqual(codigos(validarResultadoPI(resultado({ justificativa: '  ' }))), ['justificativa_ausente']);
        assert.deepEqual(codigos(validarResultadoPI(resultado({ justificativa: "PAM d'agua" }))), ['justificativa_invalida']);
    });

    await teste('o resultado tem de responder o PI pedido: o PI Agent nao troca o par', () => {
        const r = validarResultadoPI(resultado({ item: 'Vasopressina' }), piNora);
        assert.deepEqual(codigos(r), ['pi_divergente']);
        assert.equal(r.erros[0].pi, 1);
        assert.deepEqual(codigos(validarResultadoPI(resultado({ dependeDe: [] }))), ['campo_nao_permitido']);
    });

    await teste('ResultadoPI e julgado pelo MESMO verificarClausulas do contrato do artefato', () => {
        const poda = pruningPayload(constraints, CENARIO);
        const contrato = montarContrato(poda, condutasPorDecisaoMed(modelo), [], esquemaDeDadosMed(modelo));
        const p = poda.politicas.find(x => x.meios.length > 0 && x.decisoes.length > 0)!;
        const decisao = p.decisoes[0];
        const valores = p.valoresPorDecisao?.[decisao] ?? p.valores;
        const admissivel: ResultadoPI = {
            ordem: 1, item: p.item, conduta: contrato.condutaPorDecisao[decisao] ?? 'qualquer',
            acao: { decisao, meio: p.meios[0], valor: valores[0] ?? { valor: '1.0', unidade: p.unidades[0] ?? 'u' } },
            justificativa: 'duble'
        };
        assert.equal(validarResultadoPI(admissivel).veredito, 'VALID');
        assert.deepEqual(verificarClausulas(contrato, [comoClausulaLida(admissivel)]), []);

        const fora = universo.find(d => !p.decisoes.includes(d))!;
        const inadmissivel = { ...admissivel, acao: { ...admissivel.acao, decisao: fora } };
        assert.deepEqual(verificarClausulas(contrato, [comoClausulaLida(inadmissivel)]).map(v => v.tipo), ['decisao_inadmissivel']);
    });

    // =========================================================================
    console.log('\nResultadoValidacao');
    // =========================================================================

    await teste('validacao VALID: sem erro, sem dado faltante, com o valor', () => {
        const r = valido({ x: 1 });
        assert.equal(r.veredito, 'VALID');
        assert.deepEqual(r.valor, { x: 1 });
        assert.deepEqual(incoerencias(r), []);
    });

    await teste('validacao INVALID: exige erro, com codigo, mensagem, PI e prompt recomendado', () => {
        const r = invalido([{ codigo: 'item_ausente', mensagem: 'sem item', pi: 2, item: 'X' }], { promptRecomendado: 'refaca o PI 2' });
        assert.equal(r.veredito, 'INVALID');
        assert.equal(r.erros[0].pi, 2);
        assert.equal(r.promptRecomendado, 'refaca o PI 2');
        assert.deepEqual(incoerencias(r), []);
        assert.throws(() => invalido([]), /pelo menos um erro/);
    });

    await teste('validacao UNRESOLVED: exige o dado faltante e nao e aprovacao nem reprovacao', () => {
        const r = naoResolvido(['telemetria.PAM'], { avisos: [{ codigo: 'sem_medida', mensagem: 'PAM nao medida' }] });
        assert.equal(r.veredito, 'UNRESOLVED');
        assert.deepEqual(r.dadosFaltantes, ['telemetria.PAM']);
        assert.deepEqual(r.erros, []);
        assert.equal(r.valor, undefined);
        assert.deepEqual(incoerencias(r), []);
        assert.throws(() => naoResolvido([]), /dado faltante/);
    });

    await teste('incoerencias acusa resultado montado a mao fora das regras', () => {
        const base = { erros: [], avisos: [], dadosFaltantes: [] };
        assert.deepEqual(incoerencias({ ...base, veredito: 'INVALID' }), ['INVALID sem erro']);
        assert.deepEqual(incoerencias({ ...base, veredito: 'UNRESOLVED' }), ['UNRESOLVED sem dado faltante']);
        assert.deepEqual(incoerencias({ ...base, veredito: 'VALID', dadosFaltantes: ['x'] }), ['VALID com dado faltante']);
        assert.deepEqual(incoerencias({ ...base, veredito: 'INVALID', erros: [{ codigo: 'c', mensagem: 'm' }], valor: 1 }), ['INVALID com valor']);
    });

    await teste('combinar: INVALID vence UNRESOLVED, que vence VALID; avisos e prompts se somam', () => {
        const v = valido(1, [{ codigo: 'a', mensagem: 'aviso' }]);
        const u = naoResolvido(['PAM'], { promptRecomendado: 'meca a PAM' });
        const i = invalido([{ codigo: 'e', mensagem: 'erro' }], { promptRecomendado: 'refaca' });
        assert.equal(combinar([v, v]).veredito, 'VALID');
        assert.equal(combinar([v, u]).veredito, 'UNRESOLVED');
        const todos = combinar([v, u, i]);
        assert.equal(todos.veredito, 'INVALID');
        assert.deepEqual(todos.avisos.map(a => a.codigo), ['a']);
        assert.equal(todos.promptRecomendado, 'meca a PAM\n\nrefaca');
        assert.deepEqual(incoerencias(todos), []);
    });

    await teste('deViolacoes converte o contrato do artefato sem perda e reaproveita o relatorio', () => {
        assert.equal(deViolacoes([]).veredito, 'VALID');
        const violacoes: Violacao[] = [{
            clausula: 0, tipo: 'decisao_inadmissivel', mensagem: 'AUMENTAR_VAZAO nao e admissivel para Propofol',
            reparo: { item: 'Propofol', decisao: 'AUMENTAR_VAZAO' }
        }];
        const r = deViolacoes(violacoes, 3);
        assert.equal(r.veredito, 'INVALID');
        assert.deepEqual(r.erros[0], {
            codigo: 'decisao_inadmissivel', mensagem: violacoes[0].mensagem, pi: 3, item: 'Propofol',
            reparo: { item: 'Propofol', decisao: 'AUMENTAR_VAZAO' }
        });
        assert.equal(r.promptRecomendado, relatorioDeViolacoes(violacoes));
    });

    // =========================================================================
    console.log('\nEstados');
    // =========================================================================

    await teste('estados validos: os catorze da especificacao mais PI_DECOMPOSED e PI_ALL_VALID, e so eles', () => {
        assert.deepEqual([...STATUS_MULTIAGENTE], [
            'RECEIVED', 'KNOWLEDGE_RETRIEVED', 'SEMANTIC_PROMPT_READY', 'PLANNING', 'SEQUENCE_VALIDATING',
            'SEQUENCE_VALID', 'PI_DECOMPOSING', 'PI_DECOMPOSED', 'PI_EXECUTING', 'PI_VALIDATING', 'PI_ALL_VALID', 'COMPOSING',
            'GLOBAL_VALIDATING', 'COMPLETED', 'UNRESOLVED', 'FAILED'
        ]);
        assert.deepEqual(Object.keys(TRANSICOES_MULTIAGENTE).sort(), [...STATUS_MULTIAGENTE].sort());
        for (const destinos of Object.values(TRANSICOES_MULTIAGENTE)) {
            for (const d of destinos) assert.ok(STATUS_MULTIAGENTE.includes(d), `destino desconhecido ${d}`);
        }
    });

    await teste('terminais nao tem saida; todo nao terminal pode falhar', () => {
        assert.deepEqual([...STATUS_TERMINAIS], ['COMPLETED', 'UNRESOLVED', 'FAILED']);
        for (const s of STATUS_MULTIAGENTE) {
            if (statusTerminal(s)) assert.deepEqual(TRANSICOES_MULTIAGENTE[s], [], s);
            else assert.ok(transicaoPermitida(s, 'FAILED'), `${s} precisa poder falhar`);
        }
    });

    await teste('o caminho feliz e permitido de ponta a ponta, e todo estado e alcancavel', () => {
        const feliz: StatusMultiagente[] = [
            'RECEIVED', 'KNOWLEDGE_RETRIEVED', 'SEMANTIC_PROMPT_READY', 'PLANNING', 'SEQUENCE_VALIDATING',
            'SEQUENCE_VALID', 'PI_DECOMPOSING', 'PI_DECOMPOSED', 'PI_EXECUTING', 'PI_VALIDATING', 'PI_ALL_VALID', 'COMPOSING',
            'GLOBAL_VALIDATING', 'COMPLETED'
        ];
        for (let i = 1; i < feliz.length; i++) assert.ok(transicaoPermitida(feliz[i - 1], feliz[i]), `${feliz[i - 1]} -> ${feliz[i]}`);
        assert.ok(!transicaoPermitida('PI_DECOMPOSING', 'PI_EXECUTING'), 'a execucao cognitiva so comeca depois de PI_DECOMPOSED');
        assert.ok(!transicaoPermitida('PI_VALIDATING', 'COMPOSING'), 'a composicao so comeca com todos os PIs validos (PI_ALL_VALID)');

        const alcancados = new Set<StatusMultiagente>(['RECEIVED']);
        const fila: StatusMultiagente[] = ['RECEIVED'];
        while (fila.length > 0) {
            for (const d of TRANSICOES_MULTIAGENTE[fila.shift()!]) {
                if (!alcancados.has(d)) { alcancados.add(d); fila.push(d); }
            }
        }
        assert.deepEqual([...alcancados].sort(), [...STATUS_MULTIAGENTE].sort());
    });

    await teste('todo laco volta pelo Planner, exceto a nova tentativa de um PI', () => {
        const posicao = (s: StatusMultiagente): number => STATUS_MULTIAGENTE.indexOf(s);
        const voltas: string[] = [];
        for (const de of STATUS_MULTIAGENTE) {
            for (const para of TRANSICOES_MULTIAGENTE[de]) {
                if (posicao(para) <= posicao(de)) voltas.push(`${de}->${para}`);
            }
        }
        assert.deepEqual(voltas.sort(), [
            'GLOBAL_VALIDATING->PLANNING', 'PI_VALIDATING->PI_EXECUTING', 'PI_VALIDATING->PLANNING', 'SEQUENCE_VALIDATING->PLANNING'
        ]);
    });

    await teste('avancarStatus registra a transicao e recusa a nao permitida sem mudar nada', () => {
        const ctx = novoContextoExecucao({ dominio: 'med', pedido: 'p', contexto: CENARIO, orcamento: ORCAMENTO_PADRAO });
        avancarStatus(ctx, 'FAILED', 'motor fora do ar');
        assert.equal(ctx.status, 'FAILED');
        assert.deepEqual(ctx.historicoStatus, [{ de: 'RECEIVED', para: 'FAILED', motivo: 'motor fora do ar' }]);
        assert.throws(() => avancarStatus(ctx, 'PLANNING'), /FAILED -> PLANNING/);
        assert.equal(ctx.status, 'FAILED');
        assert.equal(ctx.historicoStatus.length, 1);

        const outro = novoContextoExecucao({ dominio: 'med', pedido: 'p', contexto: CENARIO, orcamento: ORCAMENTO_PADRAO });
        assert.throws(() => avancarStatus(outro, 'PLANNING'), /RECEIVED -> PLANNING/);
    });

    // =========================================================================
    console.log('\nOrcamento de tentativas');
    // =========================================================================

    await teste('sem ambiente, o orcamento padrao', () => {
        assert.deepEqual(orcamentoDeEnv({}), { planner: 3, porPI: 3, ciclosGlobais: 2 });
    });

    await teste('o ambiente e lido e limitado a [1, TETO]: nunca zero, nunca sem fim', () => {
        const ler = (v: string): number => orcamentoDeEnv({ SPC_CML_MAX_TENTATIVAS_PLANNER: v }).planner;
        assert.equal(ler('5'), 5);
        assert.equal(ler('2.9'), 2);
        assert.equal(ler('0'), 1);
        assert.equal(ler('-3'), 1);
        assert.equal(ler('1000'), TETO_TENTATIVAS);
        assert.equal(ler('abc'), ORCAMENTO_PADRAO.planner);
        // Vazio segue a convencao de `numeroDeEnv` (Number('') === 0) e vira 1.
        assert.equal(ler(''), 1);
        assert.deepEqual(
            orcamentoDeEnv({ SPC_CML_MAX_TENTATIVAS_PI: '4', SPC_CML_MAX_CICLOS_GLOBAIS: '1' }),
            { planner: 3, porPI: 4, ciclosGlobais: 1 }
        );
        assert.equal(limitarTentativas(Number.POSITIVE_INFINITY, 3), 3);
        assert.equal(limitarTentativas(Number.NaN, 3), 3);
    });

    await teste('o pior caso de chamadas e finito e cresce so linearmente com os PIs', () => {
        assert.equal(piorCasoDeChamadas(ORCAMENTO_PADRAO, 4), 2 * (3 + 4 * 3));
        const teto = { planner: TETO_TENTATIVAS, porPI: TETO_TENTATIVAS, ciclosGlobais: TETO_TENTATIVAS };
        assert.equal(piorCasoDeChamadas(teto, 5), TETO_TENTATIVAS * (TETO_TENTATIVAS + 5 * TETO_TENTATIVAS));
        assert.equal(piorCasoDeChamadas(ORCAMENTO_PADRAO, -1), 2 * 3);
    });

    // =========================================================================
    console.log('\nContexto da execucao');
    // =========================================================================

    const constraintsDoFoco: RetrievedConstraints = constraints;
    const poda = pruningPayload(constraintsDoFoco, CENARIO);
    const conhecimentoPara = (id: string): ConhecimentoRecuperado<RetrievedConstraints> => {
        const auditoria = auditoriaVazia('hibrida_rag_cypher', 'med', CENARIO.intencao!, id);
        auditoria.validacao = [regraValidada('Propofol', 'PAM', 52, 60)];
        return {
            constraints: constraintsDoFoco, foco: null, auditoriaRecuperacao: auditoria, poda,
            politicaEfetiva: poda, promptSemantico: montarPromptSemantico(constraintsDoFoco, CENARIO, poda)
        };
    };

    await teste('um contexto novo nasce RECEIVED, com id no formato da auditoria e sem nada planejado', () => {
        const ctx = novoContextoExecucao({ dominio: 'med', pedido: CENARIO.intencao!, contexto: CENARIO, orcamento: ORCAMENTO_PADRAO });
        assert.equal(ctx.status, 'RECEIVED');
        assert.match(ctx.requestId, /^rec-/);
        assert.equal(ctx.tentativaGlobal, 1);
        assert.deepEqual([ctx.tentativasPlanner, ctx.resultadosPI, ctx.errosValidacao, ctx.regras], [[], [], [], []]);
        assert.equal(ctx.contexto, CENARIO, 'o cenario e referenciado, nao copiado');
        assert.deepEqual(incoerenciasDoContexto(ctx), []);
    });

    await teste('registrarConhecimento leva a SEMANTIC_PROMPT_READY referenciando a recuperacao', () => {
        const ctx = novoContextoExecucao<ClinicalContext, RetrievedConstraints>({
            dominio: 'med', pedido: CENARIO.intencao!, contexto: CENARIO, requestId: 'req-1', orcamento: ORCAMENTO_PADRAO
        });
        const c = conhecimentoPara('req-1');
        registrarConhecimento(ctx, c);
        assert.equal(ctx.status, 'SEMANTIC_PROMPT_READY');
        assert.deepEqual(ctx.historicoStatus.map(t => t.para), ['KNOWLEDGE_RETRIEVED', 'SEMANTIC_PROMPT_READY']);
        assert.equal(ctx.politicaEfetiva, c.politicaEfetiva);
        assert.equal(ctx.regras, c.auditoriaRecuperacao.validacao, 'regras e o mesmo array da auditoria');
        assert.deepEqual(ctx.evidencias, evidenciasDe(ctx.regras));
        assert.equal(ctx.promptSemantico, c.promptSemantico);
        assert.deepEqual(incoerenciasDoContexto(ctx), []);
        assert.throws(() => registrarConhecimento(ctx, c), /SEMANTIC_PROMPT_READY -> KNOWLEDGE_RETRIEVED/);
    });

    await teste('recuperacao de outra requisicao e recusada sem mudar o status', () => {
        const ctx = novoContextoExecucao({ dominio: 'med', pedido: 'p', contexto: CENARIO, requestId: 'req-1', orcamento: ORCAMENTO_PADRAO });
        assert.throws(() => registrarConhecimento(ctx, conhecimentoPara('req-2')), /req-2 nao pertence a execucao req-1/);
        assert.equal(ctx.status, 'RECEIVED');
    });

    await teste('incoerenciasDoContexto acusa fase sem o que ela exige e orcamento estourado', () => {
        const ctx = novoContextoExecucao({ dominio: 'med', pedido: 'p', contexto: CENARIO, requestId: 'req-1', orcamento: ORCAMENTO_PADRAO });
        registrarConhecimento(ctx, conhecimentoPara('req-1'));
        ctx.status = 'SEQUENCE_VALID';
        assert.deepEqual(incoerenciasDoContexto(ctx), ['SEQUENCE_VALID sem sequencia validada']);

        ctx.sequenciaValidada = [piNora];
        ctx.resultadosPI = [validarResultadoPI(resultado({ item: 'Vasopressina' })).valor!];
        assert.deepEqual(incoerenciasDoContexto(ctx), [
            'resultado do PI 1 responde (Vasopressina, Titular_Vasopressor), mas o PI e (Noradrenalina, Titular_Vasopressor)'
        ]);

        ctx.resultadosPI = [];
        ctx.tentativaGlobal = 3;
        const falha = invalido<PIPlanejado[]>([{ codigo: 'x', mensagem: 'x' }]);
        ctx.tentativasPlanner = [1, 2, 3, 4].map(tentativa => ({ ciclo: 1, tentativa, proposta: [], validacao: falha }));
        assert.deepEqual(incoerenciasDoContexto(ctx), [
            'tentativaGlobal 3 passou do orcamento de 2 ciclo(s)',
            'ciclo 1: 4 propostas do Planner, orcamento de 3'
        ]);
    });

    // =========================================================================
    console.log('\nContextoGeracaoItem');
    // =========================================================================

    await teste('contextosPorItem: um por item, com a politica referenciada e as vistas coerentes com ela', () => {
        assert.ok(constraints.interacoes.length > 0, 'o cenario precisa ter interacao entre farmacos em uso');
        const validadas = [regraValidada('Propofol', 'PAM', 52, 60), regraValidada('Noradrenalina', 'FC', 145, 100)];
        const contextos = contextosPorItem(poda, {
            validadas, dominio: 'med', pedido: CENARIO.intencao, relacionais: constraints.interacoes, decisoesDoDominio: universo
        });

        assert.equal(contextos.length, poda.politicas.length);
        for (const [i, c] of contextos.entries()) {
            assert.equal(c.item, poda.politicas[i], 'a politica e o mesmo objeto da poda');
            assert.equal(c.metadata.ordemOriginal, i);
            assert.deepEqual(c.subgrafoDoItem.politicas, [c.item]);
            assert.equal(c.subgrafoDoItem.papeis, poda.papeis);
            assert.equal(c.pedido, CENARIO.intencao);
            assert.equal(c.decisoes.admissiveis, c.item.decisoes);
            assert.deepEqual([...c.decisoes.admissiveis, ...c.decisoes.bloqueadas].sort(), [...new Set([...c.item.decisoes, ...universo])].sort());
            assert.ok(c.decisoes.bloqueadas.every(d => !c.item.decisoes.includes(d)));
            assert.equal(c.valores.gerais, c.item.valores);
            assert.equal(c.restricoes, c.item.motivos);
            assert.ok(c.regras.every(r => r.item === c.item.item));
            assert.ok(c.regrasRelacionais.every(r => r.entre.split(' + ').includes(c.item.item)));
            assert.equal(c.pi, undefined, 'sem Planner, sem PI');
            assert.deepEqual(c.relacoes, []);
        }

        const propofol = contextos.find(c => c.item.item === 'Propofol')!;
        assert.deepEqual(propofol.regras, [validadas[0]]);
        assert.deepEqual(propofol.telemetriaRelevante, { PAM: 52 });
        assert.deepEqual(propofol.evidencias, [{ regraId: validadas[0].regraId, campo: 'PAM', observado: 52, esperado: '< 60' }]);
        assert.ok(contextos.some(c => c.regrasRelacionais.length > 0), 'alguma interacao chegou ao item que ela cita');
    });

    await teste('sem o universo de decisoes, nenhuma decisao e dada como bloqueada', () => {
        for (const c of contextosPorItem(poda)) {
            assert.deepEqual(c.decisoes.bloqueadas, []);
            assert.deepEqual(c.regras, []);
            assert.deepEqual(c.telemetriaRelevante, {});
            assert.equal(c.pedido, '');
        }
    });

    // =========================================================================
    console.log('\nScheduler de PIs no fluxo');
    // =========================================================================

    await teste('SEQUENCE_VALID -> DAG -> ondas -> PI_DECOMPOSED -> PI_EXECUTING: o fluxo segue, onda por onda, ate COMPLETED', async () => {
        const conhecimento: ConhecimentoRecuperado<RetrievedConstraints> = {
            constraints, foco: null, auditoriaRecuperacao: auditoriaVazia('deterministica', 'med', CENARIO.intencao!, 'req-dag'),
            poda, politicaEfetiva: poda, promptSemantico: montarPromptSemantico(constraints, CENARIO, poda)
        };
        // PI 3 depende do 1; o 2 e independente: ondas [1, 2] [3].
        const planoDoPlanner = 'PLANO 1 | Propofol | Manter_Bloqueio | [ ] 2 | Noradrenalina | Acionar_Equipe | [ ] 3 | Vancomicina | Solicitar_Exame_Controle | [ 1 ] FIM';
        const motorPlanner: MotorPlanner = async () => ({ saida: planoDoPlanner, tokens_prompt: 4000 });
        const pis: PedidoPIAgent[] = [];
        process.env.SPC_CML_DECODIFICACAO = 'multiagente';
        try {
            const r = (await decodificar({
                ...montarEntradaGeracao(CENARIO, constraints, modelo, poda, conhecimento),
                endpoint: SEM_MOTOR, motor: async () => { throw new Error('nem incremental nem monolitica'); },
                motorPlanner, motorPIAgent: piAgentQueObedece(pis), verificadorGramatical: verificadorQueAceita()
            })) as ResultadoMultiagente;
            const ctx = r.execucao;
            const caminho = [ctx.historicoStatus[0].de, ...ctx.historicoStatus.map(t => t.para)];
            const i = caminho.indexOf('SEQUENCE_VALID');
            assert.deepEqual(caminho.slice(i, i + 4), ['SEQUENCE_VALID', 'PI_DECOMPOSING', 'PI_DECOMPOSED', 'PI_EXECUTING']);
            assert.equal(ctx.status, 'COMPLETED');
            // O DAG nasceu da sequencia validada, e so dela.
            assert.deepEqual(ctx.planoExecucaoPI!.ordens, ctx.sequenciaValidada!.map(p => p.ordem));
            assert.deepEqual(ctx.planoExecucaoPI!.predecessores, { 1: [], 2: [], 3: [1] });
            assert.deepEqual(ctx.planoExecucaoPI!.ondas.map(o => o.ordens), [[1, 2], [3]]);
            assert.match(ctx.historicoStatus.find(t => t.para === 'PI_DECOMPOSED')!.motivo!, /em 2 onda\(s\), largura maxima 2/);
            assert.deepEqual(ctx.ondasPI.map(o => o.status), ['CONCLUIDA', 'CONCLUIDA']);
            assert.deepEqual(pis.map(p => p.ordem), [1, 2, 3], 'em serie, onda por onda');
            assert.deepEqual(ctx.resultadosPI.map(x => x.ordem), [1, 2, 3]);
            assert.deepEqual(incoerenciasDoContexto(ctx), []);
        } finally {
            restaurar();
        }
    });

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
