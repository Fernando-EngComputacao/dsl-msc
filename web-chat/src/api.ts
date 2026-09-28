import type { Mensagem } from './types';

export interface Dominio {
    id: 'med' | 'agro' | 'fut';
    nome: string;
    descricao: string;
}

export interface ChatResumo {
    id: string;
    titulo: string;
    dominio: 'med' | 'agro' | 'fut';
    criadoEm: string;
    atualizadoEm: string;
}

export interface ChatCompleto extends ChatResumo {
    mensagens: Mensagem[];
}

/** Espelho de src/inference/avaliar-grafo.ts e avaliar-sintaxe.ts — o contrato de POST /api/avaliar. */
export type Veredito = 'VALID' | 'INVALID' | 'UNRESOLVED';

/** Veredito de uma camada que pode não ter rodado. */
export type VereditoSemantico = Veredito | 'NOT_EVALUATED';

/** O que o juiz disse — ou por que não disse. */
export type StatusJuiz = Veredito | 'NOT_CALLED' | 'NO_RESPONSE';

export type ClassificacaoAvaliacao = 'VALIDO_PELO_ORACULO' | 'INVALIDO_PELO_ORACULO' | 'UNRESOLVIDO_PELO_ORACULO' | 'DISCORDANCIA_LLM';

export interface ContagemVereditos {
    VALID: number;
    INVALID: number;
    UNRESOLVED: number;
}

export interface MetricasAvaliacao {
    /** Só linhas efetivamente avaliadas. */
    total: number;
    sintaxe: { VALID: number; INVALID: number };
    semantica: ContagemVereditos & { NOT_EVALUATED: number };
    oraculo: ContagemVereditos;
    juiz: ContagemVereditos & { NOT_CALLED: number; NO_RESPONSE: number };
    concordantes: number;
    discordantes: number;
    /** `<oraculo>+<juiz>` -> quantas linhas. */
    pares: Record<string, number>;
    violacoes: number;
}

/** Erro da validação sintática: de G (`/verify` sem política), do parser Langium ou da ligação de referências. */
export interface ErroSintatico {
    codigo: string;
    mensagem: string;
    fonte: 'gramatica' | 'parser' | 'ligacao' | 'artefato';
    linha?: number;
    coluna?: number;
    regra?: string;
    campo?: string;
    encontrado?: string;
    esperado?: string[];
}

/** 1. Sintaxe: G + parser da DSL -> AST oficial. */
export interface ValidacaoSintatica {
    veredito: 'VALID' | 'INVALID';
    erros: ErroSintatico[];
    /** O que cada peça disse. Ausente quando nenhuma foi chamada (artefato vazio). */
    pecas?: { gramatica: 'ACEITO' | 'RECUSADO'; parser: 'ACEITO' | 'RECUSADO' };
}

/** O AST oficial (Langium), serializado — o mesmo objeto que a semântica leu. */
export type AstArtefato = { $type: string; name?: string } & Record<string, unknown>;

export interface ProblemaValidacao {
    codigo: string;
    mensagem: string;
    pi?: number;
    pis?: number[];
    item?: string;
    conduta?: string;
    regra?: string;
    evidencias?: string[];
    alternativas?: string[];
}

export interface ProblemaSemantico extends ProblemaValidacao {
    etapa: string;
}

export interface EtapaSemantica {
    etapa: 'gramatica_da_politica' | 'sequencia' | 'pis' | 'global';
    validador: string;
    veredito: VereditoSemantico;
    erros: ProblemaValidacao[];
    avisos: ProblemaValidacao[];
    dadosFaltantes: string[];
    motivo?: string;
}

/** 2. Semântica determinística, sobre o AST: os validadores da geração. */
export interface ValidacaoSemantica {
    veredito: VereditoSemantico;
    erros: ProblemaSemantico[];
    avisos: ProblemaSemantico[];
    dadosFaltantes: string[];
    etapas: EtapaSemantica[];
    /** Conhecimento que é só texto: vai como evidência, nenhuma etapa o confere. */
    naoFormalizado: string[];
    motivo?: string;
}

