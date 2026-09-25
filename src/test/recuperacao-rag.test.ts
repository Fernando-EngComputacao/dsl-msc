/**
 * Verificacao do RAG de candidatos (`knowledge/recuperacao-rag.ts`).
 *
 * O que estes testes protegem nao e a busca — e a FRONTEIRA. RAG recupera;
 * Cypher valida. Um candidato em primeiro lugar por cosseno nao esta autorizado,
 * e um candidato ausente da lista nao esta proibido. Por isso os casos aqui
 * cobrem tanto o caminho feliz quanto a ausencia de qualquer veredito: nenhum
 * campo da saida diz "valido", nenhuma ordenacao vira escolha.
 *
 * Tudo roda com dubles injetados (`Embutidor` e `BuscaVetorial`), no mesmo
 * padrao de `incremental.test.ts`: sem Neo4j, sem motor Python, sem GPU.
 */

import assert from 'node:assert/strict';

import { construirContextoRecuperacao } from '../knowledge/recuperacao.js';
import {
    INDICES_POR_DOMINIO,
    recuperarCandidatos,
    type BuscaVetorial,
    type CandidatoRegra,
    type Embutidor
} from '../knowledge/recuperacao-rag.js';
import type { ItemPontuado } from '../knowledge/foco.js';
import type { ClinicalContext } from '../knowledge/graphrag.js';
import type { AgroContext } from '../knowledge/graphrag-agro.js';
import type { FutContext } from '../knowledge/graphrag-fut.js';

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

const MED: ClinicalContext = {
    intencao: 'avaliar hipotensao persistente',
    paciente: 'PT-2026-0031',
    telemetria: { PAM: 52, FC: 128 },
    populacoes: ['Renal_Cronico'],
    farmacosEmUso: ['Noradrenalina']
};

/** Escore do indice em [0,1]; o cosseno e o remapeamento que `foco.ts` faz. */
function achado(nome: string, escore: number, nodeId: string): ItemPontuado {
    return { nome, escore, cosseno: 2 * escore - 1, nodeId };
}

/** Duble do embedder: registra o texto recebido e devolve um vetor fixo. */
function embutidorDuble(): { embutir: Embutidor; recebidos: string[]; vetor: number[] } {
    const recebidos: string[] = [];
    const vetor = [0.1, 0.2, 0.3];
    return {
        recebidos,
        vetor,
        embutir: async texto => {
            recebidos.push(texto);
            return vetor;
        }
    };
}

/** Duble da busca vetorial: responde por indice e registra o que lhe pediram. */
function buscaDuble(porIndice: Record<string, ItemPontuado[]>): {
    busca: BuscaVetorial;
    pedidos: { indice: string; vetor: number[]; topK: number }[];
} {
    const pedidos: { indice: string; vetor: number[]; topK: number }[] = [];
    const busca: BuscaVetorial = async (indice, vetor, topK) => {
        pedidos.push({ indice, vetor, topK });
        return (porIndice[indice] ?? []).slice(0, topK);
    };
    return { busca, pedidos };
}

const BUSCA_MED: Record<string, ItemPontuado[]> = {
    farmaco_embedding: [
        achado('Noradrenalina', 0.81, '4:abc:1'),
        achado('Vasopressina', 0.74, '4:abc:2'),
        achado('Propofol', 0.66, '4:abc:3')
    ],
    protocolo_embedding: [achado('Choque_Septico', 0.78, '4:abc:9')]
};

