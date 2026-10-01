<script setup lang="ts">
import { computed } from 'vue';
import type { RespostaAvaliacao } from '../api';

const props = defineProps<{ resposta: RespostaAvaliacao; origem: 'avaliacao' | 'importacao' }>();

// Até 60 s: segundos com decimais. Acima disso: a unidade maior necessária, sempre com as menores
// (min + s; h + min + s; d + h + min + s), em segundos inteiros.
function formatar(segundos: number): string {
    if (segundos <= 60) return `${segundos.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} s`;
    const total = Math.round(segundos); // arredonda antes de decompor, para o resto não "vazar" (59,7 min → 60 min 0 s)
    const s = total % 60;
    if (total <= 3600) return `${Math.floor(total / 60)} min ${s} s`;
    const min = Math.floor(total / 60) % 60;
    if (total <= 86400) return `${Math.floor(total / 3600)} h ${min} min ${s} s`;
    return `${Math.floor(total / 86400)} d ${Math.floor(total / 3600) % 24} h ${min} min ${s} s`;
}

const itens = computed(() => [
    { rotulo: 'Total', dica: 'Duração da avaliação inteira (oráculo e juiz rodam em paralelo)', valor: props.resposta.tempoTotalSegundos },
    { rotulo: 'Sintaxe', dica: 'Soma da validação sintática de todos os planos', valor: props.resposta.tempoSintaxeSegundos },
    { rotulo: 'Oráculo', dica: 'Soma da validação semântica de todos os planos', valor: props.resposta.tempoOraculoSegundos },
    { rotulo: 'LLM Judge', dica: 'Soma das chamadas ao LLM Judge de todos os planos', valor: props.resposta.tempoLlmJudgeSegundos }
]);

const algumTempo = computed(() => itens.value.some(i => typeof i.valor === 'number'));

// Sem tempo nenhum, o motivo aparece em vez de a seção sumir — e nada é inventado.
const semTempos = computed(() =>
    props.origem === 'importacao'
        ? 'este JSONL não traz tempos (foi gravado antes da medição, ou por uma versão do servidor sem ela).'
        : 'a API que respondeu não enviou a medição. Provavelmente é uma instância antiga do servidor (npm run web:api): reinicie-a para carregar o código atual.'
);
</script>

<template>
    <section class="max-w-5xl rounded-2xl border border-neutral-200 p-4 dark:border-white/10">
        <p class="mb-3 text-sm font-medium text-neutral-800 dark:text-neutral-100">Tempo da avaliação</p>
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
