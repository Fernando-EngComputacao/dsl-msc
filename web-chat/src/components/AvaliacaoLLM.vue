<script setup lang="ts">
import { computed, ref } from 'vue';
import type { RespostaAvaliacao } from '../api';
import {
    analisar,
    ESTADOS_OPERACIONAIS_JUIZ,
    FONTE_ANALISE_INICIAL,
    FONTES,
    fonteDisponivel,
    normalizarLinhas,
    OPCOES_FONTE,
    type BlocoAnalise,
    type Distribuicao,
    type FonteAnalise,
    type Filtro,
    type IdFonte,
    type Lado,
    type Proporcao
} from '../../../src/inference/analise-avaliacao';
import { texNum, type IdDocumentacao } from '../../../src/inference/metodologia-avaliacao';
import CartaoMetrica from './CartaoMetrica.vue';
import MetodologiaEstatistica from './MetodologiaEstatistica.vue';
import Tex from './Tex.vue';

/**
 * Sessão "Avaliação LLM": a análise estatística dos julgamentos JÁ gravados,
 * com um seletor de fonte. Nada aqui chama oráculo, juiz ou geração — trocar a
 * fonte só refaz `analisar` sobre os mesmos planos, e o que a análise não
 * devolve (métrica sem significado para a fonte) simplesmente não é desenhado.
 * Todo número exibido vem pronto da camada de cálculo; aqui só há apresentação.
 */
const props = defineProps<{ resposta: RespostaAvaliacao; dominio?: string }>();

const fonte = ref<FonteAnalise>(FONTE_ANALISE_INICIAL);
const filtroLado = ref<Lado | ''>('');
const filtroDominio = ref('');

/** Painel "(?)". Fica aqui, e não no painel, para que fonte e filtros sobrevivam a abrir e fechar. */
const metodologiaAberta = ref(false);
const metodologiaAncora = ref<IdDocumentacao | null>(null);
function abrirMetodologia(ancora: IdDocumentacao | null = null): void {
    metodologiaAncora.value = ancora;
    metodologiaAberta.value = true;
}

const planos = computed(() => normalizarLinhas(props.resposta.linhas, props.dominio));
const filtro = computed<Filtro>(() => ({
    ...(filtroLado.value ? { lado: filtroLado.value } : {}),
    ...(filtroDominio.value ? { dominio: filtroDominio.value } : {})
}));
const analise = computed(() => analisar(planos.value, fonte.value, filtro.value));
const disponivel = computed<Record<FonteAnalise, boolean>>(() =>
    Object.fromEntries(OPCOES_FONTE.map(o => [o.id, o.fontes.every(f => fonteDisponivel(planos.value, f))])) as Record<FonteAnalise, boolean>
);
const comparativa = computed(() => analise.value.opcao.modo === 'comparativa');
const geral = computed(() => analise.value.geral);
const comparacao = computed(() => geral.value?.comparacao);

const ROTULO_LADO: Record<Lado, string> = { arquitetura: 'Arquitetura', baseline: 'Baseline' };

// ---------------------------------------------------------------- filtros
const filtrosAtivos = computed(() => [
    ...(filtroLado.value ? [{ chave: 'lado' as const, rotulo: `Modelo: ${ROTULO_LADO[filtroLado.value]}` }] : []),
    ...(filtroDominio.value ? [{ chave: 'dominio' as const, rotulo: `Domínio: ${filtroDominio.value}` }] : [])
]);
function removerFiltro(chave: 'lado' | 'dominio'): void {
    if (chave === 'lado') filtroLado.value = '';
    else filtroDominio.value = '';
}
function limparFiltros(): void {
    filtroLado.value = '';
    filtroDominio.value = '';
}
const temFiltros = computed(() => analise.value.lados.length > 1 || analise.value.dominios.length > 1);

/** Contexto do cabeçalho: só o que está nos dados. */
const contexto = computed(() => [
    { rotulo: 'Observações', valor: `${analise.value.totalPlanos} plano(s)` },
    { rotulo: 'Domínio', valor: filtroDominio.value || analise.value.dominios.join(', ') || '—' },
    { rotulo: 'Modelo', valor: filtroLado.value ? ROTULO_LADO[filtroLado.value] : analise.value.lados.map(l => ROTULO_LADO[l]).join(' + ') || '—' }
]);

// ---------------------------------------------------------------- apresentação
const COR_ESTADO: Record<string, string> = {
    VALID: 'bg-emerald-500 dark:bg-emerald-400',
    CORRETO: 'bg-emerald-500 dark:bg-emerald-400',
    INVALID: 'bg-rose-500 dark:bg-rose-400',
    INCORRETO: 'bg-rose-500 dark:bg-rose-400',
    UNRESOLVED: 'bg-amber-400 dark:bg-amber-300',
    INCOMPLETO: 'bg-amber-400 dark:bg-amber-300'
};
/** NOT_CALLED e NO_RESPONSE: estados operacionais do Judge, desenhados à parte das classes. */
const ehOperacional = (e: string): boolean => (ESTADOS_OPERACIONAIS_JUIZ as readonly string[]).includes(e);
const corEstado = (e: string): string => COR_ESTADO[e] ?? 'listrado';

