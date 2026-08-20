import type { RespostaComando } from './api';

export interface ItemResultadoLote {
    linha: number;
    intencao: string;
    aceito: boolean;
    valido?: boolean;
    erroMotor?: string | null;
    regrasEmGHat?: number;
    erro?: string;
    telemetria?: Record<string, unknown>;
    promptSemantico?: string;
    foco?: RespostaComando['foco'];
    plano?: string;
}

export interface LoteEstado {
    nomeArquivo: string;
    total: number;
    concluidos: number;
    cancelado: boolean;
    finalizado: boolean;
    estagioAtual?: string;
    resultados: ItemResultadoLote[];
}

export interface Mensagem {
    id: number;
    autor: 'usuario' | 'assistente' | 'sistema' | 'lote';
    dominio: 'med' | 'agro';
    texto?: string;
    carregando?: boolean;
    estagio?: string;
    resposta?: RespostaComando;
    erro?: string;
    /** Só para autor 'sistema': nome do dominio pro qual a conversa mudou. */
    dominioNome?: string;
    /** Só para autor 'lote': progresso e resultados do upload em lote. */
    lote?: LoteEstado;
}
