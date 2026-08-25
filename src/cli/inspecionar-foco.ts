/**
 * Inspetor da recuperacao do subgrafo em foco (etapa 2 da Figura 5.1).
 *
 * Responde, para um comando qualquer e sem gastar uma geracao do LLM: QUAIS nos
 * do Grafo de Conhecimento esse pedido ativa, POR QUE cada um entrou, e o que
 * sobra no Prompt Semantico depois do filtro. E a ferramenta para auditar se o
 * embedding esta "pegando" o subgrafo certo — a pergunta que originou este
 * arquivo foi exatamente essa.
 *
 *     npm run foco:inspecionar -- agro "A cana ta com a folha fervendo, comeca o imidacloprido"
 *     npm run foco:inspecionar -- med  "aumenta a nora que a pressao caiu"
 *     npm run foco:inspecionar -- fut  "foi mao dele dentro da area"
 *
 * Com `--todos`, mostra tambem os nos que ficaram FORA do foco e o cosseno de
 * cada um, que e o que permite calibrar a margem de corte em knowledge/foco.ts.
 */

import neo4j, { type Driver, type Session } from 'neo4j-driver';

import { loadAgroModel } from '../database/neo4j-agro.js';
import { loadFutModel } from '../database/neo4j-fut.js';
import { loadModel } from '../database/neo4j.js';
import { montarPromptSemanticoAgro } from '../inference/agro-client.js';
import { montarPromptSemanticoFut } from '../inference/fut-client.js';
import { montarPromptSemantico } from '../inference/llm-client.js';
import { nomesAgro, nomesFut, nomesMed } from '../knowledge/documentos.js';
import { embedTexto } from '../knowledge/embeddings.js';
import { topKPorVetor } from '../knowledge/foco.js';
import {
    filtrarPorFocoAgro,
    retrieveAgroConstraints,
    retrieverFocoAgro,
    type AgroContext
} from '../knowledge/graphrag-agro.js';
import {
    filtrarPorFocoFut,
    retrieveFutConstraints,
    retrieverFocoFut,
    type FutContext
} from '../knowledge/graphrag-fut.js';
import {
    filtrarPorFoco,
    retrieveConstraints,
    retrieverFoco,
    type ClinicalContext
} from '../knowledge/graphrag.js';

/**
 * Telemetria neutra por dominio: o inspetor existe para olhar a RECUPERACAO, e
 * uma leitura fixa mantem a comparacao entre dois comandos honesta. Passe
 * `--telemetria '{"vento":14}'` para sobrepor os valores que interessarem.
 */
const TELEMETRIA_PADRAO: Record<string, Record<string, number>> = {
    med: { PAM: 62, FC: 98, SpO2: 94, lactato: 2.8, creatinina: 1.4, RASS: -2, glicemia: 180 },
    agro: {
        vento: 8, temperatura: 38, umidade: 56, NDVI: 0.81, umidade_foliar: 40,
        temperatura_foliar: 36, distancia_manancial: 352, distancia_cultura_sensivel: 400,
        chuva_prevista: 0, infestacao: 38
    },
    fut: {
        minuto: 67, cartoes_amarelos_jogador: 1, cartoes_amarelos_equipe: 3,
        distancia_barreira: 9, distancia_gol: 12, diferenca_gols: 1
    }
};

interface Opcoes {
    dominio: string;
    comando: string;
    todos: boolean;
    telemetria: Record<string, number>;
}

function lerArgumentos(): Opcoes {
    const args = process.argv.slice(2);
    const dominio = args[0];
    if (!dominio || !['med', 'agro', 'fut'].includes(dominio)) {
        console.error('uso: inspecionar-foco <med|agro|fut> "<comando>" [--todos] [--telemetria \'{"k":v}\']');
        process.exit(2);
    }

    let comando = '';
    let todos = false;
    let telemetria = { ...TELEMETRIA_PADRAO[dominio] };

    for (let i = 1; i < args.length; i++) {
        if (args[i] === '--todos') todos = true;
        else if (args[i] === '--telemetria') {
            telemetria = { ...telemetria, ...(JSON.parse(args[++i]) as Record<string, number>) };
        } else if (!comando) comando = args[i];
    }

    if (!comando) {
        console.error('falta o comando a inspecionar.');
        process.exit(2);
    }
    return { dominio, comando, todos, telemetria };
}

const t = (n: number): string => (n >= 0 ? ' ' : '') + n.toFixed(4);

/**
 * Ranking bruto do indice vetorial, sem nenhum corte. E a visao que mostra o
 * quanto os cossenos ficam comprimidos e, portanto, por que o corte tem de ser
 * relativo ao melhor e nao um limiar absoluto.
 */
async function rankingCompleto(
    session: Session,
    indice: string,
    rotulo: string,
    vetor: number[],
    total: number,
    emFoco: Set<string>
): Promise<void> {
    const itens = await topKPorVetor(session, indice, vetor, total);
    console.log(`\n  ranking bruto — ${rotulo}`);
    const melhor = Math.max(...itens.map(i => i.cosseno));
    for (const item of [...itens].sort((a, b) => b.cosseno - a.cosseno)) {
        const marca = emFoco.has(item.nome) ? '*' : ' ';
        console.log(
            `   ${marca} ${item.nome.padEnd(26)} cos=${t(item.cosseno)}  ` +
                `margem=${t(melhor - item.cosseno)}`
        );
    }
}

