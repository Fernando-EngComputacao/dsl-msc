<script setup lang="ts">
import { computed } from 'vue';
import type { Mensagem } from '../types';
import CopyButton from './CopyButton.vue';

const props = defineProps<{ mensagem: Mensagem }>();

const idSorteio = computed(() => {
    const s = props.mensagem.resposta?.sorteio;
    if (!s) return null;
    return (
        (s.paciente as string | undefined) ??
        (s.talhao as string | undefined) ??
        (s.partida as string | undefined) ??
        null
    );
});

/** Bloco completo (comando + paciente/talhão + telemetria + populações/áreas +
 *  fármacos/produtos em uso) — usado tanto pra exibir no painel expansível
 *  quanto pro botão de copiar e pro download. */
const dadosTelemetriaTexto = computed(() => {
    const s = props.mensagem.resposta?.sorteio;
    if (!s) return '';

    const linhas: string[] = [];
    linhas.push(`Comando digitado: ${props.mensagem.texto ?? ''}`);

    if (s.paciente) linhas.push(`Paciente: ${s.paciente}`);
    else if (s.talhao) linhas.push(`Talhão: ${s.talhao}`);
    else if (s.partida) linhas.push(`Partida: ${s.partida}`);

    const telemetria = s.telemetria as Record<string, number> | undefined;
    if (telemetria) {
        linhas.push('Telemetria:');
        for (const [chave, valor] of Object.entries(telemetria)) linhas.push(`  ${chave}: ${valor}`);
    }

    const populacoes = s.populacoes as string[] | undefined;
    if (populacoes?.length) linhas.push(`Populações: ${populacoes.join(', ')}`);
    const areas = s.areas as string[] | undefined;
    if (areas?.length) linhas.push(`Áreas: ${areas.join(', ')}`);
    const contextos = s.contextos as string[] | undefined;
    if (contextos?.length) linhas.push(`Contextos: ${contextos.join(', ')}`);

    const farmacosEmUso = s.farmacosEmUso as string[] | undefined;
    if (farmacosEmUso?.length) linhas.push(`Fármacos em uso: ${farmacosEmUso.join(', ')}`);
    const produtosEmUso = s.produtosEmUso as string[] | undefined;
    if (produtosEmUso?.length) linhas.push(`Produtos em uso: ${produtosEmUso.join(', ')}`);
    const infracoesEmUso = s.infracoesEmUso as string[] | undefined;
    if (infracoesEmUso?.length) linhas.push(`Infrações marcadas: ${infracoesEmUso.join(', ')}`);

    return linhas.join('\n');
});

const foco = computed(() => props.mensagem.resposta?.foco);

const focoTexto = computed(() => {
    const f = foco.value;
    if (!f) return '';
    const linhas: string[] = [];
    if (f.farmacos) linhas.push(`farmacos: ${f.farmacos.join(', ') || '—'}`);
    if (f.protocolos) linhas.push(`protocolos: ${f.protocolos.join(', ') || '—'}`);
    if (f.produtos) linhas.push(`produtos: ${f.produtos.join(', ') || '—'}`);
    if (f.culturas) linhas.push(`culturas: ${f.culturas.join(', ') || '—'}`);
    if (f.infracoes) linhas.push(`infrações: ${f.infracoes.join(', ') || '—'}`);
    if (f.lances) linhas.push(`lances: ${f.lances.join(', ') || '—'}`);
    return linhas.join('\n');
});

// Campos de 1o nivel do plano/missao/arbitragem (ver PlanCommand/MissionCommand/
// DecisionCommand em dsl.langium, agrodrone.langium e futebol.langium) e os
// sub-campos de cada ordem/aplicacao/marcacao/alerta.
const CAMPOS_TOPO = ['esquema_referencia', 'paciente', 'talhao', 'partida', 'sequencia', 'ordem', 'aplicacao', 'marcacao', 'alerta', 'auditoria'];
const CAMPOS_SUB = ['decisao', 'dose', 'vazao', 'minuto', 'via', 'modo', 'reinicio', 'justificativa', 'regra'];

