/**
 * Camada analítica da sessão "Avaliação LLM" (web-chat): a análise estatística
 * dos julgamentos JÁ EXISTENTES de cada plano. Nada aqui roda oráculo, juiz,
 * geração ou validação — só lê o que a avaliação gravou.
 *
 *     linhas avaliadas  →  normalizarLinhas  →  PlanoAvaliado[]
 *     fonte selecionada →  analisar          →  Analise (só as métricas que a fonte admite)
 *
 * As FONTES são conceitualmente separadas, e cada uma tem um papel:
 *
 *   oraculo    referência normativa do SPC-CML (VALID | INVALID | UNRESOLVED)
 *   llmJudge   avaliador independente (as três classes + NOT_CALLED | NO_RESPONSE)
 *   humana     referência humana por linha (CORRETO | INCORRETO | INCOMPLETO) —
 *              ainda sem dados; lida de `avaliacaoHumana.classe` quando existir.
 *
 * A OPÇÃO selecionada (`FonteAnalise`) diz se a análise é DESCRITIVA (a
 * distribuição de uma fonte) ou COMPARATIVA (a concordância entre duas). Métrica
 * sem significado para a opção não é calculada: ela não existe no resultado,
 * em vez de aparecer zerada. Todo percentual vem com numerador e denominador
 * explícitos, e é `null` — nunca NaN — quando o denominador é zero.
 *
 * Para incluir a avaliação humana na comparação no futuro (Oráculo × Humano,
 * LLM × Humano), basta uma nova opção que chame `comparar` com a fonte `humana`
 * e um mapeamento entre os espaços de classes: o resto da camada não muda.
 */

// =============================================================================
// Fontes e classes
// =============================================================================

export type Lado = 'arquitetura' | 'baseline';
export const LADOS: readonly Lado[] = ['arquitetura', 'baseline'];

export const CLASSES_VEREDITO = ['VALID', 'INVALID', 'UNRESOLVED'] as const;
export type ClasseVeredito = (typeof CLASSES_VEREDITO)[number];

/** Estados operacionais do juiz: ele não deu veredito. */
export const ESTADOS_OPERACIONAIS_JUIZ = ['NOT_CALLED', 'NO_RESPONSE'] as const;
export const ESTADOS_JUIZ = [...CLASSES_VEREDITO, ...ESTADOS_OPERACIONAIS_JUIZ] as const;
export type EstadoJuiz = (typeof ESTADOS_JUIZ)[number];

export const CLASSES_HUMANAS = ['CORRETO', 'INCORRETO', 'INCOMPLETO'] as const;
export type ClasseHumana = (typeof CLASSES_HUMANAS)[number];

export type IdFonte = 'oraculo' | 'llmJudge' | 'humana';

export interface Fonte {
    id: IdFonte;
    rotulo: string;
    papel: 'referencia_normativa' | 'avaliador_llm' | 'referencia_humana';
    /** Tudo o que a fonte pode registrar para um plano. */
    estados: readonly string[];
    /** Os estados que são VEREDITO (entram em concordância e matriz). */
    classes: readonly string[];
    ler(p: PlanoAvaliado): string | undefined;
}

export const FONTES: Record<IdFonte, Fonte> = {
    oraculo: {
        id: 'oraculo',
        rotulo: 'Oráculo',
        papel: 'referencia_normativa',
        estados: CLASSES_VEREDITO,
        classes: CLASSES_VEREDITO,
        ler: p => p.julgamentos.oraculo
    },
    llmJudge: {
        id: 'llmJudge',
        rotulo: 'LLM Judge',
        papel: 'avaliador_llm',
        estados: ESTADOS_JUIZ,
        classes: CLASSES_VEREDITO,
        ler: p => p.julgamentos.llmJudge
    },
    humana: {
        id: 'humana',
        rotulo: 'Avaliação Humana',
        papel: 'referencia_humana',
        estados: CLASSES_HUMANAS,
        classes: CLASSES_HUMANAS,
        ler: p => p.julgamentos.humana
    }
};

// =============================================================================
// Opções do seletor
// =============================================================================

