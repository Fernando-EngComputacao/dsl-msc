<script setup lang="ts">
/**
 * Seção 3: quanto tempo custa UM plano — a geração mais a validação que rodou
 * durante ela (o gate: oráculo e/ou LLM Judge, uma vez por tentativa).
 *
 * Essa validação não está na seção "tempo da avaliação" (que é a desta tela) nem
 * na de "tempo de geração": ela é de outra etapa, e é por isso que esta seção
 * existe. As parcelas vêm ao lado, com a MESMA estatística, para a soma poder
 * ser conferida.
 *
 * Estatística: média, desvio padrão AMOSTRAL (n−1) e intervalo de confiança de
 * 95% da MÉDIA, pela t de Student. O IC diz a incerteza sobre a média, não onde
 * cai o próximo plano — por isso mediana, quartis e mín–máx aparecem ao lado:
 * tempos costumam ter cauda longa à direita, e nesse caso média e mediana se
 * separam.
 */
import { computed } from 'vue';
import type { RespostaAvaliacao } from '../api';
import {
    formatarDuracaoMs,
    formatarIntervalo,
    formatarPercentual,
    ladosPresentes,
    tempoPorPlano,
    type LadoAvaliado
} from '../tempos-plano';

const props = defineProps<{ resposta: RespostaAvaliacao; origem: 'avaliacao' | 'importacao' }>();

const lados = computed(() => ladosPresentes(props.resposta));
const analises = computed(() => lados.value.map(lado => ({ lado, dados: tempoPorPlano(props.resposta, lado) })));
const rotulo = (lado: LadoAvaliado): string => (lado === 'arquitetura' ? 'Arquitetura' : 'Baseline');

const algumaMedida = computed(() => analises.value.some(a => a.dados.algumaMedida));

const semTempos = computed(() =>
    props.origem === 'importacao'
        ? 'este JSONL não traz tempos por plano. Avalie de novo o results_…jsonl com o servidor atual para gravá-los.'
        : 'a API não devolveu tempos por plano. Se for uma instância antiga do servidor (npm run web:api), reinicie-a.'
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
                    <line x1="4" y1="19" x2="20" y2="19" />
                    <rect x="6" y="9" width="4" height="7" />
                    <rect x="14" y="5" width="4" height="11" />
                </svg>
            </div>
            <div>
                <p class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Tempo por plano (geração + validação)</p>
                <p class="text-xs text-neutral-500 dark:text-neutral-400">
                    O custo de produzir um plano: a geração mais a validação feita durante ela, no gate do lote.
                    Com média, desvio padrão, intervalo de confiança de 95% e a distribuição ao lado.
                </p>
            </div>
        </div>

        <section class="max-w-5xl rounded-2xl border border-neutral-200 p-4 dark:border-white/10">
            <template v-if="algumaMedida">
                <div class="flex flex-col gap-6">
                    <div v-for="a in analises" :key="a.lado">
                        <p class="mb-2 text-sm font-medium text-neutral-800 dark:text-neutral-100">{{ rotulo(a.lado) }}</p>
                        <div class="-mx-1 overflow-x-auto px-1">
                            <table class="w-full min-w-[52rem] border-collapse text-left text-xs">
                                <thead>
                                    <tr class="text-[11px] tracking-wide text-neutral-400 uppercase dark:text-neutral-500">
                                        <th class="py-1.5 pr-3 font-normal">Amostra</th>
                                        <th class="py-1.5 pr-3 font-normal" title="Planos com esta medida">n</th>
                                        <th class="py-1.5 pr-3 font-normal">Média</th>
                                        <th class="py-1.5 pr-3 font-normal" title="Desvio padrão amostral (divisor n−1)">dp</th>
                                        <th class="py-1.5 pr-3 font-normal" title="Intervalo de confiança de 95% da média (t de Student)">
                                            IC 95% da média
                                        </th>
                                        <th class="py-1.5 pr-3 font-normal">Mediana</th>
                                        <th class="py-1.5 pr-3 font-normal" title="1º e 3º quartis">Q1–Q3</th>
                                        <th class="py-1.5 pr-3 font-normal">Mín–Máx</th>
                                        <th class="py-1.5 font-normal" title="Coeficiente de variação: dp/média">CV</th>
                                    </tr>
                                </thead>
                                <tbody class="text-neutral-700 dark:text-neutral-200">
                                    <tr
                                        v-for="amostra in a.dados.amostras"
                                        :key="amostra.rotulo"
                                        class="border-t border-neutral-100 dark:border-white/5"
                                        :class="[
                                            amostra.resumo === null ? 'text-neutral-400 dark:text-neutral-500' : '',
                                            amostra.principal ? 'bg-neutral-50 dark:bg-white/5' : ''
                                        ]"
                                    >
                                        <th
                                            class="py-1.5 pr-3 text-left font-normal"
                                            :class="amostra.principal ? 'font-medium text-neutral-900 dark:text-neutral-50' : ''"
                                            :title="amostra.dica"
                                        >
                                            {{ amostra.rotulo }}
                                        </th>
                                        <td class="py-1.5 pr-3 tabular-nums">{{ amostra.resumo?.n ?? 0 }}</td>
                                        <td
                                            class="py-1.5 pr-3 tabular-nums"
                                            :class="amostra.principal ? 'font-medium text-neutral-900 dark:text-neutral-50' : ''"
                                        >
                                            {{ formatarDuracaoMs(amostra.resumo?.media) }}
                                        </td>
                                        <td class="py-1.5 pr-3 tabular-nums">{{ formatarDuracaoMs(amostra.resumo?.desvioPadrao) }}</td>
                                        <td class="py-1.5 pr-3 tabular-nums">{{ formatarIntervalo(amostra.resumo) }}</td>
                                        <td class="py-1.5 pr-3 tabular-nums">{{ formatarDuracaoMs(amostra.resumo?.mediana) }}</td>
                                        <td class="py-1.5 pr-3 tabular-nums">
                                            {{ formatarDuracaoMs(amostra.resumo?.q1) }} – {{ formatarDuracaoMs(amostra.resumo?.q3) }}
                                        </td>
                                        <td class="py-1.5 pr-3 tabular-nums">
                                            {{ formatarDuracaoMs(amostra.resumo?.minimo) }} – {{ formatarDuracaoMs(amostra.resumo?.maximo) }}
                                        </td>
                                        <td class="py-1.5 tabular-nums">{{ formatarPercentual(amostra.resumo?.coeficienteVariacao) }}</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <p class="mt-4 border-t border-neutral-200 pt-3 text-[11px] leading-relaxed text-neutral-500 dark:border-white/10 dark:text-neutral-400">
                    <strong class="font-medium">Como ler.</strong> O desvio padrão é amostral (n−1) e descreve a
                    dispersão entre planos; o IC de 95% é da <em>média</em>, pela t de Student, e encolhe com n — ele
                    não diz onde cai o próximo plano. O IC supõe observações independentes e média aproximadamente
                    normal; com n pequeno e cauda longa (o caso típico de tempos) ele é otimista, e a mediana com os
                    quartis descreve melhor o plano típico. Linha vazia é medida que o arquivo não trouxe: o lote sem
                    gate não tem validação durante a geração, e nesse caso a linha principal é igual à da geração.
                </p>
            </template>
            <p v-else class="text-xs text-neutral-500 dark:text-neutral-400">Medidas indisponíveis: {{ semTempos }}</p>
        </section>
    </div>
</template>
