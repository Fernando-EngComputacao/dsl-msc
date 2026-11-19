<script setup lang="ts">
/**
 * O que uma unidade das tabelas de tempo por plano significa, de onde o número
 * vem e um exemplo numérico fechado.
 *
 * Só apresentação: o conteúdo vive em `detalhe-tempo.ts`, e `tempos-plano.test.ts`
 * cobra que toda linha das duas tabelas tem detalhe e vice-versa.
 */
import { ROTULO_SECAO, type DetalheTempo } from '../detalhe-tempo';

const props = defineProps<{ detalhe: DetalheTempo | null }>();
const emit = defineEmits<{ fechar: [] }>();

const TITULO_BLOCO = 'mb-1.5 text-[11px] font-semibold tracking-wide text-neutral-400 uppercase dark:text-neutral-500';
const CORPO = 'text-xs leading-relaxed text-neutral-700 dark:text-neutral-200';
const CARTAO = 'rounded-2xl border border-neutral-200/70 bg-white/40 p-3.5 dark:border-white/10 dark:bg-white/5';
</script>

<template>
    <Teleport to="body">
        <Transition name="modal-fade">
            <div
                v-if="props.detalhe"
                class="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4"
                role="dialog"
                aria-modal="true"
                aria-labelledby="detalhe-tempo-titulo"
                tabindex="-1"
                @keydown.esc="emit('fechar')"
            >
                <div class="absolute inset-0 bg-neutral-900/30 backdrop-blur-sm dark:bg-black/50" @click="emit('fechar')"></div>

                <div
                    class="relative flex max-h-full w-full max-w-2xl flex-col rounded-3xl border border-neutral-200 bg-white/95 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-neutral-900/80 dark:shadow-black/40"
                >
                    <div class="flex items-start justify-between gap-4 px-6 pt-5 pb-3">
                        <div>
                            <p class="text-[11px] font-medium tracking-wide text-neutral-400 uppercase dark:text-neutral-500">
                                {{ ROTULO_SECAO[props.detalhe.secao] }}
                            </p>
                            <h2 id="detalhe-tempo-titulo" class="mt-0.5 text-base font-semibold text-neutral-900 dark:text-neutral-100">
                                {{ props.detalhe.rotulo }}
                            </h2>
                        </div>
                        <button
                            type="button"
                            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-white/10"
                            title="Fechar"
                            aria-label="Fechar"
                            @click="emit('fechar')"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24">
                                <path d="M18 6L6 18M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                            </svg>
                        </button>
                    </div>

                    <div class="space-y-3.5 overflow-y-auto px-6 pb-6">
                        <section>
                            <p :class="TITULO_BLOCO">O que é</p>
                            <p :class="CORPO">{{ props.detalhe.oQueE }}</p>
                        </section>

                        <section :class="CARTAO">
                            <p :class="TITULO_BLOCO">De onde vem o número</p>
                            <p class="mb-1.5">
                                <code class="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-700 dark:bg-white/10 dark:text-neutral-200">{{
                                    props.detalhe.origem.campo
                                }}</code>
                            </p>
                            <p :class="CORPO">{{ props.detalhe.origem.texto }}</p>
                        </section>

                        <section>
                            <p :class="TITULO_BLOCO">O que a tabela mostra</p>
                            <p :class="CORPO">{{ props.detalhe.comoSeUsa }}</p>
                        </section>

                        <section class="rounded-2xl border border-blue-200/70 bg-blue-50/50 p-3.5 dark:border-blue-500/20 dark:bg-blue-500/5">
                            <p class="mb-1.5 text-[11px] font-semibold tracking-wide text-blue-700 uppercase dark:text-blue-300">
                                Exemplo
                            </p>

                            <dl class="mb-2.5 space-y-1">
                                <div v-for="d in props.detalhe.exemplo.dados" :key="d.rotulo" class="flex flex-wrap gap-x-2 text-xs">
                                    <dt class="text-neutral-500 dark:text-neutral-400">{{ d.rotulo }}:</dt>
                                    <dd class="font-medium text-neutral-800 tabular-nums dark:text-neutral-100">{{ d.valor }}</dd>
                                </div>
                            </dl>

                            <ul class="mb-2.5 space-y-1">
                                <li
                                    v-for="(linha, i) in props.detalhe.exemplo.conta"
                                    :key="i"
                                    class="rounded-lg bg-white/70 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-neutral-700 tabular-nums dark:bg-black/20 dark:text-neutral-200"
                                >
                                    {{ linha }}
                                </li>
                            </ul>

                            <p :class="CORPO">{{ props.detalhe.exemplo.leitura }}</p>
                        </section>

                        <section>
                            <p :class="TITULO_BLOCO">Cuidado ao interpretar</p>
                            <p :class="CORPO">{{ props.detalhe.cuidado }}</p>
                        </section>

                        <section>
                            <p :class="TITULO_BLOCO">Quando a linha fica vazia</p>
                            <p :class="CORPO">{{ props.detalhe.quandoVazio }}</p>
                        </section>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.modal-fade-enter-active,
.modal-fade-leave-active {
    transition: opacity 0.15s ease;
}

.modal-fade-enter-from,
.modal-fade-leave-to {
    opacity: 0;
}
</style>
