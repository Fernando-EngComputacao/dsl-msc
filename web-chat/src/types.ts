import type { RespostaComando } from './api';

export interface Mensagem {
    id: number;
    autor: 'usuario' | 'assistente' | 'sistema';
    dominio: 'med' | 'agro';
    texto?: string;
    carregando?: boolean;
    estagio?: string;
    resposta?: RespostaComando;
    erro?: string;
    /** Só para autor 'sistema': nome do dominio pro qual a conversa mudou. */
    dominioNome?: string;
}
