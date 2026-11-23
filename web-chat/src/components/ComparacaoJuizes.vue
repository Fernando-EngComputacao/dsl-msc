<script setup lang="ts">
/**
 * O resultado do REJULGAMENTO: os dois juízes no mesmo plano.
 *
 * Mostra, e só mostra: todas as contas vêm de
 * src/inference/comparacao-juizes.ts, que por sua vez usa as fórmulas da
 * sessão "Avaliação LLM" (analise-avaliacao.ts). Nenhum número é recalculado
 * aqui, e todo percentual aparece com o seu denominador.
 *
 * A leitura da tela, de cima para baixo:
 *   1. quem julgou e o que ficou de fora;
 *   2. quanto cada juiz acompanha o ORÁCULO (a referência normativa) e quanto
 *      os dois concordam entre si;
 *   3. plano a plano, quem acerta quando os dois divergem;
 *   4. a matriz fronteira × local e a distribuição dos vereditos;
 *   5. a lista das divergências, com as duas justificativas.
 */
import { computed, ref } from 'vue';
import type { ComparacaoJuizes, ResumoRejulgamento } from '../api';
import type { Proporcao } from '../../../src/inference/analise-avaliacao';

const props = defineProps<{
    comparacao: ComparacaoJuizes;
    resumo?: ResumoRejulgamento;
    /** Nome do JSONL que o rejulgamento gravou, quando houve. */
    arquivoJsonl?: string;
}>();

const CLASSES = ['VALID', 'INVALID', 'UNRESOLVED'] as const;

const COR_VEREDITO: Record<string, string> = {
    VALID: 'text-emerald-700 dark:text-emerald-300',
    INVALID: 'text-rose-700 dark:text-rose-300',
    UNRESOLVED: 'text-amber-700 dark:text-amber-300'
};

