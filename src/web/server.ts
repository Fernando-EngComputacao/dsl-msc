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
import type { ClinicalContext } from '../knowledge/graphrag.js';
import { nomeArquivoAvaliacao, parseRegistrosAvaliacao, type RegistroAvaliacaoImportado } from '../inference/avaliacao-jsonl.js';
import {
    baseDoArquivoAvaliacao,
    CHAVE_SUJEITO,
    DOMINIOS,
    ehDominio,
    ehParte,
    fundirAvaliacoes,
    fusaoParaCsv,
    fusaoParaJsonl,
    nomeArquivoFusao,
    PARTES,
    sujeitoDoCenario,
    type FonteFusao,
    type OpcoesFusao,
    type ParteFusao,
    type RegistroCenario
} from '../inference/fusao-avaliacoes.js';
import { gerarPlanoRestrito, montarEntradaGeracao } from '../inference/llm-client.js';

import { loadAgroModel } from '../database/neo4j-agro.js';
import type { AgroContext } from '../knowledge/graphrag-agro.js';
import { gerarMissaoRestrita, montarEntradaGeracaoAgro } from '../inference/agro-client.js';

import { loadFutModel } from '../database/neo4j-fut.js';
import type { FutContext } from '../knowledge/graphrag-fut.js';
import { gerarArbitragemRestrita, montarEntradaGeracaoFut } from '../inference/fut-client.js';

import type { AuditoriaRecuperacao } from '../knowledge/recuperacao-hibrida.js';
import {
    ADAPTADOR_AGRO,
    ADAPTADOR_FUT,
    ADAPTADOR_MED,
    recuperarConhecimento,
    type EmitirEstagio,
    type FocoResposta
} from '../inference/recuperacao-conhecimento.js';
import { ehResultadoMultiagente, verificadorGramaticaHttp, type ResultadoDecodificacao } from '../inference/decodificacao.js';
import { resumoExecucao, type ResumoExecucao } from '../inference/multiagente.js';

import {
    agregarMetricas,
    avaliarPlano,
    detalheNaoAvaliado,
    geracaoDoPlano,
    juizLLMHttp,
    listaDe,
    montarLinha,
    parearRegistros,
    registrosJsonl,
    sinaisDe,
    type BlocoTelemetriaGrafo,
    type DependenciasAvaliacao,
    type GeracaoDoPlano,
    type DetalheLado,
    type DetalheLinha,
    type IdentidadeJuiz,
    type JuizLLM,
    type RegistroAvaliarGrafo,
    type ResultadoAvaliacaoGrafo
} from '../inference/avaliar-grafo.js';
import { anexarJulgamentoAnterior, compararJuizes, type ComparacaoJuizes } from '../inference/comparacao-juizes.js';
import {
    chaveDoAmbiente,
    ehProvedorFronteira,
    juizFronteira,
    modeloDoJuiz,
    PROVEDORES,
    PROVEDORES_FRONTEIRA,
    testarConexaoJuiz,
    type ProvedorFronteira
} from '../inference/juiz-fronteira.js';
import { gerarComGate, type CriterioGate, type ResumoGate } from '../inference/geracao-validada.js';
import { diagnosticadorLLMHttp } from '../inference/diagnostico-juiz.js';
import { tokenizadorHttp, type Tokenizador } from '../inference/motor-http.js';
import { criarAnalisadorDsl, verificadorDaDsl } from '../inference/avaliar-sintaxe.js';

const ENGINE = process.env.SPC_CML_ENDPOINT ?? 'http://127.0.0.1:8000';
// Um motor por dominio: main.py fixa a gramatica na subida, e o chat oferece os
// tres lado a lado. Sem SPC_CML_ENDPOINT_AGRO/SPC_CML_ENDPOINT_FUT os dominios
// sem endpoint proprio caem no mesmo motor, que e o comportamento de quem sobe
// so um — util, mas ai o outro dominio responde 422 ("a poda eliminou o simbolo
// inicial") em vez de gerar contra a gramatica errada.
const ENGINE_AGRO = process.env.SPC_CML_ENDPOINT_AGRO ?? ENGINE;
const ENGINE_FUT = process.env.SPC_CML_ENDPOINT_FUT ?? ENGINE;

const TIMEOUT_MS = Number(process.env.SPC_CML_TIMEOUT_MS ?? 600_000);
// Teto de UMA chamada ao juiz de fronteira (ver juiz-fronteira.ts). Menor que o
// do motor local: aqui e rede publica, e a resposta pedida tem tres linhas.
const TIMEOUT_JUIZ_FRONTEIRA_MS = Number(process.env.SPC_CML_JUIZ_FRONTEIRA_TIMEOUT_MS ?? 180_000);
// Teto do TESTE de conexao (POST /api/juizes/testar): bem menor que o da
// avaliacao, porque alguem esta olhando a tela esperando. Estourar aqui nao diz
// que a chave esta errada — diz que o provedor nao respondeu nesse tempo.
const TIMEOUT_TESTE_JUIZ_MS = Number(process.env.SPC_CML_JUIZ_TESTE_TIMEOUT_MS ?? 60_000);
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

const MODELO_MED_PATH = path.join('src', 'examples', 'med', 'uti.dsl');
const MODELO_AGRO_PATH = path.join('src', 'examples', 'agro', 'lavoura.agro');
const MODELO_FUT_PATH = path.join('src', 'examples', 'fut', 'futebol.fut');

console.log('Carregando modelo clinico (uti.dsl)...');
const modeloMed = await loadModel(MODELO_MED_PATH);
console.log('Carregando modelo agricola (lavoura.agro)...');
const modeloAgro = await loadAgroModel(MODELO_AGRO_PATH);
console.log('Carregando modelo de arbitragem (futebol.fut)...');
const modeloFut = await loadFutModel(MODELO_FUT_PATH);

const driver: Driver = neo4j.driver(
    process.env.NEO4J_URI ?? 'bolt://localhost:7687',
    neo4j.auth.basic(process.env.NEO4J_USER ?? 'neo4j', process.env.NEO4J_PASSWORD ?? '#UFG2026')
);

interface RespostaComando {
    aceito: boolean;
    motivoValidacao?: string;
    sorteio?: Record<string, unknown>;
    foco?: FocoResposta | null;
    focoIndisponivel?: string;
    promptSemantico?: string;
    decisoesAdmissiveis?: string[];
    resultado?: string;
    valido?: boolean;
    erroMotor?: string | null;
    regrasEmGHat?: number;
    /** Trilha da recuperacao: modo, consulta semantica, candidatos, vereditos. */
    auditoriaRecuperacao?: AuditoriaRecuperacao;
    /** So com SPC_CML_DECODIFICACAO=multiagente: status, tentativas do Planner e sequencia candidata. */
    execucaoMultiagente?: ResumoExecucao;
    /**
     * So quando o pedido liga o gate da geracao (`validacao.ativa`, ver
     * /api/comando): a avaliacao do plano que ficou, com as MESMAS camadas
     * separadas que /api/avaliar devolve (sintaxe, semantica, oraculo, juiz),
     * menos `contextoGrafo` — o Prompt Semantico ja vai em `promptSemantico`.
     */
    avaliacao?: DetalheLado;
    /** So com o gate ligado: tentativas, vereditos descartados e o custo de cada parte. */
    geracaoValidada?: ResumoGate;
}

