/**
 * Documentação metodológica da sessão "Avaliação LLM" — o painel "(?)".
 *
 * Duas partes:
 *
 *   1. DOCUMENTACAO e SECOES_METODOLOGIA: o que cada métrica mede, a fórmula,
 *      as variáveis, numerador e denominador, quem entra e quem sai, casos
 *      especiais, fundamentos (cada um com a sua NATUREZA: definição, identidade,
 *      propriedade, teorema, pressuposto, critério ou convenção), justificativa e
 *      limitações. Cada documentação aponta as métricas da camada analítica
 *      (`IdMetrica`) que explica e a função de `FORMULAS` que a implementa.
 *
 *   2. aplicarMetodologia: a mesma metodologia aplicada à análise ATUAL (fonte e
 *      filtros), com a substituição dos valores reais nas fórmulas. Os números
 *      vêm do resultado de `analisar` e das MESMAS funções de `FORMULAS` que o
 *      cálculo usa — a documentação não recalcula por conta própria.
 *
 * Notação: as fórmulas são LaTeX (renderizadas pelo KaTeX na interface). Nos
 * textos corridos, matemática em linha vem entre `$…$` e em bloco entre
 * `$$…$$`. Toda fórmula — a da documentação e a da substituição com os dados —
 * é montada pelos construtores de `TEX`: a forma exibida é uma só.
 *
 * Nada aqui inventa teorema nem referência bibliográfica: quando a métrica é uma
 * definição estatística, o campo `teorema` diz isso.
 */

import {
    analisar,
    CLASSES_VEREDITO,
    FONTES,
    FORMULAS,
    METRICAS_POR_FONTE,
    normalizarLinhas,
    OPCOES_FONTE,
    type Analise,
    type Comparacao,
    type FonteAnalise,
    type Filtro,
    type IdMetrica,
    type LinhaEntrada,
    type Proporcao
} from './analise-avaliacao.js';

// =============================================================================
// Estrutura
// =============================================================================

export type NaturezaFundamento = 'definicao' | 'identidade' | 'propriedade' | 'teorema' | 'pressuposto' | 'criterio' | 'convencao';

export const ROTULO_NATUREZA: Record<NaturezaFundamento, string> = {
    definicao: 'Definição',
    identidade: 'Identidade matemática',
    propriedade: 'Propriedade',
    teorema: 'Teorema',
    pressuposto: 'Pressuposto',
    criterio: 'Critério estatístico',
    convencao: 'Convenção de interpretação'
};

export interface Fundamento {
    natureza: NaturezaFundamento;
    /** Texto corrido; matemática em linha entre `$…$`. */
    texto: string;
}

export interface VariavelFormula {
    /** O símbolo, em LaTeX. */
    simbolo: string;
    /** Texto corrido; matemática em linha entre `$…$`. */
    significado: string;
}

export type IdDocumentacao =
    | 'distribuicao'
    | 'recortes'
    | 'taxaRespostaJuiz'
    | 'coberturaJuiz'
    | 'coberturaComparacao'
    | 'concordancia'
    | 'discordancia'
    | 'matrizConfusao'
    | 'precision'
    | 'recall'
    | 'f1'
    | 'macroF1'
    | 'kappa'
    | 'microF1'
    | 'balancedAccuracy'
    | 'macroPrecisionRecall';

export interface DocumentacaoMetrica {
    id: IdDocumentacao;
    nome: string;
    /** As métricas da camada analítica que esta documentação explica. Vazio quando não implementada. */
    metricas: readonly IdMetrica[];
    implementada: boolean;
    oQueMede: string;
    /** A fórmula de apresentação, em LaTeX: uma equação em bloco por item. */
    formula: readonly string[];
    /** Forma algebricamente equivalente que o código usa, quando difere da fórmula de apresentação (LaTeX). */
    formaImplementada?: readonly string[];
    /** A função de `FORMULAS` que calcula esta métrica. */
    funcao?: keyof typeof FORMULAS;
    variaveis: readonly VariavelFormula[];
    numerador?: string;
    denominador?: string;
    entram: string;
    ficamFora: string;
    casosEspeciais: readonly string[];
    fundamentos: readonly Fundamento[];
    teorema: string;
    pressupostos: readonly string[];
    justificativa: string;
    limitacoes: readonly string[];
}

export const TEOREMA_NAO_APLICAVEL = 'Teorema específico: não aplicável. Não é necessário um teorema; trata-se da definição estatística da métrica.';

// =============================================================================
// Notação LaTeX: os construtores das fórmulas (documentação E dados reais)
// =============================================================================

const m = String.raw;

/** Uma equação: lado esquerdo e lado direito, em LaTeX. */
export interface EquacaoTex {
    lhs: string;
    rhs: string;
}

/** Nome de classe/estado como texto dentro da fórmula (NOT_CALLED → \text{NOT\_CALLED}). */
export function texClasse(c: string): string {
    return m`\text{${c.replace(/_/g, m`\_`)}}`;
}

/** Número no padrão pt-BR, em LaTeX (vírgula decimal sem o espaço de pontuação); null → "indefinido". */
export function texNum(x: number | null | undefined, casas = 3): string {
    return x === null || x === undefined ? m`\text{indefinido}` : formatarNumero(x, casas).replace(/,/g, '{,}');
}

const texFrac = (a: string | number, b: string | number): string => m`\frac{${String(a)}}{${String(b)}}`;

/** Resultado de uma proporção: valor e porcentagem, ou "indefinido" com denominador zero. */
function texResultado(p: Proporcao): string {
    const r = FORMULAS.razao(p.n, p.denominador);
    return r === null ? m`\text{indefinido}` : m`${texNum(r)}\;(${texNum(100 * r, 1)}\%)`;
}

export const eqTex = (e: EquacaoTex): string => `${e.lhs} = ${e.rhs}`;

const NCOMP = m`N_{\mathrm{comp}}`;
const SOMA_DIAG = m`\sum_{c} n(c,c)`;

/**
 * As fórmulas, uma vez só. A documentação usa a forma genérica (classe `c`); a
 * aplicação aos dados usa a mesma forma com a classe real no lugar de `c`.
 */
export const TEX = {
    proporcao: (c = 'c'): EquacaoTex => ({ lhs: m`p_{${c}}`, rhs: m`\frac{n_{${c}}}{N_f}` }),
    porcentagem: (c = 'c'): EquacaoTex => ({ lhs: m`P_{${c}}`, rhs: m`100 \cdot \frac{n_{${c}}}{N_f}` }),
    recorte: { lhs: m`M(S_g)`, rhs: m`M\big(\{\, \text{planos do recorte com grupo} = g \,\}\big)` } as EquacaoTex,
    taxaResposta: { lhs: m`\mathrm{TR}`, rhs: m`\frac{V_J}{C_J}` } as EquacaoTex,
    coberturaJuiz: { lhs: m`\mathrm{Cob}_J`, rhs: m`\frac{V_J}{N}` } as EquacaoTex,
    coberturaComparacao: { lhs: m`\mathrm{Cob}_{\mathrm{comp}}`, rhs: m`\frac{${NCOMP}}{N_{\mathrm{ref}}}` } as EquacaoTex,
    concordancia: { lhs: 'A', rhs: m`\frac{${SOMA_DIAG}}{${NCOMP}}` } as EquacaoTex,
    discordancia: { lhs: 'D', rhs: m`\frac{${NCOMP} - ${SOMA_DIAG}}{${NCOMP}}` } as EquacaoTex,
    tipoDiscordancia: (i = 'i', j = 'j'): EquacaoTex => ({ lhs: m`d(${i} \to ${j})`, rhs: m`\frac{n(${i},${j})}{${NCOMP}}` }),
    celula: { lhs: m`n(i,j)`, rhs: m`\#\{\, \text{pares comparáveis} : \text{Oráculo} = i,\ \text{Judge} = j \,\}` } as EquacaoTex,
    linha: (c = 'c'): EquacaoTex => ({ lhs: m`\mathrm{linha}_{${c}}`, rhs: m`\sum_{j} n(${c},j)` }),
    coluna: (c = 'c'): EquacaoTex => ({ lhs: m`\mathrm{coluna}_{${c}}`, rhs: m`\sum_{i} n(i,${c})` }),
    total: { lhs: NCOMP, rhs: m`\sum_{i}\sum_{j} n(i,j)` } as EquacaoTex,
    precision: (c = 'c'): EquacaoTex => ({ lhs: m`\mathrm{Precision}(${c})`, rhs: m`\frac{n(${c},${c})}{\mathrm{coluna}_{${c}}}` }),
    recall: (c = 'c'): EquacaoTex => ({ lhs: m`\mathrm{Recall}(${c})`, rhs: m`\frac{n(${c},${c})}{\mathrm{linha}_{${c}}}` }),
    f1: (c = 'c'): EquacaoTex => ({ lhs: m`\mathrm{F1}(${c})`, rhs: m`\frac{2\, n(${c},${c})}{\mathrm{linha}_{${c}} + \mathrm{coluna}_{${c}}}` }),
    macroF1: { lhs: m`\mathrm{MacroF1}`, rhs: m`\frac{1}{K} \sum_{c \in C^{*}} \mathrm{F1}(c)` } as EquacaoTex,
    po: { lhs: 'P_o', rhs: m`\frac{${SOMA_DIAG}}{${NCOMP}}` } as EquacaoTex,
    pe: { lhs: 'P_e', rhs: m`\sum_{c} \frac{\mathrm{linha}_{c}}{${NCOMP}} \cdot \frac{\mathrm{coluna}_{c}}{${NCOMP}}` } as EquacaoTex,
    kappa: { lhs: m`\kappa`, rhs: m`\frac{P_o - P_e}{1 - P_e}` } as EquacaoTex
};

/**
 * O trecho de LaTeX que identifica, na documentação, cada função de `FORMULAS`.
 * Os testes exigem que a documentação de uma métrica contenha a assinatura da
 * função que a calcula: a fórmula exibida e a calculada não podem divergir.
 */
