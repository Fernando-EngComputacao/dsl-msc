/**
 * Gate da GERAÇÃO: gera o plano, avalia com a MESMA cascata da tela de
 * avaliação (sintaxe → semântica → oráculo, e o LLM Judge, em `avaliarPlano`,
 * avaliar-grafo.ts) e, quando a avaliação reprova, gera outra vez — até aprovar
 * ou esgotar as tentativas.
 *
 * Por que aqui, e não dentro da geração: o pipeline multiagente já tem os
 * retries DELE (Planner, PIs, ciclo global), contra os validadores que ele
 * mesmo chama. O gate é um laço EXTERNO, fechado pela avaliação completa — o
 * parser oficial da DSL (AST), os validadores semânticos sobre esse AST e, se
 * pedido, o juiz LLM. É de propósito que ele não compartilhe nada com a
 * geração: o que aprova o plano aqui é o mesmo juízo que o aprovaria depois, em
 * outra tela, a partir do arquivo.
 *
 * QUEM REPROVA é escolha de quem chama (`criterio`):
 *
 *   oraculo  o veredito normativo (sintaxe + semântica). O juiz pode rodar e
 *            entra no registro, mas não manda o plano de volta.
 *   juiz     o LLM Judge decide. Atenção: isto deixa passar plano que o oráculo
 *            reprovou (e o registro mostra isso, nunca o esconde).
 *   ambos    o plano só fica se o oráculo E o juiz derem VALID — o mais estrito.
 *
 * Repetir só faz sentido porque a geração é amostrada (temperatura > 0 no
 * motor): a mesma entrada dá planos diferentes. Com temperatura 0 o laço
 * apenas repetiria o mesmo plano até o teto.
 *
 * EFEITO DE SELEÇÃO, quando o juiz participa do critério: nas linhas que
 * ficaram, ele não é mais um observador independente — elas foram escolhidas
 * por agradá-lo. A concordância medida sobre esse arquivo não é mais uma
 * comparação limpa entre oráculo e juiz. As tentativas descartadas ficam
 * registradas justamente para que a medida da PRIMEIRA geração continue
 * disponível.
 *
 * Nada aqui conhece HTTP, domínio nem grafo: `gerar` e `avaliar` entram por
 * injeção (o servidor liga em `processarMed/Agro/Fut` e em `avaliarRegistro`),
 * o que torna o laço testável sem motor nem Neo4j.
 */

import type { Veredito } from '../knowledge/validacao.js';
import type { DetalheLado, Oraculo, StatusJuiz } from './avaliar-grafo.js';

/** Quem reprova o plano e manda gerar de novo. */
export type CriterioGate = 'oraculo' | 'juiz' | 'ambos';

/**
 * O veredito que fechou (ou não) o gate.
 * `NAO_AVALIADO`: falha técnica — nenhuma camada deu veredito.
 * `NOT_CALLED`/`NO_RESPONSE`: o juiz era critério e não respondeu (ou não foi chamado).
 */
export type VereditoGate = Veredito | 'NAO_AVALIADO' | 'NOT_CALLED' | 'NO_RESPONSE';

export interface OpcoesGate {
    /** Teto de gerações do MESMO cenário, contando a primeira. Menor que 1 vira 1. */
    maxTentativas: number;
    /** Quem reprova (ver o cabeçalho). Padrão: `ambos`. */
    criterio?: CriterioGate;
    /**
     * Gerar de novo também quando a reprovação foi falha técnica
     * (`naoAvaliado`: grafo fora, motor fora, telemetria insuficiente; ou o juiz
     * sem resposta). Padrão: não — falha de infraestrutura não é defeito do
     * plano, e insistir só multiplica o tempo perdido enquanto a causa está lá.
     */
    repetirNaoAvaliado?: boolean;
    /** Como chamar o artefato nas mensagens de estágio ("plano", "missão", "decisão"). Padrão: "plano". */
    rotulo?: string;
}

