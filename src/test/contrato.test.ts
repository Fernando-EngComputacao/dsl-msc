/**
 * Verificacao da especializacao por item e do contrato do artefato.
 *
 * O caso que originou estes testes e real: para o cenario
 *
 *     PAM 52, lactato 4.2, noradrenalina JA em infusao
 *     "subo a noradrenalina em um degrau?"
 *
 * a arquitetura devolveu um plano com cinco defeitos de uma vez — INICIAR_INFUSAO
 * num farmaco que ja infundia, dose 0.4 onde o modelo declara degrau de 0.05,
 * MANTER_BLOQUEADO num farmaco que nao estava bloqueado, 0.1 U/min de
 * vasopressina (2,5x o limite rigido) e o identificador de paciente copiado do
 * exemplar few-shot. Nenhum deles era exprimivel por acidente: a poda mandava ao
 * motor TRES listas planas (acoes, itens, meios) e a gramatica montava o produto
 * cartesiano das tres.
 *
 * Cada defeito daquele plano virou um teste aqui. Nada depende de Neo4j, do
 * motor Python nem de GPU: tudo e a mesma comparacao deterministica que a
 * arquitetura usa em producao.
 */

import assert from 'node:assert/strict';

import { loadModel } from '../database/neo4j.js';
import { loadAgroModel } from '../database/neo4j-agro.js';
import { loadFutModel } from '../database/neo4j-fut.js';
import {
    lerArtefato,
    montarContrato,
    podarPorViolacoes,
    verificarContrato
} from '../knowledge/contrato.js';
import {
    condutasPorDecisaoMed,
    pruningPayload,
    retrieveConstraints,
    type ClinicalContext
} from '../knowledge/graphrag.js';
import { agroPruningPayload, retrieveAgroConstraints } from '../knowledge/graphrag-agro.js';
import { futPruningPayload, retrieveFutConstraints } from '../knowledge/graphrag-fut.js';

/** O cenario exato do caso relatado. */
const CENARIO: ClinicalContext = {
    intencao: 'PAM 52 mmHg e lactato 4.2 mmol/L: subo a noradrenalina em um degrau?',
    paciente: 'PT-2026-4001',
    telemetria: { PAM: 52, FC: 104, lactato: 4.2, RASS: -2, TFG: 106, plaquetas: 182, glicemia: 158, SpO2: 93 },
    populacoes: [],
    farmacosEmUso: ['Noradrenalina']
};

/** O plano que a arquitetura devolveu para esse cenario, tal como veio. */
const PLANO_RELATADO =
    "plano Plano_Choque_Refratario para Choque_Septico { " +
    "esquema_referencia AssistenteUTI_v2 paciente 'PT-2026-0031' " +
    "sequencia [ Iniciar_Vasopressor, Titular_Vasopressor, Manter_Bloqueio ] " +
    "ordem Noradrenalina decisao INICIAR_INFUSAO dose 0.2 mcg/kg/min via ACESSO_CENTRAL " +
    "justificativa 'PAM 52 mmHg abaixo do alvo de 65 mmHg' " +
    "ordem Vasopressina decisao MANTER_BLOQUEADO dose 0.1 U/min via ACESSO_CENTRAL " +
    "justificativa 'segunda linha poupadora de catecolamina' " +
    "ordem Noradrenalina decisao AUMENTAR_VAZAO dose 0.4 mcg/kg/min via ACESSO_CENTRAL " +
    "justificativa 'PAM 52 mmHg e lactato persistente' " +
    "auditoria 'plano ancorado no subgrafo de choque septico' }";

/** O mesmo pedido, atendido dentro do que o modelo declara. */
const PLANO_CONFORME =
    "plano Plano_Choque para Choque_Septico { " +
    "esquema_referencia AssistenteUTI_v2 paciente 'PT-2026-4001' " +
    "sequencia [ Titular_Vasopressor, Acionar_Equipe ] " +
    "ordem Noradrenalina decisao AUMENTAR_VAZAO dose 0.05 mcg/kg/min via ACESSO_CENTRAL " +
    "justificativa 'PAM 52 mmHg abaixo do alvo de 65 mmHg apos volume' " +
    "ordem Vancomicina decisao ESCALAR_EQUIPE dose 0.0 mg/kg via ACESSO_CENTRAL " +
    "justificativa 'lactato 4.2 mmol/L dispara acionamento do time de resposta rapida' " +
    "auditoria 'plano derivado sob restricao gramatical e ancoragem no grafo' }";

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

