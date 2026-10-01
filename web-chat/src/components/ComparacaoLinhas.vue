<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DetalheLado, DetalheLinha } from '../api';
import { rotuloVeredicto, tomDoLado } from '../avaliacao';
import AvaliacaoLado from './AvaliacaoLado.vue';

const props = defineProps<{
    linhas: DetalheLinha[];
    mostrarArquitetura: boolean;
    mostrarBaseline: boolean;
}>();

const filtro = ref<'todas' | 'divergencias' | 'discordancias'>('todas');
const busca = ref('');
const abertas = ref<Set<number>>(new Set());

const totalDivergencias = computed(() => props.linhas.filter(l => l.temDivergencia).length);
const totalDiscordancias = computed(() => props.linhas.filter(l => l.temDiscordancia).length);

/** Sem acento e em minúsculas: quem audita digita "glicemia" e espera achar
 *  "Glicemia", "hiperglicêmico" etc. sem se preocupar com acentuação. */
function normalizar(texto: string): string {
    return texto
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase();
}

const linhasVisiveis = computed(() => {
    let lista =
        filtro.value === 'divergencias'
            ? props.linhas.filter(l => l.temDivergencia)
            : filtro.value === 'discordancias'
              ? props.linhas.filter(l => l.temDiscordancia)
              : props.linhas;

    const termo = busca.value.trim();
    if (termo) {
        // "#12" ou "12" casa a linha exata; qualquer outra coisa busca no texto
        // da intenção. Um número também continua valendo como texto (ex.: "308"
        // acha "Glicemia capilar deu 308"), então os dois modos convivem.
        const semCerquilha = termo.replace(/^#/, '');
        const numero = /^\d+$/.test(semCerquilha) ? Number(semCerquilha) : null;
        const alvo = normalizar(termo);
        lista = lista.filter(l => (numero !== null && l.linha === numero) || normalizar(l.intencao).includes(alvo));
    }

    return lista;
});

// ---------------------------------------------------------------------------
// Paginação: 20 casos por página, ou todos de uma vez ("Ver tudo"). Filtro e
// busca continuam valendo sobre o conjunto inteiro; a página só recorta o
// que já passou por eles.
// ---------------------------------------------------------------------------

const POR_PAGINA = 20;
const verTudo = ref(false);
const pagina = ref(1);

const totalPaginas = computed(() => Math.max(1, Math.ceil(linhasVisiveis.value.length / POR_PAGINA)));
const paginado = computed(() => !verTudo.value && linhasVisiveis.value.length > POR_PAGINA);

const linhasDaPagina = computed(() => {
    if (!paginado.value) return linhasVisiveis.value;
    const inicio = (pagina.value - 1) * POR_PAGINA;
    return linhasVisiveis.value.slice(inicio, inicio + POR_PAGINA);
});

/** "21–40 de 137" — o intervalo que está na tela. */
const intervalo = computed(() => {
    const total = linhasVisiveis.value.length;
    if (!paginado.value) return { de: total > 0 ? 1 : 0, ate: total, total };
    const de = (pagina.value - 1) * POR_PAGINA + 1;
    return { de, ate: Math.min(de + POR_PAGINA - 1, total), total };
});

/** Os números de página a mostrar: sempre a primeira, a última e as vizinhas da atual; o resto vira "…". */
const botoesDePagina = computed<Array<number | '…'>>(() => {
    const n = totalPaginas.value;
    const atual = pagina.value;
    const paginas = [...new Set([1, n, atual - 1, atual, atual + 1])].filter(p => p >= 1 && p <= n).sort((a, b) => a - b);
    const saida: Array<number | '…'> = [];
    paginas.forEach((p, i) => {
        if (i > 0 && p - paginas[i - 1] > 1) saida.push('…');
        saida.push(p);
    });
    return saida;
});

function irPara(p: number): void {
    pagina.value = Math.min(Math.max(1, p), totalPaginas.value);
}

function alternarVerTudo(): void {
    verTudo.value = !verTudo.value;
    pagina.value = 1;
}

// Filtro ou busca novos começam na primeira página; um conjunto que encolheu nunca deixa a página fora do alcance.
watch([filtro, busca], () => (pagina.value = 1));
watch(totalPaginas, n => {
    if (pagina.value > n) pagina.value = n;
});

/** Quantas colunas o painel expandido tem: um por lado selecionado. */
const colunas = computed(() => (props.mostrarArquitetura ? 1 : 0) + (props.mostrarBaseline ? 1 : 0));

function alternar(linha: number): void {
    const novo = new Set(abertas.value);
    if (novo.has(linha)) novo.delete(linha);
    else novo.add(linha);
    abertas.value = novo;
}

/** Expande os casos que estão na tela (a página atual, ou todos em "Ver tudo"). */
function expandirTodas(): void {
    abertas.value = new Set(linhasDaPagina.value.map(l => l.linha));
}

function recolherTodas(): void {
    abertas.value = new Set();
}

/** Cor da pill de um lado na linha recolhida: a do ORÁCULO, como no painel; o juiz nunca pinta a linha (a discordância é o ⚠). */
const PILL: Record<ReturnType<typeof tomDoLado>, string> = {
    neutro: 'bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-400',
    valido: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400',
    invalido: 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400',
    indeterminado: 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300'
};

function pill(lado: DetalheLado | undefined): string {
    return PILL[tomDoLado(lado)];
}
</script>

<template>
    <section>
        <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-2.5">
                <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="8" y1="6" x2="21" y2="6" />
                        <line x1="8" y1="12" x2="21" y2="12" />
                        <line x1="8" y1="18" x2="21" y2="18" />
                        <line x1="3" y1="6" x2="3.01" y2="6" />
                        <line x1="3" y1="12" x2="3.01" y2="12" />
                        <line x1="3" y1="18" x2="3.01" y2="18" />
                    </svg>
                </div>
                <div>
                    <p class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Comparação por linha</p>
                    <p class="text-xs text-neutral-500 dark:text-neutral-400">
                        <template v-if="linhasVisiveis.length !== linhas.length">{{ linhasVisiveis.length }} de {{ linhas.length }} caso(s)</template>
                        <template v-else>{{ linhas.length }} caso(s)</template>
                        · {{ totalDivergencias }} reprovado(s) ou indeterminado(s) pelo oráculo · {{ totalDiscordancias }} com discordância oráculo × LLM
                    </p>
                </div>
            </div>

            <div class="flex flex-wrap items-center gap-2">
                <div class="relative">
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-neutral-400 dark:text-neutral-500"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                        v-model="busca"
                        type="search"
                        placeholder="Buscar por prompt ou #linha…"
                        class="w-56 rounded-full border border-neutral-200 bg-white py-1.5 pr-8 pl-8 text-xs text-neutral-700 outline-none transition-colors placeholder:text-neutral-400 focus:border-blue-300 dark:border-white/10 dark:bg-white/5 dark:text-neutral-200 dark:placeholder:text-neutral-500 dark:focus:border-blue-500/40"
                    />
                    <button
                        v-if="busca"
                        type="button"
                        class="absolute top-1/2 right-2.5 -translate-y-1/2 text-neutral-400 transition-colors hover:text-neutral-700 dark:hover:text-neutral-100"
                        title="Limpar busca"
                        @click="busca = ''"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" /></svg>
                    </button>
                </div>

                <div class="flex rounded-full bg-neutral-100 p-0.5 dark:bg-white/10">
                    <button
                        type="button"
                        class="rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
                        :class="filtro === 'todas' ? 'bg-white text-neutral-800 shadow-sm dark:bg-white/15 dark:text-neutral-100' : 'text-neutral-500 dark:text-neutral-400'"
                        @click="filtro = 'todas'"
                    >
                        Todas
                    </button>
                    <button
                        type="button"
                        class="rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
                        :class="filtro === 'divergencias' ? 'bg-white text-neutral-800 shadow-sm dark:bg-white/15 dark:text-neutral-100' : 'text-neutral-500 dark:text-neutral-400'"
                        @click="filtro = 'divergencias'"
                    >
                        Reprovados pelo oráculo
                    </button>
                    <button
                            type="button"
                        class="rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
                        :class="filtro === 'discordancias' ? 'bg-white text-neutral-800 shadow-sm dark:bg-white/15 dark:text-neutral-100' : 'text-neutral-500 dark:text-neutral-400'"
                        @click="filtro = 'discordancias'"
                    >
                        Discordâncias
                    </button>
                </div>

                <button
                    type="button"
                    class="rounded-full border border-neutral-200 px-3 py-1.5 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/10"
                    @click="abertas.size > 0 ? recolherTodas() : expandirTodas()"
                >
                    {{ abertas.size > 0 ? 'Recolher todas' : 'Expandir todas' }}
                </button>
            </div>
        </div>

        <p v-if="linhasVisiveis.length === 0" class="rounded-2xl border border-dashed border-neutral-200 px-4 py-8 text-center text-sm text-neutral-400 dark:border-white/10 dark:text-neutral-500">
            <template v-if="busca.trim()">Nenhum caso encontrado para “{{ busca.trim() }}”.</template>
            <template v-else-if="filtro === 'discordancias'">Nenhuma discordância — o LLM Judge concordou com o oráculo em todos os casos avaliados.</template>
            <template v-else>Nenhum caso reprovado — todos os casos avaliados foram aceitos pelo oráculo determinístico.</template>
        </p>

        <div v-else class="overflow-hidden rounded-2xl border border-neutral-200 dark:border-white/10">
            <div
                v-for="(l, i) in linhasDaPagina"
                :key="l.linha"
                class="border-neutral-200 dark:border-white/10"
                :class="i > 0 ? 'border-t' : ''"
            >
                <button
                    type="button"
                    class="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-white/5"
                    :class="abertas.has(l.linha) ? 'bg-neutral-50 dark:bg-white/5' : ''"
                    @click="alternar(l.linha)"
                >
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        class="shrink-0 text-neutral-400 transition-transform duration-200 dark:text-neutral-500"
                        :class="abertas.has(l.linha) ? 'rotate-90' : ''"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <polyline points="9 18 15 12 9 6" />
                    </svg>

                    <span class="w-12 shrink-0 font-mono text-xs tabular-nums text-neutral-400 dark:text-neutral-500">#{{ l.linha }}</span>

                    <span class="min-w-0 flex-1 truncate text-sm text-neutral-700 dark:text-neutral-200">{{ l.intencao }}</span>

                    <span
                        v-if="mostrarArquitetura && l.arquitetura"
                        class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
                        :class="pill(l.arquitetura)"
                        :title="`SPC-CML: ${rotuloVeredicto(l.arquitetura)}`"
                    >
                        <span v-if="l.arquitetura.concordancia === false" aria-hidden="true">⚠ </span>SPC-CML
                    </span>

                    <span
                        v-if="mostrarBaseline && l.baseline"
                        class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
                        :class="pill(l.baseline)"
                        :title="`Baseline: ${rotuloVeredicto(l.baseline)}`"
                    >
                        <span v-if="l.baseline.concordancia === false" aria-hidden="true">⚠ </span>Baseline
                    </span>
                </button>

                <Transition name="expandir">
                    <div v-if="abertas.has(l.linha)" class="overflow-hidden">
                        <div
                            class="grid gap-3 border-t border-neutral-200 bg-neutral-50/60 p-3.5 dark:border-white/10 dark:bg-white/[0.02]"
                            :class="colunas === 3 ? 'lg:grid-cols-3' : colunas === 2 ? 'lg:grid-cols-2' : 'grid-cols-1'"
                        >
                            <AvaliacaoLado v-if="mostrarArquitetura" :lado="l.arquitetura" titulo="Arquitetura SPC-CML" variante="arquitetura" />
                            <AvaliacaoLado v-if="mostrarBaseline" :lado="l.baseline" titulo="Baseline" variante="baseline" />
                        </div>
                    </div>
                </Transition>
            </div>
        </div>

        <!-- Paginação: 20 por página; "Ver tudo" mostra o conjunto inteiro (depois de filtro e busca). -->
        <nav
            v-if="linhasVisiveis.length > POR_PAGINA"
            class="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-500 dark:text-neutral-400"
            aria-label="Paginação da comparação por linha"
        >
            <p class="tabular-nums">
                <template v-if="paginado">Mostrando {{ intervalo.de }}–{{ intervalo.ate }} de {{ intervalo.total }} caso(s)</template>
                <template v-else>Mostrando todos os {{ intervalo.total }} caso(s)</template>
            </p>

            <div v-if="paginado" class="flex items-center gap-1">
                <button
                    type="button"
                    class="rounded-full px-2.5 py-1 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/10"
                    :disabled="pagina === 1"
                    aria-label="Página anterior"
                    @click="irPara(pagina - 1)"
                >
                    ‹ Anterior
                </button>
                <template v-for="(p, i) in botoesDePagina" :key="`${p}-${i}`">
                    <span v-if="p === '…'" class="px-1 text-neutral-400 dark:text-neutral-500" aria-hidden="true">…</span>
                    <button
                        v-else
                        type="button"
                        class="min-w-7 rounded-full px-2 py-1 tabular-nums transition-colors"
                        :class="p === pagina ? 'bg-neutral-800 font-medium text-white dark:bg-white dark:text-neutral-900' : 'hover:bg-neutral-100 dark:hover:bg-white/10'"
                        :aria-current="p === pagina ? 'page' : undefined"
                        :aria-label="`Página ${p}`"
                        @click="irPara(p)"
                    >
                        {{ p }}
                    </button>
                </template>
                <button
                    type="button"
                    class="rounded-full px-2.5 py-1 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/10"
                    :disabled="pagina === totalPaginas"
                    aria-label="Próxima página"
                    @click="irPara(pagina + 1)"
                >
                    Próxima ›
                </button>
            </div>

            <button
                type="button"
                class="rounded-full border border-neutral-200 px-3 py-1.5 text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/10"
                @click="alternarVerTudo"
            >
                {{ verTudo ? `Ver menos (${POR_PAGINA} por página)` : 'Ver tudo' }}
            </button>
        </nav>
    </section>
</template>

<style scoped>
/* O Chrome desenha o próprio "x" em input[type=search], que apareceria
   duplicado ao lado do nosso botão de limpar. */
input[type='search']::-webkit-search-cancel-button,
input[type='search']::-webkit-search-decoration {
    -webkit-appearance: none;
    appearance: none;
}

.expandir-enter-active,
.expandir-leave-active {
    transition:
        grid-template-rows 0.25s ease,
        opacity 0.25s ease;
    display: grid;
    grid-template-rows: 1fr;
}
.expandir-enter-from,
.expandir-leave-to {
    grid-template-rows: 0fr;
    opacity: 0;
}
.expandir-enter-active > *,
.expandir-leave-active > * {
    min-height: 0;
    overflow: hidden;
}
</style>
