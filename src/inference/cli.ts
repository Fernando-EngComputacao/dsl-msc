/**
 * Entrada interativa unificada do SPC-CML.
 *
 * Pergunta o dominio (agricola ou clinico) e depois a fonte: rodar a bateria de
 * cenarios prontos (mesmo comportamento de `npm run batch` / `npm run batch:agro`)
 * ou digitar um comando novo no terminal.
 *
 * Um comando digitado passa primeiro por `/validar-comando`: o proprio LLM local
 * julga, sob decodificacao restrita (nunca texto livre — ver VALIDACAO_GBNF em
 * main.py), se o comando e contraditorio, ambiguo ou incompleto demais. So depois
 * de aceito ele entra na recuperacao: um embedding da intencao busca por
 * similaridade no indice vetorial do Neo4j (ver retrieverFoco/retrieverFocoAgro)
 * para achar SO os farmacos/protocolos (ou produtos/culturas) pertinentes ao que
 * foi pedido — o embedding nunca decide bloqueio, so escopo; a avaliacao de cada
 * entidade continua 100% deterministica. O Prompt Semantico final sai desse
 * subconjunto, e so entao vai para a geracao sob mascaramento de logits.
 *
 * Uso:
 *   npx tsx src/inference/cli.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import neo4j, { type Driver, type Session } from 'neo4j-driver';

import { loadModel } from '../database/neo4j.js';
import {
    retrieveConstraints,
    pruningPayload,
    retrieverFoco,
    filtrarPorFoco,
    type ClinicalContext
} from '../knowledge/graphrag.js';
import { montarPromptSemantico, gerarPlanoRestrito } from './llm-client.js';
import { rodarLote as rodarLoteUti } from './batch-client.js';

import { loadAgroModel } from '../database/neo4j-agro.js';
import {
    retrieveAgroConstraints,
    agroPruningPayload,
    retrieverFocoAgro,
    filtrarPorFocoAgro,
    type AgroContext
} from '../knowledge/graphrag-agro.js';
import {
    montarPromptSemanticoAgro,
    gerarMissaoRestrita,
    rodarLote as rodarLoteAgro
} from './agro-client.js';

import { loadFutModel } from '../database/neo4j-fut.js';
import {
    retrieveFutConstraints,
    futPruningPayload,
    retrieverFocoFut,
    filtrarPorFocoFut,
    type FutContext
} from '../knowledge/graphrag-fut.js';
import {
    montarPromptSemanticoFut,
    gerarArbitragemRestrita,
    rodarLote as rodarLoteFut
} from './fut-client.js';

const ENDPOINT = process.env.SPC_CML_ENDPOINT ?? 'http://127.0.0.1:8000';
const TIMEOUT_MS = Number(process.env.SPC_CML_TIMEOUT_MS ?? 600_000);

interface ValidacaoResposta {
    compreensivel: boolean;
    motivo: string;
}

async function validarComando(comando: string): Promise<ValidacaoResposta> {
    let response: Response;
    try {
        response = await fetch(`${ENDPOINT}/validar-comando`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ comando_humano: comando }),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch (error) {
        const causa =
            (error as Error).name === 'TimeoutError'
                ? `sem resposta em ${TIMEOUT_MS / 1000}s (ajuste SPC_CML_TIMEOUT_MS)`
                : (error as Error).message;
        throw new Error(`${ENDPOINT} inacessivel: ${causa}`);
    }
    if (!response.ok) {
        throw new Error(`${ENDPOINT} respondeu ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as ValidacaoResposta;
}

async function perguntar(rl: readline.Interface, titulo: string, opcoes: string[]): Promise<number> {
    while (true) {
        console.log(`\n${titulo}`);
        opcoes.forEach((o, i) => console.log(`  [${i + 1}] ${o}`));
        const resp = (await rl.question('> ')).trim();
        const n = Number(resp);
        if (Number.isInteger(n) && n >= 1 && n <= opcoes.length) return n;
        console.log('Opcao invalida.');
    }
}

/** Pede o comando, valida com a LLM e repete ate ser aceito (ou o usuario sair com linha vazia). */
async function digitarComandoValido(rl: readline.Interface): Promise<string | null> {
    while (true) {
        const texto = (await rl.question('\nDigite o comando (linha vazia para voltar): ')).trim();
        if (!texto) return null;

        console.log('Validando com o modelo local (a 1a chamada pode demorar — baixa/carrega o modelo)...');
        let validacao: ValidacaoResposta;
        try {
            validacao = await validarComando(texto);
        } catch (error) {
            console.log(`\nMotor indisponivel: ${(error as Error).message}`);
            console.log('Suba com: cd src/python_engine && uvicorn main:app --port 8000');
            return null;
        }

        if (!validacao.compreensivel) {
            console.log(`\nComando rejeitado pela validacao: ${validacao.motivo}`);
            console.log('Digite novamente.');
            continue;
        }
        console.log(`\nComando aceito: ${validacao.motivo}`);
        return texto;
    }
}

