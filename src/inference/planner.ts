/**
 * Planner — o primeiro agente cognitivo da arquitetura multiagente.
 *
 *     ContextoExecucaoMultiagente --contextoPlanner()--> ContextoPlanner
 *        -> montarPromptPlanner   camada fina sobre o Prompt Semantico global
 *        -> MotorPlanner          POST /generate-planner: o MESMO `_gerar` do
 *                                 motor, com o mesmo modelo e o mesmo lock
 *        -> lerSaidaPlanner       saida bruta -> PIPlanejado[]
 *
 * O Planner escolhe, para cada posicao do plano, o PAR (item, conduta) e as
 * posicoes anteriores de que ele depende. Nao escolhe acao: decisao, meio,
 * valor e justificativa sao do PI Agent. A separacao esta em quatro lugares, de
 * proposito redundantes: no prompt (proibicao explicita), no contrato
 * (`PIPlanejado` tipa `acao` e `justificativa` como `never`), na gramatica (o
 * motor nao consegue emitir esses campos) e no parser (que os recusa se
 * aparecerem, venha a saida de onde vier).
 *
 * UMA chamada por execucao. Sem nova tentativa, sem realimentacao, sem
 * validacao semantica: a sequencia volta como CANDIDATA, e quem decide se ela
 * vale e a validacao contra o conhecimento, em outra etapa.
 *
 * NENHUMA CORRECAO. O parser le o protocolo ou recusa. Nao procura item em
 * texto livre, nao aproxima nome parecido, nao renumera posicao, nao completa
 * formato. Saida fora do protocolo e dado experimental — mede se o modelo
 * obedece —, e corrigi-la em silencio apagaria exatamente isso.
 */

import {
    condutasDoItem,
    condutasObrigatorias,
    condutasRealizaveis,
    estadoVazio,
    type ContratoArtefato
} from '../knowledge/contrato.js';
import {
    CAMPOS_DO_PI_AGENT,
    validarSequenciaPlanejada,
    type CodigoContratoPI,
    type PIPlanejado
} from '../knowledge/contrato-pi.js';
import type { EvidenciaRegra } from '../knowledge/item-geracao.js';
import type { SubgrafoPodado } from '../knowledge/politica.js';
import type { ContextoDominio, Dominio } from '../knowledge/recuperacao.js';
import type { RegraValidada } from '../knowledge/recuperacao-cypher.js';
import {
    invalido,
    naoResolvido,
    valido,
    type ProblemaValidacao,
    type ResultadoValidacao
} from '../knowledge/validacao.js';
import type { ContextoExecucaoMultiagente, FasePlanner, MetricasPlanner } from './multiagente.js';

// =============================================================================
// Contexto de entrada
// =============================================================================

/**
 * O que o Planner recebe. E uma PROJECAO do `ContextoExecucaoMultiagente`: os
 * campos da primeira metade sao os MESMOS objetos do contexto da execucao; a
 * segunda metade e o que so o Planner precisa — o universo de candidatos,
 * derivado da politica efetiva e do contrato.
 */
export interface ContextoPlanner {
    requestId: string;
    tentativa: { ciclo: number; numero: number };
    dominio: Dominio;
    pedido: string;
    contexto: ContextoDominio;
    promptSemantico: string;
    politicaEfetiva: SubgrafoPodado;
    regras: RegraValidada[];
    evidencias: EvidenciaRegra[];

    /** Itens da politica com pelo menos uma conduta realizavel, na ordem da politica. */
    itensDisponiveis: string[];
    /** Condutas que algum item pode realizar — o mesmo criterio da sequencia no incremental. */
    condutasDisponiveis: string[];
    /** item -> condutas que ele pode realizar (alguma decisao admissivel dele mapeia para a conduta). */
    condutasPorItem: Record<string, string[]>;
    /** Condutas que o artefato e obrigado a conter (escalonamento disparado). Informadas, nao impostas. */
    condutasObrigatorias: string[];
    /** O contrato so aceita dependencia para uma posicao ANTERIOR. */
    dependenciasPermitidas: 'somente_anteriores';
    /** Teto de posicoes: o pedido pelo chamador, limitado ao numero de itens quando o contrato exige unicidade. */
    maxPIs: number;

