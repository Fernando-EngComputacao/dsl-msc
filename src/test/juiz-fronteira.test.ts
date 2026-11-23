/**
 * O LLM Judge num modelo de FRONTEIRA (src/inference/juiz-fronteira.ts).
 * Executar (da raiz): npm run test:juiz-fronteira
 *
 * Nenhuma chamada de rede: o `fetch` e a espera entre repeticoes sao injetados.
 * O que se cobra e exatamente o que faz a troca de modelo ser uma troca de
 * MODELO, e nada mais:
 *
 *   1. MESMO PROMPT: `INSTRUCAO_JULGAMENTO` e, caractere a caractere, o
 *      `JULGAMENTO_INSTRUCAO` de src/python_engine/julgamento.py — o teste le o
 *      .py. Mudar um lado sem o outro falha aqui;
 *   2. mesma montagem: `montarPromptJulgamento` repete `montar_prompt_julgamento`
 *      (uma passada so, textos de campo vazio iguais) e poe o PedidoJuiz inteiro
 *      no prompt — pedido, telemetria, conhecimento, evidencias e plano;
 *   3. a leitura da resposta aceita FORMATACAO (cerca, negrito, acento, texto em
 *      volta) e nao aceita CONTEUDO fora do contrato: campo faltando ou veredito
 *      estranho levantam `JulgamentoIlegivel`, e nenhum veredito e escolhido no
 *      lugar do modelo;
 *   4. cada provedor monta o pedido no SEU formato (cabecalho de autenticacao,
 *      corpo, onde fica o texto) e le a resposta de onde ela esta;
 *   5. a CHAVE nunca vaza: nem em mensagem de erro, nem em corpo de log;
 *   6. 429/5xx repetem com espera; 401/403 e resposta ilegivel nao repetem;
 *   7. cancelamento propaga como AbortError, sem repetir.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { PedidoJuiz } from '../inference/avaliar-grafo.js';
import {
    causaDoStatus,
    chaveDoAmbiente,
    ehProvedorFronteira,
    ehProvedorJuiz,
    INSTRUCAO_JULGAMENTO,
    JulgamentoIlegivel,
    juizFronteira,
    lerJulgamento,
    modeloDoJuiz,
    montarPromptJulgamento,
    PEDIDO_TESTE_CONEXAO,
    PROVEDORES,
    PROVEDORES_FRONTEIRA,
    testarConexaoJuiz,
    type ProvedorFronteira
} from '../inference/juiz-fronteira.js';

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

const CHAVE = 'sk-chave-secreta-de-teste-0123456789';

const PEDIDO: PedidoJuiz = {
    plano: 'plano Plano_X para Choque_Septico { }',
    pedido: 'PAM 52 e lactato 4.2: subo a noradrenalina?',
    telemetria: '- PAM = 52\n- lactato = 4.2',
    conhecimento: '[CENARIO]\nPT-2026-4001\n[POLITICA VIGENTE]\n- Incrementar_Vasopressor',
    evidencias: '- regra Choque/PAM avaliada pelo Cypher'
};

const RESPOSTA_BOA = 'evidencias: PAM 52 abaixo de 65; politica admite incremento\njustificativa: o plano segue a politica\nveredito: VALID';

/** Uma resposta do provedor, no formato dele. */
function cargaDoProvedor(provedor: ProvedorFronteira, texto: string): unknown {
    if (provedor === 'claude') return { content: [{ type: 'text', text: texto }] };
    if (provedor === 'gemini') return { candidates: [{ content: { parts: [{ text: texto }] } }] };
    return { choices: [{ message: { content: texto } }] };
}

interface Chamada {
    url: string;
    cabecalhos: Record<string, string>;
    corpo: Record<string, unknown>;
}

