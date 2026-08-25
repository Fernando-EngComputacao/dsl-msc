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

export interface MetricasAvaliacao {
    total: number;
    semanticaCorreta: number;
    sintaxeCorreta: number;
    violacoes: number;
}

export interface DetalheLado {
    plano: string;
    sintaxeOk: boolean;
    semanticaOk: boolean;
    violacao: boolean;
    /** Explicação da LLM para o veredicto — por que o plano está certo ou errado. */
    justificativa: string;
    /** Prompt Semântico recuperado do grafo para este registro, para auditoria. */
    contextoGrafo?: string;
    /** true quando não foi possível consultar o grafo para este registro
     *  (telemetria ausente/incompleta, ou falha ao julgar) — os demais campos
     *  além de `sintaxeOk` não são confiáveis nesse caso. */
    naoAvaliado: boolean;
}

export interface DetalheLinha {
    linha: number;
    intencao: string;
    arquitetura?: DetalheLado;
    baseline?: DetalheLado;
    temDivergencia: boolean;
}

export interface RespostaAvaliacao {
    arquitetura?: MetricasAvaliacao;
    baseline?: MetricasAvaliacao;
    /** Registros que não puderam ser avaliados (telemetria ausente/incompleta
     *  ou falha ao consultar o grafo/julgar), somando os dois arquivos. */
    naoAvaliados: number;
    linhas: DetalheLinha[];
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
