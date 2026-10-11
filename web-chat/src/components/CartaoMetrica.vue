<script setup lang="ts">
import type { IdDocumentacao } from '../../../src/inference/metodologia-avaliacao';

/**
 * Um indicador da análise estatística: título, valor, contexto (numerador /
 * denominador) e uma frase de leitura. O valor chega pronto da camada de
 * cálculo — o cartão só o apresenta. O "(?)" abre a metodologia da métrica.
 */
defineProps<{
    titulo: string;
    valor: string;
    contexto?: string;
    descricao?: string;
    ancora?: IdDocumentacao;
    destaque?: boolean;
}>();
const emit = defineEmits<{ ajuda: [ancora: IdDocumentacao] }>();
</script>

<template>
    <div
        class="group relative flex min-w-0 flex-col rounded-2xl border p-4 transition-colors"
        :class="destaque
            ? 'border-blue-300 bg-blue-50/70 ring-1 ring-blue-500/20 dark:border-blue-400/40 dark:bg-blue-500/10'
            : 'border-neutral-200 bg-white hover:border-neutral-300 dark:border-white/10 dark:bg-white/[0.02] dark:hover:border-white/20'"
    >
        <div class="flex items-start justify-between gap-2">
            <!-- Sem caixa alta: ela transformaria "κ" em "Κ", que se lê como K. -->
            <p class="text-xs font-semibold tracking-wide" :class="'text-neutral-500 dark:text-neutral-400'">{{ titulo }}</p>
            <button
                v-if="ancora"
                type="button"
                class="ajuda -mt-0.5 -mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
                :class="'border-neutral-300 text-neutral-400 hover:border-blue-500 hover:text-blue-600 dark:border-white/20 dark:text-neutral-500 dark:hover:border-blue-400 dark:hover:text-blue-300'"
                :aria-label="`Metodologia: ${titulo}`"
                :data-tip="'Como é calculado'"
                @click="emit('ajuda', ancora)"
            >?</button>
        </div>
        <p class="mt-2 text-[1.7rem] leading-none font-semibold tracking-tight tabular-nums" :class="'text-neutral-900 dark:text-neutral-50'">{{ valor }}</p>
        <p v-if="contexto" class="mt-2 text-xs tabular-nums" :class="'text-neutral-600 dark:text-neutral-300'">{{ contexto }}</p>
        <p v-if="descricao" class="mt-0.5 text-[11px]" :class="'text-neutral-400 dark:text-neutral-500'">{{ descricao }}</p>
        <slot />
    </div>
</template>

<style scoped>
/* Dica do "(?)" como pseudo-elemento: não entra no texto da página. */
.ajuda {
    position: relative;
}
.ajuda::after {
    content: attr(data-tip);
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    z-index: 20;
    white-space: nowrap;
    border-radius: 6px;
    padding: 3px 7px;
    font-size: 10.5px;
    font-weight: 500;
    background: rgb(23 23 23);
    color: white;
    opacity: 0;
    pointer-events: none;
    transform: translateY(-2px);
    transition: opacity 0.12s ease, transform 0.12s ease;
}
.ajuda:hover::after,
.ajuda:focus-visible::after {
    opacity: 1;
    transform: translateY(0);
}
.dark .ajuda::after {
    background: rgb(245 245 245);
    color: rgb(23 23 23);
}
</style>
