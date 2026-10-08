<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { Analise, Filtro } from '../../../src/inference/analise-avaliacao';
import {
    aplicacaoDidatica,
    aplicarMetodologia,
    descreverFontes,
    DOCUMENTACAO,
    EXEMPLO_DIDATICO,
    ROTULO_NATUREZA,
    SECOES_METODOLOGIA,
    type DocumentacaoMetrica,
    type IdDocumentacao,
    type NaturezaFundamento,
    type SecaoMetodologia
} from '../../../src/inference/metodologia-avaliacao';
import PassoMetodologia from './PassoMetodologia.vue';
import Tex from './Tex.vue';
import TextoMat from './TextoMat.vue';

/**
 * Painel "(?)" da sessão Avaliação LLM: a metodologia estatística como
 * documentação matemática, aplicada à análise que está na tela (mesma fonte,
 * mesmos filtros). Todo o conteúdo vem de metodologia-avaliacao.ts — aqui só há
 * apresentação: índice, navegação e renderização LaTeX.
 */
const props = defineProps<{ aberto: boolean; analise: Analise; filtro: Filtro; ancora?: IdDocumentacao | null }>();
const emit = defineEmits<{ fechar: [] }>();

const aplicacao = computed(() => aplicarMetodologia(props.analise, props.filtro));
const didatica = aplicacaoDidatica();
const fontes = descreverFontes();

const docs = (ids: readonly IdDocumentacao[]): DocumentacaoMetrica[] => DOCUMENTACAO.filter(d => ids.includes(d.id));
const ativas = computed(() => docs(aplicacao.value.ativas));
const semSignificado = computed(() => docs(aplicacao.value.semSignificado));
const naoImplementadas = DOCUMENTACAO.filter(d => !d.implementada);
const passosDe = (id: IdDocumentacao) => aplicacao.value.passos.filter(p => p.id === id);
const passosDidaticosDe = (id: IdDocumentacao) => didatica.passos.filter(p => p.id === id);
const secao = (id: SecaoMetodologia['id']) => SECOES_METODOLOGIA.find(s => s.id === id)!;

/** No exemplo didático completo, só os passos da comparação (as distribuições não acrescentam nada a conferir). */
const PASSOS_DIDATICOS: readonly IdDocumentacao[] = ['matrizConfusao', 'concordancia', 'precision', 'recall', 'f1', 'macroF1', 'kappa'];
const passosDidaticos = didatica.passos.filter(p => PASSOS_DIDATICOS.includes(p.id));

const COR_NATUREZA: Record<NaturezaFundamento, string> = {
    definicao: 'bg-blue-50 text-blue-700 ring-blue-600/15 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-400/20',
    identidade: 'bg-teal-50 text-teal-700 ring-teal-600/15 dark:bg-teal-500/10 dark:text-teal-300 dark:ring-teal-400/20',
    propriedade: 'bg-violet-50 text-violet-700 ring-violet-600/15 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-400/20',
    teorema: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20',
    pressuposto: 'bg-neutral-100 text-neutral-700 ring-neutral-500/15 dark:bg-white/5 dark:text-neutral-300 dark:ring-white/10',
    criterio: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20',
    convencao: 'bg-rose-50 text-rose-700 ring-rose-600/15 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/20'
};
const ETIQUETA = 'w-fit shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset';
const SUB = 'mb-1.5 text-[10.5px] font-semibold tracking-[0.1em] text-neutral-500 uppercase dark:text-neutral-400';
const ROTULO = 'font-semibold text-neutral-900 dark:text-neutral-100';
const SOBRETITULO = 'text-[10px] font-semibold tracking-[0.14em] text-neutral-400 uppercase dark:text-neutral-500';
const LISTA = 'list-disc space-y-1.5 pl-5 marker:text-neutral-300 dark:marker:text-neutral-600';