/** O que a avaliação decidiu sobre UM plano, segundo o critério do gate. */
export interface DecisaoGate {
    aprovado: boolean;
    /** O veredito que decidiu. */
    veredito: VereditoGate;
    /** Quem decidiu. */
    fonte: 'oraculo' | 'juiz';
    /** O veredito normativo, quando houve. */
    oraculo?: Veredito;
    /** O que o juiz disse, quando a avaliação o trouxe. */
    juiz?: StatusJuiz;
    /**
     * A reprovação é falha técnica, não defeito do plano (avaliação impossível,
     * juiz sem resposta, juiz não chamado com o oráculo aprovando): gerar de
     * novo não conserta, então por padrão o gate para aqui.
     */
    falhaTecnica: boolean;
}

/** Uma geração reprovada e descartada pelo gate: o que foi jogado fora e por quê. */
export interface TentativaDescartada {
    tentativa: number;
    plano: string;
    /** O veredito que reprovou. */
    veredito: VereditoGate;
    /** Quem reprovou: o oráculo ou o juiz. */
    fonte: 'oraculo' | 'juiz';
    /** O veredito normativo desta tentativa, mesmo quando quem reprovou foi o juiz. */
    oraculo?: Veredito;
    /** O status do juiz nesta tentativa, mesmo quando quem reprovou foi o oráculo. */
    juiz?: StatusJuiz;
    /** A camada do oráculo que reprovou (sintaxe ou semântica), quando foi ele. */
    origem?: Oraculo['origem'];
    /** Em falha técnica, o motivo. */
    motivo?: string;
    /** Códigos dos erros que reprovaram (sintaxe e semântica) e os dados que faltaram. */
    codigos: string[];
    /** O que o juiz escreveu ao reprovar — a razão dele, como ele a deu. */
    justificativaJuiz?: string;
    tempoGeracaoMs: number;
    tempoAvaliacaoMs: number | null;
}

/** O custo e o desfecho do gate — o que vai para a resposta da API e para o JSONL do lote. */
export interface ResumoGate {
    /** Quantas gerações rodaram (1 = aprovado de primeira). */
    tentativas: number;
    maxTentativas: number;
    criterio: CriterioGate;
    /** O critério aprovou o plano que ficou. */
    aceita: boolean;
    /** O veredito que decidiu a tentativa que ficou. */
    veredito: VereditoGate;
    /** Quem decidiu. */
    fonte: 'oraculo' | 'juiz';
    /** O veredito normativo do plano que ficou. */
    oraculo?: Veredito;
    /** O status do juiz no plano que ficou. */
    juiz?: StatusJuiz;
    /** Teto batido sem aprovação: o que ficou é o último plano reprovado. */
    limiteAtingido: boolean;
    /** Geração que ficou (a aprovada, ou a última quando o teto foi batido). */
    tempoGeracaoAceitaMs: number;
    /** Soma das gerações descartadas — o custo do gate, fora do tempo do plano que ficou. */
    tempoGeracaoDescartadaMs: number;
    /** Soma das avaliações de todas as tentativas. */
    tempoAvaliacaoMs: number;
    descartadas: TentativaDescartada[];
}

export interface ResultadoGate<R> {
    /** A geração que ficou: a aprovada pelo critério ou, no teto, a última. */
    resposta: R;
    /** A avaliação completa dessa geração. Ausente só quando não houve plano a avaliar. */
    avaliacao?: DetalheLado;
    resumo: ResumoGate;
}

export interface DependenciasGate<R> {
    /** Roda o pipeline de geração inteiro, uma vez. */
    gerar: (tentativa: number) => Promise<R>;
    /** A cascata de avaliação sobre o plano gerado (sintaxe → semântica → oráculo [‖ juiz]). */
    avaliar: (resposta: R, tentativa: number) => Promise<DetalheLado>;
    /** O texto do plano na resposta da geração; `undefined` quando não houve plano. */
    planoDe: (resposta: R) => string | undefined;
    aoEstagio?: (texto: string) => Promise<void> | void;
    sinal?: AbortSignal;
}

