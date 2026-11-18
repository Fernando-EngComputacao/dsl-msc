/**
 * Entrada SSR dos testes da tela: carregada pelo Vite (`ssrLoadModule`), para
 * que o componente, o Vue e o renderizador venham do MESMO grafo de módulos.
 */
import { createSSRApp, h } from 'vue';
import { renderToString, type SSRContext } from 'vue/server-renderer';
import type { DetalheLado } from '../src/api';
import AvaliacaoLado from '../src/components/AvaliacaoLado.vue';
import ComplexidadeModal from '../src/components/ComplexidadeModal.vue';

/** O HTML do painel de um lado, como a Comparação por linha o desenha ao expandir a linha. */
export function renderizarLado(lado: DetalheLado | undefined): Promise<string> {
    return renderToString(createSSRApp({ render: () => h(AvaliacaoLado, { lado, titulo: 'Arquitetura SPC-CML', variante: 'arquitetura' }) }));
}

/**
 * O HTML do modal de complexidade (header). Ele usa `<Teleport to="body">`, e no
 * SSR o conteúdo teleportado NÃO entra na string principal: vai para
 * `ctx.teleports`. Por isso os dois são concatenados aqui — senão o teste
 * conferiria uma casca vazia e passaria sem ver nada.
 */
export async function renderizarComplexidade(aberto = true): Promise<string> {
    const ctx: SSRContext = {};
    const html = await renderToString(createSSRApp({ render: () => h(ComplexidadeModal, { aberto }) }), ctx);
    const teleportado = Object.values((ctx.teleports ?? {}) as Record<string, string>).join('');
    return html + teleportado;
}