interface PerfilPaciente {
    paciente: string;
    populacoes: string[];
    farmacosEmUso: string[];
}

interface AmostraTelemetria {
    telemetria: Record<string, number>;
}

function linhaAleatoria<T>(caminho: string): T {
    const linhas = fs
        .readFileSync(caminho, 'utf-8')
        .split('\n')
        .filter(l => l.trim().length > 0);
    return JSON.parse(linhas[Math.floor(Math.random() * linhas.length)]) as T;
}

/**
 * Sorteia paciente e telemetria de DOIS pools independentes (400 linhas cada):
 * a fala digitada no terminal nao vem com monitor de beira-leito atras dela, e
 * "quem e o paciente" e "o que o monitor mostra agora" sao independentes entre
 * si — sortear os dois do mesmo pool acoplaria demografia a instante clinico
 * sem motivo.
 */
/**
 * Lista o foco anotando de onde cada no veio — lexical (o usuario escreveu o
 * nome), vetorial (similaridade no indice) ou grafo (entrou junto pela aresta).
 * E o que permite auditar, na propria sessao, se o subgrafo ativado corresponde
 * ao que foi pedido.
 */
function descreverFoco(nomes: Set<string>, origem: Map<string, string>): string {
    if (nomes.size === 0) return '—';
    return [...nomes].map(n => `${n} (${origem.get(n) ?? 'grafo'})`).join(', ');
}

function sortearContextoUti(
    pacientesPath: string,
    telemetriasPath: string
): Omit<ClinicalContext, 'intencao'> {
    const paciente = linhaAleatoria<PerfilPaciente>(pacientesPath);
    const { telemetria } = linhaAleatoria<AmostraTelemetria>(telemetriasPath);
    return { ...paciente, telemetria };
}

async function loopDigitarUti(
    rl: readline.Interface,
    model: Awaited<ReturnType<typeof loadModel>>,
    session: Session,
    pacientesPath: string,
    telemetriasPath: string
): Promise<void> {
    while (true) {
        const texto = await digitarComandoValido(rl);
        if (texto === null) return;

        const sorteio = sortearContextoUti(pacientesPath, telemetriasPath);
        const contexto: ClinicalContext = { ...sorteio, intencao: texto };
        console.log(
            `\nPaciente sorteado: ${contexto.paciente ?? 's/ id'} — ` +
                Object.entries(contexto.telemetria)
                    .map(([k, v]) => `${k}=${v}`)
                    .join('  ')
        );

        let constraints = retrieveConstraints(model, contexto);

        try {
            const foco = await retrieverFoco(session, texto, model);
            constraints = filtrarPorFoco(constraints, foco, model, contexto);
            console.log(
                `\nSubgrafo em foco: farmacos [${descreverFoco(foco.farmacos, foco.origem)}], ` +
                    `protocolos [${descreverFoco(foco.protocolos, foco.origem)}]`
            );
        } catch (error) {
            console.log(
                `\n(recuperacao por embedding indisponivel — usando o grafo completo: ${(error as Error).message})`
            );
        }

        const poda = pruningPayload(constraints);

        console.log('\n=== PROMPT SEMANTICO (recuperado do grafo) ===');
        console.log(montarPromptSemantico(constraints));
        console.log(`\ndecisoes admissiveis apos a poda: ${poda.acoes_permitidas.join(', ')}`);

        try {
            const resposta = await gerarPlanoRestrito(contexto, constraints);
            console.log(
                `\nPlano gerado (valido: ${resposta.valido}, ${resposta.regras_em_g_hat} regras em G_hat):`
            );
            console.log(resposta.resultado);
            if (resposta.erro) console.log(`Erro reportado: ${resposta.erro}`);
        } catch (error) {
            console.log(`\nMotor indisponivel: ${(error as Error).message}`);
        }
    }
}

interface PerfilTalhao {
    talhao: string;
    areas: string[];
    produtosEmUso: string[];
}

interface AmostraSensor {
    telemetria: Record<string, number>;
}

