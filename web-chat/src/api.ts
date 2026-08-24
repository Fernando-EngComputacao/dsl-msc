import type { Mensagem } from './types';

export interface Dominio {
    id: 'med' | 'agro';
    nome: string;
    descricao: string;
}

export interface ChatResumo {
    id: string;
    titulo: string;
    dominio: 'med' | 'agro';
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
}

export interface DetalheLinha {
    linha: number;
    intencao: string;
    groundTruth: { plano: string; description: string };
    arquitetura?: DetalheLado;
    baseline?: DetalheLado;
    temDivergencia: boolean;
}

export interface RespostaAvaliacao {
    arquitetura?: MetricasAvaliacao;
    baseline?: MetricasAvaliacao;
    /** Registros enviados que não casaram com nenhum cenário do ground truth. */
    naoPareados: number;
    /** Registros cujo paciente/talhão existe no ground truth mas com telemetria
     *  diferente — mesmo código, outro quadro clínico. */
    telemetriaDivergente: number;
    linhas: DetalheLinha[];
}

export interface RespostaComando {
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

export async function avaliarResultados(
    dominio: 'med' | 'agro',
    arquiteturaJsonl?: string,
    baselineJsonl?: string
): Promise<RespostaAvaliacao> {
    const resp = await fetch(`${BASE_URL}/api/avaliar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dominio, arquiteturaJsonl, baselineJsonl })
    });
    if (!resp.ok) {
        const corpo = await resp.json().catch(() => ({}) as { erro?: string });
        throw new Error((corpo as { erro?: string }).erro ?? `o servidor respondeu ${resp.status}`);
    }
    return resp.json();
}

export async function criarChat(dominio: 'med' | 'agro', mensagens: Mensagem[]): Promise<ChatCompleto> {
    const resp = await fetch(`${BASE_URL}/api/chats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dominio, mensagens })
    });
    if (!resp.ok) throw new Error(`falha ao salvar chat: ${resp.status}`);
    return resp.json();
}

export async function atualizarChat(id: string, dominio: 'med' | 'agro', mensagens: Mensagem[]): Promise<ChatCompleto> {
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
