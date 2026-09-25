/**
 * Abstracao do LLM (`inference/motor-llm.ts`) e a separacao entre GERACAO
 * SEMANTICA e REALIZACAO GRAMATICAL.
 *
 * Roda OFFLINE. O motor local e dublado por um servidor HTTP de verdade nesta
 * mesma maquina: o teste exercita o `fetch`, as rotas e os corpos que o motor
 * Python recebe — e o caminho de producao, so que com respostas fixas.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspect, parseEnv } from 'node:util';

import { loadModel } from '../database/neo4j.js';
import { retrieveConstraints, pruningPayload, type ClinicalContext } from '../knowledge/graphrag.js';
import type { SubgrafoPodado } from '../knowledge/politica.js';
import { montarEntradaGeracao, montarPromptSemantico } from '../inference/llm-client.js';
import { chamarMotor, decodificar, motorFragmentoDe, motorHttp } from '../inference/decodificacao.js';
import { criarMotorLLM } from '../inference/fabrica-motor-llm.js';
import { MotorLlamaCpp } from '../inference/motor-llamacpp.js';
import {
    CAPACIDADES_LLM,
    ErroCapacidadeLLM,
    ErroConfiguracaoLLM,
    descreverConfiguracaoLLM,
    exigirRealizacaoGramatical,
    lerConfiguracaoLLM,
    type MotorLLM,
    type PedidoGeracaoSemantica,
    type PedidoRealizacaoGramatical,
    type ResultadoRealizacao
} from '../inference/motor-llm.js';
import { gerarPlanoSemantico, montarPedidoSemantico } from '../inference/geracao-semantica.js';

let falhas = 0;
function teste(nome: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok   ${nome}`))
        .catch((erro: Error) => {
            falhas++;
            console.log(`  FALHA ${nome}\n       ${erro.message}`);
        });
}

/** Configuracao so a partir do ambiente dado, sem ler `.env` da maquina. */
const config = (env: Record<string, string>) => lerConfiguracaoLLM({ env, arquivoEnv: null });

// =============================================================================
// Motor local dublado
// =============================================================================

interface Pedido {
    rota: string;
    corpo: Record<string, unknown>;
}

type Responder = (p: Pedido) => { status?: number; corpo: unknown };

async function motorLocal(responder: Responder): Promise<{ url: string; pedidos: Pedido[]; fechar: () => Promise<void> }> {
    const pedidos: Pedido[] = [];
    const servidor = http.createServer((req, res) => {
        let bruto = '';
        req.on('data', c => (bruto += c));
        req.on('end', () => {
            const pedido = { rota: req.url ?? '', corpo: bruto ? JSON.parse(bruto) : {} };
            pedidos.push(pedido);
            const { status = 200, corpo } = responder(pedido);
            res.writeHead(status, { 'Content-Type': typeof corpo === 'string' ? 'text/plain' : 'application/json' });
            res.end(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
        });
    });
    await new Promise<void>(r => servidor.listen(0, '127.0.0.1', r));
    const { port } = servidor.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        pedidos,
        fechar: () => new Promise<void>(r => servidor.close(() => r()))
    };
}

/** O que o motor de verdade devolve em cada rota, com valores fixos. */
const respostaPadrao: Responder = ({ rota, corpo }) => {
    if (rota === '/generate-constrained') {
        return { corpo: { resultado: 'plano P para X { }', valido: true, erro: null, g_hat_utilizada: 'g', regras_em_g_hat: 7, especializada: true, modelo: 'qwen-teste' } };
    }
    if (rota === '/generate-fragment') {
        return corpo.encerramento
            ? { corpo: { fragmento: '', encerrou: true, especializada: true, regras_em_g_hat: 3, modelo: 'qwen-teste' } }
            : { corpo: { fragmento: 'Plano_Teste', encerrou: false, especializada: true, regras_em_g_hat: 3, modelo: 'qwen-teste' } };
    }
    if (rota === '/generate-semantic') {
        return { corpo: { texto: 'Noradrenalina | AUMENTAR_VAZAO | PAM 52', modelo: 'qwen-teste', backend: 'llamacpp', tokens_entrada: 120, tokens_saida: 14, motivo_parada: 'stop', latencia_ms: 5 } };
    }
    return { status: 404, corpo: 'Not Found' };
};

