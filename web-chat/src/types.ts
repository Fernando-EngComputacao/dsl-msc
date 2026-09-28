import type { PIPlanejado, RespostaComando } from './api';

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
    /**
     * Só no modo multiagente: o status e a sequência do Planner. A DSL do
     * artefato não escreve `dependeDe`; sem isto, o avaliador julga os PIs sem as
     * dependências (e sem as relações que cada PI Agent viu no prompt).
     */
    execucaoMultiagente?: { status: string; sequenciaValidada?: PIPlanejado[] };
}

export interface LoteEstado {
    nomeArquivo: string;
    total: number;
    concluidos: number;
    cancelado: boolean;
    finalizado: boolean;
    estagioAtual?: string;
    resultados: ItemResultadoLote[];
    /** Timestamp (ms) de quando o lote começou a rodar — usado pra calcular duracaoSegundos. */
    iniciadoEm: number;
    /** Só preenchido quando finalizado: tempo total do lote, do início ao fim. */
    duracaoSegundos?: number;
}

export interface Mensagem {
    id: number;
    autor: 'usuario' | 'assistente' | 'sistema' | 'lote';
    dominio: 'med' | 'agro' | 'fut';
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
