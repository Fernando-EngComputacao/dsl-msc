<script lang="ts">
/** As seções do resultado da avaliação. `todas` mostra as outras quatro, uma abaixo da outra. */
export type AbaResultado = 'todas' | 'metricas' | 'analise' | 'graficos' | 'tempo';
</script>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';

const props = defineProps<{ modelValue: AbaResultado }>();
const emit = defineEmits<{ 'update:modelValue': [aba: AbaResultado] }>();

const ABAS: { chave: AbaResultado; rotulo: string }[] = [
    { chave: 'todas', rotulo: 'Todas' },
    { chave: 'metricas', rotulo: 'Métricas' },
    { chave: 'analise', rotulo: 'Análise' },
    { chave: 'graficos', rotulo: 'Gráficos' },
    { chave: 'tempo', rotulo: 'Tempo' }
];

const indice = computed(() => ABAS.findIndex(a => a.chave === props.modelValue));
const botoes = ref<HTMLButtonElement[]>([]);

function escolher(i: number): void {
    emit('update:modelValue', ABAS[i].chave);
}

/** Setas, Home e End movem a seleção (e o foco), como em qualquer grupo de abas. */
function aoTeclar(e: KeyboardEvent): void {
    const n = ABAS.length;
    const alvo =
        e.key === 'ArrowRight' ? (indice.value + 1) % n
        : e.key === 'ArrowLeft' ? (indice.value - 1 + n) % n
        : e.key === 'Home' ? 0
        : e.key === 'End' ? n - 1
        : -1;
    if (alvo < 0) return;
    e.preventDefault();
    escolher(alvo);
    void nextTick(() => botoes.value[alvo]?.focus());
}
</script>

<template>
    <nav class="mb-8 flex w-full justify-center" aria-label="Seções do resultado">
        <div
            class="relative grid w-full max-w-2xl grid-cols-5 rounded-full bg-neutral-100/80 p-1 shadow-sm dark:bg-white/5"
            role="tablist"
            @keydown="aoTeclar"
        >
            <!-- O destaque desliza até a aba escolhida: cada aba ocupa 1/5 da largura útil. -->
            <span
                class="indicador pointer-events-none absolute inset-y-1 left-1 rounded-full bg-white shadow-sm ring-1 ring-black/5 dark:bg-white/15 dark:ring-white/10"
                :style="{ width: 'calc((100% - 0.5rem) / 5)', transform: `translateX(${indice * 100}%)` }"
                aria-hidden="true"
            ></span>

            <button
                v-for="(aba, i) in ABAS"
                :key="aba.chave"
                :ref="(el) => { if (el) botoes[i] = el as HTMLButtonElement; }"
                type="button"
                role="tab"
                :aria-selected="modelValue === aba.chave"
                :tabindex="modelValue === aba.chave ? 0 : -1"
                :title="aba.rotulo"
                class="relative z-10 flex items-center justify-center gap-2 rounded-full px-2 py-2 text-sm font-medium transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 sm:px-3"
                :class="modelValue === aba.chave
                    ? 'text-blue-900 dark:text-blue-50'
                    : 'text-neutral-500 hover:text-blue-800 dark:text-neutral-400 dark:hover:text-blue-200'"
                @click="escolher(i)"
            >
                <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="shrink-0 transition-colors duration-200"
                    :class="modelValue === aba.chave ? 'text-blue-600 dark:text-blue-400' : ''"
                    aria-hidden="true"
                >
                    <template v-if="aba.chave === 'todas'">
                        <rect x="3" y="3" width="7" height="7" rx="1.5" />
                        <rect x="14" y="3" width="7" height="7" rx="1.5" />
                        <rect x="3" y="14" width="7" height="7" rx="1.5" />
                        <rect x="14" y="14" width="7" height="7" rx="1.5" />
                    </template>
                    <template v-else-if="aba.chave === 'metricas'">
                        <path d="M3.34 19a10 10 0 1 1 17.32 0" />
                        <path d="M12 14l4-4" />
                    </template>
                    <template v-else-if="aba.chave === 'analise'">
                        <circle cx="11" cy="11" r="7" />
                        <path d="M21 21l-4.3-4.3" />
                    </template>
                    <template v-else-if="aba.chave === 'graficos'">
                        <line x1="4" y1="20" x2="20" y2="20" />
                        <line x1="7" y1="16" x2="7" y2="10" />
                        <line x1="12" y1="16" x2="12" y2="5" />
                        <line x1="17" y1="16" x2="17" y2="12" />
                    </template>
                    <template v-else>
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 7v5l3 2" />
                    </template>
                </svg>
                <span class="hidden sm:inline">{{ aba.rotulo }}</span>
            </button>
        </div>
    </nav>
</template>

<style scoped>
.indicador {
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

@media (prefers-reduced-motion: reduce) {
    .indicador {
        transition: none;
    }
}
</style>
