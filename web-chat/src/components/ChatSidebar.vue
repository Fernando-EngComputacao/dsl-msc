<script setup lang="ts">
defineProps<{
    aberta: boolean;
}>();

const emit = defineEmits<{
    'novo-chat': [];
    fechar: [];
}>();
</script>

<template>
    <Transition name="backdrop-fade">
        <div v-if="aberta" class="fixed inset-0 z-30 bg-neutral-900/30 backdrop-blur-sm md:hidden" @click="emit('fechar')"></div>
    </Transition>

    <aside
        class="fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col overflow-hidden border-r border-neutral-200/70 bg-white/70 shadow-xl shadow-black/5 backdrop-blur-xl transition-[width,transform,opacity] duration-300 ease-in-out md:static md:z-auto md:min-w-0 dark:border-white/10 dark:bg-neutral-900/50 dark:shadow-2xl dark:shadow-black/30 dark:backdrop-blur-xl"
        :class="aberta ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-100 md:w-0 md:translate-x-0 md:border-transparent md:opacity-0'"
    >
        <div class="p-3">
            <button
                type="button"
                class="flex w-full items-center gap-2.5 rounded-full border border-neutral-200/70 bg-white/50 px-4 py-2.5 text-sm font-medium text-neutral-800 backdrop-blur-md transition-colors hover:bg-white/80 dark:border-white/10 dark:bg-white/10 dark:text-neutral-100 dark:hover:bg-white/20"
                @click="emit('novo-chat')"
            >
                <svg width="16" height="16" viewBox="0 0 24 24" class="shrink-0">
                    <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </svg>
                Novo chat
            </button>
        </div>

        <div class="flex-1 space-y-3.5 overflow-y-auto px-3 pb-3">
            <section class="rounded-2xl border border-neutral-200/60 bg-white/40 p-3.5 dark:border-white/10 dark:bg-white/5">
                <div class="mb-3 flex items-center gap-2 text-neutral-500 dark:text-neutral-400">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                    </svg>
                    <h3 class="text-xs font-semibold tracking-wide uppercase">Pesquisa</h3>
                </div>

                <div class="space-y-3">
                    <div class="flex items-start gap-2.5">
                        <div class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="8" r="7" />
                                <path d="M8.21 13.89L7 23l5-3 5 3-1.21-9.12" />
                            </svg>
                        </div>
                        <div class="min-w-0 flex-1">
                            <dt class="text-xs text-neutral-400 dark:text-neutral-500">Orientador</dt>
                            <dd class="text-sm leading-snug text-neutral-800 dark:text-neutral-200">Dr. Prof. Fábio Moreira Costa</dd>
                        </div>
                    </div>

                    <div class="flex items-start gap-2.5">
                        <div class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                                <circle cx="12" cy="7" r="4" />
                            </svg>
                        </div>
                        <div class="min-w-0 flex-1">
                            <dt class="text-xs text-neutral-400 dark:text-neutral-500">Mestrando</dt>
                            <dd class="text-sm leading-snug text-neutral-800 dark:text-neutral-200">
                                Engenheiro de Computação e Mestrando Fernando Souza Furtado Carrilho
                            </dd>
                        </div>
                    </div>

                    <div class="flex items-start gap-2.5">
                        <div class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                                <line x1="16" y1="2" x2="16" y2="6" />
                                <line x1="8" y1="2" x2="8" y2="6" />
                                <line x1="3" y1="10" x2="21" y2="10" />
                            </svg>
                        </div>
                        <div class="min-w-0 flex-1">
                            <dt class="text-xs text-neutral-400 dark:text-neutral-500">Ano</dt>
                            <dd class="text-sm leading-snug text-neutral-800 dark:text-neutral-200">2026/02</dd>
                        </div>
                    </div>

                    <div class="flex items-start gap-2.5">
                        <div class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                                <circle cx="12" cy="10" r="3" />
                            </svg>
                        </div>
                        <div class="min-w-0 flex-1">
                            <dt class="text-xs text-neutral-400 dark:text-neutral-500">Local</dt>
                            <dd class="text-sm leading-snug text-neutral-800 dark:text-neutral-200">Goiânia, Goiás, Brasil</dd>
                        </div>
                    </div>
                </div>
            </section>

            <section class="rounded-2xl border border-neutral-200/60 bg-white/40 p-3.5 dark:border-white/10 dark:bg-white/5">
                <div class="mb-3 flex items-center gap-2 text-neutral-500 dark:text-neutral-400">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                        <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                        <line x1="6" y1="6" x2="6.01" y2="6" />
                        <line x1="6" y1="18" x2="6.01" y2="18" />
                    </svg>
                    <h3 class="text-xs font-semibold tracking-wide uppercase">Ambiente do experimento</h3>
                </div>

                <div class="space-y-3">
                    <div class="flex items-start gap-2.5">
                        <div class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
                                <rect x="9" y="9" width="6" height="6" />
                                <line x1="9" y1="1" x2="9" y2="4" />
                                <line x1="15" y1="1" x2="15" y2="4" />
                                <line x1="9" y1="20" x2="9" y2="23" />
                                <line x1="15" y1="20" x2="15" y2="23" />
                                <line x1="20" y1="9" x2="23" y2="9" />
                                <line x1="20" y1="14" x2="23" y2="14" />
                                <line x1="1" y1="9" x2="4" y2="9" />
                                <line x1="1" y1="14" x2="4" y2="14" />
                            </svg>
                        </div>
                        <div class="min-w-0 flex-1">
                            <dt class="text-xs text-neutral-400 dark:text-neutral-500">Processador</dt>
                            <dd class="text-sm leading-snug text-neutral-800 dark:text-neutral-200">Intel(R) Core(TM) i7-12700H, 2.30 GHz</dd>
                        </div>
                    </div>

                    <div class="flex items-start gap-2.5">
                        <div class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="22" y1="12" x2="2" y2="12" />
                                <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
                                <line x1="6" y1="16" x2="6.01" y2="16" />
                                <line x1="10" y1="16" x2="10.01" y2="16" />
                            </svg>
                        </div>
                        <div class="min-w-0 flex-1">
                            <dt class="text-xs text-neutral-400 dark:text-neutral-500">Memória RAM</dt>
                            <dd class="text-sm leading-snug text-neutral-800 dark:text-neutral-200">32 GB @ 4800 MT/s</dd>
                        </div>
                    </div>

                    <div class="flex items-start gap-2.5">
                        <div class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                                <line x1="8" y1="21" x2="16" y2="21" />
                                <line x1="12" y1="17" x2="12" y2="21" />
                            </svg>
                        </div>
                        <div class="min-w-0 flex-1">
                            <dt class="text-xs text-neutral-400 dark:text-neutral-500">Placa gráfica</dt>
                            <dd class="text-sm leading-snug text-neutral-800 dark:text-neutral-200">NVIDIA GeForce RTX 3060 · 6GB VRAM</dd>
                        </div>
                    </div>

                    <div class="flex items-start gap-2.5">
                        <div class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z" />
                            </svg>
                        </div>
                        <div class="min-w-0 flex-1">
                            <dt class="text-xs text-neutral-400 dark:text-neutral-500">Temperatura média da sala</dt>
                            <dd class="text-sm leading-snug text-neutral-800 dark:text-neutral-200">22 °C</dd>
                        </div>
                    </div>
                </div>
            </section>
        </div>

        <div class="flex items-center gap-2.5 border-t border-neutral-200/70 px-4 py-3 dark:border-white/10">
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