export const ASSINATURA_TEX: Record<keyof typeof FORMULAS, string> = {
    razao: m`\frac{`,
    f1: TEX.f1().rhs,
    acordoEsperado: TEX.pe.rhs,
    kappa: TEX.kappa.rhs,
    mediaDosDefinidos: TEX.macroF1.rhs
};

// Textos reutilizados (mesmo fato, uma redação só).
const RE_ROTULO_UNICO = 'Cada plano tem no máximo um estado por fonte (classificação de rótulo único), e os estados de uma fonte são mutuamente exclusivos.';
const RE_MESMO_ESPACO = 'Oráculo e LLM Judge usam o mesmo espaço de classes para veredito: VALID, INVALID, UNRESOLVED.';
const RE_SEM_AMOSTRAGEM = 'Os planos avaliados são o conjunto analisado, não uma amostra aleatória declarada; nenhuma distribuição de probabilidade é assumida.';
const RE_NULL = 'Denominador zero: o valor é null e aparece como "—", nunca como NaN ou Infinity.';
const RE_UNRESOLVED = 'UNRESOLVED é uma classe própria: nunca é convertido em INVALID, entra nos denominadores e tem as suas próprias Precision, Recall e F1.';
const RE_OPERACIONAIS = 'NOT_CALLED e NO_RESPONSE são estados operacionais do Judge, não classes semânticas: ficam fora da matriz e de toda métrica de concordância.';
const N_COMP: VariavelFormula = { simbolo: NCOMP, significado: 'pares comparáveis: planos com veredito (VALID, INVALID ou UNRESOLVED) do Oráculo E do Judge' };
const N_CC: VariavelFormula = { simbolo: m`n(c,c)`, significado: 'pares em que Oráculo e Judge disseram a mesma classe $c$ (diagonal da matriz)' };
const LINHA_C: VariavelFormula = { simbolo: m`\mathrm{linha}_{c}`, significado: 'planos que o Oráculo pôs na classe $c$ (soma da linha $c$ da matriz; o "suporte" da classe)' };
const COLUNA_C: VariavelFormula = { simbolo: m`\mathrm{coluna}_{c}`, significado: 'planos que o Judge pôs na classe $c$ (soma da coluna $c$ da matriz)' };
const COMPARAVEIS_ENTRAM = 'Planos do recorte com veredito do Oráculo E veredito do Judge.';
const COMPARAVEIS_SAEM =
    'Planos sem veredito do Oráculo (não avaliados por falha técnica) e planos em que o Judge não deu veredito (NOT_CALLED: plano vazio ou sintaxe inválida; NO_RESPONSE: falha do Judge).';

// =============================================================================
// Documentação das métricas
// =============================================================================

