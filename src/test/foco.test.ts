/**
 * Verificacao da recuperacao do subgrafo em foco (etapa 2 da Figura 5.1).
 *
 * O caso que originou estes testes: o operador escreve
 *
 *     "A cana ta com a folha fervendo, comeca o imidacloprido."
 *
 * e o Prompt Semantico volta falando de Soja e Milho. Tres defeitos somados
 * produziam isso, e cada um tem um teste aqui:
 *
 *   1. o limiar comparava o escore normalizado do indice do Neo4j contra um
 *      numero calibrado em cosseno bruto, e por isso nunca reprovava ninguem;
 *   2. o topK pedia 5 vizinhos num grafo de 3 culturas — devolvia as 3;
 *   3. a cultura nomeada era descartada quando nenhum gatilho numerico dela
 *      disparava, levando junto tudo o que ela recomenda e veta.
 *
 * A parte que exige Neo4j e o motor de embedding e pulada quando eles nao estao
 * no ar, para o teste continuar util em CI sem infraestrutura.
 */

import assert from 'node:assert/strict';

import neo4j, { type Driver } from 'neo4j-driver';

import { loadAgroModel } from '../database/neo4j-agro.js';
import { documentoCultura, documentoProduto, nomesAgro } from '../knowledge/documentos.js';
import {
    casamentoLexical,
    escoreParaCosseno,
    normalizar,
    selecionarPorSimilaridade,
    topKParaGrafo
} from '../knowledge/foco.js';
import {
    filtrarPorFocoAgro,
    retrieveAgroConstraints,
    retrieverFocoAgro,
    type AgroContext
} from '../knowledge/graphrag-agro.js';

const INTENCAO = 'A cana tá com a folha fervendo, começa o imidacloprido.';

