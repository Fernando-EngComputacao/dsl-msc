/**
 * Decompositor: da sequencia VALIDADA a um `ContextoGeracaoItem` por PI.
 *
 * O que se cobra:
 *   - um contexto por PI, na ordem, com as dependencias do Planner e nenhuma
 *     inventada;
 *   - o recorte certo: regras, fatos, evidencias, telemetria, decisoes,
 *     valores e restricoes DAQUELE par (item, conduta) — e nada do resto;
 *   - independencia: nenhum objeto compartilhado entre contextos, contexto
 *     congelado, e o de um PI nao muda quando o outro muda;
 *   - nao decisao: o Decompositor carrega o universo admissivel inteiro e nao
 *     escolhe nada dele;
 *   - so decompoe o que a validacao aprovou (SEQUENCE_VALID), e inconsistencia
 *     interna e defeito, sem fallback;
 *   - serializacao sem perda, e a medida do contexto global contra o por PI;
 *   - no fluxo `multiagente`, SEQUENCE_VALID -> PI_DECOMPOSING -> PI_DECOMPOSED
 *     sem nenhuma chamada a modelo: a proxima depois do Planner ja e a do
 *     primeiro PI Agent.
 *
 * Roda OFFLINE: modelos das DSLs e recuperacao deterministica reais; regras do
 * Cypher (modo hibrido) sao dubles no formato de `RegraValidada`; o Planner e
 * um duble ou um motor falso HTTP que registra toda requisicao.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

import { loadModel } from '../database/neo4j.js';
import { loadAgroModel } from '../database/neo4j-agro.js';
import { loadFutModel } from '../database/neo4j-fut.js';
import {
    condutasPorDecisaoMed,
    esquemaDeDadosMed,
    esquemaDeclaradoMed,
    pruningPayload,
    retrieveConstraints,
    type ClinicalContext,
    type RetrievedConstraints
} from '../knowledge/graphrag.js';
import {
    agroPruningPayload,
    condutasPorDecisaoAgro,
    esquemaDeclaradoAgro,
    retrieveAgroConstraints,
    type AgroContext
} from '../knowledge/graphrag-agro.js';
import {
    condutasPorDecisaoFut,
    esquemaDeclaradoFut,
    futPruningPayload,
    retrieveFutConstraints,
    type FutContext
} from '../knowledge/graphrag-fut.js';
import { condutasDoItem, decisoesDaConduta, montarContrato, type ContratoArtefato } from '../knowledge/contrato.js';
import type { PIPlanejado } from '../knowledge/contrato-pi.js';
import {
    InconsistenciaDecomposicao,
    decomporPIs,
    evidenciasDosFatos,
    medirDecomposicao,
    montarPromptPI,
    vistaDoCenario,
    type ConhecimentoDaDecomposicao
} from '../knowledge/decompositor.js';
import { ordenarPorOrigem, type ContextoGeracaoItem } from '../knowledge/item-geracao.js';
import type { PoliticaItem, SubgrafoPodado, ValorAdmissivel } from '../knowledge/politica.js';
import type { RegraValidada } from '../knowledge/recuperacao-cypher.js';
import { auditoriaVazia } from '../knowledge/recuperacao-hibrida.js';
import { validarSequencia } from '../knowledge/validacao-sequencia.js';
import { montarEntradaGeracao, montarPromptSemantico } from '../inference/llm-client.js';
import {
    decodificar,
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
import type { MotorPlanner } from '../inference/planner.js';
import type { PedidoPIAgent } from '../inference/pi-agent.js';
import { RESPOSTA_VERIFY, piAgentQueObedece, respostaQueObedece, verificadorQueAceita } from './dubles-pi-agent.js';
import type { ConhecimentoRecuperado } from '../inference/recuperacao-conhecimento.js';

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
/** A sequencia que a validacao aprova no cenario de referencia (ver `planner.test.ts`). */
const SEQ: PIPlanejado[] = [PI_PROPOFOL, PI_NORA];

/** Regra do Cypher no formato de `RegraValidada`, para o modo hibrido sem Neo4j. */
function regra(r: {
    rotulo: string; item: string; tipo: string; relacao: string;
    campo: string; observado?: number; operador: '<' | '>'; limite: number; efeito?: RegraValidada['efeito'];
}): RegraValidada {
    const medida = r.observado !== undefined;
    const incide = medida && (r.operador === '<' ? r.observado! < r.limite : r.observado! > r.limite);
    const cond = { campo: r.campo, observado: r.observado!, esperado: `${r.operador} ${r.limite}`, operador: r.operador, limite: r.limite, satisfeita: incide };
    return {
        regraId: `${r.rotulo}:${r.item}/${r.tipo}/${r.campo}${r.operador}${r.limite}`,
        tipo: r.tipo,
        relacao: r.relacao,
        item: r.item,
        dominio: 'med',
        aplicavel: incide,
        condicoesSatisfeitas: medida && incide ? [cond] : [],
        condicoesFalhas: medida && !incide ? [cond] : [],
        lacunas: medida ? [] : [{ campo: r.campo, esperado: `${r.operador} ${r.limite}`, motivo: 'nao medido' }],
        evidencia: medida ? { [r.campo]: r.observado! } : {},
        validacaoCypher: { valida: incide, motivo: 'duble', consulta: '' },
        efeito: r.efeito ?? {},
        rag: { candidatoId: `${r.rotulo}:${r.item}`, escore: 0.9, cosseno: 0.8, papel: 'item', posicao: 0 }
    };
}

/** Todo objeto alcancavel a partir de `raiz` (arrays incluidos). */
function objetosDe(raiz: unknown, vistos = new Set<object>()): Set<object> {
    if (typeof raiz === 'object' && raiz !== null && !vistos.has(raiz)) {
        vistos.add(raiz);
        for (const v of Object.values(raiz)) objetosDe(v, vistos);
    }
    return vistos;
}

/** Os valores que `grammar_from_kg.py` usaria para a decisao: `por_decisao.get(d) or valores`. */
function valoresNaGramatica(p: PoliticaItem, d: string): ValorAdmissivel[] {
    const mapa = p.valoresPorDecisao ?? {};
    if (Object.keys(mapa).length === 0) return p.valores;
    return mapa[d] && mapa[d].length > 0 ? mapa[d] : p.valores;
}

