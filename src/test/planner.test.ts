/**
 * Planner multiagente: contexto, prompt, leitura da saida e integracao com
 * `SPC_CML_DECODIFICACAO=multiagente`.
 *
 * O que estes testes cobram, antes de tudo, e a FRONTEIRA do Planner:
 *
 *   - ele escolhe o par (item, conduta), a ordem e as dependencias — e so;
 *   - acao, decisao, meio, valor e justificativa sao recusados na leitura,
 *     venha a saida de onde vier;
 *   - a leitura nao corrige nada: nome estranho segue como veio (com aviso),
 *     posicao fora de ordem e recusada, texto livre e markdown sao recusados;
 *   - com plano valido na primeira, UMA chamada ao Planner; depois de
 *     SEQUENCE_VALID vem o Decompositor (deterministico), os PI Agents — aqui
 *     um duble que obedece —, a composicao e a validacao global, ate COMPLETED.
 *
 * Roda OFFLINE. O Planner e um duble injetado, ou um motor falso HTTP local
 * que responde `/generate-planner` e conta toda requisicao que recebe — e o
 * que prova que o caminho monolitico (`/generate-constrained`) nao foi tocado.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

import { loadModel } from '../database/neo4j.js';
import { loadFutModel } from '../database/neo4j-fut.js';
import {
    condutasPorDecisaoMed,
    pruningPayload,
    retrieveConstraints,
    type ClinicalContext,
    type RetrievedConstraints
} from '../knowledge/graphrag.js';
import { futPruningPayload, retrieveFutConstraints, type FutContext } from '../knowledge/graphrag-fut.js';
import { montarEntradaGeracao, montarPromptSemantico } from '../inference/llm-client.js';
import { montarEntradaGeracaoFut, montarPromptSemanticoFut } from '../inference/fut-client.js';
import {
    decodificar,
    ehResultadoMultiagente,
    motorPlannerHttp,
    type MotorFragmento,
    type OpcoesIncremental,
    type OpcoesMultiagente,
    type ResultadoMultiagente
} from '../inference/decodificacao.js';
import {
    condutasObrigatorias,
    condutasRealizaveis,
    estadoVazio,
    montarContrato
} from '../knowledge/contrato.js';
import {
    FORMATO_PLANNER,
    contextoPlanner,
    lerSaidaPlanner,
    montarPromptPlanner,
    planejarSequencia,
    type ContextoPlanner,
    type MotorPlanner,
    type PedidoPlanner
} from '../inference/planner.js';
import {
    avancarStatus,
    incoerenciasDoContexto,
    novoContextoExecucao,
    registrarConhecimento,
    resumoExecucao,
    ORCAMENTO_PADRAO
} from '../inference/multiagente.js';
import { auditoriaVazia } from '../knowledge/recuperacao-hibrida.js';
import type { ConhecimentoRecuperado } from '../inference/recuperacao-conhecimento.js';
import type { SubgrafoPodado } from '../knowledge/politica.js';
import type { Dominio } from '../knowledge/recuperacao.js';
import type { ResultadoValidacao } from '../knowledge/validacao.js';
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

const codigos = (r: ResultadoValidacao): string[] => r.erros.map(e => e.codigo);
const avisos = (r: ResultadoValidacao): string[] => r.avisos.map(a => a.codigo);

/** O cenario de referencia do projeto: choque, renal cronico, tres farmacos em curso. */
const CENARIO: ClinicalContext = {
    paciente: 'PT-TESTE-0001',
    intencao: 'A pressao ta despencando (PAM=52), sobe a nora e aprofunda o propofol',
    telemetria: { PAM: 52, FC: 145, lactato: 4.8, RASS: 2, TFG: 28, plaquetas: 45, glicemia: 210 },
    populacoes: ['Renal_Cronico'],
    farmacosEmUso: ['Noradrenalina', 'Propofol', 'Vancomicina']
};

/** A recuperacao de uma requisicao, montada sem Neo4j: o mesmo formato que `recuperarConhecimento` devolve. */
function conhecimentoDe<R>(
    dominio: Dominio,
    id: string,
    intencao: string,
    constraints: R,
    politica: SubgrafoPodado,
    promptSemantico: string
): ConhecimentoRecuperado<R> {
    return {
        constraints,
        foco: null,
        auditoriaRecuperacao: auditoriaVazia('deterministica', dominio, intencao, id),
        poda: politica,
        politicaEfetiva: politica,
        promptSemantico
    };
}

/** Um Planner duble que devolve um plano bem formado a partir dos candidatos que recebeu. */
function plannerQueObedece(chamadas: PedidoPlanner[], posicoes = 2): MotorPlanner {
    return async pedido => {
        chamadas.push(pedido);
        const n = Math.min(posicoes, pedido.max_pis, pedido.itens.length);
        const linhas = pedido.itens.slice(0, n).map(
            (item, i) => `${i + 1} | ${item} | ${pedido.condutas[i % pedido.condutas.length]} | [ ${i > 0 ? '1' : ''} ]`
        );
        return { saida: `PLANO ${linhas.join(' ')} FIM`, tokens_prompt: 777, valida_na_gramatica: true };
    };
}