/** Um `fetch` de mentira: guarda o que foi pedido e devolve o que o teste mandar. */
function falsoFetch(respostas: Array<{ status?: number; carga?: unknown; texto?: string; cabecalhos?: Record<string, string> }>): {
    buscar: typeof fetch;
    chamadas: Chamada[];
} {
    const chamadas: Chamada[] = [];
    let i = 0;
    const buscar = (async (url: string | URL | Request, init?: RequestInit) => {
        const r = respostas[Math.min(i, respostas.length - 1)];
        i++;
        chamadas.push({
            url: String(url),
            cabecalhos: (init?.headers ?? {}) as Record<string, string>,
            corpo: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        });
        const status = r.status ?? 200;
        const corpo = r.texto ?? JSON.stringify(r.carga ?? {});
        return new Response(corpo, {
            status,
            headers: { 'Content-Type': 'application/json', ...(r.cabecalhos ?? {}) }
        });
    }) as unknown as typeof fetch;
    return { buscar, chamadas };
}

const semEspera = async (): Promise<void> => undefined;

// ===========================================================================
console.log('\nO prompt: o mesmo do motor local');

teste('INSTRUCAO_JULGAMENTO e copia literal de JULGAMENTO_INSTRUCAO (julgamento.py)', () => {
    const py = fs.readFileSync(path.join('src', 'python_engine', 'julgamento.py'), 'utf-8');
    const achado = /JULGAMENTO_INSTRUCAO = """([\s\S]*?)"""/.exec(py);
    assert.ok(achado, 'nao achei JULGAMENTO_INSTRUCAO no julgamento.py');
    assert.equal(
        INSTRUCAO_JULGAMENTO,
        achado[1],
        'o prompt do juiz de fronteira divergiu do do motor local: os dois tem de ser o MESMO texto'
    );
});

teste('montarPromptJulgamento poe o PedidoJuiz inteiro no prompt, sem marcador sobrando', () => {
    const prompt = montarPromptJulgamento(PEDIDO);
    for (const [campo, valor] of Object.entries(PEDIDO)) {
        assert.ok(prompt.includes(valor), `o prompt nao traz ${campo}`);
    }
    assert.ok(!/\{(pedido|telemetria|conhecimento|evidencias|plano)\}/.test(prompt), 'sobrou marcador sem substituir');
    // As secoes do contrato continuam lá, com os nomes que o motor usa.
    for (const secao of ['[PEDIDO]', '[TELEMETRIA]', '[CONHECIMENTO RECUPERADO]', '[EVIDENCIAS]', '[PLANO]']) {
        assert.ok(prompt.includes(secao), `secao ausente: ${secao}`);
    }
});

teste('campo vazio vira o mesmo texto do motor; plano vazio tem o seu', () => {
    const prompt = montarPromptJulgamento({ plano: '  ', pedido: '', telemetria: '\n', conhecimento: '', evidencias: '' });
    assert.ok(prompt.includes('(plano vazio)'), 'plano vazio sem o texto do motor');
    assert.equal(prompt.match(/\(nao informado\)/g)?.length, 4, 'os quatro campos vazios deviam virar "(nao informado)"');
});

teste('uma passada so: um marcador DENTRO do conhecimento e texto, nao marcador', () => {
    const prompt = montarPromptJulgamento({ ...PEDIDO, conhecimento: 'a regra fala de {plano} e de {pedido}' });
    assert.ok(prompt.includes('a regra fala de {plano} e de {pedido}'), 'o texto do conhecimento foi reescrito');
});

// ===========================================================================
console.log('\nA leitura da resposta');

teste('resposta no formato: veredito, justificativa e evidencias separadas', () => {
    const r = lerJulgamento(RESPOSTA_BOA);
    assert.equal(r.veredito, 'VALID');
    assert.equal(r.justificativa, 'o plano segue a politica');
    assert.deepEqual(r.evidencias, ['PAM 52 abaixo de 65', 'politica admite incremento']);
    assert.equal(r.respostaBruta, RESPOSTA_BOA, 'a resposta bruta e guardada como veio');
});

teste('formatacao e tolerada: cerca, negrito, acento, maiuscula e texto em volta', () => {
    const bagunca = [
        'Claro! Aqui esta a minha analise.',
        '```',
        '- **Evidências:** vento 14 km/h acima do limite; politica proibe',
        '  **justificativa**: o plano aplica com vento acima do limite',
        '**VEREDITO:** INVALID',
        '```'
    ].join('\n');
    const r = lerJulgamento(bagunca);
    assert.equal(r.veredito, 'INVALID');
    assert.equal(r.justificativa, 'o plano aplica com vento acima do limite');
    assert.deepEqual(r.evidencias, ['vento 14 km/h acima do limite', 'politica proibe']);
});