/**
 * O motor devolve o plano/missao numa unica linha (a gramatica so garante a
 * sintaxe, nao a formatacao). Reformata pra leitura: cada campo de topo numa
 * linha, sub-campos de ordem/aplicacao/alerta indentados. As strings entre
 * aspas simples sao protegidas antes de quebrar linhas — senao uma
 * justificativa que contenha a palavra "dose" ou "via" quebraria no lugar errado.
 */
function formatarPlano(bruto: string | undefined): string {
    if (!bruto) return '';

    const strings: string[] = [];
    const MARCADOR = ''; // Private Use Area — nunca aparece em texto real
    let t = bruto
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/'[^']*'/g, correspondencia => {
            strings.push(correspondencia);
            return `${MARCADOR}${strings.length - 1}${MARCADOR}`;
        });

    t = t.replace(/\s*\{\s*/, ' {\n    ').replace(/\s*\}\s*$/, '\n}');
    t = t.replace(new RegExp(`\\s+(?=(${CAMPOS_TOPO.join('|')})\\b)`, 'g'), '\n    ');
    t = t.replace(new RegExp(`\\s+(?=(${CAMPOS_SUB.join('|')})\\b)`, 'g'), '\n        ');

    return t.replace(new RegExp(`${MARCADOR}(\\d+)${MARCADOR}`, 'g'), (_, indice) => strings[Number(indice)]);
}

const planoFormatado = computed(() => formatarPlano(props.mensagem.resposta?.resultado));

const NOME_DOMINIO: Record<'med' | 'agro' | 'fut', string> = {
    med: 'Clinico (UTI)',
    agro: 'Agricola (drone)',
    fut: 'Arbitragem (futebol)'
};
const NOME_SAIDA: Record<'med' | 'agro' | 'fut', string> = {
    med: 'Plano gerado',
    agro: 'Missão gerada',
    fut: 'Decisão gerada'
};

