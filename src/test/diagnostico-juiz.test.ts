/**
 * Diagnóstico da indeterminação do LLM Judge (src/inference/diagnostico-juiz.ts).
 * Executar: npx tsx src/test/diagnostico-juiz.test.ts
 *
 * O que se cobra:
 *   - o catálogo de fundamentação sai da recuperação real (sem Neo4j: a vista
 *     do cenário; com regras do Cypher: as condições e as lacunas), com a
 *     formalização de cada regra e as regras que o plano cita;
 *   - o diagnóstico só aceita o que o catálogo sustenta: regra, campo ou trecho
 *     inexistente é rejeitado e registrado, nada é completado;
 *   - os quatro tipos de informação ausente são distinguidos, e cada um tem de
 *     ser o que diz ser;
 *   - caminhos VALID/INVALID só com regra do catálogo, com a formalização dela;
 *   - resposta fora do formato: MALFORMED; falha, timeout ou HTTP de erro:
 *     NO_RESPONSE; cancelamento propaga.
 *
 * Roda OFFLINE: modelo da DSL de futebol, parser Langium e recuperação
 * determinística reais; o diagnosticador é dublê (ou um servidor HTTP local).
 */

import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Session } from 'neo4j-driver';

import { loadFutModel } from '../database/neo4j-fut.js';
import { EarleyRecognizer, loadBnf } from '../grammar/earley.js';
import type { FutContext } from '../knowledge/graphrag-fut.js';
import type { RegraValidada } from '../knowledge/recuperacao-cypher.js';
import { pedidoDoJuiz } from '../inference/avaliar-grafo.js';
import { criarAnalisadorDsl, validarSintaxePlano } from '../inference/avaliar-sintaxe.js';
import {
    catalogoComoTexto,
    catalogoDeFundamentacao,
    diagnosticadorLLMHttp,
    diagnosticarIndeterminacao,
    validarDiagnostico,
    type CatalogoFundamentacao,
    type DiagnosticadorLLM,
    type PedidoDiagnostico,
    type RespostaDiagnosticoLLM
} from '../inference/diagnostico-juiz.js';
import { ADAPTADOR_FUT, recuperarConhecimento } from '../inference/recuperacao-conhecimento.js';

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

/** O caso da interface: cenario PT-2026-4011 de src/examples/fut/cenarios-400-fut.jsonl e o plano real gerado para ele. */
const PLANO_FUT =
    "arbitragem Arbitragem_Carga_Imprudente_Acrescido92minutos_partida4011_para_Disputa_Bola_Dividida_esquema_AssistenteArbitragem_v1_partida_PT20264011_sequencia_Emitir_Adverti para Disputa_Bola_Dividida { esquema_referencia AssistenteArbitragem_v1 partida 'PT-2026-4011' sequencia [ Marcar_Penalti , Acionar_Revisao_VAR ] marcacao Carga_Imprudente decisao PENALTI minuto 92.0 min reinicio TIRO_LIVRE_DIRETO justificativa 'contato imprudente com uso de força excessiva, jogada concluida na frente' marcacao Entrada_Violenta decisao ACIONAR_VAR minuto 92.0 min reinicio BOLA_AO_CHAO justificativa 'contato imprudente com uso de força excessiva, jogada concluida na frente' alerta CRITICO 'contato imprudente com uso de força excessiva, jogada concluida na frente' regra 'Disputa_Bola_Dividida/gatilho' alerta CRITICO 'contato imprudente com uso de força excessiva, jogada concluida na frente' regra 'Disputa_Bola_Dividida/gatilho' auditoria 'artefato montado elemento a elemento sob verificacao no grafo: 2 clausula(s) aceitas, 0 descartada(s)' }";
const CENARIO_FUT: FutContext = {
    partida: 'PT-2026-4011',
    intencao: 'Carga imprudente aos 92 minutos com 3 de acréscimo e placar empatado, a 26 m do gol. Marca agora.',
    telemetria: {
        minuto_partida: 92, acrescimo: 3, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.0, velocidade_bola: 11,
        distancia_gol: 26, jogadores_entre_bola_e_gol: 5, tempo_revisao_var: 2, placar_diferenca: 0, faltas_acumuladas_time: 1, distancia_bola: 0.5
    },
    contextos: ['Acrescimos'],
    infracoesEmUso: []
};
const JUSTIFICATIVA_UNRESOLVED = 'o gatilho de Disputa_Bola_Dividida nao esta ativo na leitura da partida; os numeros nao mostram o contato que a marcacao afirma';

