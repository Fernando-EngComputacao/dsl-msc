/**
 * Ponte HTTP entre o front-end de chat (Vue, projeto separado em `web-chat/`)
 * e a mesma logica que o CLI interativo usa (`src/inference/cli.ts`):
 * validacao -> sorteio de paciente/talhao+telemetria -> recuperacao no grafo
 * -> foco por embedding -> geracao restrita.
 *
 * Sem framework HTTP (nao adiciona dependencia ao projeto raiz) — so
 * `node:http` com um roteador minimo, propositalmente pequeno.
 *
 * Uso:
 *   npx tsx src/web/server.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import neo4j, { type Driver } from 'neo4j-driver';

import { loadModel } from '../database/neo4j.js';
import {
    retrieveConstraints,
    pruningPayload,
    retrieverFoco,
    filtrarPorFoco,
    type ClinicalContext
} from '../knowledge/graphrag.js';
import { montarPromptSemantico, gerarPlanoRestrito } from '../inference/llm-client.js';

import { loadAgroModel } from '../database/neo4j-agro.js';
import {
    retrieveAgroConstraints,
    agroPruningPayload,
    retrieverFocoAgro,
    filtrarPorFocoAgro,
    type AgroContext
} from '../knowledge/graphrag-agro.js';
import { montarPromptSemanticoAgro, gerarMissaoRestrita } from '../inference/agro-client.js';

const ENGINE = process.env.SPC_CML_ENDPOINT ?? 'http://127.0.0.1:8000';
// Um motor por dominio: main.py fixa a gramatica na subida, e o chat oferece med e
// agro lado a lado. Sem SPC_CML_ENDPOINT_AGRO os dois caem no mesmo motor, que e o
// comportamento de quem sobe so um — util, mas ai o outro dominio responde 422
// ("a poda eliminou o simbolo inicial") em vez de gerar contra a gramatica errada.
const ENGINE_AGRO = process.env.SPC_CML_ENDPOINT_AGRO ?? ENGINE;

function motorDoDominio(dominio: 'med' | 'agro'): string {
    return dominio === 'agro' ? ENGINE_AGRO : ENGINE;
}
const TIMEOUT_MS = Number(process.env.SPC_CML_TIMEOUT_MS ?? 600_000);
const PORT = Number(process.env.SPC_CML_WEB_PORT ?? 4000);
const ORIGEM_PERMITIDA = process.env.SPC_CML_WEB_ORIGIN ?? '*';

interface ValidacaoResposta {
    compreensivel: boolean;
    motivo: string;
}

async function validarComando(comando: string, motor: string): Promise<ValidacaoResposta> {
    let response: Response;
    try {
        response = await fetch(`${motor}/validar-comando`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ comando_humano: comando }),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch (error) {
        const causa =
            (error as Error).name === 'TimeoutError'
                ? `sem resposta em ${TIMEOUT_MS / 1000}s`
                : (error as Error).message;
        throw new Error(`motor (${motor}) inacessivel: ${causa}`);
    }
    if (!response.ok) {
        throw new Error(`motor respondeu ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as ValidacaoResposta;
}

function linhaAleatoria<T>(caminho: string): T {
    const linhas = fs
        .readFileSync(caminho, 'utf-8')
        .split('\n')
        .filter(l => l.trim().length > 0);
    return JSON.parse(linhas[Math.floor(Math.random() * linhas.length)]) as T;
}

interface PerfilPaciente {
    paciente: string;
    populacoes: string[];
    farmacosEmUso: string[];
}

interface PerfilTalhao {
    talhao: string;
    areas: string[];
    produtosEmUso: string[];
}

interface AmostraTelemetria {
    telemetria: Record<string, number>;
}

const PACIENTES_PATH = path.join('src', 'examples', 'med', 'pacientes.jsonl');
const TELEMETRIAS_PATH = path.join('src', 'examples', 'med', 'telemetrias.jsonl');
const TALHOES_PATH = path.join('src', 'examples', 'agro', 'talhoes.jsonl');
const SENSORES_PATH = path.join('src', 'examples', 'agro', 'sensores.jsonl');

console.log('Carregando modelo clinico (uti.dsl)...');
const modeloMed = await loadModel(path.join('src', 'examples', 'med', 'uti.dsl'));
console.log('Carregando modelo agricola (lavoura.agro)...');
const modeloAgro = await loadAgroModel(path.join('src', 'examples', 'agro', 'lavoura.agro'));

const driver: Driver = neo4j.driver(
    process.env.NEO4J_URI ?? 'bolt://localhost:7687',
    neo4j.auth.basic(process.env.NEO4J_USER ?? 'neo4j', process.env.NEO4J_PASSWORD ?? '#UFG2026')
);

interface RespostaComando {
    aceito: boolean;
    motivoValidacao?: string;
    sorteio?: Record<string, unknown>;
    foco?: { farmacos?: string[]; protocolos?: string[]; produtos?: string[]; culturas?: string[] } | null;
    focoIndisponivel?: string;
    promptSemantico?: string;
    decisoesAdmissiveis?: string[];
    resultado?: string;
    valido?: boolean;
    erroMotor?: string | null;
    regrasEmGHat?: number;
}

type EmitirEstagio = (texto: string) => void;

async function processarMed(texto: string, estagio: EmitirEstagio): Promise<RespostaComando> {
    estagio('Sorteando paciente e telemetria…');
    const paciente = linhaAleatoria<PerfilPaciente>(PACIENTES_PATH);
    const { telemetria } = linhaAleatoria<AmostraTelemetria>(TELEMETRIAS_PATH);
    const contexto: ClinicalContext = { ...paciente, telemetria, intencao: texto };

    estagio('Buscando regras no grafo de conhecimento…');
    let constraints = retrieveConstraints(modeloMed, contexto);
    estagio(
        `Regras recuperadas: ${constraints.protocolosAtivos.length} protocolos ativos, ` +
            `${constraints.bloqueios.length} bloqueios, ${constraints.vetados.length} vetos`
    );

    let foco: RespostaComando['foco'] = null;
    let focoIndisponivel: string | undefined;

    estagio('Calculando foco por embedding no subgrafo…');
    const session = driver.session();
    try {
        const f = await retrieverFoco(session, texto);
        constraints = filtrarPorFoco(constraints, f);
        foco = { farmacos: [...f.farmacos], protocolos: [...f.protocolos] };
        estagio(`Foco recuperado: farmacos [${foco.farmacos?.join(', ') || '—'}], protocolos [${foco.protocolos?.join(', ') || '—'}]`);
    } catch (error) {
        focoIndisponivel = (error as Error).message;
        estagio('Foco por embedding indisponível — seguindo com o grafo completo');
    } finally {
        await session.close();
    }

    const poda = pruningPayload(constraints);
    const promptSemantico = montarPromptSemantico(constraints);

    estagio('Iniciando Grammar Prompting (geração restrita por gramática)…');
    const resposta = await gerarPlanoRestrito(contexto, constraints);
    estagio('Plano gerado.');

    return {
        aceito: true,
        sorteio: { paciente: contexto.paciente, telemetria, populacoes: paciente.populacoes, farmacosEmUso: paciente.farmacosEmUso },
        foco,
        focoIndisponivel,
        promptSemantico,
        decisoesAdmissiveis: poda.acoes_permitidas,
        resultado: resposta.resultado,
        valido: resposta.valido,
        erroMotor: resposta.erro,
        regrasEmGHat: resposta.regras_em_g_hat
    };
}

async function processarAgro(texto: string, estagio: EmitirEstagio): Promise<RespostaComando> {
    estagio('Sorteando talhão e leitura de sensores…');
    const talhao = linhaAleatoria<PerfilTalhao>(TALHOES_PATH);
    const { telemetria } = linhaAleatoria<AmostraTelemetria>(SENSORES_PATH);
    const contexto: AgroContext = { ...talhao, telemetria, intencao: texto };

    estagio('Buscando regras no grafo de conhecimento…');
    let constraints = retrieveAgroConstraints(modeloAgro, contexto);
    estagio(
        `Regras recuperadas: ${constraints.culturasAtivas.length} culturas ativas, ` +
            `${constraints.bloqueios.length} bloqueios, ${constraints.vetados.length} vetos`
    );

    let foco: RespostaComando['foco'] = null;
    let focoIndisponivel: string | undefined;

    estagio('Calculando foco por embedding no subgrafo…');
    const session = driver.session();
    try {
        const f = await retrieverFocoAgro(session, texto);
        constraints = filtrarPorFocoAgro(constraints, f);
        foco = { produtos: [...f.produtos], culturas: [...f.culturas] };
        estagio(`Foco recuperado: produtos [${foco.produtos?.join(', ') || '—'}], culturas [${foco.culturas?.join(', ') || '—'}]`);
    } catch (error) {
        focoIndisponivel = (error as Error).message;
        estagio('Foco por embedding indisponível — seguindo com o grafo completo');
    } finally {
        await session.close();
    }

    const poda = agroPruningPayload(constraints);
    const promptSemantico = montarPromptSemanticoAgro(constraints);

    estagio('Iniciando Grammar Prompting (geração restrita por gramática)…');
    const resposta = await gerarMissaoRestrita(contexto, constraints);
    estagio('Missão gerada.');

    return {
        aceito: true,
        sorteio: { talhao: contexto.talhao, telemetria, areas: talhao.areas, produtosEmUso: talhao.produtosEmUso },
        foco,
        focoIndisponivel,
        promptSemantico,
        decisoesAdmissiveis: poda.acoes_permitidas,
        resultado: resposta.resultado,
        valido: resposta.valido,
        erroMotor: resposta.erro,
        regrasEmGHat: resposta.regras_em_g_hat
    };
}

function lerCorpo(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let corpo = '';
        req.on('data', chunk => (corpo += chunk));
        req.on('end', () => resolve(corpo));
        req.on('error', reject);
    });
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
    const texto = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': ORIGEM_PERMITIDA,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(texto);
}

const servidor = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        jsonResponse(res, 204, null);
        return;
    }

    try {
        if (req.method === 'GET' && req.url === '/api/dominios') {
            jsonResponse(res, 200, [
                { id: 'med', nome: 'Clínico (UTI)', descricao: 'SPC-CML sobre uti.dsl' },
                { id: 'agro', nome: 'Agrícola (drone)', descricao: 'SPC-CML sobre lavoura.agro' }
            ]);
            return;
        }

        if (req.method === 'GET' && req.url === '/api/health') {
            jsonResponse(res, 200, { status: 'ok' });
            return;
        }

        if (req.method === 'POST' && req.url === '/api/comando') {
            const corpo = JSON.parse((await lerCorpo(req)) || '{}') as { dominio?: string; texto?: string };
            const dominio = corpo.dominio;
            const texto = (corpo.texto ?? '').trim();

            if (dominio !== 'med' && dominio !== 'agro') {
                jsonResponse(res, 400, { erro: "dominio deve ser 'med' ou 'agro'" });
                return;
            }
            if (!texto) {
                jsonResponse(res, 400, { erro: 'texto vazio' });
                return;
            }

            // SSE: o front-end acompanha em tempo real por onde o fluxo esta passando
            // (validacao -> sorteio -> grafo -> embedding -> grammar prompting).
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                'Access-Control-Allow-Origin': ORIGEM_PERMITIDA
            });
            const emitir = (evento: string, dados: unknown): void => {
                res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);
            };
            const estagio: EmitirEstagio = texto => emitir('estagio', { texto });

            try {
                estagio('Validando comando com o modelo local…');
                const validacao = await validarComando(texto, motorDoDominio(dominio));

                if (!validacao.compreensivel) {
                    emitir('final', { aceito: false, motivoValidacao: validacao.motivo });
                    res.end();
                    return;
                }

                const resultado =
                    dominio === 'med' ? await processarMed(texto, estagio) : await processarAgro(texto, estagio);
                emitir('final', { ...resultado, motivoValidacao: validacao.motivo });
            } catch (error) {
                emitir('erro', { erro: (error as Error).message });
            } finally {
                res.end();
            }
            return;
        }

        jsonResponse(res, 404, { erro: 'rota nao encontrada' });
    } catch (error) {
        jsonResponse(res, 500, { erro: (error as Error).message });
    }
});

servidor.listen(PORT, () => {
    console.log(`API do SPC-CML no ar em http://localhost:${PORT}`);
    console.log(`  GET  /api/dominios`);
    console.log(`  POST /api/comando   { dominio: 'med'|'agro', texto: string }  (SSE: event "estagio"*, "final"|"erro")`);
});

process.on('SIGINT', async () => {
    await driver.close();
    process.exit(0);
});
