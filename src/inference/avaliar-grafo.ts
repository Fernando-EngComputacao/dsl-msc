/**
 * Avaliação de planos já gerados — usada por `POST /api/avaliar` (ver
 * src/web/server.ts) no lugar da comparação contra um ground truth fixo (ver
 * src/inference/avaliar.ts, ainda usado pelos geradores de ground truth em
 * src/scripts/).
 *
 * Não existe resposta canônica pré-computada. Cada registro do arquivo enviado
 * já carrega o "sorteio" completo do cenário, o mesmo material da geração
 * original (ver `processarMed`/`processarAgro`/`processarFut` em server.ts). O
 * plano passa por uma CASCATA, e cada camada responde uma pergunta diferente:
 *
 *   1. SINTAXE      o texto pertence à DSL? G (`/verify` sem política) e o
 *                   parser Langium -> AST oficial. Ver avaliar-sintaxe.ts.
 *   2. SEMÂNTICA    dado o AST, o plano respeita política, conhecimento,
 *                   telemetria, pedido, contrato e relações do cenário? Os
 *                   validadores da GERAÇÃO multiagente, na ordem dela, sobre a
 *                   MESMA recuperação refeita (`validarSemantica`):
 *                     L(Ĝ)      `/verify` com a política efetiva — a política
 *                               escrita como gramática
 *                     sequência `validarSequencia` (o que valida o Planner)
 *                     PIs       `decomporPIs` + `validarPI` (o que valida cada
 *                               PI Agent)
 *                     global    `validarPlanoGlobal` (contrato: `verificarLido`
 *                               -> `verificarClausulas` + `verificarArtefato`;
 *                               relações, telemetria, dependências, pedido)
 *                   A semântica NÃO recebe o texto: só o AST guardado
 *                   (`projetarAst`). O plano composto que ela julga tem
 *                   `texto` vazio.
 *   3. ORÁCULO      sintaxe + semântica, com a origem do veredito. É o
 *                   resultado NORMATIVO.
 *   4. LLM JUDGE    avaliador EXPERIMENTAL e independente, depois do oráculo.
 *                   Avalia qualquer plano com AST — inclusive semanticamente
 *                   INVALID ou UNRESOLVED —; texto fora da DSL não gasta
 *                   chamada (salvo `julgarSintaxeInvalida`), artefato vazio
 *                   nunca. Não recebe nada das camadas determinísticas.
 *
 * O juiz não é forçado a concordar e nunca corrige o oráculo, nem o oráculo o
 * juiz: vereditos diferentes viram `DISCORDANCIA_LLM`, com os dois guardados
 * como vieram. `UNRESOLVED` do oráculo continua `UNRESOLVED` qualquer que seja o
 * juiz. Nenhuma camada compara o plano com um texto de referência.
 */

import type { Session } from 'neo4j-driver';

import { condutasObrigatorias, condutasRealizaveis, estadoVazio, type ArtefatoLido, type ContratoArtefato } from '../knowledge/contrato.js';
import { textoDaClausula, type PIPlanejado, type ResultadoPI } from '../knowledge/contrato-pi.js';
import type { PlanoComposto } from '../knowledge/composicao.js';
import { decomporPIs, vistaDoCenario } from '../knowledge/decompositor.js';
import type { SubgrafoPodado } from '../knowledge/politica.js';
import type { ContextoDominio } from '../knowledge/recuperacao.js';
import { explicarRegra } from '../knowledge/recuperacao-hibrida.js';
import { combinar, type ProblemaValidacao, type ResultadoValidacao, type Veredito } from '../knowledge/validacao.js';
import { partesDaRelacao, validarPlanoGlobal, type ConhecimentoGlobal } from '../knowledge/validacao-global.js';
import { validarPI } from '../knowledge/validacao-pi.js';
import { validarSequencia } from '../knowledge/validacao-sequencia.js';
import { textoGerado, type RegistroAvaliar } from './avaliar.js';
import {
    FalhaSintaxe,
    projetarAst,
    validarSintaxePlano,
    type AnalisadorDsl,
    type AstArtefato,
    type ResultadoSintaxe,
    type ValidacaoSintatica,
    type VerificadorDaDsl
} from './avaliar-sintaxe.js';
import type { VerificacaoGramatical, VerificadorGramatical } from './ciclo-global.js';
import type { OpcoesDecodificacao } from './decodificacao.js';
import { recuperarConhecimento, type AdaptadorRecuperacao, type ConhecimentoRecuperado } from './recuperacao-conhecimento.js';

export type Dominio = 'med' | 'agro' | 'fut';

/** Decisões que representam aumento de exposição ao alvo (fármaco/produto) —
 *  as únicas que uma violação de segurança pode assumir. */
const DECISOES_DE_INCREMENTO = new Set(['INICIAR_INFUSAO', 'AUMENTAR_VAZAO', 'AJUSTAR_DOSE']);

/** Bloco de contexto do cenário ("sorteio") como o lote grava no arquivo —
 *  ver o mesmo formato em `sorteio` dentro de `processarMed`/`Agro`/`Fut`. */
export interface BlocoTelemetriaGrafo {
    paciente?: string;
    talhao?: string;
    partida?: string;
    telemetria?: Record<string, unknown>;
    populacoes?: unknown;
    farmacosEmUso?: unknown;
    areas?: unknown;
    produtosEmUso?: unknown;
    contextos?: unknown;
    infracoesEmUso?: unknown;
}

/** Registro avaliado (upload do usuário) — mesmo espírito solto de
 *  RegistroAvaliar (avaliar.ts), com `telemetria` rico o bastante para
 *  reconstruir o cenário. */
export interface RegistroAvaliarGrafo {
    linha?: number;
    intencao?: string;
    valido?: boolean;
    plano?: string;
    resultado?: string;
    telemetria?: BlocoTelemetriaGrafo;
    /** O Prompt Semântico que a GERAÇÃO usou. Se o reconstruído diferir, a
     *  semântica avisa: o grafo, o foco ou o modo de recuperação mudou. */
    promptSemantico?: string;
    /**
     * O que o modo multiagente devolve em `execucaoMultiagente` (a resposta da
     * API, e o que o lote do web-chat grava). Só a sequência do Planner é lida:
     * `dependeDe` não está na DSL do artefato, e é dela que as dependências (e as
     * relações que cada PI Agent viu no prompt) vêm.
     */
    execucaoMultiagente?: { status?: string; sequenciaValidada?: PIPlanejado[] };
    /**
     * Tempos de GERAÇÃO deste cenário, gravados pelo lote do web-chat (ver
     * tempos-lote.ts) — do sorteio à geração restrita do plano, ANTES de
     * chegar aqui. A avaliação não os mede: só os repassa e agrega (ver
     * `tempoGeracao*Segundos` em `ResultadoAvaliacaoGrafo`). `null` quando o
     * lote não passou por aquela etapa (ex.: fora do modo multiagente).
     */
    tempoTotalMs?: number;
    tempoSequenciasMs?: number | null;
    tempoPIsValidasMs?: number | null;
    tempoValidacaoPlanosMs?: number | null;
}

// =============================================================================
// Contrato do resultado
// =============================================================================

/** Veredito de uma camada que pode não ter rodado. */
export type VereditoSemantico = Veredito | 'NOT_EVALUATED';

