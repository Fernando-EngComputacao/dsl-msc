/**
 * `MotorLLM` sobre o motor local (src/python_engine/main.py), que roda o
 * llama.cpp.
 *
 *   gerarPlanoSemantico   POST /generate-semantic   texto livre, SEM gramatica
 *   realizarComGramatica  POST /generate-constrained  artefato inteiro sob Ĝ
 *                         POST /generate-fragment     um elemento sob Ĝ
 *
 * As duas rotas de realizacao sao as de sempre, com o mesmo corpo e as mesmas
 * mensagens de erro: `chamarMotor` e `motorHttp` (decodificacao.ts) passaram a
 * delegar para ca sem mudar o que vai e o que volta pelo fio. A gramatica
 * continua sendo derivada NO MOTOR a partir do subgrafo (grammar_from_kg.py);
 * nada aqui a monta.
 */

import type { SubgrafoPodado } from '../knowledge/politica.js';
import type { RespostaFragmento, RespostaMotor } from './decodificacao.js';
import {
    CAPACIDADES_LLM,
    type MotorLLM,
    type PedidoGeracaoSemantica,
    type PedidoRealizacaoGramatical,
    type ResultadoLLM,
    type ResultadoRealizacao
} from './motor-llm.js';

export interface OpcoesMotorLlamaCpp {
    endpoint: string;
    timeoutMs: number;
    /** LLM_MODEL, so para o registro quando o motor nao informa o proprio. */
    modelo?: string;
}

/** O que `/generate-semantic` devolve. */
interface RespostaSemantica {
    texto: string;
    modelo?: string;
    tokens_entrada?: number | null;
    tokens_saida?: number | null;
    motivo_parada?: string | null;
}

export class MotorLlamaCpp implements MotorLLM {
    readonly backend = 'llamacpp' as const;
    readonly capacidades = CAPACIDADES_LLM.llamacpp;

    constructor(private readonly opcoes: OpcoesMotorLlamaCpp) {}

    get endpoint(): string {
        return this.opcoes.endpoint;
    }

    async gerarPlanoSemantico(pedido: PedidoGeracaoSemantica): Promise<ResultadoLLM> {
        const inicio = Date.now();
        const dados = await this.postar<RespostaSemantica>(
            '/generate-semantic',
            {
                sistema: pedido.sistema,
                usuario: pedido.usuario,
                max_tokens: pedido.maxTokens ?? null,
                temperatura: pedido.temperatura ?? null
            },
            status =>
                status === 404
                    ? `${this.endpoint} nao tem /generate-semantic: o motor esta desatualizado. ` +
                      'Reinicie o servico (uvicorn) para carregar main.py atual.'
                    : undefined
        );
        return {
            texto: dados.texto,
            modelo: this.modeloDe(dados.modelo),
            backend: this.backend,
            latenciaMs: Date.now() - inicio,
            tokensEntrada: dados.tokens_entrada ?? undefined,
            tokensSaida: dados.tokens_saida ?? undefined,
            motivoParada: dados.motivo_parada ?? undefined
        };
    }

    async realizarComGramatica(pedido: PedidoRealizacaoGramatical): Promise<ResultadoRealizacao> {
        const inicio = Date.now();

        if (pedido.fragmento) {
            const dados = await this.postar<RespostaFragmento & { modelo?: string }>('/generate-fragment', {
                simbolo: pedido.fragmento.simbolo,
                prefixo: pedido.fragmento.prefixo,
                comando_humano: pedido.comando,
                contexto_neo4j: pedido.contexto,
                subgrafo_regras: pedido.subgrafo,
                encerramento: pedido.fragmento.encerramento ?? null
            });
            this.exigirEspecializacao(pedido.subgrafo, dados.especializada);
            return {
                texto: dados.fragmento,
                modelo: this.modeloDe(dados.modelo),
                backend: this.backend,
                latenciaMs: Date.now() - inicio,
                encerrou: dados.encerrou,
                especializada: dados.especializada,
                regrasEmGHat: dados.regras_em_g_hat
            };
        }

        const dados = await this.postar<RespostaMotor & { modelo?: string }>('/generate-constrained', {
            comando_humano: pedido.comando,
            contexto_neo4j: pedido.contexto,
            subgrafo_regras: pedido.subgrafo
        });
        this.exigirEspecializacao(pedido.subgrafo, dados.especializada);
        return {
            texto: dados.resultado,
            modelo: this.modeloDe(dados.modelo),
            backend: this.backend,
            latenciaMs: Date.now() - inicio,
            valido: dados.valido,
            erro: dados.erro,
            gHat: dados.g_hat_utilizada,
            regrasEmGHat: dados.regras_em_g_hat,
            especializada: dados.especializada
        };
    }

    private modeloDe(informado?: string): string {
        return informado ?? this.opcoes.modelo ?? 'llamacpp (modelo do motor local)';
    }

    /**
     * Um motor no ar com codigo antigo poda so pelos tres vocabularios e devolve
     * um artefato de aparencia normal — a correcao ja aplicada parece nao ter
     * efeito. Melhor falhar alto do que gerar sob a gramatica errada.
     */
    private exigirEspecializacao(subgrafo: SubgrafoPodado, especializada?: boolean): void {
        if ((subgrafo.politicas?.length ?? 0) > 0 && especializada === false) {
            throw new Error(
                `${this.endpoint} ignorou a politica por item: o motor esta desatualizado. ` +
                    'Reinicie o servico (uvicorn) para carregar grammar_from_kg.py atual.'
            );
        }
    }

    private async postar<T>(
        rota: string,
        corpo: unknown,
        mensagemPorStatus?: (status: number) => string | undefined
    ): Promise<T> {
        const { endpoint, timeoutMs } = this.opcoes;
        let response: Response;
        try {
            response = await fetch(`${endpoint}${rota}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(corpo),
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (error) {
            const causa =
                (error as Error).name === 'TimeoutError'
                    ? `sem resposta em ${timeoutMs / 1000}s (ajuste SPC_CML_TIMEOUT_MS)`
                    : (error as Error).message;
            throw new Error(`${endpoint} inacessivel: ${causa}`);
        }
        if (!response.ok) {
            const especifica = mensagemPorStatus?.(response.status);
            if (especifica) throw new Error(especifica);
            throw new Error(`${endpoint} respondeu ${response.status}: ${await response.text()}`);
        }
        return (await response.json()) as T;
    }
}