    /**
     * Restricao progressiva: item -> condutas a que a gramatica o amarra. So
     * entra item cujo par a validacao ja reprovou; vazio na primeira tentativa.
     */
    restricoesPorItem: Record<string, string[]>;
    /** Feedback da validacao da tentativa anterior. Ausente na primeira. */
    feedback?: string;
}

/**
 * Projeta o contexto da execucao no contexto do Planner.
 *
 * UNRESOLVED quando o conhecimento nao permite montar nem o universo minimo de
 * candidatos — sem item, ou sem conduta que algum item realize. Nesse caso nao
 * ha o que perguntar ao modelo, e inventar um plano seria pior que nao ter um.
 *
 * Lanca se o conhecimento ainda nao foi registrado: e erro de uso, nao de dado.
 */
export function contextoPlanner(
    ctx: ContextoExecucaoMultiagente<ContextoDominio, unknown>,
    contrato: ContratoArtefato,
    maxPIs: number
): ResultadoValidacao<ContextoPlanner, CodigoLeituraPlanner> {
    if (ctx.promptSemantico === undefined || ctx.politicaEfetiva === undefined) {
        throw new Error(`o Planner precisa do conhecimento registrado (status ${ctx.status})`);
    }
    if (!Number.isInteger(maxPIs) || maxPIs < 1) {
        throw new Error(`teto de posicoes do Planner invalido: ${maxPIs}`);
    }

    const condutasPorItem: Record<string, string[]> = {};
    for (const p of ctx.politicaEfetiva.politicas) {
        const condutas = condutasDoItem(contrato, p.item);
        if (condutas.length > 0) condutasPorItem[p.item] = condutas;
    }
    const itensDisponiveis = Object.keys(condutasPorItem);

    if (ctx.politicaEfetiva.politicas.length === 0) {
        return naoResolvido(['itens candidatos: a politica efetiva nao tem item com decisao admissivel']);
    }
    if (itensDisponiveis.length === 0) {
        return naoResolvido([
            'condutas candidatas: nenhuma decisao admissivel mapeia para uma conduta do esquema_dados'
        ]);
    }

    return valido({
        requestId: ctx.requestId,
        tentativa: { ciclo: ctx.tentativaGlobal, numero: ctx.tentativasPlanner.filter(t => t.ciclo === ctx.tentativaGlobal).length + 1 },
        dominio: ctx.dominio,
        pedido: ctx.pedido,
        contexto: ctx.contexto,
        promptSemantico: ctx.promptSemantico,
        politicaEfetiva: ctx.politicaEfetiva,
        regras: ctx.regras,
        evidencias: ctx.evidencias,
        itensDisponiveis,
        condutasDisponiveis: condutasRealizaveis(contrato, estadoVazio()),
        condutasPorItem,
        condutasObrigatorias: condutasObrigatorias(contrato),
        dependenciasPermitidas: 'somente_anteriores',
        // Com unicidade, cada item cabe em uma posicao so: mais posicoes que
        // itens so poderiam repetir item.
        maxPIs: contrato.unicidade ? Math.min(maxPIs, itensDisponiveis.length) : maxPIs,
        restricoesPorItem: {}
    });
}

// =============================================================================
// Prompt
// =============================================================================

const AMBIENTE: Record<Dominio, string> = {
    med: 'apoio a decisao em terapia intensiva',
    agro: 'pulverizacao aerea por drone',
    fut: 'apoio a arbitragem de futebol'
};

/** A linha de formato: o mesmo texto que a gramatica do motor gera, em uma linha. */
export const FORMATO_PLANNER = 'PLANO 1 | <item> | <conduta> | [ ] 2 | <item> | <conduta> | [ 1 ] FIM';

