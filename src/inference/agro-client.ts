/**
 * Inferencia em lote sobre uma bateria de cenarios de talhao (dominio agricola).
 *
 * Espelha src/inference/batch-client.ts e llm-client.ts no dominio da pulverizacao
 * por drone. Para cada cenario refaz o ciclo completo da Figura 5.1:
 *   telemetria de sensores -> busca no grafo -> Prompt Semantico + poda -> geracao.
 *
 * Uso:
 *   npx tsx src/inference/agro-client.ts [prompt-agro.txt] [lavoura.agro]
 *
 * O contraste entre cenarios e o ponto: a mesma frase ("manda o glifosato") gera
 * gramaticas diferentes conforme o vento do talhao. O sistema nao bloqueia por
 * precaucao — ele bloqueia quando a invariante incide.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadAgroModel } from '../database/neo4j-agro.js';
import { montarContrato } from '../knowledge/contrato.js';
import { decodificarSobContrato, type ResultadoDecodificacao } from './decodificacao.js';
import type { AgroModel } from '../generated/ast.js';
import {
    retrieveAgroConstraints,
    agroPruningPayload,
    condutasPorDecisaoAgro,
    type AgroContext,
    type RetrievedAgroConstraints
} from '../knowledge/graphrag-agro.js';

// O motor fixa a gramatica na subida (SPC_CML_DOMINIO em main.py), entao os dois
// dominios nao cabem no mesmo processo. Com o chat web, que oferece os dois lado a
// lado, cada um ganha seu motor: ./init.sh sobe medico na 8000 e agro na 8001.
// Sem SPC_CML_ENDPOINT_AGRO cai no endpoint unico — preservando o deploy-agro.sh,
// onde subir_motor coloca o dominio agricola na propria 8000.
const ENDPOINT =
    process.env.SPC_CML_ENDPOINT_AGRO ?? process.env.SPC_CML_ENDPOINT ?? 'http://127.0.0.1:8000';
const TIMEOUT_MS = Number(process.env.SPC_CML_TIMEOUT_MS ?? 600_000);

interface AgroResponse {
    resultado: string;
    valido: boolean;
    erro: string | null;
    g_hat_utilizada: string | null;
    regras_em_g_hat: number;
}

/** Telemetria usada quando a entrada e um .txt sem leituras proprias. */
export const TELEMETRIA_PADRAO: AgroContext = {
    talhao: 'TL-REFERENCIA',
    telemetria: {
        vento: 14,
        temperatura: 33,
        umidade: 48,
        NDVI: 0.38,
        umidade_foliar: 57,
        temperatura_foliar: 39,
        distancia_manancial: 320,
        distancia_cultura_sensivel: 260,
        chuva_prevista: 0,
        infestacao: 18
    },
    areas: ['Faixa_Manancial'],
    produtosEmUso: ['Glifosato', 'Mancozebe']
};

/**
 * Prompt Semantico: a fala do operador unificada ao bloco factual recuperado do
 * grafo. E texto para o LLM ler, mas cada linha saiu de uma comparacao numerica
 * sobre a telemetria dos sensores, nao de uma suposicao.
 */