/** 3. Oráculo: sintaxe + semântica, com a camada que decidiu. */
export interface Oraculo {
    veredito: Veredito;
    origem: 'sintaxe' | 'semantica';
}

/** 4. Juiz LLM — avaliação experimental, comparada com o oráculo, nunca no lugar dele. */
export interface JulgamentoLLM {
    status: StatusJuiz;
    justificativa?: string;
    evidencias?: string[];
    respostaBruta?: string;
    /** Em NOT_CALLED, por que não foi chamado; em NO_RESPONSE, a falha. */
    motivo?: string;
}

export interface DetalheLado {
    plano: string;
    sujeito?: string;
    /** Incremento em item bloqueado/vetado, lido do AST. Ausente sem AST. */
    violacao?: boolean;
    /** Prompt Semântico reconstruído para este registro — o que o juiz leu. */
    contextoGrafo?: string;
    /** Falha técnica (grafo, motor): nenhuma camada tem veredito. */
    naoAvaliado: boolean;
    motivo?: string;
    validacaoSintatica?: ValidacaoSintatica;
    /** Só com sintaxe VALID. */
    ast?: AstArtefato;
    validacaoSemantica?: ValidacaoSemantica;
    oraculo?: Oraculo;
    julgamentoLLM?: JulgamentoLLM;
    concordancia?: boolean;
    classificacao?: ClassificacaoAvaliacao;
}

export interface DetalheLinha {
    linha: number;
    intencao: string;
    arquitetura?: DetalheLado;
    baseline?: DetalheLado;
    /** Algum lado avaliado não saiu VALID pelo oráculo, ou teve violação. */
    temDivergencia: boolean;
    /** Em algum lado, o juiz discordou do oráculo. */
    temDiscordancia: boolean;
}

export interface RespostaAvaliacao {
    arquitetura?: MetricasAvaliacao;
    baseline?: MetricasAvaliacao;
    /** Registros que não puderam ser avaliados, somando os dois arquivos. */
    naoAvaliados: number;
    linhas: DetalheLinha[];
    /** Nome do JSONL experimental gravado pelo servidor — ver `urlAvaliacaoJsonl`. */
    arquivoJsonl?: string;
}

export interface RespostaComando {
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
    erro?: string;
    /** Só no modo multiagente (`SPC_CML_DECODIFICACAO=multiagente`): a execução resumida. */
    execucaoMultiagente?: { status: string; sequenciaValidada?: PIPlanejado[] };
}

/** Um PI da sequência do Planner — o que o avaliador lê (`dependeDe` não está na DSL do artefato). */
export interface PIPlanejado {
    ordem: number;
    item: string;
    conduta: string;
    dependeDe: number[];
    motivo?: string;
}

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export async function buscarDominios(): Promise<Dominio[]> {
    const resp = await fetch(`${BASE_URL}/api/dominios`);
    if (!resp.ok) throw new Error(`falha ao listar dominios: ${resp.status}`);
    return resp.json();
}

export async function listarChats(): Promise<ChatResumo[]> {
    const resp = await fetch(`${BASE_URL}/api/chats`);
    if (!resp.ok) throw new Error(`falha ao listar chats: ${resp.status}`);
    return resp.json();
}

export async function buscarChat(id: string): Promise<ChatCompleto> {
    const resp = await fetch(`${BASE_URL}/api/chats/${id}`);
    if (!resp.ok) throw new Error(`falha ao carregar chat: ${resp.status}`);
    return resp.json();
}

/**
 * Envia o(s) arquivo(s) para avaliação e acompanha o progresso via SSE: cada
 * julgamento é uma geração no modelo local, então um arquivo grande pode levar
 * minutos — o servidor emite um evento "progresso" a cada linha julgada, antes
 * do evento final "final"/"erro".
 */