export type FonteAnalise = 'oraculo' | 'llm' | 'oraculo_llm' | 'humana';

export interface OpcaoFonte {
    id: FonteAnalise;
    rotulo: string;
    modo: 'descritiva' | 'comparativa';
    /** Descritiva: a fonte analisada. Comparativa: [referência, avaliador]. */
    fontes: readonly IdFonte[];
    descricao: string;
}

export const OPCOES_FONTE: readonly OpcaoFonte[] = [
    {
        id: 'oraculo',
        rotulo: 'Apenas Oráculo',
        modo: 'descritiva',
        fontes: ['oraculo'],
        descricao: 'Análise descritiva da distribuição dos julgamentos normativos do Oráculo. Sem segunda fonte, não há concordância.'
    },
    {
        id: 'llm',
        rotulo: 'Apenas LLM Judge',
        modo: 'descritiva',
        fontes: ['llmJudge'],
        descricao: 'Análise descritiva da distribuição dos julgamentos do LLM Judge, com a cobertura do juiz. Não compara com o Oráculo.'
    },
    {
        id: 'oraculo_llm',
        rotulo: 'Oráculo + LLM Judge',
        modo: 'comparativa',
        fontes: ['oraculo', 'llmJudge'],
        descricao: 'Análise comparativa: o Oráculo como referência normativa do SPC-CML e o LLM Judge como avaliador independente.'
    },
    {
        id: 'humana',
        rotulo: 'Avaliação Humana',
        modo: 'descritiva',
        fontes: ['humana'],
        descricao: 'Análise da classificação humana por linha (CORRETO, INCORRETO, INCOMPLETO), quando os dados existirem.'
    }
];

export const FONTE_ANALISE_INICIAL: FonteAnalise = 'oraculo_llm';

export function opcaoFonte(id: FonteAnalise): OpcaoFonte {
    return OPCOES_FONTE.find(o => o.id === id)!;
}

/** Quais métricas têm significado em cada opção (a tabela da especificação). */
export type IdMetrica =
    | 'distribuicao'
    | 'porDominio'
    | 'porModelo'
    | 'coberturaJuiz'
    | 'concordancia'
    | 'matrizConfusao'
    | 'precision'
    | 'recall'
    | 'f1'
    | 'kappa';

const DESCRITIVAS: readonly IdMetrica[] = ['distribuicao', 'porDominio', 'porModelo'];
const COMPARATIVAS: readonly IdMetrica[] = ['concordancia', 'matrizConfusao', 'precision', 'recall', 'f1', 'kappa'];

export const METRICAS_POR_FONTE: Record<FonteAnalise, readonly IdMetrica[]> = {
    oraculo: DESCRITIVAS,
    llm: [...DESCRITIVAS, 'coberturaJuiz'],
    oraculo_llm: [...DESCRITIVAS, 'coberturaJuiz', ...COMPARATIVAS],
    // As comparativas só entram quando houver outra referência comparável à humana.
    humana: DESCRITIVAS
};

// =============================================================================
// Normalização
// =============================================================================

/** O que a camada lê de um lado de uma linha — o formato de `DetalheLado`. */
export interface LadoEntrada {
    naoAvaliado?: boolean;
    oraculo?: { veredito?: string } | null;
    julgamentoLLM?: { status?: string } | null;
    /** Futuro: a avaliação humana do plano. Ausente: ninguém avaliou. */
    avaliacaoHumana?: { classe?: string } | null;
}

/** Uma linha avaliada — o formato de `DetalheLinha`. */
export interface LinhaEntrada {
    linha: number;
    intencao: string;
    dominio?: string;
    arquitetura?: LadoEntrada;
    baseline?: LadoEntrada;
}

/** A unidade da análise: UM plano (uma linha de um lado), com o que cada fonte disse dele. */
export interface PlanoAvaliado {
    linha: number;
    lado: Lado;
    intencao: string;
    dominio?: string;
    naoAvaliado: boolean;
    /** Ausente = aquela fonte não julgou este plano. Nunca preenchido por suposição. */
    julgamentos: { oraculo?: ClasseVeredito; llmJudge?: EstadoJuiz; humana?: ClasseHumana };
}

