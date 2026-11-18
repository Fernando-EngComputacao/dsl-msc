/**
 * Integridade do catalogo de complexidade (web-chat/src/complexidade.ts), que o
 * modal do header mostra.
 * Executar (da raiz): npm run test:web-complexidade
 *
 * O catalogo e texto: nenhum teste prova que "O(c log c)" esta certo. O que se
 * pode cobrar — e e o que importa para ele nao apodrecer — e a PROCEDENCIA:
 *
 *   1. toda `evidencia` aponta para arquivo que existe, e a `ancora` esta NAQUELA
 *      linha (tolerancia de 5 linhas) — referencia que escorregou e apontada com
 *      a linha certa na mensagem, em vez de passar calada;
 *   2. todo item cuja origem nao e a leitura do codigo tem fonte, e com URL
 *      quando nao e livro/artigo impresso;
 *   3. todo simbolo usado nas formulas esta declarado em VARIAVEIS;
 *   4. toda ferramenta de terceiros esta marcada como caixa-preta;
 *   5. item marcado como `nao-documentado` TEM ressalva (senao a lacuna some);
 *   6. ids unicos, campos obrigatorios nao vazios, caminhos compostos apontando
 *      para itens existentes;
 *   7. a contagem de linhas do codigo nao esta absurdamente defasada (o arquivo
 *      diz como foi medida; aqui se confere a ordem de grandeza);
 *   8. o modal RENDERIZA (SSR de verdade, pelo Vite, como em diagnostico.test.ts) e
 *      mostra o que importa: cada item, a derivacao, a ressalva e as fontes com link.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { createServer } from 'vite';

import {
    CAMADAS,
    CAMINHOS,
    CODIGO,
    ITENS,
    METODO,
    VARIAVEIS,
    itemPorId,
    itensPorCamada,
    variavelPorSimbolo
} from '../src/complexidade';

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

/** Raiz do repositorio: .../web-chat/tests -> ../.. */
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Distancia tolerada entre a linha declarada e a linha onde a ancora esta. */
const TOLERANCIA_LINHAS = 5;

teste('toda evidencia aponta para o arquivo, a linha e o trecho certos', () => {
    const problemas: string[] = [];
    for (const item of ITENS) {
        if (!item.evidencia) continue;
        const [arquivo, linhaTexto] = item.evidencia.split(':');
        const caminho = path.join(RAIZ, arquivo);
        if (!fs.existsSync(caminho)) {
            problemas.push(`${item.id}: arquivo inexistente (${arquivo})`);
            continue;
        }
        const linhas = fs.readFileSync(caminho, 'utf-8').split('\n');
        const linha = Number(linhaTexto);
        if (!Number.isInteger(linha) || linha < 1 || linha > linhas.length) {
            problemas.push(`${item.id}: linha ${linhaTexto} fora de ${arquivo} (${linhas.length} linhas)`);
            continue;
        }
        if (!item.ancora) {
            problemas.push(`${item.id}: evidencia sem ancora — a referencia nao se verifica`);
            continue;
        }
        // Onde a ancora realmente esta (1-indexado), para a mensagem dizer a linha certa.
        const encontradas = linhas.map((texto, i) => (texto.includes(item.ancora!) ? i + 1 : 0)).filter(n => n > 0);
        if (encontradas.length === 0) {
            problemas.push(`${item.id}: trecho "${item.ancora}" nao existe mais em ${arquivo}`);
            continue;
        }
        if (!encontradas.some(n => Math.abs(n - linha) <= TOLERANCIA_LINHAS)) {
            problemas.push(`${item.id}: ${arquivo}:${linha} escorregou — o trecho esta em ${encontradas.join(' / ')}`);
        }
    }
    assert.deepEqual(problemas, [], `evidencias quebradas:\n       ${problemas.join('\n       ')}`);
});

