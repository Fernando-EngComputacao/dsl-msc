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

export async function enviarComando(dominio: string, texto: string): Promise<RespostaComando> {
    const resp = await fetch(`${BASE_URL}/api/comando`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dominio, texto })
    });
    const corpo = (await resp.json()) as RespostaComando;
    if (!resp.ok) {
        throw new Error(corpo.erro ?? `o servidor respondeu ${resp.status}`);
    }
    return corpo;
}
