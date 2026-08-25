<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Dominio } from '../api';
import DomainIcon from './DomainIcon.vue';

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

const atual = computed<Dominio | undefined>(() => props.dominios.find(d => d.id === props.modelValue));
</script>

<template>
    <div class="relative">
        <button
            type="button"
            class="flex items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-200 dark:border dark:border-white/10 dark:bg-white/10 dark:text-neutral-200 dark:backdrop-blur-md dark:hover:bg-white/20"
            @click="aberto = !aberto"
            :aria-expanded="aberto"
        >
            <DomainIcon v-if="atual" :id="atual.id" :size="14" class="shrink-0 text-neutral-500 dark:text-neutral-400" />
            <span class="max-w-[9rem] truncate sm:max-w-none">{{ atual?.nome ?? 'Modelo' }}</span>
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
            class="absolute bottom-[calc(100%+8px)] left-0 z-20 min-w-[260px] rounded-2xl border border-neutral-200 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-neutral-900/70 dark:shadow-2xl dark:shadow-black/40 dark:backdrop-blur-xl"
        >
            <button
                v-for="d in dominios"
                :key="d.id"
                type="button"
                class="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left hover:bg-neutral-100 dark:hover:bg-white/10"
                :class="d.id === modelValue ? 'bg-blue-50 dark:bg-blue-500/15' : ''"
                @click="selecionar(d.id)"
            >
                <span
                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors"
                    :class="d.id === modelValue ? 'bg-blue-600 text-white' : 'bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300'"
                >
                    <DomainIcon :id="d.id" :size="15" />
                </span>
                <span class="flex min-w-0 flex-col items-start gap-0.5">
                    <span class="text-sm font-medium text-neutral-900 dark:text-neutral-100">{{ d.nome }}</span>
                    <span class="text-xs text-neutral-500 dark:text-neutral-400">{{ d.descricao }}</span>
                </span>
            </button>
        </div>
    </div>
</template>
