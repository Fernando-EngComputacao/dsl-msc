<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import ExperimentoModal from './ExperimentoModal.vue';

defineProps<{
    aberta: boolean;
}>();

const emit = defineEmits<{
    'novo-chat': [];
    fechar: [];
}>();

const route = useRoute();
const emChat = computed(() => route.path === '/');
const modalAberto = ref(false);

const rotas = [
    { caminho: '/', titulo: 'Chat', icone: 'chat', sub: [] as { modo: string; titulo: string }[] },
    {
        caminho: '/avaliar',
        titulo: 'Avaliar resultados',
        icone: 'avaliar',
        sub: [
            { modo: 'julgar', titulo: 'Julgar resultado' },
            { modo: 'importar', titulo: 'Importar resultado' }
        ]
    }
];

const modoAtivo = computed(() => (route.query.modo === 'importar' ? 'importar' : 'julgar'));
// Submenu visível ao passar o mouse (recolhe ao sair) ou fixado pela seta.
const fixado = ref<Record<string, boolean>>({});
const pairando = ref<string | null>(null);
const visivel = (caminho: string): boolean => !!fixado.value[caminho] || pairando.value === caminho;
</script>

<template>
    <Transition name="backdrop-fade">
        <div v-if="aberta" class="fixed inset-0 z-30 bg-neutral-900/30 backdrop-blur-sm md:hidden" @click="emit('fechar')"></div>
    </Transition>

    <aside
        class="fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col overflow-hidden border-r border-neutral-200/70 bg-white/30 shadow-xl shadow-black/5 backdrop-blur-xl transition-[width,transform,opacity] duration-300 ease-in-out md:static md:z-auto md:min-w-0 dark:border-white/10 dark:bg-neutral-900/50 dark:shadow-2xl dark:shadow-black/30 dark:backdrop-blur-xl"
        :class="aberta ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-100 md:w-0 md:translate-x-0 md:border-transparent md:opacity-0'"
    >
        <div v-if="emChat" class="p-3 pb-0">
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

        <!-- Rotas -->
        <nav class="flex-1 overflow-y-auto p-3">
            <p class="px-3 pb-2 text-[11px] font-semibold tracking-wider text-neutral-400 uppercase dark:text-neutral-500">Navegação</p>
            <div class="relative flex flex-col gap-1">
                <!-- Indicador deslizante: acompanha o item ativo (passo = h-10 + gap-1 = 44px) -->
                <span
                    v-if="indiceAtivo >= 0"
                    class="pointer-events-none absolute inset-x-0 top-0 h-10 rounded-xl bg-blue-500/10 ring-1 ring-blue-500/20 transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] dark:bg-blue-400/10 dark:ring-blue-400/20"
                    :style="{ transform: `translateY(${indiceAtivo * 44}px)` }"
                >
                    <span class="absolute top-2.5 bottom-2.5 left-0 w-0.5 rounded-full bg-blue-600 dark:bg-blue-400"></span>
                </span>

                <div
                    v-for="rota in rotas"
                    :key="rota.caminho"
                    class="relative"
                    @mouseenter="rota.sub.length && (pairando = rota.caminho)"
                    @mouseleave="pairando === rota.caminho && (pairando = null)"
                >
                    <RouterLink
                        :to="rota.caminho"
                        class="group relative flex h-10 items-center gap-3 rounded-xl px-3.5 text-sm transition-colors duration-200"
                        :class="
                            route.path === rota.caminho
                                ? 'font-medium text-blue-700 dark:text-blue-300'
                                : 'text-neutral-600 hover:bg-neutral-900/5 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-white/5 dark:hover:text-neutral-100'
                        "
                    >
                        <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.8"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            class="shrink-0 transition-transform duration-200 group-hover:scale-110"
                        >
                            <template v-if="rota.icone === 'chat'">
                                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                            </template>
                            <template v-else>
                                <line x1="18" y1="20" x2="18" y2="10" />
                                <line x1="12" y1="20" x2="12" y2="4" />
                                <line x1="6" y1="20" x2="6" y2="14" />
                            </template>
                        </svg>
                        <span class="truncate">{{ rota.titulo }}</span>
                    </RouterLink>

                    <button
                        v-if="rota.sub.length"
                        type="button"
                        class="absolute top-1.5 right-2 flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-900/5 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-white/10 dark:hover:text-neutral-200"
                        :title="fixado[rota.caminho] ? 'Desafixar' : 'Fixar aberto'"
                        :aria-expanded="visivel(rota.caminho)"
                        @click="fixado[rota.caminho] = !fixado[rota.caminho]"
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            class="transition-transform duration-300"
                            :class="visivel(rota.caminho) ? 'rotate-90' : ''"
                        >
                            <path d="M9 18l6-6-6-6" />
                        </svg>
                    </button>

                    <div
                        v-if="rota.sub.length"
                        class="grid transition-[grid-template-rows,opacity] duration-300 ease-in-out"
                        :class="visivel(rota.caminho) ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'"
                    >
                        <div class="overflow-hidden">
                            <div class="mt-1 ml-[1.65rem] space-y-0.5 border-l border-neutral-200 pl-2.5 dark:border-white/10">
                                <RouterLink
                                    v-for="item in rota.sub"
                                    :key="item.modo"
                                    :to="{ path: rota.caminho, query: { modo: item.modo } }"
                                    :tabindex="visivel(rota.caminho) ? 0 : -1"
                                    class="flex h-8 items-center gap-2 rounded-lg px-3 text-[13px] transition-colors duration-200"
                                    :class="
                                        route.path === rota.caminho && modoAtivo === item.modo
                                            ? 'bg-blue-500/10 font-medium text-blue-700 dark:bg-blue-400/10 dark:text-blue-300'
                                            : 'text-neutral-500 hover:bg-neutral-900/5 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-100'
                                    "
                                >
                                    <span
                                        class="h-1.5 w-1.5 shrink-0 rounded-full transition-colors"
                                        :class="route.path === rota.caminho && modoAtivo === item.modo ? 'bg-blue-600 dark:bg-blue-400' : 'bg-neutral-300 dark:bg-neutral-600'"
                                    ></span>
                                    {{ item.titulo }}
                                </RouterLink>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </nav>

        <!-- Informações do experimento (modal externo) -->
        <div class="px-3 pb-3">
            <button
                type="button"
                class="flex w-full items-center gap-2.5 rounded-full px-4 py-2 text-sm text-neutral-600 transition-colors hover:bg-neutral-900/5 dark:text-neutral-300 dark:hover:bg-white/5"
                @click="modalAberto = true"
            >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4M12 8h.01" />
                </svg>
                Informações do experimento
            </button>
        </div>

        <div class="flex items-center gap-2.5 border-t border-neutral-200/70 px-4 py-3 dark:border-white/10">
            <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">FF</div>
            <span class="truncate text-sm font-medium text-neutral-700 dark:text-neutral-200">Fernando Furtado</span>
        </div>
    </aside>
    <ExperimentoModal :aberto="modalAberto" @fechar="modalAberto = false" />
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
