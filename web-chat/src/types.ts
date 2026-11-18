import type { CriterioGate, DetalheLado, PIPlanejado, RespostaComando, ResumoGate } from './api';
import type { TemposCenario, TemposGateCenario } from './tempos-lote';

/** Os campos de tempo (ver tempos-lote.ts) vêm depois dos campos de resultado, em toda linha. */
export interface ItemResultadoLote extends Partial<TemposCenario>, Partial<TemposGateCenario> {
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
    /**
     * Só com o gate da geração ligado: a avaliação do plano que ficou, nas
     * mesmas camadas separadas da tela de avaliação (sintaxe, semântica,
     * oráculo, juiz). É o que torna o JSONL do lote já avaliado.
     */
    avaliacao?: DetalheLado;
    /** Só com o gate ligado: tentativas, vereditos descartados e o custo de cada parte. */
    geracaoValidada?: ResumoGate;
}

export interface LoteEstado {
    nomeArquivo: string;
    total: number;
    concluidos: number;
    /** O gate pedido quando este lote começou (ausente: lote sem validação). */
    validacao?: { maxTentativas: number; criterio: CriterioGate; juiz: boolean };
    cancelado: boolean;
    finalizado: boolean;
    estagioAtual?: string;
    resultados: ItemResultadoLote[];
    /** Timestamp (ms) de quando o lote começou a rodar — usado pra calcular duracaoSegundos. */
    iniciadoEm: number;
    /** Só preenchido quando finalizado: tempo total do lote, do início ao fim. */
    duracaoSegundos?: number;
    /** Só preenchido quando o laço termina: `performance.now()` do início do primeiro cenário ao fim do último. */
    tempoTotalBatchMs?: number;
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
