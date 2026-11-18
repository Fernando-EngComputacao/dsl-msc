<script setup lang="ts">
import { computed, onMounted } from "vue";
import DomainPicker from "../components/DomainPicker.vue";
import DomainModal from "../components/DomainModal.vue";
import ChatMessage from "../components/ChatMessage.vue";
import ModelSwitchDivider from "../components/ModelSwitchDivider.vue";
import BatchProgress from "../components/BatchProgress.vue";
import ConfirmModal from "../components/ConfirmModal.vue";
import type { CriterioGate } from "../api";
import {
  dominios,
  dominioAtual,
  erroCarregamento,
  mensagens,
  textoInput,
  enviando,
  areaMensagens,
  modalTrocaAberto,
  dominioPendente,
  inputArquivoLote,
  gateLote,
  loteAtivo,
  modalPararLoteAberto,
  modalEscolherModeloLoteAberto,
  nomeDominio,
  sugestoesAtuais,
  carregarDominios,
  enviar,
  pararGeracao,
  aoTeclar,
  aoEscolherDominio,
  confirmarTrocaDominio,
  cancelarTrocaDominio,
  abrirSeletorArquivo,
  escolherModeloLote,
  cancelarEscolhaModeloLote,
  aoSelecionarArquivo,
  pedirPararLote,
  confirmarPararLote,
  cancelarPararLote,
  baixarResultadosLote,
} from "../chat";

onMounted(() => {
  if (dominios.value.length === 0) carregarDominios();
});

/** O que o critério escolhido implica para a leitura dos resultados. */
const explicacaoCriterio = computed(() => {
  if (gateLote.value.criterio === 'juiz')
    return "O juiz decide sozinho: pode ficar plano que o oráculo reprovou (o registro mostra).";
  if (gateLote.value.criterio === 'oraculo')
    return "O veredito normativo decide; o juiz, se chamado, só vai para o registro.";
  return "O mais estrito. Com o juiz no critério, nas linhas que ficam ele não é mais um observador independente — a concordância só é limpa nas tentativas descartadas.";
});

function vincularAreaMensagens(el: unknown): void {
  areaMensagens.value = el instanceof HTMLElement ? el : null;
}

function vincularInputArquivoLote(el: unknown): void {
  inputArquivoLote.value = el instanceof HTMLInputElement ? el : null;
}
</script>

