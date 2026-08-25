/**
 * Decodificacao sob contrato — a volta que fecha o ciclo da Figura 5.1.
 *
 * A decodificacao restrita garante que a saida pertence a L(Ĝ). Com a
 * especializacao por item (ver `knowledge/politica.ts`), Ĝ ja carrega quase toda
 * a semantica: item, decisao, meio e valor sao escolhidos juntos, nao em
 * vocabularios independentes. O que sobra fora do alcance de uma gramatica livre
 * de contexto sao as propriedades do artefato INTEIRO — unicidade por item,
 * concordancia entre a `sequencia` declarada e as clausulas emitidas,
 * escalonamento disparado que nao virou ordem.
 *
 * Este modulo verifica exatamente essas propriedades e, quando a saida as viola,
 * NAO se limita a reprovar: ele repoda o subgrafo tirando o par (item, decisao)
 * que falhou e gera de novo. A gramatica da tentativa seguinte e estritamente
 * menor que a da anterior, entao o mesmo erro deixa de ser exprimivel — a
 * verificacao semantica realimenta a poda, em vez de so julgar no fim.
 *
 * Tudo aqui e agnostico de dominio: o contrato e derivado dos papeis declarados
 * por cada `graphrag-*.ts`, e este arquivo nunca menciona farmaco, produto nem
 * infracao.
 */

import {
    podarPorViolacoes,
    relatorioDeViolacoes,
    verificarContrato,
    type ContratoArtefato,
    type Violacao
} from '../knowledge/contrato.js';
import type { SubgrafoPodado } from '../knowledge/politica.js';

const ENDPOINT_PADRAO = process.env.SPC_CML_ENDPOINT ?? 'http://127.0.0.1:8000';
const TIMEOUT_PADRAO = Number(process.env.SPC_CML_TIMEOUT_MS ?? 600_000);

/**
 * Quantas geracoes no maximo por cenario. Cada tentativa custa uma decodificacao
 * inteira; o valor 3 cobre o caso tipico (uma violacao, uma repoda, um acerto)
 * sem transformar um cenario patologico em lote travado.
 */
const MAX_TENTATIVAS = Number(process.env.SPC_CML_MAX_TENTATIVAS ?? 3);

/** Resposta crua de `POST /generate-constrained` (ver python_engine/main.py). */
export interface RespostaMotor {
    resultado: string;
    valido: boolean;
    erro: string | null;
    g_hat_utilizada: string | null;
    regras_em_g_hat: number;
}

export interface ResultadoDecodificacao extends RespostaMotor {
    /** Quantas geracoes foram necessarias (1 quando saiu certo de primeira). */
    tentativas: number;
    /** Violacoes que ainda restavam na ultima tentativa. */
    violacoes: Violacao[];
    /** O que cada tentativa violou — material de auditoria e de tese. */
    historico: { tentativa: number; violacoes: Violacao[] }[];
    conforme: boolean;
}

export async function chamarMotor(
    payload: { comando_humano: string; contexto_neo4j: string; subgrafo_regras: SubgrafoPodado },
    endpoint: string = ENDPOINT_PADRAO,
    timeoutMs: number = TIMEOUT_PADRAO
): Promise<RespostaMotor> {
    let response: Response;
    try {
        response = await fetch(`${endpoint}/generate-constrained`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
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
        throw new Error(`${endpoint} respondeu ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as RespostaMotor;
}

export interface OpcoesDecodificacao {
    comando: string;
    /** Prompt Semantico ja montado pelo dominio. */
    contexto: string;
    subgrafo: SubgrafoPodado;
    contrato: ContratoArtefato;
    endpoint?: string;
    timeoutMs?: number;
    maxTentativas?: number;
}

/**
 * Gera, verifica o contrato e — se preciso — repoda e gera de novo.
 *
 * Devolve sempre a ULTIMA saida, conforme ou nao, com as violacoes que restaram:
 * esconder uma saida nao conforme seria pior que devolve-la marcada, porque o
 * lote perderia o caso mais informativo que existe.
 */
export async function decodificarSobContrato(
    opts: OpcoesDecodificacao
): Promise<ResultadoDecodificacao> {
    const maxTentativas = opts.maxTentativas ?? MAX_TENTATIVAS;
    const historico: { tentativa: number; violacoes: Violacao[] }[] = [];

    let subgrafo = opts.subgrafo;
    let contrato = opts.contrato;
    let contexto = opts.contexto;
    let ultima: RespostaMotor | undefined;
    let violacoes: Violacao[] = [];

    for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
        ultima = await chamarMotor(
            {
                comando_humano: opts.comando,
                contexto_neo4j: contexto,
                subgrafo_regras: subgrafo
            },
            opts.endpoint,
            opts.timeoutMs
        );

        const veredito = verificarContrato(contrato, ultima.resultado);
        violacoes = veredito.violacoes;
        if (veredito.conforme) {
            return { ...ultima, tentativas: tentativa, violacoes: [], historico, conforme: true };
        }

        historico.push({ tentativa, violacoes });

        // Repoda: o par que falhou sai da politica, e com ele sai da gramatica.
        const menor = podarPorViolacoes(subgrafo, violacoes);
        const encolheu =
            menor.politicas.length < subgrafo.politicas.length ||
            menor.acoes_permitidas.length < subgrafo.acoes_permitidas.length;

        if (menor.politicas.length === 0 || !encolheu) {
            // Ou nao sobrou item algum, ou a violacao e do artefato (sequencia,
            // escalonamento) e nao ha o que retirar: insistir com a MESMA
            // gramatica so gastaria geracao. O relatorio vai no prompt e a
            // proxima tentativa e a ultima.
            if (!encolheu && tentativa < maxTentativas) {
                contexto = `${opts.contexto}\n\n${relatorioDeViolacoes(violacoes)}`;
                continue;
            }
            break;
        }

        subgrafo = menor;
        contrato = { ...contrato, politicas: new Map(menor.politicas.map(p => [p.item, p])) };
        contexto = `${opts.contexto}\n\n${relatorioDeViolacoes(violacoes)}`;
    }

    return {
        ...(ultima ?? {
            resultado: '',
            valido: false,
            erro: 'nenhuma tentativa concluida',
            g_hat_utilizada: null,
            regras_em_g_hat: 0
        }),
        tentativas: historico.length || 1,
        violacoes,
        historico,
        conforme: violacoes.length === 0
    };
}