function daLista<T extends string>(lista: readonly T[], valor: unknown): T | undefined {
    return typeof valor === 'string' && (lista as readonly string[]).includes(valor) ? (valor as T) : undefined;
}

export function normalizarLinhas(linhas: readonly LinhaEntrada[], dominioPadrao?: string): PlanoAvaliado[] {
    const planos: PlanoAvaliado[] = [];
    for (const l of linhas) {
        for (const lado of LADOS) {
            const d = l[lado];
            if (!d) continue;
            const julgamentos: PlanoAvaliado['julgamentos'] = {};
            const oraculo = daLista(CLASSES_VEREDITO, d.oraculo?.veredito);
            const juiz = daLista(ESTADOS_JUIZ, d.julgamentoLLM?.status);
            const humana = daLista(CLASSES_HUMANAS, d.avaliacaoHumana?.classe);
            if (oraculo) julgamentos.oraculo = oraculo;
            if (juiz) julgamentos.llmJudge = juiz;
            if (humana) julgamentos.humana = humana;
            const dominio = l.dominio ?? dominioPadrao;
            planos.push({
                linha: l.linha,
                lado,
                intencao: l.intencao,
                ...(dominio ? { dominio } : {}),
                naoAvaliado: d.naoAvaliado === true,
                julgamentos
            });
        }
    }
    return planos;
}

// =============================================================================
// Métricas
// =============================================================================

/** Uma proporção com o denominador explícito. `percentual` é null quando não há denominador. */
export interface Proporcao {
    n: number;
    denominador: number;
    percentual: number | null;
}

/**
 * As fórmulas da camada, nomeadas. O cálculo abaixo E a documentação
 * metodológica (metodologia-avaliacao.ts) usam estas funções — o texto da
 * fórmula exibido ao usuário e o número calculado não têm como divergir.
 * Divisão por zero nunca produz NaN/Infinity: devolve null.
 */
export const FORMULAS = {
    /** a / b; null quando b = 0. */
    razao: (a: number, b: number): number | null => (b > 0 ? a / b : null),
    /** F1 = 2·TP / (suporte + preditos) — o mesmo que 2PR / (P + R) e que 2TP / (2TP + FP + FN). */
    f1: (tp: number, suporte: number, preditos: number): number | null => FORMULAS.razao(2 * tp, suporte + preditos),
    /** P_e = Σ_c (linha_c / N) · (coluna_c / N); null quando N = 0. */
    acordoEsperado: (linhas: readonly number[], colunas: readonly number[], n: number): number | null =>
        n > 0 ? linhas.reduce((s, l, i) => s + (l / n) * (colunas[i] / n), 0) : null,
    /** κ = (P_o − P_e) / (1 − P_e); null sem P_o ou P_e, ou quando P_e = 1 (1 − P_e = 0). */
    kappa: (po: number | null, pe: number | null): number | null => (po === null || pe === null || pe >= 1 ? null : (po - pe) / (1 - pe)),
    /** Média aritmética dos valores definidos; null quando nenhum é definido. */
    mediaDosDefinidos: (valores: readonly (number | null)[]): number | null => {
        const definidos = valores.filter((v): v is number => v !== null);
        return definidos.length > 0 ? definidos.reduce((s, v) => s + v, 0) / definidos.length : null;
    }
} as const;

export function proporcao(n: number, denominador: number): Proporcao {
    const r = FORMULAS.razao(n, denominador);
    return { n, denominador, percentual: r === null ? null : 100 * r };
}

const razao = FORMULAS.razao;

export interface Distribuicao {
    fonte: IdFonte;
    /** Planos em que a fonte registrou algum estado. É o denominador de `porEstado`. */
    elegiveis: number;
    /** Planos sem nada desta fonte (não avaliados, ou não julgados por ela). Não entra em nenhum estado. */
    semJulgamento: number;
    porEstado: Record<string, Proporcao>;
}