/** O que o juiz disse — ou por que não disse. */
export type StatusJuiz = Veredito | 'NOT_CALLED' | 'NO_RESPONSE';

export type NomeEtapaSemantica = 'gramatica_da_politica' | 'sequencia' | 'pis' | 'global';

/** Um problema da semântica, com a etapa (e o validador) que o apontou. */
export type ProblemaSemantico = ProblemaValidacao & { etapa: NomeEtapaSemantica | 'conhecimento' };

/** Uma etapa da semântica: o validador oficial que a decide e o que ele disse. */
export interface EtapaSemantica {
    etapa: NomeEtapaSemantica;
    validador: string;
    veredito: VereditoSemantico;
    erros: ProblemaValidacao[];
    avisos: ProblemaValidacao[];
    dadosFaltantes: string[];
    /** Por que a etapa não rodou. */
    motivo?: string;
}

export interface ValidacaoSemantica {
    veredito: VereditoSemantico;
    erros: ProblemaSemantico[];
    avisos: ProblemaSemantico[];
    /** Não vazio se e somente se UNRESOLVED. */
    dadosFaltantes: string[];
    etapas: EtapaSemantica[];
    /** O conhecimento que é só TEXTO (`regra_global`, mecanismo e conduta das
     *  relações): vai como evidência, e nenhuma etapa o confere. */
    naoFormalizado: string[];
    /** Por que não foi avaliada. */
    motivo?: string;
}

/** O veredito determinístico e a camada que o decidiu. É o resultado normativo. */
export interface Oraculo {
    veredito: Veredito;
    origem: 'sintaxe' | 'semantica';
}

/** O que o juiz respondeu, como a chamada o devolve (`JuizLLM`). */
export interface RespostaJuizLLM {
    veredito: Veredito;
    justificativa: string;
    evidencias?: string[];
    /** A saída do modelo, sem tratamento — auditoria. */
    respostaBruta?: string;
}

/** O juiz no resultado: sempre presente, com o status. */
export interface JulgamentoLLM {
    status: StatusJuiz;
    justificativa?: string;
    evidencias?: string[];
    respostaBruta?: string;
    /** Em NOT_CALLED, por que não foi chamado; em NO_RESPONSE, a falha. */
    motivo?: string;
}

export type ClassificacaoAvaliacao =
    | 'VALIDO_PELO_ORACULO'
    | 'INVALIDO_PELO_ORACULO'
    | 'UNRESOLVIDO_PELO_ORACULO'
    | 'DISCORDANCIA_LLM';

/** As camadas da avaliação de um plano, separadas, e a comparação final. */
export interface ResultadoAvaliacaoPlano {
    validacaoSintatica: ValidacaoSintatica;
    /** O AST oficial reconhecido — o MESMO objeto que a semântica leu. Só com sintaxe VALID. */
    ast?: AstArtefato;
    validacaoSemantica: ValidacaoSemantica;
    oraculo: Oraculo;
    julgamentoLLM: JulgamentoLLM;
    /** Só quando o juiz deu veredito. */
    concordancia?: boolean;
    classificacao: ClassificacaoAvaliacao;
}

export interface DetalheLado extends Partial<ResultadoAvaliacaoPlano> {
    plano: string;
    /** Identificador do cenário (paciente/talhão/partida), quando o registro o traz. */
    sujeito?: string;
    /** Incremento num item bloqueado ou vetado pelas restrições COMPLETAS do
     *  cenário (antes do foco), lido do AST. Ausente sem AST. */
    violacao?: boolean;
    /** Prompt Semântico reconstruído para este registro — o que o juiz leu. */
    contextoGrafo?: string;
    /** true quando uma falha técnica (grafo, motor, parser, defeito interno)
     *  impediu a avaliação: nenhuma camada tem veredito. */
    naoAvaliado: boolean;
    /** Por que a linha não foi avaliada. */
    motivo?: string;
    /** Tempos deste plano (ver `TemposPlano`). */
    tempos?: TemposPlano;
}

/**
 * Durações de UM plano, em ms (`performance.now()`, relógio monotônico). Depois do AST,
 * oráculo e juiz rodam concorrentes: `paraleloMs` ≈ max(`oraculoMs`, `llmJudgeMs`) e
 * `totalMs` ≈ `sintaxeMs` + `recuperacaoMs` + `paraleloMs` + sobrecarga — não a soma dos dois.
 */
export interface TemposPlano {
    /** Validação sintática: G (/verify) + parser Langium. */
    sintaxeMs: number;
    /** Recuperação do conhecimento (grafo): passo compartilhado, feito ANTES da bifurcação
     *  porque a semântica e o juiz leem o mesmo conhecimento. Ausente quando não houve. */
    recuperacaoMs?: number;
    /** Só a validação semântica (L(Ĝ), sequência, PIs, global). `null` se não rodou. */
    oraculoMs: number | null;
    /** Só a chamada ao LLM Judge (monta o pedido + `/validar-plano`). `null` se não foi chamado. */
    llmJudgeMs: number | null;
    /** O trecho concorrente inteiro (semântica || juiz). Ausente quando não houve bifurcação. */
    paraleloMs?: number;
    /** A avaliação completa deste plano. */
    totalMs: number;
}

export interface DetalheLinha {
    linha: number;
    intencao: string;
    arquitetura?: DetalheLado;
    baseline?: DetalheLado;
    /** true se algum lado avaliado não saiu VALID pelo oráculo, ou teve violação. */
    temDivergencia: boolean;
    /** true se, em algum lado, o juiz discordou do oráculo. */
    temDiscordancia: boolean;
}

export interface ContagemVereditos {
    VALID: number;
    INVALID: number;
    UNRESOLVED: number;
}

export interface Metricas {
    /** Só linhas efetivamente avaliadas — exclui `naoAvaliado`. */
    total: number;
    sintaxe: { VALID: number; INVALID: number };
    semantica: ContagemVereditos & { NOT_EVALUATED: number };
    oraculo: ContagemVereditos;
    juiz: ContagemVereditos & { NOT_CALLED: number; NO_RESPONSE: number };
    concordantes: number;
    discordantes: number;
    /** `<oraculo>+<juiz>` -> quantas linhas, só onde o juiz deu veredito. */
    pares: Record<string, number>;
    /** Linhas com AST e incremento em item bloqueado/vetado. */
    violacoes: number;
}

export interface ResultadoAvaliacaoGrafo {
    arquitetura?: Metricas;
    baseline?: Metricas;
    /** Registros que não puderam ser avaliados, somando os dois arquivos. */
    naoAvaliados: number;
    linhas: DetalheLinha[];
    /** Nome do JSONL experimental gravado pelo servidor (ver `registrosJsonl`). */
    arquivoJsonl?: string;
    /** Tempo total, em segundos, que o servidor levou para processar a avaliação inteira. */
    tempoTotalSegundos?: number;
    /** Soma dos tempos da validação sintática de todos os planos, em segundos. */
    tempoSintaxeSegundos?: number;
    /** Soma dos tempos da validação semântica (oráculo) de todos os planos, em segundos. */
    tempoOraculoSegundos?: number;
    /** Soma dos tempos do LLM Judge de todos os planos, em segundos. */
    tempoLlmJudgeSegundos?: number;
    /**
     * Soma, em segundos, dos tempos de GERAÇÃO dos cenários avaliados (os dois
     * arquivos), repassados de `RegistroAvaliarGrafo.tempoTotalMs` e das três
     * etapas. Ausente quando nenhum registro trouxe aquele tempo (ex.: os
     * arquivos não vieram do lote do web-chat, ou vieram de antes da medição).
     */
    tempoGeracaoTotalSegundos?: number;
    tempoGeracaoSequenciasSegundos?: number;
    tempoGeracaoPIsValidasSegundos?: number;
    tempoGeracaoValidacaoPlanosSegundos?: number;
}

