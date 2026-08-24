<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { MetricasAvaliacao } from '../api';

const props = defineProps<{
    variante: 'arquitetura' | 'baseline';
    metricas: MetricasAvaliacao;
    /** Métricas do outro lado (se presentes), só pra exibir o delta — nunca o inverso. */
    comparar?: MetricasAvaliacao;
}>();

type ChaveMetrica = 'semanticaCorreta' | 'sintaxeCorreta' | 'violacoes';

const LINHAS: Array<{ chave: ChaveMetrica; label: string; icone: 'check' | 'code' | 'alert'; cor: string; melhorQuandoMaior: boolean }> = [
    { chave: 'semanticaCorreta', label: 'Semântica correta', icone: 'check', cor: 'blue', melhorQuandoMaior: true },
    { chave: 'sintaxeCorreta', label: 'Sintaxe correta', icone: 'code', cor: 'emerald', melhorQuandoMaior: true },
    { chave: 'violacoes', label: 'Violações', icone: 'alert', cor: 'rose', melhorQuandoMaior: false }
];

const CORES: Record<string, { bg: string; texto: string; barra: string }> = {
    blue: { bg: 'bg-blue-50 dark:bg-blue-500/15', texto: 'text-blue-600 dark:text-blue-400', barra: 'bg-blue-500' },
    emerald: { bg: 'bg-emerald-50 dark:bg-emerald-500/15', texto: 'text-emerald-600 dark:text-emerald-400', barra: 'bg-emerald-500' },
    rose: { bg: 'bg-rose-50 dark:bg-rose-500/15', texto: 'text-rose-600 dark:text-rose-400', barra: 'bg-rose-500' }
};

/** Barras nascem em 0% e só assumem a largura real depois do primeiro paint —
 *  senão a transição CSS não tem um "de onde" animar (chega pronta). */
const crescida = ref(false);
onMounted(() => requestAnimationFrame(() => requestAnimationFrame(() => (crescida.value = true))));

function percentual(chave: ChaveMetrica): number {
    if (props.metricas.total === 0) return 0;
    return Math.round((props.metricas[chave] / props.metricas.total) * 100);
}

function delta(chave: ChaveMetrica): number | null {
    if (!props.comparar) return null;
    return props.metricas[chave] - props.comparar[chave];
}

function deltaBom(chave: ChaveMetrica, valor: number): boolean {
    const melhorQuandoMaior = LINHAS.find(l => l.chave === chave)!.melhorQuandoMaior;
    return melhorQuandoMaior ? valor > 0 : valor < 0;
}
</script>

<template>
    <div
        class="animate-fade-in-up rounded-2xl border p-5 shadow-sm"
        :class="
            variante === 'arquitetura'
                ? 'border-blue-200/70 bg-blue-50/40 dark:border-blue-500/20 dark:bg-blue-500/[0.04]'
                : 'border-neutral-200 bg-white dark:border-white/10 dark:bg-white/5'
        "
    >
        <div class="mb-4 flex items-center gap-2.5">
            <div
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                :class="variante === 'arquitetura' ? 'bg-blue-100 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400' : 'bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300'"
            >
                <svg v-if="variante === 'arquitetura'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                    <rect x="9" y="9" width="6" height="6" />
                    <line x1="9" y1="2" x2="9" y2="4" />
                    <line x1="15" y1="2" x2="15" y2="4" />
                    <line x1="9" y1="20" x2="9" y2="22" />
                    <line x1="15" y1="20" x2="15" y2="22" />
                    <line x1="20" y1="9" x2="22" y2="9" />
                    <line x1="20" y1="15" x2="22" y2="15" />
                    <line x1="2" y1="9" x2="4" y2="9" />
                    <line x1="2" y1="15" x2="4" y2="15" />
                </svg>
            </div>
            <p class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                {{ variante === 'arquitetura' ? 'Arquitetura' : 'Baseline' }}
            </p>
        </div>

        <div class="space-y-4">
            <div
                v-for="(linha, i) in LINHAS"
                :key="linha.chave"
                class="animate-fade-in-up"
                :style="{ animationDelay: `${90 + i * 70}ms` }"
            >
                <div class="mb-1.5 flex items-center gap-2">
                    <div class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full" :class="CORES[linha.cor].bg">
                        <svg v-if="linha.icone === 'check'" width="11" height="11" viewBox="0 0 24 24" fill="none" :class="CORES[linha.cor].texto" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M20 6L9 17l-5-5" />
                        </svg>
                        <svg v-else-if="linha.icone === 'code'" width="11" height="11" viewBox="0 0 24 24" fill="none" :class="CORES[linha.cor].texto" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="16 18 22 12 16 6" />
                            <polyline points="8 6 2 12 8 18" />
                        </svg>
                        <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" :class="CORES[linha.cor].texto" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                    </div>

                    <span class="flex-1 text-sm text-neutral-600 dark:text-neutral-300">{{ linha.label }}</span>

                    <span
                        v-if="delta(linha.chave) !== null && delta(linha.chave) !== 0"
                        class="rounded-full px-1.5 py-0.5 text-[11px] font-medium"
                        :class="
                            deltaBom(linha.chave, delta(linha.chave)!)
                                ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400'
                                : 'bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-400'
                        "
                        :title="`vs. baseline: ${delta(linha.chave)! > 0 ? '+' : ''}${delta(linha.chave)}`"
                    >
                        {{ delta(linha.chave)! > 0 ? '+' : '' }}{{ delta(linha.chave) }}
                    </span>

                    <span class="font-mono text-sm tabular-nums text-neutral-800 dark:text-neutral-100">{{ metricas[linha.chave] }}/{{ metricas.total }}</span>
                </div>
                <div class="h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-white/10">
                    <div
                        class="h-full rounded-full transition-[width] duration-700 ease-out"
                        :class="CORES[linha.cor].barra"
                        :style="{ width: (crescida ? percentual(linha.chave) : 0) + '%' }"
                    ></div>
                </div>
            </div>
        </div>
    </div>
</template>
