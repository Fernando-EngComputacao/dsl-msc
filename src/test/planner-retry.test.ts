/**
 * O laco do Planner: proposta -> validacao deterministica -> feedback -> nova
 * proposta, dentro do orcamento.
 *
 * O Planner e um duble que devolve, em ordem, as saidas roteirizadas de cada
 * caso — e conta as chamadas: o que estes testes cobram, antes de tudo, e que
 * o numero de chamadas e exatamente o previsto, nunca uma a mais que o
 * orcamento. O conhecimento e o real (cenario de referencia, PAM 52, politica
 * inteira); nenhum fragmento e gerado e nenhuma requisicao HTTP sai.
 */

import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

import { loadModel } from '../database/neo4j.js';
import {
    pruningPayload,
    retrieveConstraints,
    type ClinicalContext,
    type RetrievedConstraints
} from '../knowledge/graphrag.js';
import { condutasDoItem, montarContrato } from '../knowledge/contrato.js';
import { condutasPorDecisaoMed } from '../knowledge/graphrag.js';
import { montarEntradaGeracao, montarPromptSemantico } from '../inference/llm-client.js';
import {
    decodificar,
    type MotorFragmento,
    type ResultadoMultiagente
} from '../inference/decodificacao.js';
import type { MotorPlanner, PedidoPlanner } from '../inference/planner.js';
import {
    avancarStatus,
    impedimentoDeReplanejar,
    incoerenciasDoContexto,
    novoContextoExecucao,
    registrarConhecimento,
    ORCAMENTO_PADRAO,
    type ContextoExecucaoMultiagente
} from '../inference/multiagente.js';
import { auditoriaVazia } from '../knowledge/recuperacao-hibrida.js';
import type { ConhecimentoRecuperado } from '../inference/recuperacao-conhecimento.js';
import type { PoliticaItem, SubgrafoPodado } from '../knowledge/politica.js';
import type { RegraValidada } from '../knowledge/recuperacao-cypher.js';
import { invalido, valido, type ResultadoValidacao } from '../knowledge/validacao.js';
import type { PIPlanejado } from '../knowledge/contrato-pi.js';
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

const PEDIDO = 'A pressao ta despencando (PAM=52), sobe a nora e aprofunda o propofol';
const TELEMETRIA = { PAM: 52, FC: 145, lactato: 4.8, RASS: 2, TFG: 28, plaquetas: 45, glicemia: 210 };
const CENARIO: ClinicalContext = {
    paciente: 'PT-TESTE-0001', intencao: PEDIDO, telemetria: TELEMETRIA,
    populacoes: ['Renal_Cronico'], farmacosEmUso: ['Noradrenalina', 'Propofol', 'Vancomicina']
};

// As saidas roteirizadas. Todas sao do protocolo, menos LIVRE.
const VALIDO = 'PLANO 1 | Propofol | Manter_Bloqueio | [ ] 2 | Noradrenalina | Acionar_Equipe | [ 1 ] FIM';
/** Propofol nao cumpre Titular_Vasopressor com PAM 52; e falta a obrigatoria. */
const INCOMPATIVEL = 'PLANO 1 | Propofol | Titular_Vasopressor | [ ] FIM';
/** Par certo, mas sem a conduta obrigatoria. */
const SEM_OBRIGATORIA = 'PLANO 1 | Propofol | Manter_Bloqueio | [ ] FIM';
/** O pedido cita o Propofol; o plano o ignora. */
const FORA_DO_PEDIDO = 'PLANO 1 | Noradrenalina | Acionar_Equipe | [ ] FIM';
const LIVRE = 'Claro! Primeiro subo a noradrenalina e depois mantenho o propofol.';

function regraSemMedida(item: string, campo: string): RegraValidada {
    return {
        regraId: `Farmaco:${item}/RegraSeguranca/${campo}<60`, tipo: 'RegraSeguranca', relacao: 'BLOQUEIA_INCREMENTO',
        item, dominio: 'med', aplicavel: false, condicoesSatisfeitas: [], condicoesFalhas: [],
        lacunas: [{ campo, esperado: '< 60 mmHg', motivo: `o cenario nao mediu '${campo}'` }],
        evidencia: {}, validacaoCypher: { valida: false, motivo: 'sem evidencia', consulta: '' }, efeito: {},
        rag: { candidatoId: `Farmaco:${item}`, escore: 0.9, cosseno: 0.8, papel: 'item', posicao: 0 }
    };
}

