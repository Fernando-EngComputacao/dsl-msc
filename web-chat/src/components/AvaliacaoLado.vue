<script setup lang="ts">
import { computed } from 'vue';
import type { DetalheLado } from '../api';
import { ROTULO, posicao, tomDoLado, rotuloVeredicto } from '../avaliacao';

/** Um lado (arquitetura ou baseline) de uma linha avaliada. O resultado
 *  normativo é o do ORÁCULO (sintaxe + semântica determinística); o LLM Judge
 *  aparece à parte, como avaliação experimental — nunca como resultado final. */
const props = defineProps<{
    lado?: DetalheLado;
    titulo: string;
    variante: 'arquitetura' | 'baseline';
}>();

const tom = computed(() => tomDoLado(props.lado));

const astFormatado = computed(() => (props.lado?.ast === undefined ? '' : JSON.stringify(props.lado.ast, null, 2)));

const FONTE: Record<string, string> = {
    gramatica: 'G (/verify)',
    parser: 'parser da DSL',
    ligacao: 'ligação de referências',
    artefato: 'artefato'
};

const ETAPA: Record<string, string> = {
    gramatica_da_politica: 'L(Ĝ) da política',
    sequencia: 'sequência',
    pis: 'PIs',
    global: 'plano global',
    conhecimento: 'conhecimento'
};

const CLASSIFICACAO: Record<string, string> = {
    VALIDO_PELO_ORACULO: 'válido pelo oráculo',
    INVALIDO_PELO_ORACULO: 'inválido pelo oráculo',
    UNRESOLVIDO_PELO_ORACULO: 'indeterminado pelo oráculo',
    DISCORDANCIA_LLM: 'discordância do LLM'
};

const BORDA: Record<string, string> = {
    neutro: 'border-neutral-200 bg-neutral-50/60 dark:border-white/10 dark:bg-white/[0.03]',
    valido: 'border-emerald-200 bg-white dark:border-emerald-500/25 dark:bg-white/5',
    invalido: 'border-rose-200 bg-rose-50/50 dark:border-rose-500/25 dark:bg-rose-500/[0.06]',
    indeterminado: 'border-sky-200 bg-sky-50/50 dark:border-sky-500/25 dark:bg-sky-500/[0.06]'
};

const PILL: Record<string, string> = {
    neutro: 'bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-400',
    valido: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400',
    invalido: 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300',
    indeterminado: 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300'
};

const COR: Record<string, string> = {
    VALID: 'text-emerald-600 dark:text-emerald-400',
    INVALID: 'text-rose-600 dark:text-rose-400',
    UNRESOLVED: 'text-sky-600 dark:text-sky-400',
    NOT_EVALUATED: 'text-neutral-400 dark:text-neutral-500',
    NOT_CALLED: 'text-neutral-400 dark:text-neutral-500',
    NO_RESPONSE: 'text-neutral-400 dark:text-neutral-500'
};

const BLOCO = 'min-w-0 rounded-lg border border-neutral-200 bg-white/70 p-2.5 dark:border-white/10 dark:bg-black/10';
const GRUPO = 'mb-1 text-[10px] font-semibold tracking-wide text-neutral-400 uppercase dark:text-neutral-500';
</script>