export function distribuicao(planos: readonly PlanoAvaliado[], fonte: Fonte): Distribuicao {
    const lidos = planos.map(p => fonte.ler(p)).filter((v): v is string => v !== undefined);
    const porEstado: Record<string, Proporcao> = {};
    for (const e of fonte.estados) porEstado[e] = proporcao(lidos.filter(v => v === e).length, lidos.length);
    return { fonte: fonte.id, elegiveis: lidos.length, semJulgamento: planos.length - lidos.length, porEstado };
}

export interface CoberturaJuiz {
    /** Planos com veredito do juiz / planos em que ele foi chamado (exclui NOT_CALLED). */
    taxaResposta: Proporcao;
    /** Planos com veredito do juiz / todos os planos no recorte. */
    cobertura: Proporcao;
}

export function coberturaJuiz(planos: readonly PlanoAvaliado[]): CoberturaJuiz {
    const estados = planos.map(p => p.julgamentos.llmJudge);
    const comVeredito = estados.filter(e => e !== undefined && (CLASSES_VEREDITO as readonly string[]).includes(e)).length;
    const chamados = estados.filter(e => e !== undefined && e !== 'NOT_CALLED').length;
    return { taxaResposta: proporcao(comVeredito, chamados), cobertura: proporcao(comVeredito, planos.length) };
}

export interface MetricasClasse {
    /** Verdadeiros positivos / tudo que o avaliador pôs nesta classe. */
    precision: Proporcao;
    /** Verdadeiros positivos / tudo que a referência pôs nesta classe. */
    recall: Proporcao;
    f1: number | null;
    suporte: number;
}

export interface Discordancia {
    /** Classe da referência → classe do avaliador. */
    de: string;
    para: string;
    proporcao: Proporcao;
}

export interface Comparacao {
    referencia: IdFonte;
    avaliador: IdFonte;
    classes: readonly string[];
    /** Planos com veredito da referência. */
    elegiveis: number;
    /** Planos com veredito das duas fontes. É o denominador da concordância e da matriz. */
    comparaveis: number;
    excluidos: { semReferencia: number; avaliadorSemVeredito: number };
    /** comparáveis / elegíveis. */
    cobertura: Proporcao;
    concordancia: Proporcao;
    discordancia: Proporcao;
    /** Concordâncias em cada classe, sobre os comparáveis. */
    concordantesPorClasse: Record<string, Proporcao>;
    /** matriz[classe da referência][classe do avaliador] = planos. */
    matriz: Record<string, Record<string, number>>;
    /** Só os pares que ocorreram, do mais frequente ao menos. */
    discordancias: Discordancia[];
    porClasse: Record<string, MetricasClasse>;
    /** Média do F1 sobre as classes em que ele é definido (`classesConsideradas`). */
    macroF1: { valor: number | null; classesConsideradas: string[] };
    /** κ = (po − pe) / (1 − pe). null quando não há comparáveis ou pe = 1. */
    kappa: { valor: number | null; po: number | null; pe: number | null };
}

/**
 * Compara um avaliador a uma referência, plano a plano. `mapear` leva a classe
 * do avaliador ao espaço da referência — necessário quando os espaços diferem
 * (ex.: futura comparação com a avaliação humana); sem ele, as classes são as
 * mesmas.
 */
