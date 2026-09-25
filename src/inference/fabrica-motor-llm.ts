/**
 * Escolhe o `MotorLLM` a partir da configuracao (LLM_BACKEND).
 *
 * `openai` e `gemini` ja sao reconhecidos e validados (chave e modelo), mas o
 * adaptador deles e da Etapa 2: pedir um deles hoje falha com mensagem clara, em
 * vez de cair em silencio no llama.cpp — um experimento que rodasse contra o
 * modelo errado sem avisar e pior do que um que nao roda.
 */

import { MotorLlamaCpp } from './motor-llamacpp.js';
import { ErroConfiguracaoLLM, lerConfiguracaoLLM, type ConfiguracaoLLM, type MotorLLM } from './motor-llm.js';

export interface OpcoesFabricaLLM {
    /** Endpoint do motor local. Cada dominio tem o seu (SPC_CML_ENDPOINT_AGRO...). */
    endpoint?: string;
    timeoutMs?: number;
}

export function criarMotorLLM(
    config: ConfiguracaoLLM = lerConfiguracaoLLM(),
    opcoes: OpcoesFabricaLLM = {}
): MotorLLM {
    switch (config.backend) {
        case 'llamacpp':
            return new MotorLlamaCpp({
                endpoint: opcoes.endpoint ?? config.llamacpp.endpoint,
                timeoutMs: opcoes.timeoutMs ?? config.llamacpp.timeoutMs,
                modelo: config.modelo
            });
        case 'openai':
        case 'gemini':
            throw new ErroConfiguracaoLLM(
                `LLM_BACKEND=${config.backend} esta configurado, mas o adaptador ainda nao existe ` +
                    '(Etapa 2). Use LLM_BACKEND=llamacpp.'
            );
    }
}
