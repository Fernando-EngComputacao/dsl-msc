/**
 * Ponte HTTP entre o front-end de chat (Vue, projeto separado em `web-chat/`)
 * e a mesma logica que o CLI interativo usa (`src/inference/cli.ts`): sorteio
 * de paciente/talhao+telemetria -> recuperacao no grafo -> foco por embedding
 * -> geracao restrita.
 *
 * A validacao PRECISA vir depois do grafo (usando-o como contexto), nunca
 * antes — julgar a fala isolada faz o modelo local rejeitar comandos corretos
 * (ex.: "RASS -5, reduz a infusao" parece contraditorio sem saber que RASS -5
 * e sedacao profunda) e, na pratica, engole o primeiro estagio visivel do
 * front-end com uma chamada de LLM antes mesmo do grafo ser consultado. Por
 * ora ela fica DESLIGADA (ver VALIDACAO_ATIVA) — reativar exige tambem passar
 * o Prompt Semantico como contexto pro /validar-comando, nao só o texto.
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

import { loadFutModel } from '../database/neo4j-fut.js';
import {
    retrieveFutConstraints,
    futPruningPayload,
    retrieverFocoFut,
    filtrarPorFocoFut,
    type FutContext
} from '../knowledge/graphrag-fut.js';
import { montarPromptSemanticoFut, gerarArbitragemRestrita } from '../inference/fut-client.js';

import { textoGerado } from '../inference/avaliar.js';
import {
    detalheNaoAvaliado,
    detalheJulgado,
    agregarMetricas,
    parearRegistros,
    sinaisDe,
    listaDe,
    type RegistroAvaliarGrafo,
    type DetalheLado,
    type DetalheLinha,
    type ResultadoAvaliacaoGrafo
} from '../inference/avaliar-grafo.js';

const ENGINE = process.env.SPC_CML_ENDPOINT ?? 'http://127.0.0.1:8000';
// Um motor por dominio: main.py fixa a gramatica na subida, e o chat oferece os
// tres lado a lado. Sem SPC_CML_ENDPOINT_AGRO/SPC_CML_ENDPOINT_FUT os dominios
// sem endpoint proprio caem no mesmo motor, que e o comportamento de quem sobe
// so um — util, mas ai o outro dominio responde 422 ("a poda eliminou o simbolo
// inicial") em vez de gerar contra a gramatica errada.
const ENGINE_AGRO = process.env.SPC_CML_ENDPOINT_AGRO ?? ENGINE;
const ENGINE_FUT = process.env.SPC_CML_ENDPOINT_FUT ?? ENGINE;

const TIMEOUT_MS = Number(process.env.SPC_CML_TIMEOUT_MS ?? 600_000);
const PORT = Number(process.env.SPC_CML_WEB_PORT ?? 4000);
const ORIGEM_PERMITIDA = process.env.SPC_CML_WEB_ORIGIN ?? '*';

// Desligada por padrao: ver o comentario no topo do arquivo. Reativar com
// SPC_CML_VALIDACAO_ATIVA=true.
const VALIDACAO_ATIVA = process.env.SPC_CML_VALIDACAO_ATIVA === 'true';

interface ValidacaoResposta {
    compreensivel: boolean;
    motivo: string;
}

async function validarComando(comando: string, contextoNeo4j: string, motor: string): Promise<ValidacaoResposta> {
    let response: Response;
    try {
        response = await fetch(`${motor}/validar-comando`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ comando_humano: comando, contexto_neo4j: contextoNeo4j }),
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

interface JulgamentoPlano {
    correto: boolean;
    motivo: string;
}

/** Julga um plano JÁ GERADO contra o Prompt Semântico recuperado do grafo para
 *  o cenário dele — usado pela avaliação em lote (ver `avaliarComGrafo`), não
 *  pelo fluxo de geração. `sinal` permite cancelar um julgamento em andamento
 *  quando o usuário interrompe a avaliação (ver a rota /api/avaliar). */
