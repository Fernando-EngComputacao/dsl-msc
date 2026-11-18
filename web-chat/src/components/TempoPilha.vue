<script setup lang="ts">
/**
 * Seção 1 das análises de tempo: o TOTAL DA PILHA — a soma do tempo de geração
 * dos planos com o tempo de avaliação dos planos.
 *
 * Fica entre as duas seções que já existiam (geração e avaliação) porque é
 * exatamente a soma delas. O que rodou dentro da geração mas não é geração — a
 * validação do gate e as gerações descartadas — aparece como parcela à parte,
 * fora do total pedido, com o total ampliado embaixo.
 */
import { computed } from 'vue';
import type { RespostaAvaliacao } from '../api';
import { formatarSegundos, pilhaDeTempos } from '../tempos-plano';

const props = defineProps<{ resposta: RespostaAvaliacao; origem: 'avaliacao' | 'importacao' }>();

const pilha = computed(() => pilhaDeTempos(props.resposta));
const naPilha = computed(() => pilha.value.parcelas.filter(p => !p.extra));
const foraDaPilha = computed(() => pilha.value.parcelas.filter(p => p.extra));

const valor = (segundos: number | null): string => (segundos === null ? '—' : formatarSegundos(segundos));

const semTempos = computed(() =>
    props.origem === 'importacao'
        ? 'este JSONL não traz os tempos das duas etapas (foi gravado antes da medição).'
        : 'a API não devolveu os tempos das duas etapas. Se for uma instância antiga do servidor (npm run web:api), reinicie-a para carregar o código atual.'
);
</script>

<template>
    <div>
        <div class="mb-3 flex items-center gap-2.5">
            <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300">
                <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="shrink-0 text-gray-500 dark:text-gray-400"
                    aria-hidden="true"
                >
                    <polygon points="12 2 2 7 12 12 22 7 12 2" />
                    <polyline points="2 17 12 22 22 17" />
                    <polyline points="2 12 12 17 22 12" />
                </svg>
            </div>
            <div>
                <p class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Tempo total da pilha</p>
                <p class="text-xs text-neutral-500 dark:text-neutral-400">
                    A soma das duas etapas: gerar os planos e avaliá-los. É o custo de ponta a ponta do
                    experimento, do pedido em linguagem natural ao veredito.
                </p>
            </div>
        </div>

        <section class="max-w-5xl rounded-2xl border border-neutral-200 p-4 dark:border-white/10">
            <template v-if="pilha.algumaMedida">
                <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <div v-for="p in naPilha" :key="p.rotulo" :title="p.dica">
                        <p class="text-[11px] tracking-wide text-neutral-400 uppercase dark:text-neutral-500">{{ p.rotulo }}</p>
                        <p class="text-sm font-medium text-neutral-800 dark:text-neutral-100">{{ valor(p.segundos) }}</p>
                    </div>
                    <div
                        class="rounded-xl bg-neutral-50 px-3 py-2 dark:bg-white/5"
                        title="Geração + avaliação. Ausente se uma das duas etapas não foi medida — a soma parcial não é apresentada como total"
                    >
                        <p class="text-[11px] tracking-wide text-neutral-400 uppercase dark:text-neutral-500">Total da pilha</p>
                        <p class="text-base font-semibold text-neutral-900 dark:text-neutral-50">{{ valor(pilha.totalSegundos) }}</p>
                    </div>
                </div>

                <!-- O que rodou dentro da geração mas não é geração: fica fora do total pedido. -->
                <div v-if="foraDaPilha.length > 0" class="mt-4 border-t border-neutral-200 pt-3 dark:border-white/10">
                    <p class="mb-2 text-[11px] tracking-wide text-neutral-400 uppercase dark:text-neutral-500">
                        Fora do total (rodou durante a geração, no lote)
                    </p>
                    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        <div v-for="p in foraDaPilha" :key="p.rotulo" :title="p.dica">
                            <p class="text-[11px] text-neutral-400 dark:text-neutral-500">{{ p.rotulo }}</p>
                            <p class="text-sm font-medium text-neutral-700 dark:text-neutral-200">{{ valor(p.segundos) }}</p>
                        </div>
                        <div v-if="pilha.totalComGateSegundos !== null" title="Total da pilha mais a validação feita no gate">
                            <p class="text-[11px] text-neutral-400 dark:text-neutral-500">Pilha com o gate</p>
                            <p class="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                                {{ valor(pilha.totalComGateSegundos) }}
                            </p>
                        </div>
                    </div>
                </div>
            </template>
            <p v-else class="text-xs text-neutral-500 dark:text-neutral-400">Tempos indisponíveis: {{ semTempos }}</p>
        </section>
    </div>
</template>