/** Um backend que nao sabe restringir por gramatica, e registra o que lhe pedem. */
function motorSemGramatica(): MotorLLM & { pedidos: PedidoGeracaoSemantica[] } {
    const pedidos: PedidoGeracaoSemantica[] = [];
    return {
        backend: 'openai',
        capacidades: CAPACIDADES_LLM.openai,
        pedidos,
        async gerarPlanoSemantico(p) {
            pedidos.push(p);
            return { texto: 'plano proposto', modelo: 'dublado', backend: 'openai' };
        }
    };
}

/** Um backend com gramatica que responde como o motor local, sem rede. */
function motorComGramatica(): MotorLLM & { realizacoes: PedidoRealizacaoGramatical[] } {
    const realizacoes: PedidoRealizacaoGramatical[] = [];
    return {
        backend: 'llamacpp',
        capacidades: CAPACIDADES_LLM.llamacpp,
        realizacoes,
        async gerarPlanoSemantico() {
            return { texto: 'plano proposto', modelo: 'dublado', backend: 'llamacpp' };
        },
        async realizarComGramatica(p): Promise<ResultadoRealizacao> {
            realizacoes.push(p);
            if (p.fragmento) {
                return p.fragmento.encerramento
                    ? { texto: '', modelo: 'dublado', backend: 'llamacpp', encerrou: true, especializada: true }
                    : { texto: 'Plano_Teste', modelo: 'dublado', backend: 'llamacpp', encerrou: false, especializada: true };
            }
            return { texto: 'plano P para X { }', modelo: 'dublado', backend: 'llamacpp', valido: true, erro: null, regrasEmGHat: 7, especializada: true };
        }
    };
}

