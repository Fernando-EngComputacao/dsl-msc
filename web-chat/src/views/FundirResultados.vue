<script setup lang="ts">
/**
 * Tela da FUSÃO: escolhe avaliações gravadas (de quantos domínios quiser), junta
 * cada registro com o cenário de entrada e o desenho do lote, e baixa.
 *
 * A junção é do servidor (`src/inference/fusao-avaliacoes.ts`): aqui só se
 * escolhe, se confere a cobertura e se baixa. O resumo vem ANTES do download de
 * propósito — é nele que uma avaliação com linhas faltando aparece como lacuna,
 * em vez de passar por lote completo.
 */
import { computed, onMounted, ref } from 'vue';
import {
    listarAvaliacoes,
    listarCenarios,
    resumirFusao,
    urlFusao,
    type AvaliacaoGravada,
    type CenarioDisponivel,
    type FormatoFusao,
    type ParteFusao,
    type ResumoFusao
} from '../api';
import { BOTAO_AJUDA } from '../ui';

const avaliacoes = ref<AvaliacaoGravada[]>([]);
const cenarios = ref<CenarioDisponivel[]>([]);
const selecionados = ref<Set<string>>(new Set());
/** Cenários escolhidos sozinhos, como fonte sem avaliação. */
const cenariosAvulsos = ref<Set<string>>(new Set());
/** avaliação -> id do cenário escolhido à mão, `'nenhum'`, ou '' para automático. */
const cenarioDe = ref<Record<string, string>>({});
const carregando = ref(true);
const erro = ref<string | null>(null);

/** O MODO DE FUSÃO: quais das três partes vão no arquivo. */
const partes = ref<Set<ParteFusao>>(new Set(['cenario', 'resultado', 'avaliacao']));
const incluirPlano = ref(true);
const incluirDesenho = ref(true);
const incluirSemAvaliacao = ref(true);

const resumo = ref<ResumoFusao | null>(null);
const resumindo = ref(false);
const erroResumo = ref<string | null>(null);
const ajudaAberta = ref(false);

const MODOS: { parte: ParteFusao; titulo: string; descricao: string }[] = [
    {
        parte: 'cenario',
        titulo: 'Cenários',
        descricao:
            'A ENTRADA: o pedido, a telemetria, as áreas/populações/contextos e os itens em uso, do cenarios-*.jsonl.'
    },
    {
        parte: 'resultado',
        titulo: 'Resultados',
        descricao: 'O que o sistema GEROU: o plano/missão/arbitragem e o bloco geracao (tempos e tamanhos).'
    },
    {
        parte: 'avaliacao',
        titulo: 'Avaliações',
        descricao: 'O JULGAMENTO: sintaxe, semântica, oráculo, juiz LLM, concordância e classificação.'
    }
];

function alternarParte(parte: ParteFusao): void {
    const s = new Set(partes.value);
    // Pelo menos uma parte: sem nenhuma, o arquivo seria só a identidade das linhas.
    if (s.has(parte) && s.size === 1) return;
    if (s.has(parte)) s.delete(parte);
    else s.add(parte);
    partes.value = s;
    resumo.value = null;
}

const opcoes = computed(() => ({
    partes: MODOS.map(m => m.parte).filter(p => partes.value.has(p)),
    incluirPlano: incluirPlano.value,
    incluirDesenho: incluirDesenho.value,
    incluirSemAvaliacao: incluirSemAvaliacao.value
}));

const selecao = computed(() => ({
    avaliacoes: [...selecionados.value],
    cenarios: [...cenariosAvulsos.value],
    cenarioDe: cenarioDe.value
}));

const nadaEscolhido = computed(() => selecionados.value.size === 0 && cenariosAvulsos.value.size === 0);

const escolhidos = computed(() => avaliacoes.value.filter(a => selecionados.value.has(a.arquivo)));
const dominiosEscolhidos = computed(() =>
    [
        ...new Set([
            ...escolhidos.value.flatMap(a => a.dominios),
            ...cenarios.value.filter(c => cenariosAvulsos.value.has(c.id)).map(c => c.dominio)
        ])
    ].sort()
);