export async function avaliarResultados(
    dominio: 'med' | 'agro' | 'fut',
    arquiteturaJsonl: string | undefined,
    baselineJsonl: string | undefined,
    aoProgresso: (processados: number, total: number) => void,
    signal?: AbortSignal
): Promise<RespostaAvaliacao> {
    const resp = await fetch(`${BASE_URL}/api/avaliar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dominio, arquiteturaJsonl, baselineJsonl }),
        signal
    });

    if (!resp.ok || !resp.body) {
        const corpo = await resp.json().catch(() => ({}) as { erro?: string });
        throw new Error((corpo as { erro?: string }).erro ?? `o servidor respondeu ${resp.status}`);
    }

    const leitor = resp.body.getReader();
    const decodificador = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await leitor.read();
        if (done) break;
        buffer += decodificador.decode(value, { stream: true });

        let fimBloco: number;
        while ((fimBloco = buffer.indexOf('\n\n')) !== -1) {
            const bloco = buffer.slice(0, fimBloco);
            buffer = buffer.slice(fimBloco + 2);

            let evento = 'message';
            let dadosTexto = '';
            for (const linha of bloco.split('\n')) {
                if (linha.startsWith('event: ')) evento = linha.slice(7);
                else if (linha.startsWith('data: ')) dadosTexto += linha.slice(6);
            }
            if (!dadosTexto) continue;
            const dados = JSON.parse(dadosTexto);

            if (evento === 'progresso') aoProgresso(dados.processados, dados.total);
            else if (evento === 'final') return dados as RespostaAvaliacao;
            else if (evento === 'erro') throw new Error(dados.erro ?? 'falha desconhecida no servidor');
        }
    }

    throw new Error('conexão encerrada antes do resultado final');
}

/** Download do JSONL experimental de uma avaliação (oráculo e juiz LLM separados, um plano por linha). */
export function urlAvaliacaoJsonl(arquivo: string): string {
    return `${BASE_URL}/api/avaliacoes/${encodeURIComponent(arquivo)}`;
}

export async function criarChat(dominio: 'med' | 'agro' | 'fut', mensagens: Mensagem[]): Promise<ChatCompleto> {
    const resp = await fetch(`${BASE_URL}/api/chats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dominio, mensagens })
    });
    if (!resp.ok) throw new Error(`falha ao salvar chat: ${resp.status}`);
    return resp.json();
}

export async function atualizarChat(id: string, dominio: 'med' | 'agro' | 'fut', mensagens: Mensagem[]): Promise<ChatCompleto> {
    const resp = await fetch(`${BASE_URL}/api/chats/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dominio, mensagens })
    });
    if (!resp.ok) throw new Error(`falha ao salvar chat: ${resp.status}`);
    return resp.json();
}

/**
 * Envia o comando e acompanha o fluxo em tempo real via SSE: o servidor emite
 * um evento "estagio" a cada etapa (validacao -> sorteio -> grafo -> embedding
 * -> grammar prompting) antes do evento final "final"/"erro".
 */
export async function enviarComandoStream(
    dominio: string,
    texto: string,
    aoEstagio: (texto: string) => void,
    signal?: AbortSignal,
    contexto?: Record<string, unknown>
): Promise<RespostaComando> {
    const resp = await fetch(`${BASE_URL}/api/comando`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(contexto ? { dominio, texto, contexto } : { dominio, texto }),
        signal
    });

    if (!resp.ok || !resp.body) {
        const corpo = await resp.json().catch(() => ({}) as RespostaComando);
        throw new Error((corpo as RespostaComando).erro ?? `o servidor respondeu ${resp.status}`);
    }

    const leitor = resp.body.getReader();
    const decodificador = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await leitor.read();
        if (done) break;
        buffer += decodificador.decode(value, { stream: true });

        let fimBloco: number;
        while ((fimBloco = buffer.indexOf('\n\n')) !== -1) {
            const bloco = buffer.slice(0, fimBloco);
            buffer = buffer.slice(fimBloco + 2);

            let evento = 'message';
            let dadosTexto = '';
            for (const linha of bloco.split('\n')) {
                if (linha.startsWith('event: ')) evento = linha.slice(7);
                else if (linha.startsWith('data: ')) dadosTexto += linha.slice(6);
            }
            if (!dadosTexto) continue;
            const dados = JSON.parse(dadosTexto);

            if (evento === 'estagio') aoEstagio(dados.texto);
            else if (evento === 'final') return dados as RespostaComando;
            else if (evento === 'erro') throw new Error(dados.erro ?? 'falha desconhecida no servidor');
        }
    }

    throw new Error('conexão encerrada antes do resultado final');
}
