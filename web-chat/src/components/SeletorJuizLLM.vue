<script setup lang="ts">
/**
 * A escolha do LLM JUDGE: o LLM local (Qwen, no motor do domínio) ou um modelo
 * de fronteira no lugar dele.
 *
 * Escolher um provedor de fronteira pela primeira vez abre o modal do modelo e
 * da chave; depois disso o cartão seleciona direto, com "Alterar" e "Limpar os
 * dados" à mão. Tudo o que foi digitado fica neste navegador (ver
 * src/juiz-llm.ts), então atualizar a página não perde a escolha.
 *
 * A troca é só de modelo DENTRO do juiz: o oráculo determinístico continua
 * decidindo a validade, e a geração dos planos não é tocada — o juiz avalia
 * planos já gerados.
 */
import { computed, ref } from 'vue';
import type { JuizDisponivel } from '../api';
import {
    dadosDoProvedor,
    escolherProvedor,
    JUIZ_LOCAL,
    limparProvedor,
    temDados,
    type ConfigJuiz,
    type DadosProvedor
} from '../juiz-llm';
import ModalJuizLLM from './ModalJuizLLM.vue';

const props = defineProps<{
    modelValue: ConfigJuiz;
    /** Os provedores de fronteira que o servidor oferece (GET /api/juizes). */
    juizes: JuizDisponivel[];
    /** O nome do modelo local, quando o servidor já o informou. */
    modeloLocal?: string;
    /** Falha ao carregar a lista — a tela continua usável com o juiz local. */
    erro?: string | null;
}>();
const emit = defineEmits<{ 'update:modelValue': [config: ConfigJuiz] }>();

/** O provedor cujo modal está aberto; `null` = fechado. */
const configurando = ref<JuizDisponivel | null>(null);

const ehLocal = computed(() => props.modelValue.provedor === JUIZ_LOCAL);
const escolhido = computed(() => props.juizes.find(j => j.id === props.modelValue.provedor) ?? null);
const dadosEscolhido = computed(() => dadosDoProvedor(props.modelValue, props.modelValue.provedor));
/** O modelo que vai valer: o digitado, ou o padrão do provedor. */
const modeloEmUso = computed(() =>
    ehLocal.value ? (props.modeloLocal ?? 'o modelo do motor') : dadosEscolhido.value.modelo || (escolhido.value?.modeloPadrao ?? '')
);

const dadosDe = (juiz: JuizDisponivel): DadosProvedor => dadosDoProvedor(props.modelValue, juiz.id);

/**
 * Clique num cartão. O local seleciona direto; um de fronteira sem nada
 * guardado abre o modal — a avaliação não deve começar sem saber com que chave.
 */
function clicar(juiz: JuizDisponivel | null): void {
    if (!juiz) {
        emit('update:modelValue', escolherProvedor(props.modelValue, JUIZ_LOCAL));
        return;
    }
    if (temDados(props.modelValue, juiz.id) || juiz.chaveNoServidor) {
        emit('update:modelValue', escolherProvedor(props.modelValue, juiz.id));
        return;
    }
    configurando.value = juiz;
}

function salvarDoModal(dados: DadosProvedor): void {
    if (!configurando.value) return;
    emit('update:modelValue', escolherProvedor(props.modelValue, configurando.value.id, dados));
    configurando.value = null;
}

function limparDoModal(): void {
    if (!configurando.value) return;
    emit('update:modelValue', limparProvedor(props.modelValue, configurando.value.id));
    configurando.value = null;
}

/** "Limpar os dados" direto da linha de baixo: apaga e volta ao juiz local. */
function limparEscolhido(): void {
    if (ehLocal.value) return;
    emit('update:modelValue', limparProvedor(props.modelValue, props.modelValue.provedor));
}
</script>

