<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DetalheLado, DetalheLinha, MetricasAvaliacao, RespostaAvaliacao, Veredito } from '../api';
import type { RegistroAvaliacaoImportado } from '../../../src/inference/avaliacao-jsonl';
import MetricasCard from './MetricasCard.vue';
import ComparacaoLinhas from './ComparacaoLinhas.vue';
import GraficosAvaliacao from './GraficosAvaliacao.vue';
import TemposAvaliacao from './TemposAvaliacao.vue';
import TempoGeracaoPlanos from './TempoGeracaoPlanos.vue';
import AvaliacaoLLM from './AvaliacaoLLM.vue';
import NavegacaoResultado, { type AbaResultado } from './NavegacaoResultado.vue';

const props = defineProps<{ registros: RegistroAvaliacaoImportado[]; nomeArquivo: string }>();
const emit = defineEmits<{ novaAnalise: [] }>();

function metricasDoLado(registros: RegistroAvaliacaoImportado[]): MetricasAvaliacao {
    const m: MetricasAvaliacao = {
        total: 0,
        sintaxe: { VALID: 0, INVALID: 0 },
        semantica: { VALID: 0, INVALID: 0, UNRESOLVED: 0, NOT_EVALUATED: 0 },
        oraculo: { VALID: 0, INVALID: 0, UNRESOLVED: 0 },
        juiz: { VALID: 0, INVALID: 0, UNRESOLVED: 0, NOT_CALLED: 0, NO_RESPONSE: 0 },
        concordantes: 0, discordantes: 0, pares: {}, violacoes: 0
    };
    for (const r of registros) {
        if (r.naoAvaliado || !r.oraculo) continue;
        m.total++;
        if (r.validacaoSintatica?.veredito === 'VALID' || r.validacaoSintatica?.veredito === 'INVALID') m.sintaxe[r.validacaoSintatica.veredito]++;
        const semantica = r.validacaoSemantica?.veredito;
        if (semantica === 'VALID' || semantica === 'INVALID' || semantica === 'UNRESOLVED' || semantica === 'NOT_EVALUATED') m.semantica[semantica]++;
        const oraculo = r.oraculo.veredito;
        if (oraculo === 'VALID' || oraculo === 'INVALID' || oraculo === 'UNRESOLVED') m.oraculo[oraculo]++;
        const juiz = r.julgamentoLLM?.status;
        if (juiz === 'VALID' || juiz === 'INVALID' || juiz === 'UNRESOLVED' || juiz === 'NOT_CALLED' || juiz === 'NO_RESPONSE') m.juiz[juiz]++;
        if (r.violacao === true) m.violacoes++;
        if (r.concordancia !== undefined) {
            r.concordancia ? m.concordantes++ : m.discordantes++;
            if (juiz) {
                const par = `${oraculo}+${juiz}`;
                m.pares[par] = (m.pares[par] ?? 0) + 1;
            }
        }
    }
    return m;
}

function detalhe(r: RegistroAvaliacaoImportado): DetalheLado {
    return {
        ...(r as unknown as Partial<DetalheLado>),
        plano: r.plano ?? '',
        naoAvaliado: r.naoAvaliado ?? false,
        validacaoSintatica: r.validacaoSintatica as unknown as DetalheLado['validacaoSintatica'],
        ast: r.ast as unknown as DetalheLado['ast'],
        validacaoSemantica: r.validacaoSemantica as unknown as DetalheLado['validacaoSemantica'],
        oraculo: r.oraculo as unknown as DetalheLado['oraculo'],
        julgamentoLLM: r.julgamentoLLM as unknown as DetalheLado['julgamentoLLM'],
        concordancia: r.concordancia,
        classificacao: r.classificacao as DetalheLado['classificacao'],
        tempos: r.tempos as DetalheLado['tempos']
    };
}

/** O total gravado no arquivo; sem ele (JSONL com `tempos` por plano), a soma dos tempos dos planos. */
function totalDoArquivo(
    campo: 'tempoSintaxeSegundos' | 'tempoOraculoSegundos' | 'tempoLlmJudgeSegundos',
    porPlano: 'sintaxeMs' | 'oraculoMs' | 'llmJudgeMs'
): number | undefined {
    const gravado = props.registros.find(r => typeof r[campo] === 'number')?.[campo];
    if (typeof gravado === 'number') return gravado;
    const medidos = props.registros.map(r => r.tempos?.[porPlano]).filter((v): v is number => typeof v === 'number');
    return medidos.length ? Math.round(medidos.reduce((a, b) => a + b, 0) / 10) / 100 : undefined;
}

