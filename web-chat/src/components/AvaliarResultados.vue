<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { avaliarResultados, type RespostaAvaliacao } from '../api';
import MetricasCard from './MetricasCard.vue';
import ComparacaoLinhas from './ComparacaoLinhas.vue';

const DOMINIOS = [
    { id: 'med' as const, nome: 'Clínico (UTI)', descricao: 'uti.dsl', icone: 'activity' as const },
    { id: 'agro' as const, nome: 'Agrícola (drone)', descricao: 'lavoura.agro', icone: 'feather' as const },
    { id: 'fut' as const, nome: 'Arbitragem (futebol)', descricao: 'futebol.fut', icone: 'flag' as const }
];

const MODELOS = [
    { chave: 'arquitetura' as const, nome: 'Arquitetura SPC-CML', descricao: 'decodificação restrita por gramática', icone: 'shield' as const },
    { chave: 'baseline' as const, nome: 'Baseline', descricao: 'Qwen puro, sem a arquitetura', icone: 'cpu' as const }
];

const dominioSelecionado = ref<'med' | 'agro' | 'fut'>('med');
const incluirArquitetura = ref(true);
const incluirBaseline = ref(true);

const arquivos = reactive<{ arquitetura: File | null; baseline: File | null }>({ arquitetura: null, baseline: null });
const inputArquitetura = ref<HTMLInputElement | null>(null);
const inputBaseline = ref<HTMLInputElement | null>(null);

const avaliando = ref(false);
const erro = ref<string | null>(null);
const resultado = ref<RespostaAvaliacao | null>(null);

function modeloIncluido(chave: 'arquitetura' | 'baseline'): boolean {
    return chave === 'arquitetura' ? incluirArquitetura.value : incluirBaseline.value;
}

const campos = computed(() => {
    const lista: Array<{ chave: 'arquitetura' | 'baseline'; titulo: string; subtitulo: string }> = [];
    if (incluirArquitetura.value) lista.push({ chave: 'arquitetura', titulo: 'Arquitetura SPC-CML', subtitulo: 'resultado do lote com decodificação restrita' });
    if (incluirBaseline.value) lista.push({ chave: 'baseline', titulo: 'Baseline', subtitulo: 'Qwen puro, sem a arquitetura SPC-CML' });
    return lista;
});

function vincularInput(chave: 'arquitetura' | 'baseline', el: unknown): void {
    const alvo = chave === 'arquitetura' ? inputArquitetura : inputBaseline;
    alvo.value = el instanceof HTMLInputElement ? el : null;
}

function nomeArquivo(chave: 'arquitetura' | 'baseline'): string {
    return arquivos[chave]?.name ?? '';
}

const podeAvaliar = computed(() => {
    if (!incluirArquitetura.value && !incluirBaseline.value) return false;
    if (incluirArquitetura.value && !arquivos.arquitetura) return false;
    if (incluirBaseline.value && !arquivos.baseline) return false;
    return true;
});

function alternarDominio(id: 'med' | 'agro' | 'fut'): void {
    dominioSelecionado.value = id;
    resultado.value = null;
    erro.value = null;
}

function alternarModelo(chave: 'arquitetura' | 'baseline'): void {
    if (chave === 'arquitetura') incluirArquitetura.value = !incluirArquitetura.value;
    else incluirBaseline.value = !incluirBaseline.value;
    resultado.value = null;
    erro.value = null;
}

function abrirSeletor(chave: 'arquitetura' | 'baseline'): void {
    (chave === 'arquitetura' ? inputArquitetura : inputBaseline).value?.click();
}

function aoSelecionarArquivo(chave: 'arquitetura' | 'baseline', evento: Event): void {
    const input = evento.target as HTMLInputElement;
    arquivos[chave] = input.files?.[0] ?? null;
    resultado.value = null;
    erro.value = null;
}

function removerArquivo(chave: 'arquitetura' | 'baseline'): void {
    arquivos[chave] = null;
}

