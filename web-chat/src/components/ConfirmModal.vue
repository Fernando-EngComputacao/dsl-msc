<script setup lang="ts">
defineProps<{
    aberto: boolean;
    titulo: string;
    mensagem: string;
    textoConfirmar?: string;
    textoCancelar?: string;
}>();

const emit = defineEmits<{
    confirmar: [];
    cancelar: [];
}>();
</script>

<template>
    <Teleport to="body">
        <Transition name="modal-fade">
            <div v-if="aberto" class="fixed inset-0 z-50 flex items-center justify-center p-4">
                <div
                    class="absolute inset-0 bg-neutral-900/30 backdrop-blur-sm dark:bg-black/50"
                    @click="emit('cancelar')"
                ></div>

                <div
                    class="relative w-full max-w-sm rounded-3xl border border-neutral-200 bg-white/90 p-6 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-neutral-900/70 dark:shadow-black/40"
                >
                    <h2 class="text-base font-semibold text-neutral-900 dark:text-neutral-100">{{ titulo }}</h2>
                    <p class="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">{{ mensagem }}</p>

                    <div class="mt-6 flex justify-end gap-2.5">
                        <button
                            type="button"
                            class="rounded-full px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-white/10"
                            @click="emit('cancelar')"
                        >
                            {{ textoCancelar ?? 'Cancelar' }}
                        </button>
                        <button
                            type="button"
                            class="rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600"
                            @click="emit('confirmar')"
                        >
                            {{ textoConfirmar ?? 'Trocar mesmo assim' }}
                        </button>
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
