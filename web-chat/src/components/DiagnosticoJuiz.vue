<script setup lang="ts">
import { computed } from 'vue';
import type { JulgamentoLLM } from '../api';
import { ROTULO } from '../avaliacao';
import { ROTULO_FORMALIZACAO, vistaDoDiagnostico } from '../diagnostico';

/**
 * Diagnóstico da indeterminação do LLM Judge: por que ele ficou INDETERMINADO,
 * o que falta e sob que condições o plano sustentaria cada resultado. É
 * EXPLICATIVO e experimental — não é decisão do oráculo nem muda o veredito do
 * juiz. Sem diagnóstico (juiz com outro status, avaliação antiga), não aparece.
 * Falha do diagnóstico é um aviso dentro desta seção, nunca um erro da avaliação.
 */
const props = defineProps<{
    julgamento?: JulgamentoLLM;
    /** `tempos.diagnosticoMs` do plano: fora do tempo do juiz. */
    diagnosticoMs?: number;
}>();

const vista = computed(() => vistaDoDiagnostico(props.julgamento));

/** O caminho é condicional: borda tracejada na cor do resultado, nunca a pill cheia de um veredito. */
const CAMINHO: Record<string, string> = {
    VALID: 'border-emerald-300 text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-300',
    INVALID: 'border-rose-300 text-rose-700 dark:border-rose-500/40 dark:text-rose-300',
    UNRESOLVED: 'border-sky-300 text-sky-700 dark:border-sky-500/40 dark:text-sky-300'
};

const SUBTITULO: Record<string, string> = {
    VALID: 'condições que precisariam ser satisfeitas',
    INVALID: 'violação formal que precisaria ser demonstrada',
    UNRESOLVED: 'por que a informação adicional pode não bastar'
};

const SUBGRUPO = 'mb-1 text-[10px] font-semibold tracking-wide text-neutral-500 uppercase dark:text-neutral-400';
const ETIQUETA = 'rounded px-1 py-px text-[9px] font-medium bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-400';
const REFERENCIA = 'font-mono text-[10px] text-neutral-700 dark:text-neutral-200';
const VAZIO = 'text-[11px] text-neutral-400 italic dark:text-neutral-500';
</script>