teste('origem que nao e o codigo tem fonte, e a fonte tem titulo', () => {
    const problemas: string[] = [];
    for (const item of ITENS) {
        if (item.origem === 'codigo') continue;
        const fontes = item.fontes ?? [];
        if (fontes.length === 0) problemas.push(`${item.id}: origem "${item.origem}" sem fonte`);
        for (const f of fontes) {
            if (!f.titulo.trim()) problemas.push(`${item.id}: fonte sem titulo`);
            if (f.url !== undefined && !/^https?:\/\//.test(f.url)) problemas.push(`${item.id}: URL suspeita (${f.url})`);
        }
        // Ao menos UMA fonte com URL: sem link, o leitor nao confere.
        if (fontes.length > 0 && !fontes.some(f => f.url)) {
            const impressa = fontes.some(f => /\(\d{4}\)/.test(f.titulo));
            if (!impressa) problemas.push(`${item.id}: nenhuma fonte com URL`);
        }
    }
    assert.deepEqual(problemas, [], `fontes faltando:\n       ${problemas.join('\n       ')}`);
});

teste('todo simbolo usado esta declarado em VARIAVEIS', () => {
    const problemas: string[] = [];
    for (const item of ITENS) {
        for (const simbolo of item.variaveis) {
            if (!variavelPorSimbolo(simbolo)) problemas.push(`${item.id}: simbolo "${simbolo}" nao declarado`);
        }
        if (item.variaveis.length === 0) problemas.push(`${item.id}: nenhuma variavel declarada`);
    }
    assert.deepEqual(problemas, [], `simbolos orfaos:\n       ${problemas.join('\n       ')}`);
});

teste('cada variavel declarada e usada por algum item', () => {
    const usados = new Set(ITENS.flatMap(i => i.variaveis));
    const naoUsadas = VARIAVEIS.filter(v => !usados.has(v.simbolo)).map(v => v.simbolo);
    assert.deepEqual(naoUsadas, [], `variaveis declaradas e nunca usadas: ${naoUsadas.join(', ')}`);
});

teste('ferramentas de terceiros estao marcadas como caixa-preta', () => {
    const terceiros = ['lark-lalr', 'langium', 'indice-vetorial', 'travessia-grafo', 'bge-m3', 'inferencia-llm', 'gbnf'];
    for (const id of terceiros) {
        const item = itemPorId(id);
        assert.ok(item, `item ${id} deveria existir`);
        assert.equal(item!.caixaPreta, true, `${id} e ferramenta externa: tem de estar marcado como caixa-preta`);
    }
    // E o nosso codigo nao se disfarça de caixa-preta.
    for (const item of ITENS) {
        if (item.origem === 'codigo') assert.equal(item.caixaPreta, false, `${item.id}: derivado do nosso codigo, nao e caixa-preta`);
    }
});

teste('item nao documentado pela ferramenta tem ressalva', () => {
    const semRessalva = ITENS.filter(i => i.origem === 'nao-documentado' && !i.ressalva?.trim()).map(i => i.id);
    assert.deepEqual(semRessalva, [], `lacuna sem ressalva: ${semRessalva.join(', ')}`);
    // E existe pelo menos um: a honestidade do catalogo depende de admitir os limites.
    assert.ok(ITENS.some(i => i.origem === 'nao-documentado'), 'nenhuma lacuna registrada — suspeito');
});

teste('ids unicos e campos obrigatorios preenchidos', () => {
    const ids = ITENS.map(i => i.id);
    assert.equal(new Set(ids).size, ids.length, 'ids repetidos');
    for (const item of ITENS) {
        for (const campo of ['componente', 'operacao', 'tempo', 'comoObtido'] as const) {
            assert.ok(item[campo]?.trim().length > 0, `${item.id}: campo "${campo}" vazio`);
        }
        assert.ok(CAMADAS[item.camada], `${item.id}: camada desconhecida (${item.camada})`);
        assert.ok(/O\(|Linear|Escala|Não documentado/i.test(item.tempo), `${item.id}: "tempo" nao parece uma complexidade (${item.tempo})`);
    }
});

teste('caminhos compostos referenciam itens existentes', () => {
    const problemas: string[] = [];
    for (const caminho of CAMINHOS) {
        if (caminho.itens.length === 0) problemas.push(`${caminho.id}: sem itens`);
        for (const id of caminho.itens) if (!itemPorId(id)) problemas.push(`${caminho.id}: item inexistente (${id})`);
        if (!caminho.formula.trim() || !caminho.explicacao.trim()) problemas.push(`${caminho.id}: formula ou explicacao vazia`);
    }
    assert.deepEqual(problemas, [], `caminhos quebrados:\n       ${problemas.join('\n       ')}`);
});

teste('agrupamento por camada cobre todos os itens, sem duplicar', () => {
    const grupos = itensPorCamada();
    const total = grupos.reduce((s, g) => s + g.itens.length, 0);
    assert.equal(total, ITENS.length, 'algum item ficou fora (ou em duas camadas)');
    assert.ok(grupos.every(g => g.itens.length > 0), 'camada declarada sem nenhum item');
});

teste('a contagem de linhas do codigo esta na ordem de grandeza certa', () => {
    // Nao se cobra o numero exato (o codigo muda todo dia): cobra-se que a
    // camada existe e que a contagem nao esta defasada por mais de 40%.
    const medir = (dir: string): { arquivos: number; linhas: number } => {
        const caminho = path.join(RAIZ, dir);
        if (!fs.existsSync(caminho)) return { arquivos: 0, linhas: 0 };
        let arquivos = 0;
        let linhas = 0;
        const andar = (atual: string): void => {
            for (const entrada of fs.readdirSync(atual, { withFileTypes: true })) {
                const alvo = path.join(atual, entrada.name);
                if (entrada.isDirectory()) {
                    if (entrada.name !== 'node_modules' && entrada.name !== '__pycache__') andar(alvo);
                } else if (/\.(ts|py|vue)$/.test(entrada.name)) {
                    arquivos++;
                    linhas += fs.readFileSync(alvo, 'utf-8').split('\n').length;
                }
            }
        };
        andar(caminho);
        return { arquivos, linhas };
    };

    const problemas: string[] = [];
    for (const medida of CODIGO) {
        const dir = medida.camada.split(' ')[0];
        const real = medir(dir);
        if (real.arquivos === 0) {
            problemas.push(`${dir}: nao encontrei arquivos (camada renomeada?)`);
            continue;
        }
        const desvio = Math.abs(real.linhas - medida.linhas) / medida.linhas;
        if (desvio > 0.4) problemas.push(`${dir}: catalogo diz ${medida.linhas} linhas, medi ${real.linhas} (${Math.round(100 * desvio)}% de desvio)`);
    }
    assert.deepEqual(problemas, [], `contagem defasada:\n       ${problemas.join('\n       ')}`);
});

teste('o metodo esta explicado, inclusive o que nao foi medido', () => {
    assert.ok(METODO.length >= 4, 'o catalogo precisa explicar como foi feito');
    const texto = METODO.map(n => `${n.titulo} ${n.texto}`).join(' ').toLowerCase();
    assert.ok(texto.includes('ciclomática') || texto.includes('ciclomatica'), 'diga explicitamente que complexidade ciclomatica nao foi medida');
    assert.ok(texto.includes('benchmark'), 'diga que estes numeros nao sao benchmark');
});

// ---------------------------------------------------------------------------
// 8. O modal, renderizado de verdade (o conteudo vai no Teleport; ver renderizar.ts)
// ---------------------------------------------------------------------------

/** Texto visivel, sem tags nem entidades — a mesma limpeza de diagnostico.test.ts. */
const texto = (html: string): string =>
    html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ');

async function renderizacao(): Promise<void> {
    const vite = await createServer({
        root: path.join(RAIZ, 'web-chat'),
        configFile: false,
        plugins: [vue()],
        logLevel: 'error',
        appType: 'custom',
        server: { middlewareMode: true, hmr: false, ws: false }
    });
    try {
        const { renderizarComplexidade } = (await vite.ssrLoadModule('/tests/renderizar.ts')) as typeof import('./renderizar');
        const html = await renderizarComplexidade(true);
        const visivel = texto(html);

        teste('o modal renderiza e mostra todos os itens, com tempo e derivacao', () => {
            assert.ok(visivel.includes('Complexidade da arquitetura'), 'titulo ausente');
            const faltando = ITENS.filter(i => !visivel.includes(i.componente)).map(i => i.id);
            assert.deepEqual(faltando, [], `item nao apareceu na tela: ${faltando.join(', ')}`);
            const semTempo = ITENS.filter(i => !visivel.includes(i.tempo)).map(i => i.id);
            assert.deepEqual(semTempo, [], `complexidade nao apareceu: ${semTempo.join(', ')}`);
            assert.ok(visivel.includes('Como foi obtido'), 'a derivacao tem de aparecer junto do numero');
        });

        teste('as fontes aparecem com link e com a frase citada', () => {
            const comUrl = ITENS.flatMap(i => i.fontes ?? []).filter(f => f.url);
            assert.ok(comUrl.length >= 5, 'poucas fontes no catalogo');
            for (const fonte of comUrl) {
                assert.ok(html.includes(`href="${fonte.url}"`), `fonte sem link no HTML: ${fonte.titulo}`);
                assert.ok(visivel.includes(fonte.titulo), `titulo da fonte ausente: ${fonte.titulo}`);
            }
            // Link externo com rel seguro.
            assert.ok(html.includes('rel="noopener noreferrer"'), 'link externo sem rel seguro');
        });

        teste('caixa-preta, lacuna e ressalva ficam visiveis', () => {
            assert.ok(visivel.includes('caixa-preta'), 'o selo de ferramenta externa tem de aparecer');
            assert.ok(visivel.includes('nao documentado') || visivel.includes('não documentado'), 'a lacuna tem de aparecer');
            assert.ok(visivel.includes('Ressalva'), 'as ressalvas tem de aparecer');
            for (const item of ITENS.filter(i => i.ressalva)) {
                assert.ok(visivel.includes(item.ressalva!.slice(0, 40)), `ressalva de ${item.id} nao apareceu`);
            }
        });

        teste('o custo composto e o tamanho do codigo aparecem', () => {
            for (const caminho of CAMINHOS) {
                assert.ok(visivel.includes(caminho.titulo), `caminho ausente: ${caminho.id}`);
                assert.ok(visivel.includes(caminho.formula), `formula ausente: ${caminho.id}`);
            }
            for (const medida of CODIGO) {
                assert.ok(visivel.includes(medida.camada), `camada ausente na tabela: ${medida.camada}`);
            }
        });

        teste('fechado, o modal nao desenha nada', async () => {
            const vazio = await renderizarComplexidade(false);
            assert.ok(!texto(vazio).includes('Complexidade da arquitetura'), 'o modal fechado nao deve renderizar conteudo');
        });
    } finally {
        await vite.close();
    }
}

await renderizacao();

console.log(falhas === 0 ? '\nTodos os testes do catalogo de complexidade passaram.' : `\n${falhas} teste(s) falharam.`);
if (falhas > 0) process.exit(1);
