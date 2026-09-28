/**
 * Validacao deterministica da sequencia do Planner
 * (`knowledge/validacao-sequencia.ts`).
 *
 * O cenario e o de referencia do projeto — PAM 52, lactato 4.8, renal cronico,
 * noradrenalina, propofol e vancomicina em curso —, com a politica inteira (sem
 * foco), e a mesma fala: "sobe a nora e aprofunda o propofol". Nele:
 *
 *   - PAM 52 < 60 bloqueia o incremento do Propofol: `Titular_Vasopressor`
 *     (AUMENTAR_VAZAO) deixa de ser realizavel POR ELE;
 *   - dois escalonamentos disparam, e `Acionar_Equipe` passa a ser obrigatoria;
 *   - o pedido cita o Propofol pelo nome.
 *
 * Nada e dublado alem do que so existe no modo hibrido (as `RegraValidada`):
 * modelo da DSL, recuperacao deterministica, poda e contrato sao os reais.
 */

import assert from 'node:assert/strict';
import * as path from 'node:path';

import { loadModel } from '../database/neo4j.js';
import {
    condutasPorDecisaoMed,
    pruningPayload,
    retrieveConstraints,
    type ClinicalContext
} from '../knowledge/graphrag.js';
import { condutasDoItem, condutasRealizaveis, estadoVazio, montarContrato } from '../knowledge/contrato.js';
import type { PIPlanejado } from '../knowledge/contrato-pi.js';
import type { PoliticaItem, SubgrafoPodado } from '../knowledge/politica.js';
import type { RegraValidada } from '../knowledge/recuperacao-cypher.js';
import { incoerencias, type ResultadoValidacao } from '../knowledge/validacao.js';
import {
    lacunasDoConhecimento,
    validarSequencia,
    type ConhecimentoDaSequencia
} from '../knowledge/validacao-sequencia.js';

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

const PEDIDO = 'A pressao ta despencando (PAM=52), sobe a nora e aprofunda o propofol';
const TELEMETRIA = { PAM: 52, FC: 145, lactato: 4.8, RASS: 2, TFG: 28, plaquetas: 45, glicemia: 210 };
const cenario = (telemetria: Record<string, number>, intencao = PEDIDO): ClinicalContext => ({
    paciente: 'PT-TESTE-0001', intencao, telemetria,
    populacoes: ['Renal_Cronico'], farmacosEmUso: ['Noradrenalina', 'Propofol', 'Vancomicina']
});

/** `[item, conduta, dependeDe?]` na ordem do plano. */
const plano = (...pares: [string, string, number[]?][]): PIPlanejado[] =>
    pares.map(([item, conduta, dependeDe], i) => ({ ordem: i + 1, item, conduta, dependeDe: dependeDe ?? [] }));

/** Uma politica com as decisoes de alguns itens trocadas — o resto intacto. */
function comDecisoes(p: SubgrafoPodado, trocas: Record<string, string[]>): SubgrafoPodado {
    const politicas: PoliticaItem[] = p.politicas.map(x => (x.item in trocas ? { ...x, decisoes: trocas[x.item] } : x));
    return { ...p, politicas };
}

function regraSemMedida(item: string, campo: string): RegraValidada {
    return {
        regraId: `Farmaco:${item}/RegraSeguranca/${campo}<60`, tipo: 'RegraSeguranca', relacao: 'BLOQUEIA_INCREMENTO',
        item, dominio: 'med', aplicavel: false, condicoesSatisfeitas: [], condicoesFalhas: [],
        lacunas: [{ campo, esperado: '< 60 mmHg', motivo: `o cenario nao mediu '${campo}'` }],
        evidencia: {}, validacaoCypher: { valida: false, motivo: 'sem evidencia', consulta: '' },
        efeito: { razao: 'hipotensao contraindica aumento de sedacao' },
        rag: { candidatoId: `Farmaco:${item}`, escore: 0.9, cosseno: 0.8, papel: 'item', posicao: 0 }
    };
}

