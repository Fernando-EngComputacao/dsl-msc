<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import DomainPicker from "./components/DomainPicker.vue";
import DomainModal from "./components/DomainModal.vue";
import ChatMessage from "./components/ChatMessage.vue";
import ModelSwitchDivider from "./components/ModelSwitchDivider.vue";
import BatchProgress from "./components/BatchProgress.vue";
import ConfirmModal from "./components/ConfirmModal.vue";
import ChatSidebar from "./components/ChatSidebar.vue";
import AvaliarResultados from "./components/AvaliarResultados.vue";
import {
  buscarDominios,
  enviarComandoStream,
  criarChat,
  atualizarChat,
  type Dominio,
} from "./api";
import type { Mensagem, ItemResultadoLote } from "./types";
import { parseArquivoLote, type CenarioLote } from "./lote";
import { escuro, iniciarTema, alternarTema } from "./theme";
import logoUfg from "./assets/imgs/logo_ufg.png";

const dominios = ref<Dominio[]>([]);
const dominioAtual = ref<"med" | "agro">("med");
const erroCarregamento = ref<string | null>(null);

const mensagens = ref<Mensagem[]>([]);
const textoInput = ref("");
const enviando = ref(false);
const areaMensagens = ref<HTMLElement | null>(null);
let proximoId = 1;

const controladorAtual = ref<AbortController | null>(null);
const modalTrocaAberto = ref(false);
const dominioPendente = ref<"med" | "agro" | null>(null);

const chatIdAtual = ref<string | null>(null);
const sidebarAberta = ref(
  typeof window !== "undefined" ? window.innerWidth >= 768 : true,
);
const avaliarAberto = ref(false);

const inputArquivoLote = ref<HTMLInputElement | null>(null);
const loteAtivo = ref(false);
const loteControlador = ref<AbortController | null>(null);
const modalPararLoteAberto = ref(false);
const modalEscolherModeloLoteAberto = ref(false);
const dominioLoteSelecionado = ref<"med" | "agro" | null>(null);

function nomeDominio(id: "med" | "agro"): string {
  return dominios.value.find((d) => d.id === id)?.nome ?? id;
}