/** Os tempos de GERAÇÃO (ver tempos-lote.ts) só existem como agregado repetido
 *  por registro (`registrosJsonl`) — sem sub-objeto por plano para recalcular
 *  como em `totalDoArquivo`. Ausente no arquivo: fica ausente aqui também. */
function totalDoArquivoGeracao(
    campo: 'tempoGeracaoTotalSegundos' | 'tempoGeracaoSequenciasSegundos' | 'tempoGeracaoPIsValidasSegundos' | 'tempoGeracaoValidacaoPlanosSegundos'
): number | undefined {
    const gravado = props.registros.find(r => typeof r[campo] === 'number')?.[campo];
    return typeof gravado === 'number' ? gravado : undefined;
}

const resposta = computed<RespostaAvaliacao>(() => {
    const grupos = new Map<number, DetalheLinha>();
    props.registros.forEach((registro, indice) => {
        const numero = registro.linha ?? indice + 1;
        const linha = grupos.get(numero) ?? { linha: numero, intencao: registro.intencao ?? '', temDivergencia: false, temDiscordancia: false };
        const lado = registro.lado;
        if (lado === 'arquitetura' || lado === 'baseline') {
            linha[lado] = detalhe(registro);
            linha.temDivergencia ||= registro.violacao === true || (registro.oraculo?.veredito !== undefined && registro.oraculo.veredito !== 'VALID');
            linha.temDiscordancia ||= registro.concordancia === false || registro.classificacao === 'DISCORDANCIA_LLM';
        }
        grupos.set(numero, linha);
    });
    const linhas = [...grupos.values()].sort((a, b) => a.linha - b.linha);
    const arquitetura = props.registros.filter(r => r.lado === 'arquitetura');
    const baseline = props.registros.filter(r => r.lado === 'baseline');
    return {
        arquitetura: arquitetura.length ? metricasDoLado(arquitetura) : undefined,
        baseline: baseline.length ? metricasDoLado(baseline) : undefined,
        naoAvaliados: props.registros.filter(r => r.naoAvaliado === true).length,
        linhas,
        arquivoJsonl: props.nomeArquivo,
        tempoTotalSegundos: props.registros.find(r => typeof r.tempoTotalSegundos === 'number')?.tempoTotalSegundos,
        tempoSintaxeSegundos: totalDoArquivo('tempoSintaxeSegundos', 'sintaxeMs'),
        tempoOraculoSegundos: totalDoArquivo('tempoOraculoSegundos', 'oraculoMs'),
        tempoLlmJudgeSegundos: totalDoArquivo('tempoLlmJudgeSegundos', 'llmJudgeMs'),
        // Tempos de GERAÇÃO: diferente dos de cima, não há sub-objeto por plano
        // para recalcular — são repetidos em todo registro quando o servidor os
        // agregou (registrosJsonl). Sem o campo, fica ausente: nada é inventado.
        tempoGeracaoTotalSegundos: totalDoArquivoGeracao('tempoGeracaoTotalSegundos'),
        tempoGeracaoSequenciasSegundos: totalDoArquivoGeracao('tempoGeracaoSequenciasSegundos'),
        tempoGeracaoPIsValidasSegundos: totalDoArquivoGeracao('tempoGeracaoPIsValidasSegundos'),
        tempoGeracaoValidacaoPlanosSegundos: totalDoArquivoGeracao('tempoGeracaoValidacaoPlanosSegundos')
    };
});

// Qual seção do resultado aparece (só estado local). "Todas" mostra as outras, uma abaixo da outra.
const aba = ref<AbaResultado>('todas');

/** O JSONL experimental é gravado por domínio (`gravarAvaliacao`): o domínio vem dos próprios registros. */
const dominioDoArquivo = computed(() => props.registros.find(r => typeof r.dominio === 'string')?.dominio);
const mostra = (a: AbaResultado): boolean => aba.value === 'todas' || aba.value === a;

function veredito(valor: unknown): valor is Veredito {
    return valor === 'VALID' || valor === 'INVALID' || valor === 'UNRESOLVED';
}
</script>

