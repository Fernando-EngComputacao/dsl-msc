<script setup lang="ts">
/**
 * Seção 2: o tempo de geração POR TAMANHO — por caractere e por token, com o
 * tamanho médio do input e quanto ele explica do tempo.
 *
 * Duas taxas, de propósito, porque respondem perguntas diferentes:
 *   agregada   Σtempo / Σtamanho — o custo do lote por unidade (planos grandes pesam mais);
 *   por plano  a média das razões de cada plano (todo plano pesa igual).
 *
 * A última coluna é a pergunta do usuário: o tamanho do input influencia o
 * tempo? `r` é a correlação de Pearson e `r²` a fração da variação do tempo que
 * o tamanho explica. Correlação não é causa, e com n pequeno ela oscila muito —
 * por isso o n aparece ao lado, sempre.
 */
import { computed } from 'vue';
import type { RespostaAvaliacao } from '../api';
import {
    formatarDuracaoMs,
    formatarInteiro,
    formatarNumero,
    formatarPercentual,
    ladosPresentes,
    tempoPorTamanho,
    type LadoAvaliado
} from '../tempos-plano';

const props = defineProps<{ resposta: RespostaAvaliacao; origem: 'avaliacao' | 'importacao' }>();

const lados = computed(() => ladosPresentes(props.resposta));
const analises = computed(() => lados.value.map(lado => ({ lado, dados: tempoPorTamanho(props.resposta, lado) })));
const rotulo = (lado: LadoAvaliado): string => (lado === 'arquitetura' ? 'Arquitetura' : 'Baseline');

const algumaMedida = computed(() => analises.value.some(a => a.dados.algumaMedida));
const semTokens = computed(() => analises.value.every(a => a.dados.semTokens));