/** Duração, em ms com 2 casas, desde um `performance.now()` (relógio monotônico). */
const duracaoMs = (inicio: number): number => Math.round((performance.now() - inicio) * 100) / 100;

/**
 * O veredito do oráculo, ou `NAO_AVALIADO` quando nenhuma camada chegou a dar
 * um. É a leitura normativa, sem critério nenhum aplicado — quem decide o gate
 * é `decidirGate`.
 */
export function vereditoDoGate(avaliacao: DetalheLado): Veredito | 'NAO_AVALIADO' {
    if (avaliacao.naoAvaliado || !avaliacao.oraculo) return 'NAO_AVALIADO';
    return avaliacao.oraculo.veredito;
}

/**
 * Aplica o critério à avaliação de um plano. Função pura: não repete nada, não
 * chama nada — só diz se o plano passa, quem decidiu e se a reprovação foi
 * defeito do plano ou falha técnica.
 */
export function decidirGate(avaliacao: DetalheLado, criterio: CriterioGate = 'ambos'): DecisaoGate {
    // Sem veredito nenhum: a cascata não chegou a rodar (grafo/motor fora,
    // telemetria insuficiente). Não é reprovação do plano.
    const vereditoOraculo = vereditoDoGate(avaliacao);
    if (vereditoOraculo === 'NAO_AVALIADO') {
        return { aprovado: false, veredito: 'NAO_AVALIADO', fonte: 'oraculo', falhaTecnica: true };
    }

    const oraculo = vereditoOraculo;
    const juiz = avaliacao.julgamentoLLM?.status;
    const comum = { oraculo, ...(juiz !== undefined ? { juiz } : {}) };

    // 1. O oráculo, quando é critério: ele é o veredito normativo e vem primeiro.
    if (criterio !== 'juiz') {
        if (oraculo !== 'VALID') {
            return { aprovado: false, veredito: oraculo, fonte: 'oraculo', ...comum, falhaTecnica: false };
        }
        if (criterio === 'oraculo') {
            return { aprovado: true, veredito: 'VALID', fonte: 'oraculo', ...comum, falhaTecnica: false };
        }
    }

    // 2. O juiz, em `juiz` e em `ambos` (aqui o oráculo já aprovou).
    if (juiz === 'VALID') {
        return { aprovado: true, veredito: 'VALID', fonte: 'juiz', ...comum, falhaTecnica: false };
    }
    if (juiz === 'INVALID' || juiz === 'UNRESOLVED') {
        return { aprovado: false, veredito: juiz, fonte: 'juiz', ...comum, falhaTecnica: false };
    }

    // 3. Juiz sem veredito. `NOT_CALLED` com o oráculo reprovando é o caso
    //    legítimo: o texto não pertence à DSL, e o juiz só julga o que o parser
    //    reconheceu — aí a reprovação é do plano, e gerar de novo faz sentido.
    //    Qualquer outro caso é falha técnica (ou configuração: juiz desligado).
    const defeitoDoPlano = juiz === 'NOT_CALLED' && oraculo !== 'VALID';
    return {
        aprovado: false,
        veredito: juiz === 'NOT_CALLED' ? 'NOT_CALLED' : 'NO_RESPONSE',
        fonte: 'juiz',
        ...comum,
        falhaTecnica: !defeitoDoPlano
    };
}

/** Teto máximo de códigos por tentativa descartada — o resumo é para ler, não para reprocessar. */
const MAX_CODIGOS = 20;
/** Teto da justificativa do juiz guardada na tentativa descartada. */
const MAX_JUSTIFICATIVA = 400;

/**
 * Por que o oráculo reprovou, em códigos: os erros da sintaxe, os erros da
 * semântica e os dados que faltaram (a causa usual do `UNRESOLVED`). Só o
 * resumo — o detalhe inteiro de cada camada fica na avaliação da tentativa que
 * ficou, nunca reconstruído aqui.
 */
