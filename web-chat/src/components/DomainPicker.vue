<script setup lang="ts">
import { ref } from 'vue';
import type { Dominio } from '../api';

const props = defineProps<{
    dominios: Dominio[];
    modelValue: string;
}>();

const emit = defineEmits<{
    'update:modelValue': [valor: string];
}>();

const aberto = ref(false);

function selecionar(id: string): void {
    emit('update:modelValue', id);
    aberto.value = false;
}

function atual(): Dominio | undefined {
    return props.dominios.find(d => d.id === props.modelValue);
}
</script>

<template>
    <div class="relative">
        <button
            type="button"
            class="flex items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
            @click="aberto = !aberto"
            :aria-expanded="aberto"
        >
            <span class="max-w-[9rem] truncate sm:max-w-none">{{ atual()?.nome ?? 'Modelo' }}</span>
            <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                class="shrink-0 text-neutral-500 transition-transform dark:text-neutral-400"
                :class="{ 'rotate-180': aberto }"
            >
                <path d="M7 14l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
        </button>

        <div v-if="aberto" class="fixed inset-0 z-10" @click="aberto = false"></div>

        <div
            v-if="aberto"
            class="absolute bottom-[calc(100%+8px)] left-0 z-20 min-w-[260px] rounded-2xl border border-neutral-200 bg-white p-1.5 shadow-xl dark:border-neutral-700 dark:bg-neutral-800"
        >
            <button
                v-for="d in dominios"
                :key="d.id"
                type="button"
                class="flex w-full flex-col items-start gap-0.5 rounded-xl px-3 py-2.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700"
                :class="d.id === modelValue ? 'bg-blue-50 dark:bg-blue-500/15' : ''"
                @click="selecionar(d.id)"
            >
                <span class="text-sm font-medium text-neutral-900 dark:text-neutral-100">{{ d.nome }}</span>
                <span class="text-xs text-neutral-500 dark:text-neutral-400">{{ d.descricao }}</span>
            </button>
        </div>
    </div>
</template>