/**
 * O prompt do Planner. Camada FINA: o conteudo factual e o Prompt Semantico
 * global, entregue inteiro e uma vez so — nada da politica e reescrito aqui. O
 * que se acrescenta e o que so o Planner precisa: o papel, as proibicoes, os
 * candidatos (item -> condutas que ele pode cumprir) e o formato.
 *
 * Nao entram: exemplos de artefato, a gramatica da clausula, o grafo inteiro,
 * decisoes, meios ou valores fora do que o Prompt Semantico ja traz.
 */
export function montarPromptPlanner(cp: ContextoPlanner): string {
    const obrigatorias = cp.condutasObrigatorias.length > 0
        ? [
              '',
              '[CONDUTAS OBRIGATORIAS — o grafo disparou escalonamento]',
              ...cp.condutasObrigatorias.map(c => `- ${c}`)
          ]
        : [];

    return [
        'Voce e o Planner. Sua unica responsabilidade e escolher a sequencia de pares item-conduta.',
        `Sistema: ${AMBIENTE[cp.dominio]}.`,
        '',
        'Regras:',
        '- Cada posicao do plano e UM par: o item e a conduta que ele deve cumprir.',
        '- Use somente itens e condutas da lista de candidatos, escritos exatamente como aparecem.',
        '- Uma posicao so pode depender de posicoes anteriores. Sem dependencia, use [ ].',
        `- No maximo ${cp.maxPIs} posicao(oes).`,
        '- Nao produza acao.',
        '- Nao produza decisao.',
        '- Nao produza meio.',
        '- Nao produza valor.',
        '- Nao produza justificativa.',
        '- Nao produza clausulas.',
        '- Nao produza explicacoes fora do formato.',
        '',
        `comando: ${cp.pedido}`,
        'contexto (recuperado do grafo):',
        cp.promptSemantico,
        '',
        '[CANDIDATOS DO PLANO — item: condutas que ele pode cumprir]',
        ...cp.itensDisponiveis.map(i => `- ${i}: ${cp.condutasPorItem[i].join(', ')}`),
        ...obrigatorias,
        // A unica parte que muda entre tentativas: o prompt base e o mesmo, e
        // o feedback so traz o que a validacao reprovou na anterior.
        ...(cp.feedback ? ['', '[FEEDBACK DA VALIDACAO ANTERIOR]', cp.feedback] : []),
        '',
        'formato:',
        FORMATO_PLANNER,
        '',
        'plano:',
        ''
    ].join('\n');
}

// =============================================================================
// Leitura da saida
// =============================================================================

export type CodigoPlanner =
    | 'saida_vazia'
    | 'campo_de_acao'
    | 'cabecalho_ausente'
    | 'terminador_ausente'
    | 'pi_malformado'
    | 'pi_repetido'
    | 'item_fora_dos_candidatos'
    | 'conduta_fora_dos_candidatos';

/** Os codigos da leitura: os do protocolo e os do contrato estrutural do PI. */
export type CodigoLeituraPlanner = CodigoPlanner | CodigoContratoPI;

type Problema = ProblemaValidacao<CodigoLeituraPlanner>;

/**
 * Uma posicao: `<ordem> | <item> | <conduta> | [ <deps> ]`. Espaco em branco
 * entre os simbolos e livre (o motor gera um espaco; um humano ou um duble pode
 * quebrar linha). Tudo o mais e literal.
 */
const POSICAO =
    /\s*(\d+)\s*\|\s*([A-Za-z_][A-Za-z0-9_]*)\s*\|\s*([A-Za-z_][A-Za-z0-9_]*)\s*\|\s*\[\s*(\d+(?:\s*,\s*\d+)*)?\s*\]\s*/y;

const CAMPOS_PROIBIDOS = new Set<string>(CAMPOS_DO_PI_AGENT);

