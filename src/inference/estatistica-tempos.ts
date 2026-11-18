/**
 * Estatística descritiva das MEDIÇÕES por plano (tempos e tamanhos).
 *
 * Mesma disciplina de analise-avaliacao.ts: as fórmulas são nomeadas e
 * documentadas, o cálculo exibido e o número calculado saem da MESMA função, e
 * divisão por zero (ou amostra pequena demais) devolve `null` — nunca `NaN`,
 * `Infinity` nem um zero inventado.
 *
 * O que entra aqui é amostra observada, não população: o desvio padrão é o
 * amostral (n−1) e o intervalo de confiança é o da MÉDIA, por t de Student. Isso
 * responde "qual é o tempo médio de um plano, e com que incerteza", não "onde
 * cai o próximo plano" (esse seria um intervalo de predição, bem mais largo).
 *
 * Pressupostos, ditos de uma vez: o IC pela t supõe observações independentes e
 * média aproximadamente normal (o TCL costuma bastar com n grande, mesmo com
 * tempos assimétricos à direita, que é o caso típico). Com n pequeno e cauda
 * longa, o IC é otimista — por isso a mediana e o mínimo/máximo aparecem ao
 * lado, e não escondidos.
 */

/** Uma amostra resumida. Todos os campos em ms (ou na unidade da entrada). */
export interface ResumoAmostra {
    /** Observações válidas (finitas). É o denominador de tudo. */
    n: number;
    soma: number;
    media: number;
    /** Desvio padrão AMOSTRAL (divisor n−1). `null` com n < 2. */
    desvioPadrao: number | null;
    /** Erro padrão da média: dp/√n. `null` com n < 2. */
    erroPadrao: number | null;
    /** IC da média (t de Student). `null` com n < 2. */
    ic: IntervaloConfianca | null;
    mediana: number;
    /** Quartis por interpolação linear (mesmo método da mediana). */
    q1: number;
    q3: number;
    minimo: number;
    maximo: number;
    /** CV = dp/média: dispersão relativa, comparável entre grandezas. `null` sem dp ou com média 0. */
    coeficienteVariacao: number | null;
}

export interface IntervaloConfianca {
    /** 0.95 para 95%. */
    nivel: number;
    /** Valor crítico t usado (df = n−1). */
    t: number;
    /** t · erroPadrao. */
    margem: number;
    inferior: number;
    superior: number;
}

/**
 * Valores críticos t de Student bicaudais a 95%, por grau de liberdade (1..30).
 * Acima de 30 a diferença para a normal já é < 2%, e usamos 1,96 — a mesma
 * aproximação que qualquer tabela impressa faz, dita aqui em vez de escondida.
 */
const T_95: readonly number[] = [
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12,
    2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042
];
const Z_95 = 1.96;

/** O t crítico bicaudal a 95% para `df` graus de liberdade. */
export function tCritico95(df: number): number {
    if (df < 1) return Number.NaN;
    return df <= T_95.length ? T_95[df - 1] : Z_95;
}