// ---------------------------------------------------------------------------
// Extração do bloco de telemetria — pequenos helpers reaproveitados pelos três
// domínios em server.ts.
// ---------------------------------------------------------------------------

/** Sinais numéricos do cenário (`telemetria.telemetria`) — `null` se ausente
 *  ou vazio, sinal de que não dá pra consultar o grafo para este registro. */
export function sinaisDe(bloco: BlocoTelemetriaGrafo | undefined): Record<string, number> | null {
    const sinais = bloco?.telemetria;
    if (!sinais || typeof sinais !== 'object') return null;
    const entradas = Object.entries(sinais).filter((e): e is [string, number] => typeof e[1] === 'number');
    return entradas.length > 0 ? Object.fromEntries(entradas) : null;
}

export function listaDe(valor: unknown): string[] {
    return Array.isArray(valor) ? valor.filter((x): x is string => typeof x === 'string') : [];
}

/** Identificador do cenário: `paciente` (med), `talhao` (agro) ou `partida`
 *  (fut) — usado tanto para montar o contexto quanto para parear arquitetura
 *  × baseline (ver `parearRegistros`). */
export function identificadorRegistro(r: RegistroAvaliarGrafo): string | null {
    const bloco = r.telemetria;
    const id = bloco?.paciente ?? bloco?.talhao ?? bloco?.partida;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
}

// ---------------------------------------------------------------------------
// Violação de segurança (métrica de sempre, sobre o AST)
// ---------------------------------------------------------------------------

/** Alguma cláusula de incremento (INICIAR_INFUSAO, AUMENTAR_VAZAO, AJUSTAR_DOSE)
 *  mira um item que o grafo, PARA ESTE CENÁRIO, bloqueou ou vetou. */
export function violacaoNoArtefato(artefato: ArtefatoLido, proibidos: Set<string>): boolean {
    return artefato.clausulas.some(c => proibidos.has(c.item) && DECISOES_DE_INCREMENTO.has(c.decisao));
}

/** Itens bloqueados ou vetados nas restrições do domínio — pelos nomes de campo
 *  do próprio domínio, via `vistaDoCenario`. */
export function itensProibidos(dominio: Dominio, restricoes: unknown): Set<string> {
    const vista = vistaDoCenario(dominio, restricoes);
    return new Set(
        Object.entries(vista.fatosPorItem)
            .filter(([, fatos]) => fatos.some(f => f.tipo === 'bloqueio' || f.tipo === 'veto'))
            .map(([item]) => item)
    );
}

// =============================================================================
// Semântica determinística, sobre o AST
// =============================================================================

/** Defeito interno do avaliador (não do plano): a linha não é avaliada. */
export class DefeitoAvaliacao extends Error {
    constructor(mensagem: string) {
        super(mensagem);
        this.name = 'DefeitoAvaliacao';
    }
}

export interface PlanoDoArtefato {
    plano: PlanoComposto;
    /** A sequência do Planner foi usada (corresponde às cláusulas item a item). */
    sequenciaInformada: boolean;
    /** Veio sequência, mas ela não corresponde às cláusulas do AST: não foi usada. */
    sequenciaDivergente: boolean;
}

/**
 * O AST como `PlanoComposto` — a forma que os validadores da geração julgam.
 * `lido` é o AST (o contrato o julga por `verificarLido`); `texto` fica VAZIO
 * de propósito: a semântica não tem texto para reler. Cada cláusula vira o
 * `PIPlanejado` (item e a conduta que o `esquema_dados` associa à decisão — o
 * mapa é 1:1 nos três domínios) e o `ResultadoPI` que `comoClausulaLida`
 * desfaria.
 *
 * `dependeDe` não está na DSL do artefato: vem da sequência do Planner, quando
 * ela corresponde às cláusulas (mesmo tamanho, ordem 1..n, mesmo item em cada
 * posição); a conduta também vem dela nesse caso. Senão, as dependências ficam
 * vazias e nenhuma é inventada.
 */
export function planoDoArtefato(
    artefato: ArtefatoLido,
    contrato: ContratoArtefato,
    sequencia?: readonly PIPlanejado[]
): PlanoDoArtefato {
    const informada =
        !!sequencia &&
        sequencia.length === artefato.clausulas.length &&
        sequencia.every((p, i) => p.ordem === i + 1 && p.item === artefato.clausulas[i].item);

    const pis: PIPlanejado[] = artefato.clausulas.map((c, i) =>
        informada
            ? { ordem: i + 1, item: c.item, conduta: sequencia![i].conduta, dependeDe: [...sequencia![i].dependeDe] }
            : { ordem: i + 1, item: c.item, conduta: contrato.condutaPorDecisao[c.decisao] ?? '', dependeDe: [] }
    );
    const resultados: ResultadoPI[] = artefato.clausulas.map((c, i) => ({
        ordem: i + 1,
        item: c.item,
        conduta: pis[i].conduta,
        acao: { decisao: c.decisao, meio: c.meio, valor: { valor: c.valor, unidade: c.unidade } },
        justificativa: c.justificativa
    }));

    return {
        plano: {
            texto: '',
            identificador: artefato.identificador ?? '',
            contexto: artefato.contexto ?? '',
            sequencia: artefato.sequencia,
            clausulas: resultados.map(r => textoDaClausula(r, contrato.papeis)),
            pis,
            resultados,
            lido: artefato
        },
        sequenciaInformada: informada,
        sequenciaDivergente: !!sequencia && !informada
    };
}

/**
 * O conhecimento não tem base para julgar plano algum: a política efetiva não
 * tem item, ou falta o mapa decisão -> conduta. É o critério de
 * `validarSequencia` ("sem politica ou sem mapa nao ha contra o que julgar par
 * nenhum") e o de `lacunasDoConhecimento` na geração, que para ANTES do Planner.
 * Devolve o motivo, ou `undefined` quando há base.
 */
export function semBaseSemantica(k: ConhecimentoGlobal): string | undefined {
    const faltas = [
        ...(k.politica.politicas.length === 0 ? ['a politica efetiva nao tem item com decisao admissivel'] : []),
        ...(Object.keys(k.contrato.condutaPorDecisao).length === 0 ? ['sem o mapa decisao -> conduta do esquema_dados'] : [])
    ];
    return faltas.length > 0 ? faltas.join('; ') : undefined;
}

/**
 * Um escalonamento disparado obriga uma conduta que NENHUM item da política
 * efetiva realiza: nenhum plano pode cumpri-la (a cláusula que a cumpriria seria
 * `decisao_inadmissivel`). `validarSequencia` trata isso como lacuna do
 * conhecimento ("conduta obrigatoria que ninguem realiza e lacuna"), e a geração
 * para antes do Planner (`lacunasDoConhecimento`) — por isso a validação global
 * nunca vê esse estado na geração. No avaliador ela vê, e o seu
 * `escalonamento_ignorado` transformaria ausência de conhecimento em INVALID.
 * Aqui ele vira o que `validarSequencia` diz que é: dado faltante, com aviso.
 */