/**
 * Sorteia talhao e leitura de sensores de DOIS pools independentes (400 linhas
 * cada), espelhando `sortearContextoUti`: a fala digitada no terminal nao vem
 * com sensor de campo atras dela, e "qual e o talhao" e "o que o sensor mede
 * agora" sao independentes entre si.
 */
function sortearContextoAgro(talhoesPath: string, sensoresPath: string): Omit<AgroContext, 'intencao'> {
    const talhao = linhaAleatoria<PerfilTalhao>(talhoesPath);
    const { telemetria } = linhaAleatoria<AmostraSensor>(sensoresPath);
    return { ...talhao, telemetria };
}

async function loopDigitarAgro(
    rl: readline.Interface,
    model: Awaited<ReturnType<typeof loadAgroModel>>,
    session: Session,
    talhoesPath: string,
    sensoresPath: string
): Promise<void> {
    while (true) {
        const texto = await digitarComandoValido(rl);
        if (texto === null) return;

        const sorteio = sortearContextoAgro(talhoesPath, sensoresPath);
        const contexto: AgroContext = { ...sorteio, intencao: texto };
        console.log(
            `\nTalhao sorteado: ${contexto.talhao ?? 's/ id'} — ` +
                Object.entries(contexto.telemetria)
                    .map(([k, v]) => `${k}=${v}`)
                    .join('  ')
        );

        let constraints = retrieveAgroConstraints(model, contexto);

        try {
            const foco = await retrieverFocoAgro(session, texto, model);
            constraints = filtrarPorFocoAgro(constraints, foco, model, contexto);
            console.log(
                `\nSubgrafo em foco: produtos [${descreverFoco(foco.produtos, foco.origem)}], ` +
                    `culturas [${descreverFoco(foco.culturas, foco.origem)}]`
            );
        } catch (error) {
            console.log(
                `\n(recuperacao por embedding indisponivel — usando o grafo completo: ${(error as Error).message})`
            );
        }

        const poda = agroPruningPayload(constraints);

        console.log('\n=== PROMPT SEMANTICO (recuperado do grafo) ===');
        console.log(montarPromptSemanticoAgro(constraints));
        console.log(`\ndecisoes admissiveis apos a poda: ${poda.acoes_permitidas.join(', ')}`);

        try {
            const resposta = await gerarMissaoRestrita(contexto, constraints);
            console.log(
                `\nMissao gerada (valido: ${resposta.valido}, ${resposta.regras_em_g_hat} regras em G_hat):`
            );
            console.log(resposta.resultado);
            if (resposta.erro) console.log(`Erro reportado: ${resposta.erro}`);
        } catch (error) {
            console.log(`\nMotor indisponivel: ${(error as Error).message}`);
        }
    }
}

interface PerfilPartida {
    partida: string;
    contextos: string[];
    infracoesEmUso: string[];
}

interface AmostraLeituraPartida {
    telemetria: Record<string, number>;
}

/**
 * Sorteia partida e leitura de partida de DOIS pools independentes (400 linhas
 * cada), espelhando `sortearContextoUti`/`sortearContextoAgro`: a fala digitada
 * no terminal nao vem com uma leitura de partida atras dela, e "qual e a
 * partida" e "o que o placar/relogio mostram agora" sao independentes entre si.
 */
function sortearContextoFut(partidasPath: string, telemetriaPath: string): Omit<FutContext, 'intencao'> {
    const partida = linhaAleatoria<PerfilPartida>(partidasPath);
    const { telemetria } = linhaAleatoria<AmostraLeituraPartida>(telemetriaPath);
    return { ...partida, telemetria };
}

async function loopDigitarFut(
    rl: readline.Interface,
    model: Awaited<ReturnType<typeof loadFutModel>>,
    session: Session,
    partidasPath: string,
    telemetriaPath: string
): Promise<void> {
    while (true) {
        const texto = await digitarComandoValido(rl);
        if (texto === null) return;

        const sorteio = sortearContextoFut(partidasPath, telemetriaPath);
        const contexto: FutContext = { ...sorteio, intencao: texto };
        console.log(
            `\nPartida sorteada: ${contexto.partida ?? 's/ id'} — ` +
                Object.entries(contexto.telemetria)
                    .map(([k, v]) => `${k}=${v}`)
                    .join('  ')
        );

        let constraints = retrieveFutConstraints(model, contexto);

        try {
            const foco = await retrieverFocoFut(session, texto, model);
            constraints = filtrarPorFocoFut(constraints, foco, model, contexto);
            console.log(
                `\nSubgrafo em foco: infracoes [${descreverFoco(foco.infracoes, foco.origem)}], ` +
                    `lances [${descreverFoco(foco.lances, foco.origem)}]`
            );
        } catch (error) {
            console.log(
                `\n(recuperacao por embedding indisponivel — usando o grafo completo: ${(error as Error).message})`
            );
        }

        const poda = futPruningPayload(constraints);

        console.log('\n=== PROMPT SEMANTICO (recuperado do grafo) ===');
        console.log(montarPromptSemanticoFut(constraints));
        console.log(`\ndecisoes admissiveis apos a poda: ${poda.acoes_permitidas.join(', ')}`);

        try {
            const resposta = await gerarArbitragemRestrita(contexto, constraints);
            console.log(
                `\nDecisao gerada (valido: ${resposta.valido}, ${resposta.regras_em_g_hat} regras em G_hat):`
            );
            console.log(resposta.resultado);
            if (resposta.erro) console.log(`Erro reportado: ${resposta.erro}`);
        } catch (error) {
            console.log(`\nMotor indisponivel: ${(error as Error).message}`);
        }
    }
}