export function comparar(
    planos: readonly PlanoAvaliado[],
    referencia: Fonte,
    avaliador: Fonte,
    mapear: (classe: string) => string | undefined = c => c
): Comparacao {
    const classes = referencia.classes;
    const ehClasse = (v: string | undefined): v is string => v !== undefined && classes.includes(v);
    const matriz: Record<string, Record<string, number>> = {};
    for (const r of classes) matriz[r] = Object.fromEntries(classes.map(a => [a, 0]));

    let elegiveis = 0;
    let semReferencia = 0;
    let avaliadorSemVeredito = 0;
    for (const p of planos) {
        const r = referencia.ler(p);
        if (!ehClasse(r)) {
            semReferencia++;
            continue;
        }
        elegiveis++;
        const bruto = avaliador.ler(p);
        const a = bruto !== undefined && avaliador.classes.includes(bruto) ? mapear(bruto) : undefined;
        if (!ehClasse(a)) {
            avaliadorSemVeredito++;
            continue;
        }
        matriz[r][a]++;
    }

    const comparaveis = elegiveis - avaliadorSemVeredito;
    const linha = (r: string) => classes.reduce((s, a) => s + matriz[r][a], 0);
    const coluna = (a: string) => classes.reduce((s, r) => s + matriz[r][a], 0);
    const concordantes = classes.reduce((s, c) => s + matriz[c][c], 0);

    const porClasse: Record<string, MetricasClasse> = {};
    for (const c of classes) {
        const tp = matriz[c][c];
        porClasse[c] = {
            precision: proporcao(tp, coluna(c)),
            recall: proporcao(tp, linha(c)),
            // F1 = 2TP / (2TP + FP + FN) = 2TP / (suporte + preditos): indefinido só
            // quando a classe não aparece em nenhuma das duas fontes.
            f1: FORMULAS.f1(tp, linha(c), coluna(c)),
            suporte: linha(c)
        };
    }
    const comF1 = classes.filter(c => porClasse[c].f1 !== null);

    const po = razao(concordantes, comparaveis);
    const pe = FORMULAS.acordoEsperado(classes.map(linha), classes.map(coluna), comparaveis);
    const kappa = FORMULAS.kappa(po, pe);

    const discordancias: Discordancia[] = [];
    for (const r of classes) {
        for (const a of classes) {
            if (r !== a && matriz[r][a] > 0) discordancias.push({ de: r, para: a, proporcao: proporcao(matriz[r][a], comparaveis) });
        }
    }
    discordancias.sort((x, y) => y.proporcao.n - x.proporcao.n);

    return {
        referencia: referencia.id,
        avaliador: avaliador.id,
        classes,
        elegiveis,
        comparaveis,
        excluidos: { semReferencia, avaliadorSemVeredito },
        cobertura: proporcao(comparaveis, elegiveis),
        concordancia: proporcao(concordantes, comparaveis),
        discordancia: proporcao(comparaveis - concordantes, comparaveis),
        concordantesPorClasse: Object.fromEntries(classes.map(c => [c, proporcao(matriz[c][c], comparaveis)])),
        matriz,
        discordancias,
        porClasse,
        macroF1: {
            valor: FORMULAS.mediaDosDefinidos(classes.map(c => porClasse[c].f1)),
            classesConsideradas: comF1
        },
        kappa: { valor: kappa, po, pe }
    };
}

// =============================================================================
// Análise por opção
// =============================================================================

export interface Filtro {
    lado?: Lado;
    dominio?: string;
}

/** As métricas de um recorte (geral, um modelo, um domínio). Bloco ausente = métrica sem significado na opção. */
export interface BlocoAnalise {
    /** Planos no recorte. */
    total: number;
    naoAvaliados: number;
    distribuicoes: Distribuicao[];
    coberturaJuiz?: CoberturaJuiz;
    comparacao?: Comparacao;
}

export interface LinhaAnalise {
    linha: number;
    lado: Lado;
    intencao: string;
    dominio?: string;
    naoAvaliado: boolean;
    /** Só as fontes da opção selecionada. */
    julgamentos: Partial<Record<IdFonte, string>>;
    /** Só na análise comparativa, e só quando as duas fontes deram veredito. */
    concorda?: boolean;
}

export interface Analise {
    fonte: FonteAnalise;
    opcao: OpcaoFonte;
    metricas: readonly IdMetrica[];
    /** false quando a fonte não tem dado nenhum (hoje, a avaliação humana). */
    disponivel: boolean;
    motivoIndisponivel?: string;
    /** Planos depois do filtro. */
    totalPlanos: number;
    geral?: BlocoAnalise;
    porModelo: Partial<Record<Lado, BlocoAnalise>>;
    porDominio: Record<string, BlocoAnalise>;
    porLinha: LinhaAnalise[];
    /** Os valores possíveis dos filtros, a partir dos dados (não do filtro aplicado). */
    lados: Lado[];
    dominios: string[];
}

export const SEM_DADOS_HUMANOS = 'Nenhum dado de avaliação humana disponível.';

/** Tem algum dado desta fonte nos planos? */
export function fonteDisponivel(planos: readonly PlanoAvaliado[], fonte: IdFonte): boolean {
    return planos.some(p => FONTES[fonte].ler(p) !== undefined);
}