const SUGESTOES: Record<"med" | "agro", string[]> = {
  med: [
    "A pressão caiu, PAM 52. Sobe a noradrenalina.",
    "Paciente agitado no ventilador, aumenta a sedação.",
    "Glicemia deu 320, inicia insulina em bomba.",
  ],
  agro: [
    "Vento forte mas a janela fecha hoje, manda o glifosato na soja.",
    "NDVI despencou e o talhão fica perto do córrego. Aplica atrazina?",
    "A cana tá com a folha fervendo, começa o imidacloprido.",
  ],
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

/** Cria o chat na primeira mensagem e atualiza o mesmo arquivo dali em diante —
 *  fica so como registro local do experimento, sem navegacao no sidebar.
 *  Chamadas (no envio, na resposta, no lote, na troca de dominio...) disparam
 *  sem await em paralelo — encadeadas numa fila, senão duas chamadas correndo
 *  antes da primeira preencher chatIdAtual criam dois chats em vez de um so
 *  sendo atualizado. Falha ao persistir localmente nao deve travar o chat em
 *  memoria. */
let filaSalvarChat: Promise<void> = Promise.resolve();
function salvarChatAtual(): void {
  if (mensagens.value.length === 0) return;
  filaSalvarChat = filaSalvarChat.then(async () => {
    try {
      const chat = chatIdAtual.value
        ? await atualizarChat(
            chatIdAtual.value,
            dominioAtual.value,
            mensagens.value,
          )
        : await criarChat(dominioAtual.value, mensagens.value);
      chatIdAtual.value = chat.id;
    } catch {
      // idem
    }
  });
}

function novoChat(): void {
  if (enviando.value) pararGeracao();
  if (loteAtivo.value) loteControlador.value?.abort();
  mensagens.value = [];
  chatIdAtual.value = null;
  textoInput.value = "";
  if (window.innerWidth < 768) sidebarAberta.value = false;
}

async function rolarParaFinal(): Promise<void> {
  await nextTick();
  if (areaMensagens.value) {
    areaMensagens.value.scrollTop = areaMensagens.value.scrollHeight;
  }
}

async function enviar(textoForcado?: string): Promise<void> {
  const texto = (textoForcado ?? textoInput.value).trim();
  if (!texto || enviando.value || loteAtivo.value) return;

  textoInput.value = "";
  enviando.value = true;
  const controlador = new AbortController();
  controladorAtual.value = controlador;

  mensagens.value.push({
    id: proximoId++,
    autor: "usuario",
    dominio: dominioAtual.value,
    texto,
  });
  const idResposta = proximoId++;
  mensagens.value.push({
    id: idResposta,
    autor: "assistente",
    dominio: dominioAtual.value,
    carregando: true,
  });
  rolarParaFinal();
  salvarChatAtual();

  try {
    const resposta = await enviarComandoStream(
      dominioAtual.value,
      texto,
      (textoEstagio) => {
        const alvo = mensagens.value.find((m) => m.id === idResposta);
        if (alvo) alvo.estagio = textoEstagio;
        rolarParaFinal();
      },
      controlador.signal,
    );
    const alvo = mensagens.value.find((m) => m.id === idResposta);
    if (alvo) {
      alvo.carregando = false;
      alvo.resposta = resposta;
      alvo.texto = texto;
    }
  } catch (error) {
    // Abortado por causa de uma troca de modelo confirmada: essa mensagem ja
    // foi marcada como interrompida em confirmarTrocaDominio, nada a fazer aqui.
    if ((error as Error).name === "AbortError") return;

    const alvo = mensagens.value.find((m) => m.id === idResposta);
    if (alvo) {
      alvo.carregando = false;
      alvo.erro = (error as Error).message;
    }
  } finally {
    enviando.value = false;
    controladorAtual.value = null;
    rolarParaFinal();
    salvarChatAtual();
  }
}

/** Botao de enviar vira "parar" enquanto uma geracao esta em andamento. */
function pararGeracao(): void {
  const emAndamento = mensagens.value.find(
    (m) => m.autor === "assistente" && m.carregando,
  );
  if (emAndamento) {
    emAndamento.carregando = false;
    emAndamento.erro = "Interrompido pelo usuário.";
  }
  controladorAtual.value?.abort();
}

function aoTeclar(evento: KeyboardEvent): void {
  if (evento.key === "Enter" && !evento.shiftKey) {
    evento.preventDefault();
    enviar();
  }
}

/** Aplica a troca de dominio de fato: atualiza o estado e anuncia na conversa. */
function trocarDominio(novo: "med" | "agro"): void {
  dominioAtual.value = novo;
  if (mensagens.value.length > 0) {
    mensagens.value.push({
      id: proximoId++,
      autor: "sistema",
      dominio: novo,
      dominioNome: nomeDominio(novo),
    });
    rolarParaFinal();
    salvarChatAtual();
  }
}

/** Handler do DomainPicker: so troca na hora se nao houver nada em andamento. */
function aoEscolherDominio(novo: string): void {
  const alvo = novo as "med" | "agro";
  if (alvo === dominioAtual.value) return;

  if (enviando.value || loteAtivo.value) {
    dominioPendente.value = alvo;
    modalTrocaAberto.value = true;
    return;
  }
  trocarDominio(alvo);
}

function confirmarTrocaDominio(): void {
  if (!dominioPendente.value) return;

  const emAndamento = mensagens.value.find(
    (m) => m.autor === "assistente" && m.carregando,
  );
  if (emAndamento) {
    emAndamento.carregando = false;
    emAndamento.erro =
      "Interrompido: o modelo foi alterado antes da resposta terminar.";
  }
  controladorAtual.value?.abort();

  const loteEmAndamento = mensagens.value.find(
    (m) => m.autor === "lote" && m.lote && !m.lote.finalizado,
  );
  if (loteEmAndamento?.lote) loteEmAndamento.lote.cancelado = true;
  loteControlador.value?.abort();

  const novo = dominioPendente.value;
  modalTrocaAberto.value = false;
  dominioPendente.value = null;
  trocarDominio(novo);
}

function cancelarTrocaDominio(): void {
  modalTrocaAberto.value = false;
  dominioPendente.value = null;
}

function abrirSeletorArquivo(): void {
  if (enviando.value || loteAtivo.value) return;
  modalEscolherModeloLoteAberto.value = true;
}

function escolherModeloLote(id: string): void {
  modalEscolherModeloLoteAberto.value = false;
  const dominio = id as "med" | "agro";
  dominioLoteSelecionado.value = dominio;
  if (dominio !== dominioAtual.value) trocarDominio(dominio);
  inputArquivoLote.value?.click();
}

function cancelarEscolhaModeloLote(): void {
  modalEscolherModeloLoteAberto.value = false;
}

async function aoSelecionarArquivo(evento: Event): Promise<void> {
  const input = evento.target as HTMLInputElement;
  const arquivo = input.files?.[0];
  input.value = "";
  const dominio = dominioLoteSelecionado.value ?? dominioAtual.value;
  dominioLoteSelecionado.value = null;
  if (!arquivo || enviando.value || loteAtivo.value) return;

  let cenarios: CenarioLote[];
  try {
    const conteudo = await arquivo.text();
    cenarios = parseArquivoLote(arquivo.name, conteudo, dominio);
  } catch (error) {
    mensagens.value.push({
      id: proximoId++,
      autor: "assistente",
      dominio,
      erro: `Falha ao ler "${arquivo.name}": ${(error as Error).message}`,
    });
    rolarParaFinal();
    return;
  }

  const idLote = proximoId++;
  mensagens.value.push({
    id: idLote,
    autor: "lote",
    dominio,
    lote: {
      nomeArquivo: arquivo.name,
      total: cenarios.length,
      concluidos: 0,
      cancelado: false,
      finalizado: false,
      resultados: [],
      iniciadoEm: Date.now(),
    },
  });
  rolarParaFinal();
  salvarChatAtual();
  await rodarLote(cenarios, idLote, dominio);
}

/** Roda o pipeline completo uma vez por cenario do lote, sequencialmente — permite
 *  acompanhar "N/total concluidos" e cancelar entre um cenario e outro. */
async function rodarLote(
  cenarios: CenarioLote[],
  idLote: number,
  dominio: "med" | "agro",
): Promise<void> {
  const msg = mensagens.value.find((m) => m.id === idLote);
  if (!msg?.lote) return;

  loteAtivo.value = true;
  const controlador = new AbortController();
  loteControlador.value = controlador;

  for (const [i, cenario] of cenarios.entries()) {
    if (controlador.signal.aborted) break;

    let item: ItemResultadoLote;
    try {
      const resposta = await enviarComandoStream(
        dominio,
        cenario.intencao,
        (textoEstagio) => {
          msg.lote!.estagioAtual = textoEstagio;
        },
        controlador.signal,
        cenario.contexto,
      );
      item = {
        linha: i + 1,
        intencao: cenario.intencao,
        aceito: resposta.aceito,
        valido: resposta.valido,
        erroMotor: resposta.erroMotor,
        regrasEmGHat: resposta.regrasEmGHat,
        telemetria: resposta.sorteio,
        promptSemantico: resposta.promptSemantico,
        foco: resposta.foco,
        plano: resposta.resultado,
      };
    } catch (error) {
      if ((error as Error).name === "AbortError") break;
      item = {
        linha: i + 1,
        intencao: cenario.intencao,
        aceito: false,
        erro: (error as Error).message,
      };
    }

    msg.lote.resultados.push(item);
    msg.lote.concluidos++;
    rolarParaFinal();
  }

  msg.lote.finalizado = true;
  msg.lote.estagioAtual = undefined;
  msg.lote.duracaoSegundos = Number(
    ((Date.now() - msg.lote.iniciadoEm) / 1000).toFixed(1),
  );
  loteAtivo.value = false;
  loteControlador.value = null;
  salvarChatAtual();
}

function pedirPararLote(): void {
  modalPararLoteAberto.value = true;
}

function confirmarPararLote(): void {
  modalPararLoteAberto.value = false;
  const msg = mensagens.value.find(
    (m) => m.autor === "lote" && m.lote && !m.lote.finalizado,
  );
  if (msg?.lote) msg.lote.cancelado = true;
  loteControlador.value?.abort();
}

function cancelarPararLote(): void {
  modalPararLoteAberto.value = false;
}

function nomeArquivoLote(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}_${d.getFullYear()}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jsonl`;
}

function baixarResultadosLote(msg: Mensagem): void {
  const l = msg.lote;
  if (!l) return;

  const linhas = l.resultados.map((r) => JSON.stringify(r));
  linhas.push(
    JSON.stringify({
      duracaoSegundos:
        l.duracaoSegundos ??
        Number(((Date.now() - l.iniciadoEm) / 1000).toFixed(1)),
    }),
  );
  const conteudo = linhas.join("\n");
  const blob = new Blob([conteudo], {
    type: "application/x-ndjson;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `results/${nomeArquivoLote()}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div
    class="relative flex h-screen overflow-hidden bg-white/10 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100"
  >
    <!-- Manchas de cor desfocadas: sem elas o backdrop-blur dos paineis "de vidro"
             (sidebar incluida) nao tem nada para desfocar, e o efeito some. So no
             escuro. SEM z-index negativo: dentro de um container flex, os filhos
             diretos (sidebar/conteudo) pintam com z-index 0 implicito por
             especificacao, o que os coloca ACIMA de qualquer -z-10 do pai — teria
             que forcar z tao alto que cobriria tudo. Em vez disso, essa camada fica
             primeiro no DOM (logo atras dos demais na ordem de pintura) e cada um e
             transparente o bastante (bg com opacidade) para deixá-la aparecer por
             baixo. -->
    <div class="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        class="animate-blob absolute -top-40 -left-32 h-120 w-120 rounded-full bg-blue-500 opacity-8 blur-3xl [animation-delay:-2s] dark:opacity-25"
      ></div>
      <div
        class="animate-blob absolute top-1/4 -right-32 h-112 w-112 rounded-full bg-fuchsia-500 opacity-6 blur-3xl [animation-delay:-8s] dark:opacity-20"
      ></div>
      <div
        class="animate-blob absolute -bottom-40 left-1/4 h-112 w-112 rounded-full bg-rose-500 opacity-6 blur-3xl [animation-delay:-14s] dark:opacity-20"
      ></div>
      <div
        class="animate-blob absolute bottom-1/4 right-1/4 h-72 w-72 rounded-full bg-cyan-400 opacity-5 blur-3xl [animation-delay:-19s] dark:opacity-15"
      ></div>
    </div>

    <ChatSidebar
      :aberta="sidebarAberta"
      @novo-chat="novoChat"
      @fechar="sidebarAberta = false"
    />

    <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header
        class="sticky top-0 z-10 grid grid-cols-3 items-center border-b border-neutral-200 px-6 py-3 dark:border-white/10 dark:bg-neutral-900/40 dark:shadow-lg dark:shadow-black/20 dark:backdrop-blur-xl"
      >
        <div class="flex items-center gap-2 justify-self-start">
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-white/10"
            @click="sidebarAberta = !sidebarAberta"
            :title="sidebarAberta ? 'Ocultar histórico' : 'Mostrar histórico'"
          >
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path
                d="M4 6h16M4 12h16M4 18h16"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
          </button>
          <span
            class="text-sm font-medium text-neutral-500 dark:text-neutral-400"
            >SPC-CML</span
          >
        </div>

        <!-- Logo da instituição -->
        <div class="flex items-center justify-self-center gap-4">
          <div>
            <p
              class="text-xs leading-none font-bold text-neutral-800 dark:text-neutral-100"
            >
              PPGCC
            </p>
            <p
              class="mt-1 text-[9px] leading-tight tracking-wide text-neutral-500 uppercase dark:text-neutral-400"
            >
              Programa de
              <br />
              Pós-Graduação em
              <br />
              Ciência da Computação
            </p>
          </div>

          <div>
            <p
              class="text-xs leading-none font-bold text-neutral-800 dark:text-neutral-100"
            >
              INF
            </p>
            <p
              class="mt-1 text-[9px] leading-tight tracking-wide text-neutral-500 uppercase dark:text-neutral-400"
            >
              Instituto de
              <br />
              Informática
            </p>
          </div>

          <div class="flex items-center gap-1.5">
            <img :src="logoUfg" alt="UFG" class="h-8 w-auto" />
            <div>
              <p
                class="text-xs leading-none font-bold text-neutral-800 dark:text-neutral-100"
              >
                UFG
              </p>
              <p
                class="mt-1 text-[9px] leading-tight tracking-wide text-neutral-500 uppercase dark:text-neutral-400"
              >
                Universidade
                <br />
                Federal de Goiás
              </p>
            </div>
          </div>
        </div>

        <div class="flex items-center gap-1 justify-self-end">
          <button
            type="button"
            class="flex h-9 w-9 items-center justify-center rounded-full hover:bg-neutral-100 dark:hover:bg-white/10"
            :class="
              avaliarAberto
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-neutral-500 dark:text-neutral-400'
            "
            @click="avaliarAberto = !avaliarAberto"
            :title="avaliarAberto ? 'Voltar ao chat' : 'Avaliar resultados'"
          >
            <svg width="18" height="18" viewBox="0 0 24 24">
              <line
                x1="18"
                y1="20"
                x2="18"
                y2="10"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
              <line
                x1="12"
                y1="20"
                x2="12"
                y2="4"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
              <line
                x1="6"
                y1="20"
                x2="6"
                y2="14"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
          </button>

          <button
            type="button"
            class="flex h-9 w-9 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-white/10"
            @click="alternarTema"
            :title="escuro ? 'Mudar para tema claro' : 'Mudar para tema escuro'"
          >
            <svg v-if="escuro" width="18" height="18" viewBox="0 0 24 24">
              <circle
                cx="12"
                cy="12"
                r="4"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              />
              <path
                d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
            <svg v-else width="18" height="18" viewBox="0 0 24 24">
              <path
                d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </header>

      <div v-if="avaliarAberto" class="flex flex-1 flex-col overflow-hidden">
        <AvaliarResultados  />
      </div>

      <template v-else>
        <main
          ref="areaMensagens"
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
              ref="inputArquivoLote"
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
                enviando
                  ? pararGeracao()
                  : loteAtivo
                    ? pedirPararLote()
                    : enviar()
              "
            >
              <svg
                v-if="enviando || loteAtivo"
                width="14"
                height="14"
                viewBox="0 0 24 24"
              >
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
            <!-- Os modelos de linguagem são ferramentas de apoio e não substituem o julgamento profissional. Sempre verifique as informações antes de tomar decisões críticas. -->
          </p>
        </footer>
      </template>
    </div>

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
  </div>
</template>