/** Motor falso: responde so /generate-planner e registra TODA requisicao que chega. */
async function motorFalso(
    responder: (corpo: PedidoPlanner) => { status: number; corpo: unknown }
): Promise<{ url: string; recebidas: { rota: string; corpo: unknown }[]; fechar: () => void }> {
    const recebidas: { rota: string; corpo: unknown }[] = [];
    const servidor = http.createServer((req, res) => {
        let texto = '';
        req.on('data', parte => (texto += parte));
        req.on('end', () => {
            const corpo = texto ? JSON.parse(texto) : undefined;
            recebidas.push({ rota: req.url ?? '', corpo });
            const r = req.url === '/generate-planner'
                ? responder(corpo as PedidoPlanner)
                : { status: 500, corpo: { detail: `rota inesperada no teste: ${req.url}` } };
            res.writeHead(r.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(r.corpo));
        });
    });
    await new Promise<void>(resolve => servidor.listen(0, '127.0.0.1', resolve));
    const porta = (servidor.address() as AddressInfo).port;
    return {
        url: `http://127.0.0.1:${porta}`,
        recebidas,
        fechar: () => {
            servidor.closeAllConnections();
            servidor.close();
        }
    };
}

async function main(): Promise<void> {
    const modelo = await loadModel(path.join('src', 'examples', 'med', 'uti.dsl'));
    const constraints = retrieveConstraints(modelo, CENARIO);
    const poda = pruningPayload(constraints, CENARIO);
    const prompt = montarPromptSemantico(constraints, CENARIO, poda);
    const contrato = montarContrato(poda, condutasPorDecisaoMed(modelo), constraints.escalonamentos.map(e => `${e.destino}: ${e.detalhe}`));

    const original = process.env.SPC_CML_DECODIFICACAO;
    const restaurar = (): void => {
        if (original === undefined) delete process.env.SPC_CML_DECODIFICACAO;
        else process.env.SPC_CML_DECODIFICACAO = original;
    };

    /** Contexto da execucao ja em PLANNING, como `decodificarMultiagente` o deixa antes do Planner. */
    const emPlanejamento = (id = 'req-planner') => {
        const ctx = novoContextoExecucao<ClinicalContext, RetrievedConstraints>({
            dominio: 'med', pedido: CENARIO.intencao!, contexto: CENARIO, requestId: id, orcamento: ORCAMENTO_PADRAO
        });
        registrarConhecimento(ctx, conhecimentoDe('med', id, CENARIO.intencao!, constraints, poda, prompt));
        avancarStatus(ctx, 'PLANNING');
        return ctx;
    };

    // =========================================================================
    console.log('\nLeitura da saida do Planner');
    // =========================================================================

    const UNIVERSO = { itens: ['I1', 'I2', 'I3'], condutas: ['C1', 'C2'] };

    await teste('caso 1 — sequencia valida: exatamente os PIs escritos, sem campo a mais', () => {
        const esperado = [
            { ordem: 1, item: 'I1', conduta: 'C1', dependeDe: [] },
            { ordem: 2, item: 'I2', conduta: 'C2', dependeDe: [1] }
        ];
        for (const saida of [
            'PLANO\n1 | I1 | C1 | [ ]\n2 | I2 | C2 | [ 1 ]\nFIM',
            'PLANO 1 | I1 | C1 | [ ] 2 | I2 | C2 | [ 1 ] FIM',
            'PLANO\n1|I1|C1|[]\n2|I2|C2|[1]\nFIM'
        ]) {
            const r = lerSaidaPlanner(saida, UNIVERSO);
            assert.equal(r.veredito, 'VALID', saida);
            assert.deepEqual(r.valor, esperado);
            assert.deepEqual(r.avisos, []);
            for (const pi of r.valor!) assert.deepEqual(Object.keys(pi), ['ordem', 'item', 'conduta', 'dependeDe']);
        }
    });

    await teste('caso 2 — sequencia vazia: o contrato estrutural a recusa (sequencia_vazia)', () => {
        const r = lerSaidaPlanner('PLANO FIM', UNIVERSO);
        assert.equal(r.veredito, 'INVALID');
        assert.deepEqual(codigos(r), ['sequencia_vazia']);
        assert.deepEqual(codigos(lerSaidaPlanner('   ')), ['saida_vazia']);
    });

    await teste('caso 3 — item inexistente: segue como veio, com aviso; nada e corrigido nem aproximado', () => {
        for (const item of ['Dopamina', 'i1', 'I1_']) {
            const r = lerSaidaPlanner(`PLANO 1 | ${item} | C1 | [ ] FIM`, UNIVERSO);
            assert.equal(r.veredito, 'VALID', 'vocabulario e da validacao semantica, nao da leitura');
            assert.equal(r.valor![0].item, item);
            assert.deepEqual(avisos(r), ['item_fora_dos_candidatos']);
        }
    });

    await teste('caso 4 — conduta inexistente: mesmo comportamento (inclusive `marcacao`)', () => {
        for (const conduta of ['marcacao', 'Turbinar_Droga']) {
            const r = lerSaidaPlanner(`PLANO 1 | I1 | ${conduta} | [ ] FIM`, UNIVERSO);
            assert.equal(r.veredito, 'VALID');
            assert.equal(r.valor![0].conduta, conduta);
            assert.deepEqual(avisos(r), ['conduta_fora_dos_candidatos']);
        }
    });

    await teste('caso 5 — texto livre falha; nenhum item e garimpado do texto', () => {
        assert.deepEqual(
            codigos(lerSaidaPlanner('Aqui esta o plano:\n\n1. subir a I1 porque...\n2. manter a I2 porque...', UNIVERSO)),
            ['cabecalho_ausente']
        );
        assert.deepEqual(codigos(lerSaidaPlanner('PLANO 1 | I1 | C1 | [ ] porque a PAM caiu FIM')), ['pi_malformado']);
        assert.deepEqual(codigos(lerSaidaPlanner('PLANO 1 | I1 | C1 | [ ] FIM\nEspero ter ajudado.')), ['terminador_ausente']);
        assert.deepEqual(codigos(lerSaidaPlanner('plano 1 | I1 | C1 | [ ] fim')), ['cabecalho_ausente']);
    });

    await teste('caso 6 — markdown falha: cerca de codigo e negrito estao fora do protocolo', () => {
        assert.deepEqual(codigos(lerSaidaPlanner('```\nPLANO\n1 | I1 | C1 | [ ]\nFIM\n```')), ['cabecalho_ausente']);
        assert.deepEqual(codigos(lerSaidaPlanner('**PLANO** 1 | I1 | C1 | [ ] FIM')), ['cabecalho_ausente']);
        assert.deepEqual(codigos(lerSaidaPlanner('PLANO\n- 1 | I1 | C1 | [ ]\nFIM')), ['pi_malformado']);
    });

    await teste('caso 7 — acao: qualquer campo de acao recusa a saida inteira', () => {
        for (const saida of [
            'PLANO 1 | I1 | C1 | [ ] | DECISAO=AUMENTAR_VAZAO FIM',
            'PLANO 1 | I1 | C1 | [ ] | acao: suspender FIM',
            'PLANO 1 | I1 | C1 | [ ] | meio ACESSO_CENTRAL | valor 0.05 FIM'
        ]) {
            const r = lerSaidaPlanner(saida);
            assert.deepEqual(codigos(r), ['campo_de_acao'], saida);
            assert.match(r.erros[0].mensagem, /PI Agent/);
        }
        // `_` fica dentro do nome: conduta `Ajustar_Valor` nao e o campo `valor`.
        assert.equal(lerSaidaPlanner('PLANO 1 | I1 | Ajustar_Valor | [ ] FIM').veredito, 'VALID');
    });

    await teste('caso 8 — justificativa: recusada como campo e como texto', () => {
        assert.deepEqual(codigos(lerSaidaPlanner('PLANO 1 | I1 | C1 | [ ] | JUSTIFICATIVA=PAM baixa FIM')), ['campo_de_acao']);
        assert.deepEqual(codigos(lerSaidaPlanner('PLANO 1 | I1 | C1 | [ ] FIM\njustificativa: a PAM caiu')), ['campo_de_acao']);
        assert.deepEqual(codigos(lerSaidaPlanner("PLANO 1 | I1 | C1 | [ ] 'porque a PAM caiu' FIM")), ['pi_malformado']);
    });

    await teste('caso 9 — dependencia futura: recusada pelo limite estrutural do contrato', () => {
        assert.deepEqual(codigos(lerSaidaPlanner('PLANO 1 | I1 | C1 | [ 2 ] 2 | I2 | C2 | [ ] FIM')), ['dependencia_posterior']);
        assert.deepEqual(codigos(lerSaidaPlanner('PLANO 1 | I1 | C1 | [ 1 ] FIM')), ['dependencia_propria']);
        assert.deepEqual(codigos(lerSaidaPlanner('PLANO 1 | I1 | C1 | [ ] 2 | I2 | C2 | [ 7 ] FIM')), ['dependencia_inexistente']);
        const r = lerSaidaPlanner('PLANO 1 | I1 | C1 | [ ] 2 | I2 | C2 | [ ] 3 | I3 | C1 | [ 1 , 2 ] FIM');
        assert.deepEqual(r.valor![2].dependeDe, [1, 2]);
    });

    await teste('caso 10 — ordem: preservada exatamente; fora de ordem e recusado, nunca renumerado', () => {
        const r = lerSaidaPlanner('PLANO 1 | I3 | C2 | [ ] 2 | I1 | C1 | [ ] 3 | I2 | C1 | [ 2 ] FIM', UNIVERSO);
        assert.deepEqual(r.valor!.map(p => [p.ordem, p.item]), [[1, 'I3'], [2, 'I1'], [3, 'I2']]);
        const trocada = lerSaidaPlanner('PLANO 2 | I1 | C1 | [ ] 1 | I2 | C2 | [ ] FIM');
        assert.deepEqual(codigos(trocada), ['ordem_fora_de_posicao']);
        assert.equal(trocada.erros[0].pi, 1);
        assert.deepEqual(codigos(lerSaidaPlanner('PLANO 1 | I1 | C1 | [ ] 3 | I2 | C2 | [ ] FIM')), ['ordem_fora_de_posicao']);
    });

    await teste('caso 11 — duplicacao: par repetido e aviso (os dois PIs ficam); mesmo item com outra conduta, nada', () => {
        const r = lerSaidaPlanner('PLANO 1 | I1 | C1 | [ ] 2 | I1 | C1 | [ ] FIM', UNIVERSO);
        assert.equal(r.veredito, 'VALID');
        assert.equal(r.valor!.length, 2);
        assert.deepEqual(avisos(r), ['pi_repetido']);
        assert.equal(r.avisos[0].pi, 2);
        const outra = lerSaidaPlanner('PLANO 1 | I1 | C1 | [ ] 2 | I1 | C2 | [ ] FIM', UNIVERSO);
        assert.deepEqual(avisos(outra), [], 'unicidade de item e da validacao semantica');
        // Dependencia repetida: aviso do contrato estrutural, que ja existia.
        assert.deepEqual(avisos(lerSaidaPlanner('PLANO 1 | I1 | C1 | [ ] 2 | I2 | C2 | [ 1 , 1 ] FIM')), ['dependencia_repetida']);
    });

    // =========================================================================
    console.log('\nContexto do Planner');
    // =========================================================================

    await teste('e uma projecao: os campos globais sao os mesmos objetos do contexto da execucao', () => {
        const ctx = emPlanejamento();
        const cp = contextoPlanner(ctx, contrato, 5).valor!;
        assert.equal(cp.contexto, ctx.contexto);
        assert.equal(cp.politicaEfetiva, ctx.politicaEfetiva);
        assert.equal(cp.regras, ctx.regras);
        assert.equal(cp.evidencias, ctx.evidencias);
        assert.equal(cp.promptSemantico, ctx.promptSemantico);
        assert.equal(cp.requestId, ctx.requestId);
        assert.deepEqual(cp.tentativa, { ciclo: 1, numero: 1 });
        assert.equal(cp.dependenciasPermitidas, 'somente_anteriores');
    });

    await teste('os candidatos saem da politica efetiva e do contrato, com o mesmo criterio do incremental', () => {
        const cp = contextoPlanner(emPlanejamento(), contrato, 5).valor!;
        const itensDaPolitica = poda.politicas.map(p => p.item);
        assert.ok(cp.itensDisponiveis.length > 0);
        assert.ok(cp.itensDisponiveis.every(i => itensDaPolitica.includes(i)));
        for (const item of cp.itensDisponiveis) {
            const decisoes = poda.politicas.find(p => p.item === item)!.decisoes;
            const esperadas = [...new Set(decisoes.map(d => contrato.condutaPorDecisao[d]).filter(Boolean))];
            assert.deepEqual(cp.condutasPorItem[item], esperadas, item);
        }
        assert.deepEqual(cp.condutasDisponiveis, condutasRealizaveis(contrato, estadoVazio()));
        assert.deepEqual(
            [...new Set(Object.values(cp.condutasPorItem).flat())].sort(),
            [...cp.condutasDisponiveis].sort(),
            'a uniao por item e o universo de condutas'
        );
        assert.deepEqual(cp.condutasObrigatorias, condutasObrigatorias(contrato));
    });

    await teste('o teto de posicoes respeita a unicidade do contrato', () => {
        const ctx = emPlanejamento();
        const cp = contextoPlanner(ctx, contrato, 50).valor!;
        assert.equal(cp.maxPIs, cp.itensDisponiveis.length);
        assert.equal(contextoPlanner(ctx, contrato, 1).valor!.maxPIs, 1);
        assert.equal(contextoPlanner(ctx, { ...contrato, unicidade: false }, 50).valor!.maxPIs, 50);
        assert.throws(() => contextoPlanner(ctx, contrato, 0), /teto de posicoes/);
    });

    await teste('sem universo de candidatos: UNRESOLVED, dizendo o que faltou', () => {
        const ctx = emPlanejamento();
        const semMapa = contextoPlanner(ctx, { ...contrato, condutaPorDecisao: {} }, 5);
        assert.equal(semMapa.veredito, 'UNRESOLVED');
        assert.match(semMapa.dadosFaltantes[0], /condutas candidatas/);

        const vazia = { ...poda, politicas: [], acoes_permitidas: [], farmacos_liberados: [], vias_disponiveis: [] };
        const ctxVazio = novoContextoExecucao({ dominio: 'med', pedido: 'p', contexto: CENARIO, requestId: 'v', orcamento: ORCAMENTO_PADRAO });
        registrarConhecimento(ctxVazio, conhecimentoDe('med', 'v', 'p', constraints, vazia, prompt));
        const semItem = contextoPlanner(ctxVazio, contrato, 5);
        assert.equal(semItem.veredito, 'UNRESOLVED');
        assert.match(semItem.dadosFaltantes[0], /itens candidatos/);
    });

    await teste('sem o conhecimento registrado, e erro de uso', () => {
        const ctx = novoContextoExecucao({ dominio: 'med', pedido: 'p', contexto: CENARIO, orcamento: ORCAMENTO_PADRAO });
        assert.throws(() => contextoPlanner(ctx, contrato, 5), /conhecimento registrado/);
    });

    // =========================================================================
    console.log('\nPrompt do Planner');
    // =========================================================================

    const cpRef: ContextoPlanner = contextoPlanner(emPlanejamento(), contrato, 5).valor!;
    const promptRef = montarPromptPlanner(cpRef);

    await teste('o Prompt Semantico global entra inteiro e uma vez so — a politica nao e reescrita', () => {
        assert.equal(promptRef.split(cpRef.promptSemantico).length, 2);
        assert.ok(promptRef.includes(`comando: ${CENARIO.intencao}`));
    });

    await teste('o papel e as proibicoes estao explicitos', () => {
        for (const frase of [
            'Voce e o Planner. Sua unica responsabilidade e escolher a sequencia de pares item-conduta.',
            'Nao produza acao.', 'Nao produza decisao.', 'Nao produza meio.', 'Nao produza valor.',
            'Nao produza justificativa.', 'Nao produza clausulas.', 'Nao produza explicacoes fora do formato.'
        ]) {
            assert.ok(promptRef.includes(frase), frase);
        }
    });

    await teste('candidatos por item, condutas obrigatorias e formato; termina onde o plano comeca', () => {
        for (const item of cpRef.itensDisponiveis) {
            assert.ok(promptRef.includes(`- ${item}: ${cpRef.condutasPorItem[item].join(', ')}`), item);
        }
        assert.equal(promptRef.includes('[CONDUTAS OBRIGATORIAS'), cpRef.condutasObrigatorias.length > 0);
        assert.ok(promptRef.includes(FORMATO_PLANNER));
        assert.ok(promptRef.includes(`No maximo ${cpRef.maxPIs} posicao(oes)`));
        assert.ok(promptRef.endsWith('plano:\n'));
    });

    await teste('nada do prompt do artefato: sem exemplares, sem gramatica da clausula', () => {
        for (const marca of ['regras BNF', 'plano baseado nas regras', 'esquema_referencia', "justificativa '", 'auditoria \'']) {
            assert.ok(!promptRef.includes(marca), marca);
        }
    });

    // =========================================================================
    console.log('\nServico do Planner');
    // =========================================================================

    await teste('uma chamada: prompt, vocabulario e teto vao ao motor; a saida e lida e medida', async () => {
        const chamadas: PedidoPlanner[] = [];
        let relogio = 1000;
        const proposta = await planejarSequencia(cpRef, plannerQueObedece(chamadas), () => (relogio += 250));
        assert.equal(chamadas.length, 1);
        assert.deepEqual(chamadas[0], {
            prompt: promptRef, itens: cpRef.itensDisponiveis, condutas: cpRef.condutasDisponiveis, max_pis: cpRef.maxPIs
        });
        assert.equal(proposta.prompt, promptRef);
        assert.equal(proposta.validacao.veredito, 'VALID');
        assert.deepEqual(proposta.metricas, {
            caracteresPrompt: promptRef.length, itensCandidatos: cpRef.itensDisponiveis.length,
            condutasCandidatas: cpRef.condutasDisponiveis.length, duracaoMs: 250,
            pisProduzidos: proposta.validacao.valor!.length, tokensPrompt: 777, validaNaGramatica: true
        });
    });

    await teste('saida fora do protocolo volta INVALID com a saida bruta — e nao ha segunda chamada', async () => {
        let chamadas = 0;
        const livre = 'Claro! Primeiro subimos a noradrenalina e depois mantemos o propofol.';
        const proposta = await planejarSequencia(cpRef, async () => { chamadas++; return { saida: livre }; });
        assert.equal(chamadas, 1);
        assert.equal(proposta.bruto, livre);
        assert.equal(proposta.validacao.veredito, 'INVALID');
        assert.equal(proposta.metricas.pisProduzidos, 0);
    });

    await teste('falha tecnica do motor sobe como excecao', async () => {
        await assert.rejects(planejarSequencia(cpRef, async () => { throw new Error('motor caiu'); }), /motor caiu/);
    });

    // =========================================================================
    console.log('\nCliente HTTP do Planner (motor falso local)');
    // =========================================================================

    await teste('POST /generate-planner com prompt, itens, condutas e max_pis; resposta repassada crua', async () => {
        const falso = await motorFalso(() => ({ status: 200, corpo: { saida: 'PLANO 1 | I1 | C1 | [ ] FIM', tokens_prompt: 42 } }));
        try {
            const pedido = { prompt: 'p', itens: ['I1'], condutas: ['C1'], max_pis: 1 };
            const r = await motorPlannerHttp(falso.url, 5000)(pedido);
            assert.deepEqual(r, { saida: 'PLANO 1 | I1 | C1 | [ ] FIM', tokens_prompt: 42 });
            assert.deepEqual(falso.recebidas, [{ rota: '/generate-planner', corpo: pedido }]);
        } finally {
            falso.fechar();
        }
    });

    await teste('motor sem a rota (processo antigo) e erro de outro status sao falha tecnica explicita', async () => {
        const antigo = await motorFalso(() => ({ status: 404, corpo: { detail: 'Not Found' } }));
        const quebrado = await motorFalso(() => ({ status: 422, corpo: { detail: 'sem candidato' } }));
        try {
            const pedido = { prompt: 'p', itens: ['I1'], condutas: ['C1'], max_pis: 1 };
            await assert.rejects(motorPlannerHttp(antigo.url, 5000)(pedido), /desatualizado/);
            await assert.rejects(motorPlannerHttp(quebrado.url, 5000)(pedido), /respondeu 422/);
        } finally {
            antigo.fechar();
            quebrado.fechar();
        }
    });

    // =========================================================================
    console.log('\nIntegracao: decodificar com SPC_CML_DECODIFICACAO=multiagente');
    // =========================================================================

    const conhecimentoRef = conhecimentoDe('med', 'req-integracao', CENARIO.intencao!, constraints, poda, prompt);
    const entradaCom = (motorHttp: string, c: ConhecimentoRecuperado<RetrievedConstraints> = conhecimentoRef, politica = poda) =>
        ({ ...montarEntradaGeracao(CENARIO, constraints, modelo, politica, c), endpoint: motorHttp });

    /** Roda `decodificar` com o modo pedido, contando fragmentos, Planner e HTTP. */
    async function rodar(
        modo: string | undefined,
        motorPlanner: MotorPlanner | undefined,
        opts: (url: string) => OpcoesIncremental & OpcoesMultiagente,
        respostaHttp: (corpo: PedidoPlanner) => { status: number; corpo: unknown } = () => ({ status: 500, corpo: {} })
    ) {
        const falso = await motorFalso(respostaHttp);
        let fragmentos = 0;
        const motor: MotorFragmento = async pedido => {
            fragmentos++;
            return pedido.encerramento ? { fragmento: '', encerrou: true } : { fragmento: 'Plano_Teste', encerrou: false };
        };
        if (modo === undefined) delete process.env.SPC_CML_DECODIFICACAO;
        else process.env.SPC_CML_DECODIFICACAO = modo;
        try {
            // O PI Agent e um duble que obedece: aqui so o Planner esta em teste.
            const r = await decodificar({
                ...opts(falso.url), motor, ...(motorPlanner ? { motorPlanner } : {}), motorPIAgent: piAgentQueObedece(),
                verificadorGramatical: verificadorQueAceita()
            });
            return { r, fragmentos, http: falso.recebidas };
        } finally {
            restaurar();
            falso.fechar();
        }
    }

    // Valido para o cenario de referencia (PAM 52, politica inteira): trata o
    // Propofol, que o pedido cita, com uma conduta que ele realiza, e cumpre o
    // Acionar_Equipe que o escalonamento disparado obriga.
    const VALIDO_MED = 'PLANO 1 | Propofol | Manter_Bloqueio | [ ] 2 | Noradrenalina | Acionar_Equipe | [ 1 ] FIM';
    const plannerFixo = (saida: string, chamadas: PedidoPlanner[] = []): MotorPlanner => async pedido => {
        chamadas.push(pedido);
        return { saida, tokens_prompt: 777, valida_na_gramatica: true };
    };

    await teste('ate COMPLETED: plano valido na primeira, Planner chamado uma vez, incremental e monolitica nao', async () => {
        const chamadas: PedidoPlanner[] = [];
        const { r, fragmentos, http: recebidas } = await rodar('multiagente', plannerFixo(VALIDO_MED, chamadas), url => entradaCom(url));
        assert.ok(ehResultadoMultiagente(r));
        const ctx = (r as ResultadoMultiagente).execucao;

        assert.equal(chamadas.length, 1, 'o Planner e chamado exatamente uma vez');
        assert.equal(fragmentos, 0, 'o incremental nao foi chamado');
        assert.deepEqual(recebidas, [], 'nenhuma requisicao HTTP: a monolitica (/generate-constrained) nao foi chamada');

        assert.equal(ctx.status, 'COMPLETED');
        assert.deepEqual(ctx.historicoStatus.map(t => `${t.de}->${t.para}`), [
            'RECEIVED->KNOWLEDGE_RETRIEVED', 'KNOWLEDGE_RETRIEVED->SEMANTIC_PROMPT_READY',
            'SEMANTIC_PROMPT_READY->PLANNING', 'PLANNING->SEQUENCE_VALIDATING', 'SEQUENCE_VALIDATING->SEQUENCE_VALID',
            'SEQUENCE_VALID->PI_DECOMPOSING', 'PI_DECOMPOSING->PI_DECOMPOSED',
            'PI_DECOMPOSED->PI_EXECUTING', 'PI_EXECUTING->PI_VALIDATING', 'PI_VALIDATING->PI_EXECUTING',
            'PI_EXECUTING->PI_VALIDATING', 'PI_VALIDATING->PI_ALL_VALID',
            'PI_ALL_VALID->COMPOSING', 'COMPOSING->GLOBAL_VALIDATING', 'GLOBAL_VALIDATING->COMPLETED'
        ]);
        assert.deepEqual(ctx.contextosPI!.map(c => c.pi), ctx.sequenciaValidada, 'um contexto por PI, na ordem');
        assert.equal(ctx.requestId, 'req-integracao', 'o id da execucao e o da auditoria');

        const esperada = [
            { ordem: 1, item: 'Propofol', conduta: 'Manter_Bloqueio', dependeDe: [] },
            { ordem: 2, item: 'Noradrenalina', conduta: 'Acionar_Equipe', dependeDe: [1] }
        ];
        assert.deepEqual(ctx.sequenciaCandidata, esperada);
        assert.deepEqual(ctx.sequenciaValidada, esperada);
        for (const pi of ctx.sequenciaValidada!) {
            assert.ok(!('acao' in pi) && !('justificativa' in pi) && !('regras' in pi), 'o Planner nao produz acao, justificativa nem regras');
        }

        assert.equal(ctx.tentativasPlanner.length, 1);
        const t = ctx.tentativasPlanner[0];
        assert.deepEqual([t.ciclo, t.tentativa, t.fase], [1, 1, 'semantica']);
        assert.match(String(t.proposta), /^PLANO /);
        assert.equal(t.metricas?.pisProduzidos, 2);
        assert.equal(t.realimentacao, undefined, 'sem proxima tentativa, sem feedback');
        assert.deepEqual(incoerenciasDoContexto(ctx), []);

        assert.equal(r.resultado, ctx.artefatoFinal, 'o resultado e o artefato globalmente valido');
        assert.equal(r.valido, true);
        assert.equal(r.erro, null);
        const resumo = JSON.parse(JSON.stringify(resumoExecucao(ctx)));
        assert.deepEqual(resumo.sequenciaValidada, ctx.sequenciaValidada, 'o resumo atravessa JSON');
        assert.deepEqual(resumo.contextosPI, ctx.contextosPI, 'os contextos de PI tambem');
    });

    await teste('o mesmo caminho pelo cliente HTTP real, contra o motor falso: so /generate-planner e chamado', async () => {
        const { r, fragmentos, http: recebidas } = await rodar('multiagente', undefined, url => entradaCom(url), () => ({
            status: 200,
            corpo: { saida: VALIDO_MED, tokens_prompt: 900, valida_na_gramatica: true }
        }));
        const ctx = (r as ResultadoMultiagente).execucao;
        assert.equal(ctx.status, 'COMPLETED');
        assert.equal(fragmentos, 0);
        assert.deepEqual(recebidas.map(x => x.rota), ['/generate-planner'], 'nem /generate-fragment, nem rota de PI');
        assert.equal(ctx.tentativasPlanner[0].metricas?.tokensPrompt, 900);
        assert.equal(ctx.sequenciaValidada!.length, 2);
    });

    await teste('sem a variavel, a mesma entrada segue no incremental — a recuperacao a mais e inerte', async () => {
        const chamadas: PedidoPlanner[] = [];
        const { r, fragmentos, http: recebidas } = await rodar(undefined, plannerQueObedece(chamadas), url => entradaCom(url));
        assert.ok(!ehResultadoMultiagente(r));
        assert.ok('passos' in r, 'o resultado e o do incremental');
        assert.ok(fragmentos > 0);
        assert.equal(chamadas.length, 0, 'o Planner nao e chamado fora do modo multiagente');
        assert.deepEqual(recebidas, []);
    });

    await teste('caso 12 — Planner sem candidatos: UNRESOLVED sem chamar o modelo e sem inventar sequencia', async () => {
        let chamadas = 0;
        const planner: MotorPlanner = async () => { chamadas++; return { saida: 'PLANO 1 | X | Y | [ ] FIM' }; };

        // Sem o modelo da DSL (como na CLI), nao ha mapa decisao -> conduta.
        const semModelo = (url: string) => ({
            ...montarEntradaGeracao(CENARIO, constraints, undefined, poda, conhecimentoRef), endpoint: url
        });
        const a = (await rodar('multiagente', planner, semModelo)).r as ResultadoMultiagente;
        assert.equal(a.execucao.status, 'UNRESOLVED');
        assert.match(a.execucao.errosValidacao[0].dadosFaltantes[0], /condutas candidatas/);

        const vazia = { ...poda, politicas: [], acoes_permitidas: [], farmacos_liberados: [], vias_disponiveis: [] };
        const cVazio = conhecimentoDe('med', 'req-vazio', CENARIO.intencao!, constraints, vazia, prompt);
        const b = (await rodar('multiagente', planner, url => entradaCom(url, cVazio, vazia))).r as ResultadoMultiagente;
        assert.equal(b.execucao.status, 'UNRESOLVED');

        assert.equal(chamadas, 0, 'sem universo, nao ha o que perguntar ao modelo');
        for (const x of [a, b]) {
            assert.equal(x.execucao.sequenciaCandidata, undefined);
            assert.deepEqual(x.execucao.tentativasPlanner, []);
            assert.deepEqual(x.execucao.historicoStatus.map(t => t.para).slice(-2), ['PLANNING', 'UNRESOLVED']);
        }
    });

    await teste('falha tecnica: FAILED com o motivo, sem nova chamada', async () => {
        let chamadas = 0;
        const { r } = await rodar('multiagente', async () => { chamadas++; throw new Error('http://motor inacessivel: fetch failed'); }, url => entradaCom(url));
        const ctx = (r as ResultadoMultiagente).execucao;
        assert.equal(chamadas, 1);
        assert.equal(ctx.status, 'FAILED');
        assert.match(ctx.historicoStatus[ctx.historicoStatus.length - 1].motivo ?? '', /inacessivel/);
        assert.match(r.erro ?? '', /FAILED/);
    });

    await teste('politica da geracao diferente da politica efetiva da recuperacao: FAILED, sem chamar o Planner', async () => {
        let chamadas = 0;
        const outra = { ...poda };
        const { r } = await rodar('multiagente', async () => { chamadas++; return { saida: '' }; }, url => entradaCom(url, conhecimentoRef, outra));
        assert.equal((r as ResultadoMultiagente).execucao.status, 'FAILED');
        assert.equal(chamadas, 0);
    });

    await teste('o fluxo e o mesmo em outro dominio (fut)', async () => {
        const modeloFut = await loadFutModel(path.join('src', 'examples', 'fut', 'futebol.fut'));
        const linha = fs.readFileSync(path.join('src', 'examples', 'fut', 'cenarios-fut.jsonl'), 'utf-8').split('\n')[0];
        const cenario = JSON.parse(linha) as FutContext;
        const c = retrieveFutConstraints(modeloFut, cenario);
        const p = futPruningPayload(c, cenario);
        const k = conhecimentoDe('fut', 'req-fut', cenario.intencao ?? '', c, p, montarPromptSemanticoFut(c, cenario, p));
        const chamadas: PedidoPlanner[] = [];
        // A saida real do Qwen no smoke da etapa anterior, para este mesmo cenario.
        const { r } = await rodar('multiagente', plannerFixo('PLANO 1 | Carga_Imprudente | Marcar_Penalti | [ ] FIM', chamadas), url => ({
            ...montarEntradaGeracaoFut(cenario, c, modeloFut, p, k), endpoint: url
        }));
        const ctx = (r as ResultadoMultiagente).execucao;
        assert.equal(ctx.status, 'COMPLETED');
        assert.equal(ctx.dominio, 'fut');
        const infracoes = modeloFut.elements.filter(e => e.$type === 'InfractionDef').map(e => (e as { name: string }).name);
        assert.ok(chamadas[0].itens.every(i => infracoes.includes(i)), 'os candidatos sao infracoes do modelo');
        assert.deepEqual(ctx.sequenciaValidada, [{ ordem: 1, item: 'Carga_Imprudente', conduta: 'Marcar_Penalti', dependeDe: [] }]);
    });

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