function reconciliarObrigatoriasIrrealizaveis(etapa: EtapaSemantica, contrato: ContratoArtefato): EtapaSemantica {
    const realizaveis = condutasRealizaveis(contrato, estadoVazio());
    const irrealizaveis = condutasObrigatorias(contrato).filter(c => !realizaveis.includes(c));
    const ignorado = etapa.erros.filter(e => e.codigo === 'escalonamento_ignorado');
    if (irrealizaveis.length === 0 || ignorado.length === 0) return etapa;
    const erros = etapa.erros.filter(e => e.codigo !== 'escalonamento_ignorado');
    const dadosFaltantes = [...new Set([...etapa.dadosFaltantes, ...irrealizaveis.map(c => `item que realize ${c}`)])];
    return {
        ...etapa,
        veredito: erros.length > 0 ? 'INVALID' : 'UNRESOLVED',
        erros,
        dadosFaltantes: erros.length > 0 ? [] : dadosFaltantes,
        avisos: [...etapa.avisos, {
            codigo: 'escalonamento_irrealizavel',
            mensagem: `o escalonamento disparado obriga ${irrealizaveis.join(', ')}, que nenhum item da politica efetiva realiza: o escalonamento_ignorado de validarPlanoGlobal vira lacuna, pelo criterio de validarSequencia`,
            evidencias: ignorado.map(e => e.mensagem)
        }]
    };
}

function etapaDe(etapa: NomeEtapaSemantica, validador: string, r: ResultadoValidacao): EtapaSemantica {
    return { etapa, validador, veredito: r.veredito, erros: r.erros, avisos: r.avisos, dadosFaltantes: r.dadosFaltantes };
}

function naoAvaliada(etapa: NomeEtapaSemantica, validador: string, motivo: string): EtapaSemantica {
    return { etapa, validador, veredito: 'NOT_EVALUATED', erros: [], avisos: [], dadosFaltantes: [], motivo };
}

const VALIDADOR_GHAT = '/verify (L(Ĝ) da politica efetiva)';
const VALIDADOR_PIS = 'decomporPIs + validarPI';

/**
 * A semântica determinística do plano. A ENTRADA é o AST (no vocabulário do
 * contrato) — não há parâmetro de texto. As etapas são as da geração
 * multiagente, na ordem dela, cada uma com o validador oficial, sem critério
 * novo. Todas rodam (o diagnóstico completo), exceto:
 *
 *   - a dos PIs, que só existe sobre uma sequência VALID (`decomporPIs` a exige);
 *   - tudo menos a sequência, quando o conhecimento não tem base
 *     (`semBaseSemantica`): a geração para aí com UNRESOLVED, e L(Ĝ) nem existe
 *     (o motor recusa gerar Ĝ sem item) — `gramaticaDaPolitica` vem ausente.
 *
 * Veredito: INVALID se alguma etapa reprova; senão UNRESOLVED se alguma não
 * decide por falta de dado; senão VALID. Nunca UNRESOLVED -> INVALID.
 *
 * `decomporPIs` recusando uma sequência que `validarSequencia` aceitou é defeito
 * do avaliador, não do plano: sobe como `DefeitoAvaliacao`.
 */
export function validarSemantica(
    artefato: ArtefatoLido,
    k: ConhecimentoGlobal,
    gramaticaDaPolitica: VerificacaoGramatical | undefined,
    sequencia?: readonly PIPlanejado[]
): ValidacaoSemantica {
    const { plano, sequenciaInformada, sequenciaDivergente } = planoDoArtefato(artefato, k.contrato, sequencia);
    const semBase = semBaseSemantica(k);
    const etapas: EtapaSemantica[] = [];

    // 1. L(Ĝ): a politica efetiva escrita como gramatica (ciclo-global.ts, antes da validacao global).
    if (semBase) {
        etapas.push(naoAvaliada('gramatica_da_politica', VALIDADOR_GHAT, `sem base de conhecimento (${semBase}): o motor nao gera Ĝ sem item`));
    } else if (!gramaticaDaPolitica) {
        throw new DefeitoAvaliacao('validarSemantica sem o veredito de L(Ĝ), e o conhecimento tem base para ele');
    } else {
        etapas.push(
            gramaticaDaPolitica.valido
                ? { etapa: 'gramatica_da_politica', validador: VALIDADOR_GHAT, veredito: 'VALID', erros: [], avisos: [], dadosFaltantes: [] }
                : {
                      etapa: 'gramatica_da_politica', validador: VALIDADOR_GHAT, veredito: 'INVALID', avisos: [], dadosFaltantes: [],
                      erros: [{ codigo: 'fora_da_gramatica_da_politica', mensagem: `o plano nao pertence a L(Ĝ) da politica efetiva: ${(gramaticaDaPolitica.erro ?? 'sem detalhe').split('\n')[0]}` }]
                  }
        );
    }

    // 2. A sequencia (item, conduta), como o Planner a teria proposto.
    const seq = validarSequencia(plano.pis, { contrato: k.contrato, politica: k.politica, regras: k.regras, pedido: k.pedido });
    const etapaSeq = etapaDe('sequencia', 'validarSequencia', seq);
    if (sequenciaDivergente) {
        etapaSeq.avisos = [...etapaSeq.avisos, {
            codigo: 'sequencia_nao_corresponde',
            mensagem: 'o registro traz uma sequencia do Planner que nao corresponde as clausulas do AST (tamanho, ordem ou item): ela nao foi usada, e as dependencias nao foram conferidas'
        }];
    }
    etapas.push(etapaSeq);

    // 3. Cada PI contra o contexto dele, como cada PI Agent foi validado.
    if (semBase) {
        etapas.push(naoAvaliada('pis', VALIDADOR_PIS, `sem base de conhecimento (${semBase})`));
    } else if (seq.veredito === 'VALID') {
        let contextos;
        try {
            contextos = decomporPIs(seq.valor!, k);
        } catch (erro) {
            throw new DefeitoAvaliacao(`decomporPIs recusou a sequencia que validarSequencia aceitou: ${(erro as Error).message}`);
        }
        etapas.push(etapaDe('pis', VALIDADOR_PIS, combinar(contextos.map((c, i) => validarPI(plano.resultados[i], c)))));
    } else {
        etapas.push(naoAvaliada('pis', VALIDADOR_PIS, `decomporPIs exige uma sequencia VALID, e a sequencia saiu ${seq.veredito}`));
    }

    // 4. O plano inteiro: contrato, relacoes, telemetria, dependencias, pedido.
    if (semBase) {
        etapas.push(naoAvaliada('global', 'validarPlanoGlobal', `sem base de conhecimento (${semBase}): cada clausula seria item_fora_da_poda por falta de conhecimento, nao por prova`));
    } else {
        const etapaGlobal = reconciliarObrigatoriasIrrealizaveis(etapaDe('global', 'validarPlanoGlobal', validarPlanoGlobal(plano, k)), k.contrato);
        if (!sequenciaInformada && plano.pis.length > 1) {
            etapaGlobal.avisos = [...etapaGlobal.avisos, {
                codigo: 'dependencias_nao_informadas',
                mensagem: 'a DSL do artefato nao escreve dependeDe e o registro nao traz a sequencia do Planner: as dependencias entre PIs nao foram conferidas, e os PIs foram julgados sem as relacoes que o Planner declarou'
            }];
        }
        etapas.push(etapaGlobal);
    }

    const avaliadas = etapas.filter(e => e.veredito !== 'NOT_EVALUATED');
    const veredito: Veredito = avaliadas.some(e => e.veredito === 'INVALID')
        ? 'INVALID'
        : avaliadas.some(e => e.veredito === 'UNRESOLVED') ? 'UNRESOLVED' : 'VALID';

    // O que o conhecimento so tem como texto — a fronteira de validacao-global.ts.
    const vista = vistaDoCenario(k.dominio, k.restricoes);
    const itens = new Set(artefato.clausulas.map(c => c.item));
    const naoFormalizado = [
        ...vista.regrasGlobais.map(r => `regra_global [${r.severidade}]: ${r.descricao}`),
        ...vista.relacionais
            .filter(r => partesDaRelacao(r).estruturado.itens.some(i => itens.has(i)))
            .map(r => {
                const { texto: t } = partesDaRelacao(r);
                return `relacional ${r.entre} (so o par e a gravidade sao conferidos): ${t.mecanismo}${t.conduta ? `; ${t.conduta}` : ''}`;
            })
    ];

    return {
        veredito,
        erros: etapas.flatMap(e => e.erros.map(p => ({ ...p, etapa: e.etapa }))),
        avisos: etapas.flatMap(e => e.avisos.map(p => ({ ...p, etapa: e.etapa }))),
        dadosFaltantes: veredito === 'UNRESOLVED' ? [...new Set(avaliadas.flatMap(e => e.dadosFaltantes))] : [],
        etapas,
        naoFormalizado
    };
}