<template>
    <div class="w-full">
        <header class="mb-8 flex flex-wrap items-center justify-between gap-4">
            <div class="flex items-center gap-3.5">
                <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500/15 via-teal-400/15 to-cyan-400/15 text-emerald-600 dark:text-emerald-400">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M8 12.5l3 3 5-6" />
                    </svg>
                </div>
                <div><h1 class="text-2xl font-medium text-neutral-900 dark:text-neutral-100">Resultado da avaliação</h1><p class="text-sm text-neutral-500 dark:text-neutral-400">Resultado importado · {{ registros.length }} registros · {{ nomeArquivo }}</p></div>
            </div>
            <button type="button" class="rounded-full border border-neutral-200 px-4 py-2.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/10" @click="emit('novaAnalise')">Fazer nova análise</button>
        </header>

        <NavegacaoResultado v-model="aba" />

        <p v-if="resposta.naoAvaliados > 0" class="mb-6 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">{{ resposta.naoAvaliados }} registro(s) não foram avaliados no arquivo original.</p>
        <div class="flex flex-col gap-10 w-screen max-w-full">
            <div v-show="mostra('metricas')" class="animate-fade-in-up">
                <div class="grid gap-4" :class="resposta.arquitetura && resposta.baseline ? 'lg:grid-cols-2' : 'grid-cols-1'">
                    <MetricasCard v-if="resposta.arquitetura" variante="arquitetura" :metricas="resposta.arquitetura" :comparar="resposta.baseline" />
                    <MetricasCard v-if="resposta.baseline" variante="baseline" :metricas="resposta.baseline" />
                </div>
            </div>
            <div v-show="mostra('analise')" class="animate-fade-in-up">
                <ComparacaoLinhas v-if="resposta.linhas.length" :linhas="resposta.linhas" :mostrar-arquitetura="!!resposta.arquitetura" :mostrar-baseline="!!resposta.baseline" />
            </div>
            <div v-show="mostra('graficos')" class="animate-fade-in-up">
                <GraficosAvaliacao :arquitetura="resposta.arquitetura" :baseline="resposta.baseline" />
            </div>
            <div v-show="mostra('avaliacaoLlm')" class="animate-fade-in-up">
                <AvaliacaoLLM :resposta="resposta" :dominio="dominioDoArquivo" />
            </div>
            <div v-show="mostra('tempo')" class="animate-fade-in-up flex flex-col gap-6">
                <TempoGeracaoPlanos :resposta="resposta" origem="importacao" />
                <TemposAvaliacao :resposta="resposta" origem="importacao" />
            </div>
        </div>
        <!-- 
        <details v-for="(registro, indice) in registros" :key="`${registro.lado}-${registro.linha}-${indice}`" class="mt-3 rounded-xl border border-neutral-200 px-4 py-3 dark:border-white/10">
            <summary class="cursor-pointer text-sm font-medium text-neutral-700 dark:text-neutral-200">Linha {{ registro.linha ?? indice + 1 }} · {{ registro.lado ?? 'resultado' }} · Oráculo {{ veredito(registro.oraculo?.veredito) ? registro.oraculo?.veredito : 'não informado' }} · Judge {{ statusJuiz(registro.julgamentoLLM?.status) ? (registro.julgamentoLLM?.status === 'NOT_CALLED' ? 'não executado' : registro.julgamentoLLM?.status) : 'não informado' }}</summary>
            <div class="mt-3 grid gap-3 text-xs sm:grid-cols-2"><p><span class="text-neutral-400">Intenção: </span>{{ registro.intencao ?? 'Não informada' }}</p><p><span class="text-neutral-400">Sujeito: </span>{{ registro.sujeito ?? 'Não informado' }}</p><p><span class="text-neutral-400">Sintaxe: </span>{{ registro.validacaoSintatica?.veredito ?? 'Não informada' }}</p><p><span class="text-neutral-400">Semântica: </span>{{ registro.validacaoSemantica?.veredito ?? 'Não informada' }}</p><p><span class="text-neutral-400">Tempo do Oráculo: </span>{{ registro.tempos?.oraculoMs == null ? 'Não informado' : `${registro.tempos.oraculoMs} ms` }}</p><p><span class="text-neutral-400">Tempo do Judge: </span>{{ registro.tempos?.llmJudgeMs == null ? (registro.julgamentoLLM?.status === 'NOT_CALLED' ? 'Não executado' : 'Não informado') : `${registro.tempos.llmJudgeMs} ms` }}</p></div>
            <pre class="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-50 p-3 font-mono text-xs text-neutral-700 dark:bg-black/20 dark:text-neutral-300">{{ registro.plano ?? 'Plano não informado' }}</pre>
            <details v-if="registro.ast" class="mt-2"><summary class="cursor-pointer text-xs text-neutral-500">AST</summary><pre class="mt-2 max-h-72 overflow-auto rounded-lg bg-neutral-50 p-3 font-mono text-[11px] dark:bg-black/20">{{ JSON.stringify(registro.ast, null, 2) }}</pre></details>
        </details>
        -->
    </div>
</template>