/** A telemetria exata do relato: nenhum gatilho da cana dispara com ela. */
const CONTEXTO: AgroContext = {
    talhao: 'TL-2026-1101',
    telemetria: {
        vento: 8,
        temperatura: 38,
        umidade: 56,
        NDVI: 0.81,
        umidade_foliar: 40,
        temperatura_foliar: 36,
        distancia_manancial: 352,
        distancia_cultura_sensivel: 400,
        chuva_prevista: 0,
        infestacao: 38
    },
    areas: [],
    produtosEmUso: ['Clorpirifos', 'Nicosulfuron'],
    intencao: INTENCAO
};

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
    const model = await loadAgroModel('src/examples/agro/lavoura.agro');
    const nomes = nomesAgro(model);

    console.log('\n[normalizacao e casamento por nome]');

    await teste('normalizar remove acento e pontuacao', () => {
        assert.equal(normalizar('A cana tá com a folha fervendo!'), 'a cana ta com a folha fervendo');
        assert.equal(normalizar('Cana_de_Acucar'), 'cana de acucar');
    });

    await teste('nome escrito por extenso identifica o no', () => {
        const foco = casamentoLexical(INTENCAO, nomes.produtos);
        assert.ok(foco.has('Imidacloprido'), `esperava Imidacloprido, veio ${[...foco]}`);
        assert.ok(!foco.has('Glifosato'), 'Glifosato nao foi citado');
    });

    await teste('meio de um nome composto NAO ancora o foco', () => {
        // "cana" e so um dos tokens de Cana_de_Acucar. Aceitar meio nome exigiria
        // uma lista de palavras correntes por dominio — que e o que manteria
        // foco.ts amarrado a cada modelo. Quem resolve este caso e o indice
        // vetorial, verificado adiante em [foco ponta a ponta].
        assert.equal(casamentoLexical(INTENCAO, nomes.culturas).size, 0);
    });

    await teste('token curto nao vale como nome inteiro', () => {
        // "d" de Dois_Quatro_D nao e distintivo; sem os demais tokens, nao casa.
        assert.equal(casamentoLexical('vamos aplicar na area d', nomes.produtos).size, 0);
    });

    console.log('\n[escore do indice vetorial]');

    await teste('escoreParaCosseno desfaz a normalizacao do Neo4j', () => {
        // O indice devolve (1 + cos) / 2: 0.5 e cosseno zero, 1.0 e vetor identico.
        assert.equal(escoreParaCosseno(0.5), 0);
        assert.equal(escoreParaCosseno(1), 1);
        assert.ok(Math.abs(escoreParaCosseno(0.7139) - 0.4278) < 1e-4);
    });

    await teste('corte por margem descarta quem esta longe do melhor', () => {
        const selecionado = selecionarPorSimilaridade([
            { nome: 'Cana_de_Acucar', cosseno: 0.49 },
            { nome: 'Milho', cosseno: 0.40 },
            { nome: 'Soja', cosseno: 0.36 }
        ]);
        assert.deepEqual([...selecionado.nomes], ['Cana_de_Acucar']);
    });

    await teste('sem ninguem acima do piso, mantem o melhor', () => {
        const selecionado = selecionarPorSimilaridade([
            { nome: 'Soja', cosseno: 0.10 },
            { nome: 'Milho', cosseno: 0.05 }
        ]);
        assert.deepEqual([...selecionado.nomes], ['Soja']);
    });

    await teste('topK nao excede o tamanho do grafo', () => {
        assert.equal(topKParaGrafo(3), 3);
        assert.equal(topKParaGrafo(9), 9);
        assert.equal(topKParaGrafo(40), 10);
    });

    console.log('\n[documentos de indexacao]');

    await teste('documento da cultura carrega os produtos do subgrafo', () => {
        const cana = model.elements.find(e => (e as { name?: string }).name === 'Cana_de_Acucar');
        const doc = documentoCultura(cana as never, model);
        assert.ok(doc.includes('Cana de Acucar'), 'faltou a variante legivel do nome');
        assert.ok(doc.includes('Imidacloprido'), 'faltou o produto recomendado');
        assert.ok(doc.includes('Nicosulfuron'), 'faltou o produto vetado');
    });

    await teste('documento do produto carrega o alvo e a cultura', () => {
        const imida = model.elements.find(e => (e as { name?: string }).name === 'Imidacloprido');
        const doc = documentoProduto(imida as never, model);
        assert.ok(doc.includes('broca-da-cana'), 'faltou o alvo biologico');
        assert.ok(doc.includes('Cana de Acucar'), 'faltou a cultura que o indica');
    });

    console.log('\n[recuperacao deterministica — sem foco]');

    await teste('a cana nao tem gatilho ativo nesta telemetria', () => {
        const c = retrieveAgroConstraints(model, CONTEXTO);
        const nomesAtivos = c.culturasAtivas.map(x => x.nome);
        assert.ok(!nomesAtivos.includes('Cana_de_Acucar'), 'era esse o ponto do relato');
        assert.ok(nomesAtivos.includes('Soja') && nomesAtivos.includes('Milho'));
    });

    // ------------------------------------------------------------------ Neo4j
    const uri = process.env.NEO4J_URI ?? 'bolt://localhost:7687';
    const driver: Driver = neo4j.driver(
        uri,
        neo4j.auth.basic(process.env.NEO4J_USER ?? 'neo4j', process.env.NEO4J_PASSWORD ?? '#UFG2026')
    );

    let disponivel = true;
    try {
        await driver.verifyConnectivity();
    } catch {
        disponivel = false;
    }

    if (!disponivel) {
        console.log('\n[foco ponta a ponta] pulado — Neo4j indisponivel em ' + uri);
    } else {
        console.log('\n[foco ponta a ponta]');
        const session = driver.session();
        try {
            const foco = await retrieverFocoAgro(session, INTENCAO, model);

            await teste('a cultura em foco e a cana, e so ela', () => {
                assert.deepEqual([...foco.culturas].sort(), ['Cana_de_Acucar']);
            });

            await teste('o produto escrito na fala esta no foco', () => {
                assert.ok(foco.produtos.has('Imidacloprido'), `veio ${[...foco.produtos]}`);
            });

            await teste('a expansao pelo grafo traz o subgrafo da cana', () => {
                // recomendados pela cana + o que ela veta
                for (const esperado of ['Dois_Quatro_D', 'Azoxistrobina', 'Nicosulfuron']) {
                    assert.ok(foco.produtos.has(esperado), `faltou ${esperado} em ${[...foco.produtos]}`);
                }
            });

            await teste('produtos exclusivos de soja/milho ficam fora', () => {
                for (const fora of ['Mancozebe', 'Acefato', 'Atrazina']) {
                    assert.ok(!foco.produtos.has(fora), `${fora} nao deveria estar no foco`);
                }
            });

            const constraints = filtrarPorFocoAgro(
                retrieveAgroConstraints(model, CONTEXTO),
                foco,
                model,
                CONTEXTO
            );

            await teste('a cana entra no Prompt Semantico mesmo sem gatilho', () => {
                const nomesCultura = constraints.culturasAtivas.map(c => c.nome);
                assert.deepEqual(nomesCultura, ['Cana_de_Acucar']);
                assert.equal(constraints.culturasAtivas[0].gatilhos.length, 0);
            });

            await teste('as recomendacoes agora sao as da cana', () => {
                const produtos = constraints.recomendados.map(r => r.produto).sort();
                assert.deepEqual(produtos, ['Azoxistrobina', 'Dois_Quatro_D', 'Imidacloprido']);
                assert.ok(constraints.recomendados.every(r => r.cultura === 'Cana_de_Acucar'));
            });

            await teste('o veto da cana aparece e estreita a politica', () => {
                const veto = constraints.vetados.find(v => v.produto === 'Nicosulfuron');
                assert.ok(veto, `esperava veto de Nicosulfuron, veio ${JSON.stringify(constraints.vetados)}`);
                const policy = constraints.politicas.get('Nicosulfuron');
                assert.ok(policy?.bloqueado, 'o veto tem de bloquear a politica');
                assert.ok(
                    !policy?.decisoes.includes('INICIAR_APLICACAO'),
                    'o foco so pode tirar decisoes, e esta tinha de sair'
                );
            });

            await teste('nada de Soja ou Milho sobra no prompt', () => {
                const texto = JSON.stringify({
                    culturas: constraints.culturasAtivas,
                    recomendados: constraints.recomendados,
                    vetados: constraints.vetados,
                    escalonamentos: constraints.escalonamentos
                });
                assert.ok(!texto.includes('Soja'), 'Soja vazou para o prompt');
                assert.ok(!texto.includes('Milho'), 'Milho vazou para o prompt');
            });
        } finally {
            await session.close();
        }
    }

    await driver.close();

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(erro => {
    console.error(erro);
    process.exit(1);
});