export function montarPromptSemanticoAgro(
    c: RetrievedAgroConstraints,
    contexto?: AgroContext
): string {
    const bloco: string[] = [];

    // O estado corrente do cenario — o que ja esta na calda e sob que area — decide
    // quais decisoes fazem sentido, e nunca chegava ao prompt.
    if (contexto) {
        bloco.push('[CENARIO]');
        if (contexto.talhao) bloco.push(`- talhao: ${contexto.talhao}`);
        const emUso = contexto.produtosEmUso ?? [];
        bloco.push(
            emUso.length > 0
                ? `- na calda neste momento: ${emUso.join(', ')} (para estes cabe ajustar vazao ou suspender — nao iniciar)`
                : '- nenhum produto na calda neste momento (so cabe iniciar)'
        );
        if ((contexto.areas ?? []).length > 0) {
            bloco.push(`- areas restritivas do talhao: ${contexto.areas!.join(', ')}`);
        }
        bloco.push('');
    }

    if (c.culturasAtivas.length > 0) {
        // Uma cultura pode entrar aqui por gatilho disparado OU por ter sido
        // identificada no pedido (ver filtrarPorFocoAgro). Os dois casos sao
        // fatos distintos e o prompt precisa distingui-los: sem gatilho, o que
        // vale sao as restricoes estruturais da cultura, nao um evento.
        bloco.push('[CULTURAS EM FOCO]');
        for (const cult of c.culturasAtivas) {
            bloco.push(`- ${cult.nome} (${cult.ciclo})`);
            if (cult.gatilhos.length === 0) {
                bloco.push('    (sem gatilho ativo na leitura corrente — cultura identificada no pedido)');
            }
            for (const g of cult.gatilhos) bloco.push(`    gatilho: ${g}`);
        }
    }

    if (c.bloqueios.length > 0) {
        bloco.push('\n[APLICACOES BLOQUEADAS — invariantes de seguranca]');
        for (const b of c.bloqueios) {
            bloco.push(`- ${b.produto}: ${b.regra} => ${b.razao}`);
        }
    }

    if (c.vetados.length > 0) {
        bloco.push('\n[PRODUTOS VETADOS NESTE CONTEXTO]');
        for (const v of c.vetados) {
            bloco.push(`- ${v.produto} (${v.origem}): ${v.motivo}`);
        }
    }

    if (c.ajustes.length > 0) {
        bloco.push('\n[AJUSTES DE VAZAO EXIGIDOS]');
        for (const a of c.ajustes) {
            bloco.push(`- ${a.produto}: ${a.acao} — ${a.detalhe} (${a.origem})`);
        }
    }

    if (c.escalonamentos.length > 0) {
        bloco.push('\n[ESCALONAMENTOS DISPARADOS]');
        for (const e of c.escalonamentos) {
            bloco.push(`- ${e.destino}: ${e.detalhe} (${e.cultura})`);
        }
    }

    if (c.incompatibilidades.length > 0) {
        bloco.push('\n[INCOMPATIBILIDADES QUE ALCANCAM O QUE ESTA NA CALDA]');
        for (const i of c.incompatibilidades) {
            bloco.push(`- ${i.entre} [${i.gravidade}]: ${i.mecanismo}. ${i.conduta}`);
        }
    }

    if (c.recomendados.length > 0) {
        bloco.push('\n[RECOMENDADOS PELA CULTURA]');
        for (const r of c.recomendados) {
            bloco.push(`- ${r.produto}: ${r.indicacao} (${r.cultura})`);
        }
    }

    bloco.push('\n[INVARIANTES GLOBAIS]');
    for (const r of c.regrasGlobais) {
        bloco.push(`- [${r.severidade}] ${r.descricao}`);
    }

    return bloco.join('\n');
}

export async function gerarMissaoRestrita(
    contexto: AgroContext,
    constraints: RetrievedAgroConstraints,
    model?: AgroModel
): Promise<ResultadoDecodificacao> {
    const subgrafo = agroPruningPayload(constraints, contexto);
    const contrato = montarContrato(
        subgrafo,
        model ? condutasPorDecisaoAgro(model) : {},
        constraints.escalonamentos.map(e => `${e.destino}: ${e.detalhe}`)
    );

    return decodificarSobContrato({
        comando: contexto.intencao ?? '',
        contexto: montarPromptSemanticoAgro(constraints, contexto),
        subgrafo,
        contrato,
        endpoint: ENDPOINT,
        timeoutMs: TIMEOUT_MS
    });
}

