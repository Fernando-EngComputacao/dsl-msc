<script setup lang="ts">
/**
 * Modal do header: a complexidade da arquitetura, camada por camada.
 *
 * Só apresentação — os números, as derivações e as fontes vivem em
 * complexidade.ts, e a procedência de cada um é conferida por
 * web-chat/tests/complexidade.test.ts (inclusive se o `arquivo:linha` da
 * evidência ainda aponta para o trecho certo).
 *
 * A tela nunca mostra um O(...) sem dizer de onde veio: cada item traz a
 * origem, a derivação e, quando é ferramenta de terceiros, o link da fonte com
 * a frase citada. Item cuja ferramenta não documenta a complexidade aparece
 * marcado como tal, com a ressalva — a lacuna é informação.
 */
import { computed, ref } from 'vue';
import {
    CAMINHOS,
    CODIGO,
    ITENS,
    METODO,
    ROTULO_ORIGEM,
    VARIAVEIS,
    itemPorId,
    itensPorCamada,
    type ItemComplexidade
} from '../complexidade';

defineProps<{ aberto: boolean }>();
const emit = defineEmits<{ fechar: [] }>();

const grupos = itensPorCamada();
const metodoAberto = ref(false);

const totais = computed(() => ({
    itens: ITENS.length,
    caixasPretas: ITENS.filter(i => i.caixaPreta).length,
    lacunas: ITENS.filter(i => i.origem === 'nao-documentado').length,
    linhas: CODIGO.reduce((s, c) => s + c.linhas, 0)
}));

/** Cor do selo da origem: quem não tem fonte oficial não se parece com quem tem. */
function corOrigem(item: ItemComplexidade): string {
    if (item.origem === 'codigo') return 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300';
    if (item.origem === 'documentacao') return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300';
    if (item.origem === 'artigo') return 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300';
    return 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300';
}
</script>