export const DOCUMENTACAO: readonly DocumentacaoMetrica[] = [
    {
        id: 'distribuicao',
        nome: 'Distribuição das classes',
        metricas: ['distribuicao'],
        implementada: true,
        oQueMede: 'A proporção dos planos em cada estado registrado pela fonte selecionada. É a descrição de como UMA fonte classifica os planos — sem comparação com outra.',
        formula: [eqTex(TEX.proporcao()), eqTex(TEX.porcentagem())],
        funcao: 'razao',
        variaveis: [
            { simbolo: 'c', significado: 'um estado da fonte $f$. Oráculo: VALID, INVALID, UNRESOLVED. LLM Judge: os mesmos três e NOT_CALLED, NO_RESPONSE. Avaliação Humana: CORRETO, INCORRETO, INCOMPLETO' },
            { simbolo: 'n_{c}', significado: 'planos do recorte com estado $c$ na fonte $f$' },
            { simbolo: 'N_f', significado: 'planos do recorte em que a fonte $f$ registrou algum estado do seu vocabulário' },
            { simbolo: 'p_{c}', significado: 'frequência relativa do estado $c$' },
            { simbolo: 'P_{c}', significado: 'a mesma frequência em porcentagem' }
        ],
        numerador: '$n_c$ — planos com o estado $c$',
        denominador: '$N_f$ — planos com algum estado da fonte $f$ (não é o total do recorte)',
        entram: 'Planos do recorte em que a fonte registrou um estado do seu vocabulário.',
        ficamFora:
            'Planos sem estado desta fonte. No Oráculo: os não avaliados por falha técnica. No Judge: os não avaliados por falha na sintaxe ou na recuperação (na falha da semântica o veredito do Judge é preservado e entra). Valores fora do vocabulário são descartados na normalização.',
        casosEspeciais: [
            RE_NULL,
            'No LLM Judge, NOT_CALLED e NO_RESPONSE são estados da distribuição: entram em $N_f$ e têm a sua parcela. Não são convertidos em VALID, INVALID ou UNRESOLVED.',
            RE_UNRESOLVED,
            'Avaliação Humana: ausência de avaliação não é contada como INCORRETO; o plano simplesmente não entra em $N_f$.'
        ],
        fundamentos: [
            { natureza: 'definicao', texto: 'Frequência relativa: a fração das observações que pertence a cada estado.' },
            { natureza: 'identidade', texto: m`$\sum_c n_c = N_f$, logo $\sum_c p_c = 1$ e $\sum_c P_c = 100\%$ (a menos do arredondamento na exibição).` }
        ],
        teorema: TEOREMA_NAO_APLICAVEL,
        pressupostos: [RE_ROTULO_UNICO, RE_SEM_AMOSTRAGEM],
        justificativa: 'É a descrição mínima e sem hipóteses de como a fonte classifica os planos. Responde "como o Oráculo (ou o Judge) classifica os planos?" sem misturar a pergunta com a de concordância.',
        limitacoes: ['Descreve a fonte, não a correção dos planos.', 'Em recortes pequenos, cada plano move a proporção de forma visível: a estimativa é instável.']
    },
    {
        id: 'recortes',
        nome: 'Recortes por modelo e por domínio',
        metricas: ['porModelo', 'porDominio'],
        implementada: true,
        oQueMede: 'As mesmas métricas desta lista, recalculadas só sobre os planos de cada grupo (Arquitetura, Baseline, ou cada domínio).',
        formula: [eqTex(TEX.recorte)],
        funcao: 'razao',
        variaveis: [
            { simbolo: 'M', significado: m`qualquer métrica documentada aqui (distribuição, concordância, $\kappa$, F1...)` },
            { simbolo: 'g', significado: 'o grupo: Arquitetura ou Baseline (modelo), ou o domínio (med, agro, fut)' },
            { simbolo: 'S_g', significado: 'o subconjunto dos planos do recorte que pertencem ao grupo $g$' }
        ],
        numerador: 'o da métrica $M$, contado só em $S_g$',
        denominador: 'o da métrica $M$, contado só em $S_g$',
        entram: 'Os planos do grupo $g$.',
        ficamFora: 'Os planos de outros grupos. Arquitetura e Baseline nunca entram no mesmo denominador de um recorte por modelo.',
        casosEspeciais: [RE_NULL, 'Grupo sem planos não aparece na tabela.'],
        fundamentos: [
            { natureza: 'definicao', texto: 'Restrição da métrica a um subconjunto das observações.' },
            {
                natureza: 'identidade',
                texto: m`Os grupos de modelo particionam o recorte: $N = N_{\text{Arquitetura}} + N_{\text{Baseline}}$. As CONTAGENS somam entre grupos; proporções, F1 e $\kappa$ não — o $\kappa$ geral não é a média dos $\kappa$ dos grupos.`
            },
            { natureza: 'propriedade', texto: 'Ao agregar grupos, uma tendência presente em cada grupo pode se inverter no total (fenômeno conhecido como paradoxo de Simpson).' }
        ],
        teorema: TEOREMA_NAO_APLICAVEL,
        pressupostos: ['Cada plano pertence a exatamente um modelo e a no máximo um domínio.'],
        justificativa: 'Permite responder "como Arquitetura e Baseline se comportam?" e "como os resultados variam entre domínios?" sem que um grupo contamine o denominador do outro.',
        limitacoes: ['Grupos pequenos produzem estimativas instáveis.', 'Cada avaliação é gravada por domínio: em geral só um domínio aparece.']
    },
    {
        id: 'taxaRespostaJuiz',
        nome: 'Taxa de resposta do Judge',
        metricas: ['coberturaJuiz'],
        implementada: true,
        oQueMede: 'Entre os planos em que o Judge foi chamado, a fração em que ele devolveu um veredito.',
        formula: [eqTex(TEX.taxaResposta)],
        funcao: 'razao',
        variaveis: [
            { simbolo: 'V_J', significado: 'planos com veredito do Judge (VALID, INVALID ou UNRESOLVED)' },
            { simbolo: 'C_J', significado: 'planos em que o Judge foi chamado: estado do Judge registrado e diferente de NOT_CALLED (NO_RESPONSE entra)' }
        ],
        numerador: '$V_J$ — planos com veredito do Judge',
        denominador: m`$C_J$ — planos com estado do Judge $\neq$ NOT_CALLED`,
        entram: 'Planos em que o Judge foi chamado.',
        ficamFora: 'NOT_CALLED (o Judge não foi chamado: plano vazio ou sintaxe inválida) e planos sem estado do Judge (não avaliados por falha na sintaxe ou na recuperação).',
        casosEspeciais: [RE_NULL, 'NO_RESPONSE entra no denominador e não no numerador: o Judge foi chamado e falhou.', RE_OPERACIONAIS],
        fundamentos: [{ natureza: 'definicao', texto: 'Proporção de chamadas que produziram resposta utilizável.' }],
        teorema: TEOREMA_NAO_APLICAVEL,
        pressupostos: ['NO_RESPONSE registra uma falha técnica do Judge, não um julgamento.'],
        justificativa: 'Separa a confiabilidade operacional do avaliador da qualidade dos seus julgamentos.',
        limitacoes: ['Não diz nada sobre se os vereditos estão certos.']
    },
    {
        id: 'coberturaJuiz',
        nome: 'Cobertura do Judge',
        metricas: ['coberturaJuiz'],
        implementada: true,
        oQueMede: 'A fração de TODOS os planos do recorte que o Judge efetivamente classificou.',
        formula: [eqTex(TEX.coberturaJuiz)],
        funcao: 'razao',
        variaveis: [
            { simbolo: 'V_J', significado: 'planos com veredito do Judge (VALID, INVALID ou UNRESOLVED)' },
            { simbolo: 'N', significado: 'todos os planos do recorte, inclusive não avaliados e NOT_CALLED' }
        ],
        numerador: '$V_J$ — planos com veredito do Judge',
        denominador: '$N$ — todos os planos do recorte',
        entram: 'Todos os planos do recorte, no denominador.',
        ficamFora: 'Nada sai do denominador: é isso que distingue a cobertura da taxa de resposta.',
        casosEspeciais: [RE_NULL, RE_OPERACIONAIS],
        fundamentos: [{ natureza: 'definicao', texto: 'Proporção do conjunto com julgamento utilizável da fonte.' }],
        teorema: TEOREMA_NAO_APLICAVEL,
        pressupostos: [RE_SEM_AMOSTRAGEM],
        justificativa: 'Mostra quanto do experimento a análise do Judge de fato representa.',
        limitacoes: ['Planos vazios e com sintaxe inválida reduzem a cobertura por desenho (o Judge não é chamado neles), não por falha do Judge.']
    },
    {
        id: 'coberturaComparacao',
        nome: 'Cobertura da comparação',
        metricas: ['concordancia'],
        implementada: true,
        oQueMede: 'Entre os planos com veredito do Oráculo, a fração que também tem veredito do Judge — isto é, quanto da referência a comparação alcança.',
        formula: [eqTex(TEX.coberturaComparacao)],
        funcao: 'razao',
        variaveis: [N_COMP, { simbolo: m`N_{\mathrm{ref}}`, significado: 'planos do recorte com veredito do Oráculo (a referência)' }],
        numerador: m`$N_{\mathrm{comp}}$ — pares comparáveis`,
        denominador: m`$N_{\mathrm{ref}}$ — planos com veredito do Oráculo`,
        entram: 'Planos com veredito do Oráculo.',
        ficamFora: 'Planos sem veredito do Oráculo (não avaliados).',
        casosEspeciais: [RE_NULL],
        fundamentos: [{ natureza: 'definicao', texto: 'Proporção da referência alcançada pela segunda fonte.' }],
        teorema: TEOREMA_NAO_APLICAVEL,
        pressupostos: [RE_MESMO_ESPACO],
        justificativa: m`Toda métrica de concordância é calculada só sobre $N_{\mathrm{comp}}$; a cobertura mostra o tamanho dessa base em relação à referência.`,
        limitacoes: ['Se os pares excluídos forem diferentes dos incluídos (ex.: só planos inválidos ficam sem Judge), a concordância descreve só o subconjunto comparável.']
    },
    {
        id: 'concordancia',
        nome: 'Concordância com o Oráculo (Accuracy relativa ao Oráculo)',
        metricas: ['concordancia'],
        implementada: true,
        oQueMede:
            'A fração dos pares comparáveis em que o Judge deu a mesma classe que o Oráculo. Nesta implementação é o mesmo número exibido como "Concordância com o Oráculo": não há um cálculo separado de Accuracy.',
        formula: [eqTex(TEX.concordancia)],
        funcao: 'razao',
        variaveis: [N_CC, N_COMP],
        numerador: m`$\sum_c n(c,c)$ — pares em que Judge = Oráculo (soma da diagonal da matriz)`,
        denominador: m`$N_{\mathrm{comp}}$ — pares comparáveis`,
        entram: COMPARAVEIS_ENTRAM,
        ficamFora: COMPARAVEIS_SAEM,
        casosEspeciais: [RE_NULL, RE_UNRESOLVED, RE_OPERACIONAIS],
        fundamentos: [
            { natureza: 'definicao', texto: 'Proporção de acerto em relação à fonte de referência.' },
            {
                natureza: 'convencao',
                texto: 'É chamada de "Accuracy relativa ao Oráculo", e não de acurácia real: o Oráculo é a referência normativa do SPC-CML, não a verdade humana.'
            }
        ],
        teorema: TEOREMA_NAO_APLICAVEL,
        pressupostos: [RE_ROTULO_UNICO, RE_MESMO_ESPACO],
        justificativa: 'Mede a coincidência observada entre o avaliador independente e a referência normativa — a pergunta "quanto o Judge concorda com o Oráculo?".',
        limitacoes: [
            'Concordância não implica correção: as duas fontes podem errar juntas.',
            'É dominada pela classe majoritária: um Judge que responde sempre VALID concorda em exatamente a fração de pares que o Oráculo julgou VALID.'
        ]
    },
    {
        id: 'discordancia',
        nome: 'Discordância',
        metricas: ['concordancia'],
        implementada: true,
        oQueMede: 'A fração dos pares comparáveis em que Judge e Oráculo deram classes diferentes, e os tipos de discordância (Oráculo → Judge).',
        formula: [m`${eqTex(TEX.discordancia)} = 1 - A`, m`${eqTex(TEX.tipoDiscordancia())}, \quad i \neq j`],
        funcao: 'razao',
        variaveis: [N_CC, N_COMP, { simbolo: m`n(i,j)`, significado: 'pares com Oráculo = $i$ e Judge = $j$' }, { simbolo: 'A', significado: 'a concordância' }],
        numerador: m`$N_{\mathrm{comp}} - \sum_c n(c,c)$ — pares fora da diagonal; para um tipo, $n(i,j)$`,
        denominador: m`$N_{\mathrm{comp}}$ — pares comparáveis`,
        entram: COMPARAVEIS_ENTRAM,
        ficamFora: COMPARAVEIS_SAEM,
        casosEspeciais: [RE_NULL, 'Só os tipos de discordância que ocorreram são listados, do mais frequente para o menos.'],
        fundamentos: [
            { natureza: 'definicao', texto: 'Complemento da concordância sobre os pares comparáveis.' },
            {
                natureza: 'identidade',
                texto: m`$D = 1 - A$ e $\sum_{i \neq j} d(i \to j) = D$. Válida porque concordância e discordância usam exatamente os mesmos pares comparáveis e o mesmo denominador $N_{\mathrm{comp}}$.`
            }
        ],
        teorema: TEOREMA_NAO_APLICAVEL,
        pressupostos: [RE_ROTULO_UNICO, RE_MESMO_ESPACO],
        justificativa: 'Os tipos de discordância (ex.: VALID → INVALID) mostram em que direção o Judge diverge, o que a taxa agregada esconde.',
        limitacoes: ['Discordância não diz qual das duas fontes está certa.']
    },
    {
        id: 'matrizConfusao',
        nome: 'Matriz de confusão',
        metricas: ['matrizConfusao'],
        implementada: true,
        oQueMede: 'A frequência conjunta das classes do Oráculo (linhas) e do Judge (colunas) nos pares comparáveis.',
        formula: [
            m`${eqTex(TEX.celula)}, \quad i, j \in \{\text{VALID}, \text{INVALID}, \text{UNRESOLVED}\}`,
            m`${eqTex(TEX.linha())} \qquad ${eqTex(TEX.coluna())} \qquad ${eqTex(TEX.total)}`
        ],
        variaveis: [
            { simbolo: 'i', significado: 'classe do Oráculo (linha)' },
            { simbolo: 'j', significado: 'classe do Judge (coluna)' },
            { simbolo: m`n(i,j)`, significado: 'contagem da célula' },
            LINHA_C,
            COLUNA_C,
            N_COMP
        ],
        numerador: '$n(i,j)$ — contagem da célula (a matriz exibe contagens, não proporções)',
        denominador: m`$N_{\mathrm{comp}}$ — o total da matriz`,
        entram: COMPARAVEIS_ENTRAM,
        ficamFora: COMPARAVEIS_SAEM,
        casosEspeciais: ['As três classes aparecem sempre, mesmo com contagem zero: nenhuma linha ou coluna é ocultada.', RE_UNRESOLVED, RE_OPERACIONAIS],
        fundamentos: [
            { natureza: 'definicao', texto: 'Tabela de contingência das classes de duas fontes sobre as mesmas observações.' },
            { natureza: 'identidade', texto: m`$\sum_i \sum_j n(i,j) = N_{\mathrm{comp}}$; $\mathrm{linha}_i = \sum_j n(i,j)$; $\mathrm{coluna}_j = \sum_i n(i,j)$.` },
            {
                natureza: 'definicao',
                texto: m`Leitura um-contra-os-outros (one-vs-rest) para cada classe $c$: $\mathrm{TP}_c = n(c,c)$; $\mathrm{FP}_c = \mathrm{coluna}_c - n(c,c)$; $\mathrm{FN}_c = \mathrm{linha}_c - n(c,c)$; $\mathrm{TN}_c = N_{\mathrm{comp}} - \mathrm{linha}_c - \mathrm{coluna}_c + n(c,c)$.`
            },
            {
                natureza: 'identidade',
                texto: m`$\sum_c \mathrm{FP}_c = \sum_c \mathrm{FN}_c = N_{\mathrm{comp}} - \sum_c n(c,c)$: todo erro é, ao mesmo tempo, um FP de uma classe e um FN de outra.`
            }
        ],
        teorema: TEOREMA_NAO_APLICAVEL,
        pressupostos: [RE_ROTULO_UNICO, RE_MESMO_ESPACO],
        justificativa: m`É a base de onde saem concordância, Precision, Recall, F1 e $\kappa$: com ela qualquer uma dessas métricas pode ser recalculada à mão.`,
        limitacoes: ['É uma tabela de contagens do conjunto avaliado; não estima erro amostral.']
    },
    {
        id: 'precision',
        nome: 'Precision por classe',
        metricas: ['precision'],
        implementada: true,
        oQueMede: 'Entre os planos que o Judge pôs na classe $c$, a fração que o Oráculo também pôs em $c$.',
        formula: [m`\mathrm{Precision}(c) = \frac{\mathrm{TP}_c}{\mathrm{TP}_c + \mathrm{FP}_c} = ${TEX.precision().rhs}`],
        funcao: 'razao',
        variaveis: [
            { simbolo: m`\mathrm{TP}_c`, significado: 'Oráculo = $c$ e Judge = $c$, isto é, $n(c,c)$' },
            { simbolo: m`\mathrm{FP}_c`, significado: m`Oráculo $\neq c$ e Judge = $c$, isto é, $\mathrm{coluna}_c - n(c,c)$` },
            COLUNA_C,
            N_CC
        ],
        numerador: m`$\mathrm{TP}_c = n(c,c)$`,
        denominador: m`$\mathrm{TP}_c + \mathrm{FP}_c = \mathrm{coluna}_c$ — tudo o que o Judge pôs na classe $c$`,
        entram: COMPARAVEIS_ENTRAM,
        ficamFora: COMPARAVEIS_SAEM,
        casosEspeciais: [
            m`$\mathrm{coluna}_c = 0$ (o Judge nunca atribuiu $c$): $\mathrm{Precision}(c)$ é indefinida e aparece como "—". A classe continua na tabela.`,
            RE_UNRESOLVED
        ],
        fundamentos: [
            { natureza: 'definicao', texto: 'Precision binária aplicada à transformação um-contra-os-outros da classe $c$ ($c$ contra todas as demais).' }
        ],
        teorema: TEOREMA_NAO_APLICAVEL,
        pressupostos: [RE_ROTULO_UNICO, RE_MESMO_ESPACO, 'O Oráculo é tomado como referência; a Precision descreve o Judge em relação a ele.'],
        justificativa: 'Mede a confiabilidade das atribuições do Judge à classe $c$: quando o Judge diz "VALID", com que frequência o Oráculo também diz.',
        limitacoes: ['Uma classe com coluna pequena tem Precision instável.']
    },
    {
        id: 'recall',
        nome: 'Recall por classe',
        metricas: ['recall'],
        implementada: true,
        oQueMede:
            'Entre os planos que o Oráculo pôs na classe $c$, a fração que o Judge também pôs em $c$. Recall(VALID): dos planos que o Oráculo julgou VALID, quantos o Judge também julgou VALID; o mesmo para INVALID e para UNRESOLVED.',
        formula: [m`\mathrm{Recall}(c) = \frac{\mathrm{TP}_c}{\mathrm{TP}_c + \mathrm{FN}_c} = ${TEX.recall().rhs}`],
        funcao: 'razao',
        variaveis: [
            { simbolo: m`\mathrm{TP}_c`, significado: 'Oráculo = $c$ e Judge = $c$, isto é, $n(c,c)$' },
            { simbolo: m`\mathrm{FN}_c`, significado: m`Oráculo = $c$ e Judge $\neq c$, isto é, $\mathrm{linha}_c - n(c,c)$` },
            LINHA_C,
            N_CC
        ],
        numerador: m`$\mathrm{TP}_c = n(c,c)$`,
        denominador: m`$\mathrm{TP}_c + \mathrm{FN}_c = \mathrm{linha}_c$ — tudo o que o Oráculo pôs na classe $c$ (o suporte)`,
        entram: COMPARAVEIS_ENTRAM,
        ficamFora: COMPARAVEIS_SAEM,
        casosEspeciais: [m`$\mathrm{linha}_c = 0$ (o Oráculo nunca atribuiu $c$): $\mathrm{Recall}(c)$ é indefinido e aparece como "—". A classe continua na tabela.`, RE_UNRESOLVED],
        fundamentos: [{ natureza: 'definicao', texto: 'Recall binário aplicado à transformação um-contra-os-outros da classe $c$.' }],
        teorema: TEOREMA_NAO_APLICAVEL,
        pressupostos: [RE_ROTULO_UNICO, RE_MESMO_ESPACO, 'O Oráculo é tomado como referência.'],
        justificativa: 'Mede a capacidade do Judge de recuperar os casos que a referência pôs em cada classe.',
        limitacoes: ['Uma classe com suporte pequeno tem Recall instável.']
    },
    {
        id: 'f1',
        nome: 'F1 por classe',
        metricas: ['f1'],
        implementada: true,
        oQueMede: 'A média harmônica entre $\\mathrm{Precision}(c)$ e $\\mathrm{Recall}(c)$.',
        formula: [m`\mathrm{F1}(c) = \frac{2 \cdot \mathrm{Precision}(c) \cdot \mathrm{Recall}(c)}{\mathrm{Precision}(c) + \mathrm{Recall}(c)}`],
        formaImplementada: [eqTex(TEX.f1()), m`\mathrm{F1}(c) = \frac{2\,\mathrm{TP}_c}{2\,\mathrm{TP}_c + \mathrm{FP}_c + \mathrm{FN}_c}`],
        funcao: 'f1',
        variaveis: [
            { simbolo: m`\mathrm{TP}_c`, significado: '$n(c,c)$' },
            LINHA_C,
            COLUNA_C,
            { simbolo: m`\mathrm{Precision}(c), \mathrm{Recall}(c)`, significado: 'as métricas acima' }
        ],
        numerador: m`$2\,\mathrm{TP}_c$`,
        denominador: m`$\mathrm{linha}_c + \mathrm{coluna}_c$ — o que o Oráculo e o que o Judge puseram na classe $c$, somados`,
        entram: COMPARAVEIS_ENTRAM,
        ficamFora: COMPARAVEIS_SAEM,
        casosEspeciais: [
            m`$\mathrm{linha}_c + \mathrm{coluna}_c = 0$ (a classe não aparece em nenhuma das duas fontes): $\mathrm{F1}(c)$ indefinido, "—".`,
            m`Classe que aparece em só uma das fontes ($\mathrm{TP}_c = 0$): $\mathrm{F1}(c) = 0$. A forma implementada dá 0 também quando só uma entre Precision e Recall é definida, evitando a indeterminação da forma $\frac{2PR}{P+R}$.`,
            RE_UNRESOLVED
        ],
        fundamentos: [
            { natureza: 'definicao', texto: 'Média harmônica de Precision e Recall da classe $c$.' },
            {
                natureza: 'identidade',
                texto: m`$\frac{2PR}{P + R} = \frac{2\,\mathrm{TP}}{2\,\mathrm{TP} + \mathrm{FP} + \mathrm{FN}} = \frac{2\,\mathrm{TP}}{\mathrm{linha}_c + \mathrm{coluna}_c}$, sempre que $P$ e $R$ são definidos e $P + R > 0$.`
            },
            {
                natureza: 'teorema',
                texto: m`Desigualdade entre as médias: média harmônica $\leq$ média aritmética, com igualdade só quando $P = R$. Por isso o F1 penaliza o desequilíbrio entre Precision e Recall (ex.: $P = 0{,}80$ e $R = 0{,}60$ dão $\mathrm{F1} \approx 0{,}686 < 0{,}70 = \frac{P + R}{2}$).`
            }
        ],
        teorema:
            'Não é necessário um teorema para definir o F1. A propriedade de penalizar o desequilíbrio entre Precision e Recall decorre da desigualdade entre as médias harmônica e aritmética.',
        pressupostos: [RE_ROTULO_UNICO, RE_MESMO_ESPACO],
        justificativa: 'Equilibra Precision e Recall numa medida só, sem deixar uma compensar a outra como faria a média aritmética.',
        limitacoes: ['F1 não é medida de calibração.', m`Ignora $\mathrm{TN}_c$ (os acertos fora da classe $c$).`]
    },
    {
        id: 'macroF1',
        nome: 'Macro F1',
        metricas: ['f1'],
        implementada: true,
        oQueMede: 'A média aritmética, sem ponderação, dos F1 das classes. Não é o F1 calculado sobre os totais (esse seria o micro-F1).',
        formula: [eqTex(TEX.macroF1)],
        funcao: 'mediaDosDefinidos',
        variaveis: [
            { simbolo: m`C^{*}`, significado: 'classes com F1 definido: as que aparecem em pelo menos uma das duas fontes' },
            { simbolo: 'K', significado: m`número de classes em $C^{*}$ (exibido junto ao valor)` },
            { simbolo: m`\mathrm{F1}(c)`, significado: 'o F1 da classe $c$' }
        ],
        numerador: m`$\sum_{c \in C^{*}} \mathrm{F1}(c)$`,
        denominador: m`$K = |C^{*}|$`,
        entram: 'As classes com F1 definido — inclusive as com F1 = 0.',
        ficamFora: 'Só a classe ausente nas duas fontes (F1 indefinido). Nenhuma classe é ocultada por ter frequência baixa ou F1 zero.',
        casosEspeciais: [m`$C^{*}$ vazio (nenhum par comparável): MacroF1 indefinido, "—".`, 'As classes consideradas são listadas na aplicação aos dados.'],
        fundamentos: [
            { natureza: 'definicao', texto: 'Média aritmética não ponderada dos F1 por classe.' },
            { natureza: 'propriedade', texto: 'Cada classe pesa $1/K$, independente do suporte: uma classe rara pesa tanto quanto a majoritária.' }
        ],
        teorema: TEOREMA_NAO_APLICAVEL,
        pressupostos: [RE_ROTULO_UNICO, RE_MESMO_ESPACO],
        justificativa: 'Evita que a classe majoritária domine a média — o desempenho em INVALID e UNRESOLVED conta tanto quanto em VALID.',
        limitacoes: ['Classes com suporte pequeno pesam o mesmo que as grandes: alta variância em conjuntos pequenos.']
    },
    {
        id: 'kappa',
        nome: "Cohen's κ (kappa)",
        metricas: ['kappa'],
        implementada: true,
        oQueMede: 'A concordância entre Oráculo e Judge descontado o acordo que se esperaria apenas a partir das distribuições marginais de cada fonte.',
        formula: [eqTex(TEX.kappa), eqTex(TEX.po), eqTex(TEX.pe)],
        funcao: 'kappa',
        variaveis: [
            { simbolo: 'P_o', significado: 'acordo observado (a mesma concordância $A$)' },
            { simbolo: 'P_e', significado: 'acordo esperado pelas marginais' },
            LINHA_C,
            COLUNA_C,
            N_COMP
        ],
        numerador: '$P_o - P_e$',
        denominador: '$1 - P_e$',
        entram: COMPARAVEIS_ENTRAM,
        ficamFora: COMPARAVEIS_SAEM,
        casosEspeciais: [
            m`$N_{\mathrm{comp}} = 0$: $P_o$ e $P_e$ não existem; $\kappa$ indefinido, "—".`,
            m`$P_e = 1$ (as duas fontes usaram uma única e mesma classe em todos os pares): $1 - P_e = 0$ e a razão não é definida; $\kappa$ aparece como "—" (null), nunca NaN ou Infinity.`
        ],
        fundamentos: [
            { natureza: 'definicao', texto: '$P_o$: proporção de pares na diagonal da matriz.' },
            {
                natureza: 'definicao',
                texto: '$P_e$: acordo esperado se as classes das duas fontes fossem combinadas ao acaso preservando a distribuição marginal de cada uma (produto das marginais, somado nas classes).'
            },
            {
                natureza: 'propriedade',
                texto: m`Com $P_e < 1$: $\kappa = 1 \iff P_o = 1$; $\kappa = 0 \iff P_o = P_e$; $\kappa < 0$ quando a concordância observada é menor que a esperada.`
            },
            {
                natureza: 'propriedade',
                texto: m`$\kappa$ depende das marginais: com uma classe muito frequente nas duas fontes, $P_e$ é alto, e $\kappa$ pode ser baixo mesmo com $P_o$ alto. Por isso $\kappa$ e a concordância podem diferir muito.`
            },
            { natureza: 'convencao', texto: m`Escalas qualitativas publicadas para $\kappa$ (faixas como "fraco", "excelente") são convenções, não leis. Esta análise não classifica o $\kappa$ em faixas.` }
        ],
        teorema: "Teorema específico: não aplicável. O κ de Cohen é uma estatística de concordância definida a partir do acordo observado e do acordo esperado pelas marginais.",
        pressupostos: [
            RE_ROTULO_UNICO,
            RE_MESMO_ESPACO,
            '$P_e$ é uma construção de referência (produto das marginais); não é uma afirmação de que Oráculo e Judge sejam independentes.',
            m`Nenhum intervalo de confiança ou teste de hipótese é calculado para $\kappa$.`
        ],
        justificativa: 'Complementa a concordância simples: separa o acordo que já viria das proporções de cada fonte do acordo além delas.',
        limitacoes: ['Sensível à prevalência das classes e ao desequilíbrio das marginais.', 'Instável com poucos pares comparáveis.']
    },
    {
        id: 'microF1',
        nome: 'Micro-F1',
        metricas: [],
        implementada: false,
        oQueMede: 'O F1 calculado sobre os totais de TP, FP e FN de todas as classes. Não é exibido nesta análise.',
        formula: [m`\mathrm{microF1} = \frac{2 \sum_c \mathrm{TP}_c}{2 \sum_c \mathrm{TP}_c + \sum_c \mathrm{FP}_c + \sum_c \mathrm{FN}_c}`],
        variaveis: [{ simbolo: m`\mathrm{TP}_c, \mathrm{FP}_c, \mathrm{FN}_c`, significado: 'as contagens um-contra-os-outros da matriz de confusão' }],
        numerador: m`$2 \sum_c \mathrm{TP}_c$`,
        denominador: m`$2 \sum_c \mathrm{TP}_c + \sum_c \mathrm{FP}_c + \sum_c \mathrm{FN}_c$`,
        entram: COMPARAVEIS_ENTRAM,
        ficamFora: COMPARAVEIS_SAEM,
        casosEspeciais: [
            'Condições da igualdade com a Accuracy: (1) cada plano tem exatamente um rótulo por fonte; (2) o mesmo espaço de classes nas duas fontes; (3) as mesmas observações nas duas contagens. Nesta análise as três valem por construção sobre os pares comparáveis (NOT_CALLED e NO_RESPONSE saem antes da matriz). Fora delas, a igualdade não é garantida.'
        ],
        fundamentos: [
            {
                natureza: 'identidade',
                texto: m`Sob as três condições, $\sum_c \mathrm{FP}_c = \sum_c \mathrm{FN}_c = N_{\mathrm{comp}} - \sum_c n(c,c)$; daí micro-Precision = micro-Recall = micro-F1 $= \sum_c n(c,c) / N_{\mathrm{comp}} = A$ (Accuracy relativa ao Oráculo).`
            }
        ],
        teorema: TEOREMA_NAO_APLICAVEL,
        pressupostos: [RE_ROTULO_UNICO, RE_MESMO_ESPACO],
        justificativa: 'Não é exibido: sob as condições acima, que valem aqui, repetiria a Accuracy relativa ao Oráculo.',
        limitacoes: ['Não implementado como métrica separada.']
    },
    {
        id: 'balancedAccuracy',
        nome: 'Balanced Accuracy',
        metricas: [],
        implementada: false,
        oQueMede: 'A média dos Recall por classe. Não é exibida nesta análise.',
        formula: [m`\mathrm{BA} = \frac{1}{K} \sum_{c} \mathrm{Recall}(c)`],
        variaveis: [
            { simbolo: m`\mathrm{Recall}(c)`, significado: 'o Recall da classe $c$' },
            { simbolo: 'K', significado: 'número de classes com Recall definido' }
        ],
        numerador: m`$\sum_c \mathrm{Recall}(c)$`,
        denominador: '$K$',
        entram: COMPARAVEIS_ENTRAM,
        ficamFora: COMPARAVEIS_SAEM,
        casosEspeciais: ['Não implementada. Os Recall por classe que ela usaria estão na tabela de Precision, Recall e F1.'],
        fundamentos: [{ natureza: 'definicao', texto: 'Média aritmética não ponderada dos Recall por classe.' }],
        teorema: TEOREMA_NAO_APLICAVEL,
        pressupostos: [RE_ROTULO_UNICO],
        justificativa: 'Seria útil com classes de frequências muito diferentes; esta versão expõe os Recall por classe e o Macro F1 no lugar dela.',
        limitacoes: ['Não implementada.']
    },
    {
        id: 'macroPrecisionRecall',
        nome: 'Macro Precision e Macro Recall',
        metricas: [],
        implementada: false,
        oQueMede: 'As médias não ponderadas da Precision e do Recall por classe. Não são exibidas nesta análise.',
        formula: [m`\mathrm{MacroP} = \frac{1}{K} \sum_{c} \mathrm{Precision}(c)`, m`\mathrm{MacroR} = \frac{1}{K} \sum_{c} \mathrm{Recall}(c)`],
        variaveis: [
            { simbolo: m`\mathrm{Precision}(c), \mathrm{Recall}(c)`, significado: 'as métricas por classe' },
            { simbolo: 'K', significado: 'número de classes com a métrica definida' }
        ],
        numerador: m`$\sum_c \mathrm{Precision}(c)$ ou $\sum_c \mathrm{Recall}(c)$`,
        denominador: '$K$',
        entram: COMPARAVEIS_ENTRAM,
        ficamFora: COMPARAVEIS_SAEM,
        casosEspeciais: ['Não implementadas. Os valores por classe estão na tabela de Precision, Recall e F1.'],
        fundamentos: [{ natureza: 'definicao', texto: 'Médias aritméticas não ponderadas das métricas por classe.' }],
        teorema: TEOREMA_NAO_APLICAVEL,
        pressupostos: [RE_ROTULO_UNICO],
        justificativa: 'A análise exibe o Macro F1, que já resume Precision e Recall por classe com peso igual.',
        limitacoes: ['Não implementadas.']
    }
];