function abrirDriverNeo4j(): Driver {
    return neo4j.driver(
        process.env.NEO4J_URI ?? 'bolt://localhost:7687',
        neo4j.auth.basic(process.env.NEO4J_USER ?? 'neo4j', process.env.NEO4J_PASSWORD ?? '#UFG2026')
    );
}

async function main(): Promise<void> {
    const rl = readline.createInterface({ input, output });
    let driver: Driver | undefined;
    try {
        const dominio = await perguntar(rl, 'Dominio:', [
            'Agricola (pulverizacao por drone)',
            'Clinico (UTI)',
            'Arbitragem (futebol)'
        ]);

        if (dominio === 1) {
            const fonte = await perguntar(rl, 'Fonte:', [
                'Rodar os cenarios prontos do arquivo (5 casos curados)',
                'Rodar a bateria de 500 casos',
                'Digitar um comando novo'
            ]);
            const modelPath = path.join('src', 'examples', 'agro', 'lavoura.agro');
            if (fonte === 1) {
                await rodarLoteAgro(path.join('src', 'examples', 'agro', 'cenarios-agro.jsonl'), modelPath);
            } else if (fonte === 2) {
                await rodarLoteAgro(path.join('src', 'examples', 'agro', 'cenarios-agro-500.jsonl'), modelPath);
            } else {
                const model = await loadAgroModel(modelPath);
                driver = abrirDriverNeo4j();
                await loopDigitarAgro(
                    rl,
                    model,
                    driver.session(),
                    path.join('src', 'examples', 'agro', 'talhoes.jsonl'),
                    path.join('src', 'examples', 'agro', 'sensores.jsonl')
                );
            }
        } else if (dominio === 2) {
            const fonte = await perguntar(rl, 'Fonte:', [
                'Rodar os cenarios prontos do arquivo (5 casos curados)',
                'Rodar a bateria de 500 casos',
                'Digitar um comando novo'
            ]);
            const modelPath = path.join('src', 'examples', 'med', 'uti.dsl');
            if (fonte === 1) {
                await rodarLoteUti(path.join('src', 'examples', 'med', 'cenarios.jsonl'), modelPath);
            } else if (fonte === 2) {
                await rodarLoteUti(path.join('src', 'examples', 'med', 'cenarios-500.jsonl'), modelPath);
            } else {
                const model = await loadModel(modelPath);
                driver = abrirDriverNeo4j();
                await loopDigitarUti(
                    rl,
                    model,
                    driver.session(),
                    path.join('src', 'examples', 'med', 'pacientes.jsonl'),
                    path.join('src', 'examples', 'med', 'telemetrias.jsonl')
                );
            }
        } else {
            const fonte = await perguntar(rl, 'Fonte:', [
                'Rodar os cenarios prontos do arquivo (5 casos curados)',
                'Digitar um comando novo'
            ]);
            const modelPath = path.join('src', 'examples', 'fut', 'futebol.fut');
            if (fonte === 1) {
                await rodarLoteFut(path.join('src', 'examples', 'fut', 'cenarios-fut.jsonl'), modelPath);
            } else {
                const model = await loadFutModel(modelPath);
                driver = abrirDriverNeo4j();
                await loopDigitarFut(
                    rl,
                    model,
                    driver.session(),
                    path.join('src', 'examples', 'fut', 'partidas.jsonl'),
                    path.join('src', 'examples', 'fut', 'telemetria.jsonl')
                );
            }
        }
    } finally {
        rl.close();
        if (driver) await driver.close();
    }
}

main().catch(err => {
    console.error('Falha:', err.message ?? err);
    process.exit(1);
});
