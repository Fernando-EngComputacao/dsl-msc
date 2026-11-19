/**
 * Exportacao do relatorio do "Resultado da avaliacao" (web-chat/src/relatorio.ts
 * + RelatorioModal.vue + RelatorioCapa.vue).
 * Executar (da raiz): npm run test:web-relatorio
 *
 * O PDF nao e montado por codigo: as secoes JA renderizadas sao impressas, as
 * nao escolhidas ficam escondidas, e o navegador salva como PDF. Esse desenho
 * tem tres juntas que podem se soltar em silencio, e sao elas que o teste cobra:
 *
 *   1. LIGACAO: todo topico com secao esta ligado nas DUAS telas de resultado
 *      (`visivel('<topico>')`) e nenhuma secao ficou presa na aba (`mostra(...)`)
 *      — senao o topico existiria no modal e nao mudaria nada no PDF, ou a
 *      secao sairia no PDF mesmo desmarcada;
 *   2. DISPONIBILIDADE: topico sem dado no arquivo nao e oferecido, e com
 *      motivo — as mesmas funcoes que desenham as secoes de tempo respondem
 *      aqui, para o modal nunca prometer uma secao que diria "sem medicoes";
 *   3. IMPRESSAO: o contrato de CSS que faz tudo isso virar papel
 *      (`.sem-impressao`, `.somente-impressao`, o bloco @media print) continua
 *      no style.css e aplicado no header e na barra lateral — sem ele o PDF
 *      sairia com a navegacao da tela e sem capa.
 *
 * Mais o modal e a capa RENDERIZANDO de verdade (SSR pelo Vite, como em
 * complexidade.test.ts): cada topico com rotulo e descricao, o indisponivel
 * desabilitado com o motivo a vista, e "Gerar PDF" barrado com so a capa.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { createServer } from 'vite';

import type { DetalheLado, DetalheLinha, MetricasAvaliacao, RespostaAvaliacao } from '../src/api';
import {
    GRUPOS,
    SEM_RESULTADO,
    TOPICOS,
    ajustarSelecao,
    contarSelecionados,
    definicaoTopico,
    disponibilidade,
    nomeDoRelatorio,
    podeGerar,
    resumoDaCapa,
    selecaoPadrao,
    selecaoTotal,
    selecaoVazia,
    topicosDoGrupo,
    topicosSelecionados,
    type SecaoDaTela,
    type SelecaoRelatorio,
    type TopicoRelatorio
} from '../src/relatorio';

let falhas = 0;
function teste(nome: string, fn: () => void): void {
    try {
        fn();
        console.log(`  ok   ${nome}`);
    } catch (erro) {
        falhas++;
        console.log(`  FALHA ${nome}\n       ${(erro as Error).message}`);
    }
}

async function testeAsync(nome: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ok   ${nome}`);
    } catch (erro) {
        falhas++;
        console.log(`  FALHA ${nome}\n       ${(erro as Error).message}`);
    }
}

/** Raiz do repositorio: .../web-chat/tests -> ../.. */
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ler = (relativo: string): string => fs.readFileSync(path.join(RAIZ, relativo), 'utf8');

/** Texto visivel de um HTML renderizado (sem tags, espacos normalizados). */
const texto = (html: string): string =>
    html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&middot;|&#183;/g, '·')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

// ---------------------------------------------------------------------------
// Um resultado completo de mentira: dois planos, tempos de geracao, de gate e
// de avaliacao, e tamanhos — o bastante para TODO topico ficar disponivel.
// ---------------------------------------------------------------------------

const METRICAS: MetricasAvaliacao = {
    total: 2,
    sintaxe: { VALID: 2, INVALID: 0 },
    semantica: { VALID: 2, INVALID: 0, UNRESOLVED: 0, NOT_EVALUATED: 0 },
    oraculo: { VALID: 2, INVALID: 0, UNRESOLVED: 0 },
    juiz: { VALID: 2, INVALID: 0, UNRESOLVED: 0, NOT_CALLED: 0, NO_RESPONSE: 0 },
    concordantes: 2,
    discordantes: 0,
    pares: { 'VALID+VALID': 2 },
    violacoes: 0
};

