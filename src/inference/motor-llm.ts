/**
 * Abstracao do LLM: o que o SPC-CML pede a um modelo de linguagem, separado de
 * QUEM responde (o motor local com llama.cpp hoje; OpenAI e Gemini depois).
 *
 * Duas operacoes, e a separacao entre elas e o ponto deste modulo:
 *
 *   gerarPlanoSemantico    o LLM PROPOE um plano em texto livre, a partir do que
 *                          a camada superior montou (pedido, Prompt Semantico,
 *                          politica efetiva, evidencias). Sem gramatica: aqui o
 *                          que se quer e o raciocinio do modelo, nao a forma.
 *   realizarComGramatica   um plano e REALIZADO na forma da DSL, sob a gramatica
 *                          Ĝ que o motor deriva da politica efetiva. Opcional:
 *                          so o backend que restringe a decodificacao a oferece.
 *
 * Nenhuma das duas e autoridade normativa. O LLM propoe; a politica efetiva, a
 * gramatica e o contrato decidem o que passa (ver `decodificacao.ts` e
 * `knowledge/contrato.ts`). Por isso o pedido carrega a politica so como
 * contexto ja montado, e nenhum backend a devolve alterada.
 *
 * A configuracao le as variaveis do ambiente e, quando existe, o arquivo `.env`
 * da raiz — o ambiente prevalece. Chave de API vira `Segredo`, que nao se
 * imprime em log, JSON nem mensagem de erro.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { inspect, parseEnv } from 'node:util';

import type { SubgrafoPodado } from '../knowledge/politica.js';

// =============================================================================
// Backends e capacidades
// =============================================================================

export const BACKENDS_LLM = ['llamacpp', 'openai', 'gemini'] as const;
export type BackendLLM = (typeof BACKENDS_LLM)[number];

export const BACKEND_PADRAO: BackendLLM = 'llamacpp';

/** O que um backend sabe fazer. O orquestrador consulta isto, nao o nome. */
export interface CapacidadesLLM {
    /** Decodificacao restrita por gramatica (GBNF): pode fazer `realizarComGramatica`. */
    gramatica: boolean;
    /** Saida em formato imposto (esquema JSON ou gramatica), ainda que sem GBNF. */
    saidaEstruturada: boolean;
    /** Resposta em fluxo, token a token. */
    streaming: boolean;
    /** Informa tokens de entrada e de saida. */
    contagemDeTokens: boolean;
}

/**
 * Capacidades por backend. As de `openai` e `gemini` sao as ESPERADAS dos
 * provedores e ainda nao foram exercitadas — os adaptadores sao da Etapa 2. Em
 * nenhum dos dois se presume GBNF: la, a realizacao na forma da DSL tera de sair
 * por saida estruturada mais verificacao, nao por mascaramento de logits.
 */
export const CAPACIDADES_LLM: Record<BackendLLM, CapacidadesLLM> = {
    llamacpp: { gramatica: true, saidaEstruturada: true, streaming: false, contagemDeTokens: true },
    openai: { gramatica: false, saidaEstruturada: true, streaming: true, contagemDeTokens: true },
    gemini: { gramatica: false, saidaEstruturada: true, streaming: true, contagemDeTokens: true }
};

// =============================================================================
// Pedidos e resultados
// =============================================================================

/**
 * Geracao SEMANTICA. O backend so precisa de `sistema` e `usuario`: a camada
 * superior ja escreveu neles a politica efetiva e as evidencias. Os campos
 * estruturados viajam para auditoria e para um backend que os queira usar como
 * dado, nunca para serem reinterpretados como permissao.
 */
export interface PedidoGeracaoSemantica {
    /** Papel do modelo e o que ele nao pode fazer. */
    sistema: string;
    /** Pedido do usuario + contexto (Prompt Semantico, politica, evidencias). */
    usuario: string;
    politicaEfetiva?: SubgrafoPodado;
    evidencias?: string[];
    /** Modelo pedido. No llama.cpp e informativo: o motor usa o que carregou. */
    modelo?: string;
    temperatura?: number;
    maxTokens?: number;
    metadados?: Record<string, string | number | boolean>;
}

/**
 * Realizacao GRAMATICAL: o motor deriva Ĝ de `subgrafo` e gera sob ela. Sem
 * `fragmento`, gera o artefato inteiro; com ele, um elemento (decodificacao
 * incremental), tendo `prefixo` como o artefato ja aceito.
 */
export interface PedidoRealizacaoGramatical {
    comando: string;
    /** Prompt Semantico do cenario. */
    contexto: string;
    /** A politica efetiva: e dela que sai a gramatica. */
    subgrafo: SubgrafoPodado;
    fragmento?: { simbolo: string; prefixo: string; encerramento?: string };
}

