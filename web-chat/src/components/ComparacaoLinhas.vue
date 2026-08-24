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

/** Quantas colunas o painel expandido tem: ground truth + os lados selecionados. */
const colunas = computed(() => 1 + (props.mostrarArquitetura ? 1 : 0) + (props.mostrarBaseline ? 1 : 0));

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
    return !!lado && lado.sintaxeOk && lado.semanticaOk && !lado.violacao;
}

/** Lista curta do que falhou naquele lado — o que a pessoa precisa ler pra
 *  saber por que a linha está marcada como divergente. */
function motivos(lado: DetalheLado | undefined): string[] {
    if (!lado) return [];
    const lista: string[] = [];
    if (!lado.sintaxeOk) lista.push('sintaxe');
    if (!lado.semanticaOk) lista.push('semântica');
    if (lado.violacao) lista.push('violação');
    return lista;
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
            <template v-else>Nenhuma divergência — todos os casos avaliados bateram com o ground truth.</template>
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
                            ladoOk(l.arquitetura)
                                ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400'
                                : 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400'
                        "
                        :title="ladoOk(l.arquitetura) ? 'SPC-CML: correto' : `SPC-CML: ${motivos(l.arquitetura).join(', ')}`"
                    >
                        SPC-CML
                    </span>

                    <span
                        v-if="mostrarBaseline && l.baseline"
                        class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
                        :class="
                            ladoOk(l.baseline)
                                ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400'
                                : 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400'
                        "
                        :title="ladoOk(l.baseline) ? 'Baseline: correto' : `Baseline: ${motivos(l.baseline).join(', ')}`"
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
                            <!-- Ground truth -->
                            <div class="flex min-w-0 flex-col rounded-xl border border-neutral-200 bg-white p-3 dark:border-white/10 dark:bg-white/5">
                                <div class="mb-2 flex items-center gap-1.5">
                                    <svg width="13" height="13" viewBox="0 0 24 24" class="shrink-0 text-neutral-500 dark:text-neutral-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M9 11l3 3L22 4" />
                                        <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
                                    </svg>
                                    <span class="text-xs font-semibold tracking-wide text-neutral-500 uppercase dark:text-neutral-400">Ground truth</span>
                                </div>
                                <pre class="mb-2 max-h-72 overflow-auto rounded-lg bg-neutral-50 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-neutral-700 dark:bg-black/20 dark:text-neutral-300">{{ l.groundTruth.plano }}</pre>
                                <p class="text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">{{ l.groundTruth.description }}</p>
                            </div>

                            <!-- Arquitetura SPC-CML -->
                            <div
                                v-if="mostrarArquitetura"
                                class="flex min-w-0 flex-col rounded-xl border p-3"
                                :class="
                                    l.arquitetura && !ladoOk(l.arquitetura)
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
                                            ladoOk(l.arquitetura)
                                                ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400'
                                                : 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300'
                                        "
                                    >
                                        {{ ladoOk(l.arquitetura) ? 'correto' : motivos(l.arquitetura).join(' · ') }}
                                    </span>
                                </div>
                                <pre v-if="l.arquitetura" class="max-h-72 overflow-auto rounded-lg bg-neutral-50 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-neutral-700 dark:bg-black/20 dark:text-neutral-300">{{ l.arquitetura.plano }}</pre>
                                <p v-else class="rounded-lg bg-neutral-50 p-2.5 text-[11px] text-neutral-400 dark:bg-black/20 dark:text-neutral-500">Sem registro para esta linha no arquivo enviado.</p>
                            </div>

                            <!-- Baseline -->
                            <div
                                v-if="mostrarBaseline"
                                class="flex min-w-0 flex-col rounded-xl border p-3"
                                :class="
                                    l.baseline && !ladoOk(l.baseline)
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
                                            ladoOk(l.baseline)
                                                ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400'
                                                : 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300'
                                        "
                                    >
                                        {{ ladoOk(l.baseline) ? 'correto' : motivos(l.baseline).join(' · ') }}
                                    </span>
                                </div>
                                <pre v-if="l.baseline" class="max-h-72 overflow-auto rounded-lg bg-neutral-50 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-neutral-700 dark:bg-black/20 dark:text-neutral-300">{{ l.baseline.plano }}</pre>
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