const semNeo4j = (): Session => ({ run: async () => { throw new Error('sem Neo4j no teste'); }, close: async () => {} }) as unknown as Session;

/** Regra do Cypher dublê, no formato de `RegraValidada`. */
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

/** Catálogo clínico com os quatro graus: regra formal medida, regra formal com lacuna, relação parcial, regra global em texto. */
const CATALOGO_MED: CatalogoFundamentacao = catalogoDeFundamentacao(
    'med',
    { PAM: 52, FC: 145 },
    {
        interacoes: [{ entre: 'Noradrenalina + Propofol', gravidade: 'alta', mecanismo: 'hipotensao aditiva', conduta: 'monitorar PAM' }],
        regrasGlobais: [{ descricao: 'toda titulacao exige reavaliacao clinica registrada', severidade: 'alta' }]
    },
    [
        regraCypher({
            regraId: R_PAM, item: 'Propofol', aplicavel: true,
            condicoesSatisfeitas: [{ campo: 'PAM', observado: 52, esperado: '< 60', operador: '<', limite: 60, unidade: 'mmHg', satisfeita: true }]
        }),
        regraCypher({ regraId: R_TFG, item: 'Vancomicina', lacunas: [{ campo: 'TFG', esperado: '< 30', motivo: "o cenario nao mediu 'TFG'" }] })
    ]
);
const FONTES_MED = {
    pedido: 'A pressao ta despencando (PAM=52), sobe a nora e aprofunda o propofol',
    plano: "plano P para Choque_Septico { ordem Propofol decisao AUMENTAR_VAZAO }",
    julgamento: 'falta a TFG para concluir sobre a Vancomicina\nPAM = 52'
};

const BASE = { evidenciasDisponiveis: [], regrasAfetadas: [], informacoesAusentes: [], motivo: 'nao se conclui', caminhosPossiveis: [], incertezaRemanescente: 'resta incerteza', limitacoes: [] };
const resposta = (o: Record<string, unknown>): RespostaDiagnosticoLLM => ({ respostaBruta: JSON.stringify({ ...BASE, ...o }) });
const validarMed = (o: Record<string, unknown>) => validarDiagnostico(resposta(o), CATALOGO_MED, FONTES_MED);