export function codigosReprovacao(avaliacao: DetalheLado): string[] {
    const codigos = [
        ...(avaliacao.validacaoSintatica?.erros ?? []).map(e => e.codigo),
        ...(avaliacao.validacaoSemantica?.erros ?? []).map(e => e.codigo),
        ...(avaliacao.validacaoSemantica?.dadosFaltantes ?? []).map(d => `dado_faltante:${d}`)
    ].filter(c => typeof c === 'string' && c.length > 0);
    return [...new Set(codigos)].slice(0, MAX_CODIGOS);
}

/** A razão do juiz, como ele a escreveu (ou o motivo de não ter concluído). */
function justificativaDoJuiz(avaliacao: DetalheLado): string | undefined {
    const j = avaliacao.julgamentoLLM;
    const texto = j?.justificativa ?? j?.motivo;
    if (texto === undefined || texto.trim().length === 0) return undefined;
    return texto.length > MAX_JUSTIFICATIVA ? `${texto.slice(0, MAX_JUSTIFICATIVA)}…` : texto;
}

/** Como a reprovação é anunciada no estágio: quem reprovou e com que veredito. */
function anuncio(decisao: DecisaoGate): string {
    return decisao.fonte === 'juiz' ? `Juiz LLM: ${decisao.veredito}` : `Oráculo: ${decisao.veredito}`;
}

/**
 * Gera e avalia até o critério aprovar, ou até o teto.
 *
 *     tentativa 1..max:
 *       gerar -> plano? (nao: para, sem avaliacao)
 *             -> avaliar -> critério aprova    -> devolve
 *                        -> reprova (defeito)  -> descarta e repete (se sobrou tentativa)
 *                        -> falha técnica      -> para (ou repete, com repetirNaoAvaliado)
 *
 * O que volta é SEMPRE um par consistente: a geração que ficou e a avaliação
 * DESSA geração — nunca a avaliação de uma tentativa com o plano de outra.
 *
 * Cancelamento (`sinal`) é checado entre as tentativas: o laço não começa uma
 * geração nova depois do abort, e a tentativa em curso é devolvida como está (a
 * avaliação propaga o próprio abort dela). Falha da geração propaga — quem
 * chama decide (no lote, a linha fica com `erro`).
 */