async function main(): Promise<void> {
    const modelo = await loadModel(path.join('src', 'examples', 'med', 'uti.dsl'));
    const mapa = condutasPorDecisaoMed(modelo);

    /** O conhecimento de uma requisicao: politica, contrato, regras e pedido. */
    function conhecimento(
        telemetria: Record<string, number> = TELEMETRIA,
        opcoes: { pedido?: string; politica?: (p: SubgrafoPodado) => SubgrafoPodado; regras?: RegraValidada[] } = {}
    ): ConhecimentoDaSequencia {
        const ctx = cenario(telemetria, opcoes.pedido);
        const constraints = retrieveConstraints(modelo, ctx);
        const base = pruningPayload(constraints, ctx);
        const politica = opcoes.politica ? opcoes.politica(base) : base;
        const contrato = montarContrato(politica, mapa, constraints.escalonamentos.map(e => `${e.destino}: ${e.detalhe}`));
        return { contrato, politica, regras: opcoes.regras ?? [], pedido: ctx.intencao ?? '' };
    }

    const K = conhecimento();
    const VALIDO = plano(['Propofol', 'Manter_Bloqueio'], ['Noradrenalina', 'Acionar_Equipe', [1]]);

    await teste('pre-condicoes do cenario (se mudarem, os casos abaixo perdem o sentido)', () => {
        assert.ok(!K.contrato.politicas.get('Propofol')!.decisoes.includes('AUMENTAR_VAZAO'), 'PAM 52 bloqueia o incremento do Propofol');
        assert.ok(K.contrato.escalonamentos.length > 0, 'ha escalonamento disparado');
        assert.ok(condutasRealizaveis(K.contrato, estadoVazio()).includes('Titular_Vasopressor'), 'outro item realiza Titular_Vasopressor');
        assert.equal(lacunasDoConhecimento(K).veredito, 'VALID');
    });

    // =========================================================================
    console.log('\nExistencia');
    // =========================================================================

    await teste('item valido e conduta valida: VALID, e o valor e a propria sequencia', () => {
        const r = validarSequencia(VALIDO, K);
        assert.equal(r.veredito, 'VALID');
        assert.deepEqual(r.valor, VALIDO);
        assert.deepEqual(incoerencias(r), []);
    });

    await teste('item inexistente: item_fora_da_poda, com o nome como veio', () => {
        const r = validarSequencia(plano(['Dopamina', 'Manter_Bloqueio'], ['Propofol', 'Manter_Bloqueio'], ['Noradrenalina', 'Acionar_Equipe']), K);
        assert.equal(r.veredito, 'INVALID');
        assert.deepEqual(codigos(r), ['item_fora_da_poda']);
        assert.deepEqual([r.erros[0].pi, r.erros[0].item], [1, 'Dopamina']);
        assert.ok(r.erros[0].alternativas!.includes('Propofol'));
    });

    await teste('conduta inexistente: `marcacao` e conduta de outro dominio sao recusadas, sem aproximacao', () => {
        for (const conduta of ['marcacao', 'Marcar_Tiro_Livre_Direto', 'manter_bloqueio']) {
            const r = validarSequencia(plano(['Propofol', conduta], ['Noradrenalina', 'Acionar_Equipe']), K);
            assert.deepEqual(codigos(r), ['conduta_inexistente'], conduta);
            assert.equal(r.erros[0].conduta, conduta);
            assert.deepEqual(r.erros[0].alternativas, condutasDoItem(K.contrato, 'Propofol'));
        }
    });

    // =========================================================================
    console.log('\nCompatibilidade item x conduta');
    // =========================================================================

    await teste('par compativel: Propofol + Manter_Bloqueio', () => {
        assert.equal(validarSequencia(VALIDO, K).veredito, 'VALID');
    });

    await teste('par incompativel: Propofol + Titular_Vasopressor com PAM 52 — regra, evidencia e alternativas', () => {
        const r = validarSequencia(plano(['Propofol', 'Titular_Vasopressor'], ['Noradrenalina', 'Acionar_Equipe']), K);
        assert.deepEqual(codigos(r), ['item_conduta_incompativel']);
        const e = r.erros[0];
        assert.deepEqual([e.pi, e.item, e.conduta], [1, 'Propofol', 'Titular_Vasopressor']);
        assert.match(e.regra!, /Titular_Vasopressor exige AUMENTAR_VAZAO/);
        assert.ok(e.evidencias!.some(ev => /PAM 52 < 60/.test(ev)), 'a evidencia traz o valor medido');
        assert.deepEqual(e.alternativas, condutasDoItem(K.contrato, 'Propofol'));
    });

    await teste('conduta que nenhum item realiza: conduta_nao_realizavel', () => {
        const so = new Set(['Propofol', 'Dobutamina', 'Midazolam']);
        const k = conhecimento(TELEMETRIA, { politica: p => ({ ...p, politicas: p.politicas.filter(x => so.has(x.item)) }) });
        const r = validarSequencia(plano(['Propofol', 'Iniciar_Vasopressor'], ['Dobutamina', 'Acionar_Equipe']), k);
        assert.deepEqual(codigos(r), ['conduta_nao_realizavel']);
        assert.match(r.erros[0].regra!, /INICIAR_INFUSAO/);
    });

    // =========================================================================
    console.log('\nObrigatoriedade');
    // =========================================================================

    await teste('todas as obrigatorias presentes: VALID', () => {
        assert.equal(validarSequencia(VALIDO, K).veredito, 'VALID');
    });

    await teste('obrigatoria ausente: escalonamento_ignorado — qual conduta, qual regra, quais PIs', () => {
        const r = validarSequencia(plano(['Propofol', 'Manter_Bloqueio']), K);
        assert.deepEqual(codigos(r), ['escalonamento_ignorado']);
        const e = r.erros[0];
        assert.equal(e.conduta, 'Acionar_Equipe');
        assert.match(e.regra!, /escalonamento disparado/);
        assert.deepEqual(e.evidencias, ['PI 1: Propofol -> Manter_Bloqueio']);
        assert.ok(e.alternativas!.includes('Noradrenalina'), 'os itens que a cumprem');
    });

    await teste('obrigatoria cumprida so por par incompativel nao conta', () => {
        // Nenhum item admite ESCALAR_EQUIPE a nao ser pela politica: Dopamina nao esta nela.
        const r = validarSequencia(plano(['Propofol', 'Manter_Bloqueio'], ['Dopamina', 'Acionar_Equipe']), K);
        assert.deepEqual(codigos(r).sort(), ['escalonamento_ignorado', 'item_fora_da_poda']);
    });

    await teste('obrigatoria que nenhum item realiza: UNRESOLVED (a regra obriga o que o conhecimento nao permite)', () => {
        const semEscalar = (p: SubgrafoPodado): SubgrafoPodado =>
            ({ ...p, politicas: p.politicas.map(x => ({ ...x, decisoes: x.decisoes.filter(d => d !== 'ESCALAR_EQUIPE') })) });
        const k = conhecimento(TELEMETRIA, { politica: semEscalar });
        const lacunas = lacunasDoConhecimento(k);
        assert.equal(lacunas.veredito, 'UNRESOLVED');
        assert.deepEqual(lacunas.dadosFaltantes, ['item que realize Acionar_Equipe']);
        const r = validarSequencia(plano(['Propofol', 'Manter_Bloqueio']), k);
        assert.equal(r.veredito, 'UNRESOLVED');
        assert.deepEqual(avisos(r), ['conhecimento_insuficiente']);
    });

    // =========================================================================
    console.log('\nDuplicidade');
    // =========================================================================

    await teste('mesmo item duas vezes, com unicidade: item_repetido, com os PIs envolvidos', () => {
        const r = validarSequencia(plano(['Propofol', 'Manter_Bloqueio'], ['Propofol', 'Suspender_Farmaco'], ['Noradrenalina', 'Acionar_Equipe']), K);
        assert.deepEqual(codigos(r), ['item_repetido']);
        assert.deepEqual([r.erros[0].pi, r.erros[0].item], [2, 'Propofol']);
        assert.deepEqual(r.erros[0].evidencias, ['PI 1: Propofol -> Manter_Bloqueio', 'PI 2: Propofol -> Suspender_Farmaco']);
        const identico = validarSequencia(plano(['Propofol', 'Manter_Bloqueio'], ['Propofol', 'Manter_Bloqueio'], ['Noradrenalina', 'Acionar_Equipe']), K);
        assert.deepEqual(codigos(identico), ['item_repetido']);
    });

    await teste('repeticao permitida (caso real): a mesma conduta para itens diferentes', () => {
        const r = validarSequencia(plano(['Propofol', 'Manter_Bloqueio'], ['Heparina', 'Manter_Bloqueio'], ['Noradrenalina', 'Acionar_Equipe']), K);
        assert.equal(r.veredito, 'VALID', 'o contrato do artefato compara conjuntos de condutas');
    });

    await teste('sem unicidade no contrato, o mesmo item pode voltar', () => {
        const k = { ...K, contrato: { ...K.contrato, unicidade: false } };
        const r = validarSequencia(plano(['Propofol', 'Manter_Bloqueio'], ['Propofol', 'Suspender_Farmaco'], ['Noradrenalina', 'Acionar_Equipe']), k);
        assert.equal(r.veredito, 'VALID');
    });

    // =========================================================================
    console.log('\nOrdem');
    // =========================================================================

    await teste('ordem correta: VALID', () => assert.equal(validarSequencia(VALIDO, K).veredito, 'VALID'));

    await teste('ordem duplicada, ordem com buraco e lista fora da ordem do plano', () => {
        const dup = VALIDO.map(p => ({ ...p, ordem: 1, dependeDe: [] }));
        assert.ok(codigos(validarSequencia(dup, K)).includes('ordem_repetida'));
        const buraco = [VALIDO[0], { ...VALIDO[1], ordem: 3, dependeDe: [] }];
        assert.ok(codigos(validarSequencia(buraco, K)).includes('ordem_fora_de_sequencia'));
        // Invertida, os dois PIs estao fora de posicao — um erro por PI; nada e reordenado.
        const trocada = [{ ...VALIDO[1], dependeDe: [] }, VALIDO[0]];
        const r = validarSequencia(trocada, K);
        assert.deepEqual(codigos(r), ['ordem_fora_de_posicao', 'ordem_fora_de_posicao']);
        assert.deepEqual(r.erros.map(e => e.pi), [2, 1]);
    });

    // =========================================================================
    console.log('\nDependencias');
    // =========================================================================

    await teste('dependencia anterior: VALID; nenhuma e exigida nem inventada', () => {
        assert.deepEqual(validarSequencia(VALIDO, K).valor![1].dependeDe, [1]);
        const semDeps = plano(['Propofol', 'Manter_Bloqueio'], ['Noradrenalina', 'Acionar_Equipe']);
        assert.deepEqual(validarSequencia(semDeps, K).valor, semDeps);
    });

    await teste('dependencia futura, inexistente e propria: INVALID', () => {
        const com = (deps1: number[], deps2: number[]) =>
            plano(['Propofol', 'Manter_Bloqueio', deps1], ['Noradrenalina', 'Acionar_Equipe', deps2]);
        assert.deepEqual(codigos(validarSequencia(com([2], []), K)), ['dependencia_posterior']);
        assert.deepEqual(codigos(validarSequencia(com([], [99]), K)), ['dependencia_inexistente']);
        assert.deepEqual(codigos(validarSequencia(com([], [2]), K)), ['dependencia_propria']);
    });

    // =========================================================================
    console.log('\nPedido');
    // =========================================================================

    await teste('plano compativel com o pedido: o item citado e tratado', () => {
        assert.equal(validarSequencia(VALIDO, K).veredito, 'VALID');
    });

    await teste('plano incompativel: o pedido cita o Propofol e o plano trata so outro item', () => {
        const r = validarSequencia(plano(['Noradrenalina', 'Acionar_Equipe']), K);
        assert.deepEqual(codigos(r), ['pedido_incompativel']);
        assert.match(r.erros[0].mensagem, /Propofol/);
    });

    await teste('cobertura insuficiente: o pedido cita dois itens e o plano trata um', () => {
        const k = conhecimento(TELEMETRIA, { pedido: 'suspende o propofol e a heparina' });
        const r = validarSequencia(VALIDO, k);
        assert.deepEqual(codigos(r), ['cobertura_insuficiente']);
        assert.equal(r.erros[0].item, 'Heparina');
    });

    await teste('conhecimento insuficiente: o pedido cita um item sem conduta que o realize — UNRESOLVED', () => {
        const k = conhecimento(TELEMETRIA, {
            pedido: 'e a heparina?',
            politica: p => comDecisoes(p, { Heparina: ['SUBSTITUIR'] })
        });
        const r = validarSequencia(VALIDO, k);
        assert.equal(r.veredito, 'UNRESOLVED');
        assert.deepEqual(r.dadosFaltantes, ['conduta para Heparina']);
        assert.deepEqual(r.erros, []);
    });

    await teste('pedido sem item citado: a cobertura nao e conferivel, e isso fica como aviso', () => {
        const k = conhecimento(TELEMETRIA, { pedido: 'o paciente esta instavel, o que fazer?' });
        const r = validarSequencia(VALIDO, k);
        assert.equal(r.veredito, 'VALID');
        assert.ok(avisos(r).includes('cobertura_indeterminada'));
    });

    // =========================================================================
    console.log('\nTelemetria');
    // =========================================================================

    await teste('condicao satisfeita (PAM 52 < 60): o incremento do Propofol e INVALID', () => {
        const r = validarSequencia(plano(['Propofol', 'Titular_Vasopressor'], ['Noradrenalina', 'Acionar_Equipe']), K);
        assert.deepEqual(codigos(r), ['item_conduta_incompativel']);
    });

    await teste('condicao nao satisfeita (PAM 82): o mesmo par e VALID', () => {
        const k = conhecimento({ ...TELEMETRIA, PAM: 82 });
        const r = validarSequencia(plano(['Propofol', 'Titular_Vasopressor'], ['Noradrenalina', 'Acionar_Equipe']), k);
        assert.equal(r.veredito, 'VALID');
    });

    await teste('telemetria insuficiente (hibrido): regra de bloqueio sem a medida — UNRESOLVED so para o par que dependia dela', () => {
        const { PAM: _, ...semPam } = TELEMETRIA;
        const k = conhecimento(semPam, { regras: [regraSemMedida('Propofol', 'PAM')] });
        const incremento = validarSequencia(plano(['Propofol', 'Titular_Vasopressor'], ['Noradrenalina', 'Acionar_Equipe']), k);
        assert.equal(incremento.veredito, 'UNRESOLVED');
        assert.deepEqual(incremento.dadosFaltantes, ['telemetria.PAM']);
        assert.ok(avisos(incremento).includes('telemetria_insuficiente'));
        assert.match(incremento.promptRecomendado!, /CONHECIMENTO INSUFICIENTE/);
        // Sem incremento, a regra que nao pode ser avaliada nao decide nada.
        assert.equal(validarSequencia(VALIDO, k).veredito, 'VALID');
    });

    // =========================================================================
    console.log('\nResultado');
    // =========================================================================

    await teste('VALID, INVALID e UNRESOLVED coerentes com o contrato de ResultadoValidacao', () => {
        const valido = validarSequencia(VALIDO, K);
        const invalido = validarSequencia(plano(['Propofol', 'Titular_Vasopressor']), K);
        const { PAM: _, ...semPam } = TELEMETRIA;
        const indecidivel = validarSequencia(
            plano(['Propofol', 'Titular_Vasopressor'], ['Noradrenalina', 'Acionar_Equipe']),
            conhecimento(semPam, { regras: [regraSemMedida('Propofol', 'PAM')] })
        );
        assert.deepEqual([valido.veredito, invalido.veredito, indecidivel.veredito], ['VALID', 'INVALID', 'UNRESOLVED']);
        for (const r of [valido, invalido, indecidivel]) assert.deepEqual(incoerencias(r), []);
    });

    await teste('INVALID traz todos os erros, agrupados por PI no relatorio que vai ao Planner', () => {
        const r = validarSequencia(plano(['Propofol', 'Titular_Vasopressor'], ['Dopamina', 'Manter_Bloqueio']), K);
        assert.deepEqual(codigos(r).sort(), ['escalonamento_ignorado', 'item_conduta_incompativel', 'item_fora_da_poda']);
        const texto = r.promptRecomendado!;
        assert.match(texto, /PI 1 \(Propofol -> Titular_Vasopressor\):/);
        assert.match(texto, /PI 2 \(Dopamina -> Manter_Bloqueio\):/);
        assert.match(texto, /Plano inteiro:/);
        assert.match(texto, /condutas que Propofol pode cumprir: /);
        assert.match(texto, /itens candidatos: /);
        assert.match(texto, /falta um PI com a conduta Acionar_Equipe/);
        assert.match(texto, /itens que podem cumprir Acionar_Equipe: /);
    });

    await teste('havendo erro comprovado, INVALID prevalece sobre o que e indecidivel', () => {
        const { PAM: _, ...semPam } = TELEMETRIA;
        const k = conhecimento(semPam, { regras: [regraSemMedida('Propofol', 'PAM')] });
        const r = validarSequencia(plano(['Propofol', 'Titular_Vasopressor']), k);
        assert.equal(r.veredito, 'INVALID');
        assert.deepEqual(codigos(r), ['escalonamento_ignorado']);
        assert.ok(avisos(r).includes('telemetria_insuficiente'), 'o indecidivel fica registrado');
    });

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