async function main(): Promise<void> {
    const model = await loadModel('src/examples/med/uti.dsl');
    const constraints = retrieveConstraints(model, CENARIO);
    const subgrafo = pruningPayload(constraints, CENARIO);
    const contrato = montarContrato(
        subgrafo,
        condutasPorDecisaoMed(model),
        constraints.escalonamentos.map(e => `${e.destino}: ${e.detalhe}`)
    );
    const politica = (item: string) => subgrafo.politicas.find(p => p.item === item)!;

    console.log('\n[politica por item — o que a poda passou a carregar]');

    await teste('farmaco em curso perde a decisao de iniciar', () => {
        const nora = politica('Noradrenalina');
        assert.ok(!nora.decisoes.includes('INICIAR_INFUSAO'),
            `Noradrenalina ja infunde e ainda admite INICIAR_INFUSAO: ${nora.decisoes.join(', ')}`);
        assert.ok(nora.decisoes.includes('AUMENTAR_VAZAO'), 'titular deveria continuar admissivel');
    });

    await teste('farmaco fora de curso perde as decisoes de continuacao', () => {
        const vaso = politica('Vasopressina');
        assert.ok(vaso.decisoes.includes('INICIAR_INFUSAO'), 'vasopressina nao esta em curso: iniciar cabe');
        assert.ok(!vaso.decisoes.includes('AUMENTAR_VAZAO'),
            'nao se titula o que nao esta correndo');
    });

    await teste('valor por decisao sai da bula, nao do LLM', () => {
        const nora = politica('Noradrenalina');
        const titular = nora.valoresPorDecisao?.['AUMENTAR_VAZAO'] ?? [];
        assert.deepEqual(titular, [{ valor: '0.05', unidade: 'mcg/kg/min' }],
            `degrau declarado e 0.05 mcg/kg/min, veio ${JSON.stringify(titular)}`);
        const manter = nora.valoresPorDecisao?.['MANTER_BLOQUEADO'] ?? [];
        assert.deepEqual(manter, [{ valor: '0.0', unidade: 'mcg/kg/min' }]);
    });

    await teste('reticulo respeita o limite rigido da bomba', () => {
        const vaso = politica('Vasopressina');
        const acima = vaso.valores.filter(v => Number(v.valor) > 0.03);
        assert.equal(acima.length, 0,
            `limite leve da vasopressina e 0.03 U/min; passaram ${JSON.stringify(acima)}`);
    });

    await teste('sujeito e contexto viajam como constantes do cenario', () => {
        assert.equal(subgrafo.constantes.sujeito, 'PT-2026-4001');
        assert.deepEqual(subgrafo.constantes.contextos, ['Choque_Septico']);
    });

    console.log('\n[contrato do artefato — o que a gramatica nao alcanca]');

    await teste('o plano relatado e reprovado', () => {
        const veredito = verificarContrato(contrato, PLANO_RELATADO);
        assert.ok(!veredito.conforme, 'o plano com cinco defeitos passou no contrato');
    });

    await teste('a primeira violacao aponta a clausula e traz reparo', () => {
        const { violacoes } = verificarContrato(contrato, PLANO_RELATADO);
        const primeira = violacoes[0];
        assert.equal(primeira.clausula, 0, 'a primeira clausula ja viola');
        assert.equal(primeira.tipo, 'decisao_inadmissivel');
        assert.deepEqual(primeira.reparo, { item: 'Noradrenalina', decisao: 'INICIAR_INFUSAO' });
    });

    await teste('identificador do sujeito copiado do exemplar e pego', () => {
        const { violacoes } = verificarContrato(contrato, PLANO_RELATADO);
        assert.ok(violacoes.some(v => v.tipo === 'sujeito_incorreto'),
            'PT-2026-0031 nao e o paciente do cenario e passou');
    });

    await teste('dose fora do degrau declarado e pega', () => {
        // Mesmo plano, sem o defeito da primeira clausula: a verificacao para na
        // primeira violacao, entao o caso do valor precisa ser isolado.
        const soDose = PLANO_RELATADO.replace(
            'ordem Noradrenalina decisao INICIAR_INFUSAO dose 0.2 mcg/kg/min via ACESSO_CENTRAL ' +
                "justificativa 'PAM 52 mmHg abaixo do alvo de 65 mmHg' ",
            ''
        ).replace(
            'ordem Vasopressina decisao MANTER_BLOQUEADO dose 0.1 U/min via ACESSO_CENTRAL ' +
                "justificativa 'segunda linha poupadora de catecolamina' ",
            ''
        );
        const { violacoes } = verificarContrato(contrato, soDose);
        const valor = violacoes.find(v => v.tipo === 'valor_inadmissivel');
        assert.ok(valor, `esperava violacao de valor, veio ${violacoes.map(v => v.tipo).join(', ')}`);
        assert.match(valor!.mensagem, /0\.4 mcg\/kg\/min/);
    });

    await teste('duas ordens para o mesmo farmaco sao pegas', () => {
        const duasNora =
            "plano P para Choque_Septico { esquema_referencia AssistenteUTI_v2 paciente 'PT-2026-4001' " +
            'sequencia [ Titular_Vasopressor ] ' +
            "ordem Noradrenalina decisao AUMENTAR_VAZAO dose 0.05 mcg/kg/min via ACESSO_CENTRAL justificativa 'titula' " +
            "ordem Noradrenalina decisao REDUZIR_VAZAO dose 0.05 mcg/kg/min via ACESSO_CENTRAL justificativa 'reduz' " +
            "auditoria 'x' }";
        const { violacoes } = verificarContrato(contrato, duasNora);
        assert.ok(violacoes.some(v => v.tipo === 'item_repetido'),
            `ordens que se cancelam passaram: ${violacoes.map(v => v.tipo).join(', ')}`);
    });

    await teste('escalonamento disparado que ninguem cobriu e pego', () => {
        const semEscalonar =
            "plano P para Choque_Septico { esquema_referencia AssistenteUTI_v2 paciente 'PT-2026-4001' " +
            'sequencia [ Titular_Vasopressor ] ' +
            "ordem Noradrenalina decisao AUMENTAR_VAZAO dose 0.05 mcg/kg/min via ACESSO_CENTRAL justificativa 'titula' " +
            "auditoria 'x' }";
        assert.ok(constraints.escalonamentos.length > 0, 'cenario deveria disparar escalonamento');
        const { violacoes } = verificarContrato(contrato, semEscalonar);
        assert.ok(violacoes.some(v => v.tipo === 'escalonamento_ignorado'));
    });

    await teste('plano conforme passa limpo', () => {
        const veredito = verificarContrato(contrato, PLANO_CONFORME);
        assert.ok(veredito.conforme,
            `plano correto reprovado: ${veredito.violacoes.map(v => v.mensagem).join(' | ')}`);
    });

    console.log('\n[realimentacao da poda]');

    await teste('violacao encolhe o subgrafo da tentativa seguinte', () => {
        // Reparo sem decisao (item repetido) retira o item inteiro: na proxima
        // tentativa a gramatica nem cita o farmaco que se contradisse.
        const duasNora =
            "plano P para Choque_Septico { esquema_referencia AssistenteUTI_v2 paciente 'PT-2026-4001' " +
            'sequencia [ Titular_Vasopressor ] ' +
            "ordem Noradrenalina decisao AUMENTAR_VAZAO dose 0.05 mcg/kg/min via ACESSO_CENTRAL justificativa 'titula' " +
            "ordem Noradrenalina decisao REDUZIR_VAZAO dose 0.05 mcg/kg/min via ACESSO_CENTRAL justificativa 'reduz' " +
            "auditoria 'x' }";
        const { violacoes } = verificarContrato(contrato, duasNora);
        const menor = podarPorViolacoes(subgrafo, violacoes);
        assert.ok(
            !menor.politicas.some(p => p.item === 'Noradrenalina'),
            'o item que se repetiu deveria sair da poda da tentativa seguinte'
        );
        assert.ok(menor.politicas.length < subgrafo.politicas.length, 'a poda nao encolheu');
    });

    await teste('reparo de decisao ja inadmissivel nao encolhe (nada a retirar)', () => {
        // Sob a gramatica especializada esta saida e inderivavel; se vier de um
        // baseline, o contrato acusa, mas nao ha o que podar — a decisao ja
        // estava fora da politica. O laco de decodificacao trata este caso
        // reprompting, nao repodando (ver decodificacao.ts).
        const { violacoes } = verificarContrato(contrato, PLANO_RELATADO);
        const menor = podarPorViolacoes(subgrafo, violacoes);
        const nora = menor.politicas.find(p => p.item === 'Noradrenalina');
        assert.ok(nora && !nora.decisoes.includes('INICIAR_INFUSAO'));
    });

    console.log('\n[o mesmo contrato nos outros dominios]');

    await teste('agro: papeis proprios, mesma maquinaria', async () => {
        const agro = await loadAgroModel('src/examples/agro/lavoura.agro');
        const ctx = {
            intencao: 'Vento de 14 km/h no talhao de soja: manda o glifosato assim mesmo.',
            talhao: 'TL-2026-4001',
            telemetria: {
                vento: 14, temperatura: 26, umidade: 77, NDVI: 0.36, umidade_foliar: 87,
                temperatura_foliar: 32, distancia_manancial: 2203, distancia_cultura_sensivel: 1196,
                chuva_prevista: 0, infestacao: 12
            },
            areas: [],
            produtosEmUso: ['Glifosato']
        };
        const c = retrieveAgroConstraints(agro, ctx);
        const poda = agroPruningPayload(c, ctx);
        const glifosato = poda.politicas.find(p => p.item === 'Glifosato')!;
        assert.equal(poda.papeis.clausula, 'aplicacao');
        assert.equal(poda.constantes.sujeito, 'TL-2026-4001');
        assert.ok(!glifosato.decisoes.includes('AUMENTAR_VAZAO'),
            'vento 14 km/h bloqueia incremento de glifosato');
    });

    await teste('fut: o minuto da marcacao e o da leitura', async () => {
        const fut = await loadFutModel('src/examples/fut/futebol.fut');
        const ctx = {
            intencao: 'Entrada violenta a 3.2 m da bola aos 41 minutos. Expulsa agora.',
            partida: 'PT-2026-4021',
            telemetria: {
                minuto_partida: 41, acrescimo: 0, cartoes_amarelos_jogador: 0,
                distancia_ultimo_defensor: 1.4, velocidade_bola: 8, distancia_gol: 52,
                jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 3, placar_diferenca: 0,
                faltas_acumuladas_time: 1, distancia_bola: 3.2
            },
            contextos: [],
            infracoesEmUso: []
        };
        const c = retrieveFutConstraints(fut, ctx);
        const poda = futPruningPayload(c, ctx);
        const entrada = poda.politicas.find(p => p.item === 'Entrada_Violenta')!;
        assert.deepEqual(entrada.valores, [{ valor: '41.0', unidade: 'min' }],
            `o minuto vem da leitura, veio ${JSON.stringify(entrada.valores)}`);
        assert.equal(poda.papeis.campoSujeito, 'partida');
    });

    console.log('\n[leitura do artefato]');

    await teste('as clausulas sao lidas pelos papeis do dominio', () => {
        const lido = lerArtefato(PLANO_RELATADO, contrato.papeis);
        assert.equal(lido.clausulas.length, 3);
        assert.equal(lido.sujeito, 'PT-2026-0031');
        assert.deepEqual(lido.sequencia, ['Iniciar_Vasopressor', 'Titular_Vasopressor', 'Manter_Bloqueio']);
        assert.equal(lido.clausulas[2].valor, '0.4');
    });

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
