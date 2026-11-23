<script setup lang="ts">
/**
 * Os dados de um juiz de FRONTEIRA: o modelo, a chave de API — e o teste de
 * conexão que confere os dois antes de uma avaliação inteira depender deles.
 *
 * Abre ao escolher um provedor que ainda não tem dados, e ao pedir "Alterar".
 * Salvar guarda no navegador (ver src/juiz-llm.ts) e passa a valer para a
 * próxima avaliação; cancelar não muda nada — nem a escolha do provedor.
 *
 * TESTAR é opcional e não trava o "Usar": o teste faz UM julgamento de
 * brinquedo no provedor (POST /api/juizes/testar) pelo MESMO caminho da
 * avaliação, então "conexão OK" quer dizer que a chave foi aceita, que o modelo
 * existe e que a resposta dele tem o formato que o juiz exige. O veredito que
 * volta é prova de vida, não nota de juiz nenhum.
 *
 * O resultado vale para o que foi testado: editar o modelo ou a chave depois
 * marca o teste como VENCIDO em vez de apagá-lo sem dizer nada. Fechar o modal
 * cancela um teste em andamento.
 *
 * O QUE FICA ESCONDIDO: toda explicação (o que este juiz faz, o que o campo do
 * modelo muda, onde a chave fica guardada, o que o teste prova) está atrás do
 * `^` do seu bloco e começa fechada — quem já sabe vê só os campos e os botões.
 * Resultado de teste e status não são explicação: aparecem sempre. Cada abertura
 * do modal volta tudo a fechado.
 */
import { computed, ref, watch } from 'vue';
import { testarJuiz, type JuizDisponivel, type PedidoTesteJuiz, type ResultadoTesteJuiz } from '../api';
import type { DadosProvedor } from '../juiz-llm';
// A leitura "que peça passou e que peça falhou" é do módulo puro, que tem teste
// (web-chat/tests/juiz-llm.test.ts) — a tela só desenha o que ele diz.
import { diagnosticoDoTeste, tituloDaFalha, type EstadoPeca } from '../teste-juiz';

const props = defineProps<{
    /** O provedor sendo configurado. `null` mantém o modal fechado. */
    juiz: JuizDisponivel | null;
    /** O que já estava guardado para ele. */
    dados: DadosProvedor;
    /** Há dados guardados para apagar. */
    temDados: boolean;
}>();

const emit = defineEmits<{
    salvar: [dados: DadosProvedor];
    limpar: [];
    cancelar: [];
}>();

const modelo = ref('');
const apiKey = ref('');
const mostrarChave = ref(false);

/** Os blocos que têm explicação atrás do `^`. */
type Secao = 'juiz' | 'modelo' | 'chave' | 'teste';

const aberto = ref<Record<Secao, boolean>>({ juiz: false, modelo: false, chave: false, teste: false });

function alternar(secao: Secao): void {
    aberto.value[secao] = !aberto.value[secao];
}

/** O teste em andamento, para poder cancelá-lo. */
let controlador: AbortController | null = null;
const testando = ref(false);
/** O último resultado, ou `null` se ninguém testou nesta abertura. */
const teste = ref<ResultadoTesteJuiz | null>(null);
/** O que aquele resultado testou — é com isto que se sabe se ele venceu. */
const alvoTestado = ref<{ modelo: string; apiKey: string } | null>(null);
/** A resposta crua do provedor fica atrás de um `^`: é evidência, não leitura. */
const mostrarRespostaBruta = ref(false);

/** Peça por peça: chave, modelo e provedor, com o que cada um provou. */
const diagnostico = computed(() => (teste.value ? diagnosticoDoTeste(teste.value) : null));

function pararTeste(): void {
    controlador?.abort();
    controlador = null;
    testando.value = false;
}

/** Sem chave digitada e sem chave no servidor, o teste só confirmaria o óbvio. */
const podeTestar = computed(() => !!props.juiz && (apiKey.value.trim().length > 0 || props.juiz.chaveNoServidor));

/** Os campos mudaram depois do teste: o resultado é de outro modelo/chave. */
const testeVencido = computed(
    () =>
        !!teste.value &&
        !!alvoTestado.value &&
        (alvoTestado.value.modelo !== modelo.value.trim() || alvoTestado.value.apiKey !== apiKey.value.trim())
);

