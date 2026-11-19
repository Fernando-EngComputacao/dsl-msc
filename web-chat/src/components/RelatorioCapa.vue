<script setup lang="ts">
/**
 * A capa do relatório: só existe no papel (classe `somente-impressao`, ver
 * style.css). Diz o que foi avaliado, quando o arquivo foi exportado e quais
 * tópicos ele traz — para o PDF se explicar sozinho, longe da tela que o gerou.
 *
 * Nenhum dado é calculado aqui: o conteúdo vem de `resumoDaCapa` (relatorio.ts),
 * que omite o que o resultado não informa em vez de preencher com "—".
 */
import type { ResumoCapa } from '../relatorio';

defineProps<{ resumo: ResumoCapa }>();
</script>

<template>
    <section class="somente-impressao evitar-quebra mb-8 border-b border-neutral-300 pb-5">
        <p class="text-[11px] font-semibold tracking-widest text-neutral-500 uppercase">
            UFG · Instituto de Informática · PPGCC
        </p>
        <h1 class="mt-1 text-xl font-semibold text-neutral-900">{{ resumo.titulo }}</h1>
        <p class="mt-0.5 text-xs text-neutral-500">Exportado em {{ resumo.geradoEm }}</p>

        <dl class="mt-4 grid grid-cols-2 gap-x-8 gap-y-1.5 text-xs">
            <div v-for="item in resumo.itens" :key="item.rotulo" class="flex gap-2">
                <dt class="shrink-0 text-neutral-500">{{ item.rotulo }}:</dt>
                <dd class="min-w-0 font-medium text-neutral-800">{{ item.valor }}</dd>
            </div>
        </dl>

        <div v-if="resumo.topicos.length" class="mt-4">
            <p class="text-[11px] font-semibold tracking-wide text-neutral-500 uppercase">Conteúdo deste relatório</p>
            <ol class="mt-1 list-decimal pl-5 text-xs text-neutral-700">
                <li v-for="topico in resumo.topicos" :key="topico">{{ topico }}</li>
            </ol>
        </div>
    </section>
</template>
