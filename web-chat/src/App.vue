<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import ChatSidebar from "./components/ChatSidebar.vue";
import { novoChat } from "./chat";
import { escuro, iniciarTema, alternarTema } from "./theme";
import logoUfg from "./assets/imgs/logo_ufg.png";

const route = useRoute();
const router = useRouter();

const sidebarAberta = ref(
  typeof window !== "undefined" ? window.innerWidth >= 768 : true,
);

const emAvaliacao = computed(() => route.path === "/avaliar");

iniciarTema();

function aoClicarNovoChat(): void {
  novoChat();
  if (emAvaliacao.value) router.push("/");
  if (window.innerWidth < 768) sidebarAberta.value = false;
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
      @novo-chat="aoClicarNovoChat"
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
              emAvaliacao
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-neutral-500 dark:text-neutral-400'
            "
            @click="router.push(emAvaliacao ? '/' : '/avaliar')"
            :title="emAvaliacao ? 'Voltar ao chat' : 'Avaliar resultados'"
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

      <RouterView />
    </div>
  </div>
</template>
