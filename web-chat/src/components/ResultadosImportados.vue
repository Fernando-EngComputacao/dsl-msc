<script setup lang="ts">
import { computed, ref } from 'vue';
import type { RegistroAvaliacaoImportado } from '../../../src/inference/avaliacao-jsonl';

const props = defineProps<{ registros: RegistroAvaliacaoImportado[]; nomeArquivo: string }>();
const selecionado = ref(0);
const atual = computed(() => props.registros[selecionado.value]);

function formatar(valor: unknown): string {
    if (valor === undefined || valor === null) return 'Não informado';
    if (typeof valor === 'string') return valor;
    return JSON.stringify(valor, null, 2) ?? String(valor);
}

function tempo(valor: number | null | undefined, naoExecutado = false): string {
    if (valor === null && naoExecutado) return 'Não executado';
    if (valor === undefined || valor === null || !Number.isFinite(valor)) return 'Não informado';
    return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(valor)} ms`;
}
</script>

<template>
    <section class="w-full">
        <header class="mb-4 flex flex-wrap items-end justify-between gap-2">
            <div>
                <p class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Resultado importado <span class="ml-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-normal text-neutral-600 dark:bg-white/10 dark:text-neutral-300">{{ registros.length }} registros</span></p>
                <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{{ nomeArquivo }} · dados históricos, sem nova avaliação</p>
            </div>
        </header>

        <div class="overflow-x-auto rounded-xl border border-neutral-200 dark:border-white/10">
            <table class="w-full min-w-[760px] text-left text-xs">
                <thead class="bg-neutral-50 text-neutral-500 dark:bg-white/[0.03] dark:text-neutral-400"><tr>
                    <th class="px-3 py-2">Linha</th><th class="px-3 py-2">Domínio</th><th class="px-3 py-2">Lado</th><th class="px-3 py-2">Intenção</th><th class="px-3 py-2">Sintaxe</th><th class="px-3 py-2">Semântica</th><th class="px-3 py-2">Oráculo</th><th class="px-3 py-2">Judge</th>
                </tr></thead>
                <tbody><tr v-for="(registro, i) in registros" :key="`${registro.lado}-${registro.linha}-${i}`" tabindex="0" class="cursor-pointer border-t border-neutral-100 hover:bg-blue-50/60 focus:bg-blue-50/60 dark:border-white/5 dark:hover:bg-white/[0.04] dark:focus:bg-white/[0.04]" :class="selecionado === i ? 'bg-blue-50/70 dark:bg-blue-500/[0.08]' : ''" @click="selecionado = i" @keydown.enter="selecionado = i">
                    <td class="px-3 py-2 font-mono">{{ registro.linha ?? '—' }}</td><td class="px-3 py-2">{{ registro.dominio ?? '—' }}</td><td class="px-3 py-2">{{ registro.lado ?? '—' }}</td><td class="max-w-64 truncate px-3 py-2" :title="registro.intencao">{{ registro.intencao ?? '—' }}</td><td class="px-3 py-2">{{ registro.validacaoSintatica?.veredito ?? '—' }}</td><td class="px-3 py-2">{{ registro.validacaoSemantica?.veredito ?? '—' }}</td><td class="px-3 py-2">{{ registro.oraculo?.veredito ?? '—' }}</td><td class="px-3 py-2" :class="registro.classificacao === 'DISCORDANCIA_LLM' ? 'font-semibold text-amber-700 dark:text-amber-300' : ''">{{ registro.julgamentoLLM?.status === 'NOT_CALLED' ? 'Não executado' : registro.julgamentoLLM?.status ?? '—' }}</td>
                </tr></tbody>
            </table>
        </div>

        <article v-if="atual" class="mt-5 rounded-xl border border-neutral-200 p-4 dark:border-white/10">
            <header class="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Registro {{ atual.linha ?? selecionado + 1 }} · {{ atual.lado ?? 'resultado' }}</h2><span v-if="atual.classificacao === 'DISCORDANCIA_LLM'" class="rounded-full bg-amber-100 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">Discordância do LLM</span></header>
            <div class="mb-4 grid gap-3 text-xs sm:grid-cols-3"><div><p class="mb-1 text-neutral-400">Domínio · sujeito</p><p class="text-neutral-700 dark:text-neutral-200">{{ atual.dominio ?? 'Não informado' }} · {{ atual.sujeito ?? 'Não informado' }}</p></div><div><p class="mb-1 text-neutral-400">Intenção</p><p class="text-neutral-700 dark:text-neutral-200">{{ atual.intencao ?? 'Não informado' }}</p></div><div><p class="mb-1 text-neutral-400">Concordância · classificação</p><p class="text-neutral-700 dark:text-neutral-200">{{ atual.concordancia === undefined ? 'Não informado' : atual.concordancia ? 'Concorda' : 'Discorda' }} · {{ atual.classificacao ?? 'Não informado' }}</p></div></div>
            <section class="mb-4"><p class="mb-1 text-xs font-medium text-neutral-500">Plano</p><pre class="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-50 p-3 font-mono text-[11px] text-neutral-700 dark:bg-black/20 dark:text-neutral-300">{{ atual.plano ?? 'Não informado' }}</pre></section>
            <section class="mb-4"><p class="mb-2 text-xs font-medium text-neutral-500">Tempo de execução</p><div class="grid max-w-xl grid-cols-2 gap-2"><div class="rounded-lg bg-neutral-50 px-3 py-2 dark:bg-white/[0.04]"><p class="text-[11px] text-neutral-400">Oráculo</p><p class="text-sm text-neutral-700 dark:text-neutral-200">{{ tempo(atual.tempos?.oraculoMs) }}</p></div><div class="rounded-lg bg-neutral-50 px-3 py-2 dark:bg-white/[0.04]"><p class="text-[11px] text-neutral-400">LLM Judge</p><p class="text-sm text-neutral-700 dark:text-neutral-200">{{ tempo(atual.tempos?.llmJudgeMs, atual.julgamentoLLM?.status === 'NOT_CALLED') }}</p></div></div></section>
            <details v-for="secao in [{ chave: 'validacaoSintatica', titulo: 'Validação sintática' }, { chave: 'ast', titulo: 'AST' }, { chave: 'validacaoSemantica', titulo: 'Validação semântica' }, { chave: 'oraculo', titulo: 'Oráculo' }, { chave: 'julgamentoLLM', titulo: 'LLM Judge' }]" :key="secao.chave" class="mb-2 rounded-lg border border-neutral-100 px-3 py-2 dark:border-white/5">
                <summary class="cursor-pointer text-xs font-medium text-neutral-600 dark:text-neutral-300">{{ secao.titulo }}</summary>
                <pre class="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-50 p-3 font-mono text-[10px] leading-relaxed text-neutral-600 dark:bg-black/20 dark:text-neutral-400">{{ formatar(atual[secao.chave]) }}</pre>
            </details>
        </article>
    </section>
</template>