teste('do veredito le-se o primeiro termo, nao o comentario em volta', () => {
    const r = lerJulgamento('evidencias: a\njustificativa: b\nveredito: UNRESOLVED (falta a medida)');
    assert.equal(r.veredito, 'UNRESOLVED');
});

teste('a PRIMEIRA ocorrencia de cada campo e a que vale', () => {
    const r = lerJulgamento('evidencias: primeira\njustificativa: j\nveredito: VALID\nveredito: INVALID');
    assert.equal(r.veredito, 'VALID');
    assert.equal(r.evidencias?.[0], 'primeira');
});

teste('campo faltando, vazio ou veredito estranho: JulgamentoIlegivel, sem inventar veredito', () => {
    const ruins = [
        ['sem veredito', 'evidencias: a\njustificativa: b'],
        ['sem justificativa', 'evidencias: a\nveredito: VALID'],
        ['sem evidencias', 'justificativa: b\nveredito: VALID'],
        ['veredito vazio', 'evidencias: a\njustificativa: b\nveredito:'],
        ['veredito fora do contrato', 'evidencias: a\njustificativa: b\nveredito: CORRETO'],
        ['veredito negado em prosa', 'evidencias: a\njustificativa: b\nveredito: nao e INVALID'],
        ['resposta vazia', ''],
        ['so prosa', 'O plano me parece correto, aprovo.']
    ] as const;
    for (const [caso, texto] of ruins) {
        assert.throws(() => lerJulgamento(texto), JulgamentoIlegivel, `devia recusar: ${caso}`);
    }
});

// ===========================================================================
console.log('\nOs provedores');

