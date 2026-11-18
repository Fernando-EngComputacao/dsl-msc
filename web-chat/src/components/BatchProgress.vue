<script setup lang="ts">
import { computed } from 'vue';
import type { Mensagem } from '../types';
import { resumoVereditos } from '../resultados-lote';

const props = defineProps<{ mensagem: Mensagem }>();
const emit = defineEmits<{ baixar: [] }>();

const lote = computed(() => props.mensagem.lote!);

/** Só com o gate ligado: o que a avaliação decidiu nas linhas já prontas. */
const vereditos = computed(() => (lote.value.validacao ? resumoVereditos(lote.value.resultados) : null));

/** Gerações além de uma por cenário — o que o gate cobrou para chegar nos planos aprovados. */
const regeracoes = computed(() => {
    const v = vereditos.value;
    if (!v) return 0;
    return Math.max(0, v.geracoes - lote.value.resultados.length);
});

/** O juiz participou da decisão de repetir? (muda o que os selos querem dizer) */
const juizNoCriterio = computed(() => lote.value.validacao?.criterio !== 'oraculo');

const rotuloCriterio = computed(() => {
    const criterio = lote.value.validacao?.criterio;
    if (criterio === 'juiz') return 'juiz LLM';
    if (criterio === 'oraculo') return 'oráculo';
    return 'oráculo + juiz';
});

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

            <!-- Gate: o veredito de cada linha já sai aqui, e o arquivo baixado já vem avaliado. -->
            <div v-if="vereditos" class="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                <!-- Os selos de veredito sao do ORACULO; o criterio (quem manda regerar) vai no title. -->
                <span
                    class="text-neutral-400 dark:text-neutral-500"
                    :title="`Critério do gate: ${rotuloCriterio}`"
                    >oráculo:</span
                >
                <span class="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                    {{ vereditos.valid }} VALID
                </span>
                <span
                    v-if="vereditos.invalid > 0"
                    class="rounded-full bg-rose-50 px-2 py-0.5 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
                >
                    {{ vereditos.invalid }} INVALID
                </span>
                <span
                    v-if="vereditos.unresolved > 0"
                    class="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
                >
                    {{ vereditos.unresolved }} UNRESOLVED
                </span>
                <span
                    v-if="vereditos.naoAvaliados > 0"
                    class="rounded-full bg-neutral-100 px-2 py-0.5 text-neutral-500 dark:bg-white/10 dark:text-neutral-400"
                >
                    {{ vereditos.naoAvaliados }} não avaliado(s)
                </span>
                <span
                    v-if="juizNoCriterio && vereditos.juizReprovou > 0"
                    class="rounded-full bg-violet-50 px-2 py-0.5 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300"
                >
                    juiz reprovou {{ vereditos.juizReprovou }}
                </span>
                <span v-if="regeracoes > 0" class="text-neutral-400 dark:text-neutral-500">
                    · {{ regeracoes }} regeração(ões) ({{ vereditos.descartesPeloOraculo }} pelo
                    oráculo, {{ vereditos.descartesPeloJuiz }} pelo juiz)
                </span>
                <span v-if="vereditos.limiteAtingido > 0" class="text-amber-600 dark:text-amber-400">
                    · {{ vereditos.limiteAtingido }} no teto de {{ lote.validacao?.maxTentativas }} tentativas
                </span>
            </div>

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
