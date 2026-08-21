<script setup lang="ts">
import type { ChatResumo } from '../api';

defineProps<{
    aberta: boolean;
    chats: ChatResumo[];
    chatAtualId: string | null;
}>();

const emit = defineEmits<{
    'novo-chat': [];
    'abrir-chat': [id: string];
    fechar: [];
}>();

function formatarData(iso: string): string {
    const data = new Date(iso);
    const hoje = new Date();
    const mesmoDia = data.toDateString() === hoje.toDateString();
    return mesmoDia
        ? data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        : data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}
</script>

<template>
    <Transition name="backdrop-fade">
        <div v-if="aberta" class="fixed inset-0 z-30 bg-neutral-900/30 backdrop-blur-sm md:hidden" @click="emit('fechar')"></div>
    </Transition>

    <aside
        class="fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col overflow-hidden border-r border-neutral-200 bg-neutral-50 transition-[width,transform,opacity] duration-300 ease-in-out md:static md:z-auto md:min-w-0 dark:border-white/10 dark:bg-neutral-900/60 dark:backdrop-blur-xl"
        :class="aberta ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-100 md:w-0 md:translate-x-0 md:border-transparent md:opacity-0'"
    >
        <div class="p-3">
            <button
                type="button"
                class="flex w-full items-center gap-2.5 rounded-full border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-100 dark:border-white/10 dark:bg-white/5 dark:text-neutral-100 dark:hover:bg-white/10"
                @click="emit('novo-chat')"
            >
                <svg width="16" height="16" viewBox="0 0 24 24" class="shrink-0">
                    <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </svg>
                Novo chat
            </button>
        </div>

        <div class="flex-1 overflow-y-auto px-3 pb-3">
            <p class="px-2 pt-1 pb-2 text-xs font-medium tracking-wide text-neutral-400 uppercase dark:text-neutral-500">Histórico</p>

            <p v-if="chats.length === 0" class="px-2 py-2 text-sm text-neutral-400 dark:text-neutral-500">Nenhuma conversa ainda.</p>

            <button
                v-for="c in chats"
                :key="c.id"
                type="button"
                class="mb-0.5 flex w-full flex-col items-start gap-0.5 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-neutral-200/60 dark:hover:bg-white/10"
                :class="c.id === chatAtualId ? 'bg-blue-50 dark:bg-blue-500/15' : ''"
                :title="c.titulo"
                @click="emit('abrir-chat', c.id)"
            >
                <span class="w-full truncate text-sm text-neutral-800 dark:text-neutral-200">{{ c.titulo }}</span>
                <span class="text-xs text-neutral-400 dark:text-neutral-500">{{ formatarData(c.atualizadoEm) }}</span>
            </button>
        </div>

        <div class="flex items-center gap-2.5 border-t border-neutral-200 px-4 py-3 dark:border-white/10">
            <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">FF</div>
            <span class="truncate text-sm font-medium text-neutral-700 dark:text-neutral-200">Fernando Furtado</span>
        </div>
    </aside>
</template>

<style scoped>
.backdrop-fade-enter-active,
.backdrop-fade-leave-active {
    transition: opacity 0.2s ease;
}

.backdrop-fade-enter-from,
.backdrop-fade-leave-to {
    opacity: 0;
}
</style>
