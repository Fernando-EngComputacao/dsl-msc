import type { RespostaComando } from './api';

export interface Mensagem {
    id: number;
    autor: 'usuario' | 'assistente';
    dominio: 'med' | 'agro';
    texto?: string;
    carregando?: boolean;
    estagio?: string;
    resposta?: RespostaComando;
    erro?: string;
}
