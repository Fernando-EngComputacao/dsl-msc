/**
 * Entrada SSR dos testes da tela: carregada pelo Vite (`ssrLoadModule`), para
 * que o componente, o Vue e o renderizador venham do MESMO grafo de módulos.
 */
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { DetalheLado } from '../src/api';
import AvaliacaoLado from '../src/components/AvaliacaoLado.vue';

/** O HTML do painel de um lado, como a Comparação por linha o desenha ao expandir a linha. */
export function renderizarLado(lado: DetalheLado | undefined): Promise<string> {
    return renderToString(createSSRApp({ render: () => h(AvaliacaoLado, { lado, titulo: 'Arquitetura SPC-CML', variante: 'arquitetura' }) }));
}