function pct(p: Proporcao | undefined): string {
    if (!p || p.percentual === null) return '—';
    return `${p.percentual.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}
function fracao(p: Proporcao | undefined): string {
    return p ? `${p.n}/${p.denominador}` : '—';
}
function num(x: number | null | undefined, casas = 3): string {
    return x === null || x === undefined ? '—' : x.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}
/** n sobre um denominador explícito, em percentual. */
function parte(n: number, de: number): string {
    return de > 0 ? `${((100 * n) / de).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%` : '—';
}

const nomeFronteira = computed(() => {
    const j = props.comparacao.fronteira;
    return j.modelo ? `${j.provedor} · ${j.modelo}` : j.provedor;
});

/** A matriz do bloco `entreJuizes`: linhas = fronteira (referência), colunas = local. */
const matriz = computed(() => props.comparacao.entreJuizes.matriz);

const LIMITE_INICIAL = 25;
const todasDivergencias = ref(false);
const divergenciasVisiveis = computed(() =>
    todasDivergencias.value ? props.comparacao.divergencias : props.comparacao.divergencias.slice(0, LIMITE_INICIAL)
);
const aberta = ref<string | null>(null);
const chaveDivergencia = (d: { linha: number; lado: string }): string => `${d.lado}:${d.linha}`;
function alternar(chave: string): void {
    aberta.value = aberta.value === chave ? null : chave;
}
</script>

<template>
    <section class="animate-fade-in-up flex flex-col gap-6">
        <!-- 1. Quem julgou, e o que ficou de fora -->
        <div class="rounded-2xl border border-neutral-200 p-5 dark:border-white/10">
            <div class="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h2 class="text-lg font-medium text-neutral-900 dark:text-neutral-100">Dois juízes, os mesmos planos</h2>
                    <p class="mt-1 max-w-3xl text-sm text-neutral-500 dark:text-neutral-400">
                        Os planos do arquivo importado foram rejulgados por
                        <span class="font-medium text-neutral-700 dark:text-neutral-200">{{ nomeFronteira }}</span>
                        com o mesmo prompt e o mesmo contexto do juiz local — a recuperação foi refeita no grafo a partir do
                        cenário de entrada. O oráculo determinístico continua a referência normativa: o que se mede abaixo é o
                        juiz.
                    </p>
                </div>
                <dl class="grid shrink-0 grid-cols-2 gap-x-6 gap-y-1 text-sm">
                    <dt class="text-neutral-500 dark:text-neutral-400">Planos rejulgados</dt>
                    <dd class="text-right font-medium text-neutral-800 dark:text-neutral-100">{{ comparacao.total }}</dd>
                    <dt class="text-neutral-500 dark:text-neutral-400">Sem o julgamento anterior</dt>
                    <dd class="text-right font-medium text-neutral-800 dark:text-neutral-100">{{ comparacao.semPar }}</dd>
                    <template v-if="resumo">
                        <dt class="text-neutral-500 dark:text-neutral-400">Cenário de entrada</dt>
                        <dd class="text-right font-mono text-xs text-neutral-800 dark:text-neutral-100">{{ resumo.arquivoCenario }}</dd>
                    </template>
                </dl>
            </div>

            <p
                v-if="resumo && (resumo.semCenario > 0 || resumo.semPlano > 0)"
                class="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
            >
                Do arquivo importado ({{ resumo.registrosImportados }} registro(s)),
                <strong>{{ resumo.semCenario }}</strong> não acharam a sua linha em {{ resumo.arquivoCenario }} e
                <strong>{{ resumo.semPlano }}</strong> não tinham plano para julgar — essas linhas ficaram fora do
                rejulgamento, não entraram em nenhuma conta.
            </p>
            <p v-if="resumo" class="mt-3 text-xs text-neutral-400 dark:text-neutral-500">
                Casados com o cenário pelo sujeito: {{ resumo.casadosPorSujeito }}; pelo número de linha:
                {{ resumo.casadosPorLinha }}.
                <template v-if="arquivoJsonl">
                    O rejulgamento foi gravado em data/avaliacoes/{{ arquivoJsonl }}, com o veredito anterior ao lado de cada
                    plano.
                </template>
            </p>
        </div>

        <!-- 2. Cada juiz contra o oráculo, e os dois entre si -->
        <div class="grid gap-4 lg:grid-cols-3">
            <div
                v-for="c in [
                    { titulo: 'Oráculo × juiz local', dados: comparacao.oraculoLocal, destaque: false },
                    { titulo: `Oráculo × ${comparacao.fronteira.provedor}`, dados: comparacao.oraculoFronteira, destaque: true },
                    { titulo: `${comparacao.fronteira.provedor} × juiz local`, dados: comparacao.entreJuizes, destaque: false }
                ]"
                :key="c.titulo"
                class="evitar-quebra rounded-2xl border p-4"
                :class="
                    c.destaque
                        ? 'border-blue-200 bg-blue-50/50 dark:border-blue-500/30 dark:bg-blue-500/5'
                        : 'border-neutral-200 dark:border-white/10'
                "
            >
                <p class="text-sm font-medium text-neutral-800 dark:text-neutral-100">{{ c.titulo }}</p>
                <p class="mt-2.5 text-2xl font-medium text-neutral-900 dark:text-neutral-100">{{ pct(c.dados.concordancia) }}</p>
                <p class="text-xs text-neutral-500 dark:text-neutral-400">
                    concordância em {{ fracao(c.dados.concordancia) }} planos comparáveis
                </p>
                <dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <dt class="text-neutral-500 dark:text-neutral-400">κ de Cohen</dt>
                    <dd class="text-right font-medium text-neutral-800 dark:text-neutral-100">{{ num(c.dados.kappa.valor) }}</dd>
                    <dt class="text-neutral-500 dark:text-neutral-400">macro-F1</dt>
                    <dd class="text-right font-medium text-neutral-800 dark:text-neutral-100">{{ num(c.dados.macroF1.valor) }}</dd>
                    <dt class="text-neutral-500 dark:text-neutral-400">Cobertura do par</dt>
                    <dd class="text-right font-medium text-neutral-800 dark:text-neutral-100">
                        {{ pct(c.dados.cobertura) }} <span class="font-normal text-neutral-400">({{ fracao(c.dados.cobertura) }})</span>
                    </dd>
                </dl>
                <p v-if="c.dados.kappa.valor === null" class="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
                    κ não estimável: {{ c.dados.comparaveis === 0 ? 'nenhum par comparável' : 'P_e = 1 (uma única classe nas duas fontes)' }}.
                </p>
            </div>
        </div>

        <!-- 3. Quem acompanha o oráculo, plano a plano -->
        <div class="evitar-quebra rounded-2xl border border-neutral-200 p-5 dark:border-white/10">
            <p class="text-sm font-medium text-neutral-800 dark:text-neutral-100">Quem acompanha o oráculo</p>
            <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                Sobre os {{ comparacao.contraOraculo.n }} plano(s) em que o oráculo e OS DOIS juízes deram veredito. É a
                leitura direta de "a avaliação está certa?": o oráculo decide, e cada juiz acerta ou não.
            </p>
            <div class="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div
                    v-for="b in [
                        { rotulo: 'Os dois acertam', valor: comparacao.contraOraculo.ambos, cor: 'text-emerald-700 dark:text-emerald-300' },
                        { rotulo: 'Só o juiz local', valor: comparacao.contraOraculo.soLocal, cor: 'text-blue-700 dark:text-blue-300' },
                        { rotulo: `Só o ${comparacao.fronteira.provedor}`, valor: comparacao.contraOraculo.soFronteira, cor: 'text-violet-700 dark:text-violet-300' },
                        { rotulo: 'Nenhum dos dois', valor: comparacao.contraOraculo.nenhum, cor: 'text-rose-700 dark:text-rose-300' }
                    ]"
                    :key="b.rotulo"
                    class="rounded-xl bg-neutral-50 px-3 py-2.5 dark:bg-white/5"
                >
                    <p class="text-xl font-medium" :class="b.cor">{{ b.valor }}</p>
                    <p class="text-xs text-neutral-500 dark:text-neutral-400">
                        {{ b.rotulo }} · {{ parte(b.valor, comparacao.contraOraculo.n) }}
                    </p>
                </div>
            </div>
        </div>

        <!-- 4. A matriz e as distribuições -->
        <div class="grid gap-4 lg:grid-cols-2">
            <div class="evitar-quebra rounded-2xl border border-neutral-200 p-5 dark:border-white/10">
                <p class="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                    Matriz {{ comparacao.fronteira.provedor }} × juiz local
                </p>
                <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                    Linha = veredito do juiz de fronteira; coluna = veredito do juiz local. A diagonal são os acordos; fora
                    dela, quem disse o quê.
                </p>
                <div class="mt-3 overflow-x-auto">
                    <table class="w-full text-sm">
                        <thead>
                            <tr class="text-xs text-neutral-500 dark:text-neutral-400">
                                <th class="px-2 py-1.5 text-left font-medium">fronteira ↓ / local →</th>
                                <th v-for="c in CLASSES" :key="c" class="px-2 py-1.5 text-right font-medium">{{ c }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="r in CLASSES" :key="r" class="border-t border-neutral-100 dark:border-white/5">
                                <th class="px-2 py-1.5 text-left text-xs font-medium" :class="COR_VEREDITO[r]">{{ r }}</th>
                                <td
                                    v-for="c in CLASSES"
                                    :key="c"
                                    class="px-2 py-1.5 text-right tabular-nums"
                                    :class="
                                        r === c
                                            ? 'font-medium text-neutral-900 dark:text-neutral-100'
                                            : (matriz[r]?.[c] ?? 0) > 0
                                              ? 'text-rose-700 dark:text-rose-300'
                                              : 'text-neutral-300 dark:text-neutral-600'
                                    "
                                >
                                    {{ matriz[r]?.[c] ?? 0 }}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <div class="evitar-quebra rounded-2xl border border-neutral-200 p-5 dark:border-white/10">
                <p class="text-sm font-medium text-neutral-800 dark:text-neutral-100">Vereditos de cada juiz</p>
                <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                    Distribuição sobre os planos em que cada um registrou algo, e quanto cada um respondeu.
                </p>
                <div class="mt-3 overflow-x-auto">
                    <table class="w-full text-sm">
                        <thead>
                            <tr class="text-xs text-neutral-500 dark:text-neutral-400">
                                <th class="px-2 py-1.5 text-left font-medium">Juiz</th>
                                <th v-for="c in CLASSES" :key="c" class="px-2 py-1.5 text-right font-medium">{{ c }}</th>
                                <th class="px-2 py-1.5 text-right font-medium">Sem veredito</th>
                                <th class="px-2 py-1.5 text-right font-medium">Cobertura</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="j in [
                                    { rotulo: 'Local (Qwen)', dist: comparacao.distribuicoes.local, cob: comparacao.cobertura.local },
                                    { rotulo: comparacao.fronteira.provedor, dist: comparacao.distribuicoes.fronteira, cob: comparacao.cobertura.fronteira }
                                ]"
                                :key="j.rotulo"
                                class="border-t border-neutral-100 dark:border-white/5"
                            >
                                <th class="px-2 py-1.5 text-left text-xs font-medium text-neutral-700 dark:text-neutral-200">
                                    {{ j.rotulo }}
                                </th>
                                <td v-for="c in CLASSES" :key="c" class="px-2 py-1.5 text-right tabular-nums text-neutral-700 dark:text-neutral-200">
                                    {{ j.dist.porEstado[c]?.n ?? 0 }}
                                    <span class="text-xs text-neutral-400">({{ pct(j.dist.porEstado[c]) }})</span>
                                </td>
                                <td class="px-2 py-1.5 text-right tabular-nums text-neutral-700 dark:text-neutral-200">
                                    {{ (j.dist.porEstado.NOT_CALLED?.n ?? 0) + (j.dist.porEstado.NO_RESPONSE?.n ?? 0) }}
                                </td>
                                <td class="px-2 py-1.5 text-right tabular-nums text-neutral-700 dark:text-neutral-200">
                                    {{ pct(j.cob.cobertura) }}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <p class="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
                    "Sem veredito" são os estados operacionais do juiz (NOT_CALLED, NO_RESPONSE): ele não foi chamado, ou não
                    respondeu no formato. Nenhum veredito é inventado no lugar deles.
                </p>
            </div>
        </div>

        <!-- 5. As divergências -->
        <div class="rounded-2xl border border-neutral-200 p-5 dark:border-white/10">
            <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <p class="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                        Divergências entre os juízes ({{ comparacao.divergencias.length }})
                    </p>
                    <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                        Planos em que os dois deram veredito e discordaram. Clique na linha para ler as duas justificativas.
                    </p>
                </div>
                <button
                    v-if="comparacao.divergencias.length > LIMITE_INICIAL"
                    type="button"
                    class="sem-impressao rounded-full border border-neutral-200 px-3.5 py-1.5 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/10"
                    @click="todasDivergencias = !todasDivergencias"
                >
                    {{ todasDivergencias ? `Mostrar só ${LIMITE_INICIAL}` : `Mostrar todas (${comparacao.divergencias.length})` }}
                </button>
            </div>

            <p v-if="comparacao.divergencias.length === 0" class="mt-4 text-sm text-neutral-500 dark:text-neutral-400">
                Nenhuma: nos planos em que os dois juízes deram veredito, eles disseram a mesma coisa.
            </p>

            <div v-else class="mt-4 overflow-x-auto">
                <table class="w-full text-sm">
                    <thead>
                        <tr class="text-xs text-neutral-500 dark:text-neutral-400">
                            <th class="px-2 py-1.5 text-left font-medium">Linha</th>
                            <th class="px-2 py-1.5 text-left font-medium">Modelo</th>
                            <th class="px-2 py-1.5 text-left font-medium">Sujeito</th>
                            <th class="px-2 py-1.5 text-left font-medium">Oráculo</th>
                            <th class="px-2 py-1.5 text-left font-medium">Juiz local</th>
                            <th class="px-2 py-1.5 text-left font-medium">{{ comparacao.fronteira.provedor }}</th>
                            <th class="px-2 py-1.5 text-left font-medium">Acompanha o oráculo</th>
                        </tr>
                    </thead>
                    <tbody>
                        <template v-for="d in divergenciasVisiveis" :key="chaveDivergencia(d)">
                            <tr
                                class="cursor-pointer border-t border-neutral-100 hover:bg-neutral-50 dark:border-white/5 dark:hover:bg-white/5"
                                @click="alternar(chaveDivergencia(d))"
                            >
                                <td class="px-2 py-1.5 tabular-nums text-neutral-700 dark:text-neutral-200">{{ d.linha }}</td>
                                <td class="px-2 py-1.5 text-xs text-neutral-500 dark:text-neutral-400">{{ d.lado }}</td>
                                <td class="px-2 py-1.5 font-mono text-xs text-neutral-500 dark:text-neutral-400">{{ d.sujeito ?? '—' }}</td>
                                <td class="px-2 py-1.5 text-xs font-medium" :class="d.oraculo ? COR_VEREDITO[d.oraculo] : 'text-neutral-400'">
                                    {{ d.oraculo ?? '—' }}
                                </td>
                                <td class="px-2 py-1.5 text-xs font-medium" :class="COR_VEREDITO[d.local]">{{ d.local }}</td>
                                <td class="px-2 py-1.5 text-xs font-medium" :class="COR_VEREDITO[d.fronteira]">{{ d.fronteira }}</td>
                                <td class="px-2 py-1.5 text-xs text-neutral-600 dark:text-neutral-300">
                                    {{
                                        d.acompanhaOraculo === 'local'
                                            ? 'o juiz local'
                                            : d.acompanhaOraculo === 'fronteira'
                                              ? comparacao.fronteira.provedor
                                              : d.acompanhaOraculo === 'nenhum'
                                                ? 'nenhum dos dois'
                                                : '—'
                                    }}
                                </td>
                            </tr>
                            <tr v-if="aberta === chaveDivergencia(d)" class="border-t border-neutral-100 bg-neutral-50/70 dark:border-white/5 dark:bg-white/5">
                                <td colspan="7" class="px-3 py-3">
                                    <p class="mb-2 text-xs text-neutral-500 dark:text-neutral-400">{{ d.intencao }}</p>
                                    <div class="grid gap-3 sm:grid-cols-2">
                                        <div>
                                            <p class="text-xs font-medium text-neutral-600 dark:text-neutral-300">Juiz local</p>
                                            <p class="mt-1 text-xs text-neutral-600 dark:text-neutral-300">
                                                {{ d.justificativaLocal ?? '(o arquivo importado não guardou a justificativa)' }}
                                            </p>
                                        </div>
                                        <div>
                                            <p class="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                                                {{ nomeFronteira }}
                                            </p>
                                            <p class="mt-1 text-xs text-neutral-600 dark:text-neutral-300">
                                                {{ d.justificativaFronteira ?? '(sem justificativa)' }}
                                            </p>
                                        </div>
                                    </div>
                                </td>
                            </tr>
                        </template>
                    </tbody>
                </table>
            </div>
        </div>
    </section>
</template>