const semTempos = computed(() =>
    props.origem === 'importacao'
        ? 'este JSONL não traz o tempo de geração por plano (só o total do arquivo, ou nem isso). Avalie de novo o results_…jsonl com o servidor atual para gravá-lo por plano.'
        : 'a API não devolveu o tempo de geração por plano. Se for uma instância antiga do servidor (npm run web:api), reinicie-a; se o results_…jsonl avaliado não traz tempoTotalMs, ele é anterior à medição.'
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
                    <path d="M3 3v18h18" />
                    <path d="M7 15l4-4 3 3 5-6" />
                </svg>
            </div>
            <div>
                <p class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Tempo de geração por tamanho</p>
                <p class="text-xs text-neutral-500 dark:text-neutral-400">
                    Quanto custa gerar, por caractere e por token, e qual é o tamanho médio do input — para ver
                    se o tamanho da entrada influencia o tempo de processamento.
                </p>
            </div>
        </div>

        <section class="max-w-5xl rounded-2xl border border-neutral-200 p-4 dark:border-white/10">
            <template v-if="algumaMedida">
                <div class="flex flex-col gap-6">
                    <div v-for="a in analises" :key="a.lado">
                        <div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                            <p class="text-sm font-medium text-neutral-800 dark:text-neutral-100">{{ rotulo(a.lado) }}</p>
                            <p class="text-xs text-neutral-500 dark:text-neutral-400">
                                {{ a.dados.n }} plano(s) com tempo de geração · média
                                <span class="font-medium text-neutral-700 dark:text-neutral-200">{{
                                    formatarDuracaoMs(a.dados.geracao?.media)
                                }}</span>
                                <span v-if="a.dados.geracao?.desvioPadrao != null">
                                    ± {{ formatarDuracaoMs(a.dados.geracao.desvioPadrao) }} (dp)</span
                                >
                            </p>
                        </div>

                        <div v-if="a.dados.algumaMedida" class="-mx-1 overflow-x-auto px-1">
                            <table class="w-full min-w-[42rem] border-collapse text-left text-xs">
                                <thead>
                                    <tr class="text-[11px] tracking-wide text-neutral-400 uppercase dark:text-neutral-500">
                                        <th class="py-1.5 pr-3 font-normal">Unidade</th>
                                        <th class="py-1.5 pr-3 font-normal" title="Planos em que tempo e tamanho existem">n</th>
                                        <th class="py-1.5 pr-3 font-normal">Tamanho médio</th>
                                        <th class="py-1.5 pr-3 font-normal" title="Σtempo / Σtamanho: o custo do lote por unidade">
                                            Taxa agregada
                                        </th>
                                        <th
                                            class="py-1.5 pr-3 font-normal"
                                            title="Média das razões tempo/tamanho de cada plano, ± desvio padrão"
                                        >
                                            Por plano
                                        </th>
                                        <th class="py-1.5 pr-3 font-normal" title="Correlação de Pearson entre tamanho e tempo">r</th>
                                        <th class="py-1.5 font-normal" title="Fração da variação do tempo explicada pelo tamanho">r²</th>
                                    </tr>
                                </thead>
                                <tbody class="text-neutral-700 dark:text-neutral-200">
                                    <tr
                                        v-for="item in a.dados.itens"
                                        :key="item.rotulo"
                                        class="border-t border-neutral-100 dark:border-white/5"
                                        :class="item.analise.n === 0 ? 'text-neutral-400 dark:text-neutral-500' : ''"
                                    >
                                        <th class="py-1.5 pr-3 text-left font-normal" :title="item.dica">
                                            {{ item.rotulo }}
                                            <span
                                                class="ml-1 rounded-full px-1.5 py-0.5 text-[10px]"
                                                :class="
                                                    item.papel === 'input'
                                                        ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300'
                                                        : 'bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-400'
                                                "
                                                >{{ item.papel === 'input' ? 'entrada' : 'saída' }}</span
                                            >
                                        </th>
                                        <td class="py-1.5 pr-3 tabular-nums">{{ item.analise.n }}</td>
                                        <td class="py-1.5 pr-3 tabular-nums">
                                            {{ formatarInteiro(item.analise.tamanho?.media) }}
                                            <span v-if="item.analise.tamanho" class="text-neutral-400 dark:text-neutral-500">
                                                {{ item.unidade === 'token' ? 'tok' : 'car' }}</span
                                            >
                                        </td>
                                        <td class="py-1.5 pr-3 tabular-nums">
                                            {{ formatarDuracaoMs(item.analise.agregada) }}
                                        </td>
                                        <td class="py-1.5 pr-3 tabular-nums">
                                            {{ formatarDuracaoMs(item.analise.porPlano?.media) }}
                                            <span
                                                v-if="item.analise.porPlano?.desvioPadrao != null"
                                                class="text-neutral-400 dark:text-neutral-500"
                                            >
                                                ± {{ formatarDuracaoMs(item.analise.porPlano.desvioPadrao) }}</span
                                            >
                                        </td>
                                        <td class="py-1.5 pr-3 tabular-nums">{{ formatarNumero(item.analise.regressao?.r, 2) }}</td>
                                        <td class="py-1.5 tabular-nums">{{ formatarPercentual(item.analise.regressao?.r2) }}</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                        <p v-else class="text-xs text-neutral-500 dark:text-neutral-400">
                            Sem par tempo/tamanho neste lado.
                        </p>
                    </div>
                </div>

                <p class="mt-4 border-t border-neutral-200 pt-3 text-[11px] leading-relaxed text-neutral-500 dark:border-white/10 dark:text-neutral-400">
                    <strong class="font-medium">Como ler.</strong> A taxa agregada responde "quanto custa processar este
                    volume"; a taxa por plano, "quanto custa um plano típico" — elas divergem quando os planos têm
                    tamanhos muito diferentes. <strong class="font-medium">r</strong> mede só associação linear entre
                    tamanho e tempo, não causa: no pipeline multiagente o tempo também depende do número de PIs e das
                    repetições, que crescem junto com o tamanho.
                    <span v-if="semTokens">
                        As linhas em token aparecem vazias porque nenhum plano trouxe a contagem — ela é feita na
                        avaliação, chamando <code>/tokenizar</code> no motor do domínio (só com
                        <code>SPC_CML_BACKEND=llamacpp</code>). Nada é estimado a partir dos caracteres.
                    </span>
                </p>
            </template>
            <p v-else class="text-xs text-neutral-500 dark:text-neutral-400">Medidas indisponíveis: {{ semTempos }}</p>
        </section>
    </div>
</template>