async function avaliar(): Promise<void> {
    if (!podeAvaliar.value || avaliando.value) return;
    avaliando.value = true;
    erro.value = null;
    resultado.value = null;
    try {
        const arquiteturaJsonl = incluirArquitetura.value && arquivos.arquitetura ? await arquivos.arquitetura.text() : undefined;
        const baselineJsonl = incluirBaseline.value && arquivos.baseline ? await arquivos.baseline.text() : undefined;
        resultado.value = await avaliarResultados(dominioSelecionado.value, arquiteturaJsonl, baselineJsonl);
    } catch (e) {
        erro.value = (e as Error).message;
    } finally {
        avaliando.value = false;
    }
}
</script>

<template>
    <div class="flex min-h-0 w-full flex-1 flex-col overflow-y-auto px-5 py-8 sm:px-8 lg:px-10">
        <div class="mb-8 flex items-center gap-3.5">
            <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500/15 via-purple-400/15 to-rose-400/15 text-blue-600 dark:text-blue-400">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="20" x2="18" y2="10" />
                    <line x1="12" y1="20" x2="12" y2="4" />
                    <line x1="6" y1="20" x2="6" y2="14" />
                </svg>
            </div>
            <div>
                <h1 class="text-2xl font-medium text-neutral-900 dark:text-neutral-100">Avaliar resultados</h1>
                <p class="text-sm text-neutral-500 dark:text-neutral-400">Compare a saída em lote contra o ground truth do domínio.</p>
            </div>
        </div>

        <!-- Configuração fica num bloco de largura limitada (cartões de escolha
             viram tiras enormes num monitor largo); só os resultados e a
             comparação por linha usam a tela inteira, que é onde a largura
             de fato ajuda a ler. -->
        <div class="w-full max-w-5xl">
        <section class="mb-6">
            <p class="mb-2.5 text-xs font-semibold tracking-wide text-neutral-400 uppercase dark:text-neutral-500">1. Domínio</p>
            <div class="grid grid-cols-2 gap-3">
                <button
                    v-for="d in DOMINIOS"
                    :key="d.id"
                    type="button"
                    class="group relative flex items-center gap-3 rounded-2xl border p-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 active:scale-[0.98]"
                    :class="
                        dominioSelecionado === d.id
                            ? 'border-blue-300 bg-blue-50 shadow-sm dark:border-blue-500/40 dark:bg-blue-500/10'
                            : 'border-neutral-200 bg-white hover:border-neutral-300 hover:shadow-sm dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10'
                    "
                    @click="alternarDominio(d.id)"
                >
                    <div
                        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors duration-200"
                        :class="dominioSelecionado === d.id ? 'bg-blue-600 text-white' : 'bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300'"
                    >
                        <svg v-if="d.icone === 'activity'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                        </svg>
                        <svg v-else-if="d.icone === 'feather'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M20.24 12.24a6 6 0 00-8.49-8.49L5 10.5V19h8.5z" />
                            <line x1="16" y1="8" x2="2" y2="22" />
                            <line x1="17.5" y1="15" x2="9" y2="15" />
                        </svg>
                        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                            <line x1="4" y1="22" x2="4" y2="15" />
                        </svg>
                    </div>
                    <div class="min-w-0">
                        <p class="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">{{ d.nome }}</p>
                        <p class="truncate text-xs text-neutral-400 dark:text-neutral-500">{{ d.descricao }}</p>
                    </div>

                    <Transition name="pop">
                        <div v-if="dominioSelecionado === d.id" class="absolute top-2.5 right-2.5 flex h-4 w-4 items-center justify-center rounded-full bg-blue-600 text-white">
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                        </div>
                    </Transition>
                </button>
            </div>
        </section>

        <section class="mb-6">
            <p class="mb-2.5 text-xs font-semibold tracking-wide text-neutral-400 uppercase dark:text-neutral-500">2. O que validar</p>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                    v-for="m in MODELOS"
                    :key="m.chave"
                    type="button"
                    class="group relative flex items-center gap-3 rounded-2xl border p-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 active:scale-[0.98]"
                    :class="
                        modeloIncluido(m.chave)
                            ? 'border-blue-300 bg-blue-50 shadow-sm dark:border-blue-500/40 dark:bg-blue-500/10'
                            : 'border-neutral-200 bg-white hover:border-neutral-300 hover:shadow-sm dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10'
                    "
                    @click="alternarModelo(m.chave)"
                >
                    <div
                        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors duration-200"
                        :class="modeloIncluido(m.chave) ? 'bg-blue-600 text-white' : 'bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300'"
                    >
                        <svg v-if="m.icone === 'shield'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        </svg>
                        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="4" y="4" width="16" height="16" rx="2" />
                            <rect x="9" y="9" width="6" height="6" />
                            <line x1="9" y1="1" x2="9" y2="4" />
                            <line x1="15" y1="1" x2="15" y2="4" />
                            <line x1="9" y1="20" x2="9" y2="23" />
                            <line x1="15" y1="20" x2="15" y2="23" />
                            <line x1="20" y1="9" x2="23" y2="9" />
                            <line x1="20" y1="15" x2="23" y2="15" />
                            <line x1="1" y1="9" x2="4" y2="9" />
                            <line x1="1" y1="15" x2="4" y2="15" />
                        </svg>
                    </div>
                    <div class="min-w-0">
                        <p class="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">{{ m.nome }}</p>
                        <p class="truncate text-xs text-neutral-400 dark:text-neutral-500">{{ m.descricao }}</p>
                    </div>

                    <Transition name="pop">
                        <div v-if="modeloIncluido(m.chave)" class="absolute top-2.5 right-2.5 flex h-4 w-4 items-center justify-center rounded-full bg-blue-600 text-white">
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                        </div>
                    </Transition>
                </button>
            </div>
        </section>

        <section v-if="campos.length > 0" class="mb-6">
            <p class="mb-2.5 text-xs font-semibold tracking-wide text-neutral-400 uppercase dark:text-neutral-500">3. Arquivo(s) de resultado</p>
            <TransitionGroup
                tag="div"
                name="upload-card"
                class="grid gap-3.5"
                :class="campos.length === 2 ? 'sm:grid-cols-2' : 'grid-cols-1'"
            >
                <div v-for="campo in campos" :key="campo.chave" class="rounded-2xl border border-dashed border-neutral-300 p-4 text-center transition-colors dark:border-white/15">
                    <input :ref="el => vincularInput(campo.chave, el)" type="file" accept=".jsonl" class="hidden" @change="aoSelecionarArquivo(campo.chave, $event)" />

                    <p class="mb-0.5 text-sm font-medium text-neutral-800 dark:text-neutral-100">{{ campo.titulo }}</p>
                    <p class="mb-3 text-xs text-neutral-500 dark:text-neutral-400">{{ campo.subtitulo }}</p>

                    <Transition name="pop" mode="out-in">
                        <div v-if="arquivos[campo.chave]" key="arquivo" class="flex items-center justify-center gap-2 rounded-xl bg-neutral-100 px-3 py-2 text-sm text-neutral-700 dark:bg-white/10 dark:text-neutral-200">
                            <svg width="14" height="14" viewBox="0 0 24 24" class="shrink-0 text-neutral-400 dark:text-neutral-500" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                                <polyline points="14 2 14 8 20 8" />
                            </svg>
                            <span class="truncate">{{ nomeArquivo(campo.chave) }}</span>
                            <button type="button" class="shrink-0 text-neutral-400 transition-colors hover:text-neutral-700 dark:hover:text-neutral-100" title="Remover" @click="removerArquivo(campo.chave)">
                                <svg width="14" height="14" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
                            </button>
                        </div>
                        <button
                            v-else
                            key="botao"
                            type="button"
                            class="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 px-4 py-2 text-sm text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/10"
                            @click="abrirSeletor(campo.chave)"
                        >
                            <svg width="15" height="15" viewBox="0 0 24 24">
                                <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                            </svg>
                            Selecionar .jsonl
                        </button>
                    </Transition>
                </div>
            </TransitionGroup>
        </section>

        <button
            type="button"
            class="mb-6 flex items-center justify-center gap-2 self-start rounded-full bg-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-all duration-200 hover:bg-blue-700 hover:shadow active:scale-[0.97] disabled:bg-neutral-300 disabled:text-neutral-500 disabled:shadow-none dark:disabled:bg-neutral-700 dark:disabled:text-neutral-400"
            :disabled="!podeAvaliar || avaliando"
            @click="avaliar"
        >
            <svg v-if="avaliando" width="15" height="15" viewBox="0 0 24 24" class="animate-spin">
                <path d="M21 12a9 9 0 11-9-9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
            </svg>
            <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 13l4 4L19 7" />
            </svg>
            {{ avaliando ? 'Avaliando…' : 'Avaliar' }}
        </button>
        </div>

        <Transition name="fade-slide">
            <p v-if="erro" class="mb-6 flex max-w-5xl items-start gap-2.5 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
                <svg width="16" height="16" viewBox="0 0 24 24" class="mt-0.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <span>{{ erro }}</span>
            </p>
        </Transition>

        <Transition name="fade-slide">
            <div v-if="resultado">
                <p
                    v-if="resultado.naoPareados > 0 || resultado.telemetriaDivergente > 0"
                    class="mb-4 flex max-w-5xl items-start gap-2.5 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" class="mt-0.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                        <line x1="12" y1="9" x2="12" y2="13" />
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    <span>
                        <template v-if="resultado.naoPareados > 0">
                            {{ resultado.naoPareados }} registro(s) não correspondem a nenhum cenário do ground truth deste domínio — confira se o arquivo é do domínio
                            selecionado e se o lote rodou sobre os cenários oficiais.
                        </template>
                        <template v-if="resultado.telemetriaDivergente > 0">
                            <template v-if="resultado.naoPareados > 0"><br /></template>
                            {{ resultado.telemetriaDivergente }} registro(s) têm paciente conhecido mas telemetria diferente da do cenário — como o ground truth é derivado
                            da telemetria, esses casos ficaram de fora em vez de serem julgados por um gabarito que não se aplica.
                        </template>
                    </span>
                </p>

                <div class="grid gap-4" :class="resultado.arquitetura && resultado.baseline ? 'lg:grid-cols-2' : 'grid-cols-1'">
                    <MetricasCard v-if="resultado.arquitetura" variante="arquitetura" :metricas="resultado.arquitetura" :comparar="resultado.baseline" />
                    <MetricasCard v-if="resultado.baseline" variante="baseline" :metricas="resultado.baseline" />
                </div>

                <ComparacaoLinhas
                    v-if="resultado.linhas.length > 0"
                    :linhas="resultado.linhas"
                    :mostrar-arquitetura="!!resultado.arquitetura"
                    :mostrar-baseline="!!resultado.baseline"
                />
            </div>
        </Transition>
    </div>
</template>

<style scoped>
.fade-slide-enter-active {
    transition:
        opacity 0.35s ease,
        transform 0.35s ease;
}
.fade-slide-leave-active {
    transition: opacity 0.15s ease;
}
.fade-slide-enter-from {
    opacity: 0;
    transform: translateY(10px);
}
.fade-slide-leave-to {
    opacity: 0;
}

.pop-enter-active {
    transition:
        opacity 0.2s ease,
        transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.pop-leave-active {
    transition:
        opacity 0.15s ease,
        transform 0.15s ease;
}
.pop-enter-from,
.pop-leave-to {
    opacity: 0;
    transform: scale(0.6);
}

.upload-card-enter-active,
.upload-card-leave-active,
.upload-card-move {
    transition:
        opacity 0.25s ease,
        transform 0.25s ease;
}
.upload-card-enter-from,
.upload-card-leave-to {
    opacity: 0;
    transform: scale(0.96);
}
.upload-card-leave-active {
    position: absolute;
}
</style>
