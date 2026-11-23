/**
 * A escolha do LLM Judge e a memoria dela no navegador (web-chat/src/juiz-llm.ts).
 * Executar (da raiz): npm run test:web-juiz
 *
 * A tela guarda modelo e chave POR PROVEDOR no localStorage, para atualizar a
 * pagina nao perder o que foi digitado. O que se cobra:
 *
 *   1. ida e volta: o que foi salvo e lido de novo igual, inclusive trocando de
 *      provedor e voltando (os dados de cada um ficam separados);
 *   2. limpar apaga os dados daquele provedor E volta ao juiz local — nenhum
 *      resto de chave fica guardado;
 *   3. localStorage indisponivel ou corrompido nao quebra a tela: abre no juiz
 *      local (e uma janela privada tem de funcionar);
 *   4. o pedido mandado ao servidor: nada com o juiz local, e sem campo vazio
 *      com um de fronteira (chave em branco significa "use a do ambiente");
 *   5. a leitura do TESTE DE CONEXAO (web-chat/src/teste-juiz.ts): qual peca a
 *      falha acusa — chave, modelo ou provedor — e, sobretudo, o que ela NAO
 *      acusa. Um 503 nao e motivo para trocar a chave; uma chave recusada nao
 *      diz nada sobre o nome do modelo.
 */

import assert from 'node:assert/strict';

import {
    carregarConfig,
    configInicial,
    dadosDoProvedor,
    escolherProvedor,
    JUIZ_LOCAL,
    limparProvedor,
    pedidoDoJuizLLM,
    salvarConfig,
    temDados,
    type ConfigJuiz
} from '../src/juiz-llm';
import { diagnosticoDoTeste, tituloDaFalha, type EstadoPeca, type PecaTeste } from '../src/teste-juiz';
import type { CausaFalhaTeste, ResultadoTesteJuiz } from '../src/api';

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

/** Um localStorage de mentira, com a opcao de recusar tudo (janela privada). */
function instalarArmazenamento(opcoes: { recusa?: boolean } = {}): { dados: Map<string, string> } {
    const dados = new Map<string, string>();
    const falso = {
        getItem: (k: string): string | null => {
            if (opcoes.recusa) throw new Error('acesso negado');
            return dados.get(k) ?? null;
        },
        setItem: (k: string, v: string): void => {
            if (opcoes.recusa) throw new Error('acesso negado');
            dados.set(k, v);
        },
        removeItem: (k: string): void => void dados.delete(k),
        clear: (): void => dados.clear(),
        key: (): string | null => null,
        length: 0
    };
    (globalThis as { localStorage?: unknown }).localStorage = falso;
    return { dados };
}

console.log('\nA memoria da escolha do LLM Judge');

teste('comeca no juiz local, sem dados de ninguem', () => {
    instalarArmazenamento();
    const c = carregarConfig();
    assert.equal(c.provedor, JUIZ_LOCAL);
    assert.deepEqual(c.porProvedor, {});
    assert.equal(temDados(c, 'claude'), false);
    assert.deepEqual(dadosDoProvedor(c, 'claude'), { modelo: '', apiKey: '' });
});

teste('o que foi salvo volta igual depois de atualizar a pagina', () => {
    instalarArmazenamento();
    const escolhido = escolherProvedor(configInicial(), 'gemini', { modelo: 'gemini-2.5-flash-lite', apiKey: 'chave-g' });
    salvarConfig(escolhido);

    // "Atualizar a pagina" = ler de novo do mesmo armazenamento.
    const relido = carregarConfig();
    assert.equal(relido.provedor, 'gemini');
    assert.deepEqual(dadosDoProvedor(relido, 'gemini'), { modelo: 'gemini-2.5-flash-lite', apiKey: 'chave-g' });
    assert.equal(temDados(relido, 'gemini'), true);
});

teste('os dados de cada provedor ficam separados: trocar e voltar nao apaga nada', () => {
    instalarArmazenamento();
    let c: ConfigJuiz = configInicial();
    c = escolherProvedor(c, 'claude', { modelo: 'claude-opus-5-5', apiKey: 'chave-c' });
    c = escolherProvedor(c, 'deepseek', { modelo: '', apiKey: 'chave-d' });
    salvarConfig(c);

    const relido = carregarConfig();
    assert.equal(relido.provedor, 'deepseek');
    assert.equal(dadosDoProvedor(relido, 'claude').apiKey, 'chave-c', 'a chave do Claude sumiu ao trocar de provedor');
    assert.equal(dadosDoProvedor(relido, 'deepseek').apiKey, 'chave-d');

    // Voltar para o Claude nao precisa digitar nada de novo.
    const voltou = escolherProvedor(relido, 'claude');
    assert.equal(voltou.provedor, 'claude');
    assert.equal(dadosDoProvedor(voltou, 'claude').modelo, 'claude-opus-5-5');
});

