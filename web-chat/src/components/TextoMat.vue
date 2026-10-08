<script setup lang="ts">
import { computed } from 'vue';
import Tex from './Tex.vue';

/**
 * Texto corrido da metodologia: o que está entre `$…$` vira matemática em
 * linha e o que está entre `$$…$$`, equação em bloco; o resto é texto.
 */
const props = defineProps<{ texto: string }>();

type Parte = { tipo: 'texto' | 'linha' | 'bloco'; valor: string };

const partes = computed<Parte[]>(() => {
    const saida: Parte[] = [];
    let ultimo = 0;
    for (const m of props.texto.matchAll(/\$\$([\s\S]+?)\$\$|\$([^$]+?)\$/g)) {
        if (m.index > ultimo) saida.push({ tipo: 'texto', valor: props.texto.slice(ultimo, m.index) });
        saida.push(m[1] !== undefined ? { tipo: 'bloco', valor: m[1] } : { tipo: 'linha', valor: m[2] });
        ultimo = m.index + m[0].length;
    }
    if (ultimo < props.texto.length) saida.push({ tipo: 'texto', valor: props.texto.slice(ultimo) });
    return saida;
});
</script>

<template>
    <span><template v-for="(p, i) in partes" :key="i"><Tex v-if="p.tipo !== 'texto'" :tex="p.valor" :display="p.tipo === 'bloco'" /><template v-else>{{ p.valor }}</template></template></span>
</template>