<template>
    <section
        v-if="vista"
        class="mt-2 rounded-lg border border-dashed border-sky-200 bg-sky-50/40 p-2.5 dark:border-sky-500/25 dark:bg-sky-500/[0.04]"
        aria-label="Diagnóstico da indeterminação do LLM Judge"
        data-diagnostico
        :data-status="vista.status"
    >
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <p class="text-[11px] font-medium text-neutral-700 dark:text-neutral-200">Diagnóstico da indeterminação</p>
            <span class="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-white/10 dark:text-neutral-400">experimental · explicativo</span>
            <span class="text-[10px] text-neutral-400 dark:text-neutral-500">{{ vista.rotuloStatus }}</span>
        </div>
        <p class="mt-1 text-[10px] leading-relaxed text-neutral-500 dark:text-neutral-400">
            Explica por que o LLM Judge ficou <span class="font-medium text-sky-700 dark:text-sky-300">{{ ROTULO.UNRESOLVED }}</span> — e ele continua {{ ROTULO.UNRESOLVED }}.
            Não é decisão do oráculo, não muda nenhum veredito, e os caminhos abaixo são condições, não resultados.
        </p>

        <p
            v-if="vista.aviso"
            class="mt-1.5 rounded bg-neutral-100/80 px-2 py-1 text-[11px] leading-relaxed text-neutral-600 dark:bg-white/[0.06] dark:text-neutral-300"
            data-aviso-diagnostico
        >
            Diagnóstico {{ vista.rotuloStatus }}: {{ vista.aviso }}. O julgamento do juiz e o resultado do oráculo acima não são afetados.
        </p>

        <template v-if="vista.respostaLida">
            <!-- Motivo da indeterminação -->
            <div class="mt-2.5" data-secao="motivo">
                <p :class="SUBGRUPO">Motivo da indeterminação</p>
                <p v-if="vista.motivoIndeterminacao" class="text-[11px] leading-relaxed text-neutral-700 dark:text-neutral-200">{{ vista.motivoIndeterminacao }}</p>
                <p v-else :class="VAZIO">O diagnóstico não trouxe o motivo.</p>
                <ul v-if="vista.regrasAfetadas.length > 0" class="mt-1 space-y-0.5 text-[11px] leading-relaxed text-neutral-600 dark:text-neutral-300">
                    <li v-for="r in vista.regrasAfetadas" :key="r.regra">
                        <span :class="REFERENCIA">{{ r.regra }}</span>
                        <span v-if="r.formalizacao" class="ml-1" :class="ETIQUETA">{{ ROTULO_FORMALIZACAO[r.formalizacao] }}</span>
                        <span v-if="r.motivo"> — {{ r.motivo }}</span>
                    </li>
                </ul>
            </div>

            <!-- Evidências disponíveis -->
            <div class="mt-2.5" data-secao="evidencias">
                <p :class="SUBGRUPO">Evidências disponíveis</p>
                <div v-if="vista.evidencias.length > 0" class="space-y-1">
                    <div v-for="g in vista.evidencias" :key="g.grupo" :data-grupo="g.grupo">
                        <p class="text-[10px] text-neutral-500 dark:text-neutral-400">{{ g.rotulo }}</p>
                        <ul class="list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed text-neutral-600 dark:text-neutral-300">
                            <li v-for="(e, i) in g.itens" :key="i">
                                <span :class="g.grupo === 'observado' || g.grupo === 'conhecimento' ? REFERENCIA : 'italic'">{{ g.grupo === 'observado' || g.grupo === 'conhecimento' ? e.referencia : `“${e.referencia}”` }}</span>
                                <span v-if="e.descricao" class="text-neutral-500 dark:text-neutral-400"> — {{ e.descricao }}</span>
                            </li>
                        </ul>
                    </div>
                </div>
                <p v-else :class="VAZIO">Nenhuma evidência citada.</p>
            </div>

            <!-- O que falta informar -->
            <div class="mt-2.5" data-secao="ausentes">
                <p :class="SUBGRUPO">O que falta informar</p>
                <ul v-if="vista.informacoesAusentes.length > 0" class="space-y-1.5">
                    <li v-for="(x, i) in vista.informacoesAusentes" :key="i" class="text-[11px] leading-relaxed text-neutral-600 dark:text-neutral-300" :data-tipo="x.tipo">
                        <div class="flex flex-wrap items-baseline gap-x-1.5">
                            <span :class="ETIQUETA" :title="x.explicacaoTipo">{{ x.rotuloTipo }}</span>
                            <span class="font-medium text-neutral-700 dark:text-neutral-200">{{ x.referencia }}</span>
                        </div>
                        <p v-if="x.descricao">Por que importa: {{ x.descricao }}</p>
                        <p class="text-[10px] text-neutral-500 dark:text-neutral-400">
                            {{ x.explicacaoTipo }}<template v-if="x.regra">
                                · associado a <span :class="REFERENCIA">{{ x.regra }}</span><template v-if="x.formalizacao"> ({{ ROTULO_FORMALIZACAO[x.formalizacao] }})</template></template>
                        </p>
                    </li>
                </ul>
                <p v-else :class="VAZIO">O diagnóstico não apontou informação específica a registrar.</p>
            </div>

            <!-- Possíveis caminhos: condicionais, separados por resultado -->
            <div class="mt-2.5" data-secao="caminhos">
                <p :class="SUBGRUPO">Possíveis caminhos — condições, não resultados</p>
                <div v-if="vista.caminhos.length > 0" class="grid gap-1.5">
                    <div v-for="c in vista.caminhos" :key="c.resultado" class="rounded border border-dashed bg-white/60 p-2 dark:bg-black/10" :class="CAMINHO[c.resultado]" :data-caminho="c.resultado">
                        <p class="text-[11px] font-medium">
                            {{ c.resultado === 'UNRESOLVED' ? `Permanência em ${ROTULO.UNRESOLVED}` : `Caminho para ${ROTULO[c.resultado]}` }}
                            <span class="ml-1 rounded-full border border-current px-1 text-[9px] font-normal">condicional</span>
                        </p>
                        <p class="text-[10px] text-neutral-500 dark:text-neutral-400">{{ SUBTITULO[c.resultado] }}</p>
                        <ul class="mt-0.5 space-y-1">
                            <li v-for="(item, i) in c.itens" :key="i" class="text-[11px] leading-relaxed text-neutral-700 dark:text-neutral-200">
                                <p>{{ item.condicoes }}</p>
                                <p class="text-[10px] text-neutral-500 dark:text-neutral-400">
                                    <template v-if="item.regras.length > 0">sustentado por <span v-for="(r, j) in item.regras" :key="r"><span :class="REFERENCIA">{{ r }}</span>{{ j < item.regras.length - 1 ? ', ' : '' }}</span></template>
                                    <template v-else>sem regra citada</template>
                                    <span v-if="item.fundamentacao" class="ml-1" :class="ETIQUETA">{{ ROTULO_FORMALIZACAO[item.fundamentacao] }}</span>
                                </p>
                            </li>
                        </ul>
                    </div>
                </div>
                <p v-else :class="VAZIO">Nenhum caminho condicional fundamentado no conhecimento recuperado.</p>
            </div>
        </template>

        <!-- Incertezas e limitações: as do conhecimento valem mesmo quando o diagnóstico falhou -->
        <div v-if="vista.incertezaRemanescente || vista.limitacoesConhecimento.length > 0 || vista.limitacoesModelo.length > 0" class="mt-2.5" data-secao="limitacoes">
            <p :class="SUBGRUPO">Incertezas e limitações</p>
            <p v-if="vista.incertezaRemanescente" class="text-[11px] leading-relaxed text-neutral-700 dark:text-neutral-200">{{ vista.incertezaRemanescente }}</p>
            <div v-if="vista.limitacoesConhecimento.length > 0" class="mt-1">
                <p class="text-[10px] text-neutral-500 dark:text-neutral-400">Do conhecimento recuperado (determinístico)</p>
                <ul class="list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed text-neutral-600 dark:text-neutral-300">
                    <li v-for="(l, i) in vista.limitacoesConhecimento" :key="i">{{ l }}</li>
                </ul>
            </div>
            <div v-if="vista.limitacoesModelo.length > 0" class="mt-1">
                <p class="text-[10px] text-neutral-500 dark:text-neutral-400">Apontadas pelo modelo</p>
                <ul class="list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed text-neutral-600 dark:text-neutral-300">
                    <li v-for="(l, i) in vista.limitacoesModelo" :key="i">{{ l }}</li>
                </ul>
            </div>
        </div>

        <!-- Auditoria -->
        <details v-if="vista.referenciasRejeitadas.length > 0 || vista.respostaBruta || typeof diagnosticoMs === 'number'" class="mt-2" data-secao="auditoria">
            <summary class="cursor-pointer text-[11px] text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300">
                Auditoria do diagnóstico<template v-if="vista.referenciasRejeitadas.length > 0"> · {{ vista.referenciasRejeitadas.length }} referência(s) rejeitada(s)</template>
            </summary>
            <p v-if="typeof diagnosticoMs === 'number'" class="mt-1 text-[10px] text-neutral-500 dark:text-neutral-400">Tempo do diagnóstico: {{ diagnosticoMs }} ms (fora do tempo do LLM Judge)</p>
            <div v-if="vista.referenciasRejeitadas.length > 0" class="mt-1">
                <p class="text-[10px] text-neutral-500 dark:text-neutral-400">Citadas pelo modelo sem apoio no conhecimento recuperado — fora do diagnóstico:</p>
                <ul class="list-disc space-y-0.5 pl-4 text-[10px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                    <li v-for="(r, i) in vista.referenciasRejeitadas" :key="i"><span class="font-mono">{{ r.referencia }}</span><template v-if="r.secao"> ({{ r.secao }})</template><template v-if="r.motivo">: {{ r.motivo }}</template></li>
                </ul>
            </div>
            <template v-if="vista.respostaBruta">
                <p class="mt-1 text-[10px] text-neutral-500 dark:text-neutral-400">Resposta bruta do diagnóstico</p>
                <pre class="mt-0.5 max-h-40 overflow-auto rounded bg-neutral-50 p-2 font-mono text-[10px] whitespace-pre-wrap text-neutral-600 dark:bg-black/20 dark:text-neutral-400">{{ vista.respostaBruta }}</pre>
            </template>
        </details>
    </section>
</template>
