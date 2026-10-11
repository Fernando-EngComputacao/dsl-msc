<script setup lang="ts">
import { computed } from 'vue';
import type { RespostaAvaliacao } from '../api';

const props = defineProps<{ resposta: RespostaAvaliacao; origem: 'avaliacao' | 'importacao' }>();

// Mesma formatação de TemposAvaliacao.vue: até 60 s com decimais; acima disso,
// a unidade maior necessária, sempre com as menores, em segundos inteiros.
function formatar(segundos: number): string {
    if (segundos <= 60) return `${segundos.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} s`;
    const total = Math.round(segundos);
    const s = total % 60;
    if (total <= 3600) return `${Math.floor(total / 60)} min ${s} s`;
    const min = Math.floor(total / 60) % 60;
    if (total <= 86400) return `${Math.floor(total / 3600)} h ${min} min ${s} s`;
    return `${Math.floor(total / 86400)} d ${Math.floor(total / 3600) % 24} h ${min} min ${s} s`;
}

const itens = computed(() => [
    { rotulo: 'Total', dica: 'Duração da geração de cada cenário (sorteio, grafo, prompt semântico e geração restrita)', valor: props.resposta.tempoGeracaoTotalSegundos },
    { rotulo: 'Sequências', dica: 'Soma de todas as propostas do Planner, de todos os ciclos (retries incluídos) — só no modo multiagente', valor: props.resposta.tempoGeracaoSequenciasSegundos },
    { rotulo: 'PIs válidas', dica: 'Soma das ondas de execução dos PI Agents até PI_ALL_VALID (geração, validação individual e retries) — só no modo multiagente', valor: props.resposta.tempoGeracaoPIsValidasSegundos },
    { rotulo: 'Validação dos planos', dica: 'Soma da composição e da validação global de todos os ciclos — só no modo multiagente', valor: props.resposta.tempoGeracaoValidacaoPlanosSegundos }
]);

const algumTempo = computed(() => itens.value.some(i => typeof i.valor === 'number'));

// Sem tempo nenhum, o motivo aparece em vez de a seção sumir — e nada é inventado.
const semTempos = computed(() =>
    props.origem === 'importacao'
        ? 'este JSONL não traz tempos de geração. Ou a avaliação foi feita por uma instância antiga do servidor (npm run web:api), que não repassa esses tempos — reinicie-a e avalie de novo o results_…jsonl —, ou o results_…jsonl avaliado veio de antes da medição.'
        : 'a API não devolveu tempos de geração. Se o results_…jsonl enviado traz tempoTotalMs, a API que respondeu é uma instância antiga do servidor (npm run web:api): reinicie-a para carregar o código atual. Senão, o arquivo veio de antes da medição.'
);
</script>

<template>
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
                class="shrink-0 transition-colors duration-200 text-gray-500 dark:text-gray-400"
                aria-hidden="true"
            >
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
        </div>
        <div>
            <p class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Tempo de geração dos planos</p>
            <p class="text-xs text-neutral-500 dark:text-neutral-400">Os números representam o tempo gasto no pipeline de geração de cada plano (Planner, PI Agents e validação global), antes da avaliação.</p>
        </div>
    </div>
    <section class="max-w-5xl rounded-2xl border border-neutral-200 p-4 dark:border-white/10">
        <p class="mb-3 text-sm font-medium text-neutral-800 dark:text-neutral-100">Tempo da geração</p>
        <div v-if="algumTempo" class="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div v-for="item in itens" :key="item.rotulo" :title="item.dica">
                <p class="text-[11px] tracking-wide text-neutral-400 uppercase dark:text-neutral-500">{{ item.rotulo }}</p>
                <p class="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                    {{ typeof item.valor === 'number' ? formatar(item.valor) : '—' }}
                </p>
            </div>
        </div>
        <p v-else class="text-xs text-neutral-500 dark:text-neutral-400">Tempos indisponíveis: {{ semTempos }}</p>
    </section>
</template>