/** Executa `fn` com variaveis de ambiente trocadas, e devolve o ambiente como estava. */
async function comAmbiente<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const antes: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
        antes[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(antes)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

// =============================================================================

async function main(): Promise<void> {
    const model = await loadModel('src/examples/med/uti.dsl');
    const MED: ClinicalContext = {
        paciente: 'PT-2026-0031',
        intencao: 'sobe a noradrenalina',
        telemetria: { PAM: 52, FC: 145, lactato: 4.8, RASS: 2, TFG: 28, plaquetas: 45, glicemia: 210 },
        populacoes: ['Renal_Cronico'],
        farmacosEmUso: ['Noradrenalina', 'Propofol', 'Vancomicina']
    };
    const constraints = retrieveConstraints(model, MED);
    const politica: SubgrafoPodado = pruningPayload(constraints, MED);
    const entrada = montarEntradaGeracao(MED, constraints, model);

    console.log('\n[1. selecao do backend]');

    await teste('LLM_BACKEND=llamacpp: motor local, com gramatica', () => {
        const motor = criarMotorLLM(config({ LLM_BACKEND: 'llamacpp' }));
        assert.ok(motor instanceof MotorLlamaCpp);
        assert.equal(motor.backend, 'llamacpp');
        assert.equal(motor.capacidades.gramatica, true);
    });

    await teste('o nome e lido sem diferenciar caixa nem espacos', () => {
        assert.equal(config({ LLM_BACKEND: '  LlamaCpp ' }).backend, 'llamacpp');
    });

    for (const backend of ['openai', 'gemini'] as const) {
        await teste(`LLM_BACKEND=${backend}: reconhecido e validado, adaptador ainda nao existe`, () => {
            const prefixo = backend.toUpperCase();
            const c = config({ LLM_BACKEND: backend, [`${prefixo}_API_KEY`]: 'chave-de-teste', [`${prefixo}_MODEL`]: 'm' });
            assert.equal(c.backend, backend);
            assert.throws(() => criarMotorLLM(c), (e: Error) => e instanceof ErroConfiguracaoLLM && /Etapa 2/.test(e.message));
        });
    }

    console.log('\n[2. default llama.cpp]');

    await teste('sem nenhuma variavel: llamacpp no endpoint e timeout de sempre', () => {
        const c = config({});
        assert.equal(c.backend, 'llamacpp');
        assert.equal(c.llamacpp.endpoint, 'http://127.0.0.1:8000');
        assert.equal(c.llamacpp.timeoutMs, 600_000);
        assert.equal(c.reparoSemantico, true);
        assert.equal(c.maxTentativasSemanticas, 3);
        assert.ok(criarMotorLLM(c) instanceof MotorLlamaCpp);
    });

    await teste('usa SPC_CML_ENDPOINT e SPC_CML_TIMEOUT_MS, e o endpoint do dominio prevalece', () => {
        const c = config({ SPC_CML_ENDPOINT: 'http://motor:9000', SPC_CML_TIMEOUT_MS: '5000' });
        assert.equal((criarMotorLLM(c) as MotorLlamaCpp).endpoint, 'http://motor:9000');
        assert.equal((criarMotorLLM(c, { endpoint: 'http://agro:8001' }) as MotorLlamaCpp).endpoint, 'http://agro:8001');
    });

    await teste('.env e lido, e o ambiente prevalece sobre ele', () => {
        const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'spc-env-'));
        const arquivo = path.join(pasta, '.env');
        fs.writeFileSync(arquivo, 'SPC_CML_MAX_RETRIES=7\nSPC_CML_SEMANTIC_REPAIR=false\n');
        try {
            const soArquivo = lerConfiguracaoLLM({ env: {}, arquivoEnv: arquivo });
            assert.equal(soArquivo.maxTentativasSemanticas, 7);
            assert.equal(soArquivo.reparoSemantico, false);
            const comAmbienteTambem = lerConfiguracaoLLM({ env: { SPC_CML_MAX_RETRIES: '2' }, arquivoEnv: arquivo });
            assert.equal(comAmbienteTambem.maxTentativasSemanticas, 2);
        } finally {
            fs.rmSync(pasta, { recursive: true, force: true });
        }
    });

    console.log('\n[3. llama.cpp continua funcionando]');

    const motor = await motorLocal(respostaPadrao);
    try {
        await teste('artefato inteiro: POST /generate-constrained, mesmo corpo de sempre', async () => {
            motor.pedidos.length = 0;
            const r = await new MotorLlamaCpp({ endpoint: motor.url, timeoutMs: 5000 }).realizarComGramatica({
                comando: 'sobe a nora', contexto: 'prompt', subgrafo: politica
            });
            assert.deepEqual(motor.pedidos.map(p => p.rota), ['/generate-constrained']);
            assert.deepEqual(Object.keys(motor.pedidos[0].corpo), ['comando_humano', 'contexto_neo4j', 'subgrafo_regras']);
            assert.deepEqual(motor.pedidos[0].corpo.subgrafo_regras, JSON.parse(JSON.stringify(politica)));
            assert.equal(r.texto, 'plano P para X { }');
            assert.equal(r.valido, true);
            assert.equal(r.regrasEmGHat, 7);
            assert.equal(r.modelo, 'qwen-teste');
            assert.equal(r.backend, 'llamacpp');
        });

        await teste('fragmento: POST /generate-fragment, mesmo corpo de sempre', async () => {
            motor.pedidos.length = 0;
            const r = await new MotorLlamaCpp({ endpoint: motor.url, timeoutMs: 5000 }).realizarComGramatica({
                comando: 'c', contexto: 'p', subgrafo: politica, fragmento: { simbolo: 'conduta', prefixo: 'plano P', encerramento: ']' }
            });
            assert.deepEqual(Object.keys(motor.pedidos[0].corpo),
                ['simbolo', 'prefixo', 'comando_humano', 'contexto_neo4j', 'subgrafo_regras', 'encerramento']);
            assert.equal(motor.pedidos[0].corpo.encerramento, ']');
            assert.equal(r.encerrou, true);
        });

        await teste('chamarMotor e motorHttp mantem assinatura e resposta', async () => {
            motor.pedidos.length = 0;
            const artefato = await chamarMotor(
                { comando_humano: 'c', contexto_neo4j: 'p', subgrafo_regras: politica }, motor.url, 5000
            );
            assert.deepEqual(
                { resultado: artefato.resultado, valido: artefato.valido, erro: artefato.erro, g_hat_utilizada: artefato.g_hat_utilizada, regras_em_g_hat: artefato.regras_em_g_hat },
                { resultado: 'plano P para X { }', valido: true, erro: null, g_hat_utilizada: 'g', regras_em_g_hat: 7 }
            );
            const fragmento = await motorHttp(motor.url, 5000)(
                { simbolo: 'identificador', prefixo: '', subgrafo: politica }, { comando: 'c', contexto: 'p' }
            );
            assert.deepEqual({ fragmento: fragmento.fragmento, encerrou: fragmento.encerrou }, { fragmento: 'Plano_Teste', encerrou: false });
            assert.equal(motor.pedidos[1].corpo.encerramento, null);
        });

        await teste('decodificar (padrao, incremental) chega ao motor pelo adaptador', async () => {
            motor.pedidos.length = 0;
            await comAmbiente({ LLM_BACKEND: undefined, SPC_CML_DECODIFICACAO: undefined }, () =>
                decodificar({ ...entrada, endpoint: motor.url, timeoutMs: 5000 }));
            assert.ok(motor.pedidos.length > 0 && motor.pedidos.every(p => p.rota === '/generate-fragment'));
            assert.deepEqual(motor.pedidos[0].corpo.subgrafo_regras, JSON.parse(JSON.stringify(entrada.subgrafo)));
        });

        await teste('decodificar (monolitica) chega ao motor pelo adaptador', async () => {
            motor.pedidos.length = 0;
            const r = await comAmbiente({ LLM_BACKEND: undefined, SPC_CML_DECODIFICACAO: 'monolitica' }, () =>
                decodificar({ ...entrada, endpoint: motor.url, timeoutMs: 5000 }));
            assert.ok(motor.pedidos.length > 0 && motor.pedidos.every(p => p.rota === '/generate-constrained'));
            assert.equal(r.resultado, 'plano P para X { }');
        });

        await teste('as mensagens de erro de sempre: inacessivel, status HTTP, motor desatualizado', async () => {
            await assert.rejects(
                chamarMotor({ comando_humano: 'c', contexto_neo4j: 'p', subgrafo_regras: politica }, 'http://127.0.0.1:1', 2000),
                /http:\/\/127\.0\.0\.1:1 inacessivel: /
            );
            const recusa = await motorLocal(() => ({ status: 422, corpo: 'A poda eliminou o simbolo inicial' }));
            const velho = await motorLocal(() => ({ corpo: { fragmento: 'x', encerrou: false, especializada: false } }));
            try {
                await assert.rejects(
                    chamarMotor({ comando_humano: 'c', contexto_neo4j: 'p', subgrafo_regras: politica }, recusa.url, 2000),
                    new RegExp(`${recusa.url.replace(/[.]/g, '\\.')} respondeu 422: A poda eliminou`)
                );
                await assert.rejects(
                    motorHttp(velho.url, 2000)({ simbolo: 'ordem', prefixo: '', subgrafo: politica }, { comando: 'c', contexto: 'p' }),
                    /ignorou a politica por item: o motor esta desatualizado/
                );
            } finally {
                await recusa.fechar();
                await velho.fechar();
            }
        });

        await teste('geracao semantica: POST /generate-semantic, sem subgrafo nem gramatica', async () => {
            motor.pedidos.length = 0;
            const r = await new MotorLlamaCpp({ endpoint: motor.url, timeoutMs: 5000 }).gerarPlanoSemantico({
                sistema: 'Voce PROPOE.', usuario: 'sobe a nora', maxTokens: 64, temperatura: 0.2
            });
            assert.deepEqual(motor.pedidos.map(p => p.rota), ['/generate-semantic']);
            assert.deepEqual(motor.pedidos[0].corpo, { sistema: 'Voce PROPOE.', usuario: 'sobe a nora', max_tokens: 64, temperatura: 0.2 });
            assert.equal(r.texto, 'Noradrenalina | AUMENTAR_VAZAO | PAM 52');
            assert.equal(r.tokensEntrada, 120);
            assert.equal(r.tokensSaida, 14);
            assert.equal(r.motivoParada, 'stop');
            assert.equal(typeof r.latenciaMs, 'number');
        });

        await teste('motor sem /generate-semantic (codigo antigo no ar): erro que manda reiniciar', async () => {
            const antigo = await motorLocal(() => ({ status: 404, corpo: '{"detail":"Not Found"}' }));
            try {
                await assert.rejects(
                    new MotorLlamaCpp({ endpoint: antigo.url, timeoutMs: 2000 }).gerarPlanoSemantico({ sistema: 's', usuario: 'u' }),
                    /nao tem \/generate-semantic: o motor esta desatualizado/
                );
            } finally {
                await antigo.fechar();
            }
        });
    } finally {
        await motor.fechar();
    }

    console.log('\n[4. backend sem gramatica]');

    await teste('gera o plano semantico, e a realizacao gramatical e recusada antes de chamar', async () => {
        const semGramatica = motorSemGramatica();
        const r = await gerarPlanoSemantico(semGramatica, { comando: 'sobe a nora', promptSemantico: 'p', politicaEfetiva: politica });
        assert.equal(r.texto, 'plano proposto');
        assert.equal(semGramatica.pedidos.length, 1);

        assert.throws(() => exigirRealizacaoGramatical(semGramatica), ErroCapacidadeLLM);
        assert.throws(() => motorFragmentoDe(semGramatica), ErroCapacidadeLLM);
        await assert.rejects(decodificar({ ...entrada, motorLLM: semGramatica }), ErroCapacidadeLLM);
    });

    await teste('openai e gemini nao sao presumidos com GBNF', () => {
        assert.equal(CAPACIDADES_LLM.openai.gramatica, false);
        assert.equal(CAPACIDADES_LLM.gemini.gramatica, false);
        assert.equal(CAPACIDADES_LLM.llamacpp.gramatica, true);
    });

    console.log('\n[5. backend com gramatica]');

    await teste('decodificar usa o motor injetado nos dois modos, sem tocar a rede', async () => {
        for (const modo of ['incremental', 'monolitica']) {
            const comGramatica = motorComGramatica();
            await comAmbiente({ SPC_CML_DECODIFICACAO: modo }, () =>
                decodificar({ ...entrada, endpoint: 'http://127.0.0.1:1', motorLLM: comGramatica }));
            assert.ok(comGramatica.realizacoes.length > 0, modo);
            assert.ok(comGramatica.realizacoes.every(p => p.subgrafo.politicas.length > 0), modo);
            assert.equal(comGramatica.realizacoes.some(p => p.fragmento), modo === 'incremental', modo);
        }
    });

    console.log('\n[6. configuracao invalida]');

    await teste('backend desconhecido: erro com a lista de validos', () => {
        assert.throws(() => config({ LLM_BACKEND: 'lamacpp' }), /LLM_BACKEND "lamacpp" invalido: use llamacpp, openai, gemini/);
    });

    await teste('backend na nuvem sem chave ou sem modelo', () => {
        assert.throws(() => config({ LLM_BACKEND: 'openai', OPENAI_MODEL: 'm' }), /exige OPENAI_API_KEY/);
        assert.throws(() => config({ LLM_BACKEND: 'gemini', GEMINI_API_KEY: 'k' }), /exige GEMINI_MODEL \(ou LLM_MODEL\)/);
        assert.equal(config({ LLM_BACKEND: 'gemini', GEMINI_API_KEY: 'k', LLM_MODEL: 'g' }).gemini.modelo, 'g');
    });

    await teste('numeros e booleanos fora do formato', () => {
        assert.throws(() => config({ SPC_CML_MAX_RETRIES: 'tres' }), /SPC_CML_MAX_RETRIES deve ser um inteiro >= 0/);
        assert.throws(() => config({ SPC_CML_MAX_RETRIES: '-1' }), /SPC_CML_MAX_RETRIES/);
        assert.throws(() => config({ SPC_CML_SEMANTIC_REPAIR: 'talvez' }), /SPC_CML_SEMANTIC_REPAIR deve ser true ou false/);
        assert.throws(() => config({ SPC_CML_TIMEOUT_MS: '0' }), /SPC_CML_TIMEOUT_MS/);
        assert.equal(config({ SPC_CML_MAX_RETRIES: '0' }).maxTentativasSemanticas, 0);
    });

    await teste('decodificar com configuracao invalida falha antes de gerar', async () => {
        await comAmbiente({ LLM_BACKEND: 'lamacpp' }, () =>
            assert.rejects(decodificar({ ...entrada, endpoint: 'http://127.0.0.1:1' }), ErroConfiguracaoLLM));
        await comAmbiente({ LLM_BACKEND: 'openai', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm' }, () =>
            assert.rejects(decodificar({ ...entrada, endpoint: 'http://127.0.0.1:1' }), /Etapa 2/));
    });

    console.log('\n[7. .env.example]');

    await teste('traz exatamente as variaveis previstas, com os segredos vazios', () => {
        const texto = fs.readFileSync('.env.example', 'utf-8');
        const vars = parseEnv(texto);
        assert.deepEqual(Object.keys(vars).sort(), [
            'GEMINI_API_KEY', 'GEMINI_MODEL', 'LLM_BACKEND', 'LLM_MODEL',
            'OPENAI_API_KEY', 'OPENAI_MODEL', 'SPC_CML_MAX_RETRIES', 'SPC_CML_SEMANTIC_REPAIR'
        ]);
        assert.equal(vars.LLM_BACKEND, 'llamacpp');
        assert.equal(vars.OPENAI_API_KEY, '');
        assert.equal(vars.GEMINI_API_KEY, '');
        assert.doesNotMatch(texto, /sk-[A-Za-z0-9]{8,}|AIza[0-9A-Za-z_-]{10,}/, 'chave com cara de real no exemplo');
    });

    await teste('o proprio exemplo e uma configuracao valida, e ela e o padrao', () => {
        const c = lerConfiguracaoLLM({ env: {}, arquivoEnv: '.env.example' });
        assert.equal(c.backend, 'llamacpp');
        assert.equal(c.reparoSemantico, true);
        assert.equal(c.maxTentativasSemanticas, 3);
    });

    await teste('.env e ignorado pelo git; .env.example nao', () => {
        const ignorado = (arq: string): boolean => {
            try {
                execFileSync('git', ['check-ignore', '-q', arq], { stdio: 'ignore' });
                return true;
            } catch {
                return false;
            }
        };
        assert.equal(ignorado('.env'), true);
        assert.equal(ignorado('.env.example'), false);
    });

    console.log('\n[8. chaves de API nunca aparecem]');

    await teste('nem em log, nem em JSON, nem em inspect, nem em mensagem de erro', async () => {
        const OPENAI = 'sk-TESTE-nao-pode-vazar-1234567890';
        const GEMINI = 'AIzaTESTE-nao-pode-vazar-0987654321';
        const saida: string[] = [];
        const originais = { log: console.log, error: console.error, warn: console.warn, info: console.info };
        for (const k of Object.keys(originais) as (keyof typeof originais)[]) {
            console[k] = (...args: unknown[]) => saida.push(args.map(a => (typeof a === 'string' ? a : inspect(a, { depth: 10 }))).join(' '));
        }
        try {
            const c = config({ LLM_BACKEND: 'openai', OPENAI_API_KEY: OPENAI, OPENAI_MODEL: 'm', GEMINI_API_KEY: GEMINI });
            console.log(c);
            console.log(descreverConfiguracaoLLM(c));
            console.log(`chave: ${c.openai.chave}`);
            console.error(JSON.stringify(c));
            try {
                criarMotorLLM(c);
            } catch (e) {
                console.error((e as Error).message, (e as Error).stack);
            }
            try {
                config({ LLM_BACKEND: OPENAI });
            } catch (e) {
                console.error((e as Error).message);
            }
            try {
                config({ SPC_CML_SEMANTIC_REPAIR: GEMINI });
            } catch (e) {
                console.error((e as Error).message);
            }
            // A chave continua utilizavel por quem precisa dela.
            assert.equal(c.openai.chave?.revelar(), OPENAI);
        } finally {
            Object.assign(console, originais);
        }
        const tudo = saida.join('\n');
        assert.ok(saida.length >= 6, 'nada foi registrado');
        assert.ok(!tudo.includes(OPENAI) && !tudo.includes(GEMINI), 'uma chave vazou para a saida');
        assert.match(tudo, /OPENAI_API_KEY=definida/);
    });

    console.log('\n[9. a fase semantica: a camada superior monta, o motor so executa]');

    await teste('o pedido traz o papel do modelo, a politica vigente e as evidencias', () => {
        const prompt = montarPromptSemantico(constraints, MED, politica);
        const pedido = montarPedidoSemantico({
            comando: MED.intencao!, promptSemantico: prompt, politicaEfetiva: politica, evidencias: ['PAM 52 mmHg']
        });
        assert.match(pedido.sistema, /PROPOE/);
        assert.match(pedido.sistema, /nao crie regras, permissoes, decisoes nem evidencias/);
        assert.match(pedido.usuario, /^\[PEDIDO\]\nsobe a noradrenalina/);
        assert.equal(pedido.usuario.split('[POLITICA VIGENTE').length - 1, 1, 'a politica vigente deve aparecer uma vez');
        assert.match(pedido.usuario, /\[EVIDENCIAS\]\n- PAM 52 mmHg/);
        assert.equal(pedido.politicaEfetiva, politica);
        assert.equal(pedido.metadados?.artefato, 'plano');
    });

    await teste('sem o bloco no Prompt Semantico, a politica vigente e acrescentada', () => {
        const pedido = montarPedidoSemantico({ comando: 'c', promptSemantico: '[CENARIO]', politicaEfetiva: politica });
        assert.match(pedido.usuario, /\[POLITICA VIGENTE/);
    });

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