teste('escolher grava sem espaco em volta', () => {
    const c = escolherProvedor(configInicial(), 'gpt', { modelo: '  gpt-5.1  ', apiKey: '  sk-x  ' });
    assert.deepEqual(dadosDoProvedor(c, 'gpt'), { modelo: 'gpt-5.1', apiKey: 'sk-x' });
});

teste('so modelo (sem chave) ja conta como configurado — a chave pode estar no servidor', () => {
    const c = escolherProvedor(configInicial(), 'gpt', { modelo: 'gpt-5.1', apiKey: '' });
    assert.equal(temDados(c, 'gpt'), true);
    assert.equal(temDados(c, 'claude'), false);
});

console.log('\nLimpar os dados');

teste('limpar apaga os dados do provedor e volta ao juiz local', () => {
    instalarArmazenamento();
    let c = escolherProvedor(configInicial(), 'claude', { modelo: 'claude-opus-5-5', apiKey: 'chave-secreta' });
    c = limparProvedor(c, 'claude');
    salvarConfig(c);

    assert.equal(c.provedor, JUIZ_LOCAL, 'sem dados, o juiz volta a ser o local');
    assert.equal(temDados(c, 'claude'), false);
    const relido = carregarConfig();
    assert.equal(relido.provedor, JUIZ_LOCAL);
    assert.deepEqual(relido.porProvedor, {}, 'nao pode sobrar resto de chave guardado');
    assert.ok(!JSON.stringify(relido).includes('chave-secreta'), 'a chave continua no armazenamento');
});

teste('limpar um provedor que nao e o escolhido nao troca o juiz', () => {
    let c = escolherProvedor(configInicial(), 'claude', { modelo: '', apiKey: 'c' });
    c = escolherProvedor(c, 'gemini', { modelo: '', apiKey: 'g' });
    const depois = limparProvedor(c, 'claude');
    assert.equal(depois.provedor, 'gemini');
    assert.equal(temDados(depois, 'claude'), false);
    assert.equal(temDados(depois, 'gemini'), true);
});

console.log('\nArmazenamento hostil');

teste('janela privada (localStorage recusa): abre no juiz local, sem lancar', () => {
    instalarArmazenamento({ recusa: true });
    const c = carregarConfig();
    assert.equal(c.provedor, JUIZ_LOCAL);
    // Salvar tambem nao pode derrubar a tela.
    salvarConfig(escolherProvedor(c, 'claude', { modelo: 'm', apiKey: 'k' }));
});

teste('conteudo corrompido ou de outra versao: cai no inicial', () => {
    for (const lixo of ['{', 'null', '"texto"', '[]', '{"provedor":42,"porProvedor":"x"}']) {
        const { dados } = instalarArmazenamento();
        dados.set('spc-cml-juiz-llm', lixo);
        const c = carregarConfig();
        assert.equal(c.provedor, JUIZ_LOCAL, `nao tratou: ${lixo}`);
        assert.deepEqual(c.porProvedor, {}, `nao tratou: ${lixo}`);
    }
});

teste('campos de tipo errado dentro de um provedor viram texto vazio', () => {
    const { dados } = instalarArmazenamento();
    dados.set('spc-cml-juiz-llm', JSON.stringify({ provedor: 'gpt', porProvedor: { gpt: { modelo: 7, apiKey: null } } }));
    const c = carregarConfig();
    assert.equal(c.provedor, 'gpt');
    assert.deepEqual(dadosDoProvedor(c, 'gpt'), { modelo: '', apiKey: '' });
});

console.log('\nO pedido mandado ao servidor');

teste('juiz local nao manda nada: o servidor ja usa o modelo do motor', () => {
    assert.equal(pedidoDoJuizLLM(configInicial()), undefined);
});

teste('juiz de fronteira manda provedor, e so o que foi preenchido', () => {
    const comTudo = escolherProvedor(configInicial(), 'gemini', { modelo: 'gemini-2.5-flash-lite', apiKey: 'k' });
    assert.deepEqual(pedidoDoJuizLLM(comTudo), { provedor: 'gemini', modelo: 'gemini-2.5-flash-lite', apiKey: 'k' });

    // Chave em branco significa "use a do ambiente do servidor": o campo nem vai.
    const semChave = escolherProvedor(configInicial(), 'gpt', { modelo: 'gpt-5.1', apiKey: '   ' });
    assert.deepEqual(pedidoDoJuizLLM(semChave), { provedor: 'gpt', modelo: 'gpt-5.1' });

    // Sem modelo: o servidor usa o padrao do provedor.
    const soProvedor = escolherProvedor(configInicial(), 'deepseek', { modelo: '', apiKey: 'k' });
    assert.deepEqual(pedidoDoJuizLLM(soProvedor), { provedor: 'deepseek', apiKey: 'k' });
});