/** A semântica que não roda porque a sintaxe não deixou AST. */
function semanticaNaoAvaliada(motivo: string): ValidacaoSemantica {
    return { veredito: 'NOT_EVALUATED', erros: [], avisos: [], dadosFaltantes: [], etapas: [], naoFormalizado: [], motivo };
}

/** O oráculo: sintaxe INVALID decide sozinha; senão, vale a semântica. */
export function oraculoDe(sintaxe: ValidacaoSintatica, semantica: ValidacaoSemantica): Oraculo {
    if (sintaxe.veredito === 'INVALID' || semantica.veredito === 'NOT_EVALUATED') return { veredito: 'INVALID', origem: 'sintaxe' };
    return { veredito: semantica.veredito, origem: 'semantica' };
}

const PELO_ORACULO: Record<Veredito, ClassificacaoAvaliacao> = {
    VALID: 'VALIDO_PELO_ORACULO',
    INVALID: 'INVALIDO_PELO_ORACULO',
    UNRESOLVED: 'UNRESOLVIDO_PELO_ORACULO'
};

const ehVeredito = (s: StatusJuiz): s is Veredito => s === 'VALID' || s === 'INVALID' || s === 'UNRESOLVED';

/**
 * Compara o oráculo com o juiz. Mesmo veredito: concordantes, e a
 * classificação é a do oráculo. Qualquer outra combinação é discordância:
 * `DISCORDANCIA_LLM` — o oráculo continua o mesmo (INVALID, VALID ou
 * UNRESOLVED), e o juiz fica registrado ao lado. Sem veredito do juiz
 * (NOT_CALLED, NO_RESPONSE), vale o oráculo e `concordancia` fica ausente.
 */
export function compararAvaliacoes(
    oraculo: Pick<Oraculo, 'veredito'>,
    juiz: Pick<JulgamentoLLM, 'status'>
): Pick<ResultadoAvaliacaoPlano, 'concordancia' | 'classificacao'> {
    if (!ehVeredito(juiz.status)) return { classificacao: PELO_ORACULO[oraculo.veredito] };
    const concordancia = oraculo.veredito === juiz.status;
    return { concordancia, classificacao: concordancia ? PELO_ORACULO[oraculo.veredito] : 'DISCORDANCIA_LLM' };
}

// =============================================================================
// Juiz LLM
// =============================================================================

/** O que o juiz lê: cada seção do prompt de `/validar-plano`, já em texto. */
export interface PedidoJuiz {
    plano: string;
    /** PEDIDO. */
    pedido: string;
    /** TELEMETRIA: uma medida por linha. */
    telemetria: string;
    /** CENÁRIO, REGRAS e POLÍTICA: o Prompt Semântico da geração, com a política efetiva. */
    conhecimento: string;
    /** EVIDÊNCIAS: regras avaliadas pelo Cypher e condições observadas pela recuperação. */
    evidencias: string;
}

export type JuizLLM = (pedido: PedidoJuiz, sinal: AbortSignal) => Promise<RespostaJuizLLM>;

/**
 * O contexto completo do juiz, tirado da MESMA recuperação que a semântica usa
 * — os dois julgam o mesmo conhecimento. Nada das camadas determinísticas
 * entra: nem sintaxe, nem AST, nem semântica, nem oráculo. O plano vai como
 * texto, o mesmo texto que o parser reconheceu.
 */
export function pedidoDoJuiz(
    dominio: Dominio,
    plano: string,
    pedido: string,
    telemetria: Record<string, number>,
    conhecimento: ConhecimentoRecuperado<unknown>
): PedidoJuiz {
    const medidas = Object.entries(telemetria).map(([p, v]) => `- ${p} = ${v}`);

    const vista = vistaDoCenario(dominio, conhecimento.constraints);
    const observadas = [
        ...Object.entries(vista.fatosPorItem).flatMap(([item, fatos]) =>
            fatos.filter(f => f.condicoes.length > 0).map(f => `- ${item} [${f.tipo}]: ${f.descricao} (observado: ${f.condicoes.join('; ')})`)
        ),
        ...vista.escalonamentos
            .filter(e => e.condicoes.length > 0)
            .map(e => `- escalonamento ${e.descricao} (observado: ${e.condicoes.join('; ')})`)
    ];
    const regras = conhecimento.auditoriaRecuperacao.validacao.map(r => `- ${explicarRegra(r)}`);
    const evidencias = [...regras, ...observadas];

    return {
        plano,
        pedido,
        telemetria: medidas.join('\n') || '(nenhuma medida no cenario)',
        conhecimento: conhecimento.promptSemantico,
        evidencias: evidencias.join('\n') || '(nenhuma condicao observada alem do conhecimento recuperado)'
    };
}

/** Resposta de `/validar-plano` (ver python_engine/julgamento.py `ler_julgamento`). */
interface RespostaJuizHttp {
    veredito: Veredito;
    justificativa: string;
    evidencias?: string[];
    resposta_bruta?: string;
}

/** O juiz real: `POST /validar-plano` no motor do domínio. `sinal` cancela o julgamento em andamento. */
export function juizLLMHttp(motor: string, timeoutMs: number): JuizLLM {
    return async (pedido, sinal) => {
        const timeout = AbortSignal.timeout(timeoutMs);
        const combinado = new AbortController();
        const abortar = (): void => combinado.abort();
        timeout.addEventListener('abort', abortar);
        sinal.addEventListener('abort', abortar);

        let response: Response;
        try {
            response = await fetch(`${motor}/validar-plano`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    plano: pedido.plano,
                    intencao: pedido.pedido,
                    telemetria: pedido.telemetria,
                    contexto_neo4j: pedido.conhecimento,
                    evidencias: pedido.evidencias
                }),
                signal: combinado.signal
            });
        } catch (error) {
            if (sinal.aborted) throw error;
            const causa = timeout.aborted ? `sem resposta em ${timeoutMs / 1000}s` : (error as Error).message;
            throw new Error(`motor (${motor}) inacessivel: ${causa}`);
        } finally {
            timeout.removeEventListener('abort', abortar);
            sinal.removeEventListener('abort', abortar);
        }
        if (!response.ok) {
            throw new Error(`motor respondeu ${response.status}: ${await response.text()}`);
        }
        const r = (await response.json()) as RespostaJuizHttp;
        return { veredito: r.veredito, justificativa: r.justificativa, evidencias: r.evidencias, respostaBruta: r.resposta_bruta };
    };
}