function carregarCenarios(filePath: string): AgroContext[] {
    const conteudo = fs.readFileSync(filePath, 'utf-8');
    const linhas = conteudo.split('\n').filter(l => l.trim().length > 0);

    if (filePath.endsWith('.jsonl')) {
        return linhas.map(l => JSON.parse(l) as AgroContext);
    }
    return linhas.map(l => ({ ...TELEMETRIA_PADRAO, intencao: l.trim() }));
}

export async function rodarLote(entrada: string, modelPath: string): Promise<void> {
    if (!fs.existsSync(entrada)) {
        console.error(`Arquivo de cenarios nao encontrado: ${entrada}`);
        process.exit(1);
    }

    const model = await loadAgroModel(modelPath);
    const cenarios = carregarCenarios(entrada);
    console.log(`${cenarios.length} cenarios carregados de ${path.basename(entrada)}\n`);

    let motorIndisponivel = false;

    for (const [i, contexto] of cenarios.entries()) {
        console.log('='.repeat(78));
        console.log(`[CENARIO ${i + 1}] ${contexto.talhao ?? 's/ id'}`);
        console.log(`Fala: "${contexto.intencao}"`);
        console.log(
            'Sensores: ' +
                Object.entries(contexto.telemetria)
                    .map(([k, v]) => `${k}=${v}`)
                    .join('  ')
        );

        const constraints = retrieveAgroConstraints(model, contexto);
        const poda = agroPruningPayload(constraints, contexto);

        console.log(
            `\nGrafo: ${constraints.culturasAtivas.length} culturas ativas, ` +
                `${constraints.bloqueios.length} bloqueios, ${constraints.vetados.length} vetos, ` +
                `${constraints.escalonamentos.length} escalonamentos`
        );
        for (const b of constraints.bloqueios) {
            console.log(`  bloqueado: ${b.produto} (${b.regra})`);
        }
        console.log(`  decisoes admissiveis apos a poda: ${poda.acoes_permitidas.join(', ')}`);

        if (motorIndisponivel) {
            console.log('\n(motor de geracao indisponivel — etapa de decodificacao pulada)\n');
            continue;
        }

        try {
            const resposta = await gerarMissaoRestrita(contexto, constraints, model);
            console.log(
                `\nMissao gerada (valido: ${resposta.valido}, ` +
                    `${resposta.regras_em_g_hat} regras em G_hat, ` +
                `${resposta.tentativas} tentativa(s), contrato: ${resposta.conforme ? 'conforme' : 'violado'}):`
            );
            console.log(resposta.resultado);
            for (const v of resposta.violacoes) {
                const onde = v.clausula === null ? 'artefato' : `clausula ${v.clausula + 1}`;
                console.log(`  [contrato] ${onde}: ${v.mensagem}`);
            }
            if (resposta.erro) console.log(`Erro reportado: ${resposta.erro}`);
        } catch (error) {
            motorIndisponivel = true;
            console.log(`\nMotor indisponivel: ${(error as Error).message}`);
            console.log(
                'Suba com: SPC_CML_DOMINIO=agro uvicorn main:app --port 8000\n' +
                    'A recuperacao no grafo acima ja e a saida real e independe do motor.'
            );
        }
        console.log();
    }

    if (cenarios.length > 0) {
        console.log('='.repeat(78));
        console.log('PROMPT SEMANTICO DO CENARIO 1 (bloco factual enviado ao LLM)');
        console.log('='.repeat(78));
        console.log(montarPromptSemanticoAgro(retrieveAgroConstraints(model, cenarios[0])));
    }
}

async function main(): Promise<void> {
    const entrada = process.argv[2] ?? path.join('src', 'examples', 'agro', 'cenarios-agro.jsonl');
    const modelPath = process.argv[3] ?? path.join('src', 'examples', 'agro', 'lavoura.agro');
    await rodarLote(entrada, modelPath);
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
    main().catch(err => {
        console.error('Falha no lote agro:', err.message ?? err);
        process.exit(1);
    });
}