async function main(): Promise<void> {
    const modelo = await loadModel(path.join('src', 'examples', 'med', 'uti.dsl'));
    const constraints = retrieveConstraints(modelo, CENARIO);
    const poda = pruningPayload(constraints, CENARIO);
    const escalonamentos = constraints.escalonamentos.map(e => `${e.destino}: ${e.detalhe}`);
    const contrato = montarContrato(poda, condutasPorDecisaoMed(modelo), escalonamentos, esquemaDeDadosMed(modelo));
    const esquema = esquemaDeclaradoMed(modelo);
    const promptSemantico = montarPromptSemantico(constraints, CENARIO, poda);
    const politicaDe = (item: string): PoliticaItem => poda.politicas.find(p => p.item === item)!;

    // Modo hibrido: regras do item, de contexto (gatilho/escalonamento) e de itens fora do plano.
    const R = {
        propofolPAM: regra({ rotulo: 'Farmaco', item: 'Propofol', tipo: 'RegraSeguranca', relacao: 'BLOQUEIA_INCREMENTO', campo: 'PAM', observado: 52, operador: '<', limite: 60, efeito: { razao: 'hipotensao' } }),
        propofolTFG: regra({ rotulo: 'Farmaco', item: 'Propofol', tipo: 'RegraSeguranca', relacao: 'BLOQUEIA_INCREMENTO', campo: 'TFG', observado: 28, operador: '<', limite: 15 }),
        noraFC: regra({ rotulo: 'Farmaco', item: 'Noradrenalina', tipo: 'RegraSeguranca', relacao: 'BLOQUEIA_INCREMENTO', campo: 'FC', observado: 145, operador: '>', limite: 130 }),
        sedacaoRASS: regra({ rotulo: 'Protocolo', item: 'Sedacao_Analgesia_VM', tipo: 'Gatilho', relacao: 'DISPARA', campo: 'RASS', observado: 2, operador: '>', limite: 0 }),
        choqueLactato: regra({ rotulo: 'Protocolo', item: 'Choque_Septico', tipo: 'Escalonamento', relacao: 'ESCALONA', campo: 'lactato', observado: 4.8, operador: '>', limite: 4 }),
        choqueGatilho: regra({ rotulo: 'Protocolo', item: 'Choque_Septico', tipo: 'Gatilho', relacao: 'DISPARA', campo: 'PAM', observado: 52, operador: '<', limite: 65 }),
        glicemico: regra({ rotulo: 'Protocolo', item: 'Controle_Glicemico_UTI', tipo: 'Gatilho', relacao: 'DISPARA', campo: 'glicemia', observado: 210, operador: '>', limite: 180 }),
        glicemicoEsc: regra({ rotulo: 'Protocolo', item: 'Controle_Glicemico_UTI', tipo: 'Escalonamento', relacao: 'ESCALONA', campo: 'glicemia', observado: 210, operador: '>', limite: 400 }),
        heparina: regra({ rotulo: 'Farmaco', item: 'Heparina', tipo: 'RegraSeguranca', relacao: 'BLOQUEIA_INCREMENTO', campo: 'plaquetas', observado: 45, operador: '<', limite: 50 })
    };
    const regras = Object.values(R);

    const conhecimento = (extra: Partial<ConhecimentoDaDecomposicao> = {}): ConhecimentoDaDecomposicao => ({
        requestId: 'req-decomp', dominio: 'med', pedido: CENARIO.intencao!, telemetria: CENARIO.telemetria,
        contrato, politica: poda, regras: [], restricoes: constraints, esquema, ...extra
    });
    const k = conhecimento();
    const kHibrido = conhecimento({ regras });

    // =========================================================================
    console.log('\nPre-condicao: a sequencia de referencia e VALID');
    // =========================================================================

    await teste('a sequencia usada nestes testes passa na validacao contra o conhecimento', () => {
        const r = validarSequencia(SEQ, { contrato, politica: poda, regras: [], pedido: CENARIO.intencao! });
        assert.equal(r.veredito, 'VALID', JSON.stringify(r.erros));
    });

    // =========================================================================
    console.log('\nIdentidade, ordem e dependencias');
    // =========================================================================

    await teste('caso 1 — um PI valido gera exatamente um contexto, com a identidade do PI', () => {
        const [c, ...resto] = decomporPIs([PI_PROPOFOL], k);
        assert.equal(resto.length, 0);
        assert.deepEqual(c.pi, PI_PROPOFOL);
        assert.equal(c.item.item, 'Propofol');
        assert.equal(c.conduta!.nome, 'Manter_Bloqueio');
        assert.deepEqual(c.metadata, { itemId: 'Propofol', dominio: 'med', requestId: 'req-decomp', ordemOriginal: 0 });
        assert.equal(c.pedido, CENARIO.intencao);
    });

    await teste('caso 2 — dois PIs geram dois contextos independentes (nenhum objeto em comum)', () => {
        const [a, b] = decomporPIs(SEQ, k);
        assert.notEqual(a, b);
        const deA = objetosDe(a);
        const comuns = [...objetosDe(b)].filter(o => deA.has(o));
        assert.deepEqual(comuns, [], 'nenhum array ou objeto e compartilhado entre os dois contextos');
        // Nem com a execucao: nada do contexto e objeto da poda, do contrato ou das restricoes.
        const daExecucao = objetosDe([poda, constraints, SEQ, esquema, [...contrato.politicas.values()]]);
        assert.deepEqual([...deA].filter(o => daExecucao.has(o)), []);
    });

    await teste('caso 3 — a ordem do Planner e preservada, e a remontagem e deterministica', () => {
        const contextos = decomporPIs(SEQ, k);
        assert.deepEqual(contextos.map(c => c.pi!.ordem), [1, 2]);
        assert.deepEqual(contextos.map(c => c.metadata.ordemOriginal), [0, 1]);
        assert.deepEqual(ordenarPorOrigem([contextos[1], contextos[0]]), contextos);
    });

    await teste('caso 4 — dependencias preservadas nos dois sentidos; o PI 1 nao e executado', () => {
        const [a, b] = decomporPIs(SEQ, k);
        assert.deepEqual(b.pi!.dependeDe, [1]);
        assert.deepEqual(b.relacoes, [{ tipo: 'depende_de', ordem: 1, item: 'Propofol', conduta: 'Manter_Bloqueio' }]);
        assert.deepEqual(a.relacoes, [{ tipo: 'dependente', ordem: 2, item: 'Noradrenalina', conduta: 'Acionar_Equipe' }]);
        // Do PI 1, o PI 2 so conhece ordem, item e conduta.
        for (const r of b.relacoes) assert.deepEqual(Object.keys(r).sort(), ['conduta', 'item', 'ordem', 'tipo']);
    });

    await teste('nenhuma precedencia e inventada: sem dependeDe, so a relacao que o KG declara', () => {
        // Noradrenalina + Adrenalina e uma interacao do modelo; o plano nao declara dependencia.
        const seq: PIPlanejado[] = [
            { ordem: 1, item: 'Noradrenalina', conduta: 'Reduzir_Infusao', dependeDe: [] },
            { ordem: 2, item: 'Adrenalina', conduta: 'Manter_Bloqueio', dependeDe: [] }
        ];
        const [a, b] = decomporPIs(seq, k);
        assert.deepEqual(a.relacoes.map(r => [r.tipo, r.ordem]), [['relacional', 2]]);
        assert.deepEqual(b.relacoes.map(r => [r.tipo, r.ordem]), [['relacional', 1]]);
        assert.equal(a.relacoes[0].regra!.entre, 'Noradrenalina + Adrenalina');
        assert.ok(!a.relacoes.some(r => r.tipo === 'depende_de' || r.tipo === 'dependente'));
    });

    // =========================================================================
    console.log('\nRecorte: regras, fatos, evidencias');
    // =========================================================================

    await teste('caso 5 — o item recebe as regras dele: fatos, motivos e regras do Cypher', () => {
        const [a] = decomporPIs(SEQ, kHibrido);
        assert.deepEqual(a.fatos.map(f => f.tipo).sort(), ['bloqueio', 'recomendacao']);
        const bloqueio = a.fatos.find(f => f.tipo === 'bloqueio')!;
        const fonte = constraints.bloqueios.find(b => b.farmaco === 'Propofol')!;
        assert.deepEqual([bloqueio.descricao, bloqueio.condicoes], [fonte.razao, [fonte.regra]], 'o texto e o da recuperacao');
        assert.deepEqual(a.restricoes, politicaDe('Propofol').motivos);
        assert.deepEqual(a.regras.map(r => r.regraId), [R.propofolPAM, R.propofolTFG, R.sedacaoRASS].map(r => r.regraId));
    });

    await teste('caso 6 — a conduta recebe as regras dela: obrigatoriedade e escalonamento so onde obrigam', () => {
        const [, b] = decomporPIs(SEQ, kHibrido);
        assert.deepEqual(b.conduta, {
            nome: 'Acionar_Equipe',
            decisoes: ['ESCALAR_EQUIPE'],
            atributos: { requer_dupla_checagem: 'nao', justificativa_obrigatoria: 'sim', recurso_fhir: 'Communication' },
            obrigatoriaPor: escalonamentos
        });
        assert.deepEqual(b.fatos.filter(f => f.tipo === 'escalonamento').map(f => f.descricao), escalonamentos);
        assert.ok(b.regras.includes(b.regras.find(r => r.regraId === R.choqueLactato.regraId)!), 'o escalonamento que obriga entra');

        // O MESMO item com uma conduta que nao e obrigatoria: nada de escalonamento.
        const [c] = decomporPIs([{ ordem: 1, item: 'Noradrenalina', conduta: 'Reduzir_Infusao', dependeDe: [] }], kHibrido);
        assert.deepEqual(c.conduta!.obrigatoriaPor, []);
        assert.ok(!c.fatos.some(f => f.tipo === 'escalonamento'));
        assert.ok(!c.regras.some(r => r.relacao === 'ESCALONA'));
        assert.deepEqual(c.conduta!.decisoes, ['REDUZIR_VAZAO']);
    });

    await teste('caso 7 — regras irrelevantes ficam de fora', () => {
        const [a, b] = decomporPIs(SEQ, kHibrido);
        // Regras de outro item, de contexto sem relacao com o PI, e escalonamento que nao obriga a conduta.
        for (const fora of [R.noraFC, R.heparina, R.glicemico, R.glicemicoEsc, R.choqueLactato, R.choqueGatilho]) {
            assert.ok(!a.regras.some(r => r.regraId === fora.regraId), `${fora.regraId} nao e do PI 1`);
        }
        for (const fora of [R.propofolPAM, R.heparina, R.glicemico, R.glicemicoEsc, R.sedacaoRASS]) {
            assert.ok(!b.regras.some(r => r.regraId === fora.regraId), `${fora.regraId} nao e do PI 2`);
        }
        // Nada de Titular_Vasopressor nem de Noradrenalina no contexto de Propofol/Manter_Bloqueio.
        assert.ok(!a.fatos.some(f => f.descricao === constraints.bloqueios.find(x => x.farmaco === 'Noradrenalina')!.razao));
        assert.deepEqual(a.regrasRelacionais.map(r => r.entre), ['Propofol + Midazolam']);
        assert.deepEqual(b.regrasRelacionais.map(r => r.entre), ['Noradrenalina + Adrenalina']);
        assert.ok(!JSON.stringify(a).includes('Titular_Vasopressor'));
    });

    await teste('caso 8 — evidencias relevantes preservadas: as do Cypher e as condicoes observadas dos fatos', () => {
        const [a, b] = decomporPIs(SEQ, kHibrido);
        assert.deepEqual(a.evidencias, [
            { regraId: R.propofolPAM.regraId, campo: 'PAM', observado: 52, esperado: '< 60' },
            { regraId: R.propofolTFG.regraId, campo: 'TFG', observado: 28, esperado: '< 15' },
            { regraId: R.sedacaoRASS.regraId, campo: 'RASS', observado: 2, esperado: '> 0' }
        ]);
        const gatilhosSedacao = constraints.protocolosAtivos.find(p => p.nome === 'Sedacao_Analgesia_VM')!.gatilhos;
        assert.deepEqual(a.fatos.find(f => f.tipo === 'recomendacao')!.condicoes, gatilhosSedacao);
        const gatilhosChoque = constraints.protocolosAtivos.find(p => p.nome === 'Choque_Septico')!.gatilhos;
        assert.deepEqual(
            evidenciasDosFatos(b.fatos, 'protocolo'),
            [`bloqueio: ${constraints.bloqueios.find(x => x.farmaco === 'Noradrenalina')!.regra}`, ...gatilhosChoque.map(g => `protocolo Choque_Septico ativo: ${g}`)],
            'o gatilho que sustenta a recomendacao e o escalonamento aparece uma vez'
        );
    });

    // =========================================================================
    console.log('\nRecorte: decisoes, valores, restricoes, telemetria');
    // =========================================================================

    await teste('caso 9 — decisoes admissiveis: as do item que realizam a conduta, e o payload restrito a elas', () => {
        for (const c of decomporPIs(SEQ, k)) {
            const esperadas = politicaDe(c.pi!.item).decisoes.filter(d => decisoesDaConduta(contrato, c.pi!.conduta).includes(d));
            assert.deepEqual(c.decisoes.admissiveis, esperadas);
            assert.deepEqual(c.item.decisoes, esperadas);
            assert.equal(c.subgrafoDoItem.politicas.length, 1);
            assert.deepEqual(c.subgrafoDoItem.politicas[0], c.item);
            assert.deepEqual(c.subgrafoDoItem.acoes_permitidas, esperadas);
            assert.deepEqual(c.subgrafoDoItem.farmacos_liberados, [c.pi!.item]);
        }
    });

    await teste('caso 10 — decisoes bloqueadas preservadas; admissiveis, bloqueadas e foraDaConduta particionam o universo', () => {
        const [a] = decomporPIs(SEQ, k);
        assert.deepEqual(a.decisoes.bloqueadas, ['INICIAR_INFUSAO', 'AUMENTAR_VAZAO', 'AJUSTAR_DOSE']);
        for (const c of decomporPIs(SEQ, k)) {
            const { admissiveis, bloqueadas, foraDaConduta } = c.decisoes;
            const todas = [...admissiveis, ...bloqueadas, ...foraDaConduta];
            assert.equal(new Set(todas).size, todas.length, 'disjuntas');
            assert.deepEqual([...todas].sort(), [...esquema.decisoes].sort(), 'cobrem o universo');
            assert.deepEqual([...admissiveis, ...foraDaConduta].sort(), [...politicaDe(c.pi!.item).decisoes].sort());
        }
        // Sem o universo, nao se conclui bloqueio.
        assert.deepEqual(decomporPIs(SEQ, conhecimento({ esquema: undefined }))[0].decisoes.bloqueadas, []);
    });

    await teste('caso 11 — valores admissiveis: exatamente os que a gramatica alcanca para as decisoes do PI', () => {
        const seqs: PIPlanejado[][] = [SEQ, [{ ordem: 1, item: 'Vancomicina', conduta: 'Titular_Vasopressor', dependeDe: [] }]];
        let algumComVarios = false;
        for (const seq of seqs) {
            for (const c of decomporPIs(seq, k)) {
                const original = politicaDe(c.pi!.item);
                for (const d of c.decisoes.admissiveis) {
                    const vista = c.valores.porDecisao[d] ?? c.valores.gerais;
                    assert.deepEqual(vista, valoresNaGramatica(original, d), `${c.pi!.item}/${d}`);
                    assert.deepEqual(valoresNaGramatica(c.subgrafoDoItem.politicas[0], d), vista, 'o payload gera o mesmo reticulo');
                    if (vista.length > 1) algumComVarios = true;
                }
                assert.ok(Object.keys(c.valores.porDecisao).every(d => c.decisoes.admissiveis.includes(d)), 'nenhum valor de decisao fora do PI');
            }
        }
        assert.ok(algumComVarios, 'algum PI com mais de um valor admissivel — e todos foram carregados');
    });

    await teste('caso 12 — restricoes preservadas: motivos do item, atributos declarados da conduta, obrigatoriedade', () => {
        const [a, b] = decomporPIs(SEQ, k);
        assert.deepEqual(a.restricoes, politicaDe('Propofol').motivos);
        assert.equal(a.item.bloqueado, politicaDe('Propofol').bloqueado);
        assert.deepEqual(a.conduta!.atributos, esquema.condutas.Manter_Bloqueio);
        assert.deepEqual(a.conduta!.atributos, { requer_dupla_checagem: 'sim', justificativa_obrigatoria: 'sim', recurso_fhir: 'DetectedIssue' });
        assert.deepEqual(b.conduta!.obrigatoriaPor, escalonamentos);
        assert.deepEqual(a.item.meios, politicaDe('Propofol').meios, 'meios do item intactos: o atributo `via` da conduta nao vira regra');
    });

    await teste('caso 13 — telemetria relevante: a que as regras e os textos do PI leem, com o valor do cenario', () => {
        const [a, b] = decomporPIs(SEQ, k);
        assert.deepEqual(a.telemetriaRelevante, { PAM: 52, RASS: 2 });
        assert.deepEqual(b.telemetriaRelevante, { PAM: 52, FC: 145, lactato: 4.8 });
        // Hibrido: o que a regra do item leu entra mesmo sem aparecer em texto nenhum.
        const [h] = decomporPIs(SEQ, kHibrido);
        assert.deepEqual(h.telemetriaRelevante, { PAM: 52, RASS: 2, TFG: 28 });
    });

    await teste('caso 14 — o que a selecao consegue eliminar nao entra', () => {
        const [a, b] = decomporPIs(SEQ, k);
        for (const c of [a, b]) {
            assert.ok(!('subgrafo' in c), 'sem a poda global');
            for (const p of ['glicemia', 'plaquetas', 'TFG']) assert.ok(!(p in c.telemetriaRelevante), p);
            // As constantes do cenario (sujeito, contextos em foco) viajam intactas no
            // payload: o motor as le para fixar os literais do cabecalho. Sao dado do
            // cenario, nao conhecimento selecionavel — e ficam fora desta conferencia.
            assert.deepEqual(c.subgrafoDoItem.constantes, poda.constantes);
            const { constantes, ...payloadSemConstantes } = c.subgrafoDoItem;
            const texto = JSON.stringify({ ...c, subgrafoDoItem: payloadSemConstantes }) + montarPromptPI(c);
            for (const alheio of ['Insulina_Regular', 'Heparina', 'Controle_Glicemico_UTI', 'Piperacilina_Tazobactam', '[POLITICA VIGENTE']) {
                assert.ok(!texto.includes(alheio), `${c.pi!.item} nao deveria citar ${alheio}`);
            }
        }
    });

    // =========================================================================
    console.log('\nIndependencia entre PIs');
    // =========================================================================

    await teste('caso 15 — o PI 2 nao depende do contexto textual do PI 1', () => {
        const [a, b] = decomporPIs(SEQ, k);
        const promptB = montarPromptPI(b);
        // Texto que o PI 2 tem por conta propria (ex.: "ja em curso", comum aos dois
        // farmacos em curso) nao e vazamento; o resto do PI 1 nao pode aparecer.
        const proprios = new Set([...b.restricoes, ...b.fatos.map(f => f.descricao)]);
        const doPI1 = [...a.restricoes, ...a.fatos.map(f => f.descricao)].filter(t => !proprios.has(t));
        assert.ok(doPI1.length > 0);
        for (const texto of doPI1) {
            assert.ok(!promptB.includes(texto), `o prompt do PI 2 cita o PI 1: ${texto}`);
        }
        // Outro PI 1, mesmo PI 2: o contexto do PI 2 so muda na identidade do PI de que depende.
        const outroPI1: PIPlanejado = { ordem: 1, item: 'Vancomicina', conduta: 'Solicitar_Exame_Controle', dependeDe: [] };
        const [, b2] = decomporPIs([outroPI1, PI_NORA], k);
        const semRelacoes = ({ relacoes, ...resto }: ContextoGeracaoItem) => resto;
        assert.deepEqual(semRelacoes(b2), semRelacoes(b));
        assert.deepEqual(b2.relacoes, [{ tipo: 'depende_de', ordem: 1, item: 'Vancomicina', conduta: 'Solicitar_Exame_Controle' }]);
    });

    await teste('independencia — mudar o contexto de um PI nao muda o do outro (nos dois sentidos)', () => {
        const [a, b] = decomporPIs(SEQ, k);
        const fotoA = JSON.stringify(a);
        const fotoB = JSON.stringify(b);

        // Congelados: nem o proprio contexto muda por acidente.
        assert.ok(Object.isFrozen(a) && Object.isFrozen(a.decisoes.admissiveis) && Object.isFrozen(a.subgrafoDoItem.papeis));
        assert.throws(() => { (a.decisoes.admissiveis as string[]).push('AUMENTAR_VAZAO'); }, TypeError);
        assert.throws(() => { (a.subgrafoDoItem.papeis.decisoesDeIncremento as string[]).length = 0; }, TypeError);
        assert.throws(() => { (b.telemetriaRelevante as Record<string, number>).PAM = 99; }, TypeError);

        // Uma copia local mutavel de cada um, alterada a fundo: o outro nao muda.
        const copiaA = structuredClone(a) as ContextoGeracaoItem;
        copiaA.decisoes.admissiveis.push('AUMENTAR_VAZAO');
        copiaA.subgrafoDoItem.papeis.decisoesDeIncremento.length = 0;
        copiaA.pi!.dependeDe.push(9);
        copiaA.telemetriaRelevante.PAM = 99;
        assert.equal(JSON.stringify(b), fotoB);

        const copiaB = structuredClone(b) as ContextoGeracaoItem;
        copiaB.relacoes.length = 0;
        copiaB.fatos.forEach(f => f.condicoes.push('inventado'));
        copiaB.conduta!.obrigatoriaPor.length = 0;
        assert.equal(JSON.stringify(a), fotoA);
        assert.equal(JSON.stringify(b), fotoB);
    });

    await teste('a decomposicao nao muda a sequencia nem o conhecimento', () => {
        const antes = JSON.stringify({ SEQ, poda, esquema, constraints, contrato: [...contrato.politicas.values()] });
        decomporPIs(SEQ, kHibrido);
        assert.equal(JSON.stringify({ SEQ, poda, esquema, constraints, contrato: [...contrato.politicas.values()] }), antes);
        assert.ok(!Object.isFrozen(SEQ[0]) && !Object.isFrozen(poda.politicas[0]), 'a execucao nao e congelada pelo Decompositor');
    });

    // =========================================================================
    console.log('\nNao decisao');
    // =========================================================================

    await teste('caso 16 / nao decisao — nenhum contexto traz acao, decisao escolhida, meio, valor ou justificativa', () => {
        const proibidos = ['acao', 'decisao', 'meio', 'valor', 'justificativa'];
        const seq: PIPlanejado[] = [...SEQ, { ordem: 3, item: 'Vancomicina', conduta: 'Titular_Vasopressor', dependeDe: [] }];
        for (const c of decomporPIs(seq, kHibrido)) {
            assert.deepEqual(Object.keys(c).filter(ch => proibidos.includes(ch)), []);
            assert.deepEqual(Object.keys(c.pi!).sort(), ['conduta', 'dependeDe', 'item', 'ordem']);
            // Carrega o universo admissivel INTEIRO — nao escolhe dentro dele.
            const politica = politicaDe(c.pi!.item);
            assert.deepEqual(c.decisoes.admissiveis, politica.decisoes.filter(d => c.conduta!.decisoes.includes(d)));
            assert.deepEqual(c.item.meios, politica.meios);
            const prompt = montarPromptPI(c);
            assert.ok(!/^(acao|decisao|meio|valor|justificativa)\s*:/im.test(prompt), 'o prompt nao traz campo de acao preenchido');
        }
        const [vanco] = decomporPIs([{ ...seq[2], ordem: 1 }], k);
        assert.ok(vanco.valores.porDecisao.AUMENTAR_VAZAO.length > 1, 'todos os degraus viajam, nenhum e escolhido');
        assert.deepEqual(vanco.valores.porDecisao.AUMENTAR_VAZAO, politicaDe('Vancomicina').valoresPorDecisao!.AUMENTAR_VAZAO);
    });

    // =========================================================================
    console.log('\nInconsistencia interna e recusa do que nao foi validado');
    // =========================================================================

    await teste('inconsistencia interna e defeito explicito, sem fallback', () => {
        const casos: [string, PIPlanejado[], RegExp][] = [
            ['item fora da politica', [{ ordem: 1, item: 'Dopamina', conduta: 'Manter_Bloqueio', dependeDe: [] }], /nao esta na politica efetiva/],
            ['conduta fora do esquema', [{ ordem: 1, item: 'Propofol', conduta: 'marcacao', dependeDe: [] }], /nao esta no esquema_dados/],
            ['par sem decisao em comum', [{ ordem: 1, item: 'Propofol', conduta: 'Titular_Vasopressor', dependeDe: [] }], /nao admite nenhuma decisao/],
            ['dependencia para frente', [{ ...PI_PROPOFOL, dependeDe: [2] }, { ...PI_NORA, dependeDe: [] }], /forma de um plano/],
            ['lista fora de ordem', [PI_NORA, PI_PROPOFOL], /posicao 1 da lista veio numerado 2/]
        ];
        for (const [nome, seq, msg] of casos) {
            assert.throws(() => decomporPIs(seq, k), (e: Error) => e instanceof InconsistenciaDecomposicao && msg.test(e.message), nome);
        }
    });

    /** Execucao em PLANNING, como o orquestrador a deixa antes do Planner. */
    const emPlanejamento = (id: string): ContextoExecucaoMultiagente => {
        const ctx = novoContextoExecucao<ClinicalContext, RetrievedConstraints>({
            dominio: 'med', pedido: CENARIO.intencao!, contexto: CENARIO, requestId: id, orcamento: ORCAMENTO_PADRAO
        });
        registrarConhecimento(ctx, conhecimentoDe(id));
        avancarStatus(ctx, 'PLANNING');
        return ctx as ContextoExecucaoMultiagente;
    };
    function conhecimentoDe(id: string, politica: SubgrafoPodado = poda): ConhecimentoRecuperado<RetrievedConstraints> {
        return {
            constraints, foco: null, auditoriaRecuperacao: auditoriaVazia('deterministica', 'med', CENARIO.intencao!, id),
            poda: politica, politicaEfetiva: politica, promptSemantico
        };
    }
    /** Proposta julgada pela validacao real, registrada como o orquestrador registra. */
    const julgar = (ctx: ContextoExecucaoMultiagente, seq: PIPlanejado[], fase: 'protocolo' | 'semantica' = 'semantica') => {
        avancarStatus(ctx, 'SEQUENCE_VALIDATING');
        const validacao = validarSequencia(seq, { contrato, politica: poda, regras: ctx.regras, pedido: ctx.pedido });
        ctx.sequenciaCandidata = seq;
        ctx.tentativasPlanner.push({ ciclo: 1, tentativa: ctx.tentativasPlanner.length + 1, proposta: 'duble', validacao, fase, sequencia: seq });
        return validacao;
    };
    const entrada = { contrato, esquema };

    await teste('recusa: candidata, INVALID e UNRESOLVED nao sao decompostas, e o contexto nao muda', () => {
        const candidata = emPlanejamento('req-cand');
        julgar(candidata, SEQ);
        const invalida = emPlanejamento('req-inv');
        const r = julgar(invalida, [{ ordem: 1, item: 'Propofol', conduta: 'Titular_Vasopressor', dependeDe: [] }]);
        assert.equal(r.veredito, 'INVALID');
        avancarStatus(invalida, 'PLANNING', 'nova proposta');
        const semSolucao = emPlanejamento('req-unres');
        avancarStatus(semSolucao, 'UNRESOLVED', 'duble');

        for (const ctx of [candidata, invalida, semSolucao]) {
            const antes = { status: ctx.status, historico: ctx.historicoStatus.length };
            assert.throws(() => decomporSequencia(ctx, entrada), /o Decompositor recusou .*so uma sequencia SEQUENCE_VALID e decomposta/);
            assert.deepEqual({ status: ctx.status, historico: ctx.historicoStatus.length }, antes);
            assert.equal(ctx.contextosPI, undefined);
        }
    });

    await teste('recusa: SEQUENCE_VALID sem prova da validacao semantica — nem pela maquina de estados', () => {
        // Status forjado: a ultima proposta so passou pela leitura (fase protocolo).
        const forjada = emPlanejamento('req-forjada');
        julgar(forjada, SEQ, 'protocolo');
        forjada.sequenciaValidada = SEQ;
        forjada.status = 'SEQUENCE_VALID';
        assert.throws(() => decomporSequencia(forjada, entrada), /nao saiu VALID da validacao semantica/);
        assert.throws(() => avancarStatus(forjada, 'PI_DECOMPOSING'), /recusada/);

        // A sequencia trocada depois da validacao tambem nao passa.
        const trocada = emPlanejamento('req-trocada');
        const v = julgar(trocada, SEQ);
        trocada.sequenciaValidada = [...v.valor!];
        avancarStatus(trocada, 'SEQUENCE_VALID');
        assert.throws(() => decomporSequencia(trocada, entrada), /nao e a que a ultima validacao aprovou/);

        // E PI_DECOMPOSED so com um contexto por PI.
        const semContexto = emPlanejamento('req-sem-contexto');
        const w = julgar(semContexto, SEQ);
        semContexto.sequenciaValidada = w.valor;
        avancarStatus(semContexto, 'SEQUENCE_VALID');
        avancarStatus(semContexto, 'PI_DECOMPOSING');
        assert.throws(() => avancarStatus(semContexto, 'PI_DECOMPOSED'), /nenhum contexto de PI/);
    });

    await teste('SEQUENCE_VALID -> PI_DECOMPOSING -> PI_DECOMPOSED, com contextos e metricas no contexto da execucao', () => {
        const ctx = emPlanejamento('req-ok');
        const v = julgar(ctx, SEQ);
        ctx.sequenciaValidada = v.valor;
        avancarStatus(ctx, 'SEQUENCE_VALID');
        const contextos = decomporSequencia(ctx, entrada);
        assert.equal(ctx.status, 'PI_DECOMPOSED');
        assert.deepEqual(ctx.historicoStatus.slice(-2).map(t => `${t.de}->${t.para}`), ['SEQUENCE_VALID->PI_DECOMPOSING', 'PI_DECOMPOSING->PI_DECOMPOSED']);
        assert.equal(ctx.contextosPI, contextos);
        assert.deepEqual(contextos.map(c => c.pi), ctx.sequenciaValidada);
        assert.ok(contextos.every(c => c.metadata.requestId === 'req-ok'));
        assert.equal(ctx.metricasDecomposicao!.pis, 2);
        assert.deepEqual(ctx.resultadosPI, [], 'nenhum PI executado');
        assert.deepEqual(incoerenciasDoContexto(ctx), []);

        ctx.contextosPI = contextos.slice(0, 1);
        assert.deepEqual(incoerenciasDoContexto(ctx), ['PI_DECOMPOSED: 1 contexto(s) para 2 PI(s)']);
    });

    await teste('inconsistencia descoberta na etapa: FAILED com o motivo, e o erro sobe', () => {
        const ctx = emPlanejamento('req-falha');
        const v = julgar(ctx, SEQ);
        ctx.sequenciaValidada = v.valor;
        avancarStatus(ctx, 'SEQUENCE_VALID');
        // Um contrato que nao liga Manter_Bloqueio a decisao nenhuma: nao e o que validou.
        const outro: ContratoArtefato = { ...contrato, condutaPorDecisao: { ESCALAR_EQUIPE: 'Acionar_Equipe' } };
        assert.throws(() => decomporSequencia(ctx, { contrato: outro, esquema }), InconsistenciaDecomposicao);
        assert.equal(ctx.status, 'FAILED');
        assert.match(ctx.historicoStatus[ctx.historicoStatus.length - 1].motivo!, /^Decompositor: PI 1 \(Propofol -> Manter_Bloqueio\)/);
        assert.equal(ctx.contextosPI, undefined);
    });

    // =========================================================================
    console.log('\nSerializacao e tamanho');
    // =========================================================================

    await teste('serializacao — cada contexto atravessa JSON sem perder nada', () => {
        for (const c of decomporPIs(SEQ, kHibrido)) {
            const volta = JSON.parse(JSON.stringify(c)) as ContextoGeracaoItem;
            assert.deepStrictEqual(volta, c);
            assert.deepEqual(
                [volta.item, volta.pi, volta.conduta, volta.regras, volta.evidencias, volta.fatos, volta.decisoes, volta.valores, volta.restricoes, volta.telemetriaRelevante, volta.relacoes],
                [c.item, c.pi, c.conduta, c.regras, c.evidencias, c.fatos, c.decisoes, c.valores, c.restricoes, c.telemetriaRelevante, c.relacoes]
            );
            assert.ok(c.regras.length > 0 && c.fatos.length > 0 && Object.keys(c.telemetriaRelevante).length > 0, 'nao e um contexto vazio');
            assert.equal(montarPromptPI(volta), montarPromptPI(c), 'o prompt sai igual do contexto desserializado');
        }
    });

    await teste('tamanho — cada PI ve menos que o conhecimento global, e as metricas batem com os contextos', () => {
        const contextos = decomporPIs(SEQ, kHibrido);
        const m = medirDecomposicao(contextos, kHibrido, 0, promptSemantico);
        assert.equal(m.pis, 2);
        assert.equal(m.global.caracteresPromptSemantico, promptSemantico.length);
        for (const [i, p] of m.porPI.entries()) {
            assert.equal(p.caracteresContexto, JSON.stringify(contextos[i]).length);
            assert.equal(p.caracteresPrompt, montarPromptPI(contextos[i]).length);
            assert.ok(p.caracteresContexto < m.global.caracteresConhecimento);
            assert.ok(p.caracteresPrompt < m.global.caracteresPromptSemantico!);
            assert.ok(p.regras <= m.global.regras && p.fatos <= m.global.fatos && p.telemetria <= m.global.telemetria);
        }
        console.log(`       global: ${m.global.itens} itens, ${m.global.regras} regras Cypher, ${m.global.fatos} fatos, ` +
            `${m.global.regrasRelacionais} relacionais, ${m.global.telemetria} parametros | conhecimento ${m.global.caracteresConhecimento} car. ` +
            `| Prompt Semantico ${m.global.caracteresPromptSemantico} car.`);
        for (const p of m.porPI) {
            console.log(`       PI ${p.ordem} ${p.item} -> ${p.conduta}: ${p.regras} regras, ${p.fatos} fatos, ${p.regrasRelacionais} relacionais, ` +
                `${p.evidencias} evidencias, ${p.decisoesAdmissiveis} decisao(oes), ${p.valoresAdmissiveis} valor(es), ${p.telemetria} parametros ` +
                `| contexto ${p.caracteresContexto} car. | prompt ${p.caracteresPrompt} car.`);
        }
    });

    // =========================================================================
    console.log('\nOutros dominios');
    // =========================================================================

    await teste('fut: requer_var chega como atributo declarado, sem virar regra nem precedencia', async () => {
        const modeloFut = await loadFutModel(path.join('src', 'examples', 'fut', 'futebol.fut'));
        const cenario = JSON.parse(fs.readFileSync(path.join('src', 'examples', 'fut', 'cenarios-fut.jsonl'), 'utf-8').split('\n')[0]) as FutContext;
        const c = retrieveFutConstraints(modeloFut, cenario);
        const p = futPruningPayload(c, cenario);
        const contratoFut = montarContrato(p, condutasPorDecisaoFut(modeloFut), c.escalonamentos.map(e => `${e.destino}: ${e.detalhe}`));
        const [x] = decomporPIs([{ ordem: 1, item: 'Carga_Imprudente', conduta: 'Marcar_Penalti', dependeDe: [] }], {
            requestId: 'req-fut', dominio: 'fut', pedido: cenario.intencao ?? '', telemetria: cenario.telemetria,
            contrato: contratoFut, politica: p, regras: [], restricoes: c, esquema: esquemaDeclaradoFut(modeloFut)
        });
        assert.deepEqual(x.conduta!.atributos, { reinicio: 'PENALTI', requer_var: 'sim', justificativa_obrigatoria: 'sim', protocolo_ifab: 'Lei 14' });
        assert.deepEqual(x.relacoes, []);
        assert.deepEqual(x.decisoes.admissiveis, ['PENALTI']);
        assert.ok(montarPromptPI(x).includes('infracao: Carga_Imprudente'));
        const vista = vistaDoCenario('fut', c);
        assert.deepEqual(x.fatos, vista.fatosPorItem.Carga_Imprudente ?? []);
    });

    await teste('agro: os fatos vem das listas do dominio (produto/cultura), e a proibicao declarada chega ao PI', async () => {
        const modeloAgro = await loadAgroModel(path.join('src', 'examples', 'agro', 'lavoura.agro'));
        const cenario = JSON.parse(fs.readFileSync(path.join('src', 'examples', 'agro', 'cenarios-agro.jsonl'), 'utf-8').split('\n')[0]) as AgroContext;
        const c = retrieveAgroConstraints(modeloAgro, cenario);
        const p = agroPruningPayload(c, cenario);
        const contratoAgro = montarContrato(p, condutasPorDecisaoAgro(modeloAgro), c.escalonamentos.map(e => `${e.destino}: ${e.detalhe}`));
        const item = p.politicas.find(q => condutasDoItem(contratoAgro, q.item).length > 0 && c.proibicoes.some(x => x.produto === q.item))
            ?? p.politicas.find(q => condutasDoItem(contratoAgro, q.item).length > 0)!;
        const conduta = condutasDoItem(contratoAgro, item.item)[0];
        const [x] = decomporPIs([{ ordem: 1, item: item.item, conduta, dependeDe: [] }], {
            requestId: 'req-agro', dominio: 'agro', pedido: cenario.intencao ?? '', telemetria: cenario.telemetria,
            contrato: contratoAgro, politica: p, regras: [], restricoes: c, esquema: esquemaDeclaradoAgro(modeloAgro)
        });
        const proibicoes = c.proibicoes.filter(q => q.produto === item.item);
        assert.equal(x.fatos.filter(f => f.tipo === 'proibicao').length, proibicoes.length);
        const recomendacoes = c.recomendados.filter(r => r.produto === item.item);
        assert.deepEqual(x.fatos.filter(f => f.tipo === 'recomendacao').map(f => f.contexto), recomendacoes.map(r => r.cultura));
        assert.ok(Object.keys(x.telemetriaRelevante).every(t => t in cenario.telemetria));
        assert.ok(montarPromptPI(x).includes(`produto: ${item.item}`));
    });

    // =========================================================================
    console.log('\nNo fluxo multiagente');
    // =========================================================================

    await teste('a decomposicao nao chama modelo: depois de /generate-planner, so /generate-pi (um por PI), nem /generate-fragment', async () => {
        const recebidas: string[] = [];
        const servidor = http.createServer((req, res) => {
            recebidas.push(req.url ?? '');
            let corpo = '';
            req.on('data', parte => (corpo += parte));
            req.on('end', () => {
                const resposta = req.url === '/generate-planner'
                    ? { saida: 'PLANO 1 | Propofol | Manter_Bloqueio | [ ] 2 | Noradrenalina | Acionar_Equipe | [ 1 ] FIM', tokens_prompt: 900 }
                    : req.url === '/generate-pi'
                        ? respostaQueObedece(JSON.parse(corpo) as PedidoPIAgent)
                        : req.url === '/verify' ? RESPOSTA_VERIFY : undefined;
                res.writeHead(resposta ? 200 : 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(resposta ?? { detail: `rota inesperada: ${req.url}` }));
            });
        });
        await new Promise<void>(resolve => servidor.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;

        let fragmentos = 0;
        const motor: MotorFragmento = async () => { fragmentos++; return { fragmento: '', encerrou: true }; };
        const original = process.env.SPC_CML_DECODIFICACAO;
        process.env.SPC_CML_DECODIFICACAO = 'multiagente';
        try {
            const opts = { ...montarEntradaGeracao(CENARIO, constraints, modelo, poda, conhecimentoDe('req-fluxo')), endpoint: url, motor };
            assert.deepEqual(opts.execucao!.esquema, esquema, 'o cliente entrega o esquema declarado ao modo multiagente');
            const r = (await decodificar(opts)) as ResultadoMultiagente;
            const ctx = r.execucao;

            assert.deepEqual([ctx.historicoStatus[0].de, ...ctx.historicoStatus.map(t => t.para)], [
                'RECEIVED', 'KNOWLEDGE_RETRIEVED', 'SEMANTIC_PROMPT_READY', 'PLANNING', 'SEQUENCE_VALIDATING',
                'SEQUENCE_VALID', 'PI_DECOMPOSING', 'PI_DECOMPOSED',
                'PI_EXECUTING', 'PI_VALIDATING', 'PI_EXECUTING', 'PI_VALIDATING', 'PI_ALL_VALID', 'COMPOSING', 'GLOBAL_VALIDATING', 'COMPLETED'
            ]);
            assert.deepEqual(recebidas, ['/generate-planner', '/generate-pi', '/generate-pi', '/verify'], 'o Planner e um PI Agent por PI, nada entre eles');
            assert.equal(fragmentos, 0, 'o incremental nao gerou fragmento');
            assert.equal(ctx.contextosPI!.length, 2);
            assert.equal(ctx.resultadosPI.length, 2);
            assert.deepEqual(incoerenciasDoContexto(ctx), []);
            assert.equal(r.resultado, ctx.artefatoFinal, 'o artefato composto e o resultado');
            const resumo = JSON.parse(JSON.stringify(resumoExecucao(ctx)));
            assert.deepEqual(resumo.contextosPI, ctx.contextosPI);
            assert.equal(resumo.metricasDecomposicao.pis, 2);
        } finally {
            if (original === undefined) delete process.env.SPC_CML_DECODIFICACAO;
            else process.env.SPC_CML_DECODIFICACAO = original;
            servidor.closeAllConnections();
            servidor.close();
        }
    });

    await teste('com dubles: uma chamada ao Planner e uma por PI — a decomposicao nao acrescenta nenhuma', async () => {
        let chamadasPlanner = 0;
        const chamadasPI: PedidoPIAgent[] = [];
        const planner: MotorPlanner = async () => {
            chamadasPlanner++;
            return { saida: 'PLANO 1 | Propofol | Manter_Bloqueio | [ ] 2 | Noradrenalina | Acionar_Equipe | [ 1 ] FIM' };
        };
        const original = process.env.SPC_CML_DECODIFICACAO;
        process.env.SPC_CML_DECODIFICACAO = 'multiagente';
        try {
            const r = (await decodificar({
                ...montarEntradaGeracao(CENARIO, constraints, modelo, poda, conhecimentoDe('req-duble')),
                endpoint: 'http://127.0.0.1:9', motorPlanner: planner, motorPIAgent: piAgentQueObedece(chamadasPI),
                verificadorGramatical: verificadorQueAceita()
            })) as ResultadoMultiagente;
            assert.equal(r.execucao.status, 'COMPLETED');
            assert.equal(chamadasPlanner, 1);
            assert.deepEqual(chamadasPI.map(c => c.ordem), [1, 2]);
        } finally {
            if (original === undefined) delete process.env.SPC_CML_DECODIFICACAO;
            else process.env.SPC_CML_DECODIFICACAO = original;
        }
    });

    // Exemplo legivel da decomposicao do cenario de referencia.
    console.log('\n  --- exemplo: prompts do cenario de referencia (modo deterministico) ---');
    for (const c of decomporPIs(SEQ, k)) {
        console.log(montarPromptPI(c).split('\n').map(l => `    ${l}`).join('\n'));
        console.log('');
    }

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