export interface ResultadoLLM {
    texto: string;
    modelo: string;
    backend: BackendLLM;
    latenciaMs?: number;
    tokensEntrada?: number;
    tokensSaida?: number;
    motivoParada?: string;
}

/** O que a realizacao acrescenta: o veredito do proprio motor sobre Ĝ. */
export interface ResultadoRealizacao extends ResultadoLLM {
    /** O texto pertence a L(Ĝ)? So vem na realizacao do artefato inteiro. */
    valido?: boolean;
    erro?: string | null;
    gHat?: string | null;
    regrasEmGHat?: number;
    /** `false`: o motor recebeu politica por item e nao especializou (codigo antigo). */
    especializada?: boolean;
    /** O modelo emitiu o literal de encerramento em vez de um fragmento. */
    encerrou?: boolean;
}

export interface MotorLLM {
    readonly backend: BackendLLM;
    readonly capacidades: CapacidadesLLM;
    gerarPlanoSemantico(pedido: PedidoGeracaoSemantica): Promise<ResultadoLLM>;
    realizarComGramatica?(pedido: PedidoRealizacaoGramatical): Promise<ResultadoRealizacao>;
}

// =============================================================================
// Erros
// =============================================================================

/** Configuracao invalida ou backend ainda nao disponivel. */
export class ErroConfiguracaoLLM extends Error {
    override name = 'ErroConfiguracaoLLM';
}

/** O backend nao tem a capacidade que a operacao exige. */
export class ErroCapacidadeLLM extends Error {
    override name = 'ErroCapacidadeLLM';
}

/**
 * A realizacao gramatical so e confiavel num backend que restringe a
 * decodificacao. Sem isso, "realizar sob Ĝ" seria pedir a forma e torcer — e o
 * resultado nao carregaria a garantia que o resto da arquitetura supoe.
 */
export function exigirRealizacaoGramatical(
    motor: MotorLLM
): asserts motor is MotorLLM & Required<Pick<MotorLLM, 'realizarComGramatica'>> {
    if (!motor.capacidades.gramatica || typeof motor.realizarComGramatica !== 'function') {
        throw new ErroCapacidadeLLM(
            `o backend ${motor.backend} nao realiza sob gramatica: a realizacao na forma da DSL ` +
                'exige um backend com a capacidade `gramatica` (hoje, llamacpp)'
        );
    }
}

// =============================================================================
// Segredos
// =============================================================================

const OCULTO = '[segredo]';

/**
 * Valor que nunca aparece impresso: `String`, `JSON.stringify`, `console.log` e
 * `util.inspect` mostram so `[segredo]`. O valor so sai por `revelar()`, que e o
 * que um adaptador chama na hora de autenticar.
 */
export class Segredo {
    readonly #valor: string;
    constructor(valor: string) {
        this.#valor = valor;
    }
    revelar(): string {
        return this.#valor;
    }
    toString(): string {
        return OCULTO;
    }
    toJSON(): string {
        return OCULTO;
    }
    [inspect.custom](): string {
        return `Segredo(${OCULTO})`;
    }
}

// =============================================================================
// Configuracao
// =============================================================================

export interface ConfiguracaoLLM {
    backend: BackendLLM;
    /** LLM_MODEL. No llama.cpp e informativo; o motor informa o que carregou. */
    modelo?: string;
    /** O motor local. Mesmas variaveis que o resto do projeto ja usa. */
    llamacpp: { endpoint: string; timeoutMs: number };
    openai: { chave?: Segredo; modelo?: string };
    gemini: { chave?: Segredo; modelo?: string };
    /** SPC_CML_SEMANTIC_REPAIR: realimentar o LLM com as falhas do validador semantico. */
    reparoSemantico: boolean;
    /** SPC_CML_MAX_RETRIES: tentativas de reparo semantico. */
    maxTentativasSemanticas: number;
}

type Ambiente = Record<string, string | undefined>;

export interface OpcoesConfiguracaoLLM {
    /** Padrao: `process.env`. */
    env?: Ambiente;
    /** Padrao: `.env` na pasta corrente. `null` desliga a leitura do arquivo. */
    arquivoEnv?: string | null;
}

/** `.env` e ambiente juntos; o ambiente prevalece, como no `--env-file` do Node. */
function ambienteEfetivo(opcoes: OpcoesConfiguracaoLLM): Ambiente {
    const env = opcoes.env ?? process.env;
    const arquivo = opcoes.arquivoEnv === undefined ? path.resolve('.env') : opcoes.arquivoEnv;
    if (!arquivo || !fs.existsSync(arquivo)) return env;
    const doArquivo = parseEnv(fs.readFileSync(arquivo, 'utf-8')) as Ambiente;
    const efetivo: Ambiente = { ...doArquivo };
    for (const [chave, valor] of Object.entries(env)) if (valor !== undefined) efetivo[chave] = valor;
    return efetivo;
}

