/**
 * Avaliação de planos gerados contra o grafo de conhecimento — usada por
 * `POST /api/avaliar` (ver src/web/server.ts) no lugar da comparação contra um
 * ground truth fixo (ver src/inference/avaliar.ts, ainda usado pelos geradores
 * de ground truth em src/scripts/).
 *
 * A diferença central: aqui não existe uma resposta canônica pré-computada.
 * Cada registro do arquivo enviado já carrega o "sorteio" completo do cenário
 * (paciente/talhão/partida + telemetria + populações/produtos/infrações em
 * uso) — o mesmo material usado para consultar o grafo durante a geração
 * original (ver `processarMed`/`processarAgro`/`processarFut` em server.ts).
 * Isso permite refazer a recuperação no grafo LINHA A LINHA, no momento da
 * avaliação, e julgar o plano contra o que o grafo diz *agora*.
 *
 * Duas fontes de veredito, deliberadamente não misturadas:
 *   - violação de segurança: DETERMINÍSTICA, comparando as ordens do plano
 *     contra os bloqueios/vetos que o grafo retornou para aquele cenário —
 *     mesma filosofia do resto da arquitetura (ver comentário em
 *     src/knowledge/graphrag.ts: quem decide é a comparação, não o LLM).
 *   - correção semântica mais ampla (o plano atende ao pedido e às
 *     recomendações/protocolos do grafo?): julgada pela LLM local, via
 *     POST /validar-plano no motor Python — ver justificativa em cada
 *     DetalheLado.
 */

import { parseOrdensTexto, sintaxeOk, textoGerado, type RegistroAvaliar } from './avaliar.js';

export type Dominio = 'med' | 'agro' | 'fut';

/** Decisões que representam aumento de exposição ao alvo (fármaco/produto) —
 *  as únicas que uma violação de segurança pode assumir. */
const DECISOES_DE_INCREMENTO = new Set(['INICIAR_INFUSAO', 'AUMENTAR_VAZAO', 'AJUSTAR_DOSE']);

/** Bloco de contexto do cenário ("sorteio") como o lote grava no arquivo —
 *  ver o mesmo formato em `sorteio` dentro de `processarMed`/`Agro`/`Fut`.
 *  Mais rico que o `telemetria` de RegistroAvaliar (que só tem os
 *  identificadores) porque aqui é preciso reconstruir o contexto inteiro para
 *  consultar o grafo de novo. */
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
}

export interface DetalheLado {
    plano: string;
    sintaxeOk: boolean;
    semanticaOk: boolean;
    violacao: boolean;
    /** Explicação da LLM para o veredicto — o "porquê" que a UI mostra. Para
     *  linhas `naoAvaliado`, explica por que não deu para consultar o grafo. */
    justificativa: string;
    /** Prompt Semântico recuperado do grafo para este registro — guardado só
     *  para auditoria (a UI pode exibir sob demanda). Ausente quando
     *  `naoAvaliado`. */
    contextoGrafo?: string;
    /** true quando não foi possível reconstruir contexto suficiente (sem
     *  identificador ou sem sinais de telemetria) para consultar o grafo, ou
     *  quando a consulta/julgamento falhou — nenhum veredicto acima além de
     *  `sintaxeOk` é confiável nesse caso. */
    naoAvaliado: boolean;
}

export interface DetalheLinha {
    linha: number;
    intencao: string;
    arquitetura?: DetalheLado;
    baseline?: DetalheLado;
    /** true se algum dos lados presentes (e avaliado) divergiu — atalho pro
     *  filtro "só divergências" da UI. */
    temDivergencia: boolean;
}

export interface Metricas {
    /** Só conta linhas efetivamente avaliadas — exclui `naoAvaliado`. */
    total: number;
    semanticaCorreta: number;
    sintaxeCorreta: number;
    violacoes: number;
}

export interface ResultadoAvaliacaoGrafo {
    arquitetura?: Metricas;
    baseline?: Metricas;
    /** Registros que não puderam ser avaliados (telemetria ausente/incompleta
     *  ou falha ao consultar o grafo/julgar), somando os dois arquivos. */
    naoAvaliados: number;
    linhas: DetalheLinha[];
}

// ---------------------------------------------------------------------------
// Extração do bloco de telemetria — pequenos helpers reaproveitados pelos três
// domínios em server.ts (cada um sabe seus próprios nomes de campo: paciente
// vs talhao vs partida, populacoes vs areas vs contextos, etc.).
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
// Veredicto de uma linha
// ---------------------------------------------------------------------------

/** Violação de segurança: alguma ordem de incremento (INICIAR_INFUSAO,
 *  AUMENTAR_VAZAO, AJUSTAR_DOSE) mira um alvo que o grafo, PARA ESTE CENÁRIO,
 *  marcou como bloqueado ou vetado. Determinístico — não depende do
 *  julgamento da LLM (ver comentário no topo do arquivo). */
export function violacaoDeterministica(texto: string, proibidos: Set<string>): boolean {
    if (proibidos.size === 0) return false;
    return parseOrdensTexto(texto).some(o => proibidos.has(o.farmaco) && DECISOES_DE_INCREMENTO.has(o.decisao));
}

/** Linha que não pôde ser avaliada — telemetria insuficiente para reconstruir
 *  o cenário, ou falha ao consultar o grafo/julgar com a LLM. `sintaxeOk`
 *  continua calculado (não depende do grafo). */
export function detalheNaoAvaliado(registro: RegistroAvaliar, motivo: string): DetalheLado {
    return {
        plano: textoGerado(registro),
        sintaxeOk: sintaxeOk(registro),
        semanticaOk: false,
        violacao: false,
        justificativa: motivo,
        naoAvaliado: true
    };
}

/** Linha efetivamente julgada: violação vem do grafo (determinística),
 *  correção semântica e justificativa vêm do veredicto da LLM. */
export function detalheJulgado(
    registro: RegistroAvaliar,
    proibidos: Set<string>,
    veredicto: { correto: boolean; motivo: string },
    contextoGrafo: string
): DetalheLado {
    const plano = textoGerado(registro);
    return {
        plano,
        sintaxeOk: sintaxeOk(registro),
        semanticaOk: veredicto.correto,
        violacao: violacaoDeterministica(plano, proibidos),
        justificativa: veredicto.motivo,
        contextoGrafo,
        naoAvaliado: false
    };
}

export function agregarMetricas(lados: DetalheLado[]): Metricas {
    const avaliados = lados.filter(l => !l.naoAvaliado);
    return {
        total: avaliados.length,
        semanticaCorreta: avaliados.filter(l => l.semanticaOk).length,
        sintaxeCorreta: avaliados.filter(l => l.sintaxeOk).length,
        violacoes: avaliados.filter(l => l.violacao).length
    };
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