/** Palavras da saida, sem acento e em minusculas. `_` fica dentro da palavra: `Ajustar_Valor` nao e `valor`. */
function palavras(texto: string): string[] {
    return texto
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter(p => p.length > 0);
}

function trecho(texto: string): string {
    const t = texto.trim().replace(/\s+/g, ' ');
    return t.length > 60 ? `${t.slice(0, 60)}…` : t;
}

export interface UniversoPlanner {
    itens: string[];
    condutas: string[];
}

/**
 * Le a saida bruta do Planner.
 *
 *   1. So espaco em branco nas pontas e removido — e o unico elemento tecnico
 *      que o protocolo admite.
 *   2. Palavra de campo de acao (decisao, meio, valor, justificativa...) em
 *      qualquer lugar: INVALID. O Planner nao decide acao.
 *   3. `PLANO` no inicio, `FIM` no fim, e entre eles so posicoes: qualquer
 *      outra coisa — texto livre, markdown, quinto campo — e INVALID. A k-esima
 *      posicao tem de ter ordem k: nada e renumerado.
 *   4. O que foi lido passa pelo contrato estrutural (`validarSequenciaPlanejada`):
 *      plano vazio, dependencia propria, futura ou inexistente sao INVALID ali.
 *   5. Com `universo`, item ou conduta fora dos candidatos vira AVISO, nao erro,
 *      e o nome segue exatamente como veio. Vocabulario e semantica: quem
 *      decide e a validacao contra o conhecimento. Par (item, conduta) repetido
 *      tambem e so aviso, pelo mesmo motivo.
 */
export function lerSaidaPlanner(
    bruto: string,
    universo?: UniversoPlanner
): ResultadoValidacao<PIPlanejado[], CodigoLeituraPlanner> {
    const texto = bruto.trim();
    const recusar = (codigo: CodigoLeituraPlanner, mensagem: string, pi?: number) =>
        invalido<PIPlanejado[], CodigoLeituraPlanner>([pi === undefined ? { codigo, mensagem } : { codigo, mensagem, pi }]);

    if (texto.length === 0) return recusar('saida_vazia', 'o Planner nao devolveu nada');

    const acao = palavras(texto).find(p => CAMPOS_PROIBIDOS.has(p));
    if (acao) {
        return recusar('campo_de_acao', `a saida traz '${acao}': o Planner escolhe so o par (item, conduta); acao e do PI Agent`);
    }
    if (!/^PLANO(\s|$)/.test(texto)) {
        return recusar('cabecalho_ausente', `a saida precisa comecar com PLANO; comecou com "${trecho(texto)}"`);
    }
    if (!/(^|[\s\]])FIM$/.test(texto)) {
        return recusar('terminador_ausente', `a saida precisa terminar com FIM; terminou com "${trecho(texto.slice(-60))}"`);
    }

    const corpo = texto.slice('PLANO'.length, texto.length - 'FIM'.length);
    const lidos: PIPlanejado[] = [];
    let posicao = 0;
    while (corpo.slice(posicao).trim().length > 0) {
        const esperada = lidos.length + 1;
        POSICAO.lastIndex = posicao;
        const m = POSICAO.exec(corpo);
        if (!m) {
            return recusar('pi_malformado', `posicao ${esperada} fora do protocolo: "${trecho(corpo.slice(posicao))}"`, esperada);
        }
        const ordem = Number(m[1]);
        if (ordem !== esperada) {
            return recusar('ordem_fora_de_posicao', `a posicao ${esperada} veio numerada ${ordem}`, esperada);
        }
        lidos.push({
            ordem,
            item: m[2],
            conduta: m[3],
            dependeDe: m[4] ? m[4].split(',').map(d => Number(d.trim())) : []
        });
        posicao = POSICAO.lastIndex;
    }

    const contrato = validarSequenciaPlanejada(lidos);
    if (contrato.veredito !== 'VALID') {
        return invalido(contrato.erros, { avisos: contrato.avisos });
    }

    const pis = contrato.valor!;
    const avisos: Problema[] = [...contrato.avisos];
    const vistos = new Set<string>();
    for (const p of pis) {
        const par = `${p.item}|${p.conduta}`;
        if (vistos.has(par)) {
            avisos.push({ codigo: 'pi_repetido', mensagem: `o par (${p.item}, ${p.conduta}) aparece mais de uma vez`, pi: p.ordem, item: p.item });
        }
        vistos.add(par);
        if (universo && !universo.itens.includes(p.item)) {
            avisos.push({ codigo: 'item_fora_dos_candidatos', mensagem: `'${p.item}' nao esta entre os itens candidatos`, pi: p.ordem, item: p.item });
        }
        if (universo && !universo.condutas.includes(p.conduta)) {
            avisos.push({ codigo: 'conduta_fora_dos_candidatos', mensagem: `'${p.conduta}' nao esta entre as condutas candidatas`, pi: p.ordem, item: p.item });
        }
    }
    return valido(pis, avisos);
}

