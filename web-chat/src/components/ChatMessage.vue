<script setup lang="ts">
import { computed } from 'vue';
import type { Mensagem } from '../types';

const props = defineProps<{ mensagem: Mensagem }>();

const idSorteio = computed(() => {
    const s = props.mensagem.resposta?.sorteio;
    if (!s) return null;
    return (s.paciente as string | undefined) ?? (s.talhao as string | undefined) ?? null;
});

const telemetriaResumo = computed(() => {
    const t = props.mensagem.resposta?.sorteio?.telemetria as Record<string, number> | undefined;
    if (!t) return '';
    return Object.entries(t)
        .map(([k, v]) => `${k}=${v}`)
        .join('  ');
});

const foco = computed(() => props.mensagem.resposta?.foco);

function baixar(): void {
    const r = props.mensagem.resposta;
    if (!r) return;

    const linhas: string[] = [];
    linhas.push(`Dominio: ${props.mensagem.dominio === 'med' ? 'Clinico (UTI)' : 'Agricola (drone)'}`);
    linhas.push(`Comando: ${props.mensagem.texto ?? ''}`);
    linhas.push('');
    if (idSorteio.value) linhas.push(`Sorteado: ${idSorteio.value} — ${telemetriaResumo.value}`);
    linhas.push('');
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
    linhas.push(r.resultado ?? '');
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
                <div v-if="mensagem.carregando" class="flex items-center gap-2.5 py-2">
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
                            <span v-if="idSorteio" class="rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-600 dark:border dark:border-white/10 dark:bg-white/10 dark:text-neutral-300 dark:backdrop-blur-md">{{ idSorteio }}</span>
                            <span v-if="telemetriaResumo" class="rounded-full bg-neutral-100 px-3 py-1 font-mono text-xs text-neutral-600 dark:border dark:border-white/10 dark:bg-white/10 dark:text-neutral-300 dark:backdrop-blur-md">{{ telemetriaResumo }}</span>
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

                        <details v-if="mensagem.resposta.promptSemantico" class="mb-2.5 rounded-2xl border border-neutral-200 px-4 py-2.5 dark:border-white/10 dark:bg-white/5 dark:backdrop-blur-md">
                            <summary class="cursor-pointer text-sm font-medium text-neutral-500 dark:text-neutral-400">Prompt Semântico (recuperado do grafo)</summary>
                            <pre class="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-xl bg-neutral-50 p-3.5 font-mono text-xs leading-relaxed text-neutral-700 dark:border dark:border-white/10 dark:bg-black/20 dark:text-neutral-300">{{ mensagem.resposta.promptSemantico }}</pre>
                        </details>

                        <details
                            v-if="foco && (foco.farmacos?.length || foco.protocolos?.length || foco.produtos?.length || foco.culturas?.length)"
                            class="mb-2.5 rounded-2xl border border-neutral-200 px-4 py-2.5 dark:border-white/10 dark:bg-white/5 dark:backdrop-blur-md"
                        >
                            <summary class="cursor-pointer text-sm font-medium text-neutral-500 dark:text-neutral-400">Foco recuperado por embedding</summary>
                            <p class="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400" v-if="foco.farmacos">farmacos: {{ foco.farmacos.join(', ') || '—' }}</p>
                            <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400" v-if="foco.protocolos">protocolos: {{ foco.protocolos.join(', ') || '—' }}</p>
                            <p class="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400" v-if="foco.produtos">produtos: {{ foco.produtos.join(', ') || '—' }}</p>
                            <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400" v-if="foco.culturas">culturas: {{ foco.culturas.join(', ') || '—' }}</p>
                        </details>

                        <pre class="my-2 overflow-x-auto whitespace-pre-wrap break-words rounded-2xl border border-neutral-200 bg-neutral-50 p-4 font-mono text-[13px] leading-relaxed text-neutral-800 dark:border-white/10 dark:bg-black/20 dark:text-neutral-200 dark:shadow-lg dark:shadow-black/10 dark:backdrop-blur-md">{{ mensagem.resposta.resultado }}</pre>

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