// ---------------------------------------------------------------- índice
interface ItemIndice {
    id: string;
    titulo: string;
}
const indice = computed<{ grupo: string; itens: ItemIndice[] }[]>(() => [
    {
        grupo: 'Visão geral',
        itens: [
            { id: 'm-visao', titulo: 'Recorte atual' },
            { id: 'm-unidade', titulo: 'Unidade de análise' },
            { id: 'm-fontes', titulo: 'Fontes' },
            { id: 'm-tratamento', titulo: 'Tratamento dos dados' }
        ]
    },
    {
        grupo: 'Métricas',
        itens: [
            ...ativas.value.map(d => ({ id: `m-doc-${d.id}`, titulo: d.nome })),
            ...(semSignificado.value.length ? [{ id: 'm-sem-significado', titulo: 'Sem significado nesta fonte' }] : []),
            { id: 'm-nao-implementadas', titulo: 'Não implementadas' }
        ]
    },
    {
        grupo: 'Fundamentos',
        itens: [
            { id: 'm-denominadores', titulo: 'Denominadores' },
            { id: 'm-especiais', titulo: 'Casos especiais' },
            { id: 'm-propriedades', titulo: 'Propriedades matemáticas' },
            { id: 'm-limitacoes', titulo: 'Limitações' }
        ]
    },
    {
        grupo: 'Leitura',
        itens: [
            { id: 'm-exemplo', titulo: 'Exemplo didático' },
            { id: 'm-interpretacao', titulo: 'Interpretação acadêmica' }
        ]
    }
]);

const rolagem = ref<HTMLElement | null>(null);
const painel = ref<HTMLElement | null>(null);
const ativo = ref('m-visao');

function irPara(id: string, comportamento: ScrollBehavior = 'smooth'): void {
    const alvo = rolagem.value?.querySelector<HTMLElement>(`#${id}`);
    if (!alvo || !rolagem.value) return;
    ativo.value = id;
    rolagem.value.scrollTo?.({ top: alvo.offsetTop - 12, behavior: comportamento });
}

// Seção ativa: a primeira cujo topo entrou na faixa superior da área de leitura.
let observador: IntersectionObserver | null = null;
function observar(): void {
    observador?.disconnect();
    if (!rolagem.value || typeof IntersectionObserver === 'undefined') return;
    observador = new IntersectionObserver(
        entradas => {
            const visiveis = entradas.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
            if (visiveis[0]) ativo.value = (visiveis[0].target as HTMLElement).id;
        },
        { root: rolagem.value, rootMargin: '0px 0px -75% 0px' }
    );
    rolagem.value.querySelectorAll('section[id^="m-"]').forEach(s => observador!.observe(s));
}

// ---------------------------------------------------------------- abrir / fechar
let focoAnterior: HTMLElement | null = null;

function aoTeclar(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
        e.preventDefault();
        emit('fechar');
        return;
    }
    if (e.key !== 'Tab' || !painel.value) return;
    // Mantém o foco dentro do diálogo.
    const focaveis = [...painel.value.querySelectorAll<HTMLElement>('button, [href], select, summary, [tabindex]:not([tabindex="-1"])')].filter(el => !el.hasAttribute('disabled'));
    if (focaveis.length === 0) return;
    const primeiro = focaveis[0];
    const ultimo = focaveis[focaveis.length - 1];
    if (e.shiftKey && document.activeElement === primeiro) {
        e.preventDefault();
        ultimo.focus();
    } else if (!e.shiftKey && document.activeElement === ultimo) {
        e.preventDefault();
        primeiro.focus();
    }
}

watch(
    () => props.aberto,
    async aberto => {
        if (aberto) {
            focoAnterior = document.activeElement as HTMLElement | null;
            window.addEventListener('keydown', aoTeclar);
            document.body.style.overflow = 'hidden';
            await nextTick();
            painel.value?.focus();
            observar();
            if (props.ancora) irPara(`m-doc-${props.ancora}`, 'auto');
            else ativo.value = 'm-visao';
        } else {
            window.removeEventListener('keydown', aoTeclar);
            document.body.style.overflow = '';
            observador?.disconnect();
            focoAnterior?.focus?.();
        }
    },
    { immediate: true }
);
onBeforeUnmount(() => {
    window.removeEventListener('keydown', aoTeclar);
    document.body.style.overflow = '';
    observador?.disconnect();
});
</script>

