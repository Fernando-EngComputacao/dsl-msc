<script setup lang="ts">
import { computed } from 'vue';
import type { Mensagem } from '../types';

const props = defineProps<{ mensagem: Mensagem }>();
const emit = defineEmits<{ baixar: [] }>();

const lote = computed(() => props.mensagem.lote!);

const percentual = computed(() => {
    const l = lote.value;
    if (l.total === 0) return 0;
    return Math.round((l.concluidos / l.total) * 100);
});

const statusTexto = computed(() => {
    const l = lote.value;
    if (!l.finalizado) return `${l.concluidos}/${l.total} concluídos…`;
    if (l.cancelado) return `Interrompido: ${l.concluidos}/${l.total} concluídos`;
    return `Concluído: ${l.concluidos}/${l.total}`;
});
</script>

<template>
    <div class="mb-6 flex w-full max-w-full gap-3.5">
        <div
            class="relative mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-100 dark:border dark:border-white/10 dark:bg-white/10 dark:backdrop-blur-md"
        >
            <span
                v-if="!lote.finalizado"
                class="absolute inset-0 animate-ping rounded-full bg-gradient-to-br from-blue-400 via-purple-400 to-rose-400 opacity-30"
            ></span>
            <svg width="16" height="16" viewBox="0 0 24 24" class="relative text-neutral-500 dark:text-neutral-300">
                <path
                    d="M21.44 11.05l-8.49 8.49a5 5 0 01-7.07-7.07l8.49-8.49a3.5 3.5 0 014.95 4.95l-8.49 8.49a2 2 0 01-2.83-2.83l7.78-7.78"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                />
            </svg>
        </div>

        <div class="min-w-0 flex-1 rounded-2xl border border-neutral-200 px-4 py-3.5 dark:border-white/10 dark:bg-white/5 dark:backdrop-blur-md">
            <div class="mb-2.5 flex items-center justify-between gap-2">
                <span class="truncate text-sm font-medium text-neutral-700 dark:text-neutral-200">{{ lote.nomeArquivo }}</span>
                <span class="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">{{ statusTexto }}</span>
            </div>

            <div class="h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-white/10">
                <div
                    class="h-full rounded-full bg-gradient-to-r from-blue-500 via-purple-400 to-rose-400 transition-[width] duration-300 ease-out"
                    :class="!lote.finalizado ? 'animate-pulse' : ''"
                    :style="{ width: `${percentual}%` }"
                ></div>
            </div>

            <p v-if="!lote.finalizado && lote.estagioAtual" class="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                {{ lote.estagioAtual }}
            </p>

            <button
                v-if="lote.finalizado"
                type="button"
                class="mt-3 inline-flex items-center gap-1.5 rounded-full border border-neutral-200 px-3.5 py-1.5 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:border-white/10 dark:text-neutral-400 dark:backdrop-blur-md dark:hover:bg-white/10 dark:hover:text-neutral-100"
                @click="emit('baixar')"
            >
                <svg width="15" height="15" viewBox="0 0 24 24">
                    <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                Baixar resultados ({{ lote.resultados.length }})
            </button>
        </div>
    </div>
</template>