const vazio = (v: string | undefined): boolean => v === undefined || v.trim() === '';

/** O nome digitado so volta na mensagem se parecer nome de backend, nunca uma chave. */
function ecoSeguro(valor: string): string {
    return /^[A-Za-z0-9_.-]{1,24}$/.test(valor) ? `"${valor}"` : '(valor omitido)';
}

function lerBooleano(env: Ambiente, nome: string, padrao: boolean): boolean {
    const bruto = env[nome];
    if (vazio(bruto)) return padrao;
    const v = bruto!.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
    throw new ErroConfiguracaoLLM(`${nome} deve ser true ou false, veio ${ecoSeguro(bruto!.trim())}`);
}

function lerInteiro(env: Ambiente, nome: string, padrao: number, minimo: number): number {
    const bruto = env[nome];
    if (vazio(bruto)) return padrao;
    const n = Number(bruto!.trim());
    if (!Number.isInteger(n) || n < minimo) {
        throw new ErroConfiguracaoLLM(`${nome} deve ser um inteiro >= ${minimo}, veio ${ecoSeguro(bruto!.trim())}`);
    }
    return n;
}

/**
 * Le e VALIDA a configuracao do LLM. Falha cedo, com mensagem que diz o que
 * corrigir: um backend digitado errado nao pode cair em silencio no padrao,
 * porque ai o experimento rodaria contra um modelo que ninguem escolheu.
 */
export function lerConfiguracaoLLM(opcoes: OpcoesConfiguracaoLLM = {}): ConfiguracaoLLM {
    const env = ambienteEfetivo(opcoes);

    const brutoBackend = (env.LLM_BACKEND ?? '').trim();
    const backend = (vazio(brutoBackend) ? BACKEND_PADRAO : brutoBackend.toLowerCase()) as BackendLLM;
    if (!BACKENDS_LLM.includes(backend)) {
        throw new ErroConfiguracaoLLM(
            `LLM_BACKEND ${ecoSeguro(brutoBackend)} invalido: use ${BACKENDS_LLM.join(', ')}`
        );
    }

    const modelo = vazio(env.LLM_MODEL) ? undefined : env.LLM_MODEL!.trim();
    const chave = (nome: string): Segredo | undefined =>
        vazio(env[nome]) ? undefined : new Segredo(env[nome]!.trim());

    const config: ConfiguracaoLLM = {
        backend,
        modelo,
        llamacpp: {
            endpoint: vazio(env.SPC_CML_ENDPOINT) ? 'http://127.0.0.1:8000' : env.SPC_CML_ENDPOINT!.trim(),
            timeoutMs: lerInteiro(env, 'SPC_CML_TIMEOUT_MS', 600_000, 1)
        },
        openai: {
            chave: chave('OPENAI_API_KEY'),
            modelo: vazio(env.OPENAI_MODEL) ? modelo : env.OPENAI_MODEL!.trim()
        },
        gemini: {
            chave: chave('GEMINI_API_KEY'),
            modelo: vazio(env.GEMINI_MODEL) ? modelo : env.GEMINI_MODEL!.trim()
        },
        reparoSemantico: lerBooleano(env, 'SPC_CML_SEMANTIC_REPAIR', true),
        maxTentativasSemanticas: lerInteiro(env, 'SPC_CML_MAX_RETRIES', 3, 0)
    };

    // O backend escolhido precisa estar completo; os outros podem ficar vazios.
    if (backend === 'openai' || backend === 'gemini') {
        const prefixo = backend.toUpperCase();
        if (!config[backend].chave) {
            throw new ErroConfiguracaoLLM(`LLM_BACKEND=${backend} exige ${prefixo}_API_KEY`);
        }
        if (!config[backend].modelo) {
            throw new ErroConfiguracaoLLM(`LLM_BACKEND=${backend} exige ${prefixo}_MODEL (ou LLM_MODEL)`);
        }
    }
    return config;
}

/** Linha de log da configuracao. Chaves aparecem so como definida/ausente. */
export function descreverConfiguracaoLLM(c: ConfiguracaoLLM): string {
    const estado = (s?: Segredo): string => (s ? 'definida' : 'ausente');
    const alvo =
        c.backend === 'llamacpp'
            ? `endpoint=${c.llamacpp.endpoint} modelo=${c.modelo ?? '(o que o motor carregou)'}`
            : `modelo=${c[c.backend].modelo}`;
    return (
        `LLM backend=${c.backend} ${alvo} ` +
        `reparoSemantico=${c.reparoSemantico} maxTentativas=${c.maxTentativasSemanticas} ` +
        `OPENAI_API_KEY=${estado(c.openai.chave)} GEMINI_API_KEY=${estado(c.gemini.chave)}`
    );
}
