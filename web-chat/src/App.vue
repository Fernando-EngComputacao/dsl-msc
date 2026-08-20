<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import DomainPicker from './components/DomainPicker.vue';
import ChatMessage from './components/ChatMessage.vue';
import { buscarDominios, enviarComando, type Dominio } from './api';
import type { Mensagem } from './types';
import { escuro, iniciarTema, alternarTema } from './theme';

const dominios = ref<Dominio[]>([]);
const dominioAtual = ref<'med' | 'agro'>('med');
const erroCarregamento = ref<string | null>(null);

const mensagens = ref<Mensagem[]>([]);
const textoInput = ref('');
const enviando = ref(false);
const areaMensagens = ref<HTMLElement | null>(null);
let proximoId = 1;

const SUGESTOES: Record<'med' | 'agro', string[]> = {
    med: [
        'A pressão caiu, PAM 52. Sobe a noradrenalina.',
        'Paciente agitado no ventilador, aumenta a sedação.',
        'Glicemia deu 320, inicia insulina em bomba.'
    ],
    agro: [
        'Vento forte mas a janela fecha hoje, manda o glifosato na soja.',
        'NDVI despencou e o talhão fica perto do córrego. Aplica atrazina?',
        'A cana tá com a folha fervendo, começa o imidacloprido.'
    ]
};

const sugestoesAtuais = computed(() => SUGESTOES[dominioAtual.value]);

onMounted(async () => {
    iniciarTema();
    try {
        dominios.value = await buscarDominios();
        if (dominios.value.length > 0) dominioAtual.value = dominios.value[0].id;
    } catch (error) {
        erroCarregamento.value = (error as Error).message;
    }
});

async function rolarParaFinal(): Promise<void> {
    await nextTick();
    if (areaMensagens.value) {
        areaMensagens.value.scrollTop = areaMensagens.value.scrollHeight;
    }
}

async function enviar(textoForcado?: string): Promise<void> {
    const texto = (textoForcado ?? textoInput.value).trim();
    if (!texto || enviando.value) return;

    textoInput.value = '';
    enviando.value = true;

    mensagens.value.push({ id: proximoId++, autor: 'usuario', dominio: dominioAtual.value, texto });
    const idResposta = proximoId++;
    mensagens.value.push({ id: idResposta, autor: 'assistente', dominio: dominioAtual.value, carregando: true });
    rolarParaFinal();

    try {
        const resposta = await enviarComando(dominioAtual.value, texto);
        const alvo = mensagens.value.find(m => m.id === idResposta);
        if (alvo) {
            alvo.carregando = false;
            alvo.resposta = resposta;
            alvo.texto = texto;
        }
    } catch (error) {
        const alvo = mensagens.value.find(m => m.id === idResposta);
        if (alvo) {
            alvo.carregando = false;
            alvo.erro = (error as Error).message;
        }
    } finally {
        enviando.value = false;
        rolarParaFinal();
    }
}

function aoTeclar(evento: KeyboardEvent): void {
    if (evento.key === 'Enter' && !evento.shiftKey) {
        evento.preventDefault();
        enviar();
    }
}
</script>

<template>
    <div class="flex h-screen flex-col bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
        <header class="flex items-center justify-between border-b border-neutral-200 px-6 py-3.5 dark:border-neutral-800">
            <span class="text-sm font-medium text-neutral-500 dark:text-neutral-400">SPC-CML</span>
            <button
                type="button"
                class="flex h-9 w-9 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                @click="alternarTema"
                :title="escuro ? 'Mudar para tema claro' : 'Mudar para tema escuro'"
            >
                <svg v-if="escuro" width="18" height="18" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2" />
                    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </svg>
                <svg v-else width="18" height="18" viewBox="0 0 24 24">
                    <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
            </button>
        </header>

        <main ref="areaMensagens" class="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
            <div v-if="mensagens.length === 0" class="mx-auto mt-[8vh] max-w-xl text-center">
                <h1 class="mb-2 bg-gradient-to-r from-blue-500 via-purple-400 to-rose-400 bg-clip-text text-4xl font-medium text-transparent">SPC-CML</h1>
                <p class="mb-7 text-[15px] text-neutral-500 dark:text-neutral-400">Decodificação restrita por gramática, ancorada no grafo de conhecimento.</p>
                <div class="flex flex-col gap-2.5">
                    <button
                        v-for="s in sugestoesAtuais"
                        :key="s"
                        type="button"
                        class="rounded-2xl border border-neutral-200 bg-neutral-50 px-4.5 py-3.5 text-left text-sm text-neutral-800 hover:bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-800/60 dark:text-neutral-200 dark:hover:bg-neutral-800"
                        @click="enviar(s)"
                    >
                        {{ s }}
                    </button>
                </div>
            </div>

            <div v-else class="mx-auto max-w-3xl">
                <ChatMessage v-for="m in mensagens" :key="m.id" :mensagem="m" />
            </div>
        </main>

        <footer class="px-4 pb-4.5 sm:px-6">
            <div class="mx-auto flex max-w-3xl items-end gap-2 rounded-3xl bg-neutral-100 py-2 pr-2 pl-5 dark:bg-neutral-800">
                <textarea
                    v-model="textoInput"
                    rows="1"
                    placeholder="Digite o comando…"
                    class="max-h-40 flex-1 resize-none bg-transparent py-2 text-[15px] leading-relaxed text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                    @keydown="aoTeclar"
                ></textarea>

                <DomainPicker v-if="dominios.length" v-model="dominioAtual" :dominios="dominios" />
                <span v-else-if="erroCarregamento" class="shrink-0 text-xs text-red-600 dark:text-red-400">API indisponível</span>

                <button
                    type="button"
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition-colors disabled:bg-neutral-300 disabled:text-neutral-500 dark:disabled:bg-neutral-700 dark:disabled:text-neutral-400"
                    :disabled="!textoInput.trim() || enviando"
                    @click="enviar()"
                >
                    <svg width="19" height="19" viewBox="0 0 24 24">
                        <path d="M4 12h16m0 0l-6-6m6 6l-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                </button>
            </div>
            <p class="mx-auto mt-2.5 max-w-3xl text-center text-xs text-neutral-400 dark:text-neutral-500">
                O modelo pode cometer erros de julgamento clínico/agronômico. Sempre confira antes de agir.
            </p>
        </footer>
    </div>
</template>