function bloco(planos: readonly PlanoAvaliado[], opcao: OpcaoFonte, metricas: readonly IdMetrica[]): BlocoAnalise {
    const fontes = opcao.fontes.map(f => FONTES[f]);
    return {
        total: planos.length,
        naoAvaliados: planos.filter(p => p.naoAvaliado).length,
        distribuicoes: metricas.includes('distribuicao') ? fontes.map(f => distribuicao(planos, f)) : [],
        ...(metricas.includes('coberturaJuiz') ? { coberturaJuiz: coberturaJuiz(planos) } : {}),
        ...(opcao.modo === 'comparativa' && metricas.includes('concordancia') ? { comparacao: comparar(planos, fontes[0], fontes[1]) } : {})
    };
}

function agrupar(planos: readonly PlanoAvaliado[], chave: (p: PlanoAvaliado) => string | undefined): Map<string, PlanoAvaliado[]> {
    const grupos = new Map<string, PlanoAvaliado[]>();
    for (const p of planos) {
        const k = chave(p);
        if (k === undefined) continue;
        grupos.set(k, [...(grupos.get(k) ?? []), p]);
    }
    return grupos;
}

/**
 * A análise da opção selecionada sobre os planos. Função pura: trocar a opção é
 * chamar de novo com outra `fonte` — nada da chamada anterior sobrevive.
 */
export function analisar(planos: readonly PlanoAvaliado[], fonte: FonteAnalise, filtro: Filtro = {}): Analise {
    const opcao = opcaoFonte(fonte);
    const metricas = METRICAS_POR_FONTE[fonte];
    const lados = LADOS.filter(l => planos.some(p => p.lado === l));
    const dominios = [...new Set(planos.map(p => p.dominio).filter((d): d is string => d !== undefined))].sort();
    const recorte = planos.filter(p => (!filtro.lado || p.lado === filtro.lado) && (!filtro.dominio || p.dominio === filtro.dominio));
    const disponivel = opcao.fontes.every(f => fonteDisponivel(planos, f));

    const base = { fonte, opcao, metricas, totalPlanos: recorte.length, lados, dominios };
    if (!disponivel) {
        return {
            ...base,
            disponivel: false,
            motivoIndisponivel: opcao.fontes.includes('humana') ? SEM_DADOS_HUMANOS : `Nenhum julgamento de ${opcao.fontes.map(f => FONTES[f].rotulo).join(' / ')} nos dados.`,
            porModelo: {},
            porDominio: {},
            porLinha: []
        };
    }

    const porModelo: Partial<Record<Lado, BlocoAnalise>> = {};
    if (metricas.includes('porModelo')) {
        for (const [lado, grupo] of agrupar(recorte, p => p.lado)) porModelo[lado as Lado] = bloco(grupo, opcao, metricas);
    }
    const porDominio: Record<string, BlocoAnalise> = {};
    if (metricas.includes('porDominio')) {
        for (const [dominio, grupo] of agrupar(recorte, p => p.dominio)) porDominio[dominio] = bloco(grupo, opcao, metricas);
    }

    const porLinha: LinhaAnalise[] = recorte.map(p => {
        const julgamentos: Partial<Record<IdFonte, string>> = {};
        for (const f of opcao.fontes) {
            const v = FONTES[f].ler(p);
            if (v !== undefined) julgamentos[f] = v;
        }
        const linha: LinhaAnalise = { linha: p.linha, lado: p.lado, intencao: p.intencao, naoAvaliado: p.naoAvaliado, julgamentos };
        if (p.dominio) linha.dominio = p.dominio;
        if (opcao.modo === 'comparativa') {
            const [r, a] = opcao.fontes.map(f => FONTES[f]);
            const vr = r.ler(p);
            const va = a.ler(p);
            if (vr !== undefined && r.classes.includes(vr) && va !== undefined && a.classes.includes(va)) linha.concorda = vr === va;
        }
        return linha;
    });

    return { ...base, disponivel: true, geral: bloco(recorte, opcao, metricas), porModelo, porDominio, porLinha };
}