function lado(tempoGeracaoMs: number, chars: number): DetalheLado {
    return {
        plano: 'PLANO ...',
        naoAvaliado: false,
        oraculo: { veredito: 'VALID', origem: 'semantica' },
        tempos: { oraculoMs: 120, llmJudgeMs: 800, sintaxeMs: 10 },
        geracao: {
            tempoTotalMs: tempoGeracaoMs,
            tempoValidacaoMs: 900,
            tempoGeracaoDescartadaMs: 0,
            tempoCenarioMs: tempoGeracaoMs + 900,
            tentativasGeracao: 1,
            charsPedido: Math.round(chars / 4),
            charsPrompt: chars,
            charsPlano: 400,
            tokensPrompt: Math.round(chars / 4),
            tokensPlano: 100
        }
    };
}

function linha(numero: number, tempoGeracaoMs: number, chars: number): DetalheLinha {
    return {
        linha: numero,
        intencao: `cenario ${numero}`,
        arquitetura: lado(tempoGeracaoMs, chars),
        temDivergencia: false,
        temDiscordancia: false
    };
}

const COMPLETO: RespostaAvaliacao = {
    arquitetura: METRICAS,
    naoAvaliados: 1,
    linhas: [linha(1, 12_000, 2000), linha(2, 18_000, 3200)],
    arquivoJsonl: 'avaliacao-med-2026-11-18.jsonl',
    tempoTotalSegundos: 42.5,
    tempoSintaxeSegundos: 0.1,
    tempoOraculoSegundos: 0.3,
    tempoLlmJudgeSegundos: 41,
    tempoGeracaoTotalSegundos: 30
};

/** Avaliado, mas sem nenhum tempo: as cinco secoes de tempo ficam indisponiveis. */
const SEM_TEMPOS: RespostaAvaliacao = {
    arquitetura: METRICAS,
    naoAvaliados: 0,
    linhas: [{ linha: 1, intencao: 'c', arquitetura: { plano: 'P', naoAvaliado: false }, temDivergencia: false, temDiscordancia: false }]
};

const TOPICOS_DE_TEMPO: TopicoRelatorio[] = ['tempoGeracao', 'tempoAvaliacao', 'tempoPilha', 'tempoTamanho', 'tempoPlano'];

console.log('\nExportacao do relatorio — catalogo de topicos');

teste('catalogo coerente: ids unicos, campos preenchidos, grupo conhecido', () => {
    const ids = TOPICOS.map(t => t.chave);
    assert.equal(new Set(ids).size, ids.length, 'topico repetido');
    for (const t of TOPICOS) {
        assert.ok(t.rotulo.length > 3, `rotulo curto: ${t.chave}`);
        assert.ok(t.descricao.length > 20, `descricao curta: ${t.chave}`);
        assert.ok(GRUPOS[t.grupo], `grupo desconhecido: ${t.grupo}`);
    }
    // Todo topico aparece em exatamente um grupo, e nenhum grupo fica vazio.
    const porGrupo = (Object.keys(GRUPOS) as (keyof typeof GRUPOS)[]).flatMap(g => topicosDoGrupo(g));
    assert.equal(porGrupo.length, TOPICOS.length, 'algum topico ficou fora dos grupos');
    for (const g of Object.keys(GRUPOS) as (keyof typeof GRUPOS)[]) {
        assert.ok(topicosDoGrupo(g).length > 0, `grupo vazio: ${g}`);
    }
});