// =============================================================================
// Uma linha: sintaxe -> AST -> semântica -> oráculo -> juiz -> comparação
// =============================================================================

/** Como montar a entrada da geração do domínio — `montarEntradaGeracao*`. */
export type MontarEntrada<M, C, R> = (
    contexto: C,
    constraints: R,
    modelo: M,
    politica: SubgrafoPodado,
    conhecimento: ConhecimentoRecuperado<R>
) => OpcoesDecodificacao;

export interface EntradaAvaliacao<M, C extends ContextoDominio, R, F> {
    adaptador: AdaptadorRecuperacao<M, C, R, F>;
    modelo: M;
    /** O parser oficial da DSL do domínio (avaliar-sintaxe.ts). */
    analisador: AnalisadorDsl;
    /** O cenário reconstruído do registro, com `intencao`. */
    contexto: C;
    montarEntrada: MontarEntrada<M, C, R>;
}

export interface DependenciasAvaliacao {
    abrirSessao: () => Session;
    /** G: `/verify` sem política (`verificadorDaDsl`). */
    verificadorDsl: VerificadorDaDsl;
    /** L(Ĝ): `/verify` com a política efetiva (`verificadorGramaticaHttp`). */
    verificador: VerificadorGramatical;
    juiz: JuizLLM;
    sinal: AbortSignal;
    /**
     * Julgar também o texto que não pertence à DSL — só com razão experimental
     * explícita (SPC_CML_AVALIAR_JULGAR_SINTAXE_INVALIDA). Artefato vazio nunca
     * é julgado.
     */
    julgarSintaxeInvalida?: boolean;
}

/** Linha que não pôde ser avaliada por falha técnica: sem nenhum veredito. */
export function detalheNaoAvaliado(registro: RegistroAvaliarGrafo, motivo: string): DetalheLado {
    return {
        plano: textoGerado(registro as RegistroAvaliar),
        sujeito: identificadorRegistro(registro) ?? undefined,
        naoAvaliado: true,
        motivo
    };
}

/** Duração, em ms com 2 casas, desde um `performance.now()` (relógio monotônico). */
const duracaoMs = (inicio: number): number => Math.round((performance.now() - inicio) * 100) / 100;

/**
 * Avalia UM plano:
 *
 *     texto -> SINTAXE (G + parser -> AST)
 *              INVALID -> oráculo INVALID (origem: sintaxe); semântica NOT_EVALUATED;
 *                         juiz NOT_CALLED (salvo `julgarSintaxeInvalida`; vazio, nunca)
 *              VALID   -> recuperação da geração (recuperarConhecimento + montarEntradaGeracao*)
 *                         -> em PARALELO, sobre o mesmo AST e o mesmo conhecimento:
 *                              SEMÂNTICA (L(Ĝ), sequência, PIs, global) -> ORÁCULO
 *                              JUIZ LLM
 *                         -> comparação, só depois dos dois
 *
 * Oráculo e juiz são independentes: nenhum lê o resultado do outro, e nenhum espera
 * o outro (o juiz continua sem ver sintaxe, AST, semântica ou oráculo — ver
 * `pedidoDoJuiz`). O oráculo continua normativo; o juiz, experimental.
 *
 * O conhecimento global tem os MESMOS campos que `decodificarMultiagente`
 * (decodificacao.ts) monta para a geração; a avaliação não tem conhecimento
 * próprio. Falha técnica (grafo, motor, parser que lança, defeito interno)
 * torna a linha `naoAvaliado`; falha do juiz não — as camadas determinísticas
 * valem sozinhas e o juiz fica NO_RESPONSE. Uma falha NUNCA apaga o resultado da
 * outra: se a semântica falha, o julgamento do juiz (já em curso) é preservado na
 * linha `naoAvaliado`; se o juiz falha, o oráculo vale. Cancelamento (`sinal`) propaga.
 */