export function documentacao(id: IdDocumentacao): DocumentacaoMetrica {
    return DOCUMENTACAO.find(d => d.id === id)!;
}

// =============================================================================
// Seções gerais
// =============================================================================

export interface ItemSecao {
    texto: string;
    natureza?: NaturezaFundamento;
}

export interface SecaoMetodologia {
    id: 'unidade' | 'tratamento' | 'propriedades' | 'limitacoes' | 'interpretacao' | 'avaliacaoHumana' | 'filtros';
    titulo: string;
    itens: readonly ItemSecao[];
}

export const SECOES_METODOLOGIA: readonly SecaoMetodologia[] = [
    {
        id: 'unidade',
        titulo: 'Unidade de análise',
        itens: [
            { texto: 'A observação é UM plano avaliado: uma linha do arquivo, de um lado (Arquitetura ou Baseline). Uma linha com os dois lados contribui com dois planos.' },
            { texto: 'Cada plano carrega, separadamente, o veredito do Oráculo, o estado do LLM Judge e — no futuro — a avaliação humana. Ausência de julgamento de uma fonte nunca é preenchida por suposição.' },
            { texto: 'N bruto: planos no recorte (depois dos filtros). N avaliável: planos com julgamento da fonte analisada (descritiva) ou com veredito da referência (comparativa). N excluído: os demais, sempre contados e exibidos.' },
            { texto: 'Arquitetura e Baseline são conjuntos separados: os recortes por modelo nunca somam os dois no mesmo denominador.' }
        ]
    },
    {
        id: 'tratamento',
        titulo: 'Tratamento dos dados (como a avaliação produz cada estado)',
        itens: [
            { texto: 'Plano vazio: Oráculo INVALID (origem: sintaxe); Judge NOT_CALLED.' },
            { texto: 'Sintaxe inválida (texto não vazio): Oráculo INVALID (origem: sintaxe); Judge NOT_CALLED — salvo com SPC_CML_AVALIAR_JULGAR_SINTAXE_INVALIDA=true, quando o Judge julga o texto.' },
            { texto: 'Falha técnica na sintaxe ou na recuperação do conhecimento: plano não avaliado, sem Oráculo e sem Judge. Fica fora de toda distribuição e de toda comparação (conta como "sem julgamento").' },
            {
                texto:
                    'Falha técnica na validação semântica: plano não avaliado, sem Oráculo — mas o veredito do Judge, já em curso, é preservado. Entra na distribuição do LLM Judge e na cobertura; fica fora da comparação. O card "Métricas" desconta todo plano não avaliado, por isso a contagem do Judge pode diferir dele.'
            },
            { texto: 'Falha do Judge: NO_RESPONSE; o Oráculo continua valendo.' },
            { texto: RE_UNRESOLVED },
            { texto: `${RE_OPERACIONAIS} Entram na distribuição do Judge, na taxa de resposta (NO_RESPONSE) e na cobertura.` },
            { texto: 'Valor fora do vocabulário de uma fonte: descartado na normalização, tratado como ausente — nunca convertido em outra classe.' },
            { texto: RE_NULL }
        ]
    },
    {
        id: 'propriedades',
        titulo: 'Propriedades matemáticas usadas',
        itens: [
            { natureza: 'identidade', texto: m`Proporções sobre o mesmo denominador somam 1: $\sum_c n_c / N = 1$.` },
            { natureza: 'identidade', texto: m`Matriz de confusão: $\sum_i \sum_j n(i,j) = N_{\mathrm{comp}}$; somas das linhas = suporte da referência; somas das colunas = atribuições do avaliador.` },
            {
                natureza: 'identidade',
                texto: m`One-vs-rest: $\mathrm{TP}_c + \mathrm{FP}_c = \mathrm{coluna}_c$; $\mathrm{TP}_c + \mathrm{FN}_c = \mathrm{linha}_c$; $\mathrm{TP}_c + \mathrm{FP}_c + \mathrm{FN}_c + \mathrm{TN}_c = N_{\mathrm{comp}}$.`
            },
            { natureza: 'identidade', texto: m`$\sum_c \mathrm{FP}_c = \sum_c \mathrm{FN}_c = N_{\mathrm{comp}} - \sum_c n(c,c)$ (rótulo único, mesmo espaço de classes).` },
            {
                natureza: 'identidade',
                texto: m`$\mathrm{Discordância} = 1 - \mathrm{Concordância}$ — só porque as duas usam exatamente os mesmos pares comparáveis e o mesmo denominador $N_{\mathrm{comp}}$.`
            },
            {
                natureza: 'teorema',
                texto: 'Desigualdade entre as médias (harmônica ≤ aritmética, igualdade só com valores iguais): fundamenta a propriedade do F1 de penalizar desequilíbrio entre Precision e Recall.'
            },
            { natureza: 'propriedade', texto: 'A média aritmética não ponderada (Macro F1) dá peso $1/K$ a cada classe, independentemente do suporte.' },
            { natureza: 'propriedade', texto: m`$\kappa$: com $P_e < 1$, $\kappa = 1 \iff P_o = 1$ e $\kappa = 0 \iff P_o = P_e$; $\kappa$ pode ser negativo.` },
            { natureza: 'identidade', texto: 'Micro-F1 = Accuracy sob rótulo único, mesmo espaço de classes e mesmas observações (não exibido).' },
            { natureza: 'propriedade', texto: m`As contagens se somam entre recortes disjuntos; proporções, F1 e $\kappa$ não.` }
        ]
    },
    {
        id: 'limitacoes',
        titulo: 'Limitações metodológicas',
        itens: [
            { texto: 'O Oráculo é a referência normativa do SPC-CML, não a verdade humana: "Accuracy relativa ao Oráculo" não é acurácia real.' },
            { texto: 'Concordância não implica correção: Oráculo e Judge podem errar juntos.' },
            { texto: m`$\kappa$ depende das distribuições marginais; não deve ser lido sozinho.` },
            { texto: 'F1 não é medida de calibração.' },
            { texto: 'Métricas agregadas escondem o comportamento por linha: a tabela "Por linha" mostra cada plano.' },
            { texto: 'Amostras pequenas produzem estimativas instáveis; nenhum intervalo de confiança ou teste de hipótese é calculado — as métricas descrevem o conjunto avaliado.' },
            { texto: 'Resultados agregados podem esconder diferenças entre domínios e entre modelos.' },
            { texto: 'Arquitetura e Baseline mantêm denominadores separados; compará-los é comparar duas proporções de bases diferentes.' }
        ]
    },
    {
        id: 'filtros',
        titulo: 'Filtros',
        itens: [
            { texto: 'Todas as métricas são recalculadas sobre o subconjunto dos filtros atuais (modelo, domínio): N, numeradores e denominadores mudam junto.' },
            { texto: 'Os valores possíveis dos filtros vêm dos dados, não do filtro aplicado.' }
        ]
    },
    {
        id: 'avaliacaoHumana',
        titulo: 'Relação com a futura avaliação humana',
        itens: [
            { texto: 'Hoje: Oráculo = referência normativa; LLM Judge = avaliador independente. No futuro: Humano = referência independente adicional (CORRETO, INCORRETO, INCOMPLETO por linha).' },
            { texto: m`A mesma comparação (matriz, concordância, Precision, Recall, F1, $\kappa$) poderá calcular LLM × Humano, Oráculo × Humano e Oráculo × LLM, e comparar as três fontes.` },
            { texto: 'Como as classes humanas e os vereditos têm espaços diferentes, essa comparação exige um mapeamento explícito entre eles — ainda não definido; nenhum mapeamento é assumido.' },
            { texto: 'Enquanto não houver dados humanos, nenhum valor humano é calculado nem exibido.' }
        ]
    },
    {
        id: 'interpretacao',
        titulo: 'Interpretação acadêmica',
        itens: [
            { texto: 'Apenas Oráculo e Apenas LLM Judge são análises DESCRITIVAS: respondem "como esta fonte classifica os planos?". Não medem concordância.' },
            { texto: 'Oráculo + LLM Judge é análise COMPARATIVA: responde "quanto o Judge concorda com a referência normativa?" e "em que direção diverge?".' },
            { texto: m`Uma concordância alta com $\kappa$ baixo indica que boa parte do acordo é explicada pelas proporções de cada fonte (ex.: as duas dizem VALID na maioria dos casos).` },
            { texto: 'Nenhum número aqui é, sozinho, evidência de correção dos planos: ele é a medida da relação entre fontes, ou da distribuição de uma fonte, no conjunto avaliado.' }
        ]
    }
];

