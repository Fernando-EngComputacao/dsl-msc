export interface Dominio {
    id: 'med' | 'agro';
    nome: string;
    descricao: string;
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

/**
 * Envia o comando e acompanha o fluxo em tempo real via SSE: o servidor emite
 * um evento "estagio" a cada etapa (validacao -> sorteio -> grafo -> embedding
 * -> grammar prompting) antes do evento final "final"/"erro".
 */
export async function enviarComandoStream(
    dominio: string,
    texto: string,
    aoEstagio: (texto: string) => void
): Promise<RespostaComando> {
    const resp = await fetch(`${BASE_URL}/api/comando`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dominio, texto })
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