async function main(): Promise<void> {
    const modelo = await loadModel(path.join('src', 'examples', 'med', 'uti.dsl'));

    // Motor HTTP falso que so conta: qualquer requisicao aqui seria incremental ou monolitica.
    const recebidas: string[] = [];
    const servidor = http.createServer((req, res) => {
        recebidas.push(req.url ?? '');
        res.writeHead(500);
        res.end('{}');
    });
    await new Promise<void>(resolve => servidor.listen(0, '127.0.0.1', resolve));
    const URL_FALSA = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;

    const originais = {
        modo: process.env.SPC_CML_DECODIFICACAO,
        planner: process.env.SPC_CML_MAX_TENTATIVAS_PLANNER
    };

    interface Rodada {
        ctx: ContextoExecucaoMultiagente;
        r: ResultadoMultiagente;
        pedidos: PedidoPlanner[];
        fragmentos: number;
    }

    /**
     * Roda `decodificar` em modo multiagente com um Planner que devolve `saidas`
     * em ordem (a ultima se repete, se o laco pedir mais — o que os testes
     * acusam pela contagem).
     */
    async function rodar(
        saidas: string[],
        opcoes: {
            orcamento?: string;
            telemetria?: Record<string, number>;
            pedido?: string;
            regras?: RegraValidada[];
            politica?: (p: SubgrafoPodado) => SubgrafoPodado;
        } = {}
    ): Promise<Rodada> {
        const cenario = { ...CENARIO, telemetria: opcoes.telemetria ?? TELEMETRIA, intencao: opcoes.pedido ?? PEDIDO };
        const constraints = retrieveConstraints(modelo, cenario);
        const base = pruningPayload(constraints, cenario);
        const politica = opcoes.politica ? opcoes.politica(base) : base;
        const auditoria = auditoriaVazia('deterministica', 'med', cenario.intencao, `req-retry-${recebidas.length}-${Math.random()}`);
        auditoria.validacao = opcoes.regras ?? [];
        const conhecimento: ConhecimentoRecuperado<RetrievedConstraints> = {
            constraints, foco: null, auditoriaRecuperacao: auditoria, poda: politica, politicaEfetiva: politica,
            promptSemantico: montarPromptSemantico(constraints, cenario, politica)
        };

        const pedidos: PedidoPlanner[] = [];
        const planner: MotorPlanner = async pedido => {
            pedidos.push(pedido);
            return { saida: saidas[Math.min(pedidos.length, saidas.length) - 1], tokens_prompt: 1000 + pedidos.length };
        };
        let fragmentos = 0;
        const motor: MotorFragmento = async () => {
            fragmentos++;
            return { fragmento: '', encerrou: true };
        };

        process.env.SPC_CML_DECODIFICACAO = 'multiagente';
        if (opcoes.orcamento === undefined) delete process.env.SPC_CML_MAX_TENTATIVAS_PLANNER;
        else process.env.SPC_CML_MAX_TENTATIVAS_PLANNER = opcoes.orcamento;
        try {
            const entrada = montarEntradaGeracao(cenario, constraints, modelo, politica, conhecimento);
            // O PI Agent e um duble que obedece: aqui so o laco do Planner esta em teste.
            const r = (await decodificar({
                ...entrada, endpoint: URL_FALSA, motor, motorPlanner: planner, motorPIAgent: piAgentQueObedece(),
                verificadorGramatical: verificadorQueAceita()
            })) as ResultadoMultiagente;
            return { ctx: r.execucao, r, pedidos, fragmentos };
        } finally {
            for (const [chave, valor] of [['SPC_CML_DECODIFICACAO', originais.modo], ['SPC_CML_MAX_TENTATIVAS_PLANNER', originais.planner]] as const) {
                if (valor === undefined) delete process.env[chave];
                else process.env[chave] = valor;
            }
        }
    }

    const caminho = (ctx: ContextoExecucaoMultiagente): string[] => ctx.historicoStatus.map(t => t.para);
    /** Nenhum caminho usa o incremental nem a monolitica: nem fragmento, nem HTTP. */
    const semAcao = (x: Rodada): void => {
        assert.equal(x.fragmentos, 0, 'nenhum fragmento gerado (incremental)');
        assert.deepEqual(recebidas, [], 'nenhuma requisicao HTTP (monolitica / generate-fragment)');
    };

    // =========================================================================
    console.log('\nCasos do retry');
    // =========================================================================

    // A sequencia valida segue para o Decompositor, os PI Agents (duble), a
    // composicao e a validacao global, e termina em COMPLETED: o numero de
    // chamadas ao PLANNER e o que se conta.
    const DEPOIS_DA_SEQUENCIA = [
        'PI_DECOMPOSING', 'PI_DECOMPOSED', 'PI_EXECUTING', 'PI_VALIDATING', 'PI_EXECUTING', 'PI_VALIDATING', 'PI_ALL_VALID',
        'COMPOSING', 'GLOBAL_VALIDATING', 'COMPLETED'
    ];
    await teste('caso F — valida na primeira: exatamente 1 chamada, SEQUENCE_VALID e decomposicao', async () => {
        const x = await rodar([VALIDO]);
        assert.equal(x.pedidos.length, 1);
        assert.equal(x.ctx.status, 'COMPLETED');
        assert.deepEqual(caminho(x.ctx), [
            'KNOWLEDGE_RETRIEVED', 'SEMANTIC_PROMPT_READY', 'PLANNING', 'SEQUENCE_VALIDATING', 'SEQUENCE_VALID',
            ...DEPOIS_DA_SEQUENCIA
        ]);
        assert.equal(x.ctx.contextosPI!.length, 2);
        assert.equal(x.ctx.sequenciaValidada!.length, 2);
        assert.deepEqual(incoerenciasDoContexto(x.ctx), []);
        semAcao(x);
    });

    await teste('caso A — invalida, depois valida: exatamente 2 chamadas e SEQUENCE_VALID', async () => {
        const x = await rodar([INCOMPATIVEL, VALIDO]);
        assert.equal(x.pedidos.length, 2);
        assert.equal(x.ctx.status, 'COMPLETED');
        assert.deepEqual(caminho(x.ctx), [
            'KNOWLEDGE_RETRIEVED', 'SEMANTIC_PROMPT_READY',
            'PLANNING', 'SEQUENCE_VALIDATING', 'PLANNING', 'SEQUENCE_VALIDATING', 'SEQUENCE_VALID',
            ...DEPOIS_DA_SEQUENCIA
        ]);
        const volta = x.ctx.historicoStatus.find(t => t.de === 'SEQUENCE_VALIDATING' && t.para === 'PLANNING')!;
        assert.match(volta.motivo!, /item_conduta_incompativel/);
        semAcao(x);
    });

    await teste('caso B — invalida, invalida, valida: exatamente 3 chamadas e SEQUENCE_VALID', async () => {
        const x = await rodar([INCOMPATIVEL, SEM_OBRIGATORIA, VALIDO]);
        assert.equal(x.pedidos.length, 3);
        assert.equal(x.ctx.status, 'COMPLETED');
        assert.ok(caminho(x.ctx).includes('SEQUENCE_VALID'));
        assert.deepEqual(x.ctx.tentativasPlanner.map(t => t.validacao.veredito), ['INVALID', 'INVALID', 'VALID']);
        assert.deepEqual(codigos(x.ctx.tentativasPlanner[1].validacao), ['escalonamento_ignorado']);
        semAcao(x);
    });

    await teste('caso C — tres invalidas: exatamente 3 chamadas e UNRESOLVED; nao ha quarta', async () => {
        const x = await rodar([INCOMPATIVEL, SEM_OBRIGATORIA, FORA_DO_PEDIDO, VALIDO]);
        assert.equal(x.pedidos.length, 3, 'o orcamento padrao e 3');
        assert.equal(x.ctx.status, 'UNRESOLVED');
        assert.deepEqual(caminho(x.ctx).slice(-2), ['SEQUENCE_VALIDATING', 'UNRESOLVED']);
        assert.equal(x.ctx.sequenciaValidada, undefined);
        const ultimo = x.ctx.errosValidacao[x.ctx.errosValidacao.length - 1];
        assert.equal(ultimo.veredito, 'UNRESOLVED');
        assert.deepEqual(ultimo.avisos.map(a => a.codigo), ['orcamento_esgotado']);
        assert.match(ultimo.promptRecomendado!, /REJEITADO/, 'o feedback que iria para a quarta fica preservado');
        assert.deepEqual(x.ctx.errosValidacao.slice(0, 3).map(e => e.veredito), ['INVALID', 'INVALID', 'INVALID']);
        assert.match(x.ctx.historicoStatus[x.ctx.historicoStatus.length - 1].motivo!, /orcamento do Planner esgotado \(3\/3\)/);
        semAcao(x);
    });

    await teste('caso D — saida fora do protocolo entra no laco: feedback de protocolo e nova proposta', async () => {
        const x = await rodar([LIVRE, VALIDO]);
        assert.equal(x.pedidos.length, 2);
        assert.equal(x.ctx.status, 'COMPLETED');
        const [primeira, segunda] = x.ctx.tentativasPlanner;
        assert.equal(primeira.fase, 'protocolo');
        assert.equal(primeira.proposta, LIVRE);
        assert.equal(primeira.sequencia, undefined, 'nada foi garimpado do texto livre');
        assert.deepEqual(codigos(primeira.validacao), ['cabecalho_ausente']);
        assert.match(primeira.realimentacao!, /NAO respeitou o protocolo/);
        assert.ok(primeira.realimentacao!.includes(LIVRE), 'o Planner ve a propria saida');
        assert.equal(segunda.fase, 'semantica');
        semAcao(x);
    });

    await teste('caso E — conhecimento insuficiente antes do plano: UNRESOLVED sem nenhuma chamada', async () => {
        const semEscalar = (p: SubgrafoPodado): SubgrafoPodado =>
            ({ ...p, politicas: p.politicas.map((q: PoliticaItem) => ({ ...q, decisoes: q.decisoes.filter(d => d !== 'ESCALAR_EQUIPE') })) });
        const a = await rodar([VALIDO], { politica: semEscalar });
        assert.equal(a.pedidos.length, 0, 'nao se gasta tentativa com o que nenhuma proposta supre');
        assert.equal(a.ctx.status, 'UNRESOLVED');
        assert.deepEqual(caminho(a.ctx).slice(-2), ['PLANNING', 'UNRESOLVED']);
        assert.deepEqual(a.ctx.errosValidacao[0].dadosFaltantes, ['item que realize Acionar_Equipe']);

        const b = await rodar([VALIDO], {
            pedido: 'e a heparina?',
            politica: p => ({ ...p, politicas: p.politicas.map(q => (q.item === 'Heparina' ? { ...q, decisoes: ['SUBSTITUIR'] } : q)) })
        });
        assert.equal(b.pedidos.length, 0);
        assert.equal(b.ctx.status, 'UNRESOLVED');
        assert.deepEqual(b.ctx.errosValidacao[0].dadosFaltantes, ['conduta para Heparina']);
    });

    await teste('caso E — telemetria insuficiente para o par proposto: UNRESOLVED depois de 1 chamada, sem retry', async () => {
        const { PAM: _, ...semPam } = TELEMETRIA;
        const x = await rodar(
            ['PLANO 1 | Propofol | Titular_Vasopressor | [ ] 2 | Noradrenalina | Acionar_Equipe | [ ] FIM', VALIDO],
            { telemetria: semPam, regras: [regraSemMedida('Propofol', 'PAM')] }
        );
        assert.equal(x.pedidos.length, 1, 'outra proposta nao traria a medida que falta');
        assert.equal(x.ctx.status, 'UNRESOLVED');
        assert.deepEqual(caminho(x.ctx).slice(-2), ['SEQUENCE_VALIDATING', 'UNRESOLVED']);
        const v = x.ctx.tentativasPlanner[0].validacao;
        assert.deepEqual(v.dadosFaltantes, ['telemetria.PAM']);
        assert.match(v.promptRecomendado!, /CONHECIMENTO INSUFICIENTE/);
    });

    // =========================================================================
    console.log('\nOrcamento');
    // =========================================================================

    await teste('o orcamento vem de SPC_CML_MAX_TENTATIVAS_PLANNER: 1 e 2 chamadas, nunca mais', async () => {
        const um = await rodar([INCOMPATIVEL, VALIDO], { orcamento: '1' });
        assert.equal(um.pedidos.length, 1);
        assert.equal(um.ctx.status, 'UNRESOLVED');
        const dois = await rodar([INCOMPATIVEL, SEM_OBRIGATORIA, VALIDO], { orcamento: '2' });
        assert.equal(dois.pedidos.length, 2);
        assert.equal(dois.ctx.status, 'UNRESOLVED');
        assert.match(dois.ctx.historicoStatus[dois.ctx.historicoStatus.length - 1].motivo!, /2\/2/);
    });

    // =========================================================================
    console.log('\nMaquina de estados');
    // =========================================================================

    await teste('SEQUENCE_VALIDATING -> PLANNING so com a ultima proposta INVALID e orcamento sobrando', () => {
        const ctx = novoContextoExecucao({ dominio: 'med', pedido: 'p', contexto: CENARIO, requestId: 'g', orcamento: { ...ORCAMENTO_PADRAO, planner: 2 } });
        const constraints = retrieveConstraints(modelo, CENARIO);
        const p = pruningPayload(constraints, CENARIO);
        const auditoria = auditoriaVazia('deterministica', 'med', 'p', 'g');
        registrarConhecimento(ctx, { constraints, foco: null, auditoriaRecuperacao: auditoria, poda: p, politicaEfetiva: p, promptSemantico: 'x' });
        avancarStatus(ctx, 'PLANNING');
        assert.throws(() => avancarStatus(ctx, 'PLANNING'), /PLANNING -> PLANNING/, 'nunca de PLANNING para PLANNING');
        avancarStatus(ctx, 'SEQUENCE_VALIDATING');
        assert.match(impedimentoDeReplanejar(ctx)!, /nenhuma proposta/);

        const reprovada = invalido<PIPlanejado[]>([{ codigo: 'item_conduta_incompativel', mensagem: 'x' }]);
        ctx.tentativasPlanner.push({ ciclo: 1, tentativa: 1, proposta: '', validacao: reprovada });
        assert.equal(impedimentoDeReplanejar(ctx), undefined);
        avancarStatus(ctx, 'PLANNING');
        avancarStatus(ctx, 'SEQUENCE_VALIDATING');

        ctx.tentativasPlanner.push({ ciclo: 1, tentativa: 2, proposta: '', validacao: reprovada });
        assert.throws(() => avancarStatus(ctx, 'PLANNING'), /orcamento do Planner esgotado \(2\/2\)/);
        assert.equal(ctx.status, 'SEQUENCE_VALIDATING', 'a recusa nao muda o status');

        ctx.tentativasPlanner[1] = { ciclo: 1, tentativa: 2, proposta: '', validacao: valido<PIPlanejado[]>([]) };
        assert.throws(() => avancarStatus(ctx, 'PLANNING'), /so uma sequencia INVALID volta ao Planner/);
    });

    // =========================================================================
    console.log('\nHistorico, feedback e restricao');
    // =========================================================================

    await teste('cada tentativa fica: numero, prompt, saida, sequencia, validacao, fase, metricas', async () => {
        const x = await rodar([INCOMPATIVEL, SEM_OBRIGATORIA, VALIDO]);
        const ts = x.ctx.tentativasPlanner;
        assert.deepEqual(ts.map(t => [t.ciclo, t.tentativa]), [[1, 1], [1, 2], [1, 3]]);
        assert.deepEqual(ts.map(t => t.proposta), [INCOMPATIVEL, SEM_OBRIGATORIA, VALIDO]);
        assert.deepEqual(ts.map(t => t.prompt), x.pedidos.map(p => p.prompt), 'o prompt registrado e o enviado');
        assert.deepEqual(ts.map(t => t.metricas?.tokensPrompt), [1001, 1002, 1003]);
        assert.ok(ts.every(t => t.fase === 'semantica' && t.sequencia && typeof t.metricas?.duracaoValidacaoMs === 'number'));
        assert.deepEqual(ts.map(t => t.metricas?.caracteresFeedback), [undefined, ts[0].realimentacao!.length, ts[1].realimentacao!.length]);
        assert.equal(ts[2].realimentacao, undefined);
    });

    await teste('o feedback semantico traz o plano anterior, o erro por PI, a regra, a evidencia e o permitido', async () => {
        const x = await rodar([INCOMPATIVEL, VALIDO]);
        const fb = x.ctx.tentativasPlanner[0].realimentacao!;
        assert.match(fb, /REJEITADO pela validacao contra o conhecimento/);
        assert.ok(fb.includes(`plano anterior: ${INCOMPATIVEL}`), 'o plano anterior, no proprio protocolo');
        assert.match(fb, /PI 1 \(Propofol -> Titular_Vasopressor\):/);
        assert.match(fb, /item_conduta_incompativel/);
        assert.match(fb, /regra: Titular_Vasopressor exige AUMENTAR_VAZAO/);
        assert.match(fb, /evidencia: .*PAM 52 < 60/);
        assert.match(fb, /condutas que Propofol pode cumprir: /);
        assert.match(fb, /escalonamento_ignorado: falta um PI com a conduta Acionar_Equipe/);
        assert.match(fb, /itens que podem cumprir Acionar_Equipe: /);
        assert.match(fb, /Gere novamente SOMENTE a sequencia de PIs\.\nNao produza acoes ou justificativas\./);
        assert.ok(!/NAO respeitou o protocolo/.test(fb), 'o feedback semantico e outro texto');
    });

    await teste('o segundo prompt e o primeiro mais a secao de feedback — nada alem disso', async () => {
        const x = await rodar([INCOMPATIVEL, VALIDO]);
        const [p1, p2] = x.pedidos.map(p => p.prompt);
        const fb = x.ctx.tentativasPlanner[0].realimentacao!;
        assert.ok(!p1.includes('[FEEDBACK DA VALIDACAO ANTERIOR]'));
        assert.equal(p2, p1.replace('\n\nformato:', `\n\n[FEEDBACK DA VALIDACAO ANTERIOR]\n${fb}\n\nformato:`));
    });

    await teste('restricao progressiva: so o item com par reprovado e amarrado, as condutas que ele realiza', async () => {
        const x = await rodar([INCOMPATIVEL, SEM_OBRIGATORIA, VALIDO]);
        const contrato = montarContrato(
            pruningPayload(retrieveConstraints(modelo, CENARIO), CENARIO), condutasPorDecisaoMed(modelo), []
        );
        assert.equal(x.pedidos[0].condutas_por_item, undefined, 'a primeira tentativa vai sem restricao');
        assert.deepEqual(x.pedidos[1].condutas_por_item, { Propofol: condutasDoItem(contrato, 'Propofol') });
        assert.ok(!x.pedidos[1].condutas_por_item!.Propofol.includes('Titular_Vasopressor'));
        // A 2a so reprovou por obrigatoria ausente: nenhum item novo e restringido, e o de antes continua.
        assert.deepEqual(x.pedidos[2].condutas_por_item, x.pedidos[1].condutas_por_item);
        // Os itens candidatos e as condutas do vocabulario nao mudam.
        assert.deepEqual(x.pedidos[1].itens, x.pedidos[0].itens);
        assert.deepEqual(x.pedidos[1].condutas, x.pedidos[0].condutas);
    });

    servidor.closeAllConnections();
    servidor.close();
    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