// =============================================================================
// Fontes: o que cada opção do seletor usa e permite
// =============================================================================

export interface DescricaoFonte {
    id: FonteAnalise;
    rotulo: string;
    modo: 'descritiva' | 'comparativa';
    classificacao: string;
    entram: string;
    ficamFora: string;
    metricasValidas: string[];
    metricasSemSignificado: string[];
}

const DESCRICAO_FONTE: Record<FonteAnalise, Pick<DescricaoFonte, 'classificacao' | 'entram' | 'ficamFora'>> = {
    oraculo: {
        classificacao: 'Veredito normativo do Oráculo: VALID, INVALID, UNRESOLVED.',
        entram: 'Planos com veredito do Oráculo.',
        ficamFora: 'Planos não avaliados (falha técnica): sem veredito do Oráculo.'
    },
    llm: {
        classificacao: 'Estado do LLM Judge: VALID, INVALID, UNRESOLVED (vereditos) e NOT_CALLED, NO_RESPONSE (operacionais).',
        entram: 'Planos com algum estado do Judge — inclusive não avaliados por falha na semântica, cujo veredito do Judge é preservado.',
        ficamFora: 'Planos sem estado do Judge (não avaliados por falha na sintaxe ou na recuperação).'
    },
    oraculo_llm: {
        classificacao: 'Pares (Oráculo, Judge) com veredito nas duas fontes; o Oráculo é a referência.',
        entram: 'Na comparação: pares comparáveis. Nas distribuições e na cobertura: como nas opções descritivas.',
        ficamFora: 'Na comparação: planos sem veredito do Oráculo e planos com NOT_CALLED ou NO_RESPONSE.'
    },
    humana: {
        classificacao: 'Avaliação humana por plano: CORRETO, INCORRETO, INCOMPLETO (quando existir).',
        entram: 'Planos com avaliação humana registrada.',
        ficamFora: 'Planos sem avaliação humana — sem convertê-los em INCORRETO.'
    }
};