/** Só o que é número finito entra na conta. */
function validos(valores: readonly (number | null | undefined)[]): number[] {
    return valores.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

/** Quantil por interpolação linear sobre a amostra ORDENADA (método R-7, o do Excel/numpy). */
function quantil(ordenados: readonly number[], p: number): number {
    if (ordenados.length === 1) return ordenados[0];
    const posicao = (ordenados.length - 1) * p;
    const base = Math.floor(posicao);
    const resto = posicao - base;
    const proximo = ordenados[base + 1];
    return proximo === undefined ? ordenados[base] : ordenados[base] + resto * (proximo - ordenados[base]);
}

/**
 * As fórmulas, nomeadas. A seção da tela e o número exibido usam estas — não há
 * como o texto da fórmula divergir da conta.
 */
export const FORMULAS_TEMPO = {
    /** x̄ = Σxᵢ / n; `null` com n = 0. */
    media: (xs: readonly number[]): number | null => (xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null),
    /** s = √( Σ(xᵢ − x̄)² / (n − 1) ); `null` com n < 2. */
    desvioPadraoAmostral: (xs: readonly number[]): number | null => {
        if (xs.length < 2) return null;
        const m = xs.reduce((s, x) => s + x, 0) / xs.length;
        return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
    },
    /** EP = s/√n; `null` sem s. */
    erroPadrao: (s: number | null, n: number): number | null => (s === null || n < 1 ? null : s / Math.sqrt(n)),
    /** IC₉₅ = x̄ ± t(n−1) · EP; `null` sem EP. */
    intervaloConfianca95: (media: number, ep: number | null, n: number): IntervaloConfianca | null => {
        if (ep === null || n < 2) return null;
        const t = tCritico95(n - 1);
        const margem = t * ep;
        return { nivel: 0.95, t, margem, inferior: media - margem, superior: media + margem };
    },
    /** CV = s/x̄; `null` sem s ou com x̄ = 0. */
    coeficienteVariacao: (s: number | null, media: number): number | null => (s === null || media === 0 ? null : s / media),
    /** Taxa agregada: Σtempo / Σtamanho (ms por caractere/token do CONJUNTO). `null` sem tamanho. */
    taxaAgregada: (somaTempo: number, somaTamanho: number): number | null => (somaTamanho > 0 ? somaTempo / somaTamanho : null),
    /** r de Pearson entre dois vetores pareados; `null` com n < 2 ou variância nula. */
    correlacaoPearson: (xs: readonly number[], ys: readonly number[]): number | null => {
        const n = Math.min(xs.length, ys.length);
        if (n < 2) return null;
        const mx = xs.reduce((s, x) => s + x, 0) / n;
        const my = ys.reduce((s, y) => s + y, 0) / n;
        let sxy = 0;
        let sxx = 0;
        let syy = 0;
        for (let i = 0; i < n; i++) {
            const dx = xs[i] - mx;
            const dy = ys[i] - my;
            sxy += dx * dy;
            sxx += dx * dx;
            syy += dy * dy;
        }
        if (sxx === 0 || syy === 0) return null;
        return sxy / Math.sqrt(sxx * syy);
    },
    /** Reta de mínimos quadrados y = a + b·x; `null` com n < 2 ou x constante. */
    regressaoLinear: (xs: readonly number[], ys: readonly number[]): Regressao | null => {
        const n = Math.min(xs.length, ys.length);
        if (n < 2) return null;
        const mx = xs.reduce((s, x) => s + x, 0) / n;
        const my = ys.reduce((s, y) => s + y, 0) / n;
        let sxy = 0;
        let sxx = 0;
        for (let i = 0; i < n; i++) {
            sxy += (xs[i] - mx) * (ys[i] - my);
            sxx += (xs[i] - mx) ** 2;
        }
        if (sxx === 0) return null;
        const inclinacao = sxy / sxx;
        const intercepto = my - inclinacao * mx;
        const r = FORMULAS_TEMPO.correlacaoPearson(xs, ys);
        return { intercepto, inclinacao, r, r2: r === null ? null : r * r, n };
    }
} as const;

export interface Regressao {
    /** a em y = a + b·x (ms no tamanho zero: o custo fixo aparente). */
    intercepto: number;
    /** b em y = a + b·x (ms por unidade de tamanho). */
    inclinacao: number;
    r: number | null;
    /** Fração da variância do tempo explicada pelo tamanho. */
    r2: number | null;
    n: number;
}

/**
 * Resume uma amostra. `null` quando não sobrou observação nenhuma — a seção
 * mostra "—" em vez de um zero que ninguém mediu.
 */
export function resumirAmostra(valores: readonly (number | null | undefined)[]): ResumoAmostra | null {
    const xs = validos(valores);
    if (xs.length === 0) return null;

    const ordenados = [...xs].sort((a, b) => a - b);
    const soma = xs.reduce((s, x) => s + x, 0);
    const media = soma / xs.length;
    const desvioPadrao = FORMULAS_TEMPO.desvioPadraoAmostral(xs);
    const erroPadrao = FORMULAS_TEMPO.erroPadrao(desvioPadrao, xs.length);

    return {
        n: xs.length,
        soma,
        media,
        desvioPadrao,
        erroPadrao,
        ic: FORMULAS_TEMPO.intervaloConfianca95(media, erroPadrao, xs.length),
        mediana: quantil(ordenados, 0.5),
        q1: quantil(ordenados, 0.25),
        q3: quantil(ordenados, 0.75),
        minimo: ordenados[0],
        maximo: ordenados[ordenados.length - 1],
        coeficienteVariacao: FORMULAS_TEMPO.coeficienteVariacao(desvioPadrao, media)
    };
}

/**
 * Tempo por unidade de tamanho (ms por caractere, ms por token), das duas
 * formas — elas respondem perguntas diferentes e costumam divergir:
 *
 *   `agregada`  Σtempo / Σtamanho. É o custo do LOTE inteiro por unidade: planos
 *               grandes pesam mais, que é o que importa para estimar quanto custa
 *               processar um volume.
 *   `porPlano`  a média (± dp, IC) das razões tempo/tamanho de CADA plano. É o
 *               custo típico de UM plano: todo plano pesa igual, independentemente
 *               do tamanho.
 *
 * Só entram os pares em que as duas medidas existem e o tamanho é > 0.
 */
export interface TempoPorUnidade {
    /** Pares usados (tempo e tamanho presentes, tamanho > 0). */
    n: number;
    agregada: number | null;
    porPlano: ResumoAmostra | null;
    /** Tamanhos observados, resumidos — "qual é o tamanho médio" da pergunta. */
    tamanho: ResumoAmostra | null;
    /** O tempo influencia com o tamanho? r de Pearson e a reta de mínimos quadrados. */
    regressao: Regressao | null;
}

export function tempoPorUnidade(
    pares: readonly { tempoMs: number | null | undefined; tamanho: number | null | undefined }[]
): TempoPorUnidade {
    const usaveis = pares.filter(
        (p): p is { tempoMs: number; tamanho: number } =>
            typeof p.tempoMs === 'number' &&
            Number.isFinite(p.tempoMs) &&
            typeof p.tamanho === 'number' &&
            Number.isFinite(p.tamanho) &&
            p.tamanho > 0
    );
    const tempos = usaveis.map(p => p.tempoMs);
    const tamanhos = usaveis.map(p => p.tamanho);
    return {
        n: usaveis.length,
        agregada: FORMULAS_TEMPO.taxaAgregada(
            tempos.reduce((s, x) => s + x, 0),
            tamanhos.reduce((s, x) => s + x, 0)
        ),
        porPlano: resumirAmostra(usaveis.map(p => p.tempoMs / p.tamanho)),
        tamanho: resumirAmostra(tamanhos),
        regressao: FORMULAS_TEMPO.regressaoLinear(tamanhos, tempos)
    };
}