async function main(): Promise<void> {
    console.log('\n[consultaSemantica -> embedding]');

    await teste('1+2. a consulta semantica e o que vai ao embedder, e o vetor e usado', async () => {
        const rc = construirContextoRecuperacao('med', MED);
        const emb = embutidorDuble();
        const { busca, pedidos } = buscaDuble(BUSCA_MED);

        await recuperarCandidatos(rc, busca, { embutir: emb.embutir });

        assert.equal(emb.recebidos.length, 1, 'o texto deve ser embutido uma vez so');
        assert.equal(emb.recebidos[0], rc.consultaSemantica);
        // E nao a fala crua: a etapa 2 existe justamente para enriquecer isto.
        assert.notEqual(emb.recebidos[0], rc.intencao);
        assert.match(emb.recebidos[0], /PAM 52/);
        // O ID do sujeito continua fora — ver etapa 2.
        assert.ok(!emb.recebidos[0].includes('PT-2026-0031'));

        for (const p of pedidos) assert.deepEqual(p.vetor, emb.vetor);
    });

    console.log('\n[busca vetorial -> candidatos]');

    await teste('3. consulta os indices do dominio, e nenhum outro', async () => {
        const rc = construirContextoRecuperacao('med', MED);
        const emb = embutidorDuble();
        const { busca, pedidos } = buscaDuble(BUSCA_MED);

        await recuperarCandidatos(rc, busca, { embutir: emb.embutir });

        assert.deepEqual(
            pedidos.map(p => p.indice),
            ['farmaco_embedding', 'protocolo_embedding']
        );
    });

    await teste('4. candidatos retornados dos dois papeis', async () => {
        const rc = construirContextoRecuperacao('med', MED);
        const emb = embutidorDuble();
        const { busca } = buscaDuble(BUSCA_MED);

        const candidatos = await recuperarCandidatos(rc, busca, { embutir: emb.embutir });

        assert.equal(candidatos.length, 4);
        assert.deepEqual(
            candidatos.filter(c => c.metadados.papel === 'item').map(c => c.item),
            ['Noradrenalina', 'Vasopressina', 'Propofol']
        );
        assert.deepEqual(
            candidatos.filter(c => c.metadados.papel === 'contexto').map(c => c.item),
            ['Choque_Septico']
        );
    });

    await teste('5. escore preservado exatamente como o indice devolveu', async () => {
        const rc = construirContextoRecuperacao('med', MED);
        const emb = embutidorDuble();
        const { busca } = buscaDuble(BUSCA_MED);

        const candidatos = await recuperarCandidatos(rc, busca, { embutir: emb.embutir });
        const nora = candidatos.find(c => c.item === 'Noradrenalina')!;

        assert.equal(nora.escore, 0.81, 'o escore cru nao pode ser reescalado');
        assert.ok(Math.abs(nora.cosseno - 0.62) < 1e-9, 'o cosseno acompanha, sem substituir');
        // Nenhum candidato foi descartado por piso ou margem: Propofol em 0.66
        // sobrevive mesmo 0.15 abaixo do primeiro colocado.
        assert.ok(candidatos.some(c => c.item === 'Propofol'));
    });

    await teste('6. nodeId preservado', async () => {
        const rc = construirContextoRecuperacao('med', MED);
        const emb = embutidorDuble();
        const { busca } = buscaDuble(BUSCA_MED);

        const candidatos = await recuperarCandidatos(rc, busca, { embutir: emb.embutir });
        assert.equal(candidatos.find(c => c.item === 'Noradrenalina')!.nodeId, '4:abc:1');
        assert.equal(candidatos.find(c => c.item === 'Choque_Septico')!.nodeId, '4:abc:9');
    });

    await teste('7. regraId preservado e suficiente para ancorar o Cypher seguinte', async () => {
        const rc = construirContextoRecuperacao('med', MED);
        const emb = embutidorDuble();
        const { busca } = buscaDuble(BUSCA_MED);

        const candidatos = await recuperarCandidatos(rc, busca, { embutir: emb.embutir });
        const nora = candidatos.find(c => c.item === 'Noradrenalina')!;

        assert.equal(nora.regraId, 'Farmaco:Noradrenalina');
        // A chave se decompoe no MATCH que todo Cypher do projeto usa.
        const [rotulo, nome] = nora.regraId.split(':');
        assert.equal(rotulo, nora.metadados.rotulo);
        assert.equal(nome, nora.item);
        assert.equal(
            candidatos.find(c => c.item === 'Choque_Septico')!.regraId,
            'Protocolo:Choque_Septico'
        );
    });

    await teste('8. TOP-K respeitado: por indice, e repassado a busca', async () => {
        const rc = construirContextoRecuperacao('med', MED);
        const emb = embutidorDuble();
        const { busca, pedidos } = buscaDuble(BUSCA_MED);

        const candidatos = await recuperarCandidatos(rc, busca, { embutir: emb.embutir, topK: 2 });

        assert.deepEqual(pedidos.map(p => p.topK), [2, 2]);
        assert.equal(candidatos.filter(c => c.metadados.papel === 'item').length, 2);
        assert.ok(!candidatos.some(c => c.item === 'Propofol'), 'o terceiro colocado deve cair');
        // Sem corte GLOBAL: o contexto sobrevive mesmo com escore menor que os
        // itens. Um teto sobre a lista inteira seria o RAG decidindo.
        assert.equal(candidatos.filter(c => c.metadados.papel === 'contexto').length, 1);
    });

    await teste('9. nenhum candidato: lista vazia, sem erro e sem inventar nada', async () => {
        const rc = construirContextoRecuperacao('med', MED);
        const emb = embutidorDuble();
        const { busca } = buscaDuble({});

        const candidatos = await recuperarCandidatos(rc, busca, { embutir: emb.embutir });
        assert.deepEqual(candidatos, []);
    });

    await teste('9b. consulta semantica vazia nem chega a embutir', async () => {
        const emb = embutidorDuble();
        const { busca, pedidos } = buscaDuble(BUSCA_MED);
        const vazio = { ...construirContextoRecuperacao('med', MED), consultaSemantica: '   ' };

        const candidatos = await recuperarCandidatos(vazio, busca, { embutir: emb.embutir });
        assert.deepEqual(candidatos, []);
        assert.equal(emb.recebidos.length, 0);
        assert.equal(pedidos.length, 0);
    });

    await teste('10. erro do Neo4j propaga identificando o indice', async () => {
        const rc = construirContextoRecuperacao('med', MED);
        const emb = embutidorDuble();
        const busca: BuscaVetorial = async () => {
            throw new Error('Neo4jError: index not found');
        };

        await assert.rejects(
            () => recuperarCandidatos(rc, busca, { embutir: emb.embutir }),
            /busca vetorial falhou no indice farmaco_embedding.*index not found/
        );
    });

    await teste('10b. erro do embedder propaga sem virar lista vazia', async () => {
        const rc = construirContextoRecuperacao('med', MED);
        const { busca } = buscaDuble(BUSCA_MED);
        const embutir: Embutidor = async () => {
            throw new Error('127.0.0.1:8000 inacessivel');
        };

        await assert.rejects(
            () => recuperarCandidatos(rc, busca, { embutir }),
            /inacessivel/
        );
    });

    console.log('\n[os tres dominios, a mesma maquinaria]');

    await teste('11. med: farmaco_embedding + protocolo_embedding', async () => {
        const rc = construirContextoRecuperacao('med', MED);
        const emb = embutidorDuble();
        const { busca, pedidos } = buscaDuble(BUSCA_MED);

        const candidatos = await recuperarCandidatos(rc, busca, { embutir: emb.embutir });
        assert.deepEqual(pedidos.map(p => p.indice), ['farmaco_embedding', 'protocolo_embedding']);
        assert.equal(candidatos[0].dominio, 'med');
        assert.equal(candidatos[0].regraId, 'Farmaco:Noradrenalina');
    });

    await teste('12. agro: produto_embedding + cultura_embedding', async () => {
        const agro: AgroContext = {
            intencao: 'a folha ta fervendo no talhao da cana',
            talhao: 'T-04',
            telemetria: { vento: 12 },
            areas: ['Faixa_Manancial'],
            produtosEmUso: ['Imidacloprido']
        };
        const rc = construirContextoRecuperacao('agro', agro);
        const emb = embutidorDuble();
        const { busca, pedidos } = buscaDuble({
            produto_embedding: [achado('Imidacloprido', 0.79, '4:agro:1')],
            cultura_embedding: [achado('Cana_de_Acucar', 0.83, '4:agro:7')]
        });

        const candidatos = await recuperarCandidatos(rc, busca, { embutir: emb.embutir });

        assert.deepEqual(pedidos.map(p => p.indice), ['produto_embedding', 'cultura_embedding']);
        assert.equal(candidatos.length, 2);
        // Ordenado por escore: a cultura vem antes do produto. Ordem e
        // apresentacao, nao escolha.
        assert.equal(candidatos[0].regraId, 'Cultura:Cana_de_Acucar');
        assert.equal(candidatos[1].regraId, 'Produto:Imidacloprido');
        assert.equal(candidatos[0].dominio, 'agro');
    });

    await teste('13. fut: infracao_embedding + lance_embedding', async () => {
        const fut: FutContext = {
            intencao: 'entrada dura pelas costas no meio de campo',
            partida: 'PARTIDA-2026-07',
            telemetria: { minuto: 78 },
            contextos: ['Acrescimos'],
            infracoesEmUso: ['Falta_Tatica']
        };
        const rc = construirContextoRecuperacao('fut', fut);
        const emb = embutidorDuble();
        const { busca, pedidos } = buscaDuble({
            infracao_embedding: [achado('Falta_Tatica', 0.88, '4:fut:1')],
            lance_embedding: [achado('Contra_Ataque', 0.71, '4:fut:5')]
        });

        const candidatos = await recuperarCandidatos(rc, busca, { embutir: emb.embutir });

        assert.deepEqual(pedidos.map(p => p.indice), ['infracao_embedding', 'lance_embedding']);
        assert.equal(candidatos[0].regraId, 'Infracao:Falta_Tatica');
        assert.equal(candidatos[1].regraId, 'Lance:Contra_Ataque');
        assert.equal(candidatos[0].dominio, 'fut');
    });

    await teste('13b. o mapa de indices cobre os tres dominios e bate com o sync', () => {
        // Os nomes tem de ser os mesmos que `database/neo4j*.ts` cria; errar aqui
        // devolve lista vazia em producao e nenhum erro em teste.
        assert.deepEqual(INDICES_POR_DOMINIO.med.item, { indice: 'farmaco_embedding', rotulo: 'Farmaco' });
        assert.deepEqual(INDICES_POR_DOMINIO.med.contexto, { indice: 'protocolo_embedding', rotulo: 'Protocolo' });
        assert.deepEqual(INDICES_POR_DOMINIO.agro.item, { indice: 'produto_embedding', rotulo: 'Produto' });
        assert.deepEqual(INDICES_POR_DOMINIO.agro.contexto, { indice: 'cultura_embedding', rotulo: 'Cultura' });
        assert.deepEqual(INDICES_POR_DOMINIO.fut.item, { indice: 'infracao_embedding', rotulo: 'Infracao' });
        assert.deepEqual(INDICES_POR_DOMINIO.fut.contexto, { indice: 'lance_embedding', rotulo: 'Lance' });
    });

    console.log('\n[a fronteira: RAG nao decide]');

    await teste('o candidato nao carrega veredito algum', async () => {
        const rc = construirContextoRecuperacao('med', MED);
        const emb = embutidorDuble();
        const { busca } = buscaDuble(BUSCA_MED);

        const candidatos = await recuperarCandidatos(rc, busca, { embutir: emb.embutir });
        const campos = Object.keys(candidatos[0] as unknown as Record<string, unknown>).concat(
            Object.keys(candidatos[0].metadados)
        );
        for (const proibido of ['valido', 'bloqueado', 'permitido', 'autorizado', 'decisoes', 'aprovado']) {
            assert.ok(
                !campos.includes(proibido),
                `"${proibido}" nao pode existir num candidato: RAG nao valida`
            );
        }
    });

    await teste('escore alto nao promove candidato a regra: a ordem e so ordem', async () => {
        const rc = construirContextoRecuperacao('med', MED);
        const emb = embutidorDuble();
        // Propofol em PRIMEIRO lugar por cosseno. Nada aqui o autoriza — e a
        // camada deterministica que sabe da PAM 52, e ela nao foi consultada.
        const { busca } = buscaDuble({
            farmaco_embedding: [achado('Propofol', 0.93, '4:abc:3'), achado('Noradrenalina', 0.5, '4:abc:1')],
            protocolo_embedding: []
        });

        const candidatos: CandidatoRegra[] = await recuperarCandidatos(rc, busca, { embutir: emb.embutir });

        assert.equal(candidatos[0].item, 'Propofol');
        assert.equal(candidatos.length, 2, 'o segundo colocado nao e descartado pelo primeiro');
        // Os dois saem com a MESMA natureza: candidatos. Nenhum campo distingue
        // o primeiro colocado do segundo alem do escore.
        assert.deepEqual(
            Object.keys(candidatos[0]).sort(),
            Object.keys(candidatos[1]).sort()
        );
        // E a telemetria que decidiria (PAM 52) nao foi sequer lida por esta camada.
        assert.equal(rc.contextoEstruturado.telemetria.PAM, 52);
    });

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