/** `2,4 s` — a ordem de grandeza de um plano na avaliação. */
const segundos = (ms: number): string => `${(ms / 1000).toFixed(1).replace('.', ',')} s`;

// Cada abertura começa do que está guardado — a chave volta escondida, as
// explicações voltam fechadas e nenhum teste de outra abertura (ou de outro
// provedor) continua na tela.
watch(
    () => [props.juiz?.id, props.dados] as const,
    () => {
        pararTeste();
        teste.value = null;
        alvoTestado.value = null;
        mostrarRespostaBruta.value = false;
        modelo.value = props.dados.modelo;
        apiKey.value = props.dados.apiKey;
        mostrarChave.value = false;
        aberto.value = { juiz: false, modelo: false, chave: false, teste: false };
    },
    { immediate: true }
);

/**
 * Um julgamento de brinquedo no provedor. Falha de chave, de modelo, de cota ou
 * de formato volta em `ok: false` com o motivo — só o cancelamento não vira
 * resultado. A chave vai no corpo do pedido e não é gravada em lugar nenhum.
 */
async function testar(): Promise<void> {
    const juiz = props.juiz;
    if (!juiz || !podeTestar.value) return;
    const alvo = { modelo: modelo.value.trim(), apiKey: apiKey.value.trim() };
    const pedido: PedidoTesteJuiz = {
        provedor: juiz.id,
        ...(alvo.modelo ? { modelo: alvo.modelo } : {}),
        ...(alvo.apiKey ? { apiKey: alvo.apiKey } : {})
    };

    pararTeste();
    const meu = new AbortController();
    controlador = meu;
    testando.value = true;
    teste.value = null;
    alvoTestado.value = alvo;
    mostrarRespostaBruta.value = false;

    try {
        const resultado = await testarJuiz(pedido, meu.signal);
        if (!meu.signal.aborted) teste.value = resultado;
    } catch (erro) {
        // O servidor fora do ar não é falha do provedor: é falha de chegar nele.
        if (meu.signal.aborted || (erro as Error).name === 'AbortError') return;
        teste.value = {
            ok: false,
            provedor: pedido.provedor,
            modelo: alvo.modelo,
            ms: 0,
            erro: `não foi possível falar com o servidor da avaliação: ${(erro as Error).message}`,
            chaveDoAmbiente: !alvo.apiKey
        };
    } finally {
        if (controlador === meu) {
            controlador = null;
            testando.value = false;
        }
    }
}

function salvar(): void {
    emit('salvar', { modelo: modelo.value, apiKey: apiKey.value });
}

/** O sinal de cada peça: passou, falhou, ou o teste não chegou nela. */
const COR_PECA: Record<EstadoPeca, string> = {
    ok: 'bg-emerald-500 text-white',
    falhou: 'bg-rose-500 text-white',
    indefinido: 'bg-neutral-300 text-neutral-600 dark:bg-neutral-600 dark:text-neutral-200'
};
const SINAL_PECA: Record<EstadoPeca, string> = { ok: '✓', falhou: '✕', indefinido: '?' };

/** O `^` de cada bloco: mesma aparência em todos. */
const BOTAO_EXPANDIR =
    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-white/10 dark:hover:text-neutral-300';
const EXPLICACAO = 'mt-1.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400';
</script>

