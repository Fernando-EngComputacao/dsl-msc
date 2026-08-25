/**
 * Inferencia em lote sobre uma bateria de cenarios de partida (dominio de
 * arbitragem de futebol).
 *
 * Espelha src/inference/batch-client.ts/llm-client.ts (clinico) e
 * src/inference/agro-client.ts (agricola). Para cada cenario refaz o ciclo
 * completo da Figura 5.1:
 *   leitura de partida -> busca no grafo -> Prompt Semantico + poda -> geracao.
 *
 * Uso:
 *   npx tsx src/inference/fut-client.ts [prompt-fut.txt] [futebol.fut]
 *
 * O contraste entre cenarios e o ponto: a mesma frase ("marca a segunda amarela")
 * gera gramaticas diferentes conforme os cartoes ja acumulados pelo jogador. O
 * sistema nao bloqueia por precaucao — ele bloqueia quando a invariante incide.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadFutModel } from '../database/neo4j-fut.js';
import { montarContrato } from '../knowledge/contrato.js';
import { decodificarSobContrato, type ResultadoDecodificacao } from './decodificacao.js';
import type { FutModel } from '../generated/ast.js';
import {
    retrieveFutConstraints,
    futPruningPayload,
    condutasPorDecisaoFut,
    type FutContext,
    type RetrievedFutConstraints
} from '../knowledge/graphrag-fut.js';

// O motor fixa a gramatica na subida (SPC_CML_DOMINIO em main.py), entao os tres
// dominios nao cabem no mesmo processo. Com o chat web, que oferece os tres lado
// a lado, cada um ganha seu motor: ./init.sh sobe medico na 8000, agro na 8001 e
// fut na 8002. Sem SPC_CML_ENDPOINT_FUT cai no endpoint unico — preservando o
// deploy-fut.sh, onde subir_motor coloca o dominio de arbitragem na propria 8000.
const ENDPOINT =
    process.env.SPC_CML_ENDPOINT_FUT ?? process.env.SPC_CML_ENDPOINT ?? 'http://127.0.0.1:8000';
const TIMEOUT_MS = Number(process.env.SPC_CML_TIMEOUT_MS ?? 600_000);

interface FutResponse {
    resultado: string;
    valido: boolean;
    erro: string | null;
    g_hat_utilizada: string | null;
    regras_em_g_hat: number;
}

/** Leitura de partida usada quando a entrada e um .txt sem contexto proprio. */
export const TELEMETRIA_PADRAO: FutContext = {
    partida: 'PT-REFERENCIA',
    telemetria: {
        minuto_partida: 78,
        acrescimo: 0,
        cartoes_amarelos_jogador: 0,
        distancia_ultimo_defensor: -1,
        velocidade_bola: 22,
        distancia_gol: 11,
        jogadores_entre_bola_e_gol: 1,
        tempo_revisao_var: 3,
        placar_diferenca: -1,
        faltas_acumuladas_time: 3,
        distancia_bola: 0.5
    },
    contextos: [],
    infracoesEmUso: ['Mao_Deliberada']
};

/**
 * Prompt Semantico: a fala do arbitro/observador unificada ao bloco factual
 * recuperado do grafo. E texto para o LLM ler, mas cada linha saiu de uma
 * comparacao numerica sobre a leitura da partida, nao de uma suposicao.
 */
export function montarPromptSemanticoFut(
    c: RetrievedFutConstraints,
    contexto?: FutContext
): string {
    const bloco: string[] = [];

    // O estado corrente da partida — o que ja foi marcado e sob que contexto de
    // competicao — decide quais sancoes fazem sentido, e nunca chegava ao prompt.
    if (contexto) {
        bloco.push('[CENARIO]');
        if (contexto.partida) bloco.push(`- partida: ${contexto.partida}`);
        const emUso = contexto.infracoesEmUso ?? [];
        bloco.push(
            emUso.length > 0
                ? `- ja marcado nesta partida: ${emUso.join(', ')}`
                : '- nenhuma infracao marcada ate aqui nesta partida'
        );
        if ((contexto.contextos ?? []).length > 0) {
            bloco.push(`- contextos da competicao: ${contexto.contextos!.join(', ')}`);
        }
        bloco.push('');
    }

    if (c.lancesAtivos.length > 0) {
        // Um lance pode entrar aqui por gatilho disparado OU por ter sido
        // identificado na chamada do arbitro (ver filtrarPorFocoFut). Os dois
        // casos sao fatos distintos e o prompt precisa distingui-los: sem
        // gatilho, o que vale sao as restricoes estruturais do lance, nao um
        // evento da partida.
        bloco.push('[LANCES EM FOCO]');
        for (const lance of c.lancesAtivos) {
            bloco.push(`- ${lance.nome} (${lance.lei})`);
            if (lance.gatilhos.length === 0) {
                bloco.push('    (sem gatilho ativo na leitura da partida — lance identificado no pedido)');
            }
            for (const g of lance.gatilhos) bloco.push(`    gatilho: ${g}`);
        }
    }

    if (c.bloqueios.length > 0) {
        bloco.push('\n[DECISOES BLOQUEADAS — invariantes de seguranca]');
        for (const b of c.bloqueios) {
            bloco.push(`- ${b.infracao}: ${b.regra} => ${b.razao}`);
        }
    }

    if (c.vetados.length > 0) {
        bloco.push('\n[INFRACOES VETADAS NESTE CONTEXTO]');
        for (const v of c.vetados) {
            bloco.push(`- ${v.infracao} (${v.origem}): ${v.motivo}`);
        }
    }

    if (c.ajustes.length > 0) {
        bloco.push('\n[AJUSTES DE GRAVIDADE EXIGIDOS]');
        for (const a of c.ajustes) {
            bloco.push(`- ${a.infracao}: ${a.acao} — ${a.detalhe} (${a.origem})`);
        }
    }

    if (c.escalonamentos.length > 0) {
        bloco.push('\n[ESCALONAMENTOS DISPARADOS]');
        for (const e of c.escalonamentos) {
            bloco.push(`- ${e.destino}: ${e.detalhe} (${e.lance})`);
        }
    }

    if (c.agravantes.length > 0) {
        bloco.push('\n[AGRAVANTES QUE ALCANCAM O QUE JA FOI MARCADO]');
        for (const a of c.agravantes) {
            bloco.push(`- ${a.entre} [${a.gravidade}]: ${a.mecanismo}. ${a.conduta}`);
        }
    }

    if (c.recomendados.length > 0) {
        bloco.push('\n[RECOMENDADOS PELO LANCE]');
        for (const r of c.recomendados) {
            bloco.push(`- ${r.infracao}: ${r.indicacao} (${r.lance})`);
        }
    }

    bloco.push('\n[INVARIANTES GLOBAIS]');
    for (const r of c.regrasGlobais) {
        bloco.push(`- [${r.severidade}] ${r.descricao}`);
    }

    return bloco.join('\n');
}