<template>
    <Teleport to="body">
        <Transition name="modal-fade">
            <div v-if="aberto" class="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="metodologia-titulo">
                <div class="absolute inset-0 bg-neutral-950/40 backdrop-blur-sm dark:bg-black/60" @click="emit('fechar')"></div>

                <div
                    ref="painel"
                    tabindex="-1"
                    class="relative flex h-[92vh] w-full min-w-0 max-w-6xl flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl outline-none sm:rounded-3xl dark:border-white/10 dark:bg-neutral-900 dark:shadow-black/50"
                >
                    <!-- Cabeçalho -->
                    <header class="flex items-start justify-between gap-4 border-b border-neutral-200 px-4 py-3 sm:px-6 sm:py-4 dark:border-white/10">
                        <div class="flex min-w-0 items-start gap-3">
                            <div class="mt-0.5 hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neutral-100 text-neutral-600 sm:flex dark:bg-white/10 dark:text-neutral-200" aria-hidden="true">
                                <Tex tex="\Sigma" />
                            </div>
                            <div class="min-w-0">
                                <p :class="SOBRETITULO">Documentação matemática do método</p>
                                <h2 id="metodologia-titulo" class="text-base font-semibold text-neutral-900 sm:text-lg dark:text-neutral-50">Metodologia estatística</h2>
                                <p class="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
                                    Fonte: <span class="font-medium text-neutral-700 dark:text-neutral-200">{{ aplicacao.rotulo }}</span> · análise {{ aplicacao.modo }}
                                </p>
                            </div>
                        </div>
                        <button
                            type="button"
                            class="rounded-full p-2 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white"
                            aria-label="Fechar a metodologia"
                            title="Fechar (Esc)"
                            @click="emit('fechar')"
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                        </button>
                    </header>

                    <div class="flex min-h-0 flex-1">
                        <!-- Índice lateral (telas médias e grandes) -->
                        <nav class="hidden w-60 shrink-0 overflow-y-auto border-r border-neutral-200 px-3 py-4 md:block dark:border-white/10" aria-label="Índice da metodologia">
                            <div v-for="g in indice" :key="g.grupo" class="mb-4">
                                <p class="mb-1 px-2" :class="SOBRETITULO">{{ g.grupo }}</p>
                                <button
                                    v-for="item in g.itens"
                                    :key="item.id"
                                    type="button"
                                    class="block w-full rounded-r-lg border-l-2 px-2 py-1 text-left text-[12.5px] leading-snug transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
                                    :class="ativo === item.id
                                        ? 'border-blue-600 bg-blue-50 font-medium text-blue-800 dark:border-blue-400 dark:bg-blue-500/10 dark:text-blue-200'
                                        : 'border-transparent text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-100'"
                                    :aria-current="ativo === item.id ? 'true' : undefined"
                                    @click="irPara(item.id)"
                                >{{ item.titulo }}</button>
                            </div>
                        </nav>

                        <div ref="rolagem" class="relative min-w-0 flex-1 overflow-y-auto">
                            <!-- Índice compacto (celular / tablet estreito) -->
                            <div class="sticky top-0 z-10 border-b border-neutral-200 bg-white/95 px-4 py-2 backdrop-blur md:hidden dark:border-white/10 dark:bg-neutral-900/95">
                                <label class="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                                    Seção
                                    <select
                                        class="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-xs text-neutral-800 dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-100"
                                        :value="ativo"
                                        @change="irPara(($event.target as HTMLSelectElement).value)"
                                    >
                                        <optgroup v-for="g in indice" :key="g.grupo" :label="g.grupo">
                                            <option v-for="item in g.itens" :key="item.id" :value="item.id">{{ item.titulo }}</option>
                                        </optgroup>
                                    </select>
                                </label>
                            </div>

                            <article class="mx-auto max-w-3xl px-4 py-6 text-sm leading-relaxed text-neutral-700 sm:px-8 dark:text-neutral-300">
                                <!-- Recorte atual -->
                                <section id="m-visao" class="mb-10 scroll-mt-4">
                                    <p :class="SOBRETITULO">Visão geral</p>
                                    <h3 class="mb-2 text-lg font-semibold text-neutral-900 dark:text-neutral-50">Recorte atual</h3>
                                    <p>{{ aplicacao.recorte }}</p>
                                    <div class="mt-4 grid grid-cols-3 divide-x divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200 dark:divide-white/10 dark:border-white/10">
                                        <div class="px-3 py-3">
                                            <p :class="SOBRETITULO">N bruto</p>
                                            <p class="text-xl font-semibold text-neutral-900 tabular-nums dark:text-neutral-50">{{ aplicacao.contagens.nBruto }}</p>
                                            <p class="text-[11px] text-neutral-500 dark:text-neutral-400">planos no recorte</p>
                                        </div>
                                        <div class="px-3 py-3">
                                            <p :class="SOBRETITULO">N avaliável</p>
                                            <p class="text-xl font-semibold text-neutral-900 tabular-nums dark:text-neutral-50">{{ aplicacao.contagens.nAvaliavel ?? '—' }}</p>
                                            <p class="text-[11px] text-neutral-500 dark:text-neutral-400">{{ aplicacao.contagens.rotuloAvaliavel }}</p>
                                        </div>
                                        <div class="px-3 py-3">
                                            <p :class="SOBRETITULO">N excluído</p>
                                            <p class="text-xl font-semibold text-neutral-900 tabular-nums dark:text-neutral-50">{{ aplicacao.contagens.nExcluido ?? '—' }}</p>
                                            <p class="text-[11px] text-neutral-500 dark:text-neutral-400">fora do cálculo principal</p>
                                        </div>
                                    </div>
                                    <p v-if="!aplicacao.disponivel" class="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-200">
                                        {{ aplicacao.motivoIndisponivel }} A metodologia abaixo é a que será aplicada quando houver dados; nenhum valor é calculado agora.
                                    </p>
                                </section>

                                <!-- Unidade de análise -->
                                <section id="m-unidade" class="mb-10 scroll-mt-4">
                                    <h3 class="mb-2 text-base font-semibold text-neutral-900 dark:text-neutral-50">{{ secao('unidade').titulo }}</h3>
                                    <ul :class="LISTA"><li v-for="(i, k) in secao('unidade').itens" :key="k"><TextoMat :texto="i.texto" /></li></ul>
                                </section>

                                <!-- Fontes -->
                                <section id="m-fontes" class="mb-10 scroll-mt-4">
                                    <h3 class="mb-3 text-base font-semibold text-neutral-900 dark:text-neutral-50">Classificação das fontes</h3>
                                    <div class="grid gap-3 sm:grid-cols-2">
                                        <div
                                            v-for="f in fontes"
                                            :key="f.id"
                                            class="rounded-xl border p-3 text-xs"
                                            :class="f.id === aplicacao.fonte ? 'border-blue-400 bg-blue-50/50 dark:border-blue-400/50 dark:bg-blue-500/[0.06]' : 'border-neutral-200 dark:border-white/10'"
                                        >
                                            <p class="mb-1.5 flex flex-wrap items-center gap-1.5 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                                                {{ f.rotulo }}
                                                <span class="rounded-full bg-neutral-100 px-1.5 py-px text-[10px] font-normal text-neutral-600 dark:bg-white/10 dark:text-neutral-300">{{ f.modo }}</span>
                                                <span v-if="f.id === aplicacao.fonte" class="rounded-full bg-blue-600 px-1.5 py-px text-[10px] font-medium text-white dark:bg-blue-500">selecionada</span>
                                            </p>
                                            <p class="mb-1">{{ f.classificacao }}</p>
                                            <p><span class="text-neutral-400 dark:text-neutral-500">Entram:</span> {{ f.entram }}</p>
                                            <p><span class="text-neutral-400 dark:text-neutral-500">Ficam fora:</span> {{ f.ficamFora }}</p>
                                            <p class="mt-1.5"><span class="text-neutral-400 dark:text-neutral-500">Métricas válidas:</span> {{ f.metricasValidas.join(', ') }}</p>
                                            <p v-if="f.metricasSemSignificado.length"><span class="text-neutral-400 dark:text-neutral-500">Sem significado nesta fonte:</span> {{ f.metricasSemSignificado.join(', ') }}</p>
                                        </div>
                                    </div>
                                </section>

                                <!-- Tratamento -->
                                <section id="m-tratamento" class="mb-12 scroll-mt-4">
                                    <h3 class="mb-2 text-base font-semibold text-neutral-900 dark:text-neutral-50">{{ secao('tratamento').titulo }}</h3>
                                    <ul :class="LISTA"><li v-for="(i, k) in secao('tratamento').itens" :key="k"><TextoMat :texto="i.texto" /></li></ul>
                                </section>

                                <p class="mb-4" :class="SOBRETITULO">Métricas e fórmulas — só as que têm significado na fonte selecionada</p>

                                <!-- Uma seção por métrica -->
                                <section v-for="d in ativas" :id="`m-doc-${d.id}`" :key="d.id" class="mb-12 scroll-mt-4 border-t border-neutral-200 pt-6 dark:border-white/10">
                                    <div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                                        <h3 class="text-lg font-semibold text-neutral-900 dark:text-neutral-50">{{ d.nome }}</h3>
                                        <code v-if="d.funcao" class="rounded-md bg-neutral-100 px-1.5 py-0.5 font-mono text-[10.5px] text-neutral-500 dark:bg-white/5 dark:text-neutral-400" title="Função da camada de cálculo que produz este número">FORMULAS.{{ d.funcao }}</code>
                                    </div>
                                    <p class="mb-4"><TextoMat :texto="d.oQueMede" /></p>

                                    <h4 :class="SUB">Definição</h4>
                                    <div class="mb-4 rounded-xl border border-neutral-200 bg-neutral-50/70 px-3 py-2 text-neutral-900 dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-100">
                                        <Tex v-for="(f, k) in d.formula" :key="k" :tex="f" display />
                                    </div>
                                    <template v-if="d.formaImplementada">
                                        <p class="mb-1 text-xs text-neutral-500 dark:text-neutral-400">Forma usada no código (algebricamente equivalente):</p>
                                        <div class="mb-4 rounded-xl border border-dashed border-neutral-300 px-3 py-2 text-neutral-900 dark:border-white/15 dark:text-neutral-100">
                                            <Tex v-for="(f, k) in d.formaImplementada" :key="k" :tex="f" display />
                                        </div>
                                    </template>

                                    <h4 :class="SUB">Onde</h4>
                                    <div class="mb-4 overflow-x-auto">
                                        <table class="w-full text-xs">
                                            <thead>
                                                <tr class="border-b border-neutral-200 text-left text-[10px] tracking-wider text-neutral-400 uppercase dark:border-white/10 dark:text-neutral-500">
                                                    <th class="w-36 py-1.5 pr-3 font-semibold">Símbolo</th>
                                                    <th class="py-1.5 font-semibold">Significado</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                <tr v-for="v in d.variaveis" :key="v.simbolo" class="border-b border-neutral-100 align-top last:border-0 dark:border-white/5">
                                                    <td class="py-1.5 pr-3 text-neutral-900 dark:text-neutral-100"><Tex :tex="v.simbolo" /></td>
                                                    <td class="py-1.5"><TextoMat :texto="v.significado" /></td>
                                                </tr>
                                            </tbody>
                                        </table>
                                    </div>

                                    <dl class="mb-4 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
                                        <div><dt :class="ROTULO">Numerador</dt><dd><TextoMat :texto="d.numerador ?? '—'" /></dd></div>
                                        <div><dt :class="ROTULO">Denominador</dt><dd><TextoMat :texto="d.denominador ?? '—'" /></dd></div>
                                        <div><dt :class="ROTULO">Entram</dt><dd><TextoMat :texto="d.entram" /></dd></div>
                                        <div><dt :class="ROTULO">Ficam fora</dt><dd><TextoMat :texto="d.ficamFora" /></dd></div>
                                    </dl>

                                    <template v-if="d.casosEspeciais.length">
                                        <h4 :class="SUB">Casos especiais</h4>
                                        <ul class="mb-4 text-xs" :class="LISTA"><li v-for="(c, k) in d.casosEspeciais" :key="k"><TextoMat :texto="c" /></li></ul>
                                    </template>

                                    <h4 :class="SUB">Fundamentos</h4>
                                    <ul class="mb-2 space-y-1.5 text-xs">
                                        <li v-for="(f, k) in d.fundamentos" :key="k" class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-2">
                                            <span :class="[ETIQUETA, COR_NATUREZA[f.natureza]]">{{ ROTULO_NATUREZA[f.natureza] }}</span>
                                            <TextoMat :texto="f.texto" />
                                        </li>
                                    </ul>
                                    <p class="mb-5 text-xs"><span :class="ROTULO">Teorema:</span> <TextoMat :texto="d.teorema" /></p>

                                    <h4 :class="SUB">Resultado atual — aplicado aos dados atuais</h4>
                                    <div class="mb-4 rounded-xl border border-neutral-200 p-3 sm:p-4 dark:border-white/10">
                                        <p v-if="!aplicacao.disponivel" class="text-xs text-neutral-500 dark:text-neutral-400">Sem dados nesta fonte: nada a substituir.</p>
                                        <p v-else-if="passosDe(d.id).length === 0" class="text-xs text-neutral-500 dark:text-neutral-400">
                                            {{ d.id === 'recortes' ? 'Cada tabela "Por modelo" e "Por domínio" aplica as fórmulas desta lista ao subconjunto do grupo.' : 'Sem passo numérico próprio.' }}
                                        </p>
                                        <div v-else class="flex flex-col gap-5">
                                            <PassoMetodologia v-for="p in passosDe(d.id)" :key="p.titulo" :passo="p" :mostrar-titulo="passosDe(d.id).length > 1" />
                                        </div>
                                    </div>

                                    <details v-if="passosDidaticosDe(d.id).length" class="mb-4 rounded-xl border border-amber-200/80 bg-amber-50/40 p-3 dark:border-amber-400/20 dark:bg-amber-500/[0.04]">
                                        <summary class="cursor-pointer text-xs font-medium text-amber-900 select-none dark:text-amber-200">Exemplo didático (amostra artificial de 5 pares — não é resultado do experimento)</summary>
                                        <div class="mt-3 flex flex-col gap-5">
                                            <PassoMetodologia v-for="p in passosDidaticosDe(d.id)" :key="p.titulo" :passo="p" :mostrar-titulo="passosDidaticosDe(d.id).length > 1" />
                                        </div>
                                    </details>

                                    <h4 :class="SUB">Interpretação</h4>
                                    <p class="mb-4 text-xs"><TextoMat :texto="d.justificativa" /></p>

                                    <div class="grid gap-4 text-xs sm:grid-cols-2">
                                        <div>
                                            <h4 :class="SUB">Pressupostos</h4>
                                            <ul :class="LISTA"><li v-for="(p, k) in d.pressupostos" :key="k"><TextoMat :texto="p" /></li></ul>
                                        </div>
                                        <div>
                                            <h4 :class="SUB">Limitações</h4>
                                            <ul :class="LISTA"><li v-for="(l, k) in d.limitacoes" :key="k"><TextoMat :texto="l" /></li></ul>
                                        </div>
                                    </div>
                                </section>

                                <!-- Sem significado -->
                                <section v-if="semSignificado.length" id="m-sem-significado" class="mb-10 scroll-mt-4 border-t border-neutral-200 pt-6 dark:border-white/10">
                                    <h3 class="mb-2 text-base font-semibold text-neutral-900 dark:text-neutral-50">Métricas sem significado na fonte "{{ aplicacao.rotulo }}" ({{ semSignificado.length }})</h3>
                                    <p class="mb-2 text-xs text-neutral-500 dark:text-neutral-400">
                                        Não são calculadas nem exibidas nesta fonte{{ aplicacao.modo === 'descritiva' ? ': sem uma segunda fonte comparada, não há concordância a medir.' : '.' }}
                                    </p>
                                    <div class="flex flex-wrap gap-1.5">
                                        <span v-for="d in semSignificado" :key="d.id" class="rounded-full border border-dashed border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-500 dark:border-white/15 dark:text-neutral-400">{{ d.nome }}</span>
                                    </div>
                                </section>

                                <!-- Não implementadas -->
                                <section id="m-nao-implementadas" class="mb-12 scroll-mt-4 border-t border-neutral-200 pt-6 dark:border-white/10">
                                    <h3 class="mb-1 text-base font-semibold text-neutral-900 dark:text-neutral-50">Métricas não implementadas nesta análise ({{ naoImplementadas.length }})</h3>
                                    <p class="mb-3 text-xs text-neutral-500 dark:text-neutral-400">Documentadas para referência; nenhuma é calculada nem exibida.</p>
                                    <div v-for="d in naoImplementadas" :key="d.id" class="mb-3 rounded-xl border border-dashed border-neutral-300 p-3 text-xs dark:border-white/15">
                                        <p class="font-medium text-neutral-900 dark:text-neutral-100">{{ d.nome }}</p>
                                        <Tex v-for="(f, k) in d.formula" :key="k" :tex="f" display />
                                        <p class="mt-1"><TextoMat :texto="d.oQueMede" /></p>
                                        <p v-for="(f, k) in d.fundamentos" :key="k" class="mt-1.5 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-2">
                                            <span :class="[ETIQUETA, COR_NATUREZA[f.natureza]]">{{ ROTULO_NATUREZA[f.natureza] }}</span>
                                            <TextoMat :texto="f.texto" />
                                        </p>
                                        <p v-for="(c, k) in d.casosEspeciais" :key="`c${k}`" class="mt-1 text-neutral-500 dark:text-neutral-400"><TextoMat :texto="c" /></p>
                                    </div>
                                </section>

                                <!-- Denominadores -->
                                <section id="m-denominadores" class="mb-10 scroll-mt-4 border-t border-neutral-200 pt-6 dark:border-white/10">
                                    <p :class="SOBRETITULO">Fundamentos</p>
                                    <h3 class="mb-3 text-base font-semibold text-neutral-900 dark:text-neutral-50">Denominadores</h3>
                                    <div class="overflow-x-auto rounded-xl border border-neutral-200 dark:border-white/10">
                                        <table class="w-full min-w-[560px] text-xs">
                                            <thead class="bg-neutral-50 dark:bg-white/[0.03]">
                                                <tr class="text-left text-[10px] tracking-wider text-neutral-400 uppercase dark:text-neutral-500">
                                                    <th class="px-3 py-2 font-semibold">Métrica</th>
                                                    <th class="px-3 py-2 font-semibold">Numerador</th>
                                                    <th class="px-3 py-2 font-semibold">Denominador</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                <tr v-for="d in ativas" :key="d.id" class="border-t border-neutral-100 align-top dark:border-white/5">
                                                    <td class="px-3 py-2 font-medium text-neutral-900 dark:text-neutral-100">{{ d.nome }}</td>
                                                    <td class="px-3 py-2"><TextoMat :texto="d.numerador ?? '—'" /></td>
                                                    <td class="px-3 py-2"><TextoMat :texto="d.denominador ?? '—'" /></td>
                                                </tr>
                                            </tbody>
                                        </table>
                                    </div>
                                </section>

                                <!-- Casos especiais -->
                                <section id="m-especiais" class="mb-10 scroll-mt-4">
                                    <h3 class="mb-2 text-base font-semibold text-neutral-900 dark:text-neutral-50">Casos especiais</h3>
                                    <ul :class="LISTA">
                                        <li>Divisão por zero: o valor é null e aparece como "—", nunca como NaN ou Infinity. Vale para toda proporção, Precision, Recall, F1, Macro F1 e <Tex tex="\kappa" />.</li>
                                        <li><TextoMat texto="$\kappa$ indefinido: sem pares comparáveis ($N_{\mathrm{comp}} = 0$), ou com $P_e = 1$ (as duas fontes usaram uma única e mesma classe em todos os pares, $1 - P_e = 0$). A aplicação aos dados diz qual dos dois ocorreu." /></li>
                                        <li>UNRESOLVED é classe própria; NOT_CALLED e NO_RESPONSE são estados operacionais do Judge, fora da matriz (ver Tratamento dos dados).</li>
                                        <li>Classe com frequência zero não é ocultada: aparece na matriz e na tabela com "—" onde a métrica não é definida.</li>
                                    </ul>
                                </section>

                                <!-- Propriedades -->
                                <section id="m-propriedades" class="mb-10 scroll-mt-4">
                                    <h3 class="mb-3 text-base font-semibold text-neutral-900 dark:text-neutral-50">{{ secao('propriedades').titulo }}</h3>
                                    <ul class="space-y-2">
                                        <li v-for="(i, k) in secao('propriedades').itens" :key="k" class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-2">
                                            <span v-if="i.natureza" :class="[ETIQUETA, COR_NATUREZA[i.natureza]]">{{ ROTULO_NATUREZA[i.natureza] }}</span>
                                            <TextoMat :texto="i.texto" />
                                        </li>
                                    </ul>
                                    <p class="mt-3 text-xs text-neutral-500 dark:text-neutral-400">As demais métricas são definições estatísticas: não dependem de um teorema específico.</p>
                                </section>

                                <!-- Limitações -->
                                <section id="m-limitacoes" class="mb-12 scroll-mt-4">
                                    <h3 class="mb-2 text-base font-semibold text-neutral-900 dark:text-neutral-50">{{ secao('limitacoes').titulo }}</h3>
                                    <ul :class="LISTA"><li v-for="(i, k) in secao('limitacoes').itens" :key="k"><TextoMat :texto="i.texto" /></li></ul>
                                </section>

                                <!-- Exemplo didático -->
                                <section id="m-exemplo" class="mb-12 scroll-mt-4 border-t border-neutral-200 pt-6 dark:border-white/10">
                                    <p :class="SOBRETITULO">Leitura</p>
                                    <h3 class="mb-2 text-base font-semibold text-neutral-900 dark:text-neutral-50">Exemplo didático</h3>
                                    <p class="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-200">
                                        Exemplo didático — amostra artificial de 5 pares para conferir a matemática à mão. Não é resultado do experimento. Os números abaixo saem da mesma camada de cálculo usada na análise.
                                    </p>
                                    <div class="mb-5 overflow-x-auto">
                                        <table class="text-xs">
                                            <thead>
                                                <tr class="text-left text-[10px] tracking-wider text-neutral-400 uppercase dark:text-neutral-500">
                                                    <th class="py-1 pr-8 font-semibold">#</th><th class="py-1 pr-8 font-semibold">Oráculo</th><th class="py-1 font-semibold">Judge</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                <tr v-for="(e, k) in EXEMPLO_DIDATICO" :key="k" class="border-t border-neutral-100 dark:border-white/5">
                                                    <td class="py-1 pr-8 tabular-nums">{{ k + 1 }}</td>
                                                    <td class="py-1 pr-8 font-mono">{{ e.oraculo }}</td>
                                                    <td class="py-1 font-mono">{{ e.judge }}</td>
                                                </tr>
                                            </tbody>
                                        </table>
                                    </div>
                                    <div class="flex flex-col gap-6">
                                        <PassoMetodologia v-for="p in passosDidaticos" :key="p.titulo" :passo="p" mostrar-titulo />
                                    </div>
                                </section>

                                <!-- Interpretação, filtros e avaliação humana -->
                                <section id="m-interpretacao" class="scroll-mt-4">
                                    <h3 class="mb-2 text-base font-semibold text-neutral-900 dark:text-neutral-50">{{ secao('interpretacao').titulo }}</h3>
                                    <ul :class="LISTA"><li v-for="(i, k) in secao('interpretacao').itens" :key="k"><TextoMat :texto="i.texto" /></li></ul>
                                    <h4 class="mt-6" :class="SUB">{{ secao('filtros').titulo }}</h4>
                                    <ul :class="LISTA">
                                        <li>{{ aplicacao.recorte }}</li>
                                        <li v-for="(i, k) in secao('filtros').itens" :key="k"><TextoMat :texto="i.texto" /></li>
                                    </ul>
                                    <h4 class="mt-6" :class="SUB">{{ secao('avaliacaoHumana').titulo }}</h4>
                                    <ul :class="LISTA"><li v-for="(i, k) in secao('avaliacaoHumana').itens" :key="k"><TextoMat :texto="i.texto" /></li></ul>
                                    <div class="h-16"></div>
                                </section>
                            </article>
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