async function main(): Promise<void> {
    // O caso real: conhecimento recuperado do futebol.fut e o AST oficial do plano.
    const modelo = await loadFutModel(path.join('src', 'examples', 'fut', 'futebol.fut'));
    const k = await recuperarConhecimento(ADAPTADOR_FUT, modelo, CENARIO_FUT, CENARIO_FUT.intencao!, async () => {}, semNeo4j);
    const earley = new EarleyRecognizer(loadBnf(path.join('src', 'python_engine', 'grammar', 'futebol.bnf'), 'arbitragem'));
    const sintaxe = await validarSintaxePlano(PLANO_FUT, criarAnalisadorDsl('fut', path.join('src', 'examples', 'fut', 'futebol.fut')), async t => {
        const a = earley.analyze(t);
        return { valido: a.accepted, erro: a.error ?? null };
    });
    assert.equal(sintaxe.sintaxe.veredito, 'VALID', JSON.stringify(sintaxe.sintaxe.erros));
    const catalogoFut = catalogoDeFundamentacao('fut', CENARIO_FUT.telemetria, k.constraints, k.auditoriaRecuperacao.validacao, sintaxe.ast);
    const pedidoFut: PedidoDiagnostico = {
        juiz: pedidoDoJuiz('fut', PLANO_FUT, CENARIO_FUT.intencao!, CENARIO_FUT.telemetria, k),
        julgamento: { justificativa: JUSTIFICATIVA_UNRESOLVED, evidencias: ['minuto_partida = 92', 'Disputa_Bola_Dividida (sem gatilho ativo na leitura da partida)'] },
        catalogo: catalogoFut
    };
    const regra = (id: string) => catalogoFut.regras.find(r => r.id === id);

    // =========================================================================
    console.log('\nCatalogo de fundamentacao (o caso PT-2026-4011, recuperacao real)');
    // =========================================================================

    await teste('o catalogo sai da recuperacao: vetos com gatilho observado sao formais e citam o campo; isencoes e regras globais sao texto', () => {
        assert.deepEqual(
            [regra('veto:Impedimento@Posicao_Legal_No_Passe')?.formalizacao, regra('veto:Impedimento@Posicao_Legal_No_Passe')?.campos],
            ['formal', ['distancia_ultimo_defensor']]
        );
        assert.equal(regra('isencao:Carga_Imprudente')?.formalizacao, 'texto');
        assert.match(regra('isencao:Carga_Imprudente')!.descricao, /contato com uso excessivo de forca/);
        assert.equal(catalogoFut.regras.filter(r => r.origem === 'regra_global').length, 8);
        assert.ok(catalogoFut.regras.filter(r => r.origem === 'regra_global').every(r => r.formalizacao === 'texto' && r.campos.length === 0));
        assert.match(regra('regra_global#5')!.descricao, /visao do lance/);
    });

    await teste('os campos sao os da telemetria, com valor; sem regra do Cypher, nenhum campo "sem valor" e afirmado', () => {
        assert.deepEqual(catalogoFut.campos.map(c => c.campo).sort(), Object.keys(CENARIO_FUT.telemetria).sort());
        assert.ok(catalogoFut.campos.every(c => c.valor !== undefined));
        assert.deepEqual(catalogoFut.campos.find(c => c.campo === 'distancia_bola')!.regras, ['veto:Mao_Deliberada@Mao_Curta_Distancia']);
    });

    await teste('a regra que o plano cita (Disputa_Bola_Dividida/gatilho) nao existe no conhecimento: fica registrada, e o lance alvo nao vira regra', () => {
        assert.deepEqual(catalogoFut.citadasPeloPlano, [{ texto: 'Disputa_Bola_Dividida/gatilho', noCatalogo: false }]);
        assert.ok(!catalogoFut.regras.some(r => r.id.includes('Disputa_Bola_Dividida')), 'o lance sem gatilho nao ganha regra inventada');
        assert.match(catalogoComoTexto(catalogoFut), /'Disputa_Bola_Dividida\/gatilho': NAO existe no conhecimento recuperado/);
    });

    await teste('com regras do Cypher: condicao medida e lacuna; a lacuna e o unico campo sem valor', () => {
        assert.deepEqual(CATALOGO_MED.regras.map(r => [r.id, r.formalizacao]), [[R_PAM, 'formal'], [R_TFG, 'formal'], [R_INTERACAO, 'parcial'], [R_GLOBAL, 'texto']]);
        assert.deepEqual(CATALOGO_MED.campos, [
            { campo: 'PAM', valor: 52, regras: [R_PAM] },
            { campo: 'FC', valor: 145, regras: [] },
            { campo: 'TFG', regras: [R_TFG] }
        ]);
    });

    // =========================================================================
    console.log('\nDiagnostico: so o que o catalogo sustenta');
    // =========================================================================

    await teste('caso 1 — UNRESOLVED com diagnostico completo e fundamentado (exemplo real): tudo aceito, com as limitacoes do conhecimento', async () => {
        const lidos: PedidoDiagnostico[] = [];
        const diagnosticador: DiagnosticadorLLM = async p => {
            lidos.push(p);
            return resposta({
                evidenciasDisponiveis: [
                    { fonte: 'telemetria', referencia: 'minuto_partida', descricao: 'o lance e aos 92 minutos, nos acrescimos' },
                    { fonte: 'pedido', referencia: 'Carga imprudente aos 92 minutos', descricao: 'o pedido afirma a carga imprudente' },
                    { fonte: 'julgamento', referencia: 'os numeros nao mostram o contato', descricao: 'o juiz nao viu o contato na leitura' }
                ],
                regrasAfetadas: [
                    { regra: 'isencao:Carga_Imprudente', motivo: 'a isencao depende de o contato ter sido minimo ou com forca excessiva' },
                    { regra: 'regra_global#5', motivo: 'zona do contato e visao do lance nao sao leitura da partida' }
                ],
                informacoesAusentes: [
                    { tipo: 'fato_nao_observado', referencia: 'intensidade do contato na disputa', regra: 'isencao:Carga_Imprudente', descricao: 'nenhum campo do modelo registra a forca do contato' },
                    { tipo: 'regra_nao_formalizada', referencia: 'regra_global#1', regra: 'regra_global#1', descricao: 'visao clara do lance so existe como texto' },
                    { tipo: 'evidencia_insuficiente', referencia: 'distancia_gol', regra: 'regra_global#5', descricao: '26 m nao diz se o contato foi na area' }
                ],
                motivo: 'os numeros da partida nao demonstram o contato com as caracteristicas que a isencao e a marcacao exigem',
                caminhosPossiveis: [
                    { resultado: 'INVALID', condicoes: 'se o contato foi minimo e sem risco, a isencao afasta a carga imprudente', regras: ['isencao:Carga_Imprudente'] },
                    { resultado: 'UNRESOLVED', condicoes: 'sem registro da intensidade e da visao do lance, continua sem conclusao', regras: [] }
                ],
                incertezaRemanescente: 'mesmo com o registro do contato, a isencao e texto livre e nao se avalia formalmente',
                limitacoes: ['o lance Disputa_Bola_Dividida nao tem gatilho formal']
            });
        };
        const d = await diagnosticarIndeterminacao(pedidoFut, diagnosticador, new AbortController().signal);
        assert.equal(d.status, 'DIAGNOSED', JSON.stringify(d.referenciasRejeitadas));
        assert.deepEqual(d.referenciasRejeitadas, []);
        assert.deepEqual(d.regrasAfetadas!.map(r => [r.regra, r.formalizacao]), [['isencao:Carga_Imprudente', 'texto'], ['regra_global#5', 'texto']]);
        assert.deepEqual(d.informacoesAusentes!.map(i => i.tipo), ['fato_nao_observado', 'regra_nao_formalizada', 'evidencia_insuficiente']);
        assert.equal(d.evidenciasDisponiveis!.length, 3);
        assert.deepEqual(d.caminhosPossiveis!.map(c => [c.resultado, c.fundamentacao]), [['INVALID', 'texto'], ['UNRESOLVED', 'nenhuma']]);
        const limitacoes = d.limitacoes.map(l => `${l.origem}: ${l.descricao}`);
        assert.ok(limitacoes.some(l => /conhecimento: o plano cita a regra 'Disputa_Bola_Dividida\/gatilho'/.test(l)), limitacoes.join('\n'));
        assert.ok(limitacoes.some(l => /conhecimento: nenhum campo lido por regra formal esta sem valor/.test(l)));
        assert.ok(limitacoes.some(l => /conhecimento: o caminho INVALID se apoia so em regra em texto livre \(isencao:Carga_Imprudente\)/.test(l)));
        assert.ok(limitacoes.some(l => /conhecimento: regra\(s\) so em texto livre no diagnostico/.test(l)));
        assert.ok(limitacoes.some(l => l === 'modelo: o lance Disputa_Bola_Dividida nao tem gatilho formal'));
        assert.match(d.respostaBruta!, /"evidenciasDisponiveis"/);
        // O diagnosticador leu o contexto do juiz e o catalogo — nada do oraculo.
        assert.equal(lidos.length, 1);
        assert.equal(lidos[0].juiz.plano, PLANO_FUT);
        for (const proibido of ['oraculo', 'validacaoSemantica', 'VALIDO_PELO', 'DecisionCommand']) assert.ok(!JSON.stringify(lidos[0]).includes(proibido), proibido);
    });

    await teste('caso 2 — conhecimento insuficiente para recomendar campo especifico: campo com valor nao vira "campo sem valor"; catalogo vazio nem chama o modelo', async () => {
        const d = validarDiagnostico(resposta({
            regrasAfetadas: [{ regra: 'veto:Impedimento@Posicao_Legal_No_Passe', motivo: 'x' }],
            informacoesAusentes: [{ tipo: 'campo_sem_valor', referencia: 'distancia_ultimo_defensor', regra: 'veto:Impedimento@Posicao_Legal_No_Passe', descricao: 'medir de novo' }]
        }), catalogoFut, { pedido: '', plano: '', julgamento: '' });
        assert.equal(d.status, 'DIAGNOSED');
        assert.deepEqual(d.informacoesAusentes, []);
        assert.deepEqual(d.referenciasRejeitadas!.map(r => [r.secao, r.motivo]), [['informacoesAusentes', "o campo 'distancia_ultimo_defensor' tem valor (2) neste cenario"]]);
        assert.ok(d.limitacoes.some(l => /nao aponta medida especifica a registrar/.test(l.descricao)));

        let chamadas = 0;
        const vazio = catalogoDeFundamentacao('fut', { minuto_partida: 92 }, undefined, []);
        const semRegra = await diagnosticarIndeterminacao({ ...pedidoFut, catalogo: vazio }, async () => { chamadas++; return resposta({}); }, new AbortController().signal);
        assert.deepEqual([semRegra.status, chamadas], ['INSUFFICIENT_GROUNDING', 0]);
        assert.match(semRegra.motivo!, /nao foi pedido ao modelo/);
        assert.equal(semRegra.regrasAfetadas, undefined, 'nenhum conteudo inventado');
        assert.ok(semRegra.limitacoes.some(l => /nao tem regra a citar/.test(l.descricao)));
    });

    await teste('campo sem valor so quando a regra formal citada le o campo que o cenario nao mediu', () => {
        const d = validarMed({
            informacoesAusentes: [
                { tipo: 'campo_sem_valor', referencia: 'TFG', regra: R_TFG, descricao: 'registrar a TFG' },
                { tipo: 'campo_sem_valor', referencia: 'TFG', regra: R_PAM, descricao: 'a regra da PAM nao le a TFG' },
                { tipo: 'campo_sem_valor', referencia: 'PAM', regra: R_PAM, descricao: 'a PAM foi medida' }
            ]
        });
        assert.deepEqual(d.informacoesAusentes!.map(i => [i.referencia, i.regra, i.formalizacao]), [['TFG', R_TFG, 'formal']]);
        assert.deepEqual(d.referenciasRejeitadas!.map(r => r.motivo), [`a regra '${R_PAM}' nao le o campo 'TFG'`, "o campo 'PAM' tem valor (52) neste cenario"]);
        assert.ok(!d.limitacoes.some(l => /nao aponta medida especifica/.test(l.descricao)), 'com lacuna no catalogo, a limitacao nao se aplica');
    });

    await teste('caso 3 — regra so em texto livre: aceita como regra_nao_formalizada, recusada se for formal, e a limitacao fica explicita', () => {
        const d = validarMed({
            regrasAfetadas: [{ regra: R_GLOBAL, motivo: 'a reavaliacao exigida so existe como texto' }],
            informacoesAusentes: [
                { tipo: 'regra_nao_formalizada', referencia: R_GLOBAL, regra: R_GLOBAL, descricao: 'nao ha condicao estruturada para a reavaliacao' },
                { tipo: 'regra_nao_formalizada', referencia: R_PAM, regra: R_PAM, descricao: 'diz que e texto, mas tem condicao' }
            ]
        });
        assert.deepEqual(d.informacoesAusentes!.map(i => [i.tipo, i.formalizacao]), [['regra_nao_formalizada', 'texto']]);
        assert.deepEqual(d.referenciasRejeitadas!.map(r => r.motivo), [`a regra '${R_PAM}' e formal: tem condicao estruturada`]);
        assert.ok(d.limitacoes.some(l => l.origem === 'conhecimento' && l.descricao.includes(`(${R_GLOBAL})`) && /nao sao avaliadas formalmente/.test(l.descricao)));
    });

    await teste('caso 4 — regra, campo ou trecho inexistente: rejeitado com o motivo, fora do diagnostico; sem nada fundamentado, INSUFFICIENT_GROUNDING', () => {
        const d = validarDiagnostico(resposta({
            evidenciasDisponiveis: [
                { fonte: 'telemetria', referencia: 'visao_do_lance', descricao: 'inventado' },
                { fonte: 'regra', referencia: 'Disputa_Bola_Dividida/gatilho', descricao: 'inventada' },
                { fonte: 'pedido', referencia: 'o goleiro foi batido', descricao: 'nao esta no pedido' }
            ],
            regrasAfetadas: [{ regra: 'Disputa_Bola_Dividida/gatilho', motivo: 'o plano cita' }],
            informacoesAusentes: [
                { tipo: 'fato_nao_observado', referencia: 'visao_do_lance', regra: 'regra_global#1', descricao: 'parece campo, nao existe' },
                { tipo: 'fato_nao_observado', referencia: 'minuto_partida', regra: 'regra_global#1', descricao: 'e campo do modelo' },
                { tipo: 'evidencia_insuficiente', referencia: 'velocidade_bola', regra: 'Lei_12/forca', descricao: 'regra inexistente' }
            ],
            caminhosPossiveis: [{ resultado: 'VALID', condicoes: 'se o gatilho estivesse ativo', regras: ['Disputa_Bola_Dividida/gatilho'] }]
        }), catalogoFut, { pedido: CENARIO_FUT.intencao!, plano: PLANO_FUT, julgamento: JUSTIFICATIVA_UNRESOLVED });
        assert.equal(d.status, 'INSUFFICIENT_GROUNDING');
        assert.match(d.motivo!, /nenhuma regra afetada nem informacao ausente/);
        assert.deepEqual([d.regrasAfetadas, d.informacoesAusentes, d.evidenciasDisponiveis, d.caminhosPossiveis], [[], [], [], []]);
        assert.deepEqual(d.referenciasRejeitadas!.map(r => [r.secao, r.motivo]), [
            ['regrasAfetadas', "a regra 'Disputa_Bola_Dividida/gatilho' nao existe no conhecimento recuperado"],
            ['evidenciasDisponiveis', "o campo 'visao_do_lance' nao existe no modelo deste cenario"],
            ['evidenciasDisponiveis', "a regra 'Disputa_Bola_Dividida/gatilho' nao existe no conhecimento recuperado"],
            ['evidenciasDisponiveis', 'o trecho nao aparece no pedido: evidencia nao fornecida'],
            ['informacoesAusentes', "o campo 'visao_do_lance' nao existe no modelo deste cenario: um fato nao observado nao inventa campo"],
            ['informacoesAusentes', "'minuto_partida' e campo do modelo: o que falta nele e campo_sem_valor ou evidencia_insuficiente"],
            ['informacoesAusentes', "a regra 'Lei_12/forca' nao existe no conhecimento recuperado"],
            ['caminhosPossiveis', "a regra 'Disputa_Bola_Dividida/gatilho' nao existe no conhecimento recuperado (caminho VALID)"],
            ['caminhosPossiveis', 'o caminho VALID nao cita regra do conhecimento recuperado: sem fundamentacao, nao e apresentado']
        ]);
    });

    await teste('trecho do pedido e aceito sem depender de acento, caixa ou espacos', () => {
        const d = validarDiagnostico(resposta({
            regrasAfetadas: [{ regra: 'regra_global#5', motivo: 'x' }],
            evidenciasDisponiveis: [{ fonte: 'pedido', referencia: 'CARGA imprudente aos 92  minutos com 3 de acrescimo', descricao: 'o pedido' }]
        }), catalogoFut, { pedido: CENARIO_FUT.intencao!, plano: '', julgamento: '' });
        assert.deepEqual([d.status, d.evidenciasDisponiveis!.length, d.referenciasRejeitadas!.length], ['DIAGNOSED', 1, 0]);
    });

    await teste('caso 5 — caminhos VALID e INVALID com fundamentacoes diferentes: cada um com a formalizacao das regras que cita', () => {
        const d = validarMed({
            regrasAfetadas: [{ regra: R_PAM, motivo: 'a PAM decide o bloqueio' }],
            caminhosPossiveis: [
                { resultado: 'VALID', condicoes: 'se a decisao do Propofol nao for incremento, o bloqueio por PAM < 60 e respeitado', regras: [R_PAM] },
                { resultado: 'INVALID', condicoes: 'se a combinacao com a noradrenalina for demonstrada como risco', regras: [R_INTERACAO, R_GLOBAL] }
            ]
        });
        assert.deepEqual(d.caminhosPossiveis!.map(c => [c.resultado, c.fundamentacao, c.regras]), [
            ['VALID', 'formal', [R_PAM]],
            ['INVALID', 'parcial', [R_INTERACAO, R_GLOBAL]]
        ]);
        assert.ok(!d.limitacoes.some(l => /se apoia so em regra em texto livre/.test(l.descricao)), 'parcial nao e "so texto"');
    });

    await teste('caso 6 — um caminho sem fundamentacao: sai (com a regra inexistente registrada); o fundamentado continua', () => {
        const d = validarMed({
            regrasAfetadas: [{ regra: R_TFG, motivo: 'a TFG nao foi medida' }],
            caminhosPossiveis: [
                { resultado: 'VALID', condicoes: 'com TFG >= 30 o ajuste renal nao incide', regras: [R_TFG] },
                { resultado: 'INVALID', condicoes: 'se houver nefrotoxicidade', regras: ['Farmaco:Vancomicina/Nefrotoxicidade'] }
            ]
        });
        assert.deepEqual(d.caminhosPossiveis!.map(c => c.resultado), ['VALID']);
        assert.deepEqual(d.referenciasRejeitadas!.map(r => r.referencia), ['Farmaco:Vancomicina/Nefrotoxicidade', 'INVALID']);
    });

    await teste('caso 7 — resposta malformada ou incompleta: MALFORMED, com a resposta bruta e nada completado', () => {
        const casos: [string, RespostaDiagnosticoLLM, RegExp][] = [
            ['nao e JSON', { respostaBruta: 'o plano esta indeterminado porque falta a TFG' }, /a resposta nao e JSON/],
            ['cortada no teto de tokens', { respostaBruta: '{"evidenciasDisponiveis":[{"fonte":"telemetria"', cortada: true }, /parou no teto de tokens.*nao e JSON/],
            ['sem o motivo', { respostaBruta: JSON.stringify({ ...BASE, motivo: undefined }) }, /diagnostico\.motivo ausente/],
            ['lista que nao e lista', resposta({ regrasAfetadas: R_PAM }), /regrasAfetadas ausente ou nao e lista/],
            ['tipo fora do contrato', resposta({ informacoesAusentes: [{ tipo: 'palpite', referencia: 'TFG', regra: R_TFG, descricao: 'x' }] }), /informacoesAusentes\[0\]\.tipo fora de/],
            ['resultado fora dos tres', resposta({ caminhosPossiveis: [{ resultado: 'PROVAVEL', condicoes: 'x', regras: [] }] }), /resultado fora de VALID \| INVALID \| UNRESOLVED/],
            ['item sem campo', resposta({ regrasAfetadas: [{ regra: R_PAM }] }), /regrasAfetadas\[0\]\.motivo ausente/],
            ['array no lugar do objeto', { respostaBruta: '[]' }, /diagnostico nao e objeto/]
        ];
        for (const [nome, r, motivo] of casos) {
            const d = validarDiagnostico(r, CATALOGO_MED, FONTES_MED);
            assert.equal(d.status, 'MALFORMED', nome);
            assert.match(d.motivo!, motivo, nome);
            assert.equal(d.respostaBruta, r.respostaBruta, nome);
            for (const campo of ['motivoIndeterminacao', 'regrasAfetadas', 'informacoesAusentes', 'caminhosPossiveis', 'referenciasRejeitadas'] as const) {
                assert.equal(d[campo], undefined, `${nome}: ${campo}`);
            }
            assert.ok(d.limitacoes.every(l => l.origem === 'conhecimento'), nome);
        }
    });

    await teste('caso 8 — falha ou timeout do diagnosticador: NO_RESPONSE com o motivo; cancelamento propaga', async () => {
        const d = await diagnosticarIndeterminacao(pedidoFut, async () => { throw new Error('motor (http://x) inacessivel: sem resposta em 0.2s'); }, new AbortController().signal);
        assert.deepEqual([d.status, d.regrasAfetadas, d.respostaBruta], ['NO_RESPONSE', undefined, undefined]);
        assert.match(d.motivo!, /Falha ao diagnosticar com o modelo local: .*sem resposta em 0\.2s/);
        assert.ok(d.limitacoes.length > 0, 'as limitacoes do conhecimento valem mesmo sem resposta');

        const controlador = new AbortController();
        await assert.rejects(diagnosticarIndeterminacao(pedidoFut, async () => { controlador.abort(); throw new Error('abortado'); }, controlador.signal), /abortado/);
    });

    // =========================================================================
    console.log('\nDiagnosticador real (/diagnosticar-indeterminacao)');
    // =========================================================================

    /** Servidor local: `responder` decide o que cada pedido recebe. */
    async function comServidor(responder: (corpo: Record<string, unknown>, res: http.ServerResponse) => void, fn: (url: string) => Promise<void>): Promise<void> {
        const servidor = http.createServer((req, res) => {
            let corpo = '';
            req.on('data', parte => (corpo += parte));
            req.on('end', () => responder(JSON.parse(corpo), res));
        });
        await new Promise<void>(resolve => servidor.listen(0, '127.0.0.1', resolve));
        try {
            await fn(`http://127.0.0.1:${(servidor.address() as AddressInfo).port}`);
        } finally {
            servidor.closeAllConnections();
            servidor.close();
        }
    }

    await teste('envia o contexto do juiz, a resposta dele, o catalogo em texto e os identificadores que a gramatica deixa citar', async () => {
        const corpos: Record<string, unknown>[] = [];
        await comServidor((corpo, res) => {
            corpos.push(corpo);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ resposta_bruta: '{"x":1}', cortada: false }));
        }, async url => {
            const r = await diagnosticadorLLMHttp(url, 10_000)(pedidoFut, new AbortController().signal);
            assert.deepEqual(r, { respostaBruta: '{"x":1}', cortada: false });
        });
        const c = corpos[0];
        assert.deepEqual([c.plano, c.intencao, c.justificativa_juiz], [PLANO_FUT, CENARIO_FUT.intencao, JUSTIFICATIVA_UNRESOLVED]);
        assert.deepEqual(c.evidencias_juiz, pedidoFut.julgamento.evidencias);
        assert.equal(c.contexto_neo4j, pedidoFut.juiz.conhecimento);
        assert.deepEqual(c.regras, catalogoFut.regras.map(r => r.id));
        assert.deepEqual(c.regras_formais, ['veto:Impedimento@Posicao_Legal_No_Passe', 'veto:Mao_Deliberada@Mao_Curta_Distancia', 'veto:Reincidencia_Amarelo@Jogador_Sem_Advertencia']);
        assert.ok((c.regras_nao_formais as string[]).includes('isencao:Carga_Imprudente') && (c.regras_nao_formais as string[]).includes('regra_global#5'));
        assert.deepEqual([c.campos_sem_valor, (c.campos_com_valor as string[]).length], [[], 11]);
        assert.match(String(c.catalogo), /\[REGRAS CITADAS PELO PLANO\]\n- 'Disputa_Bola_Dividida\/gatilho': NAO existe/);
    });

    await teste('HTTP de erro, resposta sem resposta_bruta e timeout viram NO_RESPONSE (nunca MALFORMED nem veredito)', async () => {
        const status = async (responder: (c: Record<string, unknown>, res: http.ServerResponse) => void, timeoutMs = 10_000): Promise<[string, string]> => {
            let saida: [string, string] = ['', ''];
            await comServidor(responder, async url => {
                const d = await diagnosticarIndeterminacao(pedidoFut, diagnosticadorLLMHttp(url, timeoutMs), new AbortController().signal);
                saida = [d.status, d.motivo ?? ''];
            });
            return saida;
        };
        const [s502, m502] = await status((_, res) => { res.writeHead(502); res.end('{"detail":"motor caiu"}'); });
        assert.equal(s502, 'NO_RESPONSE');
        assert.match(m502, /motor respondeu 502/);
        const [s413, m413] = await status((_, res) => { res.writeHead(413); res.end('{"detail":"excede n_ctx"}'); });
        assert.deepEqual([s413, /413.*n_ctx/.test(m413)], ['NO_RESPONSE', true]);
        const [sVazio, mVazio] = await status((_, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
        assert.deepEqual([sVazio, /sem resposta_bruta/.test(mVazio)], ['NO_RESPONSE', true]);
        const [sLento, mLento] = await status(() => { /* nunca responde */ }, 200);
        assert.equal(sLento, 'NO_RESPONSE');
        assert.match(mLento, /sem resposta em 0\.2s/);
    });

    await teste('cancelamento durante a chamada HTTP propaga (nao vira NO_RESPONSE)', async () => {
        await comServidor(() => { /* segura */ }, async url => {
            const controlador = new AbortController();
            setTimeout(() => controlador.abort(), 50);
            await assert.rejects(diagnosticarIndeterminacao(pedidoFut, diagnosticadorLLMHttp(url, 10_000), controlador.signal));
        });
    });

    console.log(falhas === 0 ? `\nTodos os ${contagem} testes passaram.` : `\n${falhas} de ${contagem} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