teste('so a capa nao tem secao na tela; as cinco secoes da tela estao cobertas', () => {
    const semSecao = TOPICOS.filter(t => !t.secao).map(t => t.chave);
    assert.deepEqual(semSecao, ['capa'], 'topico de conteudo sem secao na tela');
    const secoes = new Set(TOPICOS.map(t => t.secao).filter((s): s is SecaoDaTela => !!s));
    assert.deepEqual([...secoes].sort(), ['analise', 'avaliacaoLlm', 'graficos', 'metricas', 'tempo']);
    assert.equal(definicaoTopico('estatisticos').secao, 'avaliacaoLlm');
});

teste('as abas da tela (NavegacaoResultado.vue) e as secoes dos topicos sao o mesmo conjunto', () => {
    const nav = ler('web-chat/src/components/NavegacaoResultado.vue');
    const declaradas = nav.match(/export type AbaResultado =([^;]+);/)?.[1];
    assert.ok(declaradas, 'nao achei a declaracao de AbaResultado');
    const abas = [...declaradas.matchAll(/'([a-zA-Z]+)'/g)].map(m => m[1]).filter(a => a !== 'todas');
    const secoes = [...new Set(TOPICOS.map(t => t.secao).filter((s): s is SecaoDaTela => !!s))];
    assert.deepEqual(abas.sort(), secoes.sort(), 'uma aba da tela nao tem topico no relatorio (ou vice-versa)');
});

console.log('\nLigacao com as telas de resultado');