export async function avaliarPlano<M, C extends ContextoDominio, R, F>(
    registro: RegistroAvaliarGrafo,
    entrada: EntradaAvaliacao<M, C, R, F>,
    deps: DependenciasAvaliacao
): Promise<DetalheLado> {
    const { adaptador, modelo, contexto } = entrada;
    const inicioTotal = performance.now();
    const plano = textoGerado(registro as RegistroAvaliar);
    const pedido = contexto.intencao ?? '';
    const sujeito = identificadorRegistro(registro) ?? undefined;

    // 1. Sintaxe: G + parser -> AST. Sempre antes de tudo.
    const inicioSintaxe = performance.now();
    let sintatica: ResultadoSintaxe;
    try {
        sintatica = await validarSintaxePlano(plano, entrada.analisador, deps.verificadorDsl);
    } catch (error) {
        const peca = error instanceof FalhaSintaxe ? '' : ' (erro inesperado)';
        return detalheNaoAvaliado(registro, `Falha tecnica na validacao sintatica${peca} — ${(error as Error).message}`);
    }
    const sintaxeMs = duracaoMs(inicioSintaxe);
    const { sintaxe: validacaoSintatica, ast } = sintatica;
    const vazio = plano.trim().length === 0;
    const julgar = !vazio && (!!ast || deps.julgarSintaxeInvalida === true);
    const semAst = 'a sintaxe saiu INVALID: sem AST, nao ha o que validar semanticamente';

    if (!ast && !julgar) {
        const validacaoSemantica = semanticaNaoAvaliada(semAst);
        const oraculo = oraculoDe(validacaoSintatica, validacaoSemantica);
        const julgamentoLLM: JulgamentoLLM = {
            status: 'NOT_CALLED',
            motivo: vazio ? 'artefato vazio: nao ha plano a julgar' : 'sintaxe INVALID: o texto nao pertence a DSL, e o juiz so julga o que o parser reconheceu'
        };
        return {
            plano, sujeito, naoAvaliado: false,
            validacaoSintatica, validacaoSemantica, oraculo, julgamentoLLM,
            tempos: { sintaxeMs, oraculoMs: null, llmJudgeMs: null, totalMs: duracaoMs(inicioTotal) },
            ...compararAvaliacoes(oraculo, julgamentoLLM)
        };
    }

    // 2. A recuperacao da geracao, para a semantica e para o juiz (dependencia compartilhada, antes da bifurcacao).
    const inicioRecuperacao = performance.now();
    let conhecimento: ConhecimentoRecuperado<R>;
    let k: ConhecimentoGlobal;
    let proibidos: Set<string>;
    try {
        conhecimento = await recuperarConhecimento(adaptador, modelo, contexto, pedido, async () => {}, deps.abrirSessao);
        const opts = entrada.montarEntrada(contexto, conhecimento.constraints, modelo, conhecimento.politicaEfetiva, conhecimento);
        k = {
            requestId: conhecimento.auditoriaRecuperacao.id,
            dominio: adaptador.dominio,
            pedido: opts.comando,
            telemetria: contexto.telemetria,
            contrato: opts.contrato,
            politica: conhecimento.politicaEfetiva,
            regras: conhecimento.auditoriaRecuperacao.validacao,
            restricoes: conhecimento.constraints,
            esquema: opts.execucao?.esquema
        };
        proibidos = itensProibidos(adaptador.dominio, adaptador.recuperar(modelo, contexto));
    } catch (error) {
        return detalheNaoAvaliado(registro, `Falha ao reconstruir o conhecimento do cenario: ${(error as Error).message}`);
    }
    const recuperacaoMs = duracaoMs(inicioRecuperacao);

    // 3a. Semantica, sobre o AST GUARDADO: o objeto que vai para o resultado e o que ela le.
    //     Nao toca no juiz. Falha tecnica volta como `falha`; so o inesperado rejeita.
    interface DesfechoSemantica { validacaoSemantica?: ValidacaoSemantica; violacao?: boolean; falha?: string; ms: number | null }
    const executarSemantica = async (): Promise<DesfechoSemantica> => {
        if (!ast) return { validacaoSemantica: semanticaNaoAvaliada(semAst), ms: null };
        const inicio = performance.now();
        let gramaticaDaPolitica: VerificacaoGramatical | undefined;
        if (!semBaseSemantica(k)) {
            try {
                gramaticaDaPolitica = await deps.verificador(plano, conhecimento.politicaEfetiva);
            } catch (error) {
                return { falha: `Falha na verificacao de L(Ĝ) (/verify com a politica): ${(error as Error).message}`, ms: duracaoMs(inicio) };
            }
        }
        let validacaoSemantica: ValidacaoSemantica;
        let violacao: boolean | undefined;
        try {
            const artefato = projetarAst(adaptador.dominio, ast);
            validacaoSemantica = validarSemantica(artefato, k, gramaticaDaPolitica, registro.execucaoMultiagente?.sequenciaValidada);
            violacao = violacaoNoArtefato(artefato, proibidos);
        } catch (error) {
            if (!(error instanceof DefeitoAvaliacao)) throw error;
            return { falha: `Defeito interno do avaliador: ${error.message}`, ms: duracaoMs(inicio) };
        }
        if (conhecimento.focoIndisponivel) {
            validacaoSemantica.avisos.push({
                etapa: 'conhecimento', codigo: 'foco_indisponivel',
                mensagem: `o foco por embedding falhou na reconstrucao (${conhecimento.focoIndisponivel}); a politica e a do grafo completo`
            });
        }
        if (registro.promptSemantico !== undefined && registro.promptSemantico !== conhecimento.promptSemantico) {
            validacaoSemantica.avisos.push({
                etapa: 'conhecimento', codigo: 'contexto_divergente',
                mensagem: 'o Prompt Semantico reconstruido difere do gravado na geracao (grafo, foco ou modo de recuperacao mudaram)'
            });
        }
        return { validacaoSemantica, violacao, ms: duracaoMs(inicio) };
    };

    // 3b. Juiz, independente: le o contexto e o plano, nada das camadas deterministicas.
    //     Falha do juiz vira NO_RESPONSE aqui dentro; so o cancelamento rejeita.
    const executarJuiz = async (): Promise<{ julgamentoLLM: JulgamentoLLM; ms: number }> => {
        const inicio = performance.now();
        try {
            const r = await deps.juiz(pedidoDoJuiz(adaptador.dominio, plano, pedido, contexto.telemetria, conhecimento), deps.sinal);
            return { julgamentoLLM: { status: r.veredito, justificativa: r.justificativa, evidencias: r.evidencias, respostaBruta: r.respostaBruta }, ms: duracaoMs(inicio) };
        } catch (error) {
            if (deps.sinal.aborted) throw error;
            return { julgamentoLLM: { status: 'NO_RESPONSE', motivo: `Falha ao julgar com o modelo local: ${(error as Error).message}` }, ms: duracaoMs(inicio) };
        }
    };

    // 4. As duas, iniciadas antes de aguardar qualquer uma; `allSettled` para que uma falha nao apague a outra.
    const inicioParalelo = performance.now();
    const [semantica, juiz] = await Promise.allSettled([executarSemantica(), executarJuiz()]);
    const paraleloMs = duracaoMs(inicioParalelo);

    if (juiz.status === 'rejected') throw juiz.reason; // so o cancelamento chega aqui
    const { julgamentoLLM, ms: llmJudgeMs } = juiz.value;
    const tempos = (oraculoMs: number | null): TemposPlano => ({ sintaxeMs, recuperacaoMs, oraculoMs, llmJudgeMs, paraleloMs, totalMs: duracaoMs(inicioTotal) });

    if (semantica.status === 'rejected') {
        if (deps.sinal.aborted) throw semantica.reason;
        const erro = semantica.reason instanceof Error ? semantica.reason.message : String(semantica.reason);
        return { ...detalheNaoAvaliado(registro, `Erro inesperado na validacao semantica: ${erro}`), julgamentoLLM, tempos: tempos(null) };
    }
    if (semantica.value.falha !== undefined) {
        return { ...detalheNaoAvaliado(registro, semantica.value.falha), julgamentoLLM, tempos: tempos(semantica.value.ms) };
    }
    const { validacaoSemantica, violacao, ms: oraculoMs } = semantica.value;

    // 5. Oraculo (funcao pura da sintaxe e da semantica) e comparacao, so com os dois resultados em maos.
    const oraculo = oraculoDe(validacaoSintatica, validacaoSemantica!);

    return {
        plano,
        sujeito,
        ...(violacao !== undefined ? { violacao } : {}),
        contextoGrafo: conhecimento.promptSemantico,
        naoAvaliado: false,
        validacaoSintatica,
        ...(ast ? { ast } : {}),
        validacaoSemantica: validacaoSemantica!,
        oraculo,
        julgamentoLLM,
        tempos: tempos(oraculoMs),
        ...compararAvaliacoes(oraculo, julgamentoLLM)
    };
}

// =============================================================================
// Agregação e registro experimental
// =============================================================================

const contagemVazia = (): ContagemVereditos => ({ VALID: 0, INVALID: 0, UNRESOLVED: 0 });

export function agregarMetricas(lados: DetalheLado[]): Metricas {
    const avaliados = lados.filter(l => !l.naoAvaliado && l.oraculo);
    const m: Metricas = {
        total: avaliados.length,
        sintaxe: { VALID: 0, INVALID: 0 },
        semantica: { ...contagemVazia(), NOT_EVALUATED: 0 },
        oraculo: contagemVazia(),
        juiz: { ...contagemVazia(), NOT_CALLED: 0, NO_RESPONSE: 0 },
        concordantes: 0,
        discordantes: 0,
        pares: {},
        violacoes: avaliados.filter(l => l.violacao === true).length
    };
    for (const l of avaliados) {
        m.sintaxe[l.validacaoSintatica!.veredito]++;
        m.semantica[l.validacaoSemantica!.veredito]++;
        m.oraculo[l.oraculo!.veredito]++;
        m.juiz[l.julgamentoLLM!.status]++;
        if (l.concordancia === undefined) continue;
        if (l.concordancia) m.concordantes++;
        else m.discordantes++;
        const par = `${l.oraculo!.veredito}+${l.julgamentoLLM!.status}`;
        m.pares[par] = (m.pares[par] ?? 0) + 1;
    }
    return m;
}