<template>
    <section>
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <!-- O juiz de sempre: nada a configurar, nada a limpar. -->
            <button
                type="button"
                class="group relative flex items-center gap-3 rounded-2xl border p-3 text-left transition-all duration-200 hover:-translate-y-0.5 active:scale-[0.98]"
                :class="
                    ehLocal
                        ? 'border-blue-300 bg-blue-50 shadow-sm dark:border-blue-500/40 dark:bg-blue-500/10'
                        : 'border-neutral-200 bg-white hover:border-neutral-300 hover:shadow-sm dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10'
                "
                @click="clicar(null)"
            >
                <div
                    class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors duration-200"
                    :class="ehLocal ? 'bg-blue-600 text-white' : 'bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300'"
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
                    <p class="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">LLM local</p>
                    <p class="truncate text-xs text-neutral-400 dark:text-neutral-500">Qwen no motor (padrão)</p>
                </div>
                <Transition name="pop">
                    <div
                        v-if="ehLocal"
                        class="absolute top-2 right-2 flex h-4 w-4 items-center justify-center rounded-full bg-blue-600 text-white"
                    >
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M20 6L9 17l-5-5" />
                        </svg>
                    </div>
                </Transition>
            </button>

            <button
                v-for="j in juizes"
                :key="j.id"
                type="button"
                class="group relative flex items-center gap-3 rounded-2xl border p-3 text-left transition-all duration-200 hover:-translate-y-0.5 active:scale-[0.98]"
                :class="
                    modelValue.provedor === j.id
                        ? 'border-blue-300 bg-blue-50 shadow-sm dark:border-blue-500/40 dark:bg-blue-500/10'
                        : 'border-neutral-200 bg-white hover:border-neutral-300 hover:shadow-sm dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10'
                "
                @click="clicar(j)"
            >
                <div
                    class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors duration-200"
                    :class="
                        modelValue.provedor === j.id
                            ? 'bg-blue-600 text-white'
                            : 'bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300'
                    "
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z" />
                    </svg>
                </div>
                <div class="min-w-0">
                    <p class="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">{{ j.nome }}</p>
                    <p class="truncate text-xs text-neutral-400 dark:text-neutral-500">
                        {{
                            temDados(modelValue, j.id)
                                ? dadosDe(j).modelo || j.modeloPadrao
                                : j.chaveNoServidor
                                  ? 'chave no servidor'
                                  : 'precisa de chave'
                        }}
                    </p>
                </div>
                <Transition name="pop">
                    <div
                        v-if="modelValue.provedor === j.id"
                        class="absolute top-2 right-2 flex h-4 w-4 items-center justify-center rounded-full bg-blue-600 text-white"
                    >
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M20 6L9 17l-5-5" />
                        </svg>
                    </div>
                </Transition>
            </button>
        </div>

        <p v-if="erro" class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            {{ erro }} — só o LLM local está disponível nesta sessão.
        </p>

        <!-- O que vai valer, e o que fazer com os dados guardados. -->
        <div class="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs">
            <p class="text-neutral-500 dark:text-neutral-400">
                <template v-if="ehLocal">
                    Juiz: <span class="font-medium text-neutral-700 dark:text-neutral-200">LLM local</span>
                    <template v-if="modeloLocal">
                        · <code>{{ modeloLocal }}</code>
                    </template>
                    — nenhuma chave, nenhuma chamada externa.
                </template>
                <template v-else-if="escolhido">
                    Juiz: <span class="font-medium text-neutral-700 dark:text-neutral-200">{{ escolhido.nome }}</span>
                    · <code>{{ modeloEmUso }}</code>
                    ·
                    {{
                        dadosEscolhido.apiKey
                            ? 'chave guardada neste navegador'
                            : escolhido.chaveNoServidor
                              ? 'usando a chave do servidor'
                              : 'sem chave — a avaliação vai falhar'
                    }}
                </template>
            </p>
            <span v-if="!ehLocal && escolhido" class="flex items-center gap-2">
                <button
                    type="button"
                    class="rounded-full border border-neutral-200 px-3 py-1 text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/10"
                    @click="configurando = escolhido"
                >
                    Alterar modelo/chave
                </button>
                <button
                    v-if="temDados(modelValue, escolhido.id)"
                    type="button"
                    class="rounded-full border border-rose-200 px-3 py-1 text-rose-600 transition-colors hover:bg-rose-50 dark:border-rose-500/30 dark:text-rose-400 dark:hover:bg-rose-500/10"
                    title="Apaga o modelo e a chave guardados neste navegador e volta ao LLM local"
                    @click="limparEscolhido"
                >
                    Limpar os dados
                </button>
            </span>
        </div>

        <ModalJuizLLM
            :juiz="configurando"
            :dados="configurando ? dadosDe(configurando) : { modelo: '', apiKey: '' }"
            :tem-dados="configurando ? temDados(modelValue, configurando.id) : false"
            @salvar="salvarDoModal"
            @limpar="limparDoModal"
            @cancelar="configurando = null"
        />
    </section>
</template>

<style scoped>
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
</style>