async function validarPlanoComGrafo(plano: string, contextoNeo4j: string, intencao: string, motor: string, sinal: AbortSignal): Promise<JulgamentoPlano> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const combinado = new AbortController();
    const abortar = (): void => combinado.abort();
    timeout.addEventListener('abort', abortar);
    sinal.addEventListener('abort', abortar);

    let response: Response;
    try {
        response = await fetch(`${motor}/validar-plano`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ plano, contexto_neo4j: contextoNeo4j, intencao }),
            signal: combinado.signal
        });
    } catch (error) {
        if (sinal.aborted) throw error;
        const causa = timeout.aborted ? `sem resposta em ${TIMEOUT_MS / 1000}s` : (error as Error).message;
        throw new Error(`motor (${motor}) inacessivel: ${causa}`);
    } finally {
        timeout.removeEventListener('abort', abortar);
        sinal.removeEventListener('abort', abortar);
    }
    if (!response.ok) {
        throw new Error(`motor respondeu ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as JulgamentoPlano;
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

interface PerfilPartida {
    partida: string;
    contextos: string[];
    infracoesEmUso: string[];
}

interface AmostraTelemetria {
    telemetria: Record<string, number>;
}

const PACIENTES_PATH = path.join('src', 'examples', 'med', 'pacientes.jsonl');
const TELEMETRIAS_PATH = path.join('src', 'examples', 'med', 'telemetrias.jsonl');
const TALHOES_PATH = path.join('src', 'examples', 'agro', 'talhoes.jsonl');
const SENSORES_PATH = path.join('src', 'examples', 'agro', 'sensores.jsonl');
const PARTIDAS_PATH = path.join('src', 'examples', 'fut', 'partidas.jsonl');
const LEITURAS_PARTIDA_PATH = path.join('src', 'examples', 'fut', 'telemetria.jsonl');

console.log('Carregando modelo clinico (uti.dsl)...');
const modeloMed = await loadModel(path.join('src', 'examples', 'med', 'uti.dsl'));
console.log('Carregando modelo agricola (lavoura.agro)...');
const modeloAgro = await loadAgroModel(path.join('src', 'examples', 'agro', 'lavoura.agro'));
console.log('Carregando modelo de arbitragem (futebol.fut)...');
const modeloFut = await loadFutModel(path.join('src', 'examples', 'fut', 'futebol.fut'));

const driver: Driver = neo4j.driver(
    process.env.NEO4J_URI ?? 'bolt://localhost:7687',
    neo4j.auth.basic(process.env.NEO4J_USER ?? 'neo4j', process.env.NEO4J_PASSWORD ?? '#UFG2026')
);

interface RespostaComando {
    aceito: boolean;
    motivoValidacao?: string;
    sorteio?: Record<string, unknown>;
    foco?: {
        farmacos?: string[];
        protocolos?: string[];
        produtos?: string[];
        culturas?: string[];
        infracoes?: string[];
        lances?: string[];
    } | null;
    focoIndisponivel?: string;
    promptSemantico?: string;
    decisoesAdmissiveis?: string[];
    resultado?: string;
    valido?: boolean;
    erroMotor?: string | null;
    regrasEmGHat?: number;
}

type EmitirEstagio = (texto: string) => Promise<void>;

/**
 * Lista o foco anotando de onde cada no veio — lexical (o usuario escreveu o
 * nome), vetorial (similaridade no indice) ou grafo (entrou junto pela aresta).
 * E o que permite auditar, na propria interface, se o subgrafo ativado
 * corresponde ao que foi pedido.
 */
function descreverFoco(nomes: Set<string>, origem: Map<string, string>): string {
    if (nomes.size === 0) return '—';
    return [...nomes].map(n => `${n} (${origem.get(n) ?? 'grafo'})`).join(', ');
}

/** Etapas locais (sorteio/grafo/embedding) terminam em milissegundos — sem uma
 *  pausa minima, o usuario nunca chega a ver a maioria delas piscar na tela. */
const PAUSA_ESTAGIO_MS = 450;
const pausa = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function processarMed(
    texto: string,
    estagio: EmitirEstagio,
    contextoForcado?: Record<string, unknown>
): Promise<RespostaComando> {
    let telemetria: Record<string, number>;
    let contexto: ClinicalContext;
    if (contextoForcado) {
        await estagio('Usando cenário do lote…');
        telemetria = (contextoForcado.telemetria as Record<string, number>) ?? {};
        contexto = {
            paciente: contextoForcado.paciente as string | undefined,
            populacoes: (contextoForcado.populacoes as string[]) ?? [],
            farmacosEmUso: (contextoForcado.farmacosEmUso as string[]) ?? [],
            telemetria,
            intencao: texto
        };
    } else {
        await estagio('Sorteando paciente e telemetria…');
        const paciente = linhaAleatoria<PerfilPaciente>(PACIENTES_PATH);
        telemetria = linhaAleatoria<AmostraTelemetria>(TELEMETRIAS_PATH).telemetria;
        contexto = { ...paciente, telemetria, intencao: texto };
    }

    await estagio('Buscando regras no grafo de conhecimento…');
    let constraints = retrieveConstraints(modeloMed, contexto);
    await estagio(
        `Regras recuperadas: ${constraints.protocolosAtivos.length} protocolos ativos, ` +
            `${constraints.bloqueios.length} bloqueios, ${constraints.vetados.length} vetos`
    );

    let foco: RespostaComando['foco'] = null;
    let focoIndisponivel: string | undefined;

    await estagio('Calculando foco por embedding no subgrafo…');
    const session = driver.session();
    try {
        const f = await retrieverFoco(session, texto, modeloMed);
        constraints = filtrarPorFoco(constraints, f, modeloMed, contexto);
        foco = { farmacos: [...f.farmacos], protocolos: [...f.protocolos] };
        await estagio(
            `Foco recuperado: farmacos [${descreverFoco(f.farmacos, f.origem)}], ` +
                `protocolos [${descreverFoco(f.protocolos, f.origem)}]`
        );
    } catch (error) {
        focoIndisponivel = (error as Error).message;
        await estagio('Foco por embedding indisponível — seguindo com o grafo completo');
    } finally {
        await session.close();
    }

    const poda = pruningPayload(constraints);
    const promptSemantico = montarPromptSemantico(constraints);
    const sorteio = { paciente: contexto.paciente, telemetria, populacoes: contexto.populacoes, farmacosEmUso: contexto.farmacosEmUso };

    let motivoValidacao: string | undefined;
    if (VALIDACAO_ATIVA) {
        await estagio('Validando comando com o modelo local (usando o grafo recuperado)…');
        const validacao = await validarComando(texto, promptSemantico, ENGINE);
        motivoValidacao = validacao.motivo;
        if (!validacao.compreensivel) {
            return { aceito: false, motivoValidacao, sorteio, foco, focoIndisponivel, promptSemantico };
        }
    }

    await estagio('Iniciando Grammar Prompting (geração restrita por gramática)…');
    const resposta = await gerarPlanoRestrito(contexto, constraints);
    await estagio('Plano gerado.');

    return {
        aceito: true,
        motivoValidacao,
        sorteio,
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

async function processarAgro(
    texto: string,
    estagio: EmitirEstagio,
    contextoForcado?: Record<string, unknown>
): Promise<RespostaComando> {
    let telemetria: Record<string, number>;
    let contexto: AgroContext;
    if (contextoForcado) {
        await estagio('Usando cenário do lote…');
        telemetria = (contextoForcado.telemetria as Record<string, number>) ?? {};
        contexto = {
            talhao: contextoForcado.talhao as string | undefined,
            areas: (contextoForcado.areas as string[]) ?? [],
            produtosEmUso: (contextoForcado.produtosEmUso as string[]) ?? [],
            telemetria,
            intencao: texto
        };
    } else {
        await estagio('Sorteando talhão e leitura de sensores…');
        const talhao = linhaAleatoria<PerfilTalhao>(TALHOES_PATH);
        telemetria = linhaAleatoria<AmostraTelemetria>(SENSORES_PATH).telemetria;
        contexto = { ...talhao, telemetria, intencao: texto };
    }

    await estagio('Buscando regras no grafo de conhecimento…');
    let constraints = retrieveAgroConstraints(modeloAgro, contexto);
    await estagio(
        `Regras recuperadas: ${constraints.culturasAtivas.length} culturas ativas, ` +
            `${constraints.bloqueios.length} bloqueios, ${constraints.vetados.length} vetos`
    );

    let foco: RespostaComando['foco'] = null;
    let focoIndisponivel: string | undefined;

    await estagio('Calculando foco por embedding no subgrafo…');
    const session = driver.session();
    try {
        const f = await retrieverFocoAgro(session, texto, modeloAgro);
        constraints = filtrarPorFocoAgro(constraints, f, modeloAgro, contexto);
        foco = { produtos: [...f.produtos], culturas: [...f.culturas] };
        await estagio(
            `Foco recuperado: produtos [${descreverFoco(f.produtos, f.origem)}], ` +
                `culturas [${descreverFoco(f.culturas, f.origem)}]`
        );
    } catch (error) {
        focoIndisponivel = (error as Error).message;
        await estagio('Foco por embedding indisponível — seguindo com o grafo completo');
    } finally {
        await session.close();
    }

    const poda = agroPruningPayload(constraints);
    const promptSemantico = montarPromptSemanticoAgro(constraints);
    const sorteio = { talhao: contexto.talhao, telemetria, areas: contexto.areas, produtosEmUso: contexto.produtosEmUso };

    let motivoValidacao: string | undefined;
    if (VALIDACAO_ATIVA) {
        await estagio('Validando comando com o modelo local (usando o grafo recuperado)…');
        const validacao = await validarComando(texto, promptSemantico, ENGINE_AGRO);
        motivoValidacao = validacao.motivo;
        if (!validacao.compreensivel) {
            return { aceito: false, motivoValidacao, sorteio, foco, focoIndisponivel, promptSemantico };
        }
    }

    await estagio('Iniciando Grammar Prompting (geração restrita por gramática)…');
    const resposta = await gerarMissaoRestrita(contexto, constraints);
    await estagio('Missão gerada.');

    return {
        aceito: true,
        motivoValidacao,
        sorteio,
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

async function processarFut(
    texto: string,
    estagio: EmitirEstagio,
    contextoForcado?: Record<string, unknown>
): Promise<RespostaComando> {
    let telemetria: Record<string, number>;
    let contexto: FutContext;
    if (contextoForcado) {
        await estagio('Usando cenário do lote…');
        telemetria = (contextoForcado.telemetria as Record<string, number>) ?? {};
        contexto = {
            partida: contextoForcado.partida as string | undefined,
            contextos: (contextoForcado.contextos as string[]) ?? [],
            infracoesEmUso: (contextoForcado.infracoesEmUso as string[]) ?? [],
            telemetria,
            intencao: texto
        };
    } else {
        await estagio('Sorteando partida e leitura de partida…');
        const partida = linhaAleatoria<PerfilPartida>(PARTIDAS_PATH);
        telemetria = linhaAleatoria<AmostraTelemetria>(LEITURAS_PARTIDA_PATH).telemetria;
        contexto = { ...partida, telemetria, intencao: texto };
    }

    await estagio('Buscando regras no grafo de conhecimento…');
    let constraints = retrieveFutConstraints(modeloFut, contexto);
    await estagio(
        `Regras recuperadas: ${constraints.lancesAtivos.length} lances ativos, ` +
            `${constraints.bloqueios.length} bloqueios, ${constraints.vetados.length} vetos`
    );

    let foco: RespostaComando['foco'] = null;
    let focoIndisponivel: string | undefined;

    await estagio('Calculando foco por embedding no subgrafo…');
    const session = driver.session();
    try {
        const f = await retrieverFocoFut(session, texto, modeloFut);
        constraints = filtrarPorFocoFut(constraints, f, modeloFut, contexto);
        foco = { infracoes: [...f.infracoes], lances: [...f.lances] };
        await estagio(
            `Foco recuperado: infracoes [${descreverFoco(f.infracoes, f.origem)}], ` +
                `lances [${descreverFoco(f.lances, f.origem)}]`
        );
    } catch (error) {
        focoIndisponivel = (error as Error).message;
        await estagio('Foco por embedding indisponível — seguindo com o grafo completo');
    } finally {
        await session.close();
    }

    const poda = futPruningPayload(constraints);
    const promptSemantico = montarPromptSemanticoFut(constraints);
    const sorteio = { partida: contexto.partida, telemetria, contextos: contexto.contextos, infracoesEmUso: contexto.infracoesEmUso };

    let motivoValidacao: string | undefined;
    if (VALIDACAO_ATIVA) {
        await estagio('Validando comando com o modelo local (usando o grafo recuperado)…');
        const validacao = await validarComando(texto, promptSemantico, ENGINE_FUT);
        motivoValidacao = validacao.motivo;
        if (!validacao.compreensivel) {
            return { aceito: false, motivoValidacao, sorteio, foco, focoIndisponivel, promptSemantico };
        }
    }

    await estagio('Iniciando Grammar Prompting (geração restrita por gramática)…');
    const resposta = await gerarArbitragemRestrita(contexto, constraints);
    await estagio('Decisão gerada.');

    return {
        aceito: true,
        motivoValidacao,
        sorteio,
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

// Historico de chats: cada conversa vira um arquivo JSON nomeado pelo timestamp
// de criacao em `data/chats/`. Como o docker-compose monta `.:/app`, isso
// persiste igual tanto local quanto no container.
const CHATS_DIR = path.join('data', 'chats');
fs.mkdirSync(CHATS_DIR, { recursive: true });

const ID_CHAT_REGEX = /^[0-9]{8}-[0-9]{6}(-[0-9]+)?$/;

interface ChatSalvo {
    id: string;
    titulo: string;
    dominio: 'med' | 'agro' | 'fut';
    criadoEm: string;
    atualizadoEm: string;
    mensagens: unknown[];
}

function caminhoChat(id: string): string {
    return path.join(CHATS_DIR, `${id}.json`);
}

/** Timestamp legivel (AAAAMMDD-HHMMSS); sufixo numerico so no raro caso de
 *  dois chats nascerem no mesmo segundo. */
function gerarIdChat(): string {
    const agora = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const base = `${agora.getFullYear()}${pad(agora.getMonth() + 1)}${pad(agora.getDate())}-${pad(agora.getHours())}${pad(agora.getMinutes())}${pad(agora.getSeconds())}`;
    let id = base;
    let sufixo = 1;
    while (fs.existsSync(caminhoChat(id))) {
        id = `${base}-${sufixo++}`;
    }
    return id;
}

function tituloDoChat(mensagens: unknown[]): string {
    const primeira = mensagens.find(
        (m): m is { texto: string } =>
            !!m &&
            typeof m === 'object' &&
            (m as { autor?: unknown }).autor === 'usuario' &&
            typeof (m as { texto?: unknown }).texto === 'string' &&
            (m as { texto: string }).texto.trim().length > 0
    );
    if (!primeira) return 'Nova conversa';
    const texto = primeira.texto.trim();
    return texto.length > 60 ? `${texto.slice(0, 60)}…` : texto;
}

function listarChatsSalvos(): Array<Omit<ChatSalvo, 'mensagens'>> {
    const arquivos = fs.readdirSync(CHATS_DIR).filter(f => f.endsWith('.json'));
    const chats = arquivos.map(arquivo => {
        const { mensagens, ...resumo } = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, arquivo), 'utf-8')) as ChatSalvo;
        return resumo;
    });
    chats.sort((a, b) => b.atualizadoEm.localeCompare(a.atualizadoEm));
    return chats;
}

/** Filtra linhas que nao sao registros de resultado (ex.: a linha final
 *  `{duracaoSegundos}` que o download em lote do web-chat acrescenta). */
function parseRegistrosAvaliar(jsonlTexto: string): RegistroAvaliarGrafo[] {
    return jsonlTexto
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .map(l => JSON.parse(l) as RegistroAvaliarGrafo)
        .filter(r => typeof r.plano === 'string' || typeof r.resultado === 'string');
}

// ---------------------------------------------------------------------------
// Avaliacao contra o grafo de conhecimento (ver src/inference/avaliar-grafo.ts)
// — usada por POST /api/avaliar no lugar da comparacao contra um ground truth
// fixo. Para cada registro do arquivo enviado, refaz a recuperacao no grafo a
// partir da telemetria que o proprio registro carrega (o mesmo "sorteio" que a
// geracao original usou) e pede a UMA LLM local que julgue o plano contra o
// que o grafo diz agora — violacao de seguranca continua deterministica (ver
// `violacaoDeterministica`), so a correcao semantica mais ampla vem da LLM.
// ---------------------------------------------------------------------------

async function avaliarRegistroMed(registro: RegistroAvaliarGrafo, motor: string, sinal: AbortSignal): Promise<DetalheLado> {
    const bloco = registro.telemetria;
    const paciente = typeof bloco?.paciente === 'string' ? bloco.paciente : undefined;
    const sinais = sinaisDe(bloco);
    if (!paciente || !sinais) {
        return detalheNaoAvaliado(registro, 'Telemetria ausente ou incompleta neste registro — não foi possível reconstruir o cenário para consultar o grafo.');
    }

    const contexto: ClinicalContext = {
        paciente,
        telemetria: sinais,
        populacoes: listaDe(bloco?.populacoes),
        farmacosEmUso: listaDe(bloco?.farmacosEmUso),
        intencao: registro.intencao ?? ''
    };

    let promptSemantico: string;
    let proibidos: Set<string>;
    try {
        const constraints = retrieveConstraints(modeloMed, contexto);
        promptSemantico = montarPromptSemantico(constraints);
        proibidos = new Set([...constraints.bloqueios.map(b => b.farmaco), ...constraints.vetados.map(v => v.farmaco)]);
    } catch (error) {
        return detalheNaoAvaliado(registro, `Falha ao consultar o grafo de conhecimento: ${(error as Error).message}`);
    }

    try {
        const veredicto = await validarPlanoComGrafo(textoGerado(registro), promptSemantico, contexto.intencao ?? '', motor, sinal);
        return detalheJulgado(registro, proibidos, veredicto, promptSemantico);
    } catch (error) {
        return detalheNaoAvaliado(registro, `Falha ao julgar com o modelo local: ${(error as Error).message}`);
    }
}

async function avaliarRegistroAgro(registro: RegistroAvaliarGrafo, motor: string, sinal: AbortSignal): Promise<DetalheLado> {
    const bloco = registro.telemetria;
    const talhao = typeof bloco?.talhao === 'string' ? bloco.talhao : undefined;
    const sinais = sinaisDe(bloco);
    if (!talhao || !sinais) {
        return detalheNaoAvaliado(registro, 'Telemetria ausente ou incompleta neste registro — não foi possível reconstruir o cenário para consultar o grafo.');
    }

    const contexto: AgroContext = {
        talhao,
        telemetria: sinais,
        areas: listaDe(bloco?.areas),
        produtosEmUso: listaDe(bloco?.produtosEmUso),
        intencao: registro.intencao ?? ''
    };

    let promptSemantico: string;
    let proibidos: Set<string>;
    try {
        const constraints = retrieveAgroConstraints(modeloAgro, contexto);
        promptSemantico = montarPromptSemanticoAgro(constraints);
        proibidos = new Set([...constraints.bloqueios.map(b => b.produto), ...constraints.vetados.map(v => v.produto)]);
    } catch (error) {
        return detalheNaoAvaliado(registro, `Falha ao consultar o grafo de conhecimento: ${(error as Error).message}`);
    }

    try {
        const veredicto = await validarPlanoComGrafo(textoGerado(registro), promptSemantico, contexto.intencao ?? '', motor, sinal);
        return detalheJulgado(registro, proibidos, veredicto, promptSemantico);
    } catch (error) {
        return detalheNaoAvaliado(registro, `Falha ao julgar com o modelo local: ${(error as Error).message}`);
    }
}

async function avaliarRegistroFut(registro: RegistroAvaliarGrafo, motor: string, sinal: AbortSignal): Promise<DetalheLado> {
    const bloco = registro.telemetria;
    const partida = typeof bloco?.partida === 'string' ? bloco.partida : undefined;
    const sinais = sinaisDe(bloco);
    if (!partida || !sinais) {
        return detalheNaoAvaliado(registro, 'Telemetria ausente ou incompleta neste registro — não foi possível reconstruir o cenário para consultar o grafo.');
    }

    const contexto: FutContext = {
        partida,
        telemetria: sinais,
        contextos: listaDe(bloco?.contextos),
        infracoesEmUso: listaDe(bloco?.infracoesEmUso),
        intencao: registro.intencao ?? ''
    };

    let promptSemantico: string;
    let proibidos: Set<string>;
    try {
        const constraints = retrieveFutConstraints(modeloFut, contexto);
        promptSemantico = montarPromptSemanticoFut(constraints);
        proibidos = new Set([...constraints.bloqueios.map(b => b.infracao), ...constraints.vetados.map(v => v.infracao)]);
    } catch (error) {
        return detalheNaoAvaliado(registro, `Falha ao consultar o grafo de conhecimento: ${(error as Error).message}`);
    }

    try {
        const veredicto = await validarPlanoComGrafo(textoGerado(registro), promptSemantico, contexto.intencao ?? '', motor, sinal);
        return detalheJulgado(registro, proibidos, veredicto, promptSemantico);
    } catch (error) {
        return detalheNaoAvaliado(registro, `Falha ao julgar com o modelo local: ${(error as Error).message}`);
    }
}

/** Julga arquitetura e depois baseline, sequencialmente — a engine ja serializa
 *  geracao via um lock interno (um modelo, uma chamada por vez), entao
 *  paralelizar aqui so complicaria o cancelamento sem ganhar tempo real. */
async function avaliarComGrafo(
    dominio: 'med' | 'agro' | 'fut',
    arquitetura: RegistroAvaliarGrafo[] | undefined,
    baseline: RegistroAvaliarGrafo[] | undefined,
    onProgresso: (processados: number, total: number) => void,
    sinal: AbortSignal
): Promise<ResultadoAvaliacaoGrafo> {
    const motor = dominio === 'med' ? ENGINE : dominio === 'agro' ? ENGINE_AGRO : ENGINE_FUT;
    const avaliarUm = dominio === 'med' ? avaliarRegistroMed : dominio === 'agro' ? avaliarRegistroAgro : avaliarRegistroFut;

    const total = (arquitetura?.length ?? 0) + (baseline?.length ?? 0);
    let processados = 0;

    const ladosArq = new Map<RegistroAvaliarGrafo, DetalheLado>();
    for (const registro of arquitetura ?? []) {
        if (sinal.aborted) break;
        ladosArq.set(registro, await avaliarUm(registro, motor, sinal));
        onProgresso(++processados, total);
    }

    const ladosBase = new Map<RegistroAvaliarGrafo, DetalheLado>();
    for (const registro of baseline ?? []) {
        if (sinal.aborted) break;
        ladosBase.set(registro, await avaliarUm(registro, motor, sinal));
        onProgresso(++processados, total);
    }

    const linhas: DetalheLinha[] = parearRegistros(arquitetura ?? [], baseline ?? []).map((par, i) => {
        const detArq = par.a ? ladosArq.get(par.a) : undefined;
        const detBase = par.b ? ladosBase.get(par.b) : undefined;
        const divergiu = (d?: DetalheLado): boolean => !!d && !d.naoAvaliado && (!d.sintaxeOk || !d.semanticaOk || d.violacao);
        return { linha: i + 1, intencao: par.intencao, arquitetura: detArq, baseline: detBase, temDivergencia: divergiu(detArq) || divergiu(detBase) };
    });

    const naoAvaliados = [...ladosArq.values(), ...ladosBase.values()].filter(d => d.naoAvaliado).length;

    return {
        arquitetura: arquitetura ? agregarMetricas([...ladosArq.values()]) : undefined,
        baseline: baseline ? agregarMetricas([...ladosBase.values()]) : undefined,
        naoAvaliados,
        linhas
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
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
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
                { id: 'agro', nome: 'Agrícola (drone)', descricao: 'SPC-CML sobre lavoura.agro' },
                { id: 'fut', nome: 'Arbitragem (futebol)', descricao: 'SPC-CML sobre futebol.fut' }
            ]);
            return;
        }

        if (req.method === 'GET' && req.url === '/api/health') {
            jsonResponse(res, 200, { status: 'ok' });
            return;
        }

        if (req.method === 'POST' && req.url === '/api/comando') {
            const corpo = JSON.parse((await lerCorpo(req)) || '{}') as {
                dominio?: string;
                texto?: string;
                contexto?: Record<string, unknown>;
            };
            const dominio = corpo.dominio;
            const texto = (corpo.texto ?? '').trim();

            if (dominio !== 'med' && dominio !== 'agro' && dominio !== 'fut') {
                jsonResponse(res, 400, { erro: "dominio deve ser 'med', 'agro' ou 'fut'" });
                return;
            }
            if (!texto) {
                jsonResponse(res, 400, { erro: 'texto vazio' });
                return;
            }

            // SSE: o front-end acompanha em tempo real por onde o fluxo esta passando
            // (sorteio -> grafo -> embedding -> grammar prompting). A validacao, quando
            // ligada, entra DENTRO de processarMed/processarAgro/processarFut, depois
            // do grafo — ver VALIDACAO_ATIVA e o comentario no topo do arquivo.
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                'Access-Control-Allow-Origin': ORIGEM_PERMITIDA
            });
            const emitir = (evento: string, dados: unknown): void => {
                res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);
            };
            const estagio: EmitirEstagio = async texto => {
                emitir('estagio', { texto });
                await pausa(PAUSA_ESTAGIO_MS);
            };

            try {
                const resultado =
                    dominio === 'med'
                        ? await processarMed(texto, estagio, corpo.contexto)
                        : dominio === 'agro'
                          ? await processarAgro(texto, estagio, corpo.contexto)
                          : await processarFut(texto, estagio, corpo.contexto);
                emitir('final', resultado);
            } catch (error) {
                emitir('erro', { erro: (error as Error).message });
            } finally {
                res.end();
            }
            return;
        }

        if (req.method === 'GET' && req.url === '/api/chats') {
            jsonResponse(res, 200, listarChatsSalvos());
            return;
        }

        if (req.method === 'POST' && req.url === '/api/chats') {
            const corpo = JSON.parse((await lerCorpo(req)) || '{}') as { dominio?: string; mensagens?: unknown[] };
            if (corpo.dominio !== 'med' && corpo.dominio !== 'agro' && corpo.dominio !== 'fut') {
                jsonResponse(res, 400, { erro: "dominio deve ser 'med', 'agro' ou 'fut'" });
                return;
            }
            const mensagens = Array.isArray(corpo.mensagens) ? corpo.mensagens : [];
            const agora = new Date().toISOString();
            const chat: ChatSalvo = {
                id: gerarIdChat(),
                titulo: tituloDoChat(mensagens),
                dominio: corpo.dominio,
                criadoEm: agora,
                atualizadoEm: agora,
                mensagens
            };
            fs.writeFileSync(caminhoChat(chat.id), JSON.stringify(chat, null, 2));
            jsonResponse(res, 201, chat);
            return;
        }

        if (req.method === 'GET' && req.url?.startsWith('/api/chats/')) {
            const id = req.url.slice('/api/chats/'.length);
            if (!ID_CHAT_REGEX.test(id) || !fs.existsSync(caminhoChat(id))) {
                jsonResponse(res, 404, { erro: 'chat nao encontrado' });
                return;
            }
            jsonResponse(res, 200, JSON.parse(fs.readFileSync(caminhoChat(id), 'utf-8')));
            return;
        }

        if (req.method === 'PUT' && req.url?.startsWith('/api/chats/')) {
            const id = req.url.slice('/api/chats/'.length);
            if (!ID_CHAT_REGEX.test(id) || !fs.existsSync(caminhoChat(id))) {
                jsonResponse(res, 404, { erro: 'chat nao encontrado' });
                return;
            }
            const corpo = JSON.parse((await lerCorpo(req)) || '{}') as { dominio?: string; mensagens?: unknown[] };
            if (corpo.dominio !== 'med' && corpo.dominio !== 'agro' && corpo.dominio !== 'fut') {
                jsonResponse(res, 400, { erro: "dominio deve ser 'med', 'agro' ou 'fut'" });
                return;
            }
            const anterior = JSON.parse(fs.readFileSync(caminhoChat(id), 'utf-8')) as ChatSalvo;
            const mensagens = Array.isArray(corpo.mensagens) ? corpo.mensagens : [];
            const chat: ChatSalvo = {
                ...anterior,
                dominio: corpo.dominio,
                titulo: tituloDoChat(mensagens),
                atualizadoEm: new Date().toISOString(),
                mensagens
            };
            fs.writeFileSync(caminhoChat(chat.id), JSON.stringify(chat, null, 2));
            jsonResponse(res, 200, chat);
            return;
        }

        if (req.method === 'POST' && req.url === '/api/avaliar') {
            const corpo = JSON.parse((await lerCorpo(req)) || '{}') as {
                dominio?: string;
                arquiteturaJsonl?: string;
                baselineJsonl?: string;
            };
            if (corpo.dominio !== 'med' && corpo.dominio !== 'agro' && corpo.dominio !== 'fut') {
                jsonResponse(res, 400, { erro: "dominio deve ser 'med', 'agro' ou 'fut'" });
                return;
            }
            if (!corpo.arquiteturaJsonl && !corpo.baselineJsonl) {
                jsonResponse(res, 400, { erro: 'envie ao menos um arquivo (arquitetura e/ou baseline)' });
                return;
            }

            let arquitetura: RegistroAvaliarGrafo[] | undefined;
            let baseline: RegistroAvaliarGrafo[] | undefined;
            try {
                arquitetura = corpo.arquiteturaJsonl ? parseRegistrosAvaliar(corpo.arquiteturaJsonl) : undefined;
                baseline = corpo.baselineJsonl ? parseRegistrosAvaliar(corpo.baselineJsonl) : undefined;
            } catch (error) {
                jsonResponse(res, 400, { erro: `falha ao interpretar o arquivo enviado: ${(error as Error).message}` });
                return;
            }

            // SSE: cada julgamento e uma geracao no modelo local (serializada pela
            // engine), entao um arquivo com centenas de linhas pode levar minutos —
            // o front-end acompanha "X de Y avaliados" e pode cancelar no meio
            // (fechar a conexao aborta o julgamento em andamento, ver `controlador`).
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                'Access-Control-Allow-Origin': ORIGEM_PERMITIDA
            });
            const emitir = (evento: string, dados: unknown): void => {
                res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);
            };

            const controlador = new AbortController();
            req.on('close', () => controlador.abort());

            try {
                const resultado = await avaliarComGrafo(
                    corpo.dominio,
                    arquitetura,
                    baseline,
                    (processados, total) => emitir('progresso', { processados, total }),
                    controlador.signal
                );
                emitir('final', resultado);
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
    console.log(`  POST /api/comando   { dominio: 'med'|'agro'|'fut', texto: string }  (SSE: event "estagio"*, "final"|"erro")`);
    console.log(`  GET  /api/chats`);
    console.log(`  POST /api/chats     { dominio: 'med'|'agro'|'fut', mensagens: [] }`);
    console.log(`  GET  /api/chats/:id`);
    console.log(`  PUT  /api/chats/:id { dominio: 'med'|'agro'|'fut', mensagens: [] }`);
    console.log(`  POST /api/avaliar   { dominio: 'med'|'agro'|'fut', arquiteturaJsonl?: string, baselineJsonl?: string }  (SSE: event "progresso"*, "final"|"erro")`);
});

process.on('SIGINT', async () => {
    await driver.close();
    process.exit(0);
});
