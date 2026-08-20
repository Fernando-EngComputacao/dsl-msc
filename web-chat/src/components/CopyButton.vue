<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{ texto: string }>();
const copiado = ref(false);

async function copiar(): Promise<void> {
    try {
        await navigator.clipboard.writeText(props.texto);
    } catch {
        // Fallback para contextos sem Clipboard API (ex.: http sem TLS).
        const area = document.createElement('textarea');
        area.value = props.texto;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.focus();
        area.select();
        document.execCommand('copy');
        area.remove();
    }
    copiado.value = true;
    setTimeout(() => (copiado.value = false), 1500);
}
</script>

<template>
    <button
        type="button"
        class="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-white/10 dark:hover:text-neutral-200"
        :title="copiado ? 'Copiado!' : 'Copiar'"
        @click.stop.prevent="copiar"
    >
        <svg v-if="!copiado" width="13" height="13" viewBox="0 0 24 24">
            <rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2" />
            <path d="M5 15V5a2 2 0 012-2h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
        <svg v-else width="13" height="13" viewBox="0 0 24 24" class="text-emerald-500">
            <path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>{{ copiado ? 'Copiado' : 'Copiar' }}</span>
    </button>
</template>