function baixar(): void {
    const r = props.mensagem.resposta;
    if (!r) return;

    const linhas: string[] = [];
    linhas.push(`Dominio: ${NOME_DOMINIO[props.mensagem.dominio]}`);
    linhas.push('');
    if (dadosTelemetriaTexto.value) {
        linhas.push('=== DADOS TELEMETRICOS ===');
        linhas.push(dadosTelemetriaTexto.value);
        linhas.push('');
    }
    if (r.promptSemantico) {
        linhas.push('=== PROMPT SEMANTICO ===');
        linhas.push(r.promptSemantico);
        linhas.push('');
    }
    if (r.decisoesAdmissiveis?.length) {
        linhas.push(`Decisoes admissiveis: ${r.decisoesAdmissiveis.join(', ')}`);
        linhas.push('');
    }
    linhas.push(`=== RESULTADO (valido: ${r.valido}, ${r.regrasEmGHat} regras em G_hat) ===`);
    linhas.push(planoFormatado.value);
    if (r.erroMotor) {
        linhas.push('');
        linhas.push(`Erro reportado: ${r.erroMotor}`);
    }

    const blob = new Blob([linhas.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `spc-cml-${props.mensagem.dominio}-${props.mensagem.id}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
</script>

<template>
    <div class="mb-6 flex" :class="mensagem.autor === 'usuario' ? 'justify-end' : ''">
        <div
            v-if="mensagem.autor === 'usuario'"
            class="max-w-[75%] whitespace-pre-wrap rounded-3xl bg-neutral-100 px-4.5 py-3 leading-relaxed text-neutral-900 dark:border dark:border-white/10 dark:bg-white/10 dark:text-neutral-100 dark:shadow-lg dark:shadow-black/10 dark:backdrop-blur-md"
        >
            {{ mensagem.texto }}
        </div>

        <div v-else class="flex w-full max-w-full gap-3.5">
            <div
                class="relative mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-100 dark:border dark:border-white/10 dark:bg-white/10 dark:backdrop-blur-md"
            >
                <span
                    v-if="mensagem.carregando"
                    class="absolute inset-0 animate-ping rounded-full bg-gradient-to-br from-blue-400 via-purple-400 to-rose-400 opacity-30"
                ></span>
                <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    class="relative"
                    :class="mensagem.carregando ? 'animate-spin-slow' : ''"
                >
                    <defs>
                        <linearGradient :id="`sparkle-${mensagem.id}`" x1="0" y1="0" x2="24" y2="24">
                            <stop offset="0%" stop-color="#4285f4" />
                            <stop offset="55%" stop-color="#9b72cb" />
                            <stop offset="100%" stop-color="#d96570" />
                        </linearGradient>
                    </defs>
                    <path
                        d="M12 2c.6 4.2 1.2 6.6 2.6 8 1.4 1.4 3.8 2 8 2.6-4.2.6-6.6 1.2-8 2.6-1.4 1.4-2 3.8-2.6 8-.6-4.2-1.2-6.6-2.6-8-1.4-1.4-3.8-2-8-2.6 4.2-.6 6.6-1.2 8-2.6 1.4-1.4 2-3.8 2.6-8z"
                        :fill="`url(#sparkle-${mensagem.id})`"
                    />
                </svg>
            </div>
            <div class="min-w-0 flex-1 pt-0.5">
                <div v-if="mensagem.carregando" class="flex flex-col items-start justify-center gap-2.5 py-2">
                    <span class="flex gap-1">
                        <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 [animation-delay:-0.3s] dark:bg-neutral-500"></span>
                        <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 [animation-delay:-0.15s] dark:bg-neutral-500"></span>
                        <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 dark:bg-neutral-500"></span>
                    </span>
                    <span v-if="mensagem.estagio" class="text-sm text-neutral-500 dark:text-neutral-400">{{ mensagem.estagio }}</span>
                </div>

                <div v-else-if="mensagem.erro" class="rounded-2xl bg-red-50 px-4 py-3 text-sm leading-relaxed text-red-700 dark:border dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400 dark:backdrop-blur-md">
                    {{ mensagem.erro }}
                </div>

                <template v-else-if="mensagem.resposta">
                    <div v-if="!mensagem.resposta.aceito" class="rounded-2xl bg-amber-50 px-4 py-3.5 text-sm leading-relaxed text-amber-800 dark:border dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300 dark:backdrop-blur-md">
                        <strong class="font-medium">Comando não aceito pela validação.</strong>
                        <p class="mt-1">{{ mensagem.resposta.motivoValidacao }}</p>
                    </div>

                    <template v-else>
                        <div class="mb-2.5 flex flex-wrap gap-2">
                            <span
                                class="rounded-full px-3 py-1 text-xs"
                                :class="mensagem.resposta.valido
                                    ? 'bg-emerald-50 text-emerald-700 dark:border dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400 dark:backdrop-blur-md'
                                    : 'bg-red-50 text-red-700 dark:border dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400 dark:backdrop-blur-md'"
                            >
                                {{ mensagem.resposta.valido ? 'válido' : 'inválido' }}
                            </span>
                            <span class="rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-600 dark:border dark:border-white/10 dark:bg-white/10 dark:text-neutral-300 dark:backdrop-blur-md">{{ mensagem.resposta.regrasEmGHat }} regras em G_hat</span>
                        </div>

                        <details v-if="dadosTelemetriaTexto" class="group mb-2.5 rounded-2xl border border-neutral-200 px-4 py-2.5 dark:border-white/10 dark:bg-white/5 dark:backdrop-blur-md">
                            <summary class="flex cursor-pointer items-center justify-between gap-2 text-sm font-medium text-neutral-500 dark:text-neutral-400">
                                <span class="flex min-w-0 items-center gap-1.5">
                                    <svg width="14" height="14" viewBox="0 0 24 24" class="shrink-0 transition-transform duration-200 group-open:rotate-90">
                                        <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                                    </svg>
                                    <span>Dados telemétricos ({{ idSorteio }})</span>
                                </span>
                                <CopyButton :texto="dadosTelemetriaTexto" />
                            </summary>
                            <pre class="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-xl bg-neutral-50 p-3.5 font-mono text-xs leading-relaxed text-neutral-700 dark:border dark:border-white/10 dark:bg-black/20 dark:text-neutral-300">{{ dadosTelemetriaTexto }}</pre>
                        </details>

                        <details v-if="mensagem.resposta.promptSemantico" class="group mb-2.5 rounded-2xl border border-neutral-200 px-4 py-2.5 dark:border-white/10 dark:bg-white/5 dark:backdrop-blur-md">
                            <summary class="flex cursor-pointer items-center justify-between gap-2 text-sm font-medium text-neutral-500 dark:text-neutral-400">
                                <span class="flex min-w-0 items-center gap-1.5">
                                    <svg width="14" height="14" viewBox="0 0 24 24" class="shrink-0 transition-transform duration-200 group-open:rotate-90">
                                        <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                                    </svg>
                                    <span>Prompt Semântico (recuperado do grafo)</span>
                                </span>
                                <CopyButton :texto="mensagem.resposta.promptSemantico" />
                            </summary>
                            <pre class="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-xl bg-neutral-50 p-3.5 font-mono text-xs leading-relaxed text-neutral-700 dark:border dark:border-white/10 dark:bg-black/20 dark:text-neutral-300">{{ mensagem.resposta.promptSemantico }}</pre>
                        </details>

                        <details
                            v-if="foco && (foco.farmacos?.length || foco.protocolos?.length || foco.produtos?.length || foco.culturas?.length || foco.infracoes?.length || foco.lances?.length)"
                            class="group mb-2.5 rounded-2xl border border-neutral-200 px-4 py-2.5 dark:border-white/10 dark:bg-white/5 dark:backdrop-blur-md"
                        >
                            <summary class="flex cursor-pointer items-center justify-between gap-2 text-sm font-medium text-neutral-500 dark:text-neutral-400">
                                <span class="flex min-w-0 items-center gap-1.5">
                                    <svg width="14" height="14" viewBox="0 0 24 24" class="shrink-0 transition-transform duration-200 group-open:rotate-90">
                                        <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                                    </svg>
                                    <span>Foco recuperado por embedding</span>
                                </span>
                                <CopyButton :texto="focoTexto" />
                            </summary>
                            <p class="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400" v-if="foco.farmacos">farmacos: {{ foco.farmacos.join(', ') || '—' }}</p>
                            <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400" v-if="foco.protocolos">protocolos: {{ foco.protocolos.join(', ') || '—' }}</p>
                            <p class="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400" v-if="foco.produtos">produtos: {{ foco.produtos.join(', ') || '—' }}</p>
                            <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400" v-if="foco.culturas">culturas: {{ foco.culturas.join(', ') || '—' }}</p>
                            <p class="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400" v-if="foco.infracoes">infrações: {{ foco.infracoes.join(', ') || '—' }}</p>
                            <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400" v-if="foco.lances">lances: {{ foco.lances.join(', ') || '—' }}</p>
                        </details>

                        <div class="mt-2 mb-1 flex items-center justify-between">
                            <span class="text-sm font-medium text-neutral-500 dark:text-neutral-400">{{ NOME_SAIDA[mensagem.dominio] }}</span>
                            <CopyButton :texto="planoFormatado" />
                        </div>
                        <pre class="mb-2 overflow-x-auto whitespace-pre-wrap break-words rounded-2xl border border-neutral-200 bg-neutral-50 p-4 font-mono text-[13px] leading-relaxed text-neutral-800 dark:border-white/10 dark:bg-black/20 dark:text-neutral-200 dark:shadow-lg dark:shadow-black/10 dark:backdrop-blur-md">{{ planoFormatado }}</pre>

                        <p v-if="mensagem.resposta.erroMotor" class="mt-2.5 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:border dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400 dark:backdrop-blur-md">
                            Erro reportado: {{ mensagem.resposta.erroMotor }}
                        </p>

                        <button
                            type="button"
                            class="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-neutral-200 px-3.5 py-1.5 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:border-white/10 dark:text-neutral-400 dark:backdrop-blur-md dark:hover:bg-white/10 dark:hover:text-neutral-100"
                            @click="baixar"
                        >
                            <svg width="15" height="15" viewBox="0 0 24 24">
                                <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                            </svg>
                            Baixar resposta
                        </button>
                    </template>
                </template>
            </div>
        </div>
    </div>
</template>