export async function gerarComGate<R>(deps: DependenciasGate<R>, opcoes: OpcoesGate): Promise<ResultadoGate<R>> {
    const max = Math.max(1, Math.floor(opcoes.maxTentativas));
    const criterio = opcoes.criterio ?? 'ambos';
    const rotulo = opcoes.rotulo ?? 'plano';
    const descartadas: TentativaDescartada[] = [];
    let tempoGeracaoDescartadaMs = 0;
    let tempoAvaliacaoMs = 0;

    for (let tentativa = 1; ; tentativa++) {
        const inicioGeracao = performance.now();
        const resposta = await deps.gerar(tentativa);
        const tempoGeracao = duracaoMs(inicioGeracao);

        const resumo = (decisao: DecisaoGate, limiteAtingido = false): ResumoGate => ({
            tentativas: tentativa,
            maxTentativas: max,
            criterio,
            aceita: decisao.aprovado,
            veredito: decisao.veredito,
            fonte: decisao.fonte,
            ...(decisao.oraculo !== undefined ? { oraculo: decisao.oraculo } : {}),
            ...(decisao.juiz !== undefined ? { juiz: decisao.juiz } : {}),
            limiteAtingido,
            tempoGeracaoAceitaMs: tempoGeracao,
            tempoGeracaoDescartadaMs: Math.round(tempoGeracaoDescartadaMs * 100) / 100,
            tempoAvaliacaoMs: Math.round(tempoAvaliacaoMs * 100) / 100,
            descartadas
        });

        // Sem plano (comando recusado na validação, geração sem artefato): não
        // há o que avaliar nem o que repetir — o gate sai de lado e a resposta
        // da geração vale como está.
        const plano = deps.planoDe(resposta);
        if (plano === undefined) {
            const semPlano: DecisaoGate = { aprovado: false, veredito: 'NAO_AVALIADO', fonte: 'oraculo', falhaTecnica: true };
            return { resposta, resumo: resumo(semPlano) };
        }

        const cascata = criterio === 'oraculo' ? 'sintaxe → semântica → oráculo' : 'sintaxe → semântica → oráculo + juiz LLM';
        await deps.aoEstagio?.(`Validando o ${rotulo} gerado (${cascata})…`);
        const inicioAvaliacao = performance.now();
        const avaliacao = await deps.avaliar(resposta, tentativa);
        const tempoAvaliacao = duracaoMs(inicioAvaliacao);
        tempoAvaliacaoMs += tempoAvaliacao;

        const decisao = decidirGate(avaliacao, criterio);
        if (decisao.aprovado) {
            const quem = decisao.fonte === 'juiz' ? 'Oráculo e juiz LLM' : 'Oráculo';
            await deps.aoEstagio?.(
                tentativa === 1
                    ? `${quem}: VALID — ${rotulo} aceito.`
                    : `${quem}: VALID — ${rotulo} aceito na tentativa ${tentativa} de ${max}.`
            );
            return { resposta, avaliacao, resumo: resumo(decisao) };
        }

        // Falha técnica não é defeito do plano: por padrão o gate para aqui e a
        // linha sai marcada, em vez de repetir a geração contra uma causa que
        // continua de pé (grafo/motor fora, juiz sem resposta).
        const repetivel = !decisao.falhaTecnica || opcoes.repetirNaoAvaliado === true;
        const cancelado = deps.sinal?.aborted === true;
        if (!repetivel || tentativa >= max || cancelado) {
            if (decisao.falhaTecnica && !repetivel) {
                await deps.aoEstagio?.(
                    decisao.veredito === 'NAO_AVALIADO'
                        ? `Não foi possível avaliar o ${rotulo} gerado — a linha sai marcada.`
                        : `O juiz LLM não deu veredito (${decisao.veredito}) — a linha sai marcada.`
                );
            } else if (cancelado) {
                await deps.aoEstagio?.(`${anuncio(decisao)} — lote interrompido, sem nova tentativa.`);
            } else {
                await deps.aoEstagio?.(`${anuncio(decisao)} na tentativa ${tentativa} de ${max} — sem tentativa restante.`);
            }
            // `limiteAtingido` é só o teto batido: parar por falha técnica ou por
            // cancelamento não é o mesmo que ter esgotado as tentativas.
            return { resposta, avaliacao, resumo: resumo(decisao, repetivel && !cancelado && tentativa >= max) };
        }

        descartadas.push({
            tentativa,
            plano,
            veredito: decisao.veredito,
            fonte: decisao.fonte,
            ...(decisao.oraculo !== undefined ? { oraculo: decisao.oraculo } : {}),
            ...(decisao.juiz !== undefined ? { juiz: decisao.juiz } : {}),
            // `origem` e a camada que REPROVOU: so faz sentido quando quem reprovou foi o oraculo.
            ...(decisao.fonte === 'oraculo' && avaliacao.oraculo ? { origem: avaliacao.oraculo.origem } : {}),
            ...(avaliacao.motivo !== undefined ? { motivo: avaliacao.motivo } : {}),
            codigos: codigosReprovacao(avaliacao),
            ...(decisao.fonte === 'juiz' ? { justificativaJuiz: justificativaDoJuiz(avaliacao) } : {}),
            tempoGeracaoMs: tempoGeracao,
            tempoAvaliacaoMs: tempoAvaliacao
        });
        tempoGeracaoDescartadaMs += tempoGeracao;
        await deps.aoEstagio?.(`${anuncio(decisao)} — gerando o ${rotulo} novamente (tentativa ${tentativa + 1} de ${max})…`);
    }
}