/** As quatro opções, com as métricas válidas e as sem significado derivadas de METRICAS_POR_FONTE. */
export function descreverFontes(): DescricaoFonte[] {
    const implementadas = DOCUMENTACAO.filter(d => d.implementada);
    return OPCOES_FONTE.map(o => {
        const metricas = METRICAS_POR_FONTE[o.id];
        return {
            id: o.id,
            rotulo: o.rotulo,
            modo: o.modo,
            ...DESCRICAO_FONTE[o.id],
            metricasValidas: implementadas.filter(d => d.metricas.some(x => metricas.includes(x))).map(d => d.nome),
            metricasSemSignificado: implementadas.filter(d => !d.metricas.some(x => metricas.includes(x))).map(d => d.nome)
        };
    });
}

// =============================================================================
// Aplicação aos dados
// =============================================================================

/**
 * Uma equação aplicada aos dados, na sequência fórmula → substituição →
 * resultado. `formula` é o lado direito montado por `TEX` (a mesma forma da
 * documentação, com a classe real no lugar de `c`).
 */
export interface EquacaoAplicada {
    lhs: string;
    formula: string;
    substituicao: string;
    resultado: string;
    /** Observação em texto corrido (ex.: por que o valor é indefinido). */
    nota?: string;
}

export interface PassoAplicado {
    id: IdDocumentacao;
    titulo: string;
    /** A aplicação em texto simples (sem LaTeX): versão textual e copiável dos mesmos números. */
    linhas: string[];
    /** Os dados que entram na conta — texto corrido, com `$…$` em linha e `$$…$$` em bloco. */
    dados: string[];
    /** As equações com os dados substituídos. */
    equacoes: EquacaoAplicada[];
}

