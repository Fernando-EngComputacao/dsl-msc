/**
 * PI Agent: um PI de ponta a ponta — contexto -> Qwen (duble) -> acao +
 * justificativa -> validacao individual -> retry SO daquele PI.
 *
 * O que se cobra, antes de tudo:
 *   - o parser le o protocolo ou recusa: PI, item, conduta ou ordem trocados,
 *     decisao ou meio desconhecidos, valor fora do formato, mais de uma acao,
 *     texto livre — nada e corrigido nem aproximado;
 *   - a validacao e deterministica e so usa o contexto do PI: decisao da
 *     conduta e admissivel, meio, valor por decisao, telemetria, pedido e uma
 *     justificativa que so afirma o que o contexto sustenta;
 *   - o retry e do PI que falhou, dentro de `orcamento.porPI`, com feedback e
 *     restricao progressiva; nenhum outro PI e regenerado nem alterado;
 *   - com um `ResultadoPI` valido por PI, a execucao passa por PI_ALL_VALID e
 *     segue para a composicao e a validacao global (cobertas em
 *     `validacao-global.test.ts`).
 *
 * Roda OFFLINE: modelo da DSL e recuperacao deterministica reais; o Planner e o
 * PI Agent sao dubles (ou um motor falso HTTP que registra toda requisicao).
 */

import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

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
import { montarContrato, type ContratoArtefato } from '../knowledge/contrato.js';
import type { PIPlanejado, ResultadoPI } from '../knowledge/contrato-pi.js';
import { comoDadoPuro, decomporPIs, type ConhecimentoDaDecomposicao } from '../knowledge/decompositor.js';
import type { ContextoGeracaoItem } from '../knowledge/item-geracao.js';
import type { EsquemaDeclarado, SubgrafoPodado } from '../knowledge/politica.js';
import type { RegraValidada } from '../knowledge/recuperacao-cypher.js';
import { auditoriaVazia } from '../knowledge/recuperacao-hibrida.js';
import type { ResultadoValidacao } from '../knowledge/validacao.js';
import { validarSequencia } from '../knowledge/validacao-sequencia.js';
import { decisoesCitadasNoPedido, restringirAposErrosPI, validarPI } from '../knowledge/validacao-pi.js';
import { montarEntradaGeracao, montarPromptSemantico } from '../inference/llm-client.js';
import {
    decodificar,
    motorPIAgentHttp,
    type MotorFragmento,
    type ResultadoMultiagente
} from '../inference/decodificacao.js';
import {
    ORCAMENTO_PADRAO,
    avancarStatus,
    decomporSequencia,
    incoerenciasDoContexto,
    novoContextoExecucao,
    registrarConhecimento,
    resumoExecucao,
    type ContextoExecucaoMultiagente
} from '../inference/multiagente.js';
import {
    executarPI,
    lerSaidaPIAgent,
    montarPromptPIAgent,
    resolverPIs,
    type MotorPIAgent,
    type PedidoPIAgent
} from '../inference/pi-agent.js';
import type { MotorPlanner } from '../inference/planner.js';
import type { ConhecimentoRecuperado } from '../inference/recuperacao-conhecimento.js';
import { RESPOSTA_VERIFY, piAgentQueObedece, piAgentRoteirizado, saidaPI, verificadorQueAceita } from './dubles-pi-agent.js';

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

/** O cenario de referencia do projeto: choque, renal cronico, tres farmacos em curso. */
const CENARIO: ClinicalContext = {
    paciente: 'PT-TESTE-0001',
    intencao: 'A pressao ta despencando (PAM=52), sobe a nora e aprofunda o propofol',
    telemetria: { PAM: 52, FC: 145, lactato: 4.8, RASS: 2, TFG: 28, plaquetas: 45, glicemia: 210 },
    populacoes: ['Renal_Cronico'],
    farmacosEmUso: ['Noradrenalina', 'Propofol', 'Vancomicina']
};

const PI_PROPOFOL: PIPlanejado = { ordem: 1, item: 'Propofol', conduta: 'Manter_Bloqueio', dependeDe: [] };
const PI_NORA: PIPlanejado = { ordem: 2, item: 'Noradrenalina', conduta: 'Acionar_Equipe', dependeDe: [1] };
const PLANO_2 = 'PLANO 1 | Propofol | Manter_Bloqueio | [ ] 2 | Noradrenalina | Acionar_Equipe | [ 1 ] FIM';
const PLANO_3 = 'PLANO 1 | Propofol | Manter_Bloqueio | [ ] 2 | Noradrenalina | Acionar_Equipe | [ 1 ] 3 | Vancomicina | Solicitar_Exame_Controle | [ ] FIM';

/** A saida que o duble produziria para um contexto, com os campos trocados. */
function linha(c: ContextoGeracaoItem, campos: Parameters<typeof saidaPI>[1] = {}): string {
    return saidaPI({ prompt: montarPromptPIAgent(c), subgrafo_regras: c.subgrafoDoItem, ordem: c.pi!.ordem, conduta: c.pi!.conduta }, campos);
}

/** Um ResultadoPI direto, para testar a validacao sem passar pelo parser. */
function resultado(c: ContextoGeracaoItem, decisao: string, valor: string, unidade: string, meio: string, justificativa: string): ResultadoPI {
    return { ordem: c.pi!.ordem, item: c.pi!.item, conduta: c.pi!.conduta, acao: { decisao, meio, valor: { valor, unidade } }, justificativa };
}

/** Uma saida que respeita o protocolo e o contexto, mas com justificativa sem evidencia: INVALID na validacao. */
const semSuporte = (p: PedidoPIAgent): string => saidaPI(p, { justificativa: 'Conforme solicitado pelo plantao' });

function regraSemMedida(item: string, campo: string): RegraValidada {
    return {
        regraId: `Farmaco:${item}/RegraSeguranca/${campo}>2`, tipo: 'RegraSeguranca', relacao: 'BLOQUEIA_INCREMENTO',
        item, dominio: 'med', aplicavel: false, condicoesSatisfeitas: [], condicoesFalhas: [],
        lacunas: [{ campo, esperado: '> 2 mg/dL', motivo: `o cenario nao mediu '${campo}'` }],
        evidencia: {}, validacaoCypher: { valida: false, motivo: 'sem evidencia', consulta: '' }, efeito: {},
        rag: { candidatoId: `Farmaco:${item}`, escore: 0.9, cosseno: 0.8, papel: 'item', posicao: 0 }
    };
}

