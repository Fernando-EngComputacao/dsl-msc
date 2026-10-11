<script setup lang="ts">
import type { PassoAplicado } from '../../../src/inference/metodologia-avaliacao';
import Tex from './Tex.vue';
import TextoMat from './TextoMat.vue';

/**
 * Um passo da metodologia aplicado aos dados, na sequência
 * FÓRMULA → DADOS → SUBSTITUIÇÃO → RESULTADO. Tudo vem pronto de
 * `aplicarMetodologia` (mesmas fórmulas de TEX, mesmos números da análise):
 * aqui nada é calculado.
 */
defineProps<{ passo: PassoAplicado; mostrarTitulo?: boolean }>();

const ETAPAS = ['Fórmula', 'Dados', 'Substituição', 'Resultado'] as const;
</script>

<template>
    <div class="passo">
        <p v-if="mostrarTitulo" class="mb-2 text-xs font-semibold text-neutral-800 dark:text-neutral-100">{{ passo.titulo }}</p>
        <ol class="relative ml-1 border-l border-neutral-200 dark:border-white/10">
            <li v-for="(etapa, i) in ETAPAS" :key="etapa" class="relative pb-3 pl-5 last:pb-0">
                <span
                    class="absolute top-0.5 -left-[9px] flex h-[18px] w-[18px] items-center justify-center rounded-full border text-[10px] font-semibold"
                    :class="etapa === 'Resultado'
                        ? 'border-blue-500 bg-blue-600 text-white dark:border-blue-400 dark:bg-blue-500'
                        : 'border-neutral-300 bg-white text-neutral-500 dark:border-white/20 dark:bg-neutral-900 dark:text-neutral-400'"
                    aria-hidden="true"
                >{{ i + 1 }}</span>
                <p class="text-[10px] font-semibold tracking-[0.08em] text-neutral-400 uppercase dark:text-neutral-500">{{ etapa }}</p>

                <div v-if="etapa === 'Fórmula'" class="mt-0.5">
                    <Tex v-for="(e, k) in passo.equacoes" :key="k" :tex="`${e.lhs} = ${e.formula}`" display />
                    <p v-if="passo.equacoes.length === 0" class="text-xs text-neutral-500 dark:text-neutral-400">Sem equação aplicável neste conjunto (ver os dados).</p>
                </div>

                <ul v-else-if="etapa === 'Dados'" class="mt-1 space-y-1 text-xs text-neutral-700 dark:text-neutral-300">
                    <li v-for="(d, k) in passo.dados" :key="k"><TextoMat :texto="d" /></li>
                </ul>

                <div v-else-if="etapa === 'Substituição'" class="mt-0.5">
                    <Tex v-for="(e, k) in passo.equacoes" :key="k" :tex="`${e.lhs} = ${e.substituicao}`" display />
                </div>

                <div v-else class="mt-1 rounded-lg border border-blue-200 bg-blue-50/60 px-2 py-1 dark:border-blue-400/25 dark:bg-blue-500/[0.07]">
                    <template v-for="(e, k) in passo.equacoes" :key="k">
                        <Tex :tex="`${e.lhs} = ${e.resultado}`" display />
                        <p v-if="e.nota" class="px-1 pb-1 text-[11px] text-amber-800 dark:text-amber-300">{{ e.nota }}</p>
                    </template>
                    <p v-if="passo.equacoes.length === 0" class="px-1 py-1 text-xs text-neutral-600 dark:text-neutral-300">Não estimável neste conjunto: nenhum valor é exibido.</p>
                </div>
            </li>
        </ol>
        <details class="mt-2 text-[11px] text-neutral-500 dark:text-neutral-400">
            <summary class="cursor-pointer select-none hover:text-neutral-700 dark:hover:text-neutral-200">Versão em texto (copiável)</summary>
            <pre class="mt-1 overflow-x-auto rounded-md bg-neutral-50 px-2.5 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-neutral-700 dark:bg-white/5 dark:text-neutral-300">{{ passo.linhas.join('\n') }}</pre>
        </details>
    </div>
</template>