for (const arquivo of ['web-chat/src/components/AvaliarResultados.vue', 'web-chat/src/components/ResultadosImportados.vue']) {
    teste(`${path.basename(arquivo)}: cada topico ligado, nenhuma secao presa na aba`, () => {
        const fonte = ler(arquivo);
        for (const t of TOPICOS.filter(t => t.secao)) {
            assert.ok(fonte.includes(`visivel('${t.chave}')`), `topico sem ligacao na tela: ${t.chave}`);
        }
        // Nenhum `visivel(...)` inventado.
        const usados = [...fonte.matchAll(/visivel\('([a-zA-Z]+)'\)/g)].map(m => m[1]);
        for (const u of usados) {
            assert.ok(TOPICOS.some(t => t.chave === u), `a tela chama visivel('${u}'), que nao e topico`);
        }
        // As secoes nao podem mais depender SO da aba: senao sairiam no PDF desmarcadas.
        assert.ok(!/v-show="mostra\(/.test(fonte), 'ainda ha secao com v-show="mostra(...)" — ela ignoraria a selecao do relatorio');
        // O gesto inteiro presente: botao, modal e capa.
        for (const marca of ['Exportar relatório', 'RelatorioModal', 'RelatorioCapa', 'usarExportacaoDoRelatorio']) {
            assert.ok(fonte.includes(marca), `${marca} ausente em ${path.basename(arquivo)}`);
        }
    });
}

teste('o contrato de impressao esta no style.css e aplicado no header e na barra lateral', () => {
    const css = ler('web-chat/src/style.css');
    assert.match(css, /\.somente-impressao\s*\{\s*display:\s*none;/, 'a capa precisa ficar escondida na tela');
    const bloco = css.match(/@media print \{[\s\S]+$/)?.[0];
    assert.ok(bloco, 'sem bloco @media print: o PDF sairia com a tela inteira');
    assert.match(bloco, /\.sem-impressao\s*\{\s*display:\s*none\s*!important;/, 'sem-impressao tem de sumir no papel');
    assert.match(bloco, /\.somente-impressao\s*\{\s*display:\s*block\s*!important;/, 'a capa tem de aparecer no papel');
    assert.match(bloco, /overflow:\s*visible\s*!important/, 'sem soltar a rolagem, o PDF corta na primeira pagina');
    assert.ok(ler('web-chat/src/App.vue').includes('sem-impressao sticky'), 'o header do app iria para o PDF');
    assert.ok(ler('web-chat/src/components/ChatSidebar.vue').includes('sem-impressao fixed'), 'a barra lateral iria para o PDF');
    assert.ok(ler('web-chat/src/components/RelatorioCapa.vue').includes('somente-impressao'), 'a capa apareceria na tela');
});

console.log('\nDisponibilidade: nada e oferecido sem dado');

teste('sem resultado, so a capa; todo indisponivel tem motivo', () => {
    const d = disponibilidade(SEM_RESULTADO);
    assert.equal(d.capa.disponivel, true);
    for (const t of TOPICOS.filter(t => t.chave !== 'capa')) {
        assert.equal(d[t.chave].disponivel, false, `${t.chave} nao deveria estar disponivel`);
        assert.ok((d[t.chave].motivo ?? '').length > 10, `${t.chave} indisponivel sem motivo`);
    }
});

teste('resultado completo: todo topico disponivel', () => {
    const d = disponibilidade(COMPLETO);
    for (const t of TOPICOS) assert.equal(d[t.chave].disponivel, true, `${t.chave} deveria estar disponivel: ${d[t.chave].motivo}`);
});

teste('avaliado sem tempo nenhum: as cinco secoes de tempo caem, o resto fica', () => {
    const d = disponibilidade(SEM_TEMPOS);
    for (const t of TOPICOS_DE_TEMPO) assert.equal(d[t].disponivel, false, `${t} nao tem dado e foi oferecido`);
    for (const t of ['capa', 'metricas', 'analise', 'graficos', 'estatisticos'] as TopicoRelatorio[]) {
        assert.equal(d[t].disponivel, true, `${t} deveria continuar disponivel`);
    }
});

teste('a disponibilidade das secoes de tempo segue as funcoes que as desenham', () => {
    // Tempo de geracao presente, mas nada por plano: pilha/tamanho/plano caem.
    const soAgregado: RespostaAvaliacao = { ...SEM_TEMPOS, tempoGeracaoTotalSegundos: 30 };
    const d = disponibilidade(soAgregado);
    assert.equal(d.tempoGeracao.disponivel, true);
    assert.equal(d.tempoAvaliacao.disponivel, false);
    assert.equal(d.tempoPilha.disponivel, true, 'ha uma parcela medida: a secao tem o que mostrar');
    assert.equal(d.tempoTamanho.disponivel, false, 'sem tempo por plano nao ha par tamanho x tempo');
    assert.equal(d.tempoPlano.disponivel, false, 'sem tempo por plano nao ha media nem desvio');
});

console.log('\nSelecao');

teste('selecaoPadrao marca tudo o que existe, e nada mais', () => {
    const d = disponibilidade(SEM_TEMPOS);
    const sel = selecaoPadrao(d);
    for (const t of TOPICOS_DE_TEMPO) assert.equal(sel[t], false, `${t} marcado sem dado`);
    assert.equal(sel.metricas, true);
    assert.equal(contarSelecionados(sel), TOPICOS.length - TOPICOS_DE_TEMPO.length);
});

teste('ajustarSelecao apaga o que nao existe e preserva o resto', () => {
    const d = disponibilidade(SEM_TEMPOS);
    const ajustada = ajustarSelecao(selecaoTotal(), d);
    assert.equal(ajustada.tempoPlano, false);
    assert.equal(ajustada.analise, true);
    // Idempotente: ajustar de novo nao muda nada.
    assert.deepEqual(ajustarSelecao(ajustada, d), ajustada);
});

teste('capa sozinha nao gera relatorio; topico marcado mas indisponivel nao conta', () => {
    const d = disponibilidade(COMPLETO);
    assert.equal(podeGerar(selecaoVazia(), d), false);
    assert.equal(podeGerar({ ...selecaoVazia(), capa: true }, d), false, 'capa sozinha nao e relatorio');
    assert.equal(podeGerar({ ...selecaoVazia(), metricas: true }, d), true);
    const semTempos = disponibilidade(SEM_TEMPOS);
    assert.equal(podeGerar({ ...selecaoVazia(), tempoPlano: true }, semTempos), false, 'marcado mas sem dado nao habilita');
});

teste('topicosSelecionados sai na ordem do relatorio', () => {
    const sel: SelecaoRelatorio = { ...selecaoVazia(), tempoPlano: true, metricas: true, capa: true };
    assert.deepEqual(topicosSelecionados(sel).map(t => t.chave), ['capa', 'metricas', 'tempoPlano']);
});

console.log('\nNome do arquivo e capa');

teste('nomeDoRelatorio: dominio, data e hora locais', () => {
    const em = new Date(2026, 10, 18, 9, 5);
    assert.equal(nomeDoRelatorio({ dominio: 'med', em }), 'relatorio-avaliacao-med-2026-11-18_09h05');
    assert.equal(nomeDoRelatorio({ em }), 'relatorio-avaliacao-spc-cml-2026-11-18_09h05');
});

teste('a capa conta o que o resultado tem — e omite o que ele nao tem', () => {
    const sel = selecaoPadrao(disponibilidade(COMPLETO));
    const capa = resumoDaCapa(COMPLETO, sel, { dominio: 'med', em: new Date(2026, 10, 18, 9, 5) });
    const valor = (rotulo: string): string | undefined => capa.itens.find(i => i.rotulo === rotulo)?.valor;
    assert.match(valor('Domínio') ?? '', /Clínico \(UTI\)/);
    assert.equal(valor('Arquivo'), 'avaliacao-med-2026-11-18.jsonl');
    assert.equal(valor('Lado avaliado'), 'Arquitetura SPC-CML');
    assert.equal(valor('Cenários'), '2');
    assert.equal(valor('Planos avaliados'), '2');
    assert.equal(valor('Não avaliados'), '1');
    // A capa nao se lista, e os topicos saem na ordem do relatorio.
    assert.ok(!capa.topicos.includes('Capa e identificação'));
    assert.deepEqual(capa.topicos.slice(0, 2), ['Métricas consolidadas', 'Comparação por linha']);

    // Resultado pelado: nenhuma linha inventada.
    const magra = resumoDaCapa(SEM_RESULTADO, selecaoVazia());
    assert.deepEqual(magra.itens.map(i => i.rotulo), ['Cenários']);
    assert.deepEqual(magra.topicos, []);
});

// ---------------------------------------------------------------------------
// Renderizacao de verdade (SSR pelo Vite), como em complexidade.test.ts.
// ---------------------------------------------------------------------------

async function renderizacao(): Promise<void> {
    const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const vite = await createServer({
        root: raiz,
        configFile: false,
        plugins: [vue()],
        logLevel: 'error',
        appType: 'custom',
        server: { middlewareMode: true, hmr: false, ws: false }
    });
    try {
        const { renderizarRelatorioModal, renderizarCapa } = (await vite.ssrLoadModule(
            '/tests/renderizar.ts'
        )) as typeof import('./renderizar');

        console.log('\nModal e capa na tela (SSR)');

        await testeAsync('o modal mostra os dez topicos com rotulo e descricao, agrupados', async () => {
            const d = disponibilidade(COMPLETO);
            const visivel = texto(await renderizarRelatorioModal(d, selecaoPadrao(d)));
            for (const t of TOPICOS) {
                assert.ok(visivel.includes(t.rotulo), `rotulo ausente: ${t.chave}`);
                assert.ok(visivel.includes(t.descricao.slice(0, 40)), `descricao ausente: ${t.chave}`);
            }
            for (const g of Object.values(GRUPOS)) assert.ok(visivel.includes(g.nome), `grupo ausente: ${g.nome}`);
            assert.ok(visivel.includes('10 de 10 marcados'), `contagem errada: ${visivel.slice(0, 200)}`);
            assert.ok(visivel.includes('Salvar como PDF'), 'o modal tem de dizer como o PDF sai');
        });

        await testeAsync('topico indisponivel: caixa desabilitada, desmarcada e com o motivo a vista', async () => {
            const d = disponibilidade(SEM_TEMPOS);
            const html = await renderizarRelatorioModal(d, selecaoPadrao(d));
            const visivel = texto(html);
            for (const t of TOPICOS_DE_TEMPO) {
                assert.ok(visivel.includes(`Indisponível: ${d[t].motivo}`), `motivo nao apareceu: ${t}`);
            }
            const caixas = [...html.matchAll(/<input type="checkbox"[^>]*>/g)].map(m => m[0]);
            assert.equal(caixas.length, TOPICOS.length, 'uma caixa por topico');
            const desabilitadas = caixas.filter(c => c.includes('disabled'));
            assert.equal(desabilitadas.length, TOPICOS_DE_TEMPO.length, 'so os sem dado ficam desabilitados');
            assert.equal(
                caixas.filter(c => c.includes('checked')).length,
                TOPICOS.length - TOPICOS_DE_TEMPO.length,
                'nenhum topico sem dado pode vir marcado'
            );
            assert.ok(visivel.includes(`${TOPICOS.length - TOPICOS_DE_TEMPO.length} de ${TOPICOS.length} marcados`));
        });

        await testeAsync('"Gerar PDF" so habilita com conteudo: a capa sozinha nao basta', async () => {
            const d = disponibilidade(COMPLETO);
            /** O atributo `disabled` do botao "Gerar PDF" — nao o `disabled:` das classes do Tailwind. */
            const barrado = (html: string): boolean => {
                const achado = [...html.matchAll(/<button((?:[^>](?!<button))*?)>(?:(?!<\/button>)[\s\S])*Gerar PDF/g)].map(m => m[1]);
                assert.equal(achado.length, 1, `esperava um botao "Gerar PDF", achei ${achado.length}`);
                return /\sdisabled(?=[\s>])/.test(`${achado[0]} `);
            };
            assert.equal(barrado(await renderizarRelatorioModal(d, { ...selecaoVazia(), capa: true })), true, 'capa sozinha tem de barrar');
            assert.equal(barrado(await renderizarRelatorioModal(d, { ...selecaoVazia(), metricas: true })), false, 'com conteudo tem de habilitar');
        });

        await testeAsync('fechado, o modal nao desenha nada', async () => {
            const d = disponibilidade(COMPLETO);
            const vazio = await renderizarRelatorioModal(d, selecaoPadrao(d), false);
            assert.ok(!texto(vazio).includes('Exportar relatório'), 'o modal fechado nao deve renderizar conteudo');
        });

        await testeAsync('a capa sai no papel com a identificacao e a lista de topicos numerada', async () => {
            const sel = selecaoPadrao(disponibilidade(COMPLETO));
            const resumo = resumoDaCapa(COMPLETO, sel, { dominio: 'med', em: new Date(2026, 10, 18, 9, 5) });
            const html = await renderizarCapa(resumo);
            const visivel = texto(html);
            assert.ok(html.includes('somente-impressao'), 'a capa nao pode aparecer na tela');
            assert.ok(visivel.includes('Relatório da avaliação — SPC-CML'));
            assert.ok(visivel.includes('UFG · Instituto de Informática · PPGCC'), visivel.slice(0, 120));
            assert.ok(visivel.includes('18 de novembro de 2026'), `data ausente: ${visivel.slice(0, 200)}`);
            for (const item of resumo.itens) assert.ok(visivel.includes(item.valor), `item ausente: ${item.rotulo}`);
            assert.match(html, /<ol[^>]*>/, 'a lista de topicos e numerada');
            for (const t of resumo.topicos) assert.ok(visivel.includes(t), `topico ausente na capa: ${t}`);
        });
    } finally {
        await vite.close();
    }
}

await renderizacao();

console.log(falhas === 0 ? '\nTodos os testes da exportacao do relatorio passaram.' : `\n${falhas} teste(s) falharam.`);
if (falhas > 0) process.exit(1);