/** Os cenários que uma avaliação pode usar: os do domínio dela (ou todos, sem domínio). */
function cenariosPara(a: AvaliacaoGravada): CenarioDisponivel[] {
    if (a.dominios.length !== 1) return cenarios.value;
    return cenarios.value.filter(c => c.dominio === a.dominios[0]);
}

function definirCenarioDe(arquivo: string, valor: string): void {
    cenarioDe.value = { ...cenarioDe.value, [arquivo]: valor };
    resumo.value = null;
}

function alternarCenarioAvulso(id: string): void {
    const s = new Set(cenariosAvulsos.value);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    cenariosAvulsos.value = s;
    resumo.value = null;
}

/** Cenários agrupados por domínio, para a seção de fontes avulsas. */
const cenariosPorDominio = computed(() => {
    const grupos = new Map<string, CenarioDisponivel[]>();
    for (const c of cenarios.value) {
        if (!grupos.has(c.dominio)) grupos.set(c.dominio, []);
        grupos.get(c.dominio)!.push(c);
    }
    return [...grupos.entries()].sort((a, b) => a[0].localeCompare(b[0]));
});

/** Agrupa a lista por domínio — a tela existe para cruzar domínios, então eles vêm separados. */
const porDominio = computed(() => {
    const grupos = new Map<string, AvaliacaoGravada[]>();
    for (const a of avaliacoes.value) {
        const chave = a.dominios.length === 1 ? a.dominios[0] : a.dominios.join('+') || 'sem domínio';
        if (!grupos.has(chave)) grupos.set(chave, []);
        grupos.get(chave)!.push(a);
    }
    return [...grupos.entries()].sort((a, b) => a[0].localeCompare(b[0]));
});

const ROTULO_DOMINIO: Record<string, string> = {
    med: 'Terapia intensiva (med)',
    agro: 'Pulverização por drone (agro)',
    fut: 'Arbitragem de futebol (fut)'
};
const rotuloDominio = (d: string): string => ROTULO_DOMINIO[d] ?? d;

function alternar(arquivo: string): void {
    const s = new Set(selecionados.value);
    if (s.has(arquivo)) s.delete(arquivo);
    else s.add(arquivo);
    selecionados.value = s;
    resumo.value = null;
}

function selecionarTodos(lista: AvaliacaoGravada[], ligar: boolean): void {
    const s = new Set(selecionados.value);
    for (const a of lista) {
        if (ligar) s.add(a.arquivo);
        else s.delete(a.arquivo);
    }
    selecionados.value = s;
    resumo.value = null;
}

const todosMarcados = (lista: AvaliacaoGravada[]): boolean =>
    lista.length > 0 && lista.every(a => selecionados.value.has(a.arquivo));