<template>
  <main
    :ref="vincularAreaMensagens"
    class="flex-1 overflow-y-auto px-4 py-6 [overflow-anchor:none] sm:px-6"
  >
    <div
      v-if="mensagens.length === 0"
      class="mx-auto mt-[8vh] max-w-xl text-center"
    >
      <h1
        class="mb-2 bg-gradient-to-r from-blue-500 via-purple-400 to-rose-400 bg-clip-text text-4xl font-medium text-transparent"
      >
        SPC-CML
      </h1>
      <p class="mb-7 text-[15px] text-neutral-500 dark:text-neutral-400">
        Decodificação restrita por gramática, ancorada no grafo de
        conhecimento.
      </p>
      <div class="flex flex-col gap-2.5">
        <button
          v-for="s in sugestoesAtuais"
          :key="s"
          type="button"
          class="rounded-2xl border border-neutral-200 bg-neutral-50 px-4.5 py-3.5 text-left text-sm text-neutral-800 transition-colors hover:bg-neutral-100 dark:border-white/10 dark:bg-white/5 dark:text-neutral-200 dark:shadow-lg dark:shadow-black/10 dark:backdrop-blur-xl dark:hover:bg-white/10"
          @click="enviar(s)"
        >
          {{ s }}
        </button>
      </div>
    </div>

    <div v-else class="mx-auto max-w-3xl">
      <template v-for="m in mensagens">
        <ModelSwitchDivider
          v-if="m.autor === 'sistema'"
          :key="`d-${m.id}`"
          :dominio-nome="m.dominioNome ?? ''"
        />
        <BatchProgress
          v-else-if="m.autor === 'lote'"
          :key="`l-${m.id}`"
          :mensagem="m"
          @baixar="baixarResultadosLote(m)"
        />
        <ChatMessage v-else :key="`m-${m.id}`" :mensagem="m" />
      </template>
    </div>
  </main>

  <footer class="relative z-10 px-4 pb-4.5 sm:px-6">
    <div
      class="mx-auto flex max-w-3xl items-end gap-2 rounded-3xl bg-neutral-100 py-2 pr-2 pl-5 dark:border dark:border-white/10 dark:bg-white/5 dark:shadow-xl dark:shadow-black/20 dark:backdrop-blur-xl"
    >
      <input
        :ref="vincularInputArquivoLote"
        type="file"
        accept=".jsonl,.csv"
        class="hidden"
        @change="aoSelecionarArquivo"
      />
      <DomainModal
        :aberto="modalEscolherModeloLoteAberto"
        :dominios="dominios"
        @selecionar="escolherModeloLote"
        @cancelar="cancelarEscolhaModeloLote"
      >
        <!-- Gate do lote: cada plano gerado passa pela mesma cascata da tela de
             avaliação e, se reprovado, é gerado de novo. Quem reprova é o
             critério. Desligado, o lote mede o acerto da primeira geração. -->
        <template #rodape>
          <label class="flex cursor-pointer items-start gap-2.5">
            <input
              v-model="gateLote.ativa"
              type="checkbox"
              class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-blue-600"
            />
            <span class="flex flex-col gap-0.5">
              <span class="text-xs font-medium text-neutral-800 dark:text-neutral-100"
                >Validar cada plano e repetir até ser aprovado</span
              >
              <span class="text-[11px] leading-snug text-neutral-500 dark:text-neutral-400"
                >A mesma avaliação da tela "Avaliar resultados". Reprovado, o
                cenário volta para a geração; aprovado, segue para a próxima
                linha do arquivo.</span
              >
            </span>
          </label>
          <div
            v-if="gateLote.ativa"
            class="mt-2 flex flex-col gap-2 pl-6 text-[11px] text-neutral-500 dark:text-neutral-400"
          >
            <label class="flex flex-col gap-1">
              <span>Quem reprova e manda gerar de novo</span>
              <select
                :value="gateLote.criterio"
                class="rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-[11px] text-neutral-700 dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-200"
                @change="
                  gateLote.criterio = ($event.target as HTMLSelectElement)
                    .value as CriterioGate
                "
              >
                <option value="ambos">Oráculo + LLM Judge (os dois precisam aprovar)</option>
                <option value="oraculo">Só o oráculo (sintaxe → semântica)</option>
                <option value="juiz">Só o LLM Judge</option>
              </select>
              <span class="leading-snug text-neutral-400 dark:text-neutral-500">{{
                explicacaoCriterio
              }}</span>
            </label>
            <label class="flex items-center gap-2">
              <span>Máximo de tentativas por cenário</span>
              <input
                v-model.number="gateLote.maxTentativas"
                type="number"
                min="1"
                max="20"
                class="w-14 rounded-lg border border-neutral-200 bg-white px-2 py-1 text-right text-neutral-700 dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-200"
              />
            </label>
            <label
              v-if="gateLote.criterio === 'oraculo'"
              class="flex cursor-pointer items-center gap-2"
            >
              <input v-model="gateLote.juiz" type="checkbox" class="h-3.5 w-3.5 accent-blue-600" />
              <span>Chamar também o LLM Judge (só para o registro)</span>
            </label>
          </div>
        </template>

        <!-- Gatilho do modal. Com um slot nomeado em uso, filho solto seria
             ignorado pelo Vue: vai no slot default, explicitamente. -->
        <template #default>
          <button
            type="button"
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-200 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-white/10"
            :disabled="enviando || loteAtivo"
            title="Enviar arquivo .jsonl/.csv em lote"
            @click="abrirSeletorArquivo"
          >
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path
                d="M21.44 11.05l-8.49 8.49a5 5 0 01-7.07-7.07l8.49-8.49a3.5 3.5 0 014.95 4.95l-8.49 8.49a2 2 0 01-2.83-2.83l7.78-7.78"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </template>
      </DomainModal>

      <textarea
        v-model="textoInput"
        rows="1"
        placeholder="Digite o comando…"
        class="max-h-40 flex-1 resize-none bg-transparent py-2 text-[15px] leading-relaxed text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-neutral-100 dark:placeholder:text-neutral-500"
        @keydown="aoTeclar"
      ></textarea>

      <DomainPicker
        v-if="dominios.length"
        :model-value="dominioAtual"
        :dominios="dominios"
        @update:model-value="aoEscolherDominio"
      />
      <span
        v-else-if="erroCarregamento"
        class="shrink-0 text-xs text-red-600 dark:text-red-400"
        >API indisponível</span
      >

      <button
        type="button"
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition-colors disabled:bg-neutral-300 disabled:text-neutral-500 dark:disabled:bg-neutral-700 dark:disabled:text-neutral-400"
        :disabled="!enviando && !loteAtivo && !textoInput.trim()"
        :title="enviando ? 'Parar' : loteAtivo ? 'Parar lote' : 'Enviar'"
        @click="
          enviando ? pararGeracao() : loteAtivo ? pedirPararLote() : enviar()
        "
      >
        <svg v-if="enviando || loteAtivo" width="14" height="14" viewBox="0 0 24 24">
          <rect
            x="5"
            y="5"
            width="14"
            height="14"
            rx="2.5"
            fill="currentColor"
          />
        </svg>
        <svg v-else width="19" height="19" viewBox="0 0 24 24">
          <path
            d="M4 12h16m0 0l-6-6m6 6l-6 6"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>
    <p
      class="mx-auto mt-2.5 max-w-3xl text-center text-xs text-neutral-400 dark:text-neutral-500"
    >
      Os modelos "Agrícula e Clínico" foram criados para testagem da
      arquitetura SPC-CML, destinado à bateria de experimentos.
    </p>
  </footer>

  <ConfirmModal
    :aberto="modalTrocaAberto"
    titulo="Trocar de modelo?"
    :mensagem="`Mudar para “${dominioPendente ? nomeDominio(dominioPendente) : ''}” vai interromper a geração da resposta em andamento. Deseja continuar mesmo assim?`"
    texto-confirmar="Trocar mesmo assim"
    texto-cancelar="Cancelar"
    @confirmar="confirmarTrocaDominio"
    @cancelar="cancelarTrocaDominio"
  />

  <ConfirmModal
    :aberto="modalPararLoteAberto"
    titulo="Encerrar o lote?"
    mensagem="Isso vai parar o processamento do arquivo em lote. Os resultados já concluídos continuam disponíveis para download."
    texto-confirmar="Encerrar lote"
    texto-cancelar="Continuar"
    @confirmar="confirmarPararLote"
    @cancelar="cancelarPararLote"
  />
</template>