export async function gerarArbitragemRestrita(
    contexto: FutContext,
    constraints: RetrievedFutConstraints,
    model?: FutModel
): Promise<ResultadoDecodificacao> {
    const subgrafo = futPruningPayload(constraints, contexto);
    const contrato = montarContrato(
        subgrafo,
        model ? condutasPorDecisaoFut(model) : {},
        constraints.escalonamentos.map(e => `${e.destino}: ${e.detalhe}`)
    );

    return decodificarSobContrato({
        comando: contexto.intencao ?? '',
        contexto: montarPromptSemanticoFut(constraints, contexto),
        subgrafo,
        contrato,
        endpoint: ENDPOINT,
        timeoutMs: TIMEOUT_MS
    });
}

function carregarCenarios(filePath: string): FutContext[] {
    const conteudo = fs.readFileSync(filePath, 'utf-8');
    const linhas = conteudo.split('\n').filter(l => l.trim().length > 0);

    if (filePath.endsWith('.jsonl')) {
        return linhas.map(l => JSON.parse(l) as FutContext);
    }
    return linhas.map(l => ({ ...TELEMETRIA_PADRAO, intencao: l.trim() }));
}

export async function rodarLote(entrada: string, modelPath: string): Promise<void> {
    if (!fs.existsSync(entrada)) {
        console.error(`Arquivo de cenarios nao encontrado: ${entrada}`);
        process.exit(1);
    }

    const model = await loadFutModel(modelPath);
    const cenarios = carregarCenarios(entrada);
    console.log(`${cenarios.length} cenarios carregados de ${path.basename(entrada)}\n`);

    let motorIndisponivel = false;

    for (const [i, contexto] of cenarios.entries()) {
        console.log('='.repeat(78));
        console.log(`[CENARIO ${i + 1}] ${contexto.partida ?? 's/ id'}`);
        console.log(`Fala: "${contexto.intencao}"`);
        console.log(
            'Leitura da partida: ' +
                Object.entries(contexto.telemetria)
                    .map(([k, v]) => `${k}=${v}`)
                    .join('  ')
        );

        const constraints = retrieveFutConstraints(model, contexto);
        const poda = futPruningPayload(constraints, contexto);

        console.log(
            `\nGrafo: ${constraints.lancesAtivos.length} lances ativos, ` +
                `${constraints.bloqueios.length} bloqueios, ${constraints.vetados.length} vetos, ` +
                `${constraints.escalonamentos.length} escalonamentos`
        );
        for (const b of constraints.bloqueios) {
            console.log(`  bloqueado: ${b.infracao} (${b.regra})`);
        }
        console.log(`  decisoes admissiveis apos a poda: ${poda.acoes_permitidas.join(', ')}`);

        if (motorIndisponivel) {
            console.log('\n(motor de geracao indisponivel — etapa de decodificacao pulada)\n');
            continue;
        }

        try {
            const resposta = await gerarArbitragemRestrita(contexto, constraints, model);
            console.log(
                `\nDecisao gerada (valido: ${resposta.valido}, ` +
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
                'Suba com: SPC_CML_DOMINIO=fut uvicorn main:app --port 8000\n' +
                    'A recuperacao no grafo acima ja e a saida real e independe do motor.'
            );
        }
        console.log();
    }

    if (cenarios.length > 0) {
        console.log('='.repeat(78));
        console.log('PROMPT SEMANTICO DO CENARIO 1 (bloco factual enviado ao LLM)');
        console.log('='.repeat(78));
        console.log(montarPromptSemanticoFut(retrieveFutConstraints(model, cenarios[0])));
    }
}

async function main(): Promise<void> {
    const entrada = process.argv[2] ?? path.join('src', 'examples', 'fut', 'cenarios-fut.jsonl');
    const modelPath = process.argv[3] ?? path.join('src', 'examples', 'fut', 'futebol.fut');
    await rodarLote(entrada, modelPath);
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
    main().catch(err => {
        console.error('Falha no lote de arbitragem:', err.message ?? err);
        process.exit(1);
    });
}