function pct(p: Proporcao | undefined): string {
    if (!p || p.percentual === null) return '—';
    return `${p.percentual.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}
function fracao(p: Proporcao | undefined): string {
    return p ? `${p.n}/${p.denominador}` : '—';
}
function num(x: number | null | undefined, casas = 3): string {
    return x === null || x === undefined ? '—' : x.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}
const rotuloFonte = (f: IdFonte): string => FONTES[f].rotulo;

/** Estados de uma distribuição: primeiro as classes, depois os estados operacionais. */
function estadosDe(d: Distribuicao): { classes: [string, Proporcao][]; operacionais: [string, Proporcao][] } {
    const todos = Object.entries(d.porEstado);
    return { classes: todos.filter(([e]) => !ehOperacional(e)), operacionais: todos.filter(([e]) => ehOperacional(e)) };
}

/** Por que o κ não foi estimado — lido do que a camada devolveu (sem recalcular). */
const motivoKappa = computed(() => {
    const c = comparacao.value;
    if (!c || c.kappa.valor !== null) return null;
    return c.comparaveis === 0 ? 'Não estimável: nenhum par comparável.' : 'Não estimável: P_e = 1 (as duas fontes usaram uma única e mesma classe).';
});

// Matriz: a intensidade da cor é só codificação visual da contagem (célula / maior célula).
const celulaAtiva = ref<{ r: string; a: string } | null>(null);
const maiorCelula = computed(() => {
    const c = comparacao.value;
    if (!c) return 1;
    return Math.max(1, ...c.classes.flatMap(r => c.classes.map(a => c.matriz[r][a])));
});
function estiloCelula(r: string, a: string, n: number): Record<string, string> {
    const alfa = n === 0 ? 0 : 0.1 + 0.55 * (n / maiorCelula.value);
    return { backgroundColor: r === a ? `rgba(16, 185, 129, ${alfa})` : `rgba(244, 63, 94, ${alfa * 0.85})` };
}

/** Linhas das tabelas por modelo e por domínio, com as colunas do modo da análise. */
interface Grupo {
    rotulo: string;
    bloco: BlocoAnalise;
}
const gruposModelo = computed<Grupo[]>(() =>
    (Object.entries(analise.value.porModelo) as [Lado, BlocoAnalise][]).map(([lado, bloco]) => ({ rotulo: ROTULO_LADO[lado], bloco }))
);
const gruposDominio = computed<Grupo[]>(() => Object.entries(analise.value.porDominio).map(([d, bloco]) => ({ rotulo: d, bloco })));
const tabelasGrupo = computed(() => [
    { titulo: 'Por modelo (Arquitetura × Baseline)', grupos: gruposModelo.value },
    { titulo: 'Por domínio', grupos: gruposDominio.value }
]);
/** Colunas da tabela por grupo no modo descritivo: os estados da fonte analisada. */
const estadosDescritiva = computed(() => Object.keys(geral.value?.distribuicoes[0]?.porEstado ?? {}));

const CARTAO = 'min-w-0 rounded-2xl border border-neutral-200 bg-white p-4 sm:p-5 dark:border-white/10 dark:bg-white/[0.02]';
const SOBRETITULO = 'text-[10.5px] font-semibold tracking-[0.12em] text-neutral-500 uppercase dark:text-neutral-400';
const TH = 'px-3 py-2 text-[10.5px] font-semibold tracking-wider text-neutral-500 uppercase dark:text-neutral-400';
const BOTAO_AJUDA =
    'inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-neutral-300 text-[10px] font-semibold text-neutral-400 transition-colors hover:border-blue-500 hover:text-blue-600 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:border-white/20 dark:text-neutral-500 dark:hover:border-blue-400 dark:hover:text-blue-300';
</script>

<template>
    <section class="flex w-full flex-col gap-5" aria-label="Análise estatística">
        <!-- Cabeçalho -->
        <header class="flex flex-col gap-3">
            <div class="flex items-start gap-3">
                <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" />
                    </svg>
                </div>
                <div class="min-w-0">
                    <p :class="SOBRETITULO">Painel experimental · SPC-CML</p>
                    <p class="flex items-center gap-2 text-lg font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
                        Análise Estatística
                        <button
                            type="button"
                            :class="BOTAO_AJUDA"
                            aria-label="Metodologia estatística"
                            title="Metodologia estatística: fórmulas, denominadores e casos especiais"
                            data-testid="abrir-metodologia"
                            @click="abrirMetodologia()"
                        >?</button>
                    </p>
                    <p class="text-sm text-neutral-500 dark:text-neutral-400">
                        {{ comparativa
                            ? 'Comparação experimental entre as decisões do LLM Judge e o Oráculo de referência.'
                            : 'Descrição dos julgamentos de uma única fonte — sem comparação entre fontes.' }}
                    </p>
                </div>
            </div>
            <dl class="flex flex-wrap gap-2 text-xs">
                <div class="flex items-center gap-1.5 rounded-full border border-neutral-200 px-2.5 py-1 dark:border-white/10">
                    <dt class="text-neutral-400 dark:text-neutral-500">Fonte</dt>
                    <dd class="font-medium text-neutral-800 dark:text-neutral-100">{{ analise.opcao.rotulo }}</dd>
                </div>
                <div class="flex items-center gap-1.5 rounded-full border border-neutral-200 px-2.5 py-1 dark:border-white/10">
                    <dt class="text-neutral-400 dark:text-neutral-500">Modo</dt>
                    <dd class="font-medium text-neutral-800 dark:text-neutral-100">{{ comparativa ? 'comparativo' : 'descritivo' }}</dd>
                </div>
                <div v-for="c in contexto" :key="c.rotulo" class="flex items-center gap-1.5 rounded-full border border-neutral-200 px-2.5 py-1 dark:border-white/10">
                    <dt class="text-neutral-400 dark:text-neutral-500">{{ c.rotulo }}</dt>
                    <dd class="font-medium text-neutral-800 tabular-nums dark:text-neutral-100">{{ c.valor }}</dd>
                </div>
                <div
                    class="flex items-center gap-1.5 rounded-full px-2.5 py-1"
                    :class="analise.disponivel ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300'"
                >
                    <span class="h-1.5 w-1.5 rounded-full" :class="analise.disponivel ? 'bg-emerald-500' : 'bg-amber-500'" aria-hidden="true"></span>
                    {{ analise.disponivel ? 'Dados disponíveis' : 'Sem dados da fonte' }}
                </div>
            </dl>
        </header>

        <MetodologiaEstatistica :aberto="metodologiaAberta" :analise="analise" :filtro="filtro" :ancora="metodologiaAncora" @fechar="metodologiaAberta = false" />

        <!-- Fonte e recorte -->
        <div :class="CARTAO">
            <p id="fonte-analise" class="mb-3" :class="SOBRETITULO">Fonte da análise</p>
            <div role="radiogroup" aria-labelledby="fonte-analise" class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <label
                    v-for="o in OPCOES_FONTE"
                    :key="o.id"
                    class="relative flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-3 transition-all has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-blue-500"
                    :class="fonte === o.id
                        ? 'border-blue-500 bg-blue-50/70 ring-1 ring-blue-500/40 dark:border-blue-400 dark:bg-blue-500/10'
                        : 'border-neutral-200 bg-white hover:border-neutral-400 dark:border-white/10 dark:bg-transparent dark:hover:border-white/30'"
                >
                    <input v-model="fonte" type="radio" name="fonte-analise" :value="o.id" class="sr-only" />
                    <span
                        class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                        :class="fonte === o.id ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300' : 'bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300'"
                        aria-hidden="true"
                    >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <template v-if="o.id === 'oraculo'"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></template>
                            <template v-else-if="o.id === 'llm'"><rect x="5" y="5" width="14" height="14" rx="3" /><path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" /></template>
                            <template v-else-if="o.id === 'oraculo_llm'"><path d="M12 3v18" /><path d="M5 7h14" /><path d="M5 7l-3 7a4 4 0 0 0 6 0z" /><path d="M19 7l-3 7a4 4 0 0 0 6 0z" /></template>
                            <template v-else><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></template>
                        </svg>
                    </span>
                    <span class="min-w-0">
                        <span class="block text-sm font-medium">{{ o.rotulo }}</span>
                        <span v-if="!disponivel[o.id]" class="mt-0.5 block text-[11px]" :class="'text-amber-700 dark:text-amber-300'">
                            Indisponível — {{ o.id === 'humana' ? 'nenhum dado de avaliação humana encontrado.' : 'sem julgamentos desta fonte nos dados.' }}
                        </span>
                        <span v-else class="mt-0.5 block text-[11px]" :class="'text-neutral-500 dark:text-neutral-400'">
                            {{ o.modo === 'comparativa' ? 'comparativa' : 'descritiva' }}
                        </span>
                    </span>
                </label>
            </div>

            <p class="mt-3 text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
                <span class="font-semibold text-neutral-800 dark:text-neutral-100">{{ comparativa ? 'Análise comparativa' : 'Análise descritiva' }}.</span>
                {{ analise.opcao.descricao }}
            </p>

            <!-- Recorte (só quando há o que escolher) -->
            <div v-if="temFiltros" class="mt-4 flex flex-col gap-2 border-t border-neutral-100 pt-4 sm:flex-row sm:flex-wrap sm:items-center dark:border-white/5">
                <span :class="SOBRETITULO" class="sm:mr-1">Recorte</span>
                <label v-if="analise.lados.length > 1" class="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
                    Modelo
                    <select v-model="filtroLado" class="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:border-white/10 dark:bg-neutral-900">
                        <option value="">Todos</option>
                        <option v-for="l in analise.lados" :key="l" :value="l">{{ ROTULO_LADO[l] }}</option>
                    </select>
                </label>
                <label v-if="analise.dominios.length > 1" class="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
                    Domínio
                    <select v-model="filtroDominio" class="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:border-white/10 dark:bg-neutral-900">
                        <option value="">Todos</option>
                        <option v-for="d in analise.dominios" :key="d" :value="d">{{ d }}</option>
                    </select>
                </label>
                <div v-if="filtrosAtivos.length" class="flex flex-wrap items-center gap-1.5 sm:ml-auto">
                    <span v-for="f in filtrosAtivos" :key="f.chave" class="inline-flex items-center gap-1 rounded-full bg-blue-50 py-0.5 pr-1 pl-2.5 text-[11px] font-medium text-blue-800 dark:bg-blue-500/15 dark:text-blue-200">
                        {{ f.rotulo }}
                        <button
                            type="button"
                            class="flex h-4 w-4 items-center justify-center rounded-full hover:bg-blue-200/70 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:hover:bg-blue-400/30"
                            :aria-label="`Remover filtro ${f.rotulo}`"
                            @click="removerFiltro(f.chave)"
                        >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                        </button>
                    </span>
                    <button v-if="filtrosAtivos.length > 1" type="button" class="text-[11px] text-neutral-500 underline-offset-2 hover:text-neutral-800 hover:underline dark:text-neutral-400 dark:hover:text-neutral-100" @click="limparFiltros">
                        Limpar filtros
                    </button>
                </div>
            </div>
        </div>

        <!-- Fonte sem dados -->
        <div v-if="!analise.disponivel" class="flex flex-col items-center rounded-2xl border border-dashed border-neutral-300 px-6 py-10 text-center dark:border-white/15">
            <div class="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-neutral-100 text-neutral-400 dark:bg-white/5 dark:text-neutral-500" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <template v-if="fonte === 'humana'"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></template>
                    <template v-else><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></template>
                </svg>
            </div>
            <template v-if="fonte === 'humana'">
                <p :class="SOBRETITULO">Avaliação humana</p>
                <p class="mt-1 text-sm font-medium text-neutral-800 dark:text-neutral-100">Ainda não existem avaliações humanas disponíveis para este conjunto de dados.</p>
                <p class="mt-1 max-w-md text-xs text-neutral-500 dark:text-neutral-400">
                    A avaliação humana está prevista metodologicamente, mas ainda não existe dado humano disponível. Nenhum valor é calculado, e a ausência de avaliação nunca é tratada como INCORRETO.
                </p>
            </template>
            <p class="mt-3 text-xs text-neutral-500 dark:text-neutral-400">{{ analise.motivoIndisponivel }}</p>
            <button
                type="button"
                class="mt-4 rounded-full border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:border-neutral-500 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:border-white/15 dark:text-neutral-200 dark:hover:border-white/40"
                @click="abrirMetodologia()"
            >Ver a metodologia prevista</button>
        </div>

        <template v-else-if="geral">
            <!-- Indicadores: análise comparativa -->
            <div v-if="comparacao" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <CartaoMetrica
                    :titulo="`Concordância com o ${rotuloFonte(comparacao.referencia)}`"
                    :valor="pct(comparacao.concordancia)"
                    :contexto="`${fracao(comparacao.concordancia)} pares comparáveis`"
                    descricao="Concordância observada (Accuracy relativa ao Oráculo)"
                    ancora="concordancia"
                    @ajuda="abrirMetodologia"
                />
                <CartaoMetrica
                    class="sm:col-span-2"
                    titulo="Cohen's κ"
                    :valor="num(comparacao.kappa.valor)"
                    :contexto="`N = ${comparacao.comparaveis} pares comparáveis`"
                    :descricao="motivoKappa ?? 'Concordância além do acordo esperado pelas marginais'"
                    ancora="kappa"
                    destaque
                    @ajuda="abrirMetodologia"
                >
                    <div v-if="comparacao.kappa.po !== null" class="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-blue-200/70 pt-2.5 text-sm text-neutral-800 dark:border-blue-400/20 dark:text-neutral-100">
                        <span title="Acordo observado"><Tex :tex="`P_o = ${texNum(comparacao.kappa.po)}`" /></span>
                        <span title="Acordo esperado pelas marginais"><Tex :tex="`P_e = ${texNum(comparacao.kappa.pe)}`" /></span>
                        <span class="text-neutral-500 dark:text-neutral-400"><Tex tex="\kappa = \frac{P_o - P_e}{1 - P_e}" /></span>
                    </div>
                </CartaoMetrica>
                <CartaoMetrica
                    titulo="Macro F1"
                    :valor="num(comparacao.macroF1.valor)"
                    :contexto="`média sobre K = ${comparacao.macroF1.classesConsideradas.length} classe(s)`"
                    descricao="Média não ponderada dos F1 por classe"
                    ancora="macroF1"
                    @ajuda="abrirMetodologia"
                />
                <CartaoMetrica
                    titulo="Discordância"
                    :valor="pct(comparacao.discordancia)"
                    :contexto="`${fracao(comparacao.discordancia)} pares comparáveis`"
                    descricao="Pares fora da diagonal da matriz"
                    ancora="discordancia"
                    @ajuda="abrirMetodologia"
                />
                <CartaoMetrica
                    titulo="Cobertura da comparação"
                    :valor="pct(comparacao.cobertura)"
                    :contexto="`${fracao(comparacao.cobertura)} com veredito do ${rotuloFonte(comparacao.referencia)}`"
                    descricao="Quanto da referência a comparação alcança"
                    ancora="coberturaComparacao"
                    @ajuda="abrirMetodologia"
                />
                <template v-if="geral.coberturaJuiz">
                    <CartaoMetrica
                        titulo="Taxa de resposta do Judge"
                        :valor="pct(geral.coberturaJuiz.taxaResposta)"
                        :contexto="`${fracao(geral.coberturaJuiz.taxaResposta)} com veredito / chamados`"
                        descricao="Operacional: NO_RESPONSE conta como falha"
                        ancora="taxaRespostaJuiz"
                        @ajuda="abrirMetodologia"
                    />
                    <CartaoMetrica
                        titulo="Cobertura do Judge"
                        :valor="pct(geral.coberturaJuiz.cobertura)"
                        :contexto="`${fracao(geral.coberturaJuiz.cobertura)} com veredito / planos do recorte`"
                        descricao="Operacional: inclui NOT_CALLED no denominador"
                        ancora="coberturaJuiz"
                        @ajuda="abrirMetodologia"
                    />
                </template>
            </div>

            <!-- Indicadores: análise descritiva -->
            <div v-else class="grid gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(190px,1fr))]">
                <CartaoMetrica titulo="Observações" :valor="String(geral.total)" contexto="planos no recorte" :descricao="geral.naoAvaliados > 0 ? `${geral.naoAvaliados} não avaliado(s) por falha técnica` : 'nenhum não avaliado'" />
                <CartaoMetrica
                    v-for="d in geral.distribuicoes"
                    :key="`n-${d.fonte}`"
                    :titulo="`Com julgamento — ${rotuloFonte(d.fonte)}`"
                    :valor="String(d.elegiveis)"
                    :contexto="`de ${geral.total} plano(s) no recorte`"
                    :descricao="d.semJulgamento > 0 ? `${d.semJulgamento} sem julgamento desta fonte (fora da conta)` : 'todos com julgamento'"
                    ancora="distribuicao"
                    @ajuda="abrirMetodologia"
                />
                <template v-if="geral.coberturaJuiz">
                    <CartaoMetrica
                        titulo="Taxa de resposta do Judge"
                        :valor="pct(geral.coberturaJuiz.taxaResposta)"
                        :contexto="`${fracao(geral.coberturaJuiz.taxaResposta)} com veredito / chamados`"
                        descricao="Operacional: NO_RESPONSE conta como falha"
                        ancora="taxaRespostaJuiz"
                        @ajuda="abrirMetodologia"
                    />
                    <CartaoMetrica
                        titulo="Cobertura do Judge"
                        :valor="pct(geral.coberturaJuiz.cobertura)"
                        :contexto="`${fracao(geral.coberturaJuiz.cobertura)} com veredito / planos do recorte`"
                        descricao="Operacional: inclui NOT_CALLED no denominador"
                        ancora="coberturaJuiz"
                        @ajuda="abrirMetodologia"
                    />
                </template>
            </div>

            <!-- Quem ficou fora da comparação -->
            <div v-if="comparacao" class="flex items-start gap-2.5 rounded-xl bg-neutral-50 px-4 py-3 text-xs text-neutral-600 dark:bg-white/[0.03] dark:text-neutral-300">
                <svg class="mt-0.5 shrink-0 text-neutral-400" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
                <p>
                    <span class="font-medium text-neutral-800 dark:text-neutral-100">Fora da comparação:</span>
                    {{ comparacao.excluidos.semReferencia }} plano(s) sem veredito do {{ rotuloFonte(comparacao.referencia) }} (inclui não avaliados)
                    · {{ comparacao.excluidos.avaliadorSemVeredito }} sem veredito do {{ rotuloFonte(comparacao.avaliador) }} — NOT_CALLED ou NO_RESPONSE, estados operacionais que não são classes semânticas e não entram na matriz.
                </p>
            </div>

            <!-- Distribuições -->
            <div :class="CARTAO">
                <div class="mb-4 flex items-center justify-between gap-2">
                    <div>
                        <p :class="SOBRETITULO">Distribuições</p>
                        <p class="text-sm font-medium text-neutral-800 dark:text-neutral-100">{{ comparativa ? 'Como cada fonte distribui os planos' : 'Como a fonte distribui os planos' }}</p>
                    </div>
                    <button type="button" :class="BOTAO_AJUDA" aria-label="Metodologia: distribuição das classes" title="Como é calculado" @click="abrirMetodologia('distribuicao')">?</button>
                </div>
                <div class="grid gap-6" :class="geral.distribuicoes.length > 1 ? 'md:grid-cols-2' : ''">
                    <div v-for="d in geral.distribuicoes" :key="d.fonte" class="min-w-0">
                        <p class="text-sm font-medium text-neutral-800 dark:text-neutral-100">Distribuição — {{ rotuloFonte(d.fonte) }}</p>
                        <p class="mb-2.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                            denominador: {{ d.elegiveis }} plano(s) com julgamento desta fonte<span v-if="d.semJulgamento > 0"> · {{ d.semJulgamento }} sem julgamento (fora da conta)</span>
                        </p>
                        <!-- Barra empilhada: 100% = planos com julgamento da fonte -->
                        <div class="mb-3 flex h-2.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-white/5" role="img" :aria-label="`Distribuição — ${rotuloFonte(d.fonte)}`">
                            <div
                                v-for="(p, estado) in d.porEstado"
                                v-show="(p.percentual ?? 0) > 0"
                                :key="estado"
                                class="h-full transition-[width] duration-500"
                                :class="corEstado(String(estado))"
                                :style="{ width: `${p.percentual ?? 0}%` }"
                                :title="`${estado}: ${fracao(p)} · ${pct(p)}`"
                            ></div>
                        </div>
                        <div class="flex flex-col gap-1">
                            <div v-for="[estado, p] in estadosDe(d).classes" :key="estado" class="flex items-center justify-between gap-3 rounded-md px-1.5 py-0.5 text-xs hover:bg-neutral-50 dark:hover:bg-white/[0.03]">
                                <span class="flex items-center gap-2"><span class="h-2 w-2 rounded-sm" :class="corEstado(estado)" aria-hidden="true"></span><span class="font-mono text-neutral-700 dark:text-neutral-200">{{ estado }}</span></span>
                                <span class="tabular-nums text-neutral-500 dark:text-neutral-400">{{ fracao(p) }} · <span class="font-semibold text-neutral-900 dark:text-neutral-50">{{ pct(p) }}</span></span>
                            </div>
                            <template v-if="estadosDe(d).operacionais.length">
                                <p class="mt-1.5 border-t border-dashed border-neutral-200 px-1.5 pt-1.5 text-[10px] font-semibold tracking-wider text-neutral-400 uppercase dark:border-white/10 dark:text-neutral-500">
                                    Estados operacionais — não são classes semânticas
                                </p>
                                <div v-for="[estado, p] in estadosDe(d).operacionais" :key="estado" class="flex items-center justify-between gap-3 rounded-md px-1.5 py-0.5 text-xs hover:bg-neutral-50 dark:hover:bg-white/[0.03]">
                                    <span class="flex items-center gap-2"><span class="listrado h-2 w-2 rounded-sm" aria-hidden="true"></span><span class="font-mono text-neutral-500 dark:text-neutral-400">{{ estado }}</span></span>
                                    <span class="tabular-nums text-neutral-500 dark:text-neutral-400">{{ fracao(p) }} · <span class="font-medium text-neutral-700 dark:text-neutral-200">{{ pct(p) }}</span></span>
                                </div>
                            </template>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Comparação: Oráculo (referência) × Judge (avaliador) -->
            <template v-if="comparacao">
                <div class="grid gap-5 lg:grid-cols-5">
                    <!-- Matriz de confusão -->
                    <div class="lg:col-span-3" :class="CARTAO">
                        <div class="mb-3 flex items-start justify-between gap-2">
                            <div>
                                <p :class="SOBRETITULO">Matriz de confusão</p>
                                <p class="text-xs text-neutral-500 dark:text-neutral-400">
                                    {{ rotuloFonte(comparacao.referencia) }} = referência · {{ rotuloFonte(comparacao.avaliador) }} = avaliação experimental · <Tex tex="N_{\mathrm{comp}}" /> = {{ comparacao.comparaveis }}
                                </p>
                            </div>
                            <button type="button" :class="BOTAO_AJUDA" aria-label="Metodologia: matriz de confusão" title="Como é calculado" @click="abrirMetodologia('matrizConfusao')">?</button>
                        </div>
                        <div class="overflow-x-auto">
                            <table class="w-full min-w-[380px] border-separate border-spacing-1 text-xs" @mouseleave="celulaAtiva = null">
                                <thead>
                                    <tr>
                                        <th></th>
                                        <th :colspan="comparacao.classes.length" class="pb-1 text-center text-[10.5px] font-semibold tracking-wider text-neutral-500 uppercase dark:text-neutral-400">
                                            {{ rotuloFonte(comparacao.avaliador) }} →
                                        </th>
                                        <th></th>
                                    </tr>
                                    <tr>
                                        <th class="pr-2 text-left text-[10.5px] font-semibold tracking-wider text-neutral-500 uppercase dark:text-neutral-400">{{ rotuloFonte(comparacao.referencia) }} ↓</th>
                                        <th
                                            v-for="a in comparacao.classes"
                                            :key="a"
                                            class="px-1 pb-1 text-center font-mono text-[11px] font-medium transition-colors"
                                            :class="celulaAtiva?.a === a ? 'text-neutral-900 dark:text-white' : 'text-neutral-500 dark:text-neutral-400'"
                                        >{{ a }}</th>
                                        <th class="pl-1 text-right text-[10.5px] font-normal text-neutral-400 dark:text-neutral-500" title="Soma da linha: o suporte da classe na referência">suporte</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="r in comparacao.classes" :key="r">
                                        <th
                                            scope="row"
                                            class="pr-2 text-left font-mono text-[11px] font-medium transition-colors"
                                            :class="celulaAtiva?.r === r ? 'text-neutral-900 dark:text-white' : 'text-neutral-600 dark:text-neutral-300'"
                                        >{{ r }}</th>
                                        <td
                                            v-for="a in comparacao.classes"
                                            :key="a"
                                            tabindex="0"
                                            class="h-14 rounded-lg text-center align-middle text-base font-semibold tabular-nums ring-inset transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                                            :class="[
                                                r === a ? 'ring-1 ring-emerald-600/30 dark:ring-emerald-400/30' : 'ring-1 ring-neutral-200 dark:ring-white/10',
                                                celulaAtiva?.r === r && celulaAtiva?.a === a ? 'ring-2 ring-neutral-900 dark:ring-white' : '',
                                                comparacao.matriz[r][a] === 0 ? 'text-neutral-300 dark:text-neutral-600' : 'text-neutral-900 dark:text-white'
                                            ]"
                                            :style="estiloCelula(r, a, comparacao.matriz[r][a])"
                                            :title="`${rotuloFonte(comparacao.referencia)}: ${r} · ${rotuloFonte(comparacao.avaliador)}: ${a} · N = ${comparacao.matriz[r][a]}`"
                                            :aria-label="`${rotuloFonte(comparacao.referencia)} ${r}, ${rotuloFonte(comparacao.avaliador)} ${a}: ${comparacao.matriz[r][a]} plano(s)${r === a ? ', concordância' : ', discordância'}`"
                                            @mouseenter="celulaAtiva = { r, a }"
                                            @focus="celulaAtiva = { r, a }"
                                            @blur="celulaAtiva = null"
                                        >{{ comparacao.matriz[r][a] }}</td>
                                        <td class="pl-1 text-right tabular-nums text-neutral-500 dark:text-neutral-400">{{ comparacao.porClasse[r].suporte }}</td>
                                    </tr>
                                    <tr>
                                        <th scope="row" class="pt-1 pr-2 text-left text-[10.5px] font-normal text-neutral-400 dark:text-neutral-500" title="Soma da coluna: o que o avaliador atribuiu à classe">atribuídos</th>
                                        <td v-for="a in comparacao.classes" :key="a" class="pt-1 text-center tabular-nums text-neutral-500 dark:text-neutral-400">{{ comparacao.porClasse[a].precision.denominador }}</td>
                                        <td class="pt-1 pl-1 text-right font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">{{ comparacao.comparaveis }}</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                        <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                            <span class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm bg-emerald-500/50" aria-hidden="true"></span>Diagonal = concordância</span>
                            <span class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm bg-rose-500/40" aria-hidden="true"></span>Fora da diagonal = discordância</span>
                            <span>Intensidade proporcional à contagem. Total: {{ comparacao.comparaveis }} plano(s) comparáveis.</span>
                        </div>
                        <p class="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500" aria-live="polite">
                            <template v-if="celulaAtiva">
                                {{ rotuloFonte(comparacao.referencia) }}: <span class="font-mono">{{ celulaAtiva.r }}</span> · {{ rotuloFonte(comparacao.avaliador) }}: <span class="font-mono">{{ celulaAtiva.a }}</span> · N = {{ comparacao.matriz[celulaAtiva.r][celulaAtiva.a] }}
                            </template>
                            <template v-else>Passe o mouse (ou o foco) sobre uma célula para ler o par.</template>
                        </p>
                    </div>

                    <!-- Concordâncias e tipos de discordância -->
                    <div class="lg:col-span-2" :class="CARTAO">
                        <div class="mb-3 flex items-start justify-between gap-2">
                            <p :class="SOBRETITULO">Concordâncias e discordâncias</p>
                            <button type="button" :class="BOTAO_AJUDA" aria-label="Metodologia: discordância" title="Como é calculado" @click="abrirMetodologia('discordancia')">?</button>
                        </div>
                        <div v-for="(p, c) in comparacao.concordantesPorClasse" :key="c" class="mb-2">
                            <div class="flex items-baseline justify-between text-xs">
                                <span class="text-neutral-700 dark:text-neutral-200"><span class="font-mono">{{ c }}</span> concordante</span>
                                <span class="tabular-nums text-neutral-500 dark:text-neutral-400">{{ fracao(p) }} · <span class="font-medium text-neutral-800 dark:text-neutral-100">{{ pct(p) }}</span></span>
                            </div>
                            <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-white/5">
                                <div class="h-full rounded-full bg-emerald-500/80 transition-[width] duration-500" :style="{ width: `${p.percentual ?? 0}%` }"></div>
                            </div>
                        </div>
                        <p class="mt-4 mb-2 text-[10.5px] font-semibold tracking-wider text-neutral-500 uppercase dark:text-neutral-400">
                            Discordâncias ({{ rotuloFonte(comparacao.referencia) }} → {{ rotuloFonte(comparacao.avaliador) }})
                        </p>
                        <p v-if="comparacao.discordancias.length === 0" class="text-xs text-neutral-500 dark:text-neutral-400">Nenhuma.</p>
                        <div v-for="d in comparacao.discordancias" :key="`${d.de}-${d.para}`" class="mb-2">
                            <div class="flex items-baseline justify-between text-xs">
                                <span class="font-mono text-neutral-700 dark:text-neutral-200">{{ d.de }} → {{ d.para }}</span>
                                <span class="tabular-nums text-neutral-500 dark:text-neutral-400">{{ fracao(d.proporcao) }} · <span class="font-medium text-neutral-800 dark:text-neutral-100">{{ pct(d.proporcao) }}</span></span>
                            </div>
                            <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-white/5">
                                <div class="h-full rounded-full bg-rose-500/70 transition-[width] duration-500" :style="{ width: `${d.proporcao.percentual ?? 0}%` }"></div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Precision / Recall / F1 -->
                <div :class="CARTAO">
                    <p :class="SOBRETITULO">Métricas por classe</p>
                    <p class="text-sm font-medium text-neutral-800 dark:text-neutral-100">Precision, Recall e F1 do {{ rotuloFonte(comparacao.avaliador) }} em relação ao {{ rotuloFonte(comparacao.referencia) }}</p>
                    <p class="mb-3 text-[11px] text-neutral-500 dark:text-neutral-400">Precision: acertos / o que o avaliador pôs na classe. Recall: acertos / o que a referência pôs na classe. "—" = denominador zero.</p>
                    <div class="overflow-x-auto rounded-xl border border-neutral-200 dark:border-white/10">
                        <table class="w-full min-w-[520px] text-xs">
                            <thead class="bg-neutral-50 dark:bg-white/[0.03]">
                                <tr>
                                    <th class="text-left" :class="TH">Classe</th>
                                    <th class="text-right" :class="TH">
                                        <span class="inline-flex items-center gap-1.5">Precision <button type="button" :class="BOTAO_AJUDA" aria-label="Metodologia: Precision" title="Como é calculado" @click="abrirMetodologia('precision')">?</button></span>
                                    </th>
                                    <th class="text-right" :class="TH">
                                        <span class="inline-flex items-center gap-1.5">Recall <button type="button" :class="BOTAO_AJUDA" aria-label="Metodologia: Recall" title="Como é calculado" @click="abrirMetodologia('recall')">?</button></span>
                                    </th>
                                    <th class="text-right" :class="TH">
                                        <span class="inline-flex items-center gap-1.5">F1 <button type="button" :class="BOTAO_AJUDA" aria-label="Metodologia: F1" title="Como é calculado" @click="abrirMetodologia('f1')">?</button></span>
                                    </th>
                                    <th class="text-right" :class="TH">Suporte</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="(m, c) in comparacao.porClasse" :key="c" class="border-t border-neutral-100 transition-colors hover:bg-neutral-50/70 dark:border-white/5 dark:hover:bg-white/[0.03]">
                                    <td class="px-3 py-2.5">
                                        <span class="inline-flex items-center gap-2"><span class="h-2 w-2 rounded-sm" :class="corEstado(String(c))" aria-hidden="true"></span><span class="font-mono font-medium text-neutral-800 dark:text-neutral-100">{{ c }}</span></span>
                                    </td>
                                    <td class="px-3 py-2.5 text-right tabular-nums">
                                        <span class="font-semibold text-neutral-900 dark:text-neutral-50">{{ pct(m.precision) }}</span>
                                        <span class="ml-1 text-neutral-400 dark:text-neutral-500">{{ fracao(m.precision) }}</span>
                                    </td>
                                    <td class="px-3 py-2.5 text-right tabular-nums">
                                        <span class="font-semibold text-neutral-900 dark:text-neutral-50">{{ pct(m.recall) }}</span>
                                        <span class="ml-1 text-neutral-400 dark:text-neutral-500">{{ fracao(m.recall) }}</span>
                                    </td>
                                    <td class="px-3 py-2.5 text-right tabular-nums">
                                        <span class="inline-flex items-center justify-end gap-2">
                                            <span class="hidden h-1.5 w-14 overflow-hidden rounded-full bg-neutral-100 sm:inline-block dark:bg-white/10" aria-hidden="true">
                                                <span class="block h-full rounded-full bg-blue-500 dark:bg-blue-400" :style="{ width: `${(m.f1 ?? 0) * 100}%` }"></span>
                                            </span>
                                            <span class="font-semibold text-neutral-900 dark:text-neutral-50">{{ num(m.f1) }}</span>
                                        </span>
                                    </td>
                                    <td class="px-3 py-2.5 text-right tabular-nums text-neutral-500 dark:text-neutral-400">{{ m.suporte }}</td>
                                </tr>
                            </tbody>
                            <tfoot>
                                <tr class="border-t border-neutral-200 bg-neutral-50/60 dark:border-white/10 dark:bg-white/[0.02]">
                                    <td class="px-3 py-2 text-[11px] font-medium text-neutral-600 dark:text-neutral-300">Macro F1 (K = {{ comparacao.macroF1.classesConsideradas.length }})</td>
                                    <td></td>
                                    <td></td>
                                    <td class="px-3 py-2 text-right font-semibold tabular-nums text-neutral-900 dark:text-neutral-50">{{ num(comparacao.macroF1.valor) }}</td>
                                    <td class="px-3 py-2 text-right tabular-nums text-neutral-500 dark:text-neutral-400">{{ comparacao.comparaveis }}</td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            </template>

            <!-- Por modelo e por domínio -->
            <template v-for="tabela in tabelasGrupo" :key="tabela.titulo">
                <div v-if="tabela.grupos.length > 0" :class="CARTAO">
                    <div class="mb-3 flex items-start justify-between gap-2">
                        <div>
                            <p :class="SOBRETITULO">Recorte</p>
                            <p class="text-sm font-medium text-neutral-800 dark:text-neutral-100">{{ tabela.titulo }}</p>
                        </div>
                        <button type="button" :class="BOTAO_AJUDA" aria-label="Metodologia: recortes por modelo e por domínio" title="Como é calculado" @click="abrirMetodologia('recortes')">?</button>
                    </div>
                    <div class="overflow-x-auto rounded-xl border border-neutral-200 dark:border-white/10">
                        <table class="w-full text-xs">
                            <thead class="bg-neutral-50 dark:bg-white/[0.03]">
                                <tr>
                                    <th class="text-left" :class="TH">Grupo</th>
                                    <th class="text-right" :class="TH">Planos</th>
                                    <template v-if="comparativa">
                                        <th class="text-right" :class="TH">Comparáveis</th>
                                        <th class="text-right" :class="TH">Concordância</th>
                                        <th class="text-right normal-case" :class="TH">κ</th>
                                        <th class="text-right" :class="TH">Macro F1</th>
                                        <th class="text-right" :class="TH">Cobertura do Judge</th>
                                    </template>
                                    <template v-else>
                                        <th v-for="e in estadosDescritiva" :key="e" class="text-right font-mono" :class="TH">{{ e }}</th>
                                        <th v-if="geral.coberturaJuiz" class="text-right" :class="TH">Cobertura do Judge</th>
                                    </template>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="g in tabela.grupos" :key="g.rotulo" class="border-t border-neutral-100 transition-colors hover:bg-neutral-50/70 dark:border-white/5 dark:hover:bg-white/[0.03]">
                                    <td class="px-3 py-2 font-medium text-neutral-800 dark:text-neutral-100">{{ g.rotulo }}</td>
                                    <td class="px-3 py-2 text-right tabular-nums">{{ g.bloco.total }}</td>
                                    <template v-if="comparativa && g.bloco.comparacao">
                                        <td class="px-3 py-2 text-right tabular-nums">{{ g.bloco.comparacao.comparaveis }}</td>
                                        <td class="px-3 py-2 text-right tabular-nums"><span class="font-semibold text-neutral-900 dark:text-neutral-50">{{ pct(g.bloco.comparacao.concordancia) }}</span> <span class="text-neutral-400 dark:text-neutral-500">{{ fracao(g.bloco.comparacao.concordancia) }}</span></td>
                                        <td class="px-3 py-2 text-right tabular-nums">{{ num(g.bloco.comparacao.kappa.valor) }}</td>
                                        <td class="px-3 py-2 text-right tabular-nums">{{ num(g.bloco.comparacao.macroF1.valor) }}</td>
                                        <td class="px-3 py-2 text-right tabular-nums">{{ pct(g.bloco.coberturaJuiz?.cobertura) }}</td>
                                    </template>
                                    <template v-else-if="!comparativa">
                                        <td v-for="(p, e) in g.bloco.distribuicoes[0]?.porEstado" :key="e" class="px-3 py-2 text-right tabular-nums">
                                            <span class="font-semibold text-neutral-900 dark:text-neutral-50">{{ pct(p) }}</span> <span class="text-neutral-400 dark:text-neutral-500">{{ fracao(p) }}</span>
                                        </td>
                                        <td v-if="g.bloco.coberturaJuiz" class="px-3 py-2 text-right tabular-nums">{{ pct(g.bloco.coberturaJuiz.cobertura) }}</td>
                                    </template>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </template>

            <!-- Por linha -->
            <details class="group" :class="CARTAO">
                <summary class="flex cursor-pointer list-none items-center justify-between gap-2 select-none">
                    <span>
                        <span class="block" :class="SOBRETITULO">Observações individuais</span>
                        <span class="text-sm font-medium text-neutral-800 dark:text-neutral-100">Por linha ({{ analise.porLinha.length }} plano(s))</span>
                    </span>
                    <svg class="text-neutral-400 transition-transform group-open:rotate-180" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                </summary>
                <div class="mt-3 max-h-[28rem] overflow-auto rounded-xl border border-neutral-200 dark:border-white/10">
                    <table class="w-full text-xs">
                        <thead class="sticky top-0 bg-neutral-50 dark:bg-neutral-900">
                            <tr>
                                <th class="text-left" :class="TH">Linha</th>
                                <th class="text-left" :class="TH">Modelo</th>
                                <th v-if="analise.dominios.length > 1" class="text-left" :class="TH">Domínio</th>
                                <th class="text-left" :class="TH">Intenção</th>
                                <th v-for="f in analise.opcao.fontes" :key="f" class="text-left" :class="TH">{{ rotuloFonte(f) }}</th>
                                <th v-if="comparativa" class="text-left" :class="TH">Concorda</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="l in analise.porLinha" :key="`${l.lado}-${l.linha}`" class="border-t border-neutral-100 align-top hover:bg-neutral-50/70 dark:border-white/5 dark:hover:bg-white/[0.03]">
                                <td class="px-3 py-1.5 tabular-nums">{{ l.linha }}</td>
                                <td class="px-3 py-1.5">{{ ROTULO_LADO[l.lado] }}</td>
                                <td v-if="analise.dominios.length > 1" class="px-3 py-1.5">{{ l.dominio ?? '—' }}</td>
                                <td class="max-w-md truncate px-3 py-1.5 text-neutral-600 dark:text-neutral-300" :title="l.intencao">{{ l.intencao }}</td>
                                <td v-for="f in analise.opcao.fontes" :key="f" class="px-3 py-1.5">
                                    <span
                                        v-if="l.julgamentos[f] && ehOperacional(l.julgamentos[f]!)"
                                        class="inline-block rounded-md border border-dashed border-neutral-300 px-1.5 py-px font-mono text-[10.5px] text-neutral-500 dark:border-white/20 dark:text-neutral-400"
                                        title="Estado operacional do Judge (não é classe semântica)"
                                    >{{ l.julgamentos[f] }}</span>
                                    <span v-else-if="l.julgamentos[f]" class="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-neutral-800 dark:text-neutral-100">
                                        <span class="h-1.5 w-1.5 rounded-full" :class="corEstado(l.julgamentos[f]!)" aria-hidden="true"></span>{{ l.julgamentos[f] }}
                                    </span>
                                    <span v-else class="text-[11px] text-neutral-400 italic dark:text-neutral-500">{{ l.naoAvaliado ? 'não avaliado' : '—' }}</span>
                                </td>
                                <td v-if="comparativa" class="px-3 py-1.5">
                                    <span v-if="l.concorda === undefined" class="text-neutral-400">—</span>
                                    <span v-else :class="l.concorda ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'">{{ l.concorda ? 'sim' : 'não' }}</span>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </details>
        </template>
    </section>
</template>

<style scoped>
/* Estados operacionais (NOT_CALLED, NO_RESPONSE): hachurados, para não se confundirem com as classes. */
.listrado {
    background-image: repeating-linear-gradient(135deg, rgb(163 163 163) 0 2px, transparent 2px 5px);
    background-color: rgb(229 229 229);
}
.dark .listrado {
    background-image: repeating-linear-gradient(135deg, rgb(115 115 115) 0 2px, transparent 2px 5px);
    background-color: rgb(38 38 38);
}
</style>