teste('o catalogo cobre os quatro provedores, com modelo padrao e variavel de ambiente', () => {
    assert.deepEqual([...PROVEDORES_FRONTEIRA], ['claude', 'gpt', 'gemini', 'deepseek']);
    for (const id of PROVEDORES_FRONTEIRA) {
        const p = PROVEDORES[id];
        assert.ok(p.nome.length > 2, `${id}: nome`);
        assert.ok(p.modeloPadrao.length > 2, `${id}: modelo padrao`);
        assert.ok(p.variaveisDeAmbiente.length > 0, `${id}: variavel de ambiente`);
        assert.match(p.url(p.modeloPadrao), /^https:\/\//, `${id}: a URL tem de ser https`);
    }
    assert.ok(ehProvedorFronteira('claude') && !ehProvedorFronteira('local') && !ehProvedorFronteira('qwen'));
    assert.ok(ehProvedorJuiz('local') && ehProvedorJuiz('gemini') && !ehProvedorJuiz('llama'));
});

teste('o modelo do pedido manda; em branco, o padrao do provedor', () => {
    assert.equal(modeloDoJuiz('claude', 'claude-sonnet-5-5'), 'claude-sonnet-5-5');
    assert.equal(modeloDoJuiz('claude', '   '), PROVEDORES.claude.modeloPadrao);
    assert.equal(modeloDoJuiz('gpt'), PROVEDORES.gpt.modeloPadrao);
});

teste('chaveDoAmbiente le as variaveis do provedor, na ordem', () => {
    assert.equal(chaveDoAmbiente('claude', { ANTHROPIC_API_KEY: 'a', CLAUDE_API_KEY: 'b' }), 'a');
    assert.equal(chaveDoAmbiente('claude', { CLAUDE_API_KEY: 'b' }), 'b');
    assert.equal(chaveDoAmbiente('gemini', { GOOGLE_API_KEY: 'g' }), 'g');
    assert.equal(chaveDoAmbiente('gpt', { OPENAI_API_KEY: '   ' }), undefined, 'chave em branco nao conta');
    assert.equal(chaveDoAmbiente('deepseek', {}), undefined);
});

for (const provedor of PROVEDORES_FRONTEIRA) {
    await testeAsync(`${provedor}: monta o pedido no formato dele e le a resposta de onde ela esta`, async () => {
        const { buscar, chamadas } = falsoFetch([{ carga: cargaDoProvedor(provedor, RESPOSTA_BOA) }]);
        const juiz = juizFronteira(provedor, CHAVE, { buscar, esperar: semEspera, modelo: 'modelo-de-teste' });
        const r = await juiz(PEDIDO, new AbortController().signal);

        assert.equal(r.veredito, 'VALID');
        assert.equal(chamadas.length, 1, 'uma chamada por julgamento');
        const c = chamadas[0];
        assert.equal(c.url, PROVEDORES[provedor].url('modelo-de-teste'));
        assert.equal(c.cabecalhos['Content-Type'], 'application/json');

        // A autenticacao no cabecalho do provedor, e a chave NUNCA na URL.
        const cabecalhos = JSON.stringify(c.cabecalhos);
        assert.ok(cabecalhos.includes(CHAVE), `${provedor}: a chave nao foi enviada`);
        assert.ok(!c.url.includes(CHAVE), `${provedor}: a chave foi para a URL`);

        // O prompt inteiro vai no corpo, qualquer que seja o formato.
        const corpo = JSON.stringify(c.corpo);
        assert.ok(corpo.includes('avaliador independente'), `${provedor}: o prompt nao foi enviado`);
        assert.ok(corpo.includes(JSON.stringify(PEDIDO.plano).slice(1, -1)), `${provedor}: o plano nao foi enviado`);
        if (provedor !== 'gemini') assert.equal(c.corpo.model, 'modelo-de-teste', `${provedor}: modelo no corpo`);
    });
}

await testeAsync('claude: cabecalho de versao da API e teto de tokens', async () => {
    const { buscar, chamadas } = falsoFetch([{ carga: cargaDoProvedor('claude', RESPOSTA_BOA) }]);
    await juizFronteira('claude', CHAVE, { buscar, esperar: semEspera })(PEDIDO, new AbortController().signal);
    assert.equal(chamadas[0].cabecalhos['anthropic-version'], '2023-06-01');
    assert.equal(chamadas[0].cabecalhos['x-api-key'], CHAVE);
    assert.ok(typeof chamadas[0].corpo.max_tokens === 'number', 'a API exige max_tokens');
});

await testeAsync('gpt: Bearer, e sem temperature nem teto (os modelos novos recusam)', async () => {
    const { buscar, chamadas } = falsoFetch([{ carga: cargaDoProvedor('gpt', RESPOSTA_BOA) }]);
    await juizFronteira('gpt', CHAVE, { buscar, esperar: semEspera })(PEDIDO, new AbortController().signal);
    assert.equal(chamadas[0].cabecalhos.Authorization, `Bearer ${CHAVE}`);
    assert.ok(!('temperature' in chamadas[0].corpo) && !('max_tokens' in chamadas[0].corpo));
});

await testeAsync('resposta sem texto no lugar esperado: erro, nao veredito', async () => {
    const { buscar } = falsoFetch([{ carga: { choices: [{ message: { refusal: 'nao posso' } }] } }]);
    await assert.rejects(
        juizFronteira('gpt', CHAVE, { buscar, esperar: semEspera })(PEDIDO, new AbortController().signal),
        /recusou|sem texto/
    );
});

// ===========================================================================
console.log('\nFalhas, repeticoes e a chave');

await testeAsync('429 repete com espera e aproveita a resposta boa da segunda vez', async () => {
    const { buscar, chamadas } = falsoFetch([
        { status: 429, texto: 'rate limited', cabecalhos: { 'retry-after': '2' } },
        { carga: cargaDoProvedor('claude', RESPOSTA_BOA) }
    ]);
    const esperas: number[] = [];
    const juiz = juizFronteira('claude', CHAVE, {
        buscar,
        esperar: async ms => {
            esperas.push(ms);
        }
    });
    const r = await juiz(PEDIDO, new AbortController().signal);
    assert.equal(r.veredito, 'VALID');
    assert.equal(chamadas.length, 2, 'devia ter repetido');
    assert.deepEqual(esperas, [2000], 'a espera devia seguir o retry-after do provedor');
});

await testeAsync('esgotadas as tentativas, a falha sobe dizendo quantas foram', async () => {
    const { buscar, chamadas } = falsoFetch([{ status: 503, texto: 'indisponivel' }]);
    await assert.rejects(
        juizFronteira('gemini', CHAVE, { buscar, esperar: semEspera, tentativas: 3 })(PEDIDO, new AbortController().signal),
        /3 tentativa/
    );
    assert.equal(chamadas.length, 3);
});

await testeAsync('401 nao repete: chave recusada e falha definitiva', async () => {
    const { buscar, chamadas } = falsoFetch([{ status: 401, texto: 'invalid api key' }]);
    await assert.rejects(
        juizFronteira('deepseek', CHAVE, { buscar, esperar: semEspera })(PEDIDO, new AbortController().signal),
        /chave de API recusada/
    );
    assert.equal(chamadas.length, 1, 'repetir com a chave errada so gastaria chamada');
});

await testeAsync('resposta ilegivel nao repete: o modelo respondeu, so nao no formato', async () => {
    const { buscar, chamadas } = falsoFetch([{ carga: cargaDoProvedor('claude', 'acho que esta bom') }]);
    await assert.rejects(
        juizFronteira('claude', CHAVE, { buscar, esperar: semEspera, tentativas: 3 })(PEDIDO, new AbortController().signal),
        /resposta do juiz sem/
    );
    assert.equal(chamadas.length, 1);
});

await testeAsync('a chave nunca aparece na mensagem de erro', async () => {
    const casos: Array<{ status: number; texto: string }> = [
        { status: 401, texto: `chave ${CHAVE} invalida` },
        { status: 400, texto: `modelo desconhecido (chave ${CHAVE})` },
        { status: 500, texto: CHAVE }
    ];
    for (const caso of casos) {
        const { buscar } = falsoFetch([caso]);
        const erro = await juizFronteira('gpt', CHAVE, { buscar, esperar: semEspera, tentativas: 1 })(
            PEDIDO,
            new AbortController().signal
        ).then(
            () => null,
            (e: Error) => e
        );
        assert.ok(erro, `${caso.status}: devia falhar`);
        // A mensagem vira `julgamentoLLM.motivo` e vai para o JSONL: nem mesmo o
        // corpo ecoado pelo provedor pode levar a chave.
        assert.ok(!erro.message.includes(CHAVE), `a chave vazou na mensagem de ${caso.status}: ${erro.message}`);
        assert.ok(erro.message.includes('[chave omitida]'), 'o trecho com a chave devia ficar marcado');
        assert.match(erro.message, /^juiz gpt \(/, 'a mensagem devia nomear provedor e modelo');
    }
});

await testeAsync('sem chave nenhuma, nao chama o provedor', async () => {
    const { buscar, chamadas } = falsoFetch([{ carga: cargaDoProvedor('claude', RESPOSTA_BOA) }]);
    await assert.rejects(
        juizFronteira('claude', '   ', { buscar, esperar: semEspera })(PEDIDO, new AbortController().signal),
        /nenhuma chave de API/
    );
    assert.equal(chamadas.length, 0);
});

await testeAsync('cancelamento sobe como AbortError e nao repete', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { buscar, chamadas } = falsoFetch([{ carga: cargaDoProvedor('claude', RESPOSTA_BOA) }]);
    const erro = await juizFronteira('claude', CHAVE, { buscar, esperar: semEspera })(PEDIDO, ctrl.signal).then(
        () => null,
        (e: Error) => e
    );
    assert.equal(erro?.name, 'AbortError');
    assert.equal(chamadas.length, 0);
});

// ===========================================================================
console.log('\nO teste de conexao: a mesma chamada, um julgamento de brinquedo');

await testeAsync('conexao boa: devolve ok, o modelo chamado e o veredito do teste', async () => {
    const { buscar, chamadas } = falsoFetch([{ carga: cargaDoProvedor('claude', RESPOSTA_BOA) }]);
    const r = await testarConexaoJuiz('claude', CHAVE, { buscar, esperar: semEspera });
    assert.equal(r.ok, true);
    assert.equal(r.provedor, 'claude');
    assert.equal(r.modelo, PROVEDORES.claude.modeloPadrao, 'sem modelo no pedido, testa o padrao do provedor');
    assert.equal(r.veredito, 'VALID');
    assert.equal(r.erro, undefined);
    assert.ok(r.ms >= 0, 'devia medir quanto a chamada levou');
    assert.equal(chamadas.length, 1, 'o teste e UMA chamada');
    // O caminho e o da avaliacao: mesma URL, mesmo cabecalho de autenticacao.
    assert.equal(chamadas[0].url, PROVEDORES.claude.url(PROVEDORES.claude.modeloPadrao));
    assert.equal(chamadas[0].cabecalhos['x-api-key'], CHAVE);
});

await testeAsync('o que vai ao provedor e um julgamento de verdade, com o prompt do juiz', async () => {
    const { buscar, chamadas } = falsoFetch([{ carga: cargaDoProvedor('gpt', RESPOSTA_BOA) }]);
    await testarConexaoJuiz('gpt', CHAVE, { buscar, esperar: semEspera });
    const mensagens = chamadas[0].corpo.messages as Array<{ content: string }>;
    const prompt = mensagens[0].content;
    assert.equal(prompt, montarPromptJulgamento(PEDIDO_TESTE_CONEXAO), 'o teste tem de usar o MESMO prompt do juiz');
    assert.ok(prompt.includes(PEDIDO_TESTE_CONEXAO.plano), 'o plano de brinquedo devia estar no prompt');
});

await testeAsync('o modelo do pedido e o que vai ser testado', async () => {
    const { buscar, chamadas } = falsoFetch([{ carga: cargaDoProvedor('gemini', RESPOSTA_BOA) }]);
    const r = await testarConexaoJuiz('gemini', CHAVE, { modelo: 'gemini-9-nao-existe', buscar, esperar: semEspera });
    assert.equal(r.modelo, 'gemini-9-nao-existe');
    assert.ok(chamadas[0].url.includes('gemini-9-nao-existe'), 'a URL devia nomear o modelo pedido');
});

await testeAsync('chave recusada vira resultado, nao excecao', async () => {
    const { buscar, chamadas } = falsoFetch([{ status: 401, texto: 'invalid api key' }]);
    const r = await testarConexaoJuiz('deepseek', CHAVE, { buscar, esperar: semEspera });
    assert.equal(r.ok, false);
    assert.match(r.erro ?? '', /chave de API recusada/);
    assert.equal(r.causa, 'chave');
    assert.equal(r.status, 401);
    assert.equal(r.veredito, undefined, 'sem resposta, nenhum veredito');
    assert.equal(chamadas.length, 1);
});

await testeAsync('resposta fora do formato do juiz reprova o teste', async () => {
    const { buscar } = falsoFetch([{ carga: cargaDoProvedor('claude', 'acho que esta bom') }]);
    const r = await testarConexaoJuiz('claude', CHAVE, { buscar, esperar: semEspera });
    assert.equal(r.ok, false);
    assert.match(r.erro ?? '', /resposta do juiz sem/);
    assert.equal(r.causa, 'formato', 'a chave e o modelo serviram: quem nao serviu foi a resposta');
});

await testeAsync('sem chave, nao chama o provedor e o motivo e esse', async () => {
    const { buscar, chamadas } = falsoFetch([{ carga: cargaDoProvedor('claude', RESPOSTA_BOA) }]);
    const r = await testarConexaoJuiz('claude', '  ', { buscar, esperar: semEspera });
    assert.equal(r.ok, false);
    assert.match(r.erro ?? '', /nenhuma chave de API/);
    assert.equal(r.causa, 'chave');
    assert.equal(chamadas.length, 0);
});

await testeAsync('o teste nao repete: 429 volta na hora, com o status do provedor', async () => {
    const { buscar, chamadas } = falsoFetch([{ status: 429, texto: 'rate limit' }]);
    const r = await testarConexaoJuiz('gpt', CHAVE, { buscar, esperar: semEspera });
    assert.equal(r.ok, false);
    assert.match(r.erro ?? '', /429/, 'quem testa quer ver o status que o provedor deu');
    assert.equal(r.causa, 'cota', '429 nao acusa a chave nem o modelo: acusa o limite de uso');
    assert.equal(r.status, 429);
    assert.equal(chamadas.length, 1, 'esperar a espera exponencial da avaliacao nao serve a quem olha a tela');
});

// A pergunta que a tela tem de responder: QUAL peca esta errada. 5xx e 429 sao
// os casos em que a resposta certa e "nenhuma das suas".
await testeAsync('503 do modelo sobrecarregado acusa o provedor, nao a chave nem o modelo', async () => {
    const { buscar } = falsoFetch([
        {
            status: 503,
            texto: '{ "error": { "code": 503, "message": "This model is currently experiencing high demand.", "status": "UNAVAILABLE" } }'
        }
    ]);
    const r = await testarConexaoJuiz('gemini', CHAVE, { modelo: 'gemini-3.8-flash', buscar, esperar: semEspera });
    assert.equal(r.ok, false);
    assert.equal(r.causa, 'provedor');
    assert.equal(r.status, 503);
    assert.equal(r.modelo, 'gemini-3.8-flash');
});

await testeAsync('404 acusa o modelo: a chave passou, o nome e que nao existe', async () => {
    const { buscar } = falsoFetch([{ status: 404, texto: 'models/x is not found for API version v1beta' }]);
    const r = await testarConexaoJuiz('gemini', CHAVE, { modelo: 'x', buscar, esperar: semEspera });
    assert.equal(r.causa, 'modelo');
    assert.equal(r.status, 404);
});

await testeAsync('400 com API_KEY_INVALID (jeito do Gemini) acusa a chave', async () => {
    const { buscar } = falsoFetch([
        { status: 400, texto: '{ "error": { "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT" } }' }
    ]);
    const r = await testarConexaoJuiz('gemini', CHAVE, { buscar, esperar: semEspera });
    assert.equal(r.causa, 'chave', 'o Gemini recusa chave com 400, nao com 401');
});

await testeAsync('provedor inacessivel acusa a rede, e nada sobre chave ou modelo', async () => {
    const buscar = (async () => {
        throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const r = await testarConexaoJuiz('claude', CHAVE, { buscar, esperar: semEspera });
    assert.equal(r.ok, false);
    assert.equal(r.causa, 'rede');
    assert.equal(r.status, undefined);
});

teste('causaDoStatus: o status manda, o corpo so desempata o 400', () => {
    assert.equal(causaDoStatus(401, ''), 'chave');
    assert.equal(causaDoStatus(403, 'permission denied'), 'chave');
    assert.equal(causaDoStatus(404, 'model not found'), 'modelo');
    assert.equal(causaDoStatus(429, 'rate limit'), 'cota');
    assert.equal(causaDoStatus(500, ''), 'provedor');
    assert.equal(causaDoStatus(503, 'high demand'), 'provedor');
    assert.equal(causaDoStatus(400, 'API key not valid'), 'chave');
    assert.equal(causaDoStatus(400, 'model: unknown model'), 'modelo');
    assert.equal(causaDoStatus(400, 'something else entirely'), 'desconhecida');
    assert.equal(causaDoStatus(418, ''), 'desconhecida');
});

await testeAsync('a chave nao vaza no motivo da falha do teste', async () => {
    const { buscar } = falsoFetch([{ status: 400, texto: `modelo desconhecido (chave ${CHAVE})` }]);
    const r = await testarConexaoJuiz('gpt', CHAVE, { buscar, esperar: semEspera });
    assert.equal(r.ok, false);
    assert.ok(!(r.erro ?? '').includes(CHAVE), `a chave vazou no resultado do teste: ${r.erro}`);
});

await testeAsync('cancelamento do teste sobe como AbortError', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { buscar, chamadas } = falsoFetch([{ carga: cargaDoProvedor('claude', RESPOSTA_BOA) }]);
    const erro = await testarConexaoJuiz('claude', CHAVE, { buscar, esperar: semEspera, sinal: ctrl.signal }).then(
        () => null,
        (e: Error) => e
    );
    assert.equal(erro?.name, 'AbortError', 'cancelar nao e um teste reprovado');
    assert.equal(chamadas.length, 0);
});

console.log(falhas === 0 ? '\nTodos os testes do juiz de fronteira passaram.' : `\n${falhas} teste(s) falharam.`);
if (falhas > 0) process.exit(1);
