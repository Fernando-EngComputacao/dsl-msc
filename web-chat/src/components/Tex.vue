<script setup lang="ts">
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { computed } from 'vue';

/**
 * Uma fórmula LaTeX renderizada pelo KaTeX. `display` = equação em bloco
 * (centralizada, com rolagem horizontal própria quando não cabe); sem ele,
 * matemática em linha. A saída inclui MathML, lido por leitores de tela.
 */
const props = withDefaults(defineProps<{ tex: string; display?: boolean }>(), { display: false });

const html = computed(() =>
    katex.renderToString(props.tex, { displayMode: props.display, throwOnError: false, strict: 'ignore', output: 'htmlAndMathml' })
);
</script>

<template>
    <span :class="display ? 'tex-bloco' : 'tex-linha'" v-html="html"></span>
</template>

<style>
.tex-bloco {
    display: block;
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 0.35rem 0.25rem;
}
.tex-bloco .katex-display {
    margin: 0;
}
.tex-linha .katex {
    font-size: 1.04em;
}
.tex-bloco .katex {
    font-size: 1.12em;
}
</style>
