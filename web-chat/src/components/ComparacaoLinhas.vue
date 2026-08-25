<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DetalheLado, DetalheLinha } from '../api';

const props = defineProps<{
    linhas: DetalheLinha[];
    mostrarArquitetura: boolean;
    mostrarBaseline: boolean;
}>();

const filtro = ref<'todas' | 'divergencias'>('todas');
const busca = ref('');
const abertas = ref<Set<number>>(new Set());

const totalDivergencias = computed(() => props.linhas.filter(l => l.temDivergencia).length);

/** Sem acento e em minúsculas: quem audita digita "glicemia" e espera achar
 *  "Glicemia", "hiperglicêmico" etc. sem se preocupar com acentuação. */
function normalizar(texto: string): string {
    return texto
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase();
}

const linhasVisiveis = computed(() => {
    let lista = filtro.value === 'divergencias' ? props.linhas.filter(l => l.temDivergencia) : props.linhas;

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

/** Quantas colunas o painel expandido tem: um por lado selecionado. */
const colunas = computed(() => (props.mostrarArquitetura ? 1 : 0) + (props.mostrarBaseline ? 1 : 0));

function alternar(linha: number): void {
    const novo = new Set(abertas.value);
    if (novo.has(linha)) novo.delete(linha);
    else novo.add(linha);
    abertas.value = novo;
}

function expandirTodas(): void {
    abertas.value = new Set(linhasVisiveis.value.map(l => l.linha));
}

function recolherTodas(): void {
    abertas.value = new Set();
}

function ladoOk(lado: DetalheLado | undefined): boolean {
    return !!lado && !lado.naoAvaliado && lado.sintaxeOk && lado.semanticaOk && !lado.violacao;
}

/** Lista curta do que falhou naquele lado — o que a pessoa precisa ler pra
 *  saber por que a linha está marcada como divergente. */
function motivos(lado: DetalheLado | undefined): string[] {
    if (!lado || lado.naoAvaliado) return [];
    const lista: string[] = [];
    if (!lado.sintaxeOk) lista.push('sintaxe');
    if (!lado.semanticaOk) lista.push('semântica (grafo)');
    if (lado.violacao) lista.push('violação');
    return lista;
}

/** Rótulo curto do veredicto — usado tanto na pill da linha colapsada quanto
 *  no cabeçalho do painel expandido. */
function rotuloVeredicto(lado: DetalheLado | undefined): string {
    if (!lado) return '';
    if (lado.naoAvaliado) return 'não avaliado';
    return ladoOk(lado) ? 'correto' : motivos(lado).join(' · ');
}
</script>

<template>
    <section class="mt-6">
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
                        · {{ totalDivergencias }} com divergência
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
                        Só divergências
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
            <template v-else>Nenhuma divergência — todos os casos avaliados foram aprovados pelo grafo de conhecimento.</template>
        </p>

        <div v-else class="overflow-hidden rounded-2xl border border-neutral-200 dark:border-white/10">
            <div
                v-for="(l, i) in linhasVisiveis"
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
                        :class="
                            l.arquitetura.naoAvaliado
                                ? 'bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-400'
                                : ladoOk(l.arquitetura)
                                  ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400'
                                  : 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400'
                        "
                        :title="`SPC-CML: ${rotuloVeredicto(l.arquitetura)}`"
                    >
                        SPC-CML
                    </span>

                    <span
                        v-if="mostrarBaseline && l.baseline"
                        class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
                        :class="
                            l.baseline.naoAvaliado
                                ? 'bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-400'
                                : ladoOk(l.baseline)
                                  ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400'
                                  : 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400'
                        "
                        :title="`Baseline: ${rotuloVeredicto(l.baseline)}`"
                    >
                        Baseline
                    </span>
                </button>

                <Transition name="expandir">
                    <div v-if="abertas.has(l.linha)" class="overflow-hidden">
                        <div
                            class="grid gap-3 border-t border-neutral-200 bg-neutral-50/60 p-3.5 dark:border-white/10 dark:bg-white/[0.02]"
                            :class="colunas === 3 ? 'lg:grid-cols-3' : colunas === 2 ? 'lg:grid-cols-2' : 'grid-cols-1'"
                        >
                            <!-- Arquitetura SPC-CML -->
                            <div
                                v-if="mostrarArquitetura"
                                class="flex min-w-0 flex-col rounded-xl border p-3"
                                :class="
                                    l.arquitetura && l.arquitetura.naoAvaliado
                                        ? 'border-neutral-200 bg-neutral-50/60 dark:border-white/10 dark:bg-white/[0.03]'
                                        : l.arquitetura && !ladoOk(l.arquitetura)
                                          ? 'border-rose-200 bg-rose-50/50 dark:border-rose-500/25 dark:bg-rose-500/[0.06]'
                                          : 'border-neutral-200 bg-white dark:border-white/10 dark:bg-white/5'
                                "
                            >
                                <div class="mb-2 flex items-center gap-1.5">
                                    <svg width="13" height="13" viewBox="0 0 24 24" class="shrink-0 text-blue-500 dark:text-blue-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                                    </svg>
                                    <span class="text-xs font-semibold tracking-wide text-neutral-500 uppercase dark:text-neutral-400">Arquitetura SPC-CML</span>
                                    <span
                                        v-if="l.arquitetura"
                                        class="ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                                        :class="
                                            l.arquitetura.naoAvaliado
                                                ? 'bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-400'
                                                : ladoOk(l.arquitetura)
                                                  ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400'
                                                  : 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300'
                                        "
                                    >
                                        {{ rotuloVeredicto(l.arquitetura) }}
                                    </span>
                                </div>
                                <template v-if="l.arquitetura">
                                    <pre class="max-h-72 overflow-auto rounded-lg bg-neutral-50 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-neutral-700 dark:bg-black/20 dark:text-neutral-300">{{ l.arquitetura.plano }}</pre>
                                    <p class="mt-2 text-[11px] leading-relaxed text-neutral-600 dark:text-neutral-300">{{ l.arquitetura.justificativa }}</p>
                                    <details v-if="l.arquitetura.contextoGrafo" class="mt-2">
                                        <summary class="cursor-pointer text-[11px] text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300">Contexto recuperado do grafo</summary>
                                        <pre class="mt-1.5 max-h-56 overflow-auto rounded-lg bg-neutral-50 p-2.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-neutral-600 dark:bg-black/20 dark:text-neutral-400">{{ l.arquitetura.contextoGrafo }}</pre>
                                    </details>
                                </template>
                                <p v-else class="rounded-lg bg-neutral-50 p-2.5 text-[11px] text-neutral-400 dark:bg-black/20 dark:text-neutral-500">Sem registro para esta linha no arquivo enviado.</p>
                            </div>

                            <!-- Baseline -->
                            <div
                                v-if="mostrarBaseline"
                                class="flex min-w-0 flex-col rounded-xl border p-3"
                                :class="
                                    l.baseline && l.baseline.naoAvaliado
                                        ? 'border-neutral-200 bg-neutral-50/60 dark:border-white/10 dark:bg-white/[0.03]'
                                        : l.baseline && !ladoOk(l.baseline)
                                          ? 'border-rose-200 bg-rose-50/50 dark:border-rose-500/25 dark:bg-rose-500/[0.06]'
                                          : 'border-neutral-200 bg-white dark:border-white/10 dark:bg-white/5'
                                "
                            >
                                <div class="mb-2 flex items-center gap-1.5">
                                    <svg width="13" height="13" viewBox="0 0 24 24" class="shrink-0 text-neutral-500 dark:text-neutral-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <rect x="4" y="4" width="16" height="16" rx="2" />
                                        <rect x="9" y="9" width="6" height="6" />
                                    </svg>
                                    <span class="text-xs font-semibold tracking-wide text-neutral-500 uppercase dark:text-neutral-400">Baseline</span>
                                    <span
                                        v-if="l.baseline"
                                        class="ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                                        :class="
                                            l.baseline.naoAvaliado
                                                ? 'bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-400'
                                                : ladoOk(l.baseline)
                                                  ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400'
                                                  : 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300'
                                        "
                                    >
                                        {{ rotuloVeredicto(l.baseline) }}
                                    </span>
                                </div>
                                <template v-if="l.baseline">
                                    <pre class="max-h-72 overflow-auto rounded-lg bg-neutral-50 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-neutral-700 dark:bg-black/20 dark:text-neutral-300">{{ l.baseline.plano }}</pre>
                                    <p class="mt-2 text-[11px] leading-relaxed text-neutral-600 dark:text-neutral-300">{{ l.baseline.justificativa }}</p>
                                    <details v-if="l.baseline.contextoGrafo" class="mt-2">
                                        <summary class="cursor-pointer text-[11px] text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300">Contexto recuperado do grafo</summary>
                                        <pre class="mt-1.5 max-h-56 overflow-auto rounded-lg bg-neutral-50 p-2.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-neutral-600 dark:bg-black/20 dark:text-neutral-400">{{ l.baseline.contextoGrafo }}</pre>
                                    </details>
                                </template>
                                <p v-else class="rounded-lg bg-neutral-50 p-2.5 text-[11px] text-neutral-400 dark:bg-black/20 dark:text-neutral-500">Sem registro para esta linha no arquivo enviado.</p>
                            </div>
                        </div>
                    </div>
                </Transition>
            </div>
        </div>
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