async function main(): Promise<void> {
    const modelo = await loadModel(path.join('src', 'examples', 'med', 'uti.dsl'));
    const constraints = retrieveConstraints(modelo, CENARIO);
    const poda = pruningPayload(constraints, CENARIO);
    const escalonamentos = constraints.escalonamentos.map(e => `${e.destino}: ${e.detalhe}`);
    const mapa = condutasPorDecisaoMed(modelo);
    const contrato = montarContrato(poda, mapa, escalonamentos, esquemaDeDadosMed(modelo));
    const esquema = esquemaDeclaradoMed(modelo);
    const promptSemantico = montarPromptSemantico(constraints, CENARIO, poda);

    const conhecimento = (extra: Partial<ConhecimentoDaDecomposicao> = {}): ConhecimentoDaDecomposicao => ({
        requestId: 'req-pi', dominio: 'med', pedido: CENARIO.intencao!, telemetria: CENARIO.telemetria,
        contrato, politica: poda, regras: [], restricoes: constraints, esquema, ...extra
    });
    const k = conhecimento();
    const [cProp, cNora] = decomporPIs([PI_PROPOFOL, PI_NORA], k);
    const [cVanco] = decomporPIs([{ ordem: 1, item: 'Vancomicina', conduta: 'Titular_Vasopressor', dependeDe: [] }], k);

    // Uma conduta sintetica que se realiza por TRES decisoes — as DSLs reais tem
    // uma decisao por conduta, e e com mais de uma que pedido x decisao e a
    // telemetria de uma decisao bloqueada deixam de ser triviais.
    const mapaAjuste = { ...mapa, AUMENTAR_VAZAO: 'Ajustar_Infusao', REDUZIR_VAZAO: 'Ajustar_Infusao', MANTER_VAZAO: 'Ajustar_Infusao' };
    const contratoAjuste = montarContrato(poda, mapaAjuste, escalonamentos, esquemaDeDadosMed(modelo));
    const esquemaAjuste: EsquemaDeclarado = { ...esquema, condutas: { ...esquema.condutas, Ajustar_Infusao: { justificativa_obrigatoria: 'sim' } } };
    const PEDIDO_REDUZIR = 'reduzir o propofol agora';
    const kAjuste = conhecimento({ contrato: contratoAjuste, esquema: esquemaAjuste, pedido: PEDIDO_REDUZIR });
    const [cAjuste] = decomporPIs([{ ordem: 1, item: 'Propofol', conduta: 'Ajustar_Infusao', dependeDe: [] }], kAjuste);
    /** A mesma conduta sintetica com o pedido de referencia, que nao nomeia decisao. */
    const [cAjusteRef] = decomporPIs([{ ordem: 1, item: 'Propofol', conduta: 'Ajustar_Infusao', dependeDe: [] }], { ...kAjuste, pedido: CENARIO.intencao! });

    const VALIDA =
        "PI 1 | Manter_Bloqueio | ordem Propofol decisao MANTER_BLOQUEADO dose 0.0 mg/kg/h via ACESSO_CENTRAL " +
        "justificativa 'PAM 52 < 60 mmHg: incremento bloqueado' FIM";

    // =========================================================================
    console.log('\nParser da saida do PI Agent');
    // =========================================================================

    await teste('pre-condicao: os contextos usados sao os que o texto supoe', () => {
        assert.deepEqual(cProp.decisoes.admissiveis, ['MANTER_BLOQUEADO']);
        assert.deepEqual(cProp.valores.porDecisao.MANTER_BLOQUEADO, [{ valor: '0.0', unidade: 'mg/kg/h' }]);
        assert.deepEqual(cProp.meios.admissiveis, ['ACESSO_CENTRAL', 'ACESSO_PERIFERICO']);
        assert.ok(cProp.meios.foraDoItem.includes('INTRAOSSEO'));
        assert.deepEqual(cAjuste.decisoes.admissiveis, ['REDUZIR_VAZAO', 'MANTER_VAZAO']);
        assert.ok(cAjuste.decisoes.bloqueadas.includes('AUMENTAR_VAZAO'));
        assert.ok(cVanco.decisoes.admissiveis.includes('AUMENTAR_VAZAO'));
    });

    await teste('casos 1-5 — PI valido: decisao, meio, valor e justificativa lidos exatamente, no ResultadoPI existente', () => {
        const r = lerSaidaPIAgent(VALIDA, cProp);
        assert.equal(r.veredito, 'VALID', JSON.stringify(r.erros));
        assert.deepEqual(r.valor, {
            ordem: 1, item: 'Propofol', conduta: 'Manter_Bloqueio',
            acao: { decisao: 'MANTER_BLOQUEADO', meio: 'ACESSO_CENTRAL', valor: { valor: '0.0', unidade: 'mg/kg/h' } },
            justificativa: 'PAM 52 < 60 mmHg: incremento bloqueado'
        });
        // So espaco nas pontas e quebra de linha entre campos sao tolerados.
        assert.equal(lerSaidaPIAgent(`  ${VALIDA.replace(' via ', '\nvia ')}\n`, cProp).veredito, 'VALID');
        // Decisao CONHECIDA mas nao admissivel passa a leitura: e da validacao.
        assert.equal(lerSaidaPIAgent(VALIDA.replace('MANTER_BLOQUEADO', 'AUMENTAR_VAZAO'), cProp).veredito, 'VALID');
    });

    await teste('casos 6-8 — item, conduta ou ordem alterados: pi_divergente, nada e corrigido', () => {
        for (const [saida, campo] of [
            [VALIDA.replace('ordem Propofol', 'ordem Noradrenalina'), /o item nao e do PI Agent/],
            [VALIDA.replace('| Manter_Bloqueio |', '| Titular_Vasopressor |'), /a conduta nao e do PI Agent/],
            [VALIDA.replace('PI 1 |', 'PI 2 |'), /a ordem nao e do PI Agent/]
        ] as const) {
            const r = lerSaidaPIAgent(saida, cProp);
            assert.deepEqual(codigos(r), ['pi_divergente'], saida);
            assert.match(r.erros[0].mensagem, campo);
        }
    });

    await teste('casos 9-11 — decisao inexistente, meio inexistente, valor fora do formato: recusados', () => {
        assert.deepEqual(codigos(lerSaidaPIAgent(VALIDA.replace('MANTER_BLOQUEADO', 'TURBINAR_INFUSAO'), cProp)), ['decisao_desconhecida']);
        assert.deepEqual(codigos(lerSaidaPIAgent(VALIDA.replace('manter_bloqueado', 'x').replace('MANTER_BLOQUEADO', 'manter_bloqueado'), cProp)), ['decisao_desconhecida'], 'caixa diferente nao e aproximada');
        assert.deepEqual(codigos(lerSaidaPIAgent(VALIDA.replace('ACESSO_CENTRAL', 'VEIA_MAGICA'), cProp)), ['meio_desconhecido']);
        assert.deepEqual(codigos(lerSaidaPIAgent(VALIDA.replace('dose 0.0', 'dose 0,0'), cProp)), ['valor_invalido']);
        assert.deepEqual(codigos(lerSaidaPIAgent(VALIDA.replace('dose 0.0', 'dose zero'), cProp)), ['valor_invalido']);
    });

    await teste('caso 12 — multiplas decisoes ou alternativas: recusadas', () => {
        assert.deepEqual(codigos(lerSaidaPIAgent(VALIDA.replace('decisao MANTER_BLOQUEADO', 'decisao MANTER_BLOQUEADO e REDUZIR_VAZAO'), cProp)), ['multiplas_acoes']);
        assert.deepEqual(codigos(lerSaidaPIAgent(VALIDA.replace('decisao MANTER_BLOQUEADO', 'decisao MANTER_BLOQUEADO ou SUSPENDER'), cProp)), ['multiplas_acoes']);
        const duas = VALIDA.replace(' FIM', " ordem Propofol decisao SUSPENDER dose 0.0 mg/kg/h via ACESSO_CENTRAL justificativa 'x' FIM");
        assert.deepEqual(codigos(lerSaidaPIAgent(duas, cProp)), ['multiplas_acoes']);
        assert.deepEqual(codigos(lerSaidaPIAgent(`${VALIDA} ${VALIDA.replace('PI 1', 'PI 2')}`, cProp)), ['multiplos_pis']);
        // Palavra-chave dentro da justificativa nao e segunda acao.
        assert.equal(lerSaidaPIAgent(VALIDA.replace("'PAM 52", "'decisao de ordem: PAM 52"), cProp).veredito, 'VALID');
    });

    await teste('caso 13 — saida livre e markdown: recusados, nada e garimpado', () => {
        assert.deepEqual(codigos(lerSaidaPIAgent('Mantenha o propofol bloqueado porque a PAM caiu.', cProp)), ['cabecalho_ausente']);
        assert.deepEqual(codigos(lerSaidaPIAgent('```\n' + VALIDA + '\n```', cProp)), ['cabecalho_ausente']);
        assert.deepEqual(codigos(lerSaidaPIAgent(`${VALIDA}\nEspero ter ajudado.`, cProp)), ['terminador_ausente']);
        assert.deepEqual(codigos(lerSaidaPIAgent('   ', cProp)), ['saida_vazia']);
    });

    await teste('caso 14 — campo ausente, justificativa vazia ou com aspa: recusados', () => {
        assert.deepEqual(codigos(lerSaidaPIAgent(VALIDA.replace(' via ACESSO_CENTRAL', ''), cProp)), ['campo_ausente']);
        assert.deepEqual(codigos(lerSaidaPIAgent(VALIDA.replace(' dose 0.0 mg/kg/h', ''), cProp)), ['campo_ausente']);
        assert.deepEqual(codigos(lerSaidaPIAgent(VALIDA.replace(/'[^']*'/, "''"), cProp)), ['justificativa_ausente']);
        assert.deepEqual(codigos(lerSaidaPIAgent(VALIDA.replace('PAM 52', "PAM d'agua 52"), cProp)), ['acao_malformada']);
    });

    // =========================================================================
    console.log('\nValidacao individual');
    // =========================================================================

    const SUPORTADA = 'PAM 52 < 60 mmHg: incremento bloqueado, Propofol mantido';

    await teste('caso 15 — decisao admissivel com justificativa suportada: VALID, o proprio resultado', () => {
        const r = resultado(cProp, 'MANTER_BLOQUEADO', '0.0', 'mg/kg/h', 'ACESSO_CENTRAL', SUPORTADA);
        const v = validarPI(r, cProp);
        assert.equal(v.veredito, 'VALID', JSON.stringify(v.erros));
        assert.deepEqual(v.valor, r);
        assert.deepEqual(avisos(v), ['pedido_indeterminado'], 'o pedido cita o Propofol mas nao nomeia decisao: nada se conclui');
    });

    await teste('caso 16 — decisao nao admissivel (vetada, sem medida): decisao_inadmissivel com os motivos', () => {
        // Midazolam esta vetado pelo protocolo: so retirada e escalonamento sobram.
        const mapaMisto = { ...mapa, ESCALAR_EQUIPE: 'Conduta_Mista', MANTER_VAZAO: 'Conduta_Mista' };
        const kMisto = conhecimento({ contrato: montarContrato(poda, mapaMisto, escalonamentos), esquema: { ...esquema, condutas: { ...esquema.condutas, Conduta_Mista: {} } } });
        const [cMid] = decomporPIs([{ ordem: 1, item: 'Midazolam', conduta: 'Conduta_Mista', dependeDe: [] }], kMisto);
        assert.deepEqual(cMid.decisoes.admissiveis, ['ESCALAR_EQUIPE']);
        const valor = cMid.valores.porDecisao.ESCALAR_EQUIPE?.[0] ?? cMid.valores.gerais[0];
        const v = validarPI(resultado(cMid, 'MANTER_VAZAO', valor.valor, valor.unidade, cMid.meios.admissiveis[0], 'vetado pelo protocolo'), cMid);
        assert.deepEqual(codigos(v), ['decisao_inadmissivel']);
        assert.ok(v.erros[0].evidencias!.some(e => /vetado por protocolo Sedacao_Analgesia_VM/.test(e)));
        assert.deepEqual(v.erros[0].alternativas, ['ESCALAR_EQUIPE']);
    });

    await teste('casos 17-18 — meio admissivel passa; meio do dominio fora do item: meio_inadmissivel', () => {
        for (const meio of ['ACESSO_CENTRAL', 'ACESSO_PERIFERICO']) {
            assert.equal(validarPI(resultado(cProp, 'MANTER_BLOQUEADO', '0.0', 'mg/kg/h', meio, SUPORTADA), cProp).veredito, 'VALID');
        }
        const v = validarPI(resultado(cProp, 'MANTER_BLOQUEADO', '0.0', 'mg/kg/h', 'INTRAOSSEO', SUPORTADA), cProp);
        assert.deepEqual(codigos(v), ['meio_inadmissivel']);
        assert.deepEqual(v.erros[0].alternativas, ['ACESSO_CENTRAL', 'ACESSO_PERIFERICO']);
    });

    await teste('casos 19-20 — valor admissivel passa; fora do reticulo e de outra decisao: valor_inadmissivel', () => {
        assert.deepEqual(codigos(validarPI(resultado(cProp, 'MANTER_BLOQUEADO', '0.5', 'mg/kg/h', 'ACESSO_CENTRAL', SUPORTADA), cProp)), ['valor_inadmissivel']);
        // Decisao x valor: um valor que o item admite para OUTRA decisao nao serve a esta.
        const politicaVanco = poda.politicas.find(p => p.item === 'Vancomicina')!;
        const doAumento = politicaVanco.valoresPorDecisao!.AUMENTAR_VAZAO.map(v => `${v.valor} ${v.unidade}`);
        const deOutra = Object.entries(politicaVanco.valoresPorDecisao!)
            .flatMap(([, vs]) => vs).find(v => !doAumento.includes(`${v.valor} ${v.unidade}`));
        assert.ok(deOutra, 'Vancomicina tem valor de outra decisao que nao serve a AUMENTAR_VAZAO');
        const just = 'lactato 4.8 no protocolo Choque_Septico';
        const ok = cVanco.valores.porDecisao.AUMENTAR_VAZAO[0];
        assert.equal(validarPI(resultado(cVanco, 'AUMENTAR_VAZAO', ok.valor, ok.unidade, cVanco.meios.admissiveis[0], just), cVanco).veredito, 'VALID');
        const v = validarPI(resultado(cVanco, 'AUMENTAR_VAZAO', deOutra!.valor, deOutra!.unidade, cVanco.meios.admissiveis[0], just), cVanco);
        assert.deepEqual(codigos(v), ['valor_inadmissivel']);
        assert.match(v.erros[0].regra!, /^AUMENTAR_VAZAO admite /);
    });

    await teste('casos 21-22 — decisao realiza a conduta; decisao de outra conduta do mesmo item: decisao_nao_realiza_conduta', () => {
        // REDUZIR_VAZAO e admissivel para o Propofol, mas realiza Reduzir_Infusao, nao Manter_Bloqueio.
        assert.ok(cProp.decisoes.foraDaConduta.includes('REDUZIR_VAZAO'));
        const v = validarPI(resultado(cProp, 'REDUZIR_VAZAO', '0.0', 'mg/kg/h', 'ACESSO_CENTRAL', SUPORTADA), cProp);
        assert.deepEqual(codigos(v), ['decisao_nao_realiza_conduta']);
        assert.equal(v.erros[0].regra, 'Manter_Bloqueio se realiza por MANTER_BLOQUEADO');
        assert.deepEqual(v.erros[0].reparo, { item: 'Propofol', decisao: 'REDUZIR_VAZAO' });
    });

    await teste('casos 23-24 — telemetria compativel passa; incremento bloqueado pela PAM: telemetria_incompativel com PAM = 52', () => {
        const ok = cVanco.valores.porDecisao.AUMENTAR_VAZAO[0];
        assert.equal(validarPI(resultado(cVanco, 'AUMENTAR_VAZAO', ok.valor, ok.unidade, 'ACESSO_CENTRAL', 'lactato 4.8 no Choque_Septico'), cVanco).veredito, 'VALID');
        const v = validarPI(resultado(cAjusteRef, 'AUMENTAR_VAZAO', '0.0', 'mg/kg/h', 'ACESSO_CENTRAL', 'PAM 52 pede subir'), cAjusteRef);
        assert.deepEqual(codigos(v), ['telemetria_incompativel']);
        assert.ok(v.erros[0].evidencias!.includes('PAM 52 < 60 mmHg'));
        assert.ok(v.erros[0].evidencias!.includes('PAM = 52'));
        assert.deepEqual(v.erros[0].alternativas, ['REDUZIR_VAZAO', 'MANTER_VAZAO']);
        // Com o pedido que nomeia REDUZIR_VAZAO, o mesmo resultado viola as duas coisas — e as duas vao juntas.
        const ambos = validarPI(resultado(cAjuste, 'AUMENTAR_VAZAO', '0.0', 'mg/kg/h', 'ACESSO_CENTRAL', 'PAM 52 pede subir'), cAjuste);
        assert.deepEqual(codigos(ambos), ['telemetria_incompativel', 'pedido_incompativel']);
    });

    await teste('casos 25-26 — justificativa suportada passa; fato inexistente em qualquer forma: INVALID', () => {
        const com = (j: string) => validarPI(resultado(cProp, 'MANTER_BLOQUEADO', '0.0', 'mg/kg/h', 'ACESSO_CENTRAL', j), cProp);
        assert.equal(com(SUPORTADA).veredito, 'VALID');
        assert.equal(com('RASS 2 no protocolo Sedacao_Analgesia_VM; PAM=52 bloqueia o incremento').veredito, 'VALID');
        assert.deepEqual(codigos(com('PAM 70 exige manter o bloqueio')), ['justificativa_valor_inexistente', 'justificativa_telemetria_divergente']);
        assert.deepEqual(codigos(com('PAM 60 exige manter o bloqueio')), ['justificativa_telemetria_divergente'], '60 existe (e o limiar), mas nao e a PAM observada');
        assert.deepEqual(codigos(com('glicemia 300 e PAM 52: manter')), ['justificativa_valor_inexistente']);
        assert.deepEqual(codigos(com('protocolo Controle_Glicemico_UTI com PAM 52')), ['justificativa_referencia_inexistente']);
        assert.deepEqual(codigos(com('regra Farmaco:Propofol/RegraSeguranca/RASS<2 com PAM 52')), ['justificativa_referencia_inexistente']);
        // Visto no Qwen real: o valor certo com a unidade errada.
        assert.deepEqual(codigos(com('PAM 52 mmHg; dose de 0.0 mg/mL')), ['justificativa_referencia_inexistente']);
        assert.equal(com('PAM 52 mmHg; dose de 0.0 mg/kg/h e/ou bloqueio').veredito, 'VALID', 'unidade do contexto e barra sem numero passam');
        // A unidade de uma MEDIDA e julgada contra a da medida (RASS: "RASS 2 > 0 pontos" no contexto).
        assert.equal(com('PAM 52 mmHg e RASS 2 pontos: incremento bloqueado').veredito, 'VALID', 'a unidade da medida no contexto passa');
        assert.deepEqual(codigos(com('PAM 52 mmHg e RASS 2 pontos/escala: incremento bloqueado')), ['justificativa_telemetria_divergente'], 'RASS e medido em pontos');
        const semSup = com('Conforme solicitado pelo plantao');
        assert.deepEqual(codigos(semSup), ['justificativa_sem_suporte']);
        assert.ok(semSup.erros[0].alternativas!.includes('pam'), 'o feedback diz o que pode ser citado');
    });

    await teste('regressao de unidade — a unidade de uma medida e comparada com a DAQUELA medida, nunca com a da acao', () => {
        // cNora: PAM em mmHg, FC em bpm, lactato em mmol/L (evidencias do contexto); acao ESCALAR_EQUIPE 0.0 mcg/kg/min.
        const escalar = cNora.valores.porDecisao.ESCALAR_EQUIPE[0];
        assert.deepEqual(escalar, { valor: '0.0', unidade: 'mcg/kg/min' }, 'pre-condicao');
        const com = (j: string, c: ContextoGeracaoItem = cNora) => validarPI(resultado(c, 'ESCALAR_EQUIPE', escalar.valor, escalar.unidade, 'ACESSO_CENTRAL', j), c);

        // 1. medida valida com a unidade correta
        const certa = com('lactato 4.8 mmol/L e PAM 52 mmHg: escalar a equipe');
        assert.equal(certa.veredito, 'VALID', JSON.stringify(certa.erros));
        assert.equal(com('FC 145 bpm bloqueia o incremento').veredito, 'VALID');
        assert.equal(com('lactato=4.8 mmol/l, PAM: 52 MMHG').veredito, 'VALID', 'caixa ignorada, e as formas = e : tambem');
        // 2. medida valida com unidade diferente da unidade da acao (o falso positivo do Qwen real)
        const outra = com('lactato 4.8 mmol/L com dose 0.0 mcg/kg/min: escalar a equipe');
        assert.equal(outra.veredito, 'VALID', JSON.stringify(outra.erros));
        // 3. valor da acao com unidade incompativel: a protecao continua
        assert.deepEqual(codigos(com('lactato 4.8 mmol/L; dose 0.0 U/mL')), ['justificativa_referencia_inexistente']);
        // 4. valor numerico inexistente no contexto
        assert.deepEqual(codigos(com('lactato 9.9 mmol/L exige a equipe')), ['justificativa_valor_inexistente', 'justificativa_telemetria_divergente']);
        // 5. unidade que nao e a da respectiva medida no contexto
        const trocada = com('lactato 4.8 mg/dL exige a equipe');
        assert.deepEqual(codigos(trocada), ['justificativa_telemetria_divergente']);
        assert.match(trocada.erros[0].mensagem, /lactato em mg\/dL, e o contexto mede lactato em mmol\/l/);
        assert.deepEqual(trocada.erros[0].evidencias, ['lactato: 4.8 mmol/l']);
        assert.deepEqual(codigos(com('PAM 52 bpm exige a equipe')), ['justificativa_telemetria_divergente'], 'bpm existe no contexto, mas e da FC');
        assert.deepEqual(codigos(com('lactato 4.8 mcg/kg/min exige a equipe')), ['justificativa_telemetria_divergente'], 'a unidade da acao nao serve a uma medida');
    });

    await teste('regressao de unidade — medida sem unidade no contexto nao e julgada, nem pela unidade da acao', () => {
        // Uma medida que o contexto do PI traz sem unidade: diurese 0 (anuria). O 0
        // coincide com o valor da acao (0.0), e mL/h nao aparece no contexto — antes
        // era acusada como "valor da acao com unidade trocada".
        const c: ContextoGeracaoItem = { ...cNora, telemetriaRelevante: { ...cNora.telemetriaRelevante, diurese: 0 } };
        assert.ok(!montarPromptPIAgent(c).includes('mL/h'), 'pre-condicao: mL/h fora do contexto');
        const v = validarPI(resultado(c, 'ESCALAR_EQUIPE', '0.0', 'mcg/kg/min', 'ACESSO_CENTRAL', 'lactato 4.8 mmol/L e diurese 0 mL/h: escalar a equipe'), c);
        assert.equal(v.veredito, 'VALID', JSON.stringify(v.erros));
        // Sem o parametro na frente, o mesmo 0 e o valor da acao: a protecao vale.
        const semMedida = validarPI(resultado(c, 'ESCALAR_EQUIPE', '0.0', 'mcg/kg/min', 'ACESSO_CENTRAL', 'lactato 4.8 mmol/L, dose 0 mL/h'), c);
        assert.deepEqual(codigos(semMedida), ['justificativa_referencia_inexistente']);
        // Palavra depois do numero nao e unidade: "no" nao tem barra nem esta no vocabulario do contexto.
        assert.equal(com2('lactato 4.8 no Choque_Septico'), 'VALID');
        function com2(j: string): string {
            return validarPI(resultado(cNora, 'ESCALAR_EQUIPE', '0.0', 'mcg/kg/min', 'ACESSO_CENTRAL', j), cNora).veredito;
        }
    });

    await teste('casos 27-28 — pedido compativel passa; pedido que nomeia outra decisao admissivel: pedido_incompativel', () => {
        assert.deepEqual(decisoesCitadasNoPedido(PEDIDO_REDUZIR, ['REDUZIR_VAZAO', 'MANTER_VAZAO', 'AUMENTAR_VAZAO']), ['REDUZIR_VAZAO']);
        assert.deepEqual(decisoesCitadasNoPedido('reduz o propofol', ['REDUZIR_VAZAO']), [], 'reduz nao e reduzir: nada aproximado');
        const just = 'PAM 52 < 60 mmHg bloqueia o incremento';
        const ok = validarPI(resultado(cAjuste, 'REDUZIR_VAZAO', cAjuste.valores.porDecisao.REDUZIR_VAZAO[0].valor, cAjuste.valores.porDecisao.REDUZIR_VAZAO[0].unidade, 'ACESSO_CENTRAL', just), cAjuste);
        assert.equal(ok.veredito, 'VALID', JSON.stringify(ok.erros));
        const valorManter = (cAjuste.valores.porDecisao.MANTER_VAZAO ?? cAjuste.valores.gerais)[0];
        const v = validarPI(resultado(cAjuste, 'MANTER_VAZAO', valorManter.valor, valorManter.unidade, 'ACESSO_CENTRAL', just), cAjuste);
        assert.deepEqual(codigos(v), ['pedido_incompativel']);
        assert.deepEqual(v.erros[0].alternativas, ['REDUZIR_VAZAO']);
        assert.deepEqual(v.erros[0].reparo, { item: 'Propofol', decisao: 'MANTER_VAZAO' });
    });

    await teste('caso 29 — conhecimento insuficiente: UNRESOLVED, nunca INVALID', () => {
        // Regra que bloquearia o incremento, sem a medida que ela exige.
        const [cVancoH] = decomporPIs([{ ordem: 1, item: 'Vancomicina', conduta: 'Titular_Vasopressor', dependeDe: [] }], conhecimento({ regras: [regraSemMedida('Vancomicina', 'creatinina')] }));
        const ok = cVancoH.valores.porDecisao.AUMENTAR_VAZAO[0];
        const a = validarPI(resultado(cVancoH, 'AUMENTAR_VAZAO', ok.valor, ok.unidade, 'ACESSO_CENTRAL', 'lactato 4.8 no Choque_Septico'), cVancoH);
        assert.equal(a.veredito, 'UNRESOLVED');
        assert.deepEqual(a.dadosFaltantes, ['telemetria.creatinina']);
        assert.ok(avisos(a).includes('telemetria_insuficiente'));

        // Justificativa obrigatoria, e o contexto nao tem evidencia alguma.
        const semEvidencia = comoDadoPuro({ ...cProp, pedido: '', restricoes: [], fatos: [], regras: [], evidencias: [], telemetriaRelevante: {}, regrasRelacionais: [] });
        const b = validarPI(resultado(semEvidencia, 'MANTER_BLOQUEADO', '0.0', 'mg/kg/h', 'ACESSO_CENTRAL', 'Mantido.'), semEvidencia);
        assert.equal(b.veredito, 'UNRESOLVED');
        assert.deepEqual(avisos(b), ['evidencia_insuficiente']);
        assert.deepEqual(b.dadosFaltantes, ['evidencia para justificar MANTER_BLOQUEADO']);
    });

    await teste('requer_dupla_checagem / requer_var: preservados no contexto e no prompt, sem virar regra', () => {
        assert.equal(cProp.conduta!.atributos.requer_dupla_checagem, 'sim');
        assert.match(montarPromptPIAgent(cProp), /Manter_Bloqueio declara requer_dupla_checagem sim/);
        // Nenhum campo novo no resultado, e a validacao nao exige nada por causa dele.
        const r = resultado(cProp, 'MANTER_BLOQUEADO', '0.0', 'mg/kg/h', 'ACESSO_CENTRAL', SUPORTADA);
        assert.deepEqual(Object.keys(validarPI(r, cProp).valor!).sort(), ['acao', 'conduta', 'item', 'justificativa', 'ordem']);
    });

    // =========================================================================
    console.log('\nRestricao progressiva e feedback');
    // =========================================================================

    await teste('restricao progressiva: so a decisao reprovada com evidencia sai; o contexto original nao muda', () => {
        const valorManter = (cAjuste.valores.porDecisao.MANTER_VAZAO ?? cAjuste.valores.gerais)[0];
        const v = validarPI(resultado(cAjuste, 'MANTER_VAZAO', valorManter.valor, valorManter.unidade, 'ACESSO_CENTRAL', 'PAM 52 < 60 mmHg'), cAjuste);
        const antes = JSON.stringify(cAjuste);
        const { contexto, proibidas } = restringirAposErrosPI(cAjuste, v);
        assert.deepEqual(proibidas, ['MANTER_VAZAO']);
        assert.deepEqual(contexto.decisoes.admissiveis, ['REDUZIR_VAZAO']);
        assert.ok(contexto.decisoes.bloqueadas.includes('MANTER_VAZAO'));
        assert.deepEqual(contexto.subgrafoDoItem.politicas[0].decisoes, ['REDUZIR_VAZAO'], 'a gramatica da proxima tentativa nao gera MANTER_VAZAO');
        assert.ok(contexto.restricoes.some(r => /MANTER_VAZAO reprovada pela validacao deste PI \(pedido_incompativel\)/.test(r)));
        assert.equal(JSON.stringify(cAjuste), antes);
        assert.ok(Object.isFrozen(contexto));

        // Erro de valor, de meio ou de justificativa nao e culpa da decisao: nada sai.
        const deValor = validarPI(resultado(cProp, 'MANTER_BLOQUEADO', '0.5', 'mg/kg/h', 'ACESSO_CENTRAL', SUPORTADA), cProp);
        const deTexto = validarPI(resultado(cProp, 'MANTER_BLOQUEADO', '0.0', 'mg/kg/h', 'ACESSO_CENTRAL', 'Conforme solicitado'), cProp);
        for (const x of [deValor, deTexto]) assert.deepEqual(restringirAposErrosPI(cProp, x).proibidas, []);
        // E nunca esvazia o PI: a unica admissivel fica.
        const unica = validarPI(resultado(cProp, 'MANTER_BLOQUEADO', '0.0', 'mg/kg/h', 'ACESSO_CENTRAL', SUPORTADA), cProp);
        const forjada = { ...unica, veredito: 'INVALID' as const, erros: [{ codigo: 'pedido_incompativel', mensagem: 'x', reparo: { item: 'Propofol', decisao: 'MANTER_BLOQUEADO' } }] };
        assert.deepEqual(restringirAposErrosPI(cProp, forjada).proibidas, []);
    });

    // =========================================================================
    console.log('\nRetry por PI (fluxo multiagente, Planner e PI Agent dubles)');
    // =========================================================================

    const originais = { modo: process.env.SPC_CML_DECODIFICACAO, porPI: process.env.SPC_CML_MAX_TENTATIVAS_PI };
    const conhecimentoDe = (id: string): ConhecimentoRecuperado<RetrievedConstraints> => ({
        constraints, foco: null, auditoriaRecuperacao: auditoriaVazia('deterministica', 'med', CENARIO.intencao!, id),
        poda, politicaEfetiva: poda, promptSemantico
    });

    /** Roda `decodificar` em modo multiagente: Planner que devolve `plano`, PI Agent dado. */
    async function fluxo(plano: string, piAgent: MotorPIAgent): Promise<ContextoExecucaoMultiagente> {
        let fragmentos = 0;
        const motor: MotorFragmento = async () => { fragmentos++; return { fragmento: '', encerrou: true }; };
        const planner: MotorPlanner = async () => ({ saida: plano, tokens_prompt: 4000 });
        process.env.SPC_CML_DECODIFICACAO = 'multiagente';
        delete process.env.SPC_CML_MAX_TENTATIVAS_PI;
        try {
            const r = (await decodificar({
                ...montarEntradaGeracao(CENARIO, constraints, modelo, poda, conhecimentoDe(`req-${Math.random()}`)),
                endpoint: 'http://127.0.0.1:9', motor, motorPlanner: planner, motorPIAgent: piAgent,
                verificadorGramatical: verificadorQueAceita()
            })) as ResultadoMultiagente;
            assert.equal(fragmentos, 0, 'nem o incremental nem a monolitica');
            assert.equal(r.resultado, r.execucao.artefatoFinal ?? '', 'o resultado e o artefato final, e so ele');
            return r.execucao;
        } finally {
            for (const [chave, valor] of [['SPC_CML_DECODIFICACAO', originais.modo], ['SPC_CML_MAX_TENTATIVAS_PI', originais.porPI]] as const) {
                if (valor === undefined) delete process.env[chave];
                else process.env[chave] = valor;
            }
        }
    }
    const porOrdem = (chamadas: PedidoPIAgent[]): number[] => chamadas.map(c => c.ordem);
    const caminhoPI = (ctx: ContextoExecucaoMultiagente): string[] =>
        ctx.historicoStatus.slice(ctx.historicoStatus.findIndex(t => t.para === 'PI_DECOMPOSED') + 1).map(t => t.para);

    await teste('caso D — PI valido na primeira: exatamente 1 chamada por PI, PI_ALL_VALID e o plano completo', async () => {
        const chamadas: PedidoPIAgent[] = [];
        const ctx = await fluxo(PLANO_2, piAgentQueObedece(chamadas));
        assert.equal(ctx.status, 'COMPLETED');
        assert.deepEqual(porOrdem(chamadas), [1, 2]);
        assert.deepEqual(caminhoPI(ctx), ['PI_EXECUTING', 'PI_VALIDATING', 'PI_EXECUTING', 'PI_VALIDATING', 'PI_ALL_VALID', 'COMPOSING', 'GLOBAL_VALIDATING', 'COMPLETED']);
        assert.deepEqual(ctx.execucoesPI.map(e => [e.ordem, e.status, e.tentativas.length]), [[1, 'VALID', 1], [2, 'VALID', 1]]);
        assert.deepEqual(incoerenciasDoContexto(ctx), []);
    });

    await teste('caso A — PI 1 INVALID, depois VALID: exatamente 2 chamadas ao PI 1', async () => {
        const chamadas: PedidoPIAgent[] = [];
        const ctx = await fluxo(PLANO_2, piAgentRoteirizado({ 1: [semSuporte] }, chamadas));
        assert.equal(ctx.status, 'COMPLETED');
        assert.deepEqual(porOrdem(chamadas), [1, 1, 2]);
        assert.deepEqual(ctx.execucoesPI[0].tentativas.map(t => t.validacao.veredito), ['INVALID', 'VALID']);
        assert.deepEqual(codigos(ctx.execucoesPI[0].tentativas[0].validacao), ['justificativa_sem_suporte']);
        assert.deepEqual(caminhoPI(ctx), ['PI_EXECUTING', 'PI_VALIDATING', 'PI_EXECUTING', 'PI_VALIDATING', 'PI_EXECUTING', 'PI_VALIDATING', 'PI_ALL_VALID', 'COMPOSING', 'GLOBAL_VALIDATING', 'COMPLETED']);
    });

    await teste('caso B — INVALID, INVALID, VALID: exatamente 3 chamadas ao PI 1', async () => {
        const chamadas: PedidoPIAgent[] = [];
        const ctx = await fluxo(PLANO_2, piAgentRoteirizado({ 1: [semSuporte, 'Mantenha o propofol.'] }, chamadas));
        assert.equal(ctx.status, 'COMPLETED');
        assert.deepEqual(porOrdem(chamadas), [1, 1, 1, 2]);
        assert.deepEqual(ctx.execucoesPI[0].tentativas.map(t => [t.fase, t.validacao.veredito]), [['semantica', 'INVALID'], ['protocolo', 'INVALID'], ['semantica', 'VALID']]);
        assert.match(ctx.execucoesPI[0].tentativas[1].realimentacao!, /NAO respeitou o protocolo do PI Agent/);
    });

    await teste('caso C — INVALID x3: UNRESOLVED, sem quarta chamada e sem tocar o PI 2', async () => {
        const chamadas: PedidoPIAgent[] = [];
        const ctx = await fluxo(PLANO_2, piAgentRoteirizado({ 1: [semSuporte, semSuporte, semSuporte, undefined] }, chamadas));
        assert.equal(ctx.status, 'UNRESOLVED');
        assert.deepEqual(porOrdem(chamadas), [1, 1, 1], 'o orcamento padrao por PI e 3; o PI 2 nem comeca');
        assert.deepEqual(ctx.execucoesPI.map(e => e.status), ['INVALID', 'PENDENTE']);
        assert.deepEqual(ctx.resultadosPI, []);
        const ultimo = ctx.errosValidacao[ctx.errosValidacao.length - 1];
        assert.equal(ultimo.veredito, 'UNRESOLVED');
        assert.deepEqual(avisos(ultimo), ['orcamento_esgotado']);
        assert.match(ctx.historicoStatus[ctx.historicoStatus.length - 1].motivo!, /orcamento do PI 1 esgotado \(3\/3\)/);
        assert.equal(ctx.execucoesPI[0].tentativas[2].realimentacao, undefined, 'sem proxima tentativa, sem feedback');
        assert.throws(() => avancarStatus(ctx, 'PI_EXECUTING'), /UNRESOLVED -> PI_EXECUTING/);
    });

    await teste('caso E — PI 1 invalido, PI 2 e 3 validos: so o PI 1 e regenerado', async () => {
        const validacao = validarSequencia(
            [PI_PROPOFOL, PI_NORA, { ordem: 3, item: 'Vancomicina', conduta: 'Solicitar_Exame_Controle', dependeDe: [] }],
            { contrato, politica: poda, regras: [], pedido: CENARIO.intencao! }
        );
        assert.equal(validacao.veredito, 'VALID', 'o plano de 3 PIs e valido');
        const chamadas: PedidoPIAgent[] = [];
        const ctx = await fluxo(PLANO_3, piAgentRoteirizado({ 1: [semSuporte] }, chamadas));
        assert.equal(ctx.status, 'COMPLETED');
        // Ondas do DAG: o PI 3 nao depende de ninguem e roda na onda 0, com o PI 1;
        // o PI 2 depende do 1 e espera a onda 1. O retry do PI 1 vem antes de tudo.
        assert.deepEqual(ctx.ondasPI.map(o => o.ordens), [[1, 3], [2]]);
        assert.deepEqual(porOrdem(chamadas), [1, 1, 3, 2]);
        assert.deepEqual(ctx.execucoesPI.map(e => e.tentativas.length), [2, 1, 1]);
        assert.deepEqual(ctx.resultadosPI.map(r => r.ordem), [1, 2, 3], 'os resultados ficam na ordem do Planner');
    });

    await teste('caso F — PI 2 invalido: o PI 1 fica intacto (uma chamada, mesmo resultado)', async () => {
        const chamadas: PedidoPIAgent[] = [];
        const ctx = await fluxo(PLANO_2, piAgentRoteirizado({ 2: [semSuporte] }, chamadas));
        assert.equal(ctx.status, 'COMPLETED');
        assert.deepEqual(porOrdem(chamadas), [1, 2, 2]);
        assert.equal(ctx.execucoesPI[0].tentativas.length, 1);
        assert.equal(ctx.resultadosPI[0], ctx.execucoesPI[0].resultado, 'o resultado do PI 1 e o mesmo objeto da tentativa dele');
    });

    await teste('caso G — dois PIs invalidos: historicos e feedbacks independentes', async () => {
        const chamadas: PedidoPIAgent[] = [];
        const ctx = await fluxo(PLANO_2, piAgentRoteirizado({ 1: ['texto livre do PI 1'], 2: [semSuporte, semSuporte] }, chamadas));
        assert.equal(ctx.status, 'COMPLETED');
        assert.deepEqual(porOrdem(chamadas), [1, 1, 2, 2, 2]);
        const [e1, e2] = ctx.execucoesPI;
        assert.ok(e1.tentativas.every(t => t.ordem === 1) && e2.tentativas.every(t => t.ordem === 2));
        assert.deepEqual(e1.tentativas.map(t => t.fase), ['protocolo', 'semantica']);
        assert.deepEqual(e2.tentativas.map(t => t.fase), ['semantica', 'semantica', 'semantica']);
        // O feedback de um PI so fala dele.
        for (const t of e2.tentativas.slice(1)) {
            assert.ok(!t.prompt.includes('texto livre do PI 1') && !t.prompt.includes('ordem Propofol'), 'o PI 2 nao ve o PI 1');
        }
        assert.ok(e1.tentativas[1].prompt.includes('texto livre do PI 1'));
        assert.deepEqual(chamadas.filter(c => c.ordem === 2).map(c => c.subgrafo_regras.politicas[0].item), ['Noradrenalina', 'Noradrenalina', 'Noradrenalina']);
    });

    // =========================================================================
    console.log('\nIsolamento, contexto e sequencia');
    // =========================================================================

    /** Execucao ja em PI_DECOMPOSED, pela validacao e decomposicao reais. */
    function emPIDecomposto(seq: PIPlanejado[], c: ContratoArtefato = contrato, e: EsquemaDeclarado = esquema, pedido = CENARIO.intencao!, politica: SubgrafoPodado = poda) {
        const id = `req-${Math.random()}`;
        const ctx = novoContextoExecucao<ClinicalContext, RetrievedConstraints>({
            dominio: 'med', pedido, contexto: { ...CENARIO, intencao: pedido }, requestId: id, orcamento: ORCAMENTO_PADRAO
        });
        registrarConhecimento(ctx, { ...conhecimentoDe(id), politicaEfetiva: politica, poda: politica });
        avancarStatus(ctx, 'PLANNING');
        avancarStatus(ctx, 'SEQUENCE_VALIDATING');
        const validacao = validarSequencia(seq, { contrato: c, politica, regras: [], pedido });
        assert.equal(validacao.veredito, 'VALID', JSON.stringify(validacao.erros));
        ctx.tentativasPlanner.push({ ciclo: 1, tentativa: 1, proposta: 'duble', validacao, fase: 'semantica', sequencia: seq });
        ctx.sequenciaValidada = validacao.valor;
        avancarStatus(ctx, 'SEQUENCE_VALID');
        decomporSequencia(ctx, { contrato: c, esquema: e });
        return ctx as ContextoExecucaoMultiagente;
    }

    await teste('isolamento — PI 1 (decisao A) valido; PI 2 (decisao B) falha e e regenerado; o resultado do PI 1 nao muda', async () => {
        const ctx = emPIDecomposto([PI_PROPOFOL, PI_NORA]);
        let fotoPI1: string | undefined;
        let objetoPI1: ResultadoPI | undefined;
        const chamadas: PedidoPIAgent[] = [];
        const roteiro = piAgentRoteirizado({ 2: [semSuporte] }, chamadas);
        await resolverPIs(ctx, async pedido => {
            if (pedido.ordem === 2 && fotoPI1 === undefined) {
                objetoPI1 = ctx.resultadosPI[0];
                fotoPI1 = JSON.stringify(ctx.resultadosPI[0]);
            }
            return roteiro(pedido);
        });
        assert.equal(ctx.status, 'PI_ALL_VALID');
        assert.equal(ctx.resultadosPI[0].acao.decisao, 'MANTER_BLOQUEADO');
        assert.equal(ctx.resultadosPI[1].acao.decisao, 'ESCALAR_EQUIPE');
        assert.equal(ctx.execucoesPI[1].tentativas.length, 2, 'o PI 2 foi regenerado');
        assert.equal(ctx.resultadosPI[0], objetoPI1, 'mesmo objeto');
        assert.equal(JSON.stringify(ctx.resultadosPI[0]), fotoPI1, 'mesmo conteudo');
        assert.deepEqual(porOrdem(chamadas), [1, 2, 2]);
    });

    await teste('contexto — o PI Agent recebe so o contexto do seu PI: sem outro PI, prefixo, artefato ou clausula anterior', async () => {
        const ctx = emPIDecomposto([PI_PROPOFOL, PI_NORA]);
        const chamadas: PedidoPIAgent[] = [];
        await resolverPIs(ctx, piAgentQueObedece(chamadas));
        const [p1, p2] = chamadas;
        for (const p of chamadas) {
            assert.deepEqual(Object.keys(p).sort(), ['conduta', 'ordem', 'prompt', 'subgrafo_regras'], 'nenhum campo de prefixo');
            assert.equal(p.subgrafo_regras.politicas.length, 1);
            for (const alheio of ['sequencia [', 'auditoria', '[POLITICA VIGENTE', 'plano ', 'comando:']) {
                assert.ok(!p.prompt.includes(alheio), `o prompt do PI ${p.ordem} traz ${alheio}`);
            }
            assert.ok(p.prompt.includes(CENARIO.intencao!), 'o pedido vai');
        }
        assert.equal(p2.subgrafo_regras.politicas[0].item, 'Noradrenalina');
        assert.ok(!p2.prompt.includes('ordem Propofol'), 'nenhuma clausula do PI 1');
        assert.ok(!p2.prompt.includes(ctx.resultadosPI[0].justificativa), 'nem o resultado do PI 1');
        assert.ok(!p2.prompt.includes('risco de hipotensao severa'), 'nem as restricoes do PI 1');
        assert.ok(p2.prompt.includes('FC: 145') && p2.prompt.includes('- ESCALAR_EQUIPE'), 'a telemetria e as decisoes do PI 2 vao');
        assert.ok(p1.prompt.includes('PAM: 52') && p1.prompt.includes('- MANTER_BLOQUEADO'));

        // O prompt do PI 2 nao depende do que o PI 1 produziu.
        const outro = emPIDecomposto([PI_PROPOFOL, PI_NORA]);
        const chamadasOutro: PedidoPIAgent[] = [];
        await resolverPIs(outro, piAgentRoteirizado({ 1: [p => saidaPI(p, { justificativa: 'RASS 2 e PAM 52: manter bloqueado', meio: 'ACESSO_PERIFERICO' })] }, chamadasOutro));
        assert.notDeepEqual(outro.resultadosPI[0], ctx.resultadosPI[0]);
        assert.equal(chamadasOutro[1].prompt, p2.prompt);
    });

    await teste('sequencia — o PI Agent nao altera PIPlanejado: item, conduta, ordem e dependencias iguais', async () => {
        const ctx = emPIDecomposto([PI_PROPOFOL, PI_NORA]);
        const antes = JSON.stringify(ctx.sequenciaValidada);
        const contextos = JSON.stringify(ctx.contextosPI);
        await resolverPIs(ctx, piAgentRoteirizado({ 1: [semSuporte], 2: [p => saidaPI(p).replace('ordem Noradrenalina', 'ordem Vasopressina')] }));
        assert.equal(JSON.stringify(ctx.sequenciaValidada), antes);
        assert.equal(JSON.stringify(ctx.contextosPI), contextos, 'os contextos decompostos tambem nao mudam');
        assert.deepEqual(ctx.resultadosPI.map(r => [r.ordem, r.item, r.conduta]), ctx.sequenciaValidada!.map(p => [p.ordem, p.item, p.conduta]));
        assert.deepEqual(codigos(ctx.execucoesPI[1].tentativas[0].validacao), ['pi_divergente'], 'a troca de item foi recusada, nao aceita');
    });

    await teste('restricao progressiva no fluxo: a decisao reprovada sai da gramatica, e o prompt base e o mesmo', async () => {
        const ctx = emPIDecomposto(
            [{ ordem: 1, item: 'Propofol', conduta: 'Ajustar_Infusao', dependeDe: [] }, PI_NORA],
            contratoAjuste, esquemaAjuste, PEDIDO_REDUZIR
        );
        const chamadas: PedidoPIAgent[] = [];
        await resolverPIs(ctx, piAgentRoteirizado({ 1: [p => saidaPI(p, { decisao: 'MANTER_VAZAO', justificativa: 'PAM 52 < 60 mmHg' })] }, chamadas));
        assert.equal(ctx.status, 'PI_ALL_VALID');
        const [t1, t2] = ctx.execucoesPI[0].tentativas;
        assert.deepEqual(codigos(t1.validacao), ['pedido_incompativel']);
        assert.deepEqual([t1.admissiveis, t2.admissiveis], [['REDUZIR_VAZAO', 'MANTER_VAZAO'], ['REDUZIR_VAZAO']]);
        assert.deepEqual(chamadas[1].subgrafo_regras.politicas[0].decisoes, ['REDUZIR_VAZAO'], 'a gramatica da segunda nao gera MANTER_VAZAO');
        assert.deepEqual(ctx.execucoesPI[0].proibidas, ['MANTER_VAZAO']);
        assert.equal(ctx.resultadosPI[0].acao.decisao, 'REDUZIR_VAZAO');
        // Prompt base preservado: a segunda so acrescenta o feedback.
        const semFeedback = t2.prompt.replace(/\n\[FEEDBACK DA VALIDACAO ANTERIOR\]\n[\s\S]*?\n\n\[FORMATO\]/, '\n[FORMATO]');
        assert.equal(semFeedback, t1.prompt);
        for (const trecho of ['O resultado anterior foi REJEITADO', 'resultado anterior: PI 1 | Ajustar_Infusao', 'pedido_incompativel', 'decisoes admissiveis agora: REDUZIR_VAZAO', 'Gere novamente SOMENTE o resultado deste PI.']) {
            assert.ok(t1.realimentacao!.includes(trecho), trecho);
        }
    });

    await teste('UNRESOLVED do PI nao e repetido: uma chamada, e a execucao para', async () => {
        const ctx = emPIDecomposto([PI_PROPOFOL, PI_NORA]);
        // O contexto do PI 1 sem evidencia alguma, e a conduta exige justificativa.
        ctx.contextosPI = [comoDadoPuro({ ...ctx.contextosPI![0], pedido: '', restricoes: [], fatos: [], regras: [], evidencias: [], telemetriaRelevante: {}, regrasRelacionais: [] }), ctx.contextosPI![1]];
        const chamadas: PedidoPIAgent[] = [];
        await resolverPIs(ctx, piAgentRoteirizado({ 1: [p => saidaPI(p, { justificativa: 'Mantido.' })] }, chamadas));
        assert.equal(ctx.status, 'UNRESOLVED');
        assert.deepEqual(porOrdem(chamadas), [1]);
        assert.equal(ctx.execucoesPI[0].status, 'UNRESOLVED');
        assert.match(ctx.historicoStatus[ctx.historicoStatus.length - 1].motivo!, /conhecimento insuficiente.*evidencia para justificar MANTER_BLOQUEADO/);
    });

    await teste('falha tecnica do motor no PI: FAILED com o motivo', async () => {
        const chamadas: PedidoPIAgent[] = [];
        const ctx = await fluxo(PLANO_2, async p => { chamadas.push(p); throw new Error('http://motor inacessivel: fetch failed'); });
        assert.equal(ctx.status, 'FAILED');
        assert.equal(chamadas.length, 1);
        assert.match(ctx.historicoStatus[ctx.historicoStatus.length - 1].motivo!, /inacessivel/);
    });

    await teste('guardas: sem resultado por PI nao ha PI_ALL_VALID; PI_EXECUTING so com orcamento', async () => {
        const ctx = emPIDecomposto([PI_PROPOFOL, PI_NORA]);
        await assert.rejects(resolverPIs({ ...ctx, status: 'SEQUENCE_VALID' }, piAgentQueObedece()), /comecam em PI_DECOMPOSED/);
        ctx.execucoesPI = ctx.contextosPI!.map(c => ({ ordem: c.pi!.ordem, item: c.pi!.item, conduta: c.pi!.conduta, status: 'PENDENTE' as const, tentativas: [], proibidas: [] }));
        avancarStatus(ctx, 'PI_EXECUTING');
        avancarStatus(ctx, 'PI_VALIDATING');
        assert.throws(() => avancarStatus(ctx, 'PI_ALL_VALID'), /0 resultado\(s\) valido\(s\) para 2 PI\(s\)/);
        ctx.execucoesPI[0].tentativas = [1, 2, 3].map(n => ({ ordem: 1, tentativa: n, prompt: '', saida: '', fase: 'protocolo' as const, validacao: { veredito: 'INVALID' as const, erros: [{ codigo: 'x', mensagem: 'x' }], avisos: [], dadosFaltantes: [] }, admissiveis: [] }));
        assert.throws(() => avancarStatus(ctx, 'PI_EXECUTING'), /orcamento do PI 1 esgotado \(3\/3\)/);
    });

    // =========================================================================
    console.log('\nIntegracao, observabilidade e tamanho');
    // =========================================================================

    await teste('integracao — SEQUENCE_VALID -> PI_DECOMPOSED -> PI_EXECUTING -> PI_VALIDATING -> VALID, pelo cliente HTTP real', async () => {
        const recebidas: string[] = [];
        const servidor = http.createServer((req, res) => {
            recebidas.push(req.url ?? '');
            let corpo = '';
            req.on('data', parte => (corpo += parte));
            req.on('end', () => {
                const pedido = corpo ? JSON.parse(corpo) : undefined;
                const resposta = req.url === '/generate-planner'
                    ? { saida: PLANO_2, tokens_prompt: 4000 }
                    : req.url === '/generate-pi'
                        ? { saida: saidaPI(pedido as PedidoPIAgent), tokens_prompt: 600, valida_na_gramatica: true }
                        : req.url === '/verify' ? RESPOSTA_VERIFY : undefined;
                res.writeHead(resposta ? 200 : 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(resposta ?? { detail: `rota inesperada: ${req.url}` }));
            });
        });
        await new Promise<void>(resolve => servidor.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
        process.env.SPC_CML_DECODIFICACAO = 'multiagente';
        delete process.env.SPC_CML_MAX_TENTATIVAS_PI;
        try {
            const r = (await decodificar({ ...montarEntradaGeracao(CENARIO, constraints, modelo, poda, conhecimentoDe('req-http')), endpoint: url })) as ResultadoMultiagente;
            const ctx = r.execucao;
            assert.deepEqual([ctx.historicoStatus[0].de, ...ctx.historicoStatus.map(t => t.para)], [
                'RECEIVED', 'KNOWLEDGE_RETRIEVED', 'SEMANTIC_PROMPT_READY', 'PLANNING', 'SEQUENCE_VALIDATING', 'SEQUENCE_VALID',
                'PI_DECOMPOSING', 'PI_DECOMPOSED', 'PI_EXECUTING', 'PI_VALIDATING', 'PI_EXECUTING', 'PI_VALIDATING', 'PI_ALL_VALID',
                'COMPOSING', 'GLOBAL_VALIDATING', 'COMPLETED'
            ]);
            assert.deepEqual(recebidas, ['/generate-planner', '/generate-pi', '/generate-pi', '/verify'], 'nem /generate-fragment nem /generate-constrained');
            assert.equal(ctx.resultadosPI.length, 2);
            assert.deepEqual(ctx.resultadosPI.map(x => [x.ordem, x.item, x.conduta]), [[1, 'Propofol', 'Manter_Bloqueio'], [2, 'Noradrenalina', 'Acionar_Equipe']]);
            assert.equal(r.resultado, ctx.artefatoFinal);
            assert.equal(r.valido, true);
            assert.equal(r.erro, null);
            assert.deepEqual(incoerenciasDoContexto(ctx), []);
            const resumo = JSON.parse(JSON.stringify(resumoExecucao(ctx)));
            assert.deepEqual(resumo.execucoesPI, ctx.execucoesPI, 'o historico por PI atravessa JSON');
            assert.deepEqual(resumo.resultadosPI, ctx.resultadosPI);
        } finally {
            if (originais.modo === undefined) delete process.env.SPC_CML_DECODIFICACAO;
            else process.env.SPC_CML_DECODIFICACAO = originais.modo;
            if (originais.porPI !== undefined) process.env.SPC_CML_MAX_TENTATIVAS_PI = originais.porPI;
            servidor.closeAllConnections();
            servidor.close();
        }
    });

    await teste('integracao — PI_EXECUTING -> PI_VALIDATING -> INVALID -> PI_EXECUTING -> PI_VALIDATING -> VALID', async () => {
        const ctx = await fluxo(PLANO_2, piAgentRoteirizado({ 1: [semSuporte] }));
        const doPI1 = ctx.historicoStatus.filter(t => /^PI 1 /.test(t.motivo ?? '')).map(t => t.para);
        assert.deepEqual(doPI1, ['PI_EXECUTING', 'PI_VALIDATING', 'PI_EXECUTING', 'PI_VALIDATING']);
        assert.deepEqual(ctx.execucoesPI[0].tentativas.map(t => t.validacao.veredito), ['INVALID', 'VALID']);
        assert.equal(ctx.status, 'COMPLETED');
    });

    await teste('observabilidade — por tentativa: prompt, tokens, duracoes, feedback, validacao e codigos', async () => {
        const ctx = await fluxo(PLANO_2, piAgentRoteirizado({ 2: [semSuporte] }));
        const [t1, t2] = ctx.execucoesPI[1].tentativas;
        for (const t of [t1, t2]) {
            assert.equal(t.metricas!.caracteresPrompt, t.prompt.length);
            assert.equal(t.metricas!.tokensPrompt, 502);
            assert.ok(t.metricas!.duracaoMs >= 0 && t.metricas!.duracaoValidacaoMs! >= 0);
        }
        assert.equal(t1.metricas!.caracteresFeedback, undefined);
        assert.equal(t2.metricas!.caracteresFeedback, t1.realimentacao!.length);
        assert.deepEqual([t1.ordem, t1.tentativa, t2.tentativa], [2, 1, 2]);
        assert.equal(ctx.execucoesPI[1].tentativas.length - 1, 1, 'retries do PI 2');
    });

    await teste('tamanho — o prompt de cada PI e muito menor que o do Planner', async () => {
        const chamadas: PedidoPIAgent[] = [];
        const ctx = await fluxo(PLANO_2, piAgentQueObedece(chamadas));
        const planner = ctx.tentativasPlanner[0].prompt!.length;
        for (const p of chamadas) assert.ok(p.prompt.length * 2 < planner, `PI ${p.ordem}: ${p.prompt.length} vs Planner ${planner}`);
        console.log(`       Planner: ${planner} car. | ${chamadas.map(p => `PI ${p.ordem}: ${p.prompt.length} car.`).join(' | ')}`);
    });

    await teste('motorPIAgentHttp — POST /generate-pi com o pedido; motor antigo (404) e erro explicito', async () => {
        const recebidas: { rota: string; corpo: unknown }[] = [];
        let status = 200;
        const servidor = http.createServer((req, res) => {
            let corpo = '';
            req.on('data', parte => (corpo += parte));
            req.on('end', () => {
                recebidas.push({ rota: req.url ?? '', corpo: JSON.parse(corpo) });
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ saida: 'x', tokens_prompt: 10 }));
            });
        });
        await new Promise<void>(resolve => servidor.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
        try {
            const exe = await executarPI(cProp, motorPIAgentHttp(url, 5000));
            assert.equal(recebidas[0].rota, '/generate-pi');
            assert.deepEqual(recebidas[0].corpo, { prompt: exe.prompt, subgrafo_regras: cProp.subgrafoDoItem, ordem: 1, conduta: 'Manter_Bloqueio' });
            assert.deepEqual(codigos(exe.leitura), ['cabecalho_ausente'], 'a saida crua do motor passa pela leitura');
            status = 404;
            await assert.rejects(executarPI(cProp, motorPIAgentHttp(url, 5000)), /nao expoe \/generate-pi: o motor esta desatualizado/);
        } finally {
            servidor.closeAllConnections();
            servidor.close();
        }
    });

    // Exemplos legiveis.
    const exemplo = await fluxo(PLANO_2, piAgentRoteirizado({ 1: [semSuporte] }));
    console.log('\n  --- exemplo: retry do PI 1 (Propofol -> Manter_Bloqueio) ---');
    for (const t of exemplo.execucoesPI[0].tentativas) {
        console.log(`    tentativa ${t.tentativa} [${t.fase}] ${t.validacao.veredito} ${codigos(t.validacao).join(', ')}`);
        console.log(`      saida: ${t.saida}`);
    }
    console.log('    feedback enviado a tentativa 2:');
    console.log(exemplo.execucoesPI[0].tentativas[0].realimentacao!.split('\n').map(l => `      ${l}`).join('\n'));
    console.log('\n  --- exemplo: prompt do PI 2 (Noradrenalina -> Acionar_Equipe) ---');
    console.log(exemplo.execucoesPI[1].tentativas[0].prompt.split('\n').map(l => `    ${l}`).join('\n'));

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