function formatarBytes(b: number): string {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} kB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function formatarData(iso: string): string {
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

async function conferir(): Promise<void> {
    resumindo.value = true;
    erroResumo.value = null;
    try {
        resumo.value = await resumirFusao(selecao.value, opcoes.value);
    } catch (e) {
        resumo.value = null;
        erroResumo.value = (e as Error).message;
    } finally {
        resumindo.value = false;
    }
}

function baixar(formato: FormatoFusao): void {
    window.location.href = urlFusao(selecao.value, formato, opcoes.value);
}

onMounted(async () => {
    try {
        const [av, cen] = await Promise.all([listarAvaliacoes(), listarCenarios()]);
        avaliacoes.value = av;
        cenarios.value = cen;
        // Pré-seleciona a avaliação mais recente de cada domínio: o caso comum é
        // cruzar "o último lote de cada um", não escolher doze arquivos à mão.
        const vistos = new Set<string>();
        const s = new Set<string>();
        for (const a of avaliacoes.value) {
            const d = a.dominios[0] ?? '';
            if (d && !vistos.has(d)) {
                vistos.add(d);
                s.add(a.arquivo);
            }
        }
        selecionados.value = s;
    } catch (e) {
        erro.value = (e as Error).message;
    } finally {
        carregando.value = false;
    }
});

const CARTAO = 'rounded-2xl border border-neutral-200 p-4 dark:border-white/10';
const CHIP = 'rounded-full px-1.5 py-0.5 text-[10px] font-medium';
</script>

<template>
    <div class="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
        <div class="mb-5 flex items-start gap-2.5">
            <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M3 5h7l3 4h8" />
                    <path d="M3 19h7l3-4h8" />
                    <path d="M18 5l3 4-3 4" />
                </svg>
            </div>
            <div class="min-w-0">
                <h1 class="flex items-center gap-2 text-base font-semibold text-neutral-900 dark:text-neutral-100">
                    Fundir cenários, resultados e avaliações
                    <button type="button" :class="BOTAO_AJUDA" aria-label="O que a fusão junta" title="O que a fusão junta" @click="ajudaAberta = !ajudaAberta">?</button>
                </h1>
                <p class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                    Um registro por plano, com a ENTRADA que o sistema recebeu, o RESULTADO que ele gerou e a
                    AVALIAÇÃO de cada camada — de quantos domínios você escolher, num arquivo só.
                </p>
            </div>
        </div>

        <div v-if="ajudaAberta" class="mb-5 rounded-2xl border border-blue-200/70 bg-blue-50/50 p-4 text-xs leading-relaxed text-neutral-700 dark:border-blue-500/20 dark:bg-blue-500/5 dark:text-neutral-200">
            <p class="mb-2">
                O <code>evalueted_*.jsonl</code> já traz duas das três partes: o <strong>resultado</strong> (o
                <code>plano</code> gerado e o bloco <code>geracao</code>) e a <strong>avaliação</strong> (sintaxe,
                semântica, oráculo, juiz). Falta nele a <strong>entrada</strong> completa — telemetria, áreas e
                itens em uso só existem no <code>cenarios-*.jsonl</code>.
            </p>
            <p class="mb-2">
                A fusão acha o cenário pelo nome do arquivo (<code>evalueted_<em>base</em>_carimbo.jsonl</code> →
                <code>src/examples/&lt;domínio&gt;/<em>base</em>.jsonl</code>) e casa linha a linha
                <strong>pelo sujeito</strong> (talhão, partida, paciente), caindo no número de linha só quando o
                sujeito não existe. O campo <code>fusao.juncao</code> de cada registro diz qual chave foi usada.
                Quando o nome não leva ao cenário certo — ou leva a nenhum —, o seletor de cada avaliação troca o
                cenário à mão, e o resumo mostra na hora quantas linhas casaram.
            </p>
            <p class="mb-2">
                O <strong>modo de fusão</strong> escolhe quais partes vão em cada registro. Parte fora do modo não
                existe no arquivo — não vira campo nulo nem coluna vazia —, e o modo entra no nome do arquivo
                baixado, porque dois downloads do mesmo lote com partes diferentes são arquivos diferentes.
            </p>
            <p>
                Nada é recalculado nem estimado: campo que nenhuma fonte trouxe fica ausente. O resumo diz quantas
                linhas ficaram sem cada parte — é assim que uma avaliação com linhas faltando aparece como lacuna.
            </p>
        </div>

        <section v-if="!carregando && !erro" :class="[CARTAO, 'mb-4']">
            <p class="mb-1 text-sm font-medium text-neutral-800 dark:text-neutral-100">Modo de fusão</p>
            <p class="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
                Quais das três partes vão em cada registro. A identidade da linha (domínio, lado, linha, sujeito) e
                a procedência ficam sempre — sem elas o registro não se liga a nada.
            </p>
            <div class="grid gap-2 sm:grid-cols-3">
                <button
                    v-for="m in MODOS"
                    :key="m.parte"
                    type="button"
                    class="rounded-xl border p-3 text-left transition-colors"
                    :class="
                        partes.has(m.parte)
                            ? 'border-blue-400 bg-blue-50/60 dark:border-blue-500/40 dark:bg-blue-500/10'
                            : 'border-neutral-200 hover:border-neutral-300 dark:border-white/10 dark:hover:border-white/20'
                    "
                    :aria-pressed="partes.has(m.parte)"
                    @click="alternarParte(m.parte)"
                >
                    <span class="flex items-center gap-2">
                        <span
                            class="flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold"
                            :class="
                                partes.has(m.parte)
                                    ? 'border-blue-500 bg-blue-500 text-white'
                                    : 'border-neutral-300 text-transparent dark:border-white/20'
                            "
                            >✓</span
                        >
                        <span class="text-xs font-medium text-neutral-800 dark:text-neutral-100">{{ m.titulo }}</span>
                    </span>
                    <span class="mt-1.5 block text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">{{
                        m.descricao
                    }}</span>
                </button>
            </div>
            <p v-if="partes.size === 1" class="mt-2 text-[11px] text-neutral-400 dark:text-neutral-500">
                Pelo menos uma parte fica ligada.
            </p>
        </section>

        <p v-if="carregando" class="text-xs text-neutral-500 dark:text-neutral-400">Carregando avaliações…</p>
        <p v-else-if="erro" class="rounded-2xl border border-red-200 bg-red-50/60 p-4 text-xs text-red-700 dark:border-red-500/20 dark:bg-red-500/5 dark:text-red-300">
            {{ erro }} — a API está no ar? (<code>npm run web:api</code>)
        </p>
        <p v-else-if="avaliacoes.length === 0" class="text-xs text-neutral-500 dark:text-neutral-400">
            Nenhuma avaliação gravada em <code>data/avaliacoes/</code>. Rode uma avaliação em
            <strong>Avaliar resultados</strong> e volte aqui.
        </p>

        <template v-else>
            <div class="flex flex-col gap-4">
                <section v-for="[dominio, lista] in porDominio" :key="dominio" :class="CARTAO">
                    <div class="mb-2.5 flex flex-wrap items-baseline justify-between gap-2">
                        <p class="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                            {{ rotuloDominio(dominio) }}
                            <span class="text-xs font-normal text-neutral-500 dark:text-neutral-400">
                                · {{ lista.length }} avaliação(ões)</span
                            >
                        </p>
                        <button
                            type="button"
                            class="text-xs text-blue-600 hover:underline dark:text-blue-400"
                            @click="selecionarTodos(lista, !todosMarcados(lista))"
                        >
                            {{ todosMarcados(lista) ? 'desmarcar todas' : 'marcar todas' }}
                        </button>
                    </div>

                    <ul class="flex flex-col gap-1.5">
                        <li v-for="a in lista" :key="a.arquivo">
                            <label
                                class="flex cursor-pointer items-start gap-2.5 rounded-xl px-2 py-1.5 hover:bg-neutral-50 dark:hover:bg-white/5"
                                :class="selecionados.has(a.arquivo) ? 'bg-neutral-50 dark:bg-white/5' : ''"
                            >
                                <input
                                    type="checkbox"
                                    class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-blue-600"
                                    :checked="selecionados.has(a.arquivo)"
                                    @change="alternar(a.arquivo)"
                                />
                                <span class="min-w-0 flex-1">
                                    <span class="block truncate font-mono text-[11px] text-neutral-800 dark:text-neutral-100">{{ a.arquivo }}</span>
                                    <span class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                                        <span class="tabular-nums">{{ a.registros }} registros</span>
                                        <span class="tabular-nums">{{ formatarBytes(a.bytes) }}</span>
                                        <span class="tabular-nums">{{ formatarData(a.modificadoEm) }}</span>
                                        <span v-for="l in a.lados" :key="l" :class="[CHIP, 'bg-neutral-100 text-neutral-600 dark:bg-white/10 dark:text-neutral-300']">{{ l }}</span>

                                        <span v-if="a.cenario" :class="[CHIP, 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300']">
                                            cenário: {{ a.cenario.linhas }} linhas
                                        </span>
                                        <span v-else :class="[CHIP, 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300']">
                                            cenário não localizado
                                        </span>
                                        <span v-if="a.cenario?.desenho" :class="[CHIP, 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300']">
                                            com desenho
                                        </span>
                                        <span
                                            v-if="a.semAvaliacao !== null && a.semAvaliacao > 0"
                                            :class="[CHIP, 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300']"
                                            :title="`${a.semAvaliacao} linha(s) do cenário sem registro de avaliação`"
                                        >
                                            {{ a.semAvaliacao }} sem avaliação
                                        </span>
                                        <span v-if="a.erro" :class="[CHIP, 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300']">{{ a.erro }}</span>
                                    </span>
                                </span>
                            </label>

                            <div
                                v-if="selecionados.has(a.arquivo) && partes.has('cenario')"
                                class="mt-1 ml-6 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400"
                            >
                                <label :for="`cen-${a.arquivo}`">cenário a juntar:</label>
                                <select
                                    :id="`cen-${a.arquivo}`"
                                    class="max-w-full rounded-lg border border-neutral-200 bg-white px-1.5 py-1 text-[11px] text-neutral-700 dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-200"
                                    :value="cenarioDe[a.arquivo] ?? ''"
                                    @change="definirCenarioDe(a.arquivo, ($event.target as HTMLSelectElement).value)"
                                >
                                    <option value="">
                                        automático pelo nome{{ a.cenario ? ` (${a.cenario.linhas} linhas)` : ' — não localizado' }}
                                    </option>
                                    <option v-for="c in cenariosPara(a)" :key="c.id" :value="c.id">
                                        {{ c.dominio }}/{{ c.arquivo }} ({{ c.linhas }} linhas{{ c.desenho ? ', com desenho' : '' }})
                                    </option>
                                    <option value="nenhum">nenhum — não juntar cenário</option>
                                </select>
                            </div>
                        </li>
                    </ul>
                </section>
            </div>

            <section v-if="cenarios.length > 0" :class="[CARTAO, 'mt-4']">
                <p class="mb-1 text-sm font-medium text-neutral-800 dark:text-neutral-100">
                    Cenários como fonte própria
                </p>
                <p class="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
                    Um <code>cenarios-*.jsonl</code> marcado aqui entra <strong>sem avaliação</strong>: todas as
                    linhas dele vão para o arquivo. É como se pede um conjunto só de entradas, de vários domínios —
                    útil com o modo em <strong>Cenários</strong> apenas. Para juntar um cenário a uma avaliação, use
                    o seletor da avaliação acima.
                </p>
                <div v-for="[dominio, lista] in cenariosPorDominio" :key="dominio" class="mb-2.5 last:mb-0">
                    <p class="mb-1 text-[11px] font-medium tracking-wide text-neutral-400 uppercase dark:text-neutral-500">
                        {{ rotuloDominio(dominio) }}
                    </p>
                    <ul class="flex flex-wrap gap-1.5">
                        <li v-for="c in lista" :key="c.id">
                            <label
                                class="flex cursor-pointer items-center gap-1.5 rounded-xl border px-2 py-1 text-[11px] transition-colors"
                                :class="
                                    cenariosAvulsos.has(c.id)
                                        ? 'border-blue-400 bg-blue-50/60 dark:border-blue-500/40 dark:bg-blue-500/10'
                                        : 'border-neutral-200 hover:border-neutral-300 dark:border-white/10'
                                "
                            >
                                <input
                                    type="checkbox"
                                    class="h-3.5 w-3.5 shrink-0 accent-blue-600"
                                    :checked="cenariosAvulsos.has(c.id)"
                                    @change="alternarCenarioAvulso(c.id)"
                                />
                                <span class="font-mono text-neutral-800 dark:text-neutral-100">{{ c.arquivo }}</span>
                                <span class="tabular-nums text-neutral-500 dark:text-neutral-400">{{ c.linhas }}</span>
                                <span v-if="c.desenho" :class="[CHIP, 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300']">desenho</span>
                            </label>
                        </li>
                    </ul>
                </div>
            </section>

            <section :class="[CARTAO, 'mt-4']">
                <p class="mb-2.5 text-sm font-medium text-neutral-800 dark:text-neutral-100">O que vai no arquivo</p>
                <div class="flex flex-col gap-2 text-xs text-neutral-700 dark:text-neutral-200">
                    <label class="flex cursor-pointer items-start gap-2" :class="partes.has('resultado') ? '' : 'opacity-40'">
                        <input v-model="incluirPlano" type="checkbox" :disabled="!partes.has('resultado')" class="mt-0.5 h-3.5 w-3.5 accent-blue-600" @change="resumo = null" />
                        <span>
                            <strong class="font-medium">Texto do plano gerado.</strong>
                            Desligue para um arquivo muito menor quando a análise é só de vereditos e tempos. Não vai
                            no CSV em nenhum caso: é texto multilinha de DSL.
                        </span>
                    </label>
                    <label class="flex cursor-pointer items-start gap-2">
                        <input v-model="incluirDesenho" type="checkbox" class="mt-0.5 h-3.5 w-3.5 accent-blue-600" @change="resumo = null" />
                        <span>
                            <strong class="font-medium">Desenho do cenário.</strong>
                            Família, dimensão controlada, estruturas exercitadas e classe esperada, do
                            <code>*.meta.jsonl</code> do lote — só existe nos lotes que o têm.
                        </span>
                    </label>
                    <label class="flex cursor-pointer items-start gap-2" :class="partes.has('cenario') ? '' : 'opacity-40'">
                        <input v-model="incluirSemAvaliacao" type="checkbox" :disabled="!partes.has('cenario')" class="mt-0.5 h-3.5 w-3.5 accent-blue-600" @change="resumo = null" />
                        <span>
                            <strong class="font-medium">Cenários sem avaliação.</strong>
                            Entram com <code>avaliacao: null</code>. É o que torna visível o cenário que o lote
                            deixou de fora, em vez de ele simplesmente não existir no arquivo.
                        </span>
                    </label>
                </div>

                <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-neutral-200 pt-3.5 dark:border-white/10">
                    <button
                        type="button"
                        class="rounded-full bg-neutral-900 px-3.5 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
                        :disabled="nadaEscolhido || resumindo"
                        @click="conferir"
                    >
                        {{ resumindo ? 'conferindo…' : 'Conferir cobertura' }}
                    </button>
                    <button
                        type="button"
                        class="rounded-full border border-neutral-300 px-3.5 py-1.5 text-xs font-medium text-neutral-700 disabled:opacity-40 dark:border-white/20 dark:text-neutral-200"
                        :disabled="nadaEscolhido"
                        @click="baixar('jsonl')"
                    >
                        Baixar JSONL
                    </button>
                    <button
                        type="button"
                        class="rounded-full border border-neutral-300 px-3.5 py-1.5 text-xs font-medium text-neutral-700 disabled:opacity-40 dark:border-white/20 dark:text-neutral-200"
                        :disabled="nadaEscolhido"
                        @click="baixar('csv')"
                    >
                        Baixar CSV
                    </button>
                    <p class="ml-auto text-[11px] text-neutral-500 dark:text-neutral-400">
                        {{ selecionados.size }} avaliação(ões)<span v-if="cenariosAvulsos.size">
                            + {{ cenariosAvulsos.size }} cenário(s)</span
                        >
                        <span v-if="dominiosEscolhidos.length"> · {{ dominiosEscolhidos.join(', ') }}</span>
                        · modo {{ opcoes.partes.join(' + ') }}
                    </p>
                </div>
                <p v-if="erroResumo" class="mt-2.5 text-xs text-red-700 dark:text-red-300">{{ erroResumo }}</p>
            </section>

            <section v-if="resumo" :class="[CARTAO, 'mt-4']">
                <p class="mb-1 text-sm font-medium text-neutral-800 dark:text-neutral-100">Cobertura da fusão</p>
                <p class="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
                    <span class="font-medium text-neutral-700 tabular-nums dark:text-neutral-200">{{ resumo.registros }}</span>
                    registros · partes {{ resumo.partes.join(' + ') }} · domínios {{ resumo.dominios.join(', ') || '—' }} ·
                    <span class="tabular-nums">{{ resumo.totalSemAvaliacao }}</span> cenário(s) sem avaliação ·
                    <span class="tabular-nums">{{ resumo.totalSemCenario }}</span> avaliação(ões) sem cenário
                </p>

                <div class="-mx-1 overflow-x-auto px-1">
                    <table class="w-full min-w-[46rem] border-collapse text-left text-xs">
                        <thead>
                            <tr class="text-[11px] tracking-wide text-neutral-400 uppercase dark:text-neutral-500">
                                <th class="py-1.5 pr-3 font-normal">Avaliação</th>
                                <th class="py-1.5 pr-3 font-normal" title="Registros de avaliação lidos">aval.</th>
                                <th class="py-1.5 pr-3 font-normal" title="Linhas do arquivo de cenários">cen.</th>
                                <th class="py-1.5 pr-3 font-normal" title="Linhas que o arquivo fundido recebe desta fonte">fundidos</th>
                                <th class="py-1.5 pr-3 font-normal" title="Casadas pelo sujeito (talhão, partida, paciente)">por sujeito</th>
                                <th class="py-1.5 pr-3 font-normal" title="Casadas pelo número de linha, por falta de sujeito">por linha</th>
                                <th class="py-1.5 pr-3 font-normal" title="Avaliações que não acharam cenário">s/ cenário</th>
                                <th class="py-1.5 font-normal" title="Cenários sem registro de avaliação">s/ avaliação</th>
                            </tr>
                        </thead>
                        <tbody class="text-neutral-700 dark:text-neutral-200">
                            <tr v-for="f in resumo.fontes" :key="f.arquivo" class="border-t border-neutral-100 align-top dark:border-white/5">
                                <th class="max-w-[18rem] py-1.5 pr-3 text-left font-normal">
                                    <span class="block truncate font-mono text-[11px]" :title="f.arquivo">
                                        <span
                                            v-if="f.tipo === 'cenario'"
                                            :class="[CHIP, 'mr-1 bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300']"
                                            >cenário</span
                                        >{{ f.arquivo }}</span
                                    >
                                    <span v-if="f.arquivoCenario" class="block truncate text-[10px] text-neutral-400 dark:text-neutral-500" :title="f.arquivoCenario">
                                        ↳ {{ f.arquivoCenario }}
                                    </span>
                                    <span v-else class="text-[10px] text-amber-700 dark:text-amber-300">↳ cenário não localizado</span>
                                </th>
                                <td class="py-1.5 pr-3 tabular-nums">{{ f.avaliacoes }}</td>
                                <td class="py-1.5 pr-3 tabular-nums">{{ f.cenarios ?? '—' }}</td>
                                <td class="py-1.5 pr-3 font-medium tabular-nums">{{ f.fundidos }}</td>
                                <td class="py-1.5 pr-3 tabular-nums">{{ f.casadosPorSujeito }}</td>
                                <td class="py-1.5 pr-3 tabular-nums" :class="f.casadosPorLinha > 0 ? 'text-amber-700 dark:text-amber-300' : ''">{{ f.casadosPorLinha }}</td>
                                <td class="py-1.5 pr-3 tabular-nums" :class="f.semCenario > 0 ? 'text-amber-700 dark:text-amber-300' : ''">{{ f.semCenario }}</td>
                                <td class="py-1.5 tabular-nums" :class="f.semAvaliacao > 0 ? 'text-amber-700 dark:text-amber-300' : ''">
                                    {{ f.semAvaliacao }}
                                    <span v-if="f.lacunas.length" class="block text-[10px] text-neutral-400 dark:text-neutral-500">
                                        linhas {{ f.lacunas.join(', ') }}{{ f.lacunasTruncadas ? '…' : '' }}
                                    </span>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <p class="mt-3.5 border-t border-neutral-200 pt-3 text-[11px] leading-relaxed text-neutral-500 dark:border-white/10 dark:text-neutral-400">
                    <strong class="font-medium">Como ler.</strong> <em>por sujeito</em> é a junção forte: ela
                    sobrevive a arquivo de cenários reordenado e a avaliação que renumerou as linhas. Linha casada
                    <em>por linha</em> depende da ordem dos dois arquivos coincidir — confira antes de usar.
                    <em>s/ avaliação</em> maior que zero significa que o lote não cobriu o cenário inteiro: os
                    números de linha ao lado são os que faltaram, no arquivo de cenários.
                    <span v-if="resumo.partes.includes('cenario') && Object.keys(resumo.telemetriaPorDominio).length > 1">
                        No CSV, as colunas <code>tel_*</code> são a união dos sensores dos domínios selecionados —
                        célula vazia é parâmetro que não existe naquele domínio, não zero.
                    </span>
                </p>
            </section>
        </template>
    </div>
</template>
