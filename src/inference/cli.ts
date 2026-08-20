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
    rodarLote as rodarLoteAgro,
    TELEMETRIA_PADRAO as TELEMETRIA_AGRO
} from './agro-client.js';

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
            const foco = await retrieverFoco(session, texto);
            constraints = filtrarPorFoco(constraints, foco);
            console.log(
                `\nFoco recuperado por embedding: farmacos [${[...foco.farmacos].join(', ')}], ` +
                    `protocolos [${[...foco.protocolos].join(', ')}]`
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

async function loopDigitarAgro(
    rl: readline.Interface,
    model: Awaited<ReturnType<typeof loadAgroModel>>,
    session: Session
): Promise<void> {
    while (true) {
        const texto = await digitarComandoValido(rl);
        if (texto === null) return;

        const contexto: AgroContext = { ...TELEMETRIA_AGRO, intencao: texto };
        let constraints = retrieveAgroConstraints(model, contexto);

        try {
            const foco = await retrieverFocoAgro(session, texto);
            constraints = filtrarPorFocoAgro(constraints, foco);
            console.log(
                `\nFoco recuperado por embedding: produtos [${[...foco.produtos].join(', ')}], ` +
                    `culturas [${[...foco.culturas].join(', ')}]`
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
            'Clinico (UTI)'
        ]);
        const fonte = await perguntar(rl, 'Fonte:', [
            'Rodar os cenarios prontos do arquivo',
            'Digitar um comando novo'
        ]);

        if (dominio === 1) {
            const modelPath = path.join('src', 'examples', 'lavoura.agro');
            if (fonte === 1) {
                await rodarLoteAgro(path.join('src', 'examples', 'prompt-agro.txt'), modelPath);
            } else {
                const model = await loadAgroModel(modelPath);
                driver = abrirDriverNeo4j();
                await loopDigitarAgro(rl, model, driver.session());
            }
        } else {
            const modelPath = path.join('src', 'examples', 'uti.dsl');
            if (fonte === 1) {
                await rodarLoteUti(path.join('src', 'examples', 'cenarios.jsonl'), modelPath);
            } else {
                const model = await loadModel(modelPath);
                driver = abrirDriverNeo4j();
                await loopDigitarUti(
                    rl,
                    model,
                    driver.session(),
                    path.join('src', 'examples', 'pacientes.jsonl'),
                    path.join('src', 'examples', 'telemetrias.jsonl')
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