export interface AplicacaoMetodologia {
    fonte: FonteAnalise;
    rotulo: string;
    modo: 'descritiva' | 'comparativa';
    disponivel: boolean;
    motivoIndisponivel?: string;
    /** A frase do recorte: quantos planos, depois de quais filtros. */
    recorte: string;
    contagens: { nBruto: number; nAvaliavel: number | null; nExcluido: number | null; rotuloAvaliavel: string };
    /** Documentações implementadas com significado na fonte selecionada. */
    ativas: IdDocumentacao[];
    /** Documentações implementadas SEM significado na fonte selecionada. */
    semSignificado: IdDocumentacao[];
    passos: PassoAplicado[];
}

export function formatarNumero(x: number | null | undefined, casas = 3): string {
    return x === null || x === undefined ? '—' : x.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}

function frac(p: Proporcao): string {
    const r = FORMULAS.razao(p.n, p.denominador);
    return r === null
        ? `${p.n} / ${p.denominador} → indefinido (denominador zero)`
        : `${p.n} / ${p.denominador} = ${formatarNumero(r)} (${formatarNumero(100 * r, 1)}%)`;
}

/** Uma equação de proporção: fórmula de `TEX`, n/denominador substituídos e o resultado. */
function eqProporcao(e: EquacaoTex, p: Proporcao, nota?: string): EquacaoAplicada {
    return { lhs: e.lhs, formula: e.rhs, substituicao: texFrac(p.n, p.denominador), resultado: texResultado(p), ...(nota ? { nota } : {}) };
}

const ROTULO_LADO = { arquitetura: 'Arquitetura', baseline: 'Baseline' } as const;

function passosComparacao(c: Comparacao): PassoAplicado[] {
    const classes = c.classes;
    const linha = (k: string) => c.porClasse[k].suporte;
    const coluna = (k: string) => classes.reduce((s, r) => s + c.matriz[r][k], 0);
    const diag = classes.map(k => c.matriz[k][k]);
    const somaDiag = diag.reduce((s, v) => s + v, 0);
    const N = c.comparaveis;
    const tc = texClasse;
    const dadosBase = m`$N_{\mathrm{comp}} = ${String(N)}$ pares comparáveis; $\sum_c n(c,c) = ${String(somaDiag)}$ (diagonal da matriz).`;
    const dadosColunas = `Totais por coluna (o que o Judge atribuiu): ${classes.map(k => m`$\mathrm{coluna}_{${tc(k)}} = ${String(coluna(k))}$`).join(', ')}.`;
    const dadosLinhas = `Totais por linha (o que o Oráculo atribuiu): ${classes.map(k => m`$\mathrm{linha}_{${tc(k)}} = ${String(linha(k))}$`).join(', ')}.`;
    const passos: PassoAplicado[] = [];

    passos.push({
        id: 'coberturaComparacao',
        titulo: 'Cobertura da comparação',
        linhas: [
            `N_ref = ${c.elegiveis} plano(s) com veredito do Oráculo; ${c.excluidos.semReferencia} sem veredito do Oráculo ficam fora.`,
            `N_comp = ${c.comparaveis} (saem ${c.excluidos.avaliadorSemVeredito} com NOT_CALLED ou NO_RESPONSE).`,
            `Cob_comp = N_comp / N_ref = ${frac(c.cobertura)}`
        ],
        dados: [
            m`$N_{\mathrm{ref}} = ${String(c.elegiveis)}$ plano(s) com veredito do Oráculo; ${String(c.excluidos.semReferencia)} sem veredito do Oráculo ficam fora.`,
            m`$N_{\mathrm{comp}} = ${String(N)}$: saem ${String(c.excluidos.avaliadorSemVeredito)} com NOT_CALLED ou NO_RESPONSE (estados operacionais, fora da comparação).`
        ],
        equacoes: [eqProporcao(TEX.coberturaComparacao, c.cobertura)]
    });

    const cabecalho = [m`\text{Oráculo}\downarrow \;/\; \text{Judge}\rightarrow`, ...classes.map(tc), m`\mathrm{linha}_c`].join(' & ');
    const corpo = classes
        .map(r => [tc(r), ...classes.map(a => (r === a ? m`\mathbf{${String(c.matriz[r][a])}}` : String(c.matriz[r][a]))), String(linha(r))].join(' & '))
        .join(m` \\ `);
    const rodape = [m`\mathrm{coluna}_c`, ...classes.map(a => String(coluna(a))), String(N)].join(' & ');
    passos.push({
        id: 'matrizConfusao',
        titulo: 'Matriz de confusão (linhas: Oráculo; colunas: Judge)',
        linhas: [
            ...classes.map(r => `Oráculo ${r}: ${classes.map(a => `n(${r},${a}) = ${c.matriz[r][a]}`).join(', ')}  →  linha_${r} = ${linha(r)}`),
            `colunas: ${classes.map(a => `coluna_${a} = ${coluna(a)}`).join(', ')}`,
            `total: Σ n(i,j) = ${c.comparaveis} = N_comp`
        ],
        dados: [
            m`$$\begin{array}{l|${'c'.repeat(classes.length)}|c} ${cabecalho} \\ \hline ${corpo} \\ \hline ${rodape} \end{array}$$`,
            'Em negrito, a diagonal: os pares em que Oráculo e Judge concordam.'
        ],
        equacoes: [{ lhs: TEX.total.lhs, formula: TEX.total.rhs, substituicao: classes.map(r => String(linha(r))).join(' + '), resultado: String(N) }]
    });

    passos.push({
        id: 'concordancia',
        titulo: 'Concordância com o Oráculo (Accuracy relativa ao Oráculo)',
        linhas: [`A = Σ n(c,c) / N_comp = (${diag.join(' + ')}) / ${c.comparaveis} = ${frac(c.concordancia)}`],
        dados: [`Diagonal da matriz: ${classes.map(k => m`$n(${tc(k)},${tc(k)}) = ${String(c.matriz[k][k])}$`).join(', ')}.`, dadosBase],
        equacoes: [
            {
                lhs: TEX.concordancia.lhs,
                formula: TEX.concordancia.rhs,
                substituicao: `${texFrac(diag.join(' + '), N)} = ${texFrac(somaDiag, N)}`,
                resultado: texResultado(c.concordancia)
            }
        ]
    });

    passos.push({
        id: 'discordancia',
        titulo: 'Discordância',
        linhas: [
            `D = (N_comp − Σ n(c,c)) / N_comp = (${c.comparaveis} − ${somaDiag}) / ${c.comparaveis} = ${frac(c.discordancia)}`,
            ...(c.discordancias.length === 0
                ? ['Nenhum par discordante.']
                : c.discordancias.map(d => `d(${d.de} → ${d.para}) = n(${d.de},${d.para}) / N_comp = ${frac(d.proporcao)}`))
        ],
        dados: [dadosBase, ...(c.discordancias.length === 0 ? ['Nenhum par discordante.'] : [])],
        equacoes: [
            { lhs: TEX.discordancia.lhs, formula: TEX.discordancia.rhs, substituicao: texFrac(`${N} - ${somaDiag}`, N), resultado: texResultado(c.discordancia) },
            ...c.discordancias.map(d => eqProporcao(TEX.tipoDiscordancia(tc(d.de), tc(d.para)), d.proporcao))
        ]
    });

    passos.push({
        id: 'precision',
        titulo: 'Precision por classe',
        linhas: classes.map(
            k => `Precision(${k}) = n(${k},${k}) / coluna_${k} = ${frac(c.porClasse[k].precision)}${coluna(k) === 0 ? ` — o Judge nunca atribuiu ${k}` : ''}`
        ),
        dados: [dadosColunas],
        equacoes: classes.map(k => eqProporcao(TEX.precision(tc(k)), c.porClasse[k].precision, coluna(k) === 0 ? `O Judge nunca atribuiu ${k}: denominador zero.` : undefined))
    });

    passos.push({
        id: 'recall',
        titulo: 'Recall por classe',
        linhas: classes.map(k => `Recall(${k}) = n(${k},${k}) / linha_${k} = ${frac(c.porClasse[k].recall)}${linha(k) === 0 ? ` — o Oráculo nunca atribuiu ${k}` : ''}`),
        dados: [dadosLinhas],
        equacoes: classes.map(k => eqProporcao(TEX.recall(tc(k)), c.porClasse[k].recall, linha(k) === 0 ? `O Oráculo nunca atribuiu ${k}: denominador zero.` : undefined))
    });

    passos.push({
        id: 'f1',
        titulo: 'F1 por classe',
        linhas: classes.map(k => {
            const tp = c.matriz[k][k];
            const f = FORMULAS.f1(tp, linha(k), coluna(k));
            return `F1(${k}) = 2·${tp} / (${linha(k)} + ${coluna(k)}) = ${2 * tp} / ${linha(k) + coluna(k)} = ${f === null ? 'indefinido (classe ausente nas duas fontes)' : formatarNumero(f)}`;
        }),
        dados: [dadosLinhas, dadosColunas],
        equacoes: classes.map(k => {
            const tp = c.matriz[k][k];
            const f = FORMULAS.f1(tp, linha(k), coluna(k));
            const e = TEX.f1(tc(k));
            return {
                lhs: e.lhs,
                formula: e.rhs,
                substituicao: `${texFrac(m`2 \cdot ${String(tp)}`, `${linha(k)} + ${coluna(k)}`)} = ${texFrac(2 * tp, linha(k) + coluna(k))}`,
                resultado: texNum(f),
                ...(f === null ? { nota: `${k} não aparece em nenhuma das duas fontes.` } : {})
            };
        })
    });

    const definidos = classes.filter(k => c.porClasse[k].f1 !== null);
    const fora = classes.filter(k => c.porClasse[k].f1 === null);
    passos.push({
        id: 'macroF1',
        titulo: 'Macro F1',
        linhas: [
            definidos.length === 0
                ? 'MacroF1 indefinido: nenhuma classe com F1 definido.'
                : `MacroF1 = (${definidos.map(k => `F1(${k})`).join(' + ')}) / ${definidos.length} = (${definidos.map(k => formatarNumero(c.porClasse[k].f1)).join(' + ')}) / ${definidos.length} = ${formatarNumero(c.macroF1.valor)}`,
            `classes consideradas (K = ${definidos.length}): ${definidos.join(', ') || '—'}`,
            fora.length > 0 ? `classes excluídas (ausentes nas duas fontes, F1 indefinido): ${fora.join(', ')}` : 'nenhuma classe excluída'
        ],
        dados: [
            m`Classes consideradas ($K = ${String(definidos.length)}$): ${definidos.join(', ') || '—'}.`,
            fora.length > 0 ? `Classes excluídas (ausentes nas duas fontes, F1 indefinido): ${fora.join(', ')}.` : 'Nenhuma classe excluída.'
        ],
        equacoes:
            definidos.length === 0
                ? []
                : [
                      {
                          lhs: TEX.macroF1.lhs,
                          formula: TEX.macroF1.rhs,
                          substituicao: texFrac(definidos.map(k => texNum(c.porClasse[k].f1)).join(' + '), definidos.length),
                          resultado: texNum(c.macroF1.valor)
                      }
                  ]
    });

    const { po, pe, valor } = c.kappa;
    const linhasKappa: string[] = [];
    const equacoesKappa: EquacaoAplicada[] = [];
    const dadosKappa: string[] = [];
    if (N === 0) {
        linhasKappa.push('κ não pode ser estimado neste conjunto porque não há pares comparáveis (N_comp = 0): P_o e P_e não existem.');
        dadosKappa.push(m`$\kappa$ não pode ser estimado neste conjunto porque não há pares comparáveis ($N_{\mathrm{comp}} = 0$): $P_o$ e $P_e$ não existem.`);
    } else {
        linhasKappa.push(`P_o = Σ n(c,c) / N_comp = ${somaDiag} / ${c.comparaveis} = ${formatarNumero(po)}`);
        const termos = classes.map(k => FORMULAS.razao(linha(k), c.comparaveis)! * FORMULAS.razao(coluna(k), c.comparaveis)!);
        linhasKappa.push(
            `P_e = Σ (linha_c / N_comp)·(coluna_c / N_comp) = ${classes.map(k => `(${linha(k)}/${c.comparaveis})·(${coluna(k)}/${c.comparaveis})`).join(' + ')}`
        );
        linhasKappa.push(`    = ${termos.map(t => formatarNumero(t, 4)).join(' + ')} = ${formatarNumero(pe, 4)}`);
        dadosKappa.push(dadosBase, dadosLinhas, dadosColunas);
        equacoesKappa.push({ lhs: TEX.po.lhs, formula: TEX.po.rhs, substituicao: texFrac(somaDiag, N), resultado: texNum(po) });
        equacoesKappa.push({
            lhs: TEX.pe.lhs,
            formula: TEX.pe.rhs,
            substituicao: `${classes.map(k => m`${texFrac(linha(k), N)} \cdot ${texFrac(coluna(k), N)}`).join(' + ')} = ${termos.map(t => texNum(t, 4)).join(' + ')}`,
            resultado: texNum(pe, 4)
        });
        const substKappa = texFrac(`${texNum(po, 4)} - ${texNum(pe, 4)}`, `1 - ${texNum(pe, 4)}`);
        if (valor === null) {
            linhasKappa.push('κ não pode ser estimado neste conjunto porque P_e = 1: as duas fontes usaram uma única e mesma classe em todos os pares, então 1 − P_e = 0.');
            equacoesKappa.push({
                lhs: TEX.kappa.lhs,
                formula: TEX.kappa.rhs,
                substituicao: substKappa,
                resultado: m`\text{indefinido}`,
                nota: 'κ não pode ser estimado neste conjunto porque P_e = 1: as duas fontes usaram uma única e mesma classe em todos os pares, então 1 − P_e = 0.'
            });
        } else {
            linhasKappa.push(`κ = (P_o − P_e) / (1 − P_e) = (${formatarNumero(po, 4)} − ${formatarNumero(pe, 4)}) / (1 − ${formatarNumero(pe, 4)}) = ${formatarNumero(valor)}`);
            equacoesKappa.push({ lhs: TEX.kappa.lhs, formula: TEX.kappa.rhs, substituicao: substKappa, resultado: texNum(valor) });
        }
    }
    passos.push({ id: 'kappa', titulo: "Cohen's κ", linhas: linhasKappa, dados: dadosKappa, equacoes: equacoesKappa });
    return passos;
}

