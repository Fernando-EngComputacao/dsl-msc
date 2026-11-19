<script setup lang="ts">
/**
 * Modal de exportação do relatório: quais tópicos entram no PDF.
 *
 * Só apresentação — a lista de tópicos, o que está disponível e as regras de
 * seleção vivem em relatorio.ts (conferidas por web-chat/tests/relatorio.test.ts).
 *
 * Tópico sem dado no resultado aparece desabilitado COM O MOTIVO, em vez de
 * sumir da lista: quem exporta precisa saber que a seção existe e por que não
 * pode entrar neste arquivo.
 */
import { ref, watch } from 'vue';
import {
    GRUPOS,
    TOPICOS,
    ajustarSelecao,
    contarSelecionados,
    podeGerar,
    selecaoPadrao,
    selecaoVazia,
    topicosDoGrupo,
    type DisponibilidadeRelatorio,
    type GrupoRelatorio,
    type SelecaoRelatorio
} from '../relatorio';

const props = defineProps<{
    aberto: boolean;
    disponibilidade: DisponibilidadeRelatorio;
    /** A última escolha, para o modal reabrir como o usuário deixou. */
    selecaoInicial?: SelecaoRelatorio;
}>();

const emit = defineEmits<{ fechar: []; gerar: [selecao: SelecaoRelatorio] }>();

/** A escolha anterior (ou tudo o que existe), já sem os indisponíveis. */
function inicial(): SelecaoRelatorio {
    return props.selecaoInicial
        ? ajustarSelecao(props.selecaoInicial, props.disponibilidade)
        : selecaoPadrao(props.disponibilidade);
}

// Começa pronto (nada de watcher `immediate`: no SSR ele não roda, e o modal
// renderizaria com uma seleção diferente da que a tela pediu)...
const sel = ref<SelecaoRelatorio>(inicial());

// ...e cada reabertura volta a partir de como o usuário deixou.
watch(
    () => props.aberto,
    aberto => {
        if (aberto) sel.value = inicial();
    }
);

const GRUPOS_NA_ORDEM: GrupoRelatorio[] = ['documento', 'resultado', 'tempo'];

function alternar(chave: keyof SelecaoRelatorio): void {
    if (!props.disponibilidade[chave].disponivel) return;
    sel.value = { ...sel.value, [chave]: !sel.value[chave] };
}

function marcarTudo(): void {
    sel.value = selecaoPadrao(props.disponibilidade);
}

function limpar(): void {
    sel.value = selecaoVazia();
}

function gerar(): void {
    if (podeGerar(sel.value, props.disponibilidade)) emit('gerar', { ...sel.value });
}
</script>

<template>
    <Teleport to="body">
        <Transition name="modal-fade">
            <div
                v-if="aberto"
                class="fixed inset-0 z-50 flex items-center justify-center p-4 sem-impressao"
                role="dialog"
                aria-modal="true"
                aria-label="Exportar relatório"
                @keydown.esc="emit('fechar')"
            >
                <div class="absolute inset-0 bg-neutral-900/30 backdrop-blur-sm dark:bg-black/50" @click="emit('fechar')"></div>

                <div
                    class="relative flex max-h-full w-full max-w-2xl flex-col rounded-3xl border border-neutral-200 bg-white/95 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-neutral-900/80 dark:shadow-black/40"
                >
                    <div class="flex items-start justify-between gap-4 px-6 pt-5 pb-3">
                        <div>
                            <h2 class="text-base font-semibold text-neutral-900 dark:text-neutral-100">Exportar relatório</h2>
                            <p class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                                Escolha os tópicos que entram no PDF — {{ contarSelecionados(sel) }} de {{ TOPICOS.length }} marcados
                            </p>
                        </div>
                        <button
                            type="button"
                            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-white/10"
                            title="Fechar"
                            @click="emit('fechar')"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24">
                                <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                            </svg>
                        </button>
                    </div>

                    <div class="flex items-center gap-2 px-6 pb-3">
                        <button
                            type="button"
                            class="rounded-full border border-neutral-200 px-3 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/10"
                            @click="marcarTudo"
                        >
                            Marcar tudo o que existe
                        </button>
                        <button
                            type="button"
                            class="rounded-full border border-neutral-200 px-3 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/10"
                            @click="limpar"
                        >
                            Desmarcar tudo
                        </button>
                    </div>

                    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-4">
                        <section v-for="grupo in GRUPOS_NA_ORDEM" :key="grupo">
                            <p class="mb-1.5 text-xs font-semibold tracking-wide text-neutral-500 uppercase dark:text-neutral-400">
                                {{ GRUPOS[grupo].nome }}
                                <span class="font-normal normal-case">· {{ GRUPOS[grupo].descricao }}</span>
                            </p>
                            <ul class="space-y-1.5">
                                <li v-for="topico in topicosDoGrupo(grupo)" :key="topico.chave">
                                    <label
                                        class="flex cursor-pointer items-start gap-3 rounded-2xl border px-3.5 py-2.5 transition-colors"
                                        :class="
                                            !disponibilidade[topico.chave].disponivel
                                                ? 'cursor-not-allowed border-neutral-200/70 opacity-60 dark:border-white/5'
                                                : sel[topico.chave]
                                                  ? 'border-blue-500/40 bg-blue-50/60 dark:border-blue-400/30 dark:bg-blue-500/10'
                                                  : 'border-neutral-200 hover:bg-neutral-50 dark:border-white/10 dark:hover:bg-white/5'
                                        "
                                    >
                                        <input
                                            type="checkbox"
                                            class="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
                                            :checked="sel[topico.chave] === true"
                                            :disabled="!disponibilidade[topico.chave].disponivel"
                                            @change="alternar(topico.chave)"
                                        />
                                        <span class="min-w-0">
                                            <span class="block text-sm font-medium text-neutral-800 dark:text-neutral-100">{{ topico.rotulo }}</span>
                                            <span class="mt-0.5 block text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">{{ topico.descricao }}</span>
                                            <span
                                                v-if="!disponibilidade[topico.chave].disponivel"
                                                class="mt-1 inline-block rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
                                            >
                                                Indisponível: {{ disponibilidade[topico.chave].motivo }}
                                            </span>
                                        </span>
                                    </label>
                                </li>
                            </ul>
                        </section>
                    </div>

                    <div class="border-t border-neutral-200/70 px-6 py-4 dark:border-white/10">
                        <p class="mb-3 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                            O PDF é gerado pela janela de impressão do navegador: em <strong>Destino</strong>, escolha
                            <strong>Salvar como PDF</strong>. O relatório sai sempre no tema claro, com o conteúdo exatamente como
                            está na tela — as linhas que estiverem expandidas na comparação saem expandidas.
                        </p>
                        <div class="flex items-center justify-end gap-2">
                            <button
                                type="button"
                                class="rounded-full border border-neutral-200 px-4 py-2 text-sm text-neutral-600 transition-colors hover:bg-neutral-50 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/10"
                                @click="emit('fechar')"
                            >
                                Cancelar
                            </button>
                            <button
                                type="button"
                                class="inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors enabled:hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                                :disabled="!podeGerar(sel, disponibilidade)"
                                :title="podeGerar(sel, disponibilidade) ? 'Abrir a janela de impressão' : 'Marque pelo menos um tópico de conteúdo'"
                                @click="gerar"
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M6 9V3h12v6" />
                                    <path d="M6 18H4v-6h16v6h-2" />
                                    <rect x="6" y="14" width="12" height="7" rx="1" />
                                </svg>
                                Gerar PDF
                            </button>
                        </div>
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
