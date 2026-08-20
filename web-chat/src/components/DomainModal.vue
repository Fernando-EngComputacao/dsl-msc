<script setup lang="ts">
import type { Dominio } from '../api';

defineProps<{
    aberto: boolean;
    dominios: Dominio[];
}>();

const emit = defineEmits<{
    selecionar: [id: string];
    cancelar: [];
}>();
</script>

<template>
    <div class="relative">
        <slot />

        <div v-if="aberto" class="fixed inset-0 z-10" @click="emit('cancelar')"></div>

        <div
            v-if="aberto"
            class="absolute bottom-[calc(100%+8px)] left-0 z-20 min-w-65 rounded-2xl border border-neutral-200 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-neutral-900/70 dark:shadow-2xl dark:shadow-black/40 dark:backdrop-blur-xl"
        >
            <button
                v-for="d in dominios"
                :key="d.id"
                type="button"
                class="flex w-full flex-col items-start gap-0.5 rounded-xl px-3 py-2.5 text-left hover:bg-neutral-100 dark:hover:bg-white/10"
                @click="emit('selecionar', d.id)"
            >
                <span class="text-sm font-medium text-neutral-900 dark:text-neutral-100">{{ d.nome }}</span>
                <span class="text-xs text-neutral-500 dark:text-neutral-400">{{ d.descricao }}</span>
            </button>
        </div>
    </div>
</template>