<template>
    <Teleport to="body">
        <Transition name="modal-fade">
            <div
                v-if="aberto"
                class="fixed inset-0 z-50 flex items-center justify-center p-4"
                role="dialog"
                aria-modal="true"
                aria-label="Complexidade da arquitetura"
                @keydown.esc="emit('fechar')"
            >
                <div class="absolute inset-0 bg-neutral-900/30 backdrop-blur-sm dark:bg-black/50" @click="emit('fechar')"></div>

                <div
                    class="relative flex max-h-full w-full max-w-4xl flex-col rounded-3xl border border-neutral-200 bg-white/95 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-neutral-900/80 dark:shadow-black/40"
                >
                    <div class="flex items-start justify-between gap-4 px-6 pt-5 pb-3">
                        <div>
                            <h2 class="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                                Complexidade da arquitetura e do código
                            </h2>
                            <p class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                                {{ totais.itens }} operações analisadas · {{ totais.caixasPretas }} em ferramentas de
                                terceiros · {{ totais.lacunas }} sem complexidade documentada pela ferramenta ·
                                {{ totais.linhas.toLocaleString('pt-BR') }} linhas de código medidas
                            </p>
                        </div>
                        <button
                            type="button"
                            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-white/10"
                            title="Fechar"
                            @click="emit('fechar')"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24">
                                <path d="M18 6L6 18M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                            </svg>
                        </button>
                    </div>

                    <div class="space-y-5 overflow-y-auto px-6 pb-6">
                        <!-- Aviso de método, curto e no topo: o resto é detalhe. -->
                        <p class="rounded-2xl bg-neutral-50 px-4 py-3 text-xs leading-relaxed text-neutral-600 dark:bg-white/5 dark:text-neutral-300">
                            Complexidade assintótica é <strong class="font-medium">crescimento, não velocidade</strong>. Quase
                            todo o tempo de parede desta arquitetura é constante multiplicativa — uma chamada ao modelo —,
                            então cada item diz em que unidade conta (caracteres, tokens, chamadas ao motor) e como o número
                            foi obtido. Medições reais de tempo ficam na aba "Tempo" da tela de avaliação.
                        </p>

                        <!-- Variáveis -->
                        <section>
                            <h3 class="mb-2 text-xs font-semibold tracking-wide text-neutral-400 uppercase dark:text-neutral-500">
                                Variáveis das fórmulas
                            </h3>
                            <div class="grid gap-2 sm:grid-cols-2">
                                <div
                                    v-for="v in VARIAVEIS"
                                    :key="v.simbolo"
                                    class="flex gap-2 rounded-xl border border-neutral-200/70 px-3 py-2 dark:border-white/10"
                                >
                                    <code class="shrink-0 font-mono text-xs font-semibold text-blue-700 dark:text-blue-300">{{ v.simbolo }}</code>
                                    <div class="min-w-0">
                                        <p class="text-xs font-medium text-neutral-800 dark:text-neutral-100">{{ v.nome }}</p>
                                        <p class="text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">{{ v.descricao }}</p>
                                        <p v-if="v.ordem" class="mt-0.5 text-[11px] text-neutral-400 dark:text-neutral-500">{{ v.ordem }}</p>
                                    </div>
                                </div>
                            </div>
                        </section>

                        <!-- Itens, por camada -->
                        <section v-for="grupo in grupos" :key="grupo.camada">
                            <h3 class="mb-0.5 text-xs font-semibold tracking-wide text-neutral-400 uppercase dark:text-neutral-500">
                                {{ grupo.nome }}
                            </h3>
                            <p class="mb-2 text-[11px] text-neutral-400 dark:text-neutral-500">{{ grupo.descricao }}</p>

                            <div class="space-y-2.5">
                                <article
                                    v-for="item in grupo.itens"
                                    :key="item.id"
                                    class="rounded-2xl border border-neutral-200/70 p-3.5 dark:border-white/10 dark:bg-white/5"
                                >
                                    <div class="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                        <h4 class="text-sm font-medium text-neutral-900 dark:text-neutral-100">{{ item.componente }}</h4>
                                        <span
                                            v-if="item.caixaPreta"
                                            class="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-600 dark:bg-white/10 dark:text-neutral-300"
                                            title="Ferramenta de terceiros: a arquitetura depende dela e não a controla"
                                            >caixa-preta</span
                                        >
                                        <span :class="corOrigem(item)" class="rounded-full px-2 py-0.5 text-[10px]">{{
                                            ROTULO_ORIGEM[item.origem]
                                        }}</span>
                                    </div>
                                    <p class="mb-2 text-xs text-neutral-500 dark:text-neutral-400">{{ item.operacao }}</p>

                                    <dl class="mb-2 grid gap-2 sm:grid-cols-2">
                                        <div class="rounded-xl bg-neutral-50 px-3 py-2 dark:bg-black/20">
                                            <dt class="text-[10px] tracking-wide text-neutral-400 uppercase dark:text-neutral-500">Tempo</dt>
                                            <dd class="font-mono text-xs text-neutral-800 dark:text-neutral-100">{{ item.tempo }}</dd>
                                        </div>
                                        <div v-if="item.espaco" class="rounded-xl bg-neutral-50 px-3 py-2 dark:bg-black/20">
                                            <dt class="text-[10px] tracking-wide text-neutral-400 uppercase dark:text-neutral-500">Espaço</dt>
                                            <dd class="font-mono text-xs text-neutral-800 dark:text-neutral-100">{{ item.espaco }}</dd>
                                        </div>
                                    </dl>

                                    <p class="text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
                                        <span class="font-medium text-neutral-800 dark:text-neutral-100">Como foi obtido. </span>
                                        {{ item.comoObtido }}
                                    </p>

                                    <p v-if="item.ressalva" class="mt-2 rounded-xl bg-amber-50/70 px-3 py-2 text-[11px] leading-relaxed text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                                        <span class="font-medium">Ressalva. </span>{{ item.ressalva }}
                                    </p>

                                    <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                                        <span v-if="item.evidencia" title="Trecho do nosso código de onde a derivação saiu">
                                            <code class="font-mono">{{ item.evidencia }}</code>
                                        </span>
                                        <span>
                                            variáveis:
                                            <code v-for="s in item.variaveis" :key="s" class="ml-1 font-mono text-blue-700 dark:text-blue-300">{{ s }}</code>
                                        </span>
                                    </div>

                                    <ul v-if="item.fontes?.length" class="mt-2 space-y-1 border-t border-neutral-200/70 pt-2 dark:border-white/10">
                                        <li v-for="fonte in item.fontes" :key="fonte.titulo" class="text-[11px] leading-snug">
                                            <a
                                                v-if="fonte.url"
                                                :href="fonte.url"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                class="font-medium text-blue-700 underline decoration-dotted hover:decoration-solid dark:text-blue-300"
                                                >{{ fonte.titulo }}</a
                                            >
                                            <span v-else class="font-medium text-neutral-700 dark:text-neutral-200">{{ fonte.titulo }}</span>
                                            <span v-if="fonte.nota" class="text-neutral-500 dark:text-neutral-400"> — {{ fonte.nota }}</span>
                                        </li>
                                    </ul>
                                </article>
                            </div>
                        </section>

                        <!-- Caminhos compostos -->
                        <section>
                            <h3 class="mb-2 text-xs font-semibold tracking-wide text-neutral-400 uppercase dark:text-neutral-500">
                                Custo composto (ponta a ponta)
                            </h3>
                            <div class="space-y-2.5">
                                <article
                                    v-for="caminho in CAMINHOS"
                                    :key="caminho.id"
                                    class="rounded-2xl border border-neutral-200/70 p-3.5 dark:border-white/10 dark:bg-white/5"
                                >
                                    <h4 class="text-sm font-medium text-neutral-900 dark:text-neutral-100">{{ caminho.titulo }}</h4>
                                    <p class="mt-1 font-mono text-xs text-neutral-800 dark:text-neutral-100">{{ caminho.formula }}</p>
                                    <p class="mt-1.5 text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">{{ caminho.explicacao }}</p>
                                    <p class="mt-1.5 text-[11px] text-neutral-400 dark:text-neutral-500">
                                        soma de:
                                        <span v-for="(id, i) in caminho.itens" :key="id">
                                            {{ i > 0 ? ' · ' : ' ' }}{{ itemPorId(id)?.componente ?? id }}
                                        </span>
                                    </p>
                                </article>
                            </div>
                        </section>

                        <!-- Tamanho do código -->
                        <section>
                            <h3 class="mb-2 text-xs font-semibold tracking-wide text-neutral-400 uppercase dark:text-neutral-500">
                                Tamanho do código (medido)
                            </h3>
                            <div class="overflow-x-auto">
                                <table class="w-full min-w-[30rem] border-collapse text-left text-xs">
                                    <thead>
                                        <tr class="text-[10px] tracking-wide text-neutral-400 uppercase dark:text-neutral-500">
                                            <th class="py-1.5 pr-3 font-normal">Camada</th>
                                            <th class="py-1.5 pr-3 font-normal">Arquivos</th>
                                            <th class="py-1.5 font-normal">Linhas</th>
                                        </tr>
                                    </thead>
                                    <tbody class="text-neutral-700 dark:text-neutral-200">
                                        <tr v-for="c in CODIGO" :key="c.camada" class="border-t border-neutral-100 dark:border-white/5">
                                            <th class="py-1.5 pr-3 text-left font-normal">
                                                <code class="font-mono text-[11px]">{{ c.camada }}</code>
                                                <span v-if="c.nota" class="block text-[10px] text-neutral-400 dark:text-neutral-500">{{ c.nota }}</span>
                                            </th>
                                            <td class="py-1.5 pr-3 tabular-nums">{{ c.arquivos }}</td>
                                            <td class="py-1.5 tabular-nums">{{ c.linhas.toLocaleString('pt-BR') }}</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </section>

                        <!-- Método -->
                        <section class="rounded-2xl border border-neutral-200/70 dark:border-white/10">
                            <button
                                type="button"
                                class="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
                                @click="metodoAberto = !metodoAberto"
                            >
                                <span class="text-xs font-semibold tracking-wide text-neutral-500 uppercase dark:text-neutral-400">
                                    Método: como este levantamento foi feito, e o que não foi medido
                                </span>
                                <svg
                                    width="14"
                                    height="14"
                                    viewBox="0 0 24 24"
                                    class="shrink-0 text-neutral-400 transition-transform"
                                    :class="metodoAberto ? 'rotate-180' : ''"
                                >
                                    <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                                </svg>
                            </button>
                            <div v-if="metodoAberto" class="space-y-3 border-t border-neutral-200/70 px-4 py-3 dark:border-white/10">
                                <div v-for="nota in METODO" :key="nota.titulo">
                                    <p class="text-xs font-medium text-neutral-800 dark:text-neutral-100">{{ nota.titulo }}</p>
                                    <p class="mt-0.5 text-[11px] leading-relaxed text-neutral-600 dark:text-neutral-300">{{ nota.texto }}</p>
                                </div>
                            </div>
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