// =============================================================================
// Chamada ao modelo
// =============================================================================

/** Corpo de `POST /generate-planner` (ver python_engine/main.py). */
export interface PedidoPlanner {
    prompt: string;
    itens: string[];
    condutas: string[];
    max_pis: number;
    /** Restricao progressiva (ver `ContextoPlanner.restricoesPorItem`). So vai quando ha restricao. */
    condutas_por_item?: Record<string, string[]>;
}

/** Resposta de `POST /generate-planner`. `saida` e crua. */
export interface RespostaPlanner {
    saida: string;
    valida_na_gramatica?: boolean;
    erro?: string | null;
    tokens_prompt?: number | null;
    regras_na_gramatica?: number;
    gbnf?: string;
}

/** Quem gera a proposta. Injetavel para teste sem motor nem GPU; o real e `motorPlannerHttp`. */
export type MotorPlanner = (pedido: PedidoPlanner) => Promise<RespostaPlanner>;

export interface PropostaPlanner {
    /** O prompt enviado — a entrada exata do modelo. */
    prompt: string;
    /** A saida como o modelo a devolveu. */
    bruto: string;
    validacao: ResultadoValidacao<PIPlanejado[], CodigoLeituraPlanner>;
    metricas: MetricasPlanner;
    /** A GBNF que mascarou a geracao, quando o motor a informa. */
    gbnf?: string;
}

/**
 * UMA proposta do Planner: monta o prompt, pede ao motor sob a gramatica do
 * Planner (derivada no motor do vocabulario enviado) e le a saida.
 *
 * Nao valida semanticamente, nao tenta de novo, nao mexe na politica nem nas
 * regras. Falha tecnica do motor sobe como excecao; saida fora do protocolo
 * volta como INVALID, com a saida bruta preservada.
 */
export async function planejarSequencia(
    cp: ContextoPlanner,
    motor: MotorPlanner,
    agora: () => number = () => performance.now()
): Promise<PropostaPlanner> {
    const prompt = montarPromptPlanner(cp);
    const restringe = Object.keys(cp.restricoesPorItem).length > 0;
    const inicio = agora();
    const resposta = await motor({
        prompt,
        itens: cp.itensDisponiveis,
        condutas: cp.condutasDisponiveis,
        max_pis: cp.maxPIs,
        // Sem restricao o pedido e o mesmo da primeira versao do Planner.
        ...(restringe ? { condutas_por_item: cp.restricoesPorItem } : {})
    });
    const duracaoMs = Math.round(agora() - inicio);
    const bruto = typeof resposta.saida === 'string' ? resposta.saida : '';
    const validacao = lerSaidaPlanner(bruto, { itens: cp.itensDisponiveis, condutas: cp.condutasDisponiveis });

    const metricas: MetricasPlanner = {
        caracteresPrompt: prompt.length,
        itensCandidatos: cp.itensDisponiveis.length,
        condutasCandidatas: cp.condutasDisponiveis.length,
        duracaoMs,
        pisProduzidos: validacao.valor?.length ?? 0
    };
    if (typeof resposta.tokens_prompt === 'number') metricas.tokensPrompt = resposta.tokens_prompt;
    if (typeof resposta.valida_na_gramatica === 'boolean') metricas.validaNaGramatica = resposta.valida_na_gramatica;
    if (cp.feedback) metricas.caracteresFeedback = cp.feedback.length;

    return { prompt, bruto, validacao, metricas, gbnf: resposta.gbnf };
}

