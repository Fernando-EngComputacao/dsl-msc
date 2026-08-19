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
import {
    retrieveAgroConstraints,
    agroPruningPayload,
    type AgroContext,
    type RetrievedAgroConstraints
} from '../knowledge/graphrag-agro.js';

const ENDPOINT = process.env.SPC_CML_ENDPOINT ?? 'http://127.0.0.1:8000';
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
export function montarPromptSemanticoAgro(c: RetrievedAgroConstraints): string {
    const bloco: string[] = [];

    if (c.culturasAtivas.length > 0) {
        bloco.push('[CULTURAS COM GATILHO ATIVO]');
        for (const cult of c.culturasAtivas) {
            bloco.push(`- ${cult.nome} (${cult.ciclo})`);
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
        bloco.push('\n[INCOMPATIBILIDADES ENTRE PRODUTOS NO TANQUE]');
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
    constraints: RetrievedAgroConstraints
): Promise<AgroResponse> {
    const payload = {
        comando_humano: contexto.intencao ?? '',
        contexto_neo4j: montarPromptSemanticoAgro(constraints),
        subgrafo_regras: agroPruningPayload(constraints)
    };

    let response: Response;
    try {
        response = await fetch(`${ENDPOINT}/generate-constrained`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch (error) {
        const causa =
            (error as Error).name === 'TimeoutError'
                ? `sem resposta em ${TIMEOUT_MS / 1000}s (ajuste SPC_CML_TIMEOUT_MS)`
                : (error as Error).message;
        throw new Error(`${ENDPOINT} inacessivel: ${causa}`);
    }

    if (!response.ok) {
        throw new Error(`${ENDPOINT} respondeu ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as AgroResponse;
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
        const poda = agroPruningPayload(constraints);

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
            const resposta = await gerarMissaoRestrita(contexto, constraints);
            console.log(
                `\nMissao gerada (valido: ${resposta.valido}, ` +
                    `${resposta.regras_em_g_hat} regras em G_hat):`
            );
            console.log(resposta.resultado);
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
    const entrada = process.argv[2] ?? path.join('src', 'examples', 'prompt-agro.txt');
    const modelPath = process.argv[3] ?? path.join('src', 'examples', 'lavoura.agro');
    await rodarLote(entrada, modelPath);
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
    main().catch(err => {
        console.error('Falha no lote agro:', err.message ?? err);
        process.exit(1);
    });
}