/**
 * A metodologia aplicada à análise atual. Os números vêm da `Analise` (o mesmo
 * objeto que a tela exibe) e das funções de `FORMULAS`.
 */
export function aplicarMetodologia(analise: Analise, filtro: Filtro = {}): AplicacaoMetodologia {
    const implementadas = DOCUMENTACAO.filter(d => d.implementada);
    const ativas = implementadas.filter(d => d.metricas.some(x => analise.metricas.includes(x))).map(d => d.id);
    const semSignificado = implementadas.filter(d => !d.metricas.some(x => analise.metricas.includes(x))).map(d => d.id);
    const filtros = [filtro.lado ? `Modelo: ${ROTULO_LADO[filtro.lado]}` : '', filtro.dominio ? `Domínio: ${filtro.dominio}` : ''].filter(Boolean);
    const recorte = `Os valores abaixo foram calculados sobre ${analise.totalPlanos} plano(s) ${filtros.length > 0 ? `após os filtros atuais (${filtros.join(', ')})` : 'sem filtros'}.`;

    const base = { fonte: analise.fonte, rotulo: analise.opcao.rotulo, modo: analise.opcao.modo, recorte, ativas, semSignificado };
    if (!analise.disponivel || !analise.geral) {
        return {
            ...base,
            disponivel: false,
            motivoIndisponivel: analise.motivoIndisponivel,
            contagens: { nBruto: analise.totalPlanos, nAvaliavel: null, nExcluido: null, rotuloAvaliavel: 'sem dados da fonte' },
            passos: []
        };
    }

    const g = analise.geral;
    const passos: PassoAplicado[] = [];
    for (const d of g.distribuicoes) {
        const rotulo = FONTES[d.fonte].rotulo;
        passos.push({
            id: 'distribuicao',
            titulo: `Distribuição — ${rotulo}`,
            linhas: [
                `N_f = ${d.elegiveis} plano(s) com estado do ${rotulo}; ${d.semJulgamento} sem estado desta fonte ficam fora.`,
                ...Object.entries(d.porEstado).map(([estado, p]) => `p_${estado} = n_${estado} / N_f = ${frac(p)}`)
            ],
            dados: [`$N_f = ${d.elegiveis}$ plano(s) com estado do ${rotulo}; ${d.semJulgamento} sem estado desta fonte ficam fora.`],
            equacoes: Object.entries(d.porEstado).map(([estado, p]) => eqProporcao(TEX.proporcao(texClasse(estado)), p))
        });
    }
    if (g.coberturaJuiz) {
        const { taxaResposta, cobertura } = g.coberturaJuiz;
        passos.push({
            id: 'taxaRespostaJuiz',
            titulo: 'Taxa de resposta do Judge',
            linhas: [`TR = V_J / C_J = ${frac(taxaResposta)}`],
            dados: [m`$V_J = ${String(taxaResposta.n)}$ plano(s) com veredito do Judge; $C_J = ${String(taxaResposta.denominador)}$ plano(s) em que o Judge foi chamado (estado $\neq$ NOT_CALLED; NO_RESPONSE entra).`],
            equacoes: [eqProporcao(TEX.taxaResposta, taxaResposta)]
        });
        passos.push({
            id: 'coberturaJuiz',
            titulo: 'Cobertura do Judge',
            linhas: [`Cob_J = V_J / N = ${frac(cobertura)}`],
            dados: [`$V_J = ${cobertura.n}$ plano(s) com veredito do Judge; $N = ${cobertura.denominador}$ plano(s) no recorte.`],
            equacoes: [eqProporcao(TEX.coberturaJuiz, cobertura)]
        });
    }
    if (g.comparacao) passos.push(...passosComparacao(g.comparacao));

    const comparativa = analise.opcao.modo === 'comparativa' && g.comparacao;
    const dist = g.distribuicoes[0];
    const contagens = comparativa
        ? { nBruto: g.total, nAvaliavel: g.comparacao!.comparaveis, nExcluido: g.total - g.comparacao!.comparaveis, rotuloAvaliavel: 'pares comparáveis (veredito do Oráculo e do Judge)' }
        : { nBruto: g.total, nAvaliavel: dist?.elegiveis ?? 0, nExcluido: dist?.semJulgamento ?? g.total, rotuloAvaliavel: `planos com julgamento do ${dist ? FONTES[dist.fonte].rotulo : 'fonte'}` };

    return { ...base, disponivel: true, contagens, passos };
}

// =============================================================================
// Exemplo didático
// =============================================================================

/** Amostra artificial, para conferir a matemática à mão. NÃO é resultado do experimento. */
export const EXEMPLO_DIDATICO: readonly { oraculo: string; judge: string }[] = [
    { oraculo: 'VALID', judge: 'VALID' },
    { oraculo: 'VALID', judge: 'INVALID' },
    { oraculo: 'INVALID', judge: 'INVALID' },
    { oraculo: 'INVALID', judge: 'VALID' },
    { oraculo: 'UNRESOLVED', judge: 'UNRESOLVED' }
];

export function linhasDoExemploDidatico(): LinhaEntrada[] {
    return EXEMPLO_DIDATICO.map((e, i) => ({
        linha: i + 1,
        intencao: `exemplo ${i + 1}`,
        arquitetura: { naoAvaliado: false, oraculo: { veredito: e.oraculo }, julgamentoLLM: { status: e.judge } }
    }));
}

/** O exemplo didático passado pela MESMA camada analítica e pela MESMA aplicação. */
export function aplicacaoDidatica(): AplicacaoMetodologia {
    return aplicarMetodologia(analisar(normalizarLinhas(linhasDoExemploDidatico()), 'oraculo_llm'));
}

/** Classes de veredito, reexportadas para a UI montar tabelas sem depender da camada analítica. */
export const CLASSES_EXEMPLO = CLASSES_VEREDITO;
