/**
 * Inferencia em lote sobre uma bateria de cenarios de leito.
 *
 * Para cada cenario o cliente refaz o ciclo completo da Figura 5.1:
 *   telemetria -> busca no grafo -> Prompt Semantico + poda -> geracao restrita.
 *
 * Uso:
 *   npx tsx src/inference/batch-client.ts [cenarios.jsonl|prompts.txt] [modelo.dsl]
 *
 * Aceita dois formatos de entrada:
 *   .jsonl  um cenario por linha, com telemetria propria (formato preferido);
 *   .txt    uma fala por linha, avaliada sobre uma telemetria de referencia.
 *
 * O contraste entre cenarios e o ponto: a mesma frase ("aumenta a sedacao")
 * produz gramaticas diferentes conforme a PAM do paciente. O sistema nao bloqueia
 * por precaucao — ele bloqueia quando a invariante incide.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadModel } from '../database/neo4j.js';
import {
    retrieveConstraints,
    pruningPayload,
    type ClinicalContext
} from '../knowledge/graphrag.js';
import { montarPromptSemantico, gerarPlanoRestrito } from './llm-client.js';

/** Telemetria usada quando a entrada e um .txt sem dados de monitor. */
export const TELEMETRIA_PADRAO: ClinicalContext = {
    paciente: 'PT-REFERENCIA',
    telemetria: { PAM: 52, FC: 145, lactato: 4.8, RASS: 2, TFG: 28, plaquetas: 45, glicemia: 210 },
    populacoes: ['Renal_Cronico'],
    farmacosEmUso: ['Noradrenalina', 'Propofol', 'Vancomicina']
};

function carregarCenarios(filePath: string): ClinicalContext[] {
    const conteudo = fs.readFileSync(filePath, 'utf-8');
    const linhas = conteudo.split('\n').filter(l => l.trim().length > 0);

    if (filePath.endsWith('.jsonl')) {
        return linhas.map(l => JSON.parse(l) as ClinicalContext);
    }

    // .txt: apenas falas; a telemetria vem do cenario de referencia.
    return linhas.map(l => ({ ...TELEMETRIA_PADRAO, intencao: l.trim() }));
}

export async function rodarLote(entrada: string, modelPath: string): Promise<void> {
    if (!fs.existsSync(entrada)) {
        console.error(`Arquivo de cenarios nao encontrado: ${entrada}`);
        process.exit(1);
    }

    const model = await loadModel(modelPath);
    const cenarios = carregarCenarios(entrada);
    console.log(`${cenarios.length} cenarios carregados de ${path.basename(entrada)}\n`);

    let motorIndisponivel = false;

    for (const [i, contexto] of cenarios.entries()) {
        console.log('='.repeat(78));
        console.log(`[CENARIO ${i + 1}] ${contexto.paciente ?? 's/ id'}`);
        console.log(`Fala: "${contexto.intencao}"`);
        console.log(
            'Telemetria: ' +
                Object.entries(contexto.telemetria)
                    .map(([k, v]) => `${k}=${v}`)
                    .join('  ')
        );

        const constraints = retrieveConstraints(model, contexto);
        const poda = pruningPayload(constraints);

        console.log(
            `\nGrafo: ${constraints.protocolosAtivos.length} protocolos ativos, ` +
                `${constraints.bloqueios.length} bloqueios, ${constraints.vetados.length} vetos, ` +
                `${constraints.escalonamentos.length} escalonamentos`
        );
        for (const b of constraints.bloqueios) {
            console.log(`  bloqueado: ${b.farmaco} (${b.regra})`);
        }
        console.log(`  decisoes admissiveis apos a poda: ${poda.acoes_permitidas.join(', ')}`);

        if (motorIndisponivel) {
            console.log('\n(motor de geracao indisponivel — etapa de decodificacao pulada)\n');
            continue;
        }

        try {
            const resposta = await gerarPlanoRestrito(contexto, constraints);
            console.log(`\nPlano gerado (valido: ${resposta.valido}, ` +
                `${resposta.regras_em_g_hat} regras em G_hat):`);
            console.log(resposta.resultado);
            if (resposta.erro) console.log(`Erro reportado: ${resposta.erro}`);
        } catch (error) {
            motorIndisponivel = true;
            console.log(`\nMotor indisponivel: ${(error as Error).message}`);
            console.log(
                'Suba com: cd src/python_engine && uvicorn main:app --port 8000\n' +
                    'A recuperacao no grafo acima ja e a saida real e independe do motor.'
            );
        }
        console.log();
    }

    // O Prompt Semantico do primeiro cenario, para inspecao.
    if (cenarios.length > 0) {
        console.log('='.repeat(78));
        console.log('PROMPT SEMANTICO DO CENARIO 1 (bloco factual enviado ao LLM)');
        console.log('='.repeat(78));
        console.log(montarPromptSemantico(retrieveConstraints(model, cenarios[0])));
    }
}

async function main(): Promise<void> {
    const entrada = process.argv[2] ?? path.join('src', 'examples', 'med', 'cenarios.jsonl');
    const modelPath = process.argv[3] ?? path.join('src', 'examples', 'med', 'uti.dsl');
    await rodarLote(entrada, modelPath);
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
    main().catch(err => {
        console.error('Falha no lote:', err.message ?? err);
        process.exit(1);
    });
}