<template>
    <div class="flex min-w-0 flex-col rounded-xl border p-3" :class="BORDA[tom]">
        <div class="mb-2 flex items-center gap-1.5">
            <svg v-if="variante === 'arquitetura'" width="13" height="13" viewBox="0 0 24 24" class="shrink-0 text-blue-500 dark:text-blue-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <svg v-else width="13" height="13" viewBox="0 0 24 24" class="shrink-0 text-neutral-500 dark:text-neutral-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="4" y="4" width="16" height="16" rx="2" />
                <rect x="9" y="9" width="6" height="6" />
            </svg>
            <span class="text-xs font-semibold tracking-wide text-neutral-500 uppercase dark:text-neutral-400">{{ titulo }}</span>
            <span v-if="lado" class="ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium" :class="PILL[tom]">
                {{ rotuloVeredicto(lado) }}
            </span>
        </div>

        <template v-if="lado">
            <pre class="max-h-72 overflow-auto rounded-lg bg-neutral-50 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-neutral-700 dark:bg-black/20 dark:text-neutral-300">{{ lado.plano || '(plano vazio)' }}</pre>

            <p v-if="lado.naoAvaliado" class="mt-2 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">{{ lado.motivo }}</p>

            <template v-else-if="lado.oraculo && lado.validacaoSintatica && lado.validacaoSemantica && lado.julgamentoLLM">
                <!-- Resultado: o oráculo é o normativo; o juiz vem depois, marcado como experimental. -->
                <section class="mt-2 rounded-lg border p-2.5" :class="BORDA[tom]">
                    <p :class="GRUPO">Resultado</p>
                    <div class="grid gap-x-4 gap-y-0.5 text-[11px] sm:grid-cols-3">
                        <p>
                            <span class="text-neutral-500 dark:text-neutral-400">Oráculo (normativo):</span>
                            <span class="font-semibold" :class="COR[lado.oraculo.veredito]"> {{ ROTULO[lado.oraculo.veredito] }}</span>
                        </p>
                        <p>
                            <span class="text-neutral-500 dark:text-neutral-400">LLM Judge (experimental):</span>
                            <span class="font-medium" :class="COR[lado.julgamentoLLM.status]"> {{ ROTULO[lado.julgamentoLLM.status] }}</span>
                        </p>
                        <p>
                            <span class="text-neutral-500 dark:text-neutral-400">Classificação:</span>
                            <span class="font-mono text-neutral-700 dark:text-neutral-200"> {{ lado.classificacao }}</span>
                            <span class="text-neutral-400 dark:text-neutral-500"> ({{ CLASSIFICACAO[lado.classificacao!] }})</span>
                        </p>
                    </div>
                    <p v-if="lado.concordancia === false" class="mt-1.5 flex items-start gap-1.5 rounded bg-amber-100/70 px-2 py-1 text-[11px] text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
                        <span aria-hidden="true">⚠</span>
                        <span>O LLM Judge discorda do oráculo. O resultado do sistema continua sendo o do oráculo; a opinião do juiz fica registrada para comparação.</span>
                    </p>
                </section>

                <!-- Validação determinística -->
                <p class="mt-3" :class="GRUPO">Validação determinística</p>
                <div class="grid gap-2">
                    <section :class="BLOCO">
                        <div class="flex flex-wrap items-baseline gap-x-2">
                            <p class="text-[11px] text-neutral-500 dark:text-neutral-400">1. Sintaxe</p>
                            <p class="text-sm font-semibold" :class="COR[lado.validacaoSintatica.veredito]">{{ ROTULO[lado.validacaoSintatica.veredito] }}</p>
                            <p class="text-[10px] text-neutral-400 dark:text-neutral-500">
                                DSL · G (/verify){{ lado.validacaoSintatica.pecas ? ` ${lado.validacaoSintatica.pecas.gramatica.toLowerCase()}` : '' }}
                                · parser Langium{{ lado.validacaoSintatica.pecas ? ` ${lado.validacaoSintatica.pecas.parser.toLowerCase()}` : '' }}
                            </p>
                        </div>
                        <ul v-if="lado.validacaoSintatica.erros.length > 0" class="mt-1 space-y-1 text-[11px] leading-relaxed text-rose-700 dark:text-rose-300">
                            <li v-for="(e, i) in lado.validacaoSintatica.erros" :key="i">
                                <span class="font-mono">{{ e.codigo }}</span>
                                <span class="text-neutral-500 dark:text-neutral-400"> · {{ FONTE[e.fonte] ?? e.fonte }}</span>
                                <span v-if="posicao(e)" class="text-neutral-500 dark:text-neutral-400"> · {{ posicao(e) }}</span>
                                <span v-if="e.regra" class="text-neutral-500 dark:text-neutral-400"> · regra {{ e.regra }}</span>
                                <span v-if="e.campo" class="text-neutral-500 dark:text-neutral-400"> · campo {{ e.campo }}</span>
                                <br />{{ e.mensagem }}
                                <span v-if="e.encontrado !== undefined" class="text-neutral-500 dark:text-neutral-400"> (encontrado: {{ e.encontrado }})</span>
                                <span v-if="e.esperado?.length" class="text-neutral-500 dark:text-neutral-400"> — esperado: {{ e.esperado.join(', ') }}</span>
                            </li>
                        </ul>
                    </section>

                    <section :class="BLOCO">
                        <div class="flex flex-wrap items-baseline gap-x-2">
                            <p class="text-[11px] text-neutral-500 dark:text-neutral-400">AST</p>
                            <p class="text-[11px] font-medium text-neutral-700 dark:text-neutral-200">{{ lado.ast ? `${lado.ast.$type} ${lado.ast.name ?? ''}` : 'ausente (sem sintaxe válida)' }}</p>
                        </div>
                        <details v-if="astFormatado" class="mt-1">
                            <summary class="cursor-pointer text-[11px] text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300">AST oficial — o mesmo objeto que a semântica leu</summary>
                            <pre class="mt-1 max-h-56 overflow-auto rounded bg-neutral-50 p-2 font-mono text-[10px] whitespace-pre-wrap text-neutral-600 dark:bg-black/20 dark:text-neutral-400">{{ astFormatado }}</pre>
                        </details>
                    </section>

                    <section :class="BLOCO">
                        <div class="flex flex-wrap items-baseline gap-x-2">
                            <p class="text-[11px] text-neutral-500 dark:text-neutral-400">2. Semântica</p>
                            <p class="text-sm font-semibold" :class="COR[lado.validacaoSemantica.veredito]">{{ ROTULO[lado.validacaoSemantica.veredito] }}</p>
                            <p class="text-[10px] text-neutral-400 dark:text-neutral-500">sobre o AST · validadores da geração</p>
                        </div>
                        <p v-if="lado.validacaoSemantica.motivo" class="text-[11px] text-neutral-500 dark:text-neutral-400">{{ lado.validacaoSemantica.motivo }}</p>
                        <ul v-if="lado.validacaoSemantica.etapas.length > 0" class="mt-1 space-y-0.5 text-[11px] text-neutral-600 dark:text-neutral-300">
                            <li v-for="e in lado.validacaoSemantica.etapas" :key="e.etapa">
                                <span :class="COR[e.veredito]" class="font-medium">{{ ROTULO[e.veredito] }}</span>
                                · {{ ETAPA[e.etapa] }} <span class="text-[10px] text-neutral-400 dark:text-neutral-500">({{ e.validador }})</span>
                                <span v-if="e.motivo" class="text-[10px] text-neutral-400 dark:text-neutral-500"> — {{ e.motivo }}</span>
                            </li>
                        </ul>
                        <ul v-if="lado.validacaoSemantica.erros.length > 0" class="mt-1 space-y-1 text-[11px] leading-relaxed text-rose-700 dark:text-rose-300">
                            <li v-for="(e, i) in lado.validacaoSemantica.erros" :key="i">
                                <span class="font-mono">{{ e.codigo }}</span>
                                <span class="text-neutral-500 dark:text-neutral-400"> · {{ ETAPA[e.etapa] ?? e.etapa }}</span>: {{ e.mensagem }}
                            </li>
                        </ul>
                        <p v-if="lado.validacaoSemantica.dadosFaltantes.length > 0" class="mt-1 text-[11px] leading-relaxed text-sky-700 dark:text-sky-300">
                            Falta para concluir (não é prova de invalidade): {{ lado.validacaoSemantica.dadosFaltantes.join('; ') }}
                        </p>
                        <details v-if="lado.validacaoSemantica.avisos.length > 0" class="mt-1">
                            <summary class="cursor-pointer text-[11px] text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300">
                                {{ lado.validacaoSemantica.avisos.length }} aviso(s)
                            </summary>
                            <ul class="mt-1 space-y-1 text-[10px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                                <li v-for="(a, i) in lado.validacaoSemantica.avisos" :key="i">{{ ETAPA[a.etapa] ?? a.etapa }} · {{ a.codigo }}: {{ a.mensagem }}</li>
                            </ul>
                        </details>
                        <details v-if="lado.validacaoSemantica.naoFormalizado.length > 0" class="mt-1">
                            <summary class="cursor-pointer text-[11px] text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300">
                                {{ lado.validacaoSemantica.naoFormalizado.length }} texto(s) não formalizado(s) — evidência, não critério
                            </summary>
                            <ul class="mt-1 space-y-1 text-[10px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                                <li v-for="(t, i) in lado.validacaoSemantica.naoFormalizado" :key="i">{{ t }}</li>
                            </ul>
                        </details>
                    </section>

                    <section :class="BLOCO">
                        <div class="flex flex-wrap items-baseline gap-x-2">
                            <p class="text-[11px] text-neutral-500 dark:text-neutral-400">3. Oráculo</p>
                            <p class="text-sm font-semibold" :class="COR[lado.oraculo.veredito]">{{ ROTULO[lado.oraculo.veredito] }}</p>
                            <p class="text-[10px] text-neutral-400 dark:text-neutral-500">decidido pela {{ lado.oraculo.origem === 'sintaxe' ? 'sintaxe' : 'semântica' }}</p>
                        </div>
                    </section>
                </div>

                <!-- Avaliação experimental -->
                <p class="mt-3" :class="GRUPO">Avaliação experimental</p>
                <section :class="BLOCO">
                    <div class="flex flex-wrap items-baseline gap-x-2">
                        <p class="text-[11px] text-neutral-500 dark:text-neutral-400">LLM Judge</p>
                        <p class="text-sm font-semibold" :class="COR[lado.julgamentoLLM.status]">{{ ROTULO[lado.julgamentoLLM.status] }}</p>
                        <p class="text-[10px] text-neutral-400 dark:text-neutral-500">independente (/validar-plano) — não altera o oráculo</p>
                    </div>
                    <p v-if="lado.julgamentoLLM.justificativa" class="mt-1 text-[11px] leading-relaxed text-neutral-600 dark:text-neutral-300">{{ lado.julgamentoLLM.justificativa }}</p>
                    <p v-if="lado.julgamentoLLM.motivo" class="mt-1 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">{{ lado.julgamentoLLM.motivo }}</p>
                    <ul v-if="lado.julgamentoLLM.evidencias?.length" class="mt-1 list-disc space-y-0.5 pl-4 text-[10px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                        <li v-for="(e, i) in lado.julgamentoLLM.evidencias" :key="i">{{ e }}</li>
                    </ul>
                    <details v-if="lado.julgamentoLLM.respostaBruta" class="mt-1.5">
                        <summary class="cursor-pointer text-[11px] text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300">Resposta bruta</summary>
                        <pre class="mt-1 max-h-40 overflow-auto rounded bg-neutral-50 p-2 font-mono text-[10px] whitespace-pre-wrap text-neutral-600 dark:bg-black/20 dark:text-neutral-400">{{ lado.julgamentoLLM.respostaBruta }}</pre>
                    </details>
                </section>

                <details v-if="lado.contextoGrafo" class="mt-2">
                    <summary class="cursor-pointer text-[11px] text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300">Contexto recuperado do grafo (o mesmo para a semântica e para o juiz)</summary>
                    <pre class="mt-1.5 max-h-56 overflow-auto rounded-lg bg-neutral-50 p-2.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-neutral-600 dark:bg-black/20 dark:text-neutral-400">{{ lado.contextoGrafo }}</pre>
                </details>
            </template>
        </template>
        <p v-else class="rounded-lg bg-neutral-50 p-2.5 text-[11px] text-neutral-400 dark:bg-black/20 dark:text-neutral-500">Sem registro para esta linha no arquivo enviado.</p>
    </div>
</template>
