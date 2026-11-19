/**
 * O gesto de exportar: do botão "Exportar relatório" até a janela de impressão.
 *
 * Por que imprimir em vez de montar o PDF por código: as seções do resultado
 * JÁ estão renderizadas (cartões, tabelas, gráficos SVG, fórmulas em KaTeX).
 * Imprimi-las mantém texto vetorial, selecionável e idêntico ao que se viu na
 * tela, sem rasterizar gráfico (html2canvas) e sem dependência nova. O que esta
 * função faz é preparar a página para o papel:
 *
 *   1. guarda a seleção de tópicos e liga `exportando` — as telas usam isso
 *      para mostrar SÓ as seções escolhidas, independente da aba aberta;
 *   2. troca o `document.title`, que é o nome que o navegador sugere ao salvar
 *      como PDF (único jeito de influenciar esse nome sem gerar o PDF aqui);
 *   3. desliga o tema escuro durante a impressão — fundo escuro não é impresso,
 *      e o texto claro sairia branco no branco;
 *   4. espera dois quadros (o layout muda de largura no papel) e chama
 *      `window.print()`;
 *   5. desfaz tudo quando a janela de impressão fecha.
 *
 * Nada aqui roda no SSR: a função inteira depende de `window`.
 */
import { nextTick, ref, type Ref } from 'vue';
import { nomeDoRelatorio, selecaoTotal, type SelecaoRelatorio } from './relatorio';

export interface Exportacao {
    /** O modal de escolha dos tópicos está aberto. */
    modalAberto: Ref<boolean>;
    /** A última escolha (o modal reabre como foi deixado). */
    selecao: Ref<SelecaoRelatorio>;
    /** Enquanto verdadeiro, a tela mostra só os tópicos escolhidos. */
    exportando: Ref<boolean>;
    /** Fecha o modal, prepara a página e abre a janela de impressão. */
    gerar: (escolha: SelecaoRelatorio, opcoes?: { dominio?: string }) => Promise<void>;
}

/** Dois quadros de animação: o suficiente para o layout de impressão assentar. */
function doisQuadros(): Promise<void> {
    return new Promise(resolve => {
        if (typeof requestAnimationFrame !== 'function') {
            resolve();
            return;
        }
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
}

export function usarExportacaoDoRelatorio(): Exportacao {
    const modalAberto = ref(false);
    const selecao = ref<SelecaoRelatorio>(selecaoTotal());
    const exportando = ref(false);

    async function gerar(escolha: SelecaoRelatorio, opcoes: { dominio?: string } = {}): Promise<void> {
        selecao.value = { ...escolha };
        modalAberto.value = false;
        exportando.value = true;
        if (typeof window === 'undefined' || typeof document === 'undefined') return;

        const tituloAnterior = document.title;
        const eraEscuro = document.documentElement.classList.contains('dark');
        document.title = nomeDoRelatorio({ dominio: opcoes.dominio });
        if (eraEscuro) document.documentElement.classList.remove('dark');

        // `afterprint` é o sinal certo, mas não chega em todo navegador: a
        // restauração é idempotente e também é chamada quando print() retorna.
        let restaurado = false;
        const restaurar = (): void => {
            if (restaurado) return;
            restaurado = true;
            window.removeEventListener('afterprint', restaurar);
            exportando.value = false;
            document.title = tituloAnterior;
            if (eraEscuro) document.documentElement.classList.add('dark');
        };
        window.addEventListener('afterprint', restaurar);

        await nextTick();
        await doisQuadros();
        try {
            window.print();
        } finally {
            // Chrome/Edge: print() só retorna quando o diálogo fecha — aqui já
            // acabou. Firefox dispara `afterprint`, que chega antes deste prazo.
            window.setTimeout(restaurar, 800);
        }
    }

    return { modalAberto, selecao, exportando, gerar };
}