<template>
    <Teleport to="body">
        <Transition name="modal-fade">
            <div v-if="juiz" class="fixed inset-0 z-50 flex items-center justify-center p-4" @keydown.esc="emit('cancelar')">
                <div class="absolute inset-0 bg-neutral-900/30 backdrop-blur-sm dark:bg-black/50" @click="emit('cancelar')"></div>

                <div
                    class="relative w-full max-w-lg rounded-3xl border border-neutral-200 bg-white/95 p-6 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-neutral-900/80 dark:shadow-black/40"
                >
                    <!-- O que este juiz faz: atrás do ^, como todo o resto que é explicação. -->
                    <div class="flex items-start gap-1.5">
                        <h2 class="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                            {{ juiz.nome }} como LLM Judge
                        </h2>
                        <button
                            type="button"
                            :class="BOTAO_EXPANDIR"
                            class="mt-0.5"
                            :aria-expanded="aberto.juiz"
                            :title="aberto.juiz ? 'Esconder a explicação' : 'O que este juiz faz'"
                            @click="alternar('juiz')"
                        >
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2.5"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                class="transition-transform duration-200"
                                :class="aberto.juiz ? 'rotate-180' : ''"
                            >
                                <path d="M6 9l6 6 6-6" />
                            </svg>
                        </button>
                    </div>
                    <Transition name="desc">
                        <p v-if="aberto.juiz" class="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
                            O {{ juiz.nome }} vai fazer exatamente o que o LLM local faz no lugar do juiz: ler o mesmo pedido, a
                            mesma telemetria, o mesmo conhecimento recuperado e as mesmas evidências, com o mesmo prompt, e
                            responder VALID, INVALID ou UNRESOLVED. A geração dos planos não muda — o juiz só olha planos já
                            gerados.
                        </p>
                    </Transition>

                    <div class="mt-5">
                        <div class="mb-1 flex items-center gap-1.5">
                            <label for="juiz-modelo" class="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                                Modelo
                            </label>
                            <button
                                type="button"
                                :class="BOTAO_EXPANDIR"
                                :aria-expanded="aberto.modelo"
                                :title="aberto.modelo ? 'Esconder a explicação' : 'O que este campo muda'"
                                @click="alternar('modelo')"
                            >
                                <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    stroke-width="2.5"
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    class="transition-transform duration-200"
                                    :class="aberto.modelo ? 'rotate-180' : ''"
                                >
                                    <path d="M6 9l6 6 6-6" />
                                </svg>
                            </button>
                        </div>
                        <input
                            id="juiz-modelo"
                            v-model="modelo"
                            type="text"
                            autocomplete="off"
                            spellcheck="false"
                            :placeholder="juiz.modeloPadrao"
                            class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 font-mono text-sm text-neutral-700 dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-200"
                        />
                        <Transition name="desc">
                            <p v-if="aberto.modelo" :class="EXPLICACAO">
                                Em branco usa {{ juiz.modeloPadrao }}. É este nome que vai no campo <code>llm-judge</code> do JSONL
                                da avaliação.
                            </p>
                        </Transition>
                    </div>

                    <div class="mt-4">
                        <div class="mb-1 flex items-center gap-1.5">
                            <label for="juiz-chave" class="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                                Chave de API{{ juiz.chaveNoServidor ? ' (opcional)' : '' }}
                            </label>
                            <button
                                type="button"
                                :class="BOTAO_EXPANDIR"
                                :aria-expanded="aberto.chave"
                                :title="aberto.chave ? 'Esconder a explicação' : 'Onde esta chave fica'"
                                @click="alternar('chave')"
                            >
                                <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    stroke-width="2.5"
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    class="transition-transform duration-200"
                                    :class="aberto.chave ? 'rotate-180' : ''"
                                >
                                    <path d="M6 9l6 6 6-6" />
                                </svg>
                            </button>
                        </div>
                        <div class="flex items-center gap-2">
                            <input
                                id="juiz-chave"
                                v-model="apiKey"
                                :type="mostrarChave ? 'text' : 'password'"
                                autocomplete="off"
                                spellcheck="false"
                                :placeholder="juiz.chaveNoServidor ? 'usar a chave do servidor' : 'cole a chave do provedor'"
                                class="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-3 py-2 font-mono text-sm text-neutral-700 dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-200"
                            />
                            <button
                                type="button"
                                class="shrink-0 rounded-lg border border-neutral-200 px-2.5 py-2 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/10"
                                :title="mostrarChave ? 'Esconder a chave' : 'Mostrar a chave'"
                                @click="mostrarChave = !mostrarChave"
                            >
                                {{ mostrarChave ? 'ocultar' : 'ver' }}
                            </button>
                        </div>
                        <Transition name="desc">
                            <p v-if="aberto.chave" :class="EXPLICACAO">
                                <template v-if="juiz.chaveNoServidor">
                                    O servidor já tem uma chave em {{ juiz.variaveisDeAmbiente.join(' / ') }}: deixe em branco para
                                    usá-la e nada é guardado aqui.
                                </template>
                                <template v-else>
                                    Fica guardada neste navegador (localStorage) para você não digitar de novo, e vai ao servidor só
                                    durante a avaliação — nunca para o disco dele, nem para o JSONL. Para não guardar nada aqui,
                                    defina {{ juiz.variaveisDeAmbiente.join(' ou ') }} no servidor e deixe o campo em branco.
                                </template>
                            </p>
                        </Transition>
                    </div>

                    <!-- Teste de conexão: um julgamento de brinquedo, pelo mesmo caminho da avaliação. -->
                    <div class="mt-4 rounded-2xl border border-neutral-200 bg-neutral-50/60 p-3 dark:border-white/10 dark:bg-white/[0.03]">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                            <div class="flex items-center gap-1.5">
                                <p class="text-xs font-medium text-neutral-600 dark:text-neutral-300">Testar a conexão</p>
                                <button
                                    type="button"
                                    :class="BOTAO_EXPANDIR"
                                    :aria-expanded="aberto.teste"
                                    :title="aberto.teste ? 'Esconder a explicação' : 'O que o teste prova'"
                                    @click="alternar('teste')"
                                >
                                    <svg
                                        width="12"
                                        height="12"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="2.5"
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        class="transition-transform duration-200"
                                        :class="aberto.teste ? 'rotate-180' : ''"
                                    >
                                        <path d="M6 9l6 6 6-6" />
                                    </svg>
                                </button>
                            </div>
                            <span class="flex items-center gap-2">
                                <button
                                    v-if="testando"
                                    type="button"
                                    class="rounded-full px-3 py-1.5 text-xs font-medium text-neutral-500 transition hover:bg-neutral-200/70 dark:text-neutral-400 dark:hover:bg-white/10"
                                    @click="pararTeste"
                                >
                                    Cancelar o teste
                                </button>
                                <button
                                    type="button"
                                    class="flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50"
                                    :class="
                                        testando
                                            ? 'border-neutral-200 text-neutral-500 dark:border-white/10 dark:text-neutral-400'
                                            : 'border-blue-200 text-blue-700 hover:bg-blue-50 dark:border-blue-500/30 dark:text-blue-300 dark:hover:bg-blue-500/10'
                                    "
                                    :disabled="testando || !podeTestar"
                                    :title="
                                        podeTestar
                                            ? 'Faz um julgamento de teste no provedor com este modelo e esta chave'
                                            : 'Cole a chave do provedor para testar'
                                    "
                                    @click="testar"
                                >
                                    <svg
                                        v-if="testando"
                                        class="animate-spin"
                                        width="12"
                                        height="12"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="3"
                                        stroke-linecap="round"
                                    >
                                        <path d="M12 3a9 9 0 109 9" />
                                    </svg>
                                    {{ testando ? 'Testando…' : 'Testar conexão' }}
                                </button>
                            </span>
                        </div>

                        <!-- Explicação: só com o ^ aberto. -->
                        <Transition name="desc">
                            <p v-if="aberto.teste" :class="EXPLICACAO">
                                Um único julgamento de brinquedo em
                                <code>{{ modelo.trim() || juiz.modeloPadrao }}</code>
                                — diz se a chave é aceita, se o modelo existe e se a resposta dele tem o formato que o juiz exige.
                                Opcional: dá para salvar sem testar.
                            </p>
                        </Transition>

                        <!-- Status e resultado não são explicação: aparecem sempre. -->
                        <p v-if="testando" class="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                            Chamando {{ juiz.nome }}… uma chamada só, e pode levar alguns segundos.
                        </p>

                        <div
                            v-else-if="teste"
                            class="mt-2 rounded-xl border px-3 py-2"
                            :class="
                                teste.ok
                                    ? 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/30 dark:bg-emerald-500/10'
                                    : 'border-rose-200 bg-rose-50/70 dark:border-rose-500/30 dark:bg-rose-500/10'
                            "
                            data-teste-juiz
                            :data-ok="teste.ok ? 'sim' : 'nao'"
                        >
                            <p
                                class="text-xs font-medium"
                                :class="teste.ok ? 'text-emerald-800 dark:text-emerald-300' : 'text-rose-800 dark:text-rose-300'"
                            >
                                <template v-if="teste.ok">
                                    Conexão OK — <code>{{ teste.modelo }}</code> respondeu em {{ segundos(teste.ms) }}
                                </template>
                                <template v-else>{{ tituloDaFalha(teste) }}</template>
                            </p>

                            <!--
                                Peça por peça: o que o teste PROVOU. `?` não é
                                falha — é o teste que parou antes de chegar nela.
                            -->
                            <ul v-if="diagnostico" class="mt-2 space-y-1">
                                <li
                                    v-for="linha in diagnostico.linhas"
                                    :key="linha.peca"
                                    class="flex items-start gap-1.5 text-xs leading-relaxed"
                                    :data-peca="linha.peca"
                                    :data-estado="linha.estado"
                                >
                                    <span
                                        class="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[9px] leading-none font-bold"
                                        :class="COR_PECA[linha.estado]"
                                    >
                                        {{ SINAL_PECA[linha.estado] }}
                                    </span>
                                    <span class="min-w-0 text-neutral-600 dark:text-neutral-300">
                                        <span class="font-medium text-neutral-700 dark:text-neutral-200">{{ linha.rotulo }}</span>
                                        — {{ linha.detalhe }}
                                    </span>
                                </li>
                            </ul>

                            <p v-if="teste.ok" class="mt-2 text-xs leading-relaxed text-emerald-700/90 dark:text-emerald-200/80">
                                Veredito <code>{{ teste.veredito }}</code> no julgamento de teste — prova de vida, não nota.
                                {{
                                    teste.chaveDoAmbiente
                                        ? 'O teste usou a chave do ambiente do servidor.'
                                        : 'O teste usou a chave digitada aqui.'
                                }}
                            </p>

                            <p v-if="diagnostico && !teste.ok" class="mt-2 text-xs leading-relaxed text-neutral-700 dark:text-neutral-200">
                                <span class="font-medium">O que fazer:</span> {{ diagnostico.acao }}
                            </p>

                            <!-- A resposta crua do provedor é evidência: fica atrás do ^, como as explicações. -->
                            <div v-if="!teste.ok" class="mt-2">
                                <button
                                    type="button"
                                    class="flex items-center gap-1 text-[11px] text-neutral-500 transition-colors hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
                                    :aria-expanded="mostrarRespostaBruta"
                                    @click="mostrarRespostaBruta = !mostrarRespostaBruta"
                                >
                                    <svg
                                        width="11"
                                        height="11"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="2.5"
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        class="transition-transform duration-200"
                                        :class="mostrarRespostaBruta ? 'rotate-180' : ''"
                                    >
                                        <path d="M6 9l6 6 6-6" />
                                    </svg>
                                    O que o provedor respondeu
                                </button>
                                <Transition name="desc">
                                    <p
                                        v-if="mostrarRespostaBruta"
                                        class="mt-1 font-mono text-[11px] leading-relaxed break-words text-rose-700 dark:text-rose-200/90"
                                    >
                                        {{ teste.erro }}
                                    </p>
                                </Transition>
                            </div>

                            <p v-if="testeVencido" class="mt-2 text-xs text-amber-700 dark:text-amber-300">
                                O modelo ou a chave mudaram depois deste teste: teste de novo para o resultado valer.
                            </p>
                        </div>
                    </div>

                    <div class="mt-6 flex flex-wrap items-center justify-between gap-2.5">
                        <button
                            v-if="temDados"
                            type="button"
                            class="rounded-full px-4 py-2 text-sm font-medium text-rose-600 transition hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
                            @click="emit('limpar')"
                        >
                            Limpar os dados
                        </button>
                        <span v-else></span>
                        <span class="flex gap-2.5">
                            <button
                                type="button"
                                class="rounded-full px-4 py-2 text-sm font-medium text-neutral-600 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-white/10"
                                @click="emit('cancelar')"
                            >
                                Cancelar
                            </button>
                            <button
                                type="button"
                                class="rounded-full bg-blue-600 px-5 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700"
                                @click="salvar"
                            >
                                Usar {{ juiz.nome }}
                            </button>
                        </span>
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

/* As explicações entram e saem sem empurrar o modal de susto. */
.desc-enter-active,
.desc-leave-active {
    transition:
        opacity 0.12s ease,
        transform 0.12s ease;
}
.desc-enter-from,
.desc-leave-to {
    opacity: 0;
    transform: translateY(-3px);
}
</style>