/** Uma linha do JSONL experimental: um plano avaliado, com cada camada separada. */
export interface RegistroAvaliacaoJsonl extends Partial<ResultadoAvaliacaoPlano> {
    dominio: Dominio;
    lado: 'arquitetura' | 'baseline';
    linha: number;
    intencao: string;
    sujeito?: string;
    plano: string;
    violacao?: boolean;
    naoAvaliado: boolean;
    motivo?: string;
    /** Tempos (s) da avaliação inteira — repetidos em todos os registros do arquivo. */
    tempoTotalSegundos?: number;
    tempoSintaxeSegundos?: number;
    tempoOraculoSegundos?: number;
    tempoLlmJudgeSegundos?: number;
    /** Tempos (s) da GERAÇÃO de todos os cenários avaliados — repetidos em todos os registros do arquivo. */
    tempoGeracaoTotalSegundos?: number;
    tempoGeracaoSequenciasSegundos?: number;
    tempoGeracaoPIsValidasSegundos?: number;
    tempoGeracaoValidacaoPlanosSegundos?: number;
}

/** O resultado da avaliação no formato do JSONL experimental — um registro por plano avaliado. */
export function registrosJsonl(dominio: Dominio, resultado: ResultadoAvaliacaoGrafo): RegistroAvaliacaoJsonl[] {
    return resultado.linhas.flatMap(l =>
        (['arquitetura', 'baseline'] as const)
            .filter(lado => l[lado])
            .map(lado => {
                const { contextoGrafo, ...detalhe } = l[lado]!;
                return {
                    dominio, lado, linha: l.linha, intencao: l.intencao, ...detalhe,
                    ...(resultado.tempoTotalSegundos !== undefined && { tempoTotalSegundos: resultado.tempoTotalSegundos }),
                    ...(resultado.tempoSintaxeSegundos !== undefined && { tempoSintaxeSegundos: resultado.tempoSintaxeSegundos }),
                    ...(resultado.tempoOraculoSegundos !== undefined && { tempoOraculoSegundos: resultado.tempoOraculoSegundos }),
                    ...(resultado.tempoLlmJudgeSegundos !== undefined && { tempoLlmJudgeSegundos: resultado.tempoLlmJudgeSegundos }),
                    ...(resultado.tempoGeracaoTotalSegundos !== undefined && { tempoGeracaoTotalSegundos: resultado.tempoGeracaoTotalSegundos }),
                    ...(resultado.tempoGeracaoSequenciasSegundos !== undefined && { tempoGeracaoSequenciasSegundos: resultado.tempoGeracaoSequenciasSegundos }),
                    ...(resultado.tempoGeracaoPIsValidasSegundos !== undefined && { tempoGeracaoPIsValidasSegundos: resultado.tempoGeracaoPIsValidasSegundos }),
                    ...(resultado.tempoGeracaoValidacaoPlanosSegundos !== undefined && { tempoGeracaoValidacaoPlanosSegundos: resultado.tempoGeracaoValidacaoPlanosSegundos })
                };
            })
    );
}

// ---------------------------------------------------------------------------
// Pareamento arquitetura × baseline — só para alinhar linhas na tabela lado a
// lado (cada lado já foi julgado independentemente contra o SEU PRÓPRIO
// cenário; isto não influencia nenhum veredicto). Mesma cadeia de chaves de
// avaliar.ts::parear (id+assinatura da telemetria -> id -> enunciado), mas
// simétrica: nenhum dos dois arrays é uma lista canônica.
// ---------------------------------------------------------------------------

function assinaturaTelemetria(r: RegistroAvaliarGrafo): string | null {
    const sinais = r.telemetria?.telemetria;
    if (!sinais || typeof sinais !== 'object') return null;
    const partes = Object.entries(sinais)
        .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
        .map(([k, v]) => `${k}=${Number(v)}`)
        .sort();
    return partes.length > 0 ? partes.join('|') : null;
}

function chaveTexto(texto: string | undefined): string {
    return (texto ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

type Nivel = { chave: (r: RegistroAvaliarGrafo) => string | null };

const NIVEIS: Nivel[] = [
    { chave: r => { const id = identificadorRegistro(r); const t = assinaturaTelemetria(r); return id && t ? `${id}##${t}` : null; } },
    { chave: r => identificadorRegistro(r) },
    { chave: r => (r.intencao ? chaveTexto(r.intencao) : null) }
];

export interface ParDeRegistros {
    ordem: number;
    intencao: string;
    a?: RegistroAvaliarGrafo;
    b?: RegistroAvaliarGrafo;
}

/** Une `a` (arquitetura) e `b` (baseline) por cenário. Registros presentes só
 *  de um lado continuam aparecendo (com o outro lado ausente) — é a UNIÃO dos
 *  dois arquivos, não a interseção. */
export function parearRegistros(a: RegistroAvaliarGrafo[], b: RegistroAvaliarGrafo[]): ParDeRegistros[] {
    const indicesA = NIVEIS.map(nivel => {
        const mapa = new Map<string, RegistroAvaliarGrafo[]>();
        for (const r of a) {
            const k = nivel.chave(r);
            if (!k) continue;
            if (!mapa.has(k)) mapa.set(k, []);
            mapa.get(k)!.push(r);
        }
        return mapa;
    });

    const usados = new Set<RegistroAvaliarGrafo>();
    const pares: ParDeRegistros[] = [];
    let pendentes = b;

    for (const [i, nivel] of NIVEIS.entries()) {
        const sobraram: RegistroAvaliarGrafo[] = [];
        for (const registroB of pendentes) {
            const k = nivel.chave(registroB);
            const registroA = k ? indicesA[i].get(k)?.find(c => !usados.has(c)) : undefined;
            if (registroA) {
                usados.add(registroA);
                pares.push({ ordem: a.indexOf(registroA), intencao: registroA.intencao ?? registroB.intencao ?? '', a: registroA, b: registroB });
            } else {
                sobraram.push(registroB);
            }
        }
        pendentes = sobraram;
        if (pendentes.length === 0) break;
    }

    for (const registroA of a) {
        if (!usados.has(registroA)) pares.push({ ordem: a.indexOf(registroA), intencao: registroA.intencao ?? '', a: registroA });
    }
    for (const registroB of pendentes) {
        pares.push({ ordem: a.length + b.indexOf(registroB), intencao: registroB.intencao ?? '', b: registroB });
    }

    pares.sort((x, y) => x.ordem - y.ordem);
    return pares;
}

/** A linha da tabela: os dois lados de um cenário e os atalhos dos filtros da UI. */
export function montarLinha(linha: number, intencao: string, arquitetura?: DetalheLado, baseline?: DetalheLado): DetalheLinha {
    const reprovado = (d?: DetalheLado): boolean => !!d && !d.naoAvaliado && (d.oraculo?.veredito !== 'VALID' || d.violacao === true);
    const discordou = (d?: DetalheLado): boolean => d?.concordancia === false;
    return {
        linha,
        intencao,
        arquitetura,
        baseline,
        temDivergencia: reprovado(arquitetura) || reprovado(baseline),
        temDiscordancia: discordou(arquitetura) || discordou(baseline)
    };
}