console.log('\nO teste de conexao: qual peca esta errada');

/** Uma falha de teste com a causa que o servidor mandaria. */
function falha(causa: CausaFalhaTeste, status?: number): ResultadoTesteJuiz {
    return {
        ok: false,
        provedor: 'gemini',
        modelo: 'gemini-3.8-flash',
        ms: 800,
        erro: 'juiz gemini (gemini-3.8-flash): o provedor respondeu …',
        causa,
        ...(status !== undefined ? { status } : {}),
        chaveDoAmbiente: false
    };
}

/** O estado de uma peca no diagnostico. */
function estado(resultado: ResultadoTesteJuiz, peca: PecaTeste): EstadoPeca {
    const linha = diagnosticoDoTeste(resultado).linhas.find(l => l.peca === peca);
    assert.ok(linha, `o diagnostico nao tem a linha de ${peca}`);
    return linha.estado;
}

teste('teste bem-sucedido: as tres pecas passaram', () => {
    const ok: ResultadoTesteJuiz = {
        ok: true,
        provedor: 'gemini',
        modelo: 'gemini-2.5-pro',
        ms: 1200,
        veredito: 'VALID',
        chaveDoAmbiente: false
    };
    const d = diagnosticoDoTeste(ok);
    assert.deepEqual(
        d.linhas.map(l => l.estado),
        ['ok', 'ok', 'ok']
    );
    assert.match(d.acao, /Nada a corrigir/);
});

// O caso que motivou tudo isto: "This model is currently experiencing high
// demand" parece erro de configuracao e nao e.
teste('503 do provedor: chave e modelo ficam OK, o errado e o provedor', () => {
    const r = falha('provedor', 503);
    assert.equal(estado(r, 'chave'), 'ok');
    assert.equal(estado(r, 'modelo'), 'ok');
    assert.equal(estado(r, 'provedor'), 'falhou');
    assert.match(diagnosticoDoTeste(r).acao, /tente de novo/i, 'o conselho e esperar, nao mexer na chave');
    assert.match(tituloDaFalha(r), /nao e a sua configuracao|não é a sua configuração/);
    assert.match(tituloDaFalha(r), /503/, 'o status ajuda quem for procurar na documentacao do provedor');
});

teste('cota estourada: nenhuma peca esta errada', () => {
    const r = falha('cota', 429);
    assert.deepEqual(
        diagnosticoDoTeste(r).linhas.map(l => l.estado),
        ['ok', 'ok', 'ok'],
        '429 so acusa o limite de uso'
    );
});

teste('chave recusada: o modelo fica INDEFINIDO, nao aprovado', () => {
    const r = falha('chave', 401);
    assert.equal(estado(r, 'chave'), 'falhou');
    assert.equal(estado(r, 'modelo'), 'indefinido', 'o provedor parou na autenticacao: dizer que o modelo serve seria inventar');
    assert.equal(estado(r, 'provedor'), 'ok', 'ele respondeu — a resposta e que foi uma recusa');
});

teste('modelo inexistente: a chave fica OK, porque o provedor autenticou antes', () => {
    const r = falha('modelo', 404);
    assert.equal(estado(r, 'chave'), 'ok');
    assert.equal(estado(r, 'modelo'), 'falhou');
});

teste('provedor inacessivel: nada foi provado sobre chave nem modelo', () => {
    const r = falha('rede');
    assert.equal(estado(r, 'chave'), 'indefinido');
    assert.equal(estado(r, 'modelo'), 'indefinido');
    assert.equal(estado(r, 'provedor'), 'falhou');
});

teste('resposta fora do formato: chave e modelo servem, o modelo e que nao segue o contrato', () => {
    const r = falha('formato');
    assert.equal(estado(r, 'chave'), 'ok');
    assert.equal(estado(r, 'modelo'), 'ok');
    assert.match(diagnosticoDoTeste(r).acao, /NO_RESPONSE/, 'vale dizer no que isto daria numa avaliacao');
});

teste('sem causa (servidor antigo): nao se afirma nada sobre chave nem modelo', () => {
    const semCausa: ResultadoTesteJuiz = { ...falha('desconhecida'), causa: undefined };
    assert.equal(estado(semCausa, 'chave'), 'indefinido');
    assert.equal(estado(semCausa, 'modelo'), 'indefinido');
});

console.log(falhas === 0 ? '\nTodos os testes da escolha do LLM Judge passaram.' : `\n${falhas} teste(s) falharam.`);
if (falhas > 0) process.exit(1);