/** O campo `execucaoMultiagente`, quando a resposta veio do modo multiagente; nos demais, nada. */
function execucaoMultiagente(resposta: ResultadoDecodificacao): Pick<RespostaComando, 'execucaoMultiagente'> {
    return ehResultadoMultiagente(resposta) ? { execucaoMultiagente: resumoExecucao(resposta.execucao) } : {};
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

    // Recuperacao, foco, poda, refinamento, politica efetiva e Prompt Semantico:
    // o bloco comum aos tres dominios, em src/inference/recuperacao-conhecimento.ts.
    // `politicaEfetiva` e a unica politica da requisicao — prompt, gramatica,
    // contrato e resposta da API leem esta.
    const conhecimento = await recuperarConhecimento(ADAPTADOR_MED, modeloMed, contexto, texto, estagio, () => driver.session());
    const { constraints, foco, focoIndisponivel, auditoriaRecuperacao, politicaEfetiva, promptSemantico } = conhecimento;
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
    const resposta = await gerarPlanoRestrito(contexto, constraints, modeloMed, politicaEfetiva, conhecimento);
    await estagio('Plano gerado.');

    return {
        aceito: true,
        motivoValidacao,
        sorteio,
        foco,
        focoIndisponivel,
        promptSemantico,
        decisoesAdmissiveis: politicaEfetiva.acoes_permitidas,
        resultado: resposta.resultado,
        valido: resposta.valido,
        erroMotor: resposta.erro,
        regrasEmGHat: resposta.regras_em_g_hat,
        auditoriaRecuperacao,
        ...execucaoMultiagente(resposta)
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

    // Bloco comum aos tres dominios — ver `recuperarConhecimento`.
    const conhecimento = await recuperarConhecimento(ADAPTADOR_AGRO, modeloAgro, contexto, texto, estagio, () => driver.session());
    const { constraints, foco, focoIndisponivel, auditoriaRecuperacao, politicaEfetiva, promptSemantico } = conhecimento;
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
    const resposta = await gerarMissaoRestrita(contexto, constraints, modeloAgro, politicaEfetiva, conhecimento);
    await estagio('Missão gerada.');

    return {
        aceito: true,
        motivoValidacao,
        sorteio,
        foco,
        focoIndisponivel,
        promptSemantico,
        decisoesAdmissiveis: politicaEfetiva.acoes_permitidas,
        resultado: resposta.resultado,
        valido: resposta.valido,
        erroMotor: resposta.erro,
        regrasEmGHat: resposta.regras_em_g_hat,
        auditoriaRecuperacao,
        ...execucaoMultiagente(resposta)
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

    // Bloco comum aos tres dominios — ver `recuperarConhecimento`.
    const conhecimento = await recuperarConhecimento(ADAPTADOR_FUT, modeloFut, contexto, texto, estagio, () => driver.session());
    const { constraints, foco, focoIndisponivel, auditoriaRecuperacao, politicaEfetiva, promptSemantico } = conhecimento;
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
    const resposta = await gerarArbitragemRestrita(contexto, constraints, modeloFut, politicaEfetiva, conhecimento);
    await estagio('Decisão gerada.');

    return {
        aceito: true,
        motivoValidacao,
        sorteio,
        foco,
        focoIndisponivel,
        promptSemantico,
        decisoesAdmissiveis: politicaEfetiva.acoes_permitidas,
        resultado: resposta.resultado,
        valido: resposta.valido,
        erroMotor: resposta.erro,
        regrasEmGHat: resposta.regras_em_g_hat,
        auditoriaRecuperacao,
        ...execucaoMultiagente(resposta)
    };
}

/** Um ponto so de despacho da geracao por dominio — a rota e o gate usam este. */
function processarDominio(
    dominio: 'med' | 'agro' | 'fut',
    texto: string,
    estagio: EmitirEstagio,
    contexto?: Record<string, unknown>
): Promise<RespostaComando> {
    return dominio === 'med'
        ? processarMed(texto, estagio, contexto)
        : dominio === 'agro'
          ? processarAgro(texto, estagio, contexto)
          : processarFut(texto, estagio, contexto);
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
// Avaliacao dos planos ja gerados (ver src/inference/avaliar-grafo.ts) — POST
// /api/avaliar. Cada plano passa pela cascata: SINTAXE (G via /verify sem
// politica + parser Langium -> AST), SEMANTICA sobre o AST (os validadores da
// geracao, sobre a MESMA recuperacao refeita a partir do "sorteio" do
// registro), ORACULO e, por ultimo, o juiz LLM independente (/validar-plano). A
// discordancia entre oraculo e juiz e registrada, nunca resolvida a favor do juiz.
// ---------------------------------------------------------------------------

// O parser oficial de cada DSL, com o modelo do especialista para ligar as
// referencias do artefato — os mesmos arquivos que o servidor carregou acima.
const ANALISADORES = {
    med: criarAnalisadorDsl('med', MODELO_MED_PATH),
    agro: criarAnalisadorDsl('agro', MODELO_AGRO_PATH),
    fut: criarAnalisadorDsl('fut', MODELO_FUT_PATH)
};

// Julgar texto que nem pertence a DSL so com razao experimental explicita.
const JULGAR_SINTAXE_INVALIDA = process.env.SPC_CML_AVALIAR_JULGAR_SINTAXE_INVALIDA === 'true';

// Diagnostico da indeterminacao do juiz (ver src/inference/diagnostico-juiz.ts): uma
// chamada a mais ao motor, so quando o juiz responde UNRESOLVED. Ligado por padrao.
const DIAGNOSTICAR_INDETERMINACAO = process.env.SPC_CML_AVALIAR_DIAGNOSTICO !== 'false';

const SEM_CENARIO = 'Telemetria ausente ou incompleta neste registro — não foi possível reconstruir o cenário para consultar o grafo.';

/** Reconstroi o cenario do registro pelos nomes de campo do dominio e o avalia;
 *  sem sujeito ou sem sinais, a linha nao e avaliada. */
function avaliarRegistro(dominio: 'med' | 'agro' | 'fut', registro: RegistroAvaliarGrafo, deps: DependenciasAvaliacao): Promise<DetalheLado> {
    const bloco = registro.telemetria;
    const sinais = sinaisDe(bloco);
    const intencao = registro.intencao ?? '';
    const semCenario = async (): Promise<DetalheLado> => detalheNaoAvaliado(registro, SEM_CENARIO);

    if (dominio === 'med') {
        const paciente = typeof bloco?.paciente === 'string' ? bloco.paciente : undefined;
        if (!paciente || !sinais) return semCenario();
        const contexto: ClinicalContext = {
            paciente, telemetria: sinais, populacoes: listaDe(bloco?.populacoes), farmacosEmUso: listaDe(bloco?.farmacosEmUso), intencao
        };
        return avaliarPlano(registro, { adaptador: ADAPTADOR_MED, modelo: modeloMed, analisador: ANALISADORES.med, contexto, montarEntrada: montarEntradaGeracao }, deps);
    }
    if (dominio === 'agro') {
        const talhao = typeof bloco?.talhao === 'string' ? bloco.talhao : undefined;
        if (!talhao || !sinais) return semCenario();
        const contexto: AgroContext = {
            talhao, telemetria: sinais, areas: listaDe(bloco?.areas), produtosEmUso: listaDe(bloco?.produtosEmUso), intencao
        };
        return avaliarPlano(registro, { adaptador: ADAPTADOR_AGRO, modelo: modeloAgro, analisador: ANALISADORES.agro, contexto, montarEntrada: montarEntradaGeracaoAgro }, deps);
    }
    const partida = typeof bloco?.partida === 'string' ? bloco.partida : undefined;
    if (!partida || !sinais) return semCenario();
    const contexto: FutContext = {
        partida, telemetria: sinais, contextos: listaDe(bloco?.contextos), infracoesEmUso: listaDe(bloco?.infracoesEmUso), intencao
    };
    return avaliarPlano(registro, { adaptador: ADAPTADOR_FUT, modelo: modeloFut, analisador: ANALISADORES.fut, contexto, montarEntrada: montarEntradaGeracaoFut }, deps);
}

/** As dependencias da cascata de avaliacao: o mesmo motor, o mesmo parser e o
 *  mesmo grafo, seja na tela de avaliacao (/api/avaliar) ou no gate da geracao
 *  em lote (/api/comando com `validacao.ativa`). `pularJuiz` so existe para o
 *  gate, e so quando o criterio e `oraculo`: nos criterios com juiz ele e
 *  obrigatorio (ver processarComGate). */
function motorDoDominio(dominio: 'med' | 'agro' | 'fut'): string {
    return dominio === 'med' ? ENGINE : dominio === 'agro' ? ENGINE_AGRO : ENGINE_FUT;
}

/**
 * Quem vai fazer o papel do LLM Judge nesta avaliacao. `chamar` ausente e o
 * juiz do motor (Qwen local); presente, e um modelo de fronteira no mesmo lugar
 * da cascata. `identidade` e sempre preenchida — e dela que sai o campo
 * `llm-judge` do JSONL.
 */
interface JuizEscolhido {
    chamar?: JuizLLM;
    identidade: IdentidadeJuiz;
}

function dependenciasAvaliacao(
    dominio: 'med' | 'agro' | 'fut',
    sinal: AbortSignal,
    pularJuiz = false,
    juizEscolhido?: JuizEscolhido
): DependenciasAvaliacao {
    const motor = motorDoDominio(dominio);
    const verificador = verificadorGramaticaHttp(motor, TIMEOUT_MS);
    return {
        abrirSessao: () => driver.session(),
        verificadorDsl: verificadorDaDsl(verificador),
        verificador,
        // O juiz do motor (Qwen local) e o padrao; o rejulgamento troca o modelo
        // por um de fronteira SEM mexer em nada mais da cascata (ver juiz-fronteira.ts).
        juiz: juizEscolhido?.chamar ?? juizLLMHttp(motor, TIMEOUT_MS),
        ...(juizEscolhido ? { juizIdentidade: juizEscolhido.identidade } : {}),
        // O diagnostico da indeterminacao continua no motor local: ele explica a
        // indeterminacao com o conhecimento recuperado, nao julga o plano.
        ...(DIAGNOSTICAR_INDETERMINACAO ? { diagnosticador: diagnosticadorLLMHttp(motor, TIMEOUT_MS) } : {}),
        sinal,
        julgarSintaxeInvalida: JULGAR_SINTAXE_INVALIDA,
        ...(pularJuiz ? { pularJuiz: true } : {})
    };
}

// ---------------------------------------------------------------------------
// Gate da geracao (ver src/inference/geracao-validada.ts) — o lote do web-chat
// liga por `validacao.ativa` em POST /api/comando: cada cenario gera o plano,
// passa pela MESMA cascata de /api/avaliar e, quando a avaliacao reprova, volta
// para a geracao, ate aprovar ou bater o teto de tentativas. Quem reprova e o
// `criterio`: o oraculo, o juiz LLM, ou os dois (padrao).
// ---------------------------------------------------------------------------

/** Opcoes do gate aceitas no corpo de POST /api/comando. */
interface ValidacaoPedida {
    ativa?: boolean;
    maxTentativas?: number;
    /**
     * Quem reprova o plano e manda gerar de novo (ver geracao-validada.ts):
     * `oraculo` (so o veredito normativo), `juiz` (o LLM Judge decide) ou
     * `ambos` (o plano so fica se os dois derem VALID). Padrao: SPC_CML_GATE_CRITERIO.
     */
    criterio?: CriterioGate;
    /**
     * Chamar o juiz LLM em cada tentativa mesmo com `criterio: 'oraculo'` — ai
     * ele vai para o registro sem decidir a repeticao. Nos criterios `juiz` e
     * `ambos` o juiz e obrigatorio e esta opcao e ignorada. Padrao: SPC_CML_GATE_JUIZ.
     */
    juiz?: boolean;
    repetirNaoAvaliado?: boolean;
}

// Teto de geracoes por cenario. Existe para o lote nao ficar preso num cenario
// que o oraculo nunca aceita (a amostragem do motor e que faz o plano mudar
// entre tentativas; nada garante que uma hora saia VALID).
const GATE_MAX_TENTATIVAS = Math.max(1, Math.floor(Number(process.env.SPC_CML_GATE_MAX_TENTATIVAS ?? 3)));
// Teto duro do que o pedido pode pedir: cada tentativa e um pipeline de geracao
// inteiro, e o motor atende um pedido por vez.
const GATE_TETO_TENTATIVAS = Math.max(GATE_MAX_TENTATIVAS, Math.floor(Number(process.env.SPC_CML_GATE_TETO_TENTATIVAS ?? 20)));
// O juiz LLM dentro do gate quando ele NAO e critério: uma geracao a mais por
// tentativa. Ligado por padrao, para a linha sair com a MESMA avaliacao da tela
// (oraculo + juiz).
const GATE_JUIZ = process.env.SPC_CML_GATE_JUIZ !== 'false';
// Quem reprova por padrao. `ambos` e o mais estrito: o plano so fica se o
// oraculo E o juiz derem VALID.
const GATE_CRITERIO: CriterioGate = (() => {
    const valor = process.env.SPC_CML_GATE_CRITERIO;
    return valor === 'oraculo' || valor === 'juiz' || valor === 'ambos' ? valor : 'ambos';
})();

/** O critério pedido, se for um dos tres; senao o padrao do servidor. */
function criterioDoPedido(valor: string | undefined): CriterioGate {
    return valor === 'oraculo' || valor === 'juiz' || valor === 'ambos' ? valor : GATE_CRITERIO;
}

const ROTULO_ARTEFATO: Record<'med' | 'agro' | 'fut', string> = { med: 'plano', agro: 'missão', fut: 'decisão' };

/** O registro que a avaliacao le, montado do que a geracao acabou de devolver —
 *  os MESMOS campos que o lote grava no JSONL de resultados (`telemetria` e o
 *  `sorteio`), para que avaliar aqui e avaliar depois pelo arquivo seja a mesma coisa. */
function registroDaGeracao(texto: string, resposta: RespostaComando): RegistroAvaliarGrafo {
    return {
        intencao: texto,
        plano: resposta.resultado,
        valido: resposta.valido,
        telemetria: resposta.sorteio as BlocoTelemetriaGrafo | undefined,
        promptSemantico: resposta.promptSemantico,
        ...(resposta.execucaoMultiagente
            ? {
                  execucaoMultiagente: {
                      status: resposta.execucaoMultiagente.status,
                      sequenciaValidada: resposta.execucaoMultiagente.sequenciaValidada
                  }
              }
            : {})
    };
}

/** Gera com o gate e devolve a resposta da geracao que ficou, mais a avaliacao dela. */
async function processarComGate(
    dominio: 'med' | 'agro' | 'fut',
    texto: string,
    estagio: EmitirEstagio,
    /** O estagio do gate, SEM a pausa minima de UI: num lote de centenas de
     *  linhas, a pausa cosmetica de cada mensagem do gate viraria minutos. */
    estagioDoGate: EmitirEstagio,
    contexto: Record<string, unknown> | undefined,
    pedido: ValidacaoPedida,
    sinal: AbortSignal
): Promise<RespostaComando> {
    const criterio = criterioDoPedido(pedido.criterio);
    // Com o juiz no critério, ele e obrigatorio: sem o julgamento nao ha o que decidir.
    const juiz = criterio === 'oraculo' ? (pedido.juiz ?? GATE_JUIZ) : true;
    const deps = dependenciasAvaliacao(dominio, sinal, !juiz);
    const tentativasPedidas = Number(pedido.maxTentativas);
    const maxTentativas = Number.isFinite(tentativasPedidas)
        ? Math.min(GATE_TETO_TENTATIVAS, Math.max(1, Math.floor(tentativasPedidas)))
        : GATE_MAX_TENTATIVAS;

    const { resposta, avaliacao, resumo } = await gerarComGate<RespostaComando>(
        {
            gerar: () => processarDominio(dominio, texto, estagio, contexto),
            avaliar: r => avaliarRegistro(dominio, registroDaGeracao(texto, r), deps),
            // Sem plano (comando recusado, geracao sem artefato): nada a avaliar nem a repetir.
            planoDe: r => (r.aceito && typeof r.resultado === 'string' ? r.resultado : undefined),
            aoEstagio: estagioDoGate,
            sinal
        },
        { maxTentativas, criterio, repetirNaoAvaliado: pedido.repetirNaoAvaliado === true, rotulo: ROTULO_ARTEFATO[dominio] }
    );

    // `contextoGrafo` sai: e o Prompt Semantico reconstruido pela avaliacao, que
    // a resposta ja manda em `promptSemantico` (o da geracao).
    const { contextoGrafo: _contextoGrafo, ...avaliacaoSemPrompt } = avaliacao ?? ({} as DetalheLado);
    return {
        ...resposta,
        ...(avaliacao ? { avaliacao: avaliacaoSemPrompt as DetalheLado } : {}),
        geracaoValidada: resumo
    };
}

// O JSONL experimental de cada avaliacao: um registro por plano, com cada camada
// (sintaxe, semantica, oraculo, juiz) separada (ver `registrosJsonl`). Mesmo esquema de persistencia dos
// chats: arquivo em data/, que o docker-compose monta.
const AVALIACOES_DIR = path.join('data', 'avaliacoes');
fs.mkdirSync(AVALIACOES_DIR, { recursive: true });
// Nomes atuais (`evalueted_<nome>_<AAAAMMDD-HHmmss>[-n].jsonl`) e os antigos (`<AAAAMMDD-HHmmss>-<dominio>[-n].jsonl`).
const ARQUIVO_AVALIACAO_REGEX = /^(evalueted_[A-Za-z0-9._-]+_[0-9]{8}-[0-9]{6}(-[0-9]+)?|[0-9]{8}-[0-9]{6}-(med|agro|fut)(-[0-9]+)?)\.jsonl$/;

function gravarAvaliacao(dominio: 'med' | 'agro' | 'fut', resultado: ResultadoAvaliacaoGrafo, nomeEntrada?: string): string {
    const inicial = nomeArquivoAvaliacao(nomeEntrada, dominio, new Date());
    const base = inicial.replace(/\.jsonl$/, '');
    let nome = inicial;
    for (let sufixo = 1; fs.existsSync(path.join(AVALIACOES_DIR, nome)); sufixo++) nome = `${base}-${sufixo}.jsonl`;
    const linhas = registrosJsonl(dominio, resultado).map(r => JSON.stringify(r));
    fs.writeFileSync(path.join(AVALIACOES_DIR, nome), linhas.join('\n') + (linhas.length > 0 ? '\n' : ''));
    return nome;
}

/**
 * Conta tokens do Prompt Semantico e do plano no motor, uma linha por vez.
 * Assim que o motor diz que nao sabe (rota ausente, backend sem tokenizador),
 * DESISTE: nao repete a chamada condenada em cada uma das N linhas. Sem tokens,
 * os campos simplesmente nao existem — a analise mostra "—" e nenhuma
 * estimativa toma o lugar deles.
 */
function contadorDeTokens(tokenizar: Tokenizador): (
    prompt: string | undefined,
    plano: string | undefined,
    sinal: AbortSignal
) => Promise<Pick<GeracaoDoPlano, 'tokensPrompt' | 'tokensPlano'>> {
    let disponivel = true;
    return async (prompt, plano, sinal) => {
        const temPrompt = typeof prompt === 'string' && prompt.length > 0;
        const temPlano = typeof plano === 'string' && plano.length > 0;
        if (!disponivel || (!temPrompt && !temPlano)) return {};
        const tokens = await tokenizar([prompt ?? '', plano ?? ''], sinal);
        if (tokens === null) {
            disponivel = false;
            return {};
        }
        return {
            ...(temPrompt ? { tokensPrompt: tokens[0] } : {}),
            ...(temPlano ? { tokensPlano: tokens[1] } : {})
        };
    };
}

/** Anexa ao lado avaliado o bloco `geracao` (tempos repassados + tamanhos). */
async function comGeracao(
    registro: RegistroAvaliarGrafo,
    lado: DetalheLado,
    contar: ReturnType<typeof contadorDeTokens>,
    sinal: AbortSignal
): Promise<DetalheLado> {
    const geracao: GeracaoDoPlano = {
        ...(geracaoDoPlano(registro, lado.plano) ?? {}),
        ...(await contar(registro.promptSemantico, lado.plano, sinal))
    };
    return Object.keys(geracao).length > 0 ? { ...lado, geracao } : lado;
}

/** Julga arquitetura e depois baseline, sequencialmente — a engine ja serializa
 *  geracao via um lock interno (um modelo, uma chamada por vez), entao
 *  paralelizar aqui so complicaria o cancelamento sem ganhar tempo real. */
// ---------------------------------------------------------------------------
// Quem e o juiz desta avaliacao
// ---------------------------------------------------------------------------

/** O nome do modelo local por dominio, uma pergunta por processo. */
const modeloLocalPorDominio = new Map<string, string>();

/** `bartowski/Qwen2.5-7B-Instruct-GGUF/Qwen2.5-7B-Instruct-Q4_K_M.gguf` -> `Qwen2.5-7B-Instruct-Q4_K_M`. */
function rotuloDoModelo(bruto: string): string {
    return bruto.split('/').pop()!.replace(/\.gguf$/i, '');
}

/**
 * O MODELO que o juiz local usa, como o proprio motor o reporta
 * (`GET /health`). Vai para o campo `llm-judge` do JSONL, entao nao pode ser
 * chute: sem resposta do motor, cai no mesmo padrao que o main.py usa
 * (SPC_CML_MODEL) — e nao numa etiqueta inventada.
 */
async function nomeDoModeloLocal(dominio: 'med' | 'agro' | 'fut'): Promise<string> {
    const emCache = modeloLocalPorDominio.get(dominio);
    if (emCache) return emCache;
    const padrao = rotuloDoModelo(process.env.SPC_CML_MODEL ?? 'Qwen/Qwen2.5-7B-Instruct');
    let nome = padrao;
    try {
        const r = await fetch(`${motorDoDominio(dominio)}/health`, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
            const modelo = (await r.json()).modelo;
            if (typeof modelo === 'string' && modelo.length > 0) nome = rotuloDoModelo(modelo);
        }
    } catch {
        // Motor fora do ar ou sem /health: fica o padrao. Nao e motivo para
        // recusar a avaliacao — quem decide isso e a primeira chamada de verdade.
    }
    modeloLocalPorDominio.set(dominio, nome);
    return nome;
}

/** O juiz pedido no corpo de POST /api/avaliar. */
interface JuizPedido {
    provedor?: string;
    modelo?: string;
    apiKey?: string;
}

/**
 * Resolve o juiz do pedido: ausente (ou `local`) e o modelo do motor; um
 * provedor de fronteira exige chave (do corpo ou do ambiente) e vira um
 * `JuizLLM` proprio. Devolve `erro` quando o pedido nao da para atender — a
 * avaliacao nao comeca com um juiz que vai falhar em todas as linhas.
 */
async function resolverJuiz(
    pedido: JuizPedido | undefined,
    dominio: 'med' | 'agro' | 'fut'
): Promise<{ escolhido: JuizEscolhido } | { erro: string }> {
    const provedor = pedido?.provedor;
    if (provedor === undefined || provedor === 'local') {
        return { escolhido: { identidade: { provedor: 'local', modelo: await nomeDoModeloLocal(dominio) } } };
    }
    if (!ehProvedorFronteira(provedor)) {
        return { erro: `juiz.provedor deve ser 'local' ou um de: ${PROVEDORES_FRONTEIRA.join(', ')}` };
    }
    const chave = pedido?.apiKey?.trim() || chaveDoAmbiente(provedor);
    if (!chave) {
        return {
            erro: `informe a chave de API de ${PROVEDORES[provedor].nome}, ou defina ${PROVEDORES[provedor].variaveisDeAmbiente.join(' ou ')} no servidor`
        };
    }
    const modelo = modeloDoJuiz(provedor, pedido?.modelo);
    return {
        escolhido: {
            chamar: juizFronteira(provedor, chave, { modelo, timeoutMs: TIMEOUT_JUIZ_FRONTEIRA_MS }),
            identidade: { provedor, modelo }
        }
    };
}

/** O que muda numa avaliacao fora do padrao — hoje, o rejulgamento. */
interface OpcoesAvaliacaoComGrafo {
    /** Troca o juiz LLM da cascata por um modelo de fronteira. Ausente: o local. */
    juiz?: JuizEscolhido;
    /**
     * Ajusta as linhas ANTES de agregar os tempos e gravar o JSONL — o
     * rejulgamento usa para anexar a cada plano o julgamento que o arquivo
     * importado ja tinha. Nao toca nas metricas, que saem dos lados avaliados.
     */
    ajustarLinhas?: (linhas: DetalheLinha[]) => DetalheLinha[];
}

async function avaliarComGrafo(
    dominio: 'med' | 'agro' | 'fut',
    arquitetura: RegistroAvaliarGrafo[] | undefined,
    baseline: RegistroAvaliarGrafo[] | undefined,
    onProgresso: (processados: number, total: number) => void,
    sinal: AbortSignal,
    nomeEntrada?: string,
    opcoes: OpcoesAvaliacaoComGrafo = {}
): Promise<ResultadoAvaliacaoGrafo> {
    const inicio = performance.now();
    const deps = dependenciasAvaliacao(dominio, sinal, false, opcoes.juiz);

    const total = (arquitetura?.length ?? 0) + (baseline?.length ?? 0);
    let processados = 0;

    // Tokens do Prompt Semantico e do plano: medidos no motor, por linha.
    const contarTokens = contadorDeTokens(tokenizadorHttp(motorDoDominio(dominio), TIMEOUT_MS));

    const ladosArq = new Map<RegistroAvaliarGrafo, DetalheLado>();
    for (const registro of arquitetura ?? []) {
        if (sinal.aborted) break;
        const lado = await avaliarRegistro(dominio, registro, deps);
        ladosArq.set(registro, await comGeracao(registro, lado, contarTokens, sinal));
        onProgresso(++processados, total);
    }

    const ladosBase = new Map<RegistroAvaliarGrafo, DetalheLado>();
    for (const registro of baseline ?? []) {
        if (sinal.aborted) break;
        const lado = await avaliarRegistro(dominio, registro, deps);
        ladosBase.set(registro, await comGeracao(registro, lado, contarTokens, sinal));
        onProgresso(++processados, total);
    }

    const pareadas: DetalheLinha[] = parearRegistros(arquitetura ?? [], baseline ?? []).map((par, i) =>
        montarLinha(i + 1, par.intencao, par.a ? ladosArq.get(par.a) : undefined, par.b ? ladosBase.get(par.b) : undefined)
    );
    const linhas = opcoes.ajustarLinhas ? opcoes.ajustarLinhas(pareadas) : pareadas;

    const naoAvaliados = [...ladosArq.values(), ...ladosBase.values()].filter(d => d.naoAvaliado).length;

    const todos = [...ladosArq.values(), ...ladosBase.values()];
    const somaSegundos = (campo: 'sintaxeMs' | 'oraculoMs' | 'llmJudgeMs' | 'diagnosticoMs'): number =>
        Math.round(todos.reduce((acc, d) => acc + (d.tempos?.[campo] ?? 0), 0) / 10) / 100;

    // Tempos de GERAÇÃO: não medidos aqui, só repassados do que o lote do
    // web-chat gravou em cada registro de ENTRADA (tempos-lote.ts, web-chat) e
    // agregados. Ausente (não soma 0) quando NENHUM registro trouxe o tempo —
    // arquivo que não veio do lote, ou de antes da medição.
    const entradas = [...(arquitetura ?? []), ...(baseline ?? [])];
    const somaSegundosGeracao = (
        campo: 'tempoTotalMs' | 'tempoSequenciasMs' | 'tempoPIsValidasMs' | 'tempoValidacaoPlanosMs'
    ): number | undefined => {
        const valores = entradas.map(r => r[campo]).filter((v): v is number => typeof v === 'number');
        return valores.length === 0 ? undefined : Math.round(valores.reduce((a, b) => a + b, 0) / 10) / 100;
    };

    const resultado: ResultadoAvaliacaoGrafo = {
        arquitetura: arquitetura ? agregarMetricas([...ladosArq.values()]) : undefined,
        baseline: baseline ? agregarMetricas([...ladosBase.values()]) : undefined,
        naoAvaliados,
        linhas,
        ...(opcoes.juiz ? { juiz: opcoes.juiz.identidade } : {}),
        tempoTotalSegundos: Math.round((performance.now() - inicio) / 10) / 100,
        tempoSintaxeSegundos: somaSegundos('sintaxeMs'),
        tempoOraculoSegundos: somaSegundos('oraculoMs'),
        tempoLlmJudgeSegundos: somaSegundos('llmJudgeMs'),
        // Separado do juiz: so os planos com UNRESOLVED somam; ausente quando nenhum foi diagnosticado.
        ...(todos.some(d => d.tempos?.diagnosticoMs !== undefined) && { tempoDiagnosticoSegundos: somaSegundos('diagnosticoMs') }),
        tempoGeracaoTotalSegundos: somaSegundosGeracao('tempoTotalMs'),
        tempoGeracaoSequenciasSegundos: somaSegundosGeracao('tempoSequenciasMs'),
        tempoGeracaoPIsValidasSegundos: somaSegundosGeracao('tempoPIsValidasMs'),
        tempoGeracaoValidacaoPlanosSegundos: somaSegundosGeracao('tempoValidacaoPlanosMs')
    };
    if (!sinal.aborted) resultado.arquivoJsonl = gravarAvaliacao(dominio, resultado, nomeEntrada);
    return resultado;
}

function lerCorpo(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let corpo = '';
        req.on('data', chunk => (corpo += chunk));
        req.on('end', () => resolve(corpo));
        req.on('error', reject);
    });
}

// ===========================================================================
// Fusão de cenários, resultados e avaliações (ver inference/fusao-avaliacoes.ts)
// ===========================================================================

const EXEMPLOS_DIR = path.join('src', 'examples');

/** Lê um JSONL de cenários/desenho sem transformar nada. Linha inválida aborta. */
function lerJsonl(caminho: string): RegistroCenario[] {
    const registros: RegistroCenario[] = [];
    for (const [i, linha] of fs.readFileSync(caminho, 'utf-8').split(/\r?\n/).entries()) {
        if (!linha.trim()) continue;
        try {
            registros.push(JSON.parse(linha) as RegistroCenario);
        } catch {
            throw new Error(`${caminho}: JSON invalido na linha ${i + 1}`);
        }
    }
    return registros;
}

/**
 * Acha o `cenarios-*.jsonl` da entrada de uma avaliação pelo nome do arquivo:
 * `evalueted_<base>_<carimbo>.jsonl` -> `src/examples/<dominio>/<base>.jsonl`.
 * Com o domínio conhecido procura só nele; sem domínio, nos três — e o `.meta`
 * do mesmo lote entra quando existir.
 */
function cenarioDaAvaliacao(
    nomeAvaliacao: string,
    dominio: string | null
): { cenarios?: FonteFusao['cenarios']; meta?: FonteFusao['meta'] } {
    const base = baseDoArquivoAvaliacao(nomeAvaliacao);
    if (!base) return {};
    const onde = ehDominio(dominio) ? [dominio] : DOMINIOS;
    for (const d of onde) {
        const caminho = path.join(EXEMPLOS_DIR, d, `${base}.jsonl`);
        if (!fs.existsSync(caminho)) continue;
        const caminhoMeta = path.join(EXEMPLOS_DIR, d, `${base}.meta.jsonl`);
        return {
            cenarios: { arquivo: caminho, registros: lerJsonl(caminho) },
            ...(fs.existsSync(caminhoMeta)
                ? { meta: { arquivo: caminhoMeta, registros: lerJsonl(caminhoMeta) } }
                : {})
        };
    }
    return {};
}

/**
 * Um cenário escolhível na tela, identificado por `<dominio>/<arquivo>`. Só
 * `cenarios-*.jsonl` de `src/examples/<dominio>/`, e nunca os derivados
 * (`.meta.jsonl`, `.contrastes.jsonl`), que não são entrada de nada.
 */
const ARQUIVO_CENARIO_REGEX = /^cenarios[A-Za-z0-9._-]*\.jsonl$/;
const DERIVADO_REGEX = /\.(meta|contrastes)\.jsonl$/;

interface CenarioDisponivel {
    /** `<dominio>/<arquivo>` — o identificador que a rota aceita. */
    id: string;
    dominio: string;
    arquivo: string;
    caminho: string;
    linhas: number;
    bytes: number;
    /** O campo que identifica o sujeito neste domínio (`talhao`, `partida`, `paciente`). */
    chaveSujeito: string;
    /** Existe `<base>.meta.jsonl` ao lado: a fusão pode trazer o desenho do lote. */
    desenho: boolean;
}

/** Valida e resolve um `<dominio>/<arquivo>` para um caminho dentro de src/examples. */
function resolverCenario(id: string): { dominio: string; arquivo: string; caminho: string } | null {
    const barra = id.indexOf('/');
    if (barra < 0) return null;
    const dominio = id.slice(0, barra);
    const arquivo = id.slice(barra + 1);
    if (!ehDominio(dominio) || !ARQUIVO_CENARIO_REGEX.test(arquivo) || DERIVADO_REGEX.test(arquivo)) return null;
    const caminho = path.join(EXEMPLOS_DIR, dominio, arquivo);
    if (!fs.existsSync(caminho)) return null;
    return { dominio, arquivo, caminho };
}

const cacheCenarios = new Map<string, CenarioDisponivel>();

function listarCenarios(): CenarioDisponivel[] {
    const saida: CenarioDisponivel[] = [];
    for (const dominio of DOMINIOS) {
        const dir = path.join(EXEMPLOS_DIR, dominio);
        if (!fs.existsSync(dir)) continue;
        for (const arquivo of fs.readdirSync(dir).sort()) {
            if (!ARQUIVO_CENARIO_REGEX.test(arquivo) || DERIVADO_REGEX.test(arquivo)) continue;
            const caminho = path.join(dir, arquivo);
            const st = fs.statSync(caminho);
            const chave = `${dominio}/${arquivo}|${st.mtimeMs}|${st.size}`;
            let item = cacheCenarios.get(chave);
            if (!item) {
                item = {
                    id: `${dominio}/${arquivo}`,
                    dominio,
                    arquivo,
                    caminho,
                    linhas: lerJsonl(caminho).length,
                    bytes: st.size,
                    chaveSujeito: CHAVE_SUJEITO[dominio],
                    desenho: fs.existsSync(caminho.replace(/\.jsonl$/, '.meta.jsonl'))
                };
                cacheCenarios.set(chave, item);
            }
            saida.push(item);
        }
    }
    return saida;
}

/** O cenário de um id escolhido na tela, com o desenho ao lado quando existe. */
function cenarioEscolhido(id: string): { cenarios?: FonteFusao['cenarios']; meta?: FonteFusao['meta'] } {
    const alvo = resolverCenario(id);
    if (!alvo) return {};
    const caminhoMeta = alvo.caminho.replace(/\.jsonl$/, '.meta.jsonl');
    return {
        cenarios: { arquivo: alvo.caminho, registros: lerJsonl(alvo.caminho) },
        ...(fs.existsSync(caminhoMeta) ? { meta: { arquivo: caminhoMeta, registros: lerJsonl(caminhoMeta) } } : {})
    };
}

interface ResumoArquivoAvaliacao {
    arquivo: string;
    bytes: number;
    modificadoEm: string;
    registros: number;
    dominios: string[];
    lados: string[];
    base: string | null;
    /** O cenário de entrada, quando localizado pelo nome — o que a fusão vai juntar. */
    cenario: { arquivo: string; linhas: number; desenho: boolean } | null;
    /** Cenários sem registro de avaliação: a assinatura de lote interrompido. */
    semAvaliacao: number | null;
}

/** Releitura é caro (dezenas de MB): memoriza por nome + mtime + tamanho. */
const cacheResumo = new Map<string, ResumoArquivoAvaliacao>();

function resumirArquivoAvaliacao(nome: string): ResumoArquivoAvaliacao {
    const caminho = path.join(AVALIACOES_DIR, nome);
    const st = fs.statSync(caminho);
    const chave = `${nome}|${st.mtimeMs}|${st.size}`;
    const emCache = cacheResumo.get(chave);
    if (emCache) return emCache;

    const avaliacoes = parseRegistrosAvaliacao(fs.readFileSync(caminho, 'utf-8'));
    const dominios = [...new Set(avaliacoes.map(r => r.dominio).filter((d): d is string => !!d))].sort();
    const { cenarios, meta } = cenarioDaAvaliacao(nome, dominios.length === 1 ? dominios[0] : null);
    const linhasComAvaliacao = new Set(avaliacoes.map(r => r.linha).filter((l): l is number => typeof l === 'number'));

    const resumo: ResumoArquivoAvaliacao = {
        arquivo: nome,
        bytes: st.size,
        modificadoEm: st.mtime.toISOString(),
        registros: avaliacoes.length,
        dominios,
        lados: [...new Set(avaliacoes.map(r => r.lado).filter((l): l is string => !!l))].sort(),
        base: baseDoArquivoAvaliacao(nome),
        cenario: cenarios ? { arquivo: cenarios.arquivo, linhas: cenarios.registros.length, desenho: !!meta } : null,
        semAvaliacao: cenarios
            ? cenarios.registros.filter((_, i) => !linhasComAvaliacao.has(i + 1)).length
            : null
    };
    cacheResumo.set(chave, resumo);
    return resumo;
}

function listarArquivosAvaliacao(): string[] {
    return fs
        .readdirSync(AVALIACOES_DIR)
        .filter(n => ARQUIVO_AVALIACAO_REGEX.test(n))
        .sort((a, b) => b.localeCompare(a));
}

/**
 * As fontes da fusão.
 *
 * `avaliacoes` são os `evalueted_*.jsonl`; cada um recebe o cenário que
 * `cenarioPorAvaliacao` mandar (escolha da tela), ou o descoberto pelo nome, ou
 * NENHUM quando a escolha for `nenhum` — o caso de querer só o veredito, sem
 * arriscar casar com o cenário errado. `cenariosAvulsos` entram como fontes
 * próprias, sem avaliação: é como se pede um conjunto só de entradas.
 */
function montarFontes(
    avaliacoes: string[],
    cenariosAvulsos: string[],
    cenarioPorAvaliacao: Map<string, string>
): FonteFusao[] {
    const fontes: FonteFusao[] = avaliacoes.map(nome => {
        const registros = parseRegistrosAvaliacao(fs.readFileSync(path.join(AVALIACOES_DIR, nome), 'utf-8'));
        const dominios = [...new Set(registros.map(r => r.dominio).filter((d): d is string => !!d))];
        const escolha = cenarioPorAvaliacao.get(nome);
        const cenario =
            escolha === 'nenhum'
                ? {}
                : escolha
                  ? cenarioEscolhido(escolha)
                  : cenarioDaAvaliacao(nome, dominios.length === 1 ? dominios[0] : null);
        return { arquivo: nome, tipo: 'avaliacao' as const, avaliacoes: registros, ...cenario };
    });

    for (const id of cenariosAvulsos) {
        const alvo = resolverCenario(id)!;
        fontes.push({
            arquivo: alvo.caminho,
            tipo: 'cenario' as const,
            dominio: alvo.dominio,
            avaliacoes: [],
            ...cenarioEscolhido(id)
        });
    }
    return fontes;
}

// ===========================================================================
// REJULGAMENTO (POST /api/rejulgar) — os MESMOS planos, outro juiz
//
// A tela de importacao carrega um `evalueted_*.jsonl` ja avaliado e pede para
// rejulgar aqueles planos com um modelo de fronteira (ver juiz-fronteira.ts). O
// objetivo e medir o JUIZ: o oraculo deterministico continua a referencia
// normativa, e o que se compara e quanto cada juiz o acompanha (ver
// comparacao-juizes.ts).
//
// POR QUE PRECISA DO CENARIO: o juiz nao le o plano sozinho. Ele le o pedido, a
// telemetria, o conhecimento recuperado e as evidencias — o `PedidoJuiz` que
// `pedidoDoJuiz` monta da MESMA recuperacao que a semantica usa. O
// `evalueted_*.jsonl` NAO guarda esse contexto (`registrosJsonl` tira o
// `contextoGrafo`, que e grande e se reconstroi), e a telemetria do cenario
// nunca esteve nele. Entao o rejulgamento refaz o caminho inteiro a partir do
// `cenarios-*.jsonl` de entrada: o mesmo grafo, a mesma recuperacao, o mesmo
// prompt — so o modelo muda. Sem o cenario, rejulgar daria ao modelo de
// fronteira um contexto mais pobre do que o juiz local teve, e a comparacao nao
// mediria o juiz: mediria a falta de contexto.
//
// Consequencia aceita: a cascata roda inteira (sintaxe, semantica, oraculo),
// nao so o juiz. E barato perto do julgamento (segundos contra minutos) e tem
// um brinde: o oraculo recalculado permite ver se o veredito normativo do
// arquivo importado se reproduz no grafo de hoje.
// ===========================================================================

/** As entradas da avaliacao reconstruidas a partir do arquivo importado + o cenario. */
interface EntradasRejulgamento {
    arquitetura: RegistroAvaliarGrafo[];
    baseline: RegistroAvaliarGrafo[];
    /** Registros casados pelo sujeito (chave forte) e pelo numero de linha. */
    casadosPorSujeito: number;
    casadosPorLinha: number;
    /** Registros do arquivo que nao acharam linha de cenario: ficam de fora. */
    semCenario: number;
    /** Registros sem plano ou sem lado: nao ha o que rejulgar. */
    semPlano: number;
}

/**
 * Casa cada registro avaliado com a sua linha de cenario e monta a entrada da
 * avaliacao: o PLANO vem do arquivo importado (e o plano que se quer rejulgar) e
 * a LEITURA vem do cenario (a telemetria, os contextos e os itens em uso que o
 * grafo precisa). Mesma ordem de chaves da fusao — sujeito primeiro, que
 * sobrevive a renumeracao das linhas, e o numero da linha depois.
 *
 * Os tempos de GERACAO que o arquivo importado trazia sao repassados, para o
 * arquivo rejulgado continuar servindo as analises de tempo. `charsPrompt` nao:
 * ele vinha do Prompt Semantico da geracao, que o arquivo nao guarda — campo
 * ausente continua ausente, nada e estimado.
 */
function entradasDoRejulgamento(
    importados: readonly RegistroAvaliacaoImportado[],
    cenarios: readonly RegistroCenario[],
    dominio: 'med' | 'agro' | 'fut'
): EntradasRejulgamento {
    const porSujeito = new Map<string, RegistroCenario>();
    const porLinha = new Map<number, RegistroCenario>();
    for (const [i, c] of cenarios.entries()) {
        const sujeito = sujeitoDoCenario(c, dominio);
        if (sujeito !== null && !porSujeito.has(sujeito)) porSujeito.set(sujeito, c);
        porLinha.set(i + 1, c);
    }

    const saida: EntradasRejulgamento = {
        arquitetura: [],
        baseline: [],
        casadosPorSujeito: 0,
        casadosPorLinha: 0,
        semCenario: 0,
        semPlano: 0
    };

    for (const r of importados) {
        if (typeof r.plano !== 'string' || r.plano.length === 0 || (r.lado !== 'arquitetura' && r.lado !== 'baseline')) {
            saida.semPlano++;
            continue;
        }
        let cenario: RegistroCenario | undefined;
        if (r.sujeito && porSujeito.has(r.sujeito)) {
            cenario = porSujeito.get(r.sujeito);
            saida.casadosPorSujeito++;
        } else if (typeof r.linha === 'number' && porLinha.has(r.linha)) {
            cenario = porLinha.get(r.linha);
            saida.casadosPorLinha++;
        } else {
            saida.semCenario++;
            continue;
        }

        const g = r.geracao ?? {};
        saida[r.lado].push({
            ...(typeof r.linha === 'number' ? { linha: r.linha } : {}),
            intencao: r.intencao ?? (typeof cenario!.intencao === 'string' ? cenario!.intencao : ''),
            plano: r.plano,
            telemetria: cenario as BlocoTelemetriaGrafo,
            ...sePresenteNoRegistro({
                tempoTotalMs: g.tempoTotalMs,
                tempoSequenciasMs: g.tempoSequenciasMs,
                tempoPIsValidasMs: g.tempoPIsValidasMs,
                tempoValidacaoPlanosMs: g.tempoValidacaoPlanosMs,
                tempoValidacaoMs: g.tempoValidacaoMs,
                tempoGeracaoDescartadaMs: g.tempoGeracaoDescartadaMs,
                tempoCenarioMs: g.tempoCenarioMs,
                tentativasGeracao: g.tentativasGeracao
            })
        });
    }
    return saida;
}

/** Campo ausente no registro importado continua ausente na entrada. */
function sePresenteNoRegistro<T extends object>(valores: T): Partial<T> {
    return Object.fromEntries(Object.entries(valores).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;
}

/** A resposta de /api/rejulgar: a avaliacao nova + a comparacao dos dois juizes. */
interface RespostaRejulgamento extends ResultadoAvaliacaoGrafo {
    comparacaoJuizes: ComparacaoJuizes;
    /** De onde veio a leitura do cenario, e o que ficou de fora do rejulgamento. */
    rejulgamento: {
        arquivoImportado?: string;
        arquivoCenario: string;
        registrosImportados: number;
        rejulgados: number;
        casadosPorSujeito: number;
        casadosPorLinha: number;
        semCenario: number;
        semPlano: number;
    };
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
                /** Gate: gera, avalia (oraculo e/ou juiz) e regera ate aprovar (ver processarComGate). */
                validacao?: ValidacaoPedida;
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
            // O gate anuncia validacao e regeracao sem a pausa cosmetica: essas
            // mensagens acompanham trabalho que leva segundos, nao milissegundos.
            const estagioDoGate: EmitirEstagio = async texto => {
                emitir('estagio', { texto });
            };

            // Cliente que desiste (o lote cancelado, a aba fechada) aborta o que
            // ainda nao comecou: sem isto o gate seguiria gerando tentativa apos
            // tentativa para ninguem, prendendo o motor.
            const controlador = new AbortController();
            req.on('close', () => controlador.abort());

            try {
                const resultado =
                    corpo.validacao?.ativa === true
                        ? await processarComGate(dominio, texto, estagio, estagioDoGate, corpo.contexto, corpo.validacao, controlador.signal)
                        : await processarDominio(dominio, texto, estagio, corpo.contexto);
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
                /** Nome do arquivo de entrada (o da Arquitetura; senao o da Baseline): vira o nome do arquivo da avaliacao. */
                nomeEntrada?: string;
                /**
                 * Quem faz o papel do LLM Judge: ausente ou `local` e o modelo do
                 * motor; um provedor de fronteira troca SO o modelo do juiz (ver
                 * juiz-fronteira.ts). A geracao dos planos nao passa por aqui —
                 * este pedido avalia planos que ja existem no arquivo enviado.
                 */
                juiz?: JuizPedido;
            };
            if (corpo.dominio !== 'med' && corpo.dominio !== 'agro' && corpo.dominio !== 'fut') {
                jsonResponse(res, 400, { erro: "dominio deve ser 'med', 'agro' ou 'fut'" });
                return;
            }
            if (!corpo.arquiteturaJsonl && !corpo.baselineJsonl) {
                jsonResponse(res, 400, { erro: 'envie ao menos um arquivo (arquitetura e/ou baseline)' });
                return;
            }

            const juiz = await resolverJuiz(corpo.juiz, corpo.dominio);
            if ('erro' in juiz) {
                jsonResponse(res, 400, { erro: juiz.erro });
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
                    controlador.signal,
                    corpo.nomeEntrada,
                    { juiz: juiz.escolhido }
                );
                emitir('final', resultado);
            } catch (error) {
                emitir('erro', { erro: (error as Error).message });
            } finally {
                res.end();
            }
            return;
        }

        // Quem pode fazer o papel do LLM Judge: o modelo LOCAL (como o motor do
        // dominio o reporta) e os provedores de fronteira, com o modelo padrao
        // de cada um e se a chave dele JA esta no ambiente do servidor — so o
        // booleano: a chave nunca sai daqui.
        if (req.method === 'GET' && req.url?.startsWith('/api/juizes')) {
            const pedido = new URL(req.url, 'http://localhost').searchParams.get('dominio');
            const dominio = ehDominio(pedido) ? pedido : 'med';
            jsonResponse(res, 200, {
                local: { provedor: 'local', modelo: await nomeDoModeloLocal(dominio) },
                fronteira: PROVEDORES_FRONTEIRA.map(id => ({
                    id,
                    nome: PROVEDORES[id].nome,
                    modeloPadrao: PROVEDORES[id].modeloPadrao,
                    chaveNoServidor: chaveDoAmbiente(id) !== undefined,
                    variaveisDeAmbiente: [...PROVEDORES[id].variaveisDeAmbiente]
                }))
            });
            return;
        }

        // TESTE DE CONEXAO de um provedor de fronteira, antes de gastar uma
        // avaliacao inteira para descobrir que a chave esta errada: faz UM
        // julgamento de brinquedo (ver `testarConexaoJuiz`) pelo mesmo caminho
        // que o rejulgamento usa — mesma URL, mesmo cabecalho, mesmo prompt,
        // mesma leitura da resposta —, so sem repetir em 429/5xx.
        //
        // Responde 200 tambem quando o teste FALHA: a falha e o resultado do
        // teste, nao um erro desta rota. 400 e so para pedido mal formado.
        //
        // A chave chega no corpo, vive na memoria deste pedido e nao volta na
        // resposta, nao entra em log e nao vai para disco. Sem chave no corpo,
        // o teste usa a do ambiente — assim se confere a chave do servidor.
        if (req.method === 'POST' && req.url === '/api/juizes/testar') {
            const corpo = JSON.parse((await lerCorpo(req)) || '{}') as {
                provedor?: string;
                /** O modelo a testar. Vazio: o padrao do provedor. */
                modelo?: string;
                /** A chave a testar. Vazia: a do ambiente do servidor, quando existir. */
                apiKey?: string;
            };

            if (!ehProvedorFronteira(corpo.provedor)) {
                jsonResponse(res, 400, { erro: `provedor deve ser um de: ${PROVEDORES_FRONTEIRA.join(', ')}` });
                return;
            }
            const provedor: ProvedorFronteira = corpo.provedor;
            const doPedido = corpo.apiKey?.trim();
            const chave = doPedido || chaveDoAmbiente(provedor);
            if (!chave) {
                jsonResponse(res, 400, {
                    erro: `informe a chave de API de ${PROVEDORES[provedor].nome}, ou defina ${PROVEDORES[provedor].variaveisDeAmbiente.join(' ou ')} no servidor`
                });
                return;
            }

            // Fechar a tela no meio do teste aborta a chamada ao provedor.
            const controlador = new AbortController();
            req.on('close', () => controlador.abort());
            try {
                const resultado = await testarConexaoJuiz(provedor, chave, {
                    modelo: corpo.modelo,
                    timeoutMs: TIMEOUT_TESTE_JUIZ_MS,
                    sinal: controlador.signal
                });
                jsonResponse(res, 200, { ...resultado, chaveDoAmbiente: !doPedido });
            } catch {
                // Unica saida por excecao: o cancelamento acima. Sem tela do
                // outro lado, nao ha o que responder.
                if (!res.writableEnded) res.end();
            }
            return;
        }

        // Rejulga os planos de uma avaliacao ja feita com um modelo de FRONTEIRA
        // no lugar do juiz local (ver juiz-fronteira.ts e o bloco REJULGAMENTO
        // acima). Mesmo SSE de /api/avaliar: progresso por plano e cancelamento
        // ao fechar a conexao. A chave de API fica so na memoria deste pedido.
        if (req.method === 'POST' && req.url === '/api/rejulgar') {
            const corpo = JSON.parse((await lerCorpo(req)) || '{}') as {
                dominio?: string;
                /** O `evalueted_*.jsonl` ja avaliado, inteiro. */
                avaliacaoJsonl?: string;
                /** Nome do arquivo importado: acha o `cenarios-*.jsonl` de entrada e nomeia o novo arquivo. */
                nomeArquivo?: string;
                /** `<dominio>/<arquivo>` para escolher o cenario a mao, quando o nome nao basta. */
                cenario?: string;
                provedor?: string;
                modelo?: string;
                apiKey?: string;
            };

            if (!ehProvedorFronteira(corpo.provedor)) {
                jsonResponse(res, 400, { erro: `provedor deve ser um de: ${PROVEDORES_FRONTEIRA.join(', ')}` });
                return;
            }
            const provedor: ProvedorFronteira = corpo.provedor;
            if (!corpo.avaliacaoJsonl) {
                jsonResponse(res, 400, { erro: 'envie o arquivo de avaliacao (JSONL) a rejulgar' });
                return;
            }

            let importados: RegistroAvaliacaoImportado[];
            try {
                importados = parseRegistrosAvaliacao(corpo.avaliacaoJsonl);
            } catch (error) {
                jsonResponse(res, 400, { erro: `falha ao interpretar o arquivo enviado: ${(error as Error).message}` });
                return;
            }

            // O dominio vem do proprio arquivo; a tela so manda quando o arquivo
            // mistura dominios (ai nao da para rejulgar os dois de uma vez).
            const dosRegistros = [...new Set(importados.map(r => r.dominio).filter(ehDominio))];
            const dominio = ehDominio(corpo.dominio) ? corpo.dominio : dosRegistros.length === 1 ? dosRegistros[0] : undefined;
            if (!dominio) {
                jsonResponse(res, 400, {
                    erro:
                        dosRegistros.length > 1
                            ? `o arquivo tem mais de um dominio (${dosRegistros.join(', ')}): rejulgue um por vez`
                            : 'nao foi possivel saber o dominio do arquivo: informe-o no pedido'
                });
                return;
            }

            const chave = corpo.apiKey?.trim() || chaveDoAmbiente(provedor);
            if (!chave) {
                jsonResponse(res, 400, {
                    erro: `informe a chave de API de ${PROVEDORES[provedor].nome}, ou defina ${PROVEDORES[provedor].variaveisDeAmbiente.join(' ou ')} no servidor`
                });
                return;
            }

            // O cenario de entrada: o escolhido na tela, senao o que o nome do
            // arquivo indica. Ele e OBRIGATORIO — e dele que sai a leitura que o
            // juiz le (ver o bloco REJULGAMENTO).
            const escolhido = corpo.cenario ? resolverCenario(corpo.cenario) : null;
            if (corpo.cenario && !escolhido) {
                jsonResponse(res, 400, { erro: `cenario nao encontrado: ${corpo.cenario}` });
                return;
            }
            if (escolhido && escolhido.dominio !== dominio) {
                jsonResponse(res, 400, { erro: `o cenario escolhido e de ${escolhido.dominio}, e o arquivo e de ${dominio}` });
                return;
            }
            const cenario = escolhido
                ? { arquivo: escolhido.caminho, registros: lerJsonl(escolhido.caminho) }
                : cenarioDaAvaliacao(corpo.nomeArquivo ?? '', dominio).cenarios;
            if (!cenario) {
                const base = baseDoArquivoAvaliacao(corpo.nomeArquivo ?? '');
                jsonResponse(res, 400, {
                    erro: base
                        ? `nao achei o cenario de entrada (src/examples/${dominio}/${base}.jsonl): escolha o arquivo de cenarios na tela`
                        : 'o nome do arquivo nao diz qual cenario foi a entrada: escolha o arquivo de cenarios na tela'
                });
                return;
            }

            const entradas = entradasDoRejulgamento(importados, cenario.registros, dominio);
            const rejulgados = entradas.arquitetura.length + entradas.baseline.length;
            if (rejulgados === 0) {
                jsonResponse(res, 400, {
                    erro: `nenhum plano do arquivo casou com uma linha de ${path.basename(cenario.arquivo)} (${entradas.semCenario} sem cenario, ${entradas.semPlano} sem plano): confira o cenario escolhido`
                });
                return;
            }

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

            const identidade: IdentidadeJuiz = { provedor, modelo: modeloDoJuiz(provedor, corpo.modelo) };
            let pareados = 0;
            let semPar = 0;
            try {
                const resultado = await avaliarComGrafo(
                    dominio,
                    entradas.arquitetura.length > 0 ? entradas.arquitetura : undefined,
                    entradas.baseline.length > 0 ? entradas.baseline : undefined,
                    (processados, total) => emitir('progresso', { processados, total }),
                    controlador.signal,
                    // O nome do CENARIO (nao o do arquivo importado): o arquivo
                    // rejulgado continua casando com a sua entrada pelo nome.
                    path.basename(cenario.arquivo),
                    {
                        juiz: {
                            chamar: juizFronteira(provedor, chave, { modelo: identidade.modelo, timeoutMs: TIMEOUT_JUIZ_FRONTEIRA_MS }),
                            identidade
                        },
                        ajustarLinhas: linhas => {
                            const p = anexarJulgamentoAnterior(linhas, importados);
                            pareados = p.pareados;
                            semPar = p.semPar;
                            return p.linhas;
                        }
                    }
                );
                const resposta: RespostaRejulgamento = {
                    ...resultado,
                    comparacaoJuizes: compararJuizes(resultado.linhas, identidade, dominio),
                    rejulgamento: {
                        ...(corpo.nomeArquivo ? { arquivoImportado: corpo.nomeArquivo } : {}),
                        arquivoCenario: path.basename(cenario.arquivo),
                        registrosImportados: importados.length,
                        rejulgados: pareados + semPar,
                        casadosPorSujeito: entradas.casadosPorSujeito,
                        casadosPorLinha: entradas.casadosPorLinha,
                        semCenario: entradas.semCenario,
                        semPlano: entradas.semPlano
                    }
                };
                emitir('final', resposta);
            } catch (error) {
                emitir('erro', { erro: (error as Error).message });
            } finally {
                res.end();
            }
            return;
        }

        // Lista as avaliacoes gravadas, cada uma com o cenario de entrada que a
        // fusao vai juntar e quantas linhas daquele cenario ficaram sem avaliacao.
        if (req.method === 'GET' && (req.url === '/api/avaliacoes' || req.url === '/api/avaliacoes/')) {
            const arquivos = listarArquivosAvaliacao().map(nome => {
                try {
                    return resumirArquivoAvaliacao(nome);
                } catch (error) {
                    // Arquivo corrompido nao derruba a listagem: ele aparece com o erro.
                    const st = fs.statSync(path.join(AVALIACOES_DIR, nome));
                    return {
                        arquivo: nome,
                        bytes: st.size,
                        modificadoEm: st.mtime.toISOString(),
                        registros: 0,
                        dominios: [],
                        lados: [],
                        base: baseDoArquivoAvaliacao(nome),
                        cenario: null,
                        semAvaliacao: null,
                        erro: (error as Error).message
                    };
                }
            });
            jsonResponse(res, 200, arquivos);
            return;
        }

        // Os cenarios escolhiveis na tela da fusao: um id `<dominio>/<arquivo>`
        // por `cenarios-*.jsonl` de src/examples, sem os derivados.
        if (req.method === 'GET' && (req.url === '/api/cenarios' || req.url === '/api/cenarios/')) {
            jsonResponse(res, 200, listarCenarios());
            return;
        }

        // A FUSAO: cenario + resultado + avaliacao, de quantos arquivos (e
        // dominios) se pedir. `formato=resumo` devolve so a cobertura, para a
        // tela conferir antes de baixar; `jsonl` e `csv` devolvem o arquivo.
        if (req.method === 'GET' && req.url?.startsWith('/api/fusao')) {
            const url = new URL(req.url, 'http://localhost');
            const lerLista = (...nomesParam: string[]): string[] =>
                nomesParam
                    .flatMap(n => url.searchParams.getAll(n))
                    .flatMap(v => v.split(','))
                    .map(v => v.trim())
                    .filter(v => v.length > 0);

            // `arquivo` continua valendo como nome do parametro de avaliacao.
            const pedidos = [...new Set(lerLista('avaliacao', 'avaliacoes', 'arquivo', 'arquivos'))];
            const invalidos = pedidos.filter(n => !ARQUIVO_AVALIACAO_REGEX.test(n));
            if (invalidos.length > 0) {
                jsonResponse(res, 400, { erro: `nome de avaliacao invalido: ${invalidos.join(', ')}` });
                return;
            }
            const ausentes = pedidos.filter(n => !fs.existsSync(path.join(AVALIACOES_DIR, n)));
            if (ausentes.length > 0) {
                jsonResponse(res, 404, { erro: `avaliacao nao encontrada: ${ausentes.join(', ')}` });
                return;
            }

            // Cenarios avulsos: fontes sem avaliacao, para o modo que quer so a entrada.
            const cenariosPedidos = [...new Set(lerLista('cenario', 'cenarios'))];
            const cenariosInvalidos = cenariosPedidos.filter(id => resolverCenario(id) === null);
            if (cenariosInvalidos.length > 0) {
                jsonResponse(res, 400, {
                    erro: `cenario invalido ou inexistente: ${cenariosInvalidos.join(', ')} (use <dominio>/<arquivo>)`
                });
                return;
            }

            // `cenarioDe=<avaliacao>:<dominio>/<arquivo>` escolhe o cenario de UMA
            // avaliacao; `:nenhum` desliga a juncao dela.
            const cenarioPorAvaliacao = new Map<string, string>();
            for (const par of lerLista('cenarioDe')) {
                const corte = par.indexOf(':');
                const alvo = corte < 0 ? '' : par.slice(0, corte);
                const escolha = corte < 0 ? '' : par.slice(corte + 1);
                if (!pedidos.includes(alvo)) {
                    jsonResponse(res, 400, { erro: `cenarioDe aponta para avaliacao fora da selecao: ${par}` });
                    return;
                }
                if (escolha !== 'nenhum' && resolverCenario(escolha) === null) {
                    jsonResponse(res, 400, { erro: `cenarioDe com cenario invalido: ${par}` });
                    return;
                }
                cenarioPorAvaliacao.set(alvo, escolha);
            }

            // Sem selecao nenhuma, funde TODAS as avaliacoes — "quero o dataset inteiro".
            const nomes = pedidos.length > 0 || cenariosPedidos.length > 0 ? pedidos : listarArquivosAvaliacao();
            if (nomes.length === 0 && cenariosPedidos.length === 0) {
                jsonResponse(res, 404, { erro: 'nenhuma avaliacao gravada para fundir' });
                return;
            }

            // O MODO DE FUSAO: quais das tres partes vao no registro.
            const partesPedidas = lerLista('parte', 'partes');
            const forasDeParte = partesPedidas.filter(p => !ehParte(p));
            if (forasDeParte.length > 0) {
                jsonResponse(res, 400, {
                    erro: `parte invalida: ${forasDeParte.join(', ')} (use ${PARTES.join(', ')})`
                });
                return;
            }
            const partes = partesPedidas as ParteFusao[];

            const formato = url.searchParams.get('formato') ?? 'resumo';
            if (formato !== 'resumo' && formato !== 'jsonl' && formato !== 'csv') {
                jsonResponse(res, 400, { erro: "formato deve ser 'resumo', 'jsonl' ou 'csv'" });
                return;
            }
            const ligado = (nome: string, padrao: boolean): boolean => {
                const v = url.searchParams.get(nome);
                if (v === null) return padrao;
                return v !== '0' && v !== 'false';
            };
            const opcoes: OpcoesFusao = {
                partes,
                incluirPlano: ligado('plano', true),
                incluirDesenho: ligado('desenho', true),
                incluirSemAvaliacao: ligado('semAvaliacao', false)
            };

            let fundido;
            try {
                fundido = fundirAvaliacoes(montarFontes(nomes, cenariosPedidos, cenarioPorAvaliacao), opcoes);
            } catch (error) {
                jsonResponse(res, 400, { erro: `falha ao fundir: ${(error as Error).message}` });
                return;
            }

            if (formato === 'resumo') {
                jsonResponse(res, 200, { opcoes, ...fundido.resumo });
                return;
            }

            const corpo = formato === 'csv' ? fusaoParaCsv(fundido) : fusaoParaJsonl(fundido);
            const nomeArquivo = nomeArquivoFusao(fundido.resumo.dominios, new Date(), formato, fundido.resumo.partes);
            res.writeHead(200, {
                'Content-Type':
                    formato === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
                'Content-Disposition': `attachment; filename="${nomeArquivo}"`,
                'Access-Control-Allow-Origin': ORIGEM_PERMITIDA,
                'Access-Control-Expose-Headers': 'Content-Disposition'
            });
            res.end(corpo);
            return;
        }

        if (req.method === 'GET' && req.url?.startsWith('/api/avaliacoes/')) {
            const nome = req.url.slice('/api/avaliacoes/'.length);
            const caminho = path.join(AVALIACOES_DIR, nome);
            if (!ARQUIVO_AVALIACAO_REGEX.test(nome) || !fs.existsSync(caminho)) {
                jsonResponse(res, 404, { erro: 'avaliacao nao encontrada' });
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'application/x-ndjson; charset=utf-8',
                'Content-Disposition': `attachment; filename="${nome}"`,
                'Access-Control-Allow-Origin': ORIGEM_PERMITIDA
            });
            res.end(fs.readFileSync(caminho));
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
    console.log(
        `  POST /api/comando   { dominio: 'med'|'agro'|'fut', texto: string, contexto?: {}, validacao?: { ativa, maxTentativas, juiz } }  (SSE: event "estagio"*, "final"|"erro")`
    );
    console.log(
        `                      validacao.ativa: gate — gera, avalia (sintaxe/semantica/oraculo [+ juiz LLM]) e regera ate aprovar (criterio ${GATE_CRITERIO}, teto ${GATE_MAX_TENTATIVAS}, juiz ${GATE_JUIZ ? 'on' : 'off'})`
    );
    console.log(`  GET  /api/chats`);
    console.log(`  POST /api/chats     { dominio: 'med'|'agro'|'fut', mensagens: [] }`);
    console.log(`  GET  /api/chats/:id`);
    console.log(`  PUT  /api/chats/:id { dominio: 'med'|'agro'|'fut', mensagens: [] }`);
    console.log(`  POST /api/avaliar   { dominio: 'med'|'agro'|'fut', arquiteturaJsonl?: string, baselineJsonl?: string, nomeEntrada?: string }  (SSE: event "progresso"*, "final"|"erro")`);
    console.log(`  GET  /api/avaliacoes           (lista as avaliacoes gravadas, com o cenario de entrada de cada uma)`);
    console.log(`  GET  /api/avaliacoes/:arquivo  (JSONL experimental de uma avaliacao: oraculo e juiz LLM separados)`);
    console.log(`  GET  /api/cenarios             (os cenarios-*.jsonl escolhiveis, por dominio)`);
    console.log(
        `  POST /api/juizes/testar { provedor, modelo?, apiKey? }  (um julgamento de brinquedo: diz se a chave e o modelo respondem, teto ${TIMEOUT_TESTE_JUIZ_MS / 1000}s)`
    );
    console.log(
        `  GET  /api/fusao?avaliacao=a&cenario=agro/cenarios-400-agro.jsonl&partes=cenario,resultado,avaliacao`
    );
    console.log(
        `                      &formato=resumo|jsonl|csv[&cenarioDe=a:agro/x.jsonl][&plano=0][&desenho=0][&semAvaliacao=1]`
    );
    console.log(`                      funde cenario + resultado + avaliacao de varios dominios num arquivo`);
});

process.on('SIGINT', async () => {
    await driver.close();
    process.exit(0);
});