function imprimirFoco(rotulo: string, nomes: Set<string>, origem: Map<string, string>): void {
    if (nomes.size === 0) {
        console.log(`  ${rotulo}: —`);
        return;
    }
    console.log(`  ${rotulo}:`);
    for (const nome of nomes) {
        console.log(`    - ${nome.padEnd(28)} [${origem.get(nome) ?? 'grafo'}]`);
    }
}

async function main(): Promise<void> {
    const { dominio, comando, todos, telemetria } = lerArgumentos();

    const driver: Driver = neo4j.driver(
        process.env.NEO4J_URI ?? 'bolt://localhost:7687',
        neo4j.auth.basic(process.env.NEO4J_USER ?? 'neo4j', process.env.NEO4J_PASSWORD ?? '#UFG2026')
    );
    const session = driver.session();

    console.log(`dominio: ${dominio}`);
    console.log(`comando: ${comando}`);
    console.log(
        'telemetria: ' + Object.entries(telemetria).map(([k, v]) => `${k}=${v}`).join('  ')
    );

    try {
        if (dominio === 'agro') {
            const model = await loadAgroModel('src/examples/agro/lavoura.agro');
            const contexto: AgroContext = { telemetria, areas: [], produtosEmUso: [], intencao: comando };

            const semFoco = retrieveAgroConstraints(model, contexto);
            const foco = await retrieverFocoAgro(session, comando, model);
            const comFoco = filtrarPorFocoAgro(semFoco, foco, model, contexto);

            console.log('\n=== SUBGRAFO EM FOCO ===');
            imprimirFoco('culturas', foco.culturas, foco.origem);
            imprimirFoco('produtos', foco.produtos, foco.origem);

            if (todos) {
                const nomes = nomesAgro(model);
                const vetor = await embedTexto(comando);
                await rankingCompleto(session, 'cultura_embedding', 'culturas', vetor, nomes.culturas.length, foco.culturas);
                await rankingCompleto(session, 'produto_embedding', 'produtos', vetor, nomes.produtos.length, foco.produtos);
            }

            console.log('\n=== PROMPT SEMANTICO (com foco) ===');
            console.log(montarPromptSemanticoAgro(comFoco));
            console.log('\n=== POLITICAS ADMISSIVEIS ===');
            for (const [nome, p] of comFoco.politicas) {
                console.log(`  ${nome}${p.bloqueado ? ' [restrito]' : ''}: ${p.decisoes.join(', ')}`);
            }
        } else if (dominio === 'med') {
            const model = await loadModel('src/examples/med/uti.dsl');
            const contexto: ClinicalContext = {
                telemetria, populacoes: [], farmacosEmUso: [], intencao: comando
            };

            const semFoco = retrieveConstraints(model, contexto);
            const foco = await retrieverFoco(session, comando, model);
            const comFoco = filtrarPorFoco(semFoco, foco, model, contexto);

            console.log('\n=== SUBGRAFO EM FOCO ===');
            imprimirFoco('protocolos', foco.protocolos, foco.origem);
            imprimirFoco('farmacos', foco.farmacos, foco.origem);

            if (todos) {
                const nomes = nomesMed(model);
                const vetor = await embedTexto(comando);
                await rankingCompleto(session, 'protocolo_embedding', 'protocolos', vetor, nomes.protocolos.length, foco.protocolos);
                await rankingCompleto(session, 'farmaco_embedding', 'farmacos', vetor, nomes.farmacos.length, foco.farmacos);
            }

            console.log('\n=== PROMPT SEMANTICO (com foco) ===');
            console.log(montarPromptSemantico(comFoco));
            console.log('\n=== POLITICAS ADMISSIVEIS ===');
            for (const [nome, p] of comFoco.politicas) {
                console.log(`  ${nome}${p.bloqueado ? ' [restrito]' : ''}: ${p.decisoes.join(', ')}`);
            }
        } else {
            const model = await loadFutModel('src/examples/fut/futebol.fut');
            const contexto: FutContext = {
                telemetria, contextos: [], infracoesEmUso: [], intencao: comando
            };

            const semFoco = retrieveFutConstraints(model, contexto);
            const foco = await retrieverFocoFut(session, comando, model);
            const comFoco = filtrarPorFocoFut(semFoco, foco, model, contexto);

            console.log('\n=== SUBGRAFO EM FOCO ===');
            imprimirFoco('lances', foco.lances, foco.origem);
            imprimirFoco('infracoes', foco.infracoes, foco.origem);

            if (todos) {
                const nomes = nomesFut(model);
                const vetor = await embedTexto(comando);
                await rankingCompleto(session, 'lance_embedding', 'lances', vetor, nomes.lances.length, foco.lances);
                await rankingCompleto(session, 'infracao_embedding', 'infracoes', vetor, nomes.infracoes.length, foco.infracoes);
            }

            console.log('\n=== PROMPT SEMANTICO (com foco) ===');
            console.log(montarPromptSemanticoFut(comFoco));
            console.log('\n=== POLITICAS ADMISSIVEIS ===');
            for (const [nome, p] of comFoco.politicas) {
                console.log(`  ${nome}${p.bloqueado ? ' [restrito]' : ''}: ${p.decisoes.join(', ')}`);
            }
        }
    } finally {
        await session.close();
        await driver.close();
    }
}

main().catch(erro => {
    console.error(erro);
    process.exit(1);
});