// =============================================================================
// Realimentacao
// =============================================================================

/** A sequencia de volta ao formato do protocolo, para o Planner ver o que propos. */
export function comoProtocolo(sequencia: PIPlanejado[]): string {
    const deps = (d: number[]): string => (d.length > 0 ? `[ ${d.join(' , ')} ]` : '[ ]');
    return `PLANO ${sequencia.map(p => `${p.ordem} | ${p.item} | ${p.conduta} | ${deps(p.dependeDe)}`).join(' ')} FIM`;
}

function recorte(texto: string, limite = 300): string {
    const t = texto.trim();
    return t.length > limite ? `${t.slice(0, limite)}…` : t;
}

/**
 * O feedback que vai na secao [FEEDBACK DA VALIDACAO ANTERIOR] da proxima
 * tentativa. Dois textos distintos, porque sao falhas distintas — e a
 * distincao e dado experimental:
 *
 *   protocolo  a saida nao respeitou o formato. O Planner ve a propria saida e
 *              o que estava fora dele, e o formato de novo.
 *   semantica  a forma estava certa e o plano contrariou o conhecimento. O
 *              Planner ve o plano que propos e, por PI, o erro, a regra, a
 *              evidencia e o que o conhecimento permite (`relatorioDaSequencia`).
 *
 * So entra o que a validacao reprovou na tentativa anterior: nada do grafo,
 * nada do artefato, nada que o prompt base ja traga.
 */
export function montarFeedbackPlanner(
    fase: FasePlanner,
    bruto: string,
    validacao: ResultadoValidacao,
    sequencia?: PIPlanejado[]
): string {
    const fecho = ['Gere novamente SOMENTE a sequencia de PIs.', 'Nao produza acoes ou justificativas.'];
    if (fase === 'protocolo') {
        return [
            'A saida anterior NAO respeitou o protocolo do Planner.',
            `saida anterior: ${recorte(bruto)}`,
            'problemas:',
            ...validacao.erros.map(e => `- ${e.codigo}: ${e.mensagem}`),
            `Responda somente no formato: ${FORMATO_PLANNER}`,
            ...fecho
        ].join('\n');
    }
    return [
        'O plano anterior foi REJEITADO pela validacao contra o conhecimento.',
        `plano anterior: ${sequencia ? comoProtocolo(sequencia) : recorte(bruto)}`,
        validacao.promptRecomendado ?? validacao.erros.map(e => `- ${e.codigo}: ${e.mensagem}`).join('\n'),
        ...fecho
    ].join('\n');
}

/**
 * A restricao da proxima tentativa: cada item cujo par foi comprovadamente
 * incompativel fica amarrado as condutas que ele realiza. Acumula entre
 * tentativas — a evidencia nao expira. Nenhum item e restringido so porque o
 * Planner nao o escolheu.
 */
export function restringirAposErros(
    restricoes: Record<string, string[]>,
    validacao: ResultadoValidacao,
    condutasPorItem: Record<string, string[]>
): Record<string, string[]> {
    const novas = { ...restricoes };
    for (const e of validacao.erros) {
        if (e.codigo === 'item_conduta_incompativel' && e.item && condutasPorItem[e.item]) {
            novas[e.item] = condutasPorItem[e.item];
        }
    }
    return novas;
}
