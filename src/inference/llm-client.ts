/**
 * Cliente do motor de decodificacao restrita.
 *
 * Une as duas metades da arquitetura: a recuperacao no Grafo de Conhecimento
 * (TypeScript, sobre a AST da DSL) e a geracao sob mascaramento de logits
 * (Python/Outlines). O Prompt Semantico e o subgrafo de poda sao construidos
 * aqui a partir do modelo real — nada e transcrito a mao.
 *
 * Uso:
 *   npx tsx src/inference/llm-client.ts [modelo.dsl]
 *
 * A gramatica NAO viaja no payload: o servico ja a possui, derivada da mesma DSL
 * por `npx tsx src/cli/export-bnf.ts`. Enviar uma copia pelo fio reintroduziria
 * exatamente a segunda fonte de verdade que a arquitetura elimina.
 */

import * as path from 'node:path';
import { loadModel } from '../database/neo4j.js';
import { montarContrato } from '../knowledge/contrato.js';
import {
    retrieveConstraints,
    pruningPayload,
    condutasPorDecisaoMed,
    esquemaDeDadosMed,
    type ClinicalContext,
    type RetrievedConstraints
} from '../knowledge/graphrag.js';
import { decodificar, type OpcoesDecodificacao, type ResultadoDecodificacao } from './decodificacao.js';
import {
    anotarRecomendacao,
    blocoPoliticaEfetiva,
    type SubgrafoPodado
} from '../knowledge/politica.js';
import type { MedicalModel } from '../generated/ast.js';

const ENDPOINT = process.env.SPC_CML_ENDPOINT ?? 'http://127.0.0.1:8000';

/** Teto por cenario. Generoso: a 1a chamada ainda baixa e carrega os pesos. */
const TIMEOUT_MS = Number(process.env.SPC_CML_TIMEOUT_MS ?? 600_000);

/** Payload aceito por `POST /generate-constrained` (ver python_engine/main.py). */
interface ICURequest {
    comando_humano: string;
    contexto_neo4j: string;
    subgrafo_regras: {
        acoes_permitidas: string[];
        farmacos_liberados: string[];
        vias_disponiveis: string[];
    };
}

interface ICUResponse {
    resultado: string;
    valido: boolean;
    erro: string | null;
    g_hat_utilizada: string | null;
    regras_em_g_hat: number;
}

/**
 * Prompt Semantico (etapa 3 da Figura 5.1): a fala do profissional unificada ao
 * bloco factual recuperado do grafo. E texto para o LLM ler, mas cada linha aqui
 * saiu de uma comparacao numerica sobre a telemetria, nao de uma suposicao.
 */
export function montarPromptSemantico(
    constraints: RetrievedConstraints,
    contexto?: ClinicalContext,
    /**
     * Politica efetivamente vigente para esta geracao. Quando vem, ela e a
     * AUTORIDADE sobre o que e exprimivel: as recomendacoes que ela nao permite
     * mais sao anotadas, e um bloco final declara o que resta admissivel.
     *
     * Ausente: o prompt sai exatamente como sempre saiu. Isso importa porque
     * varios chamadores nao podem mudar de comportamento — a geracao de gabarito
     * (`scripts/gerar-ground-truth-*.ts`) e a avaliacao em lote julgam contra um
     * texto que precisa permanecer estavel.
     */
    politicaVigente?: SubgrafoPodado
): string {
    const bloco: string[] = [];

    // O que ja esta correndo no leito muda a decisao licita (nao se INICIA o que
    // ja infunde) e nunca chegava ao prompt: so aparecia, de lado, no bloco de
    // interacoes. Sem este bloco, o modelo escolhe entre iniciar e titular no
    // escuro.
    if (contexto) {
        bloco.push('[CENARIO]');
        if (contexto.paciente) bloco.push(`- paciente: ${contexto.paciente}`);
        const emUso = contexto.farmacosEmUso ?? [];
        bloco.push(
            emUso.length > 0
                ? `- em infusao neste momento: ${emUso.join(', ')} (para estes cabe titular, reduzir ou suspender — nao iniciar)`
                : '- nenhum farmaco em infusao neste momento (so cabe iniciar)'
        );
        if ((contexto.populacoes ?? []).length > 0) {
            bloco.push(`- populacoes especiais: ${contexto.populacoes!.join(', ')}`);
        }
        bloco.push('');
    }

    if (constraints.protocolosAtivos.length > 0) {
        // Um protocolo pode entrar aqui por gatilho disparado OU por ter sido
        // identificado no pedido (ver filtrarPorFoco). Os dois casos sao fatos
        // distintos e o prompt precisa distingui-los: sem gatilho, o que vale
        // sao as restricoes estruturais do protocolo, nao um evento.
        bloco.push('[PROTOCOLOS EM FOCO]');
        for (const p of constraints.protocolosAtivos) {
            bloco.push(`- ${p.nome} (CID ${p.cid})`);
            if (p.gatilhos.length === 0) {
                bloco.push('    (sem gatilho ativo na telemetria — protocolo identificado no pedido)');
            }
            for (const g of p.gatilhos) bloco.push(`    gatilho: ${g}`);
        }
    }

    if (constraints.bloqueios.length > 0) {
        bloco.push('\n[INCREMENTOS BLOQUEADOS — invariantes de seguranca]');
        for (const b of constraints.bloqueios) {
            bloco.push(`- ${b.farmaco}: ${b.regra} => ${b.razao}`);
        }
    }

    if (constraints.vetados.length > 0) {
        bloco.push('\n[FARMACOS VETADOS NESTE CONTEXTO]');
        for (const v of constraints.vetados) {
            bloco.push(`- ${v.farmaco} (${v.origem}): ${v.motivo}`);
        }
    }

    if (constraints.ajustes.length > 0) {
        bloco.push('\n[AJUSTES DE DOSE EXIGIDOS]');
        for (const a of constraints.ajustes) {
            bloco.push(`- ${a.farmaco}: ${a.acao} — ${a.detalhe} (${a.origem})`);
        }
    }

    if (constraints.escalonamentos.length > 0) {
        bloco.push('\n[ESCALONAMENTOS DISPARADOS]');
        for (const e of constraints.escalonamentos) {
            bloco.push(`- ${e.destino}: ${e.detalhe} (${e.protocolo})`);
        }
    }

    if (constraints.interacoes.length > 0) {
        bloco.push('\n[INTERACOES ENTRE FARMACOS EM USO]');
        for (const i of constraints.interacoes) {
            bloco.push(`- ${i.entre} [${i.gravidade}]: ${i.mecanismo}. ${i.conduta}`);
        }
    }

    if (constraints.recomendados.length > 0) {
        bloco.push('\n[RECOMENDADOS PELO PROTOCOLO]');
        for (const r of constraints.recomendados) {
            // A recomendacao continua sendo um fato do protocolo; o que se
            // acrescenta e que ela pode ja nao ser realizavel.
            const nota = politicaVigente ? anotarRecomendacao(politicaVigente, r.farmaco) : undefined;
            bloco.push(`- ${r.farmaco}: ${r.indicacao} (${r.protocolo})` + (nota ? ` ${nota}` : ''));
        }
    }

    bloco.push('\n[INVARIANTES GLOBAIS]');
    for (const r of constraints.regrasGlobais) {
        bloco.push(`- [${r.severidade}] ${r.descricao}`);
    }

    // Por ultimo, e de proposito: o modelo le os fatos primeiro e fecha com o
    // que de fato pode decidir.
    if (politicaVigente) bloco.push(...blocoPoliticaEfetiva(politicaVigente));

    return bloco.join('\n');
}

/**
 * Monta o que a decodificacao recebe, SEM gerar. Pura e exportada de proposito:
 * e o unico ponto em que se pode conferir, sem rede e sem GPU, qual subgrafo de
 * fato chega ao gerador.
 *
 * `subgrafoRefinado` e o resultado de `refinarPolitica` (ver
 * `knowledge/recuperacao-politica.ts`) no modo hibrido. Quando vem, e ele que
 * vale e a poda NAO e recalculada — recalcular descartaria em silencio o
 * refinamento que o Cypher justificou. Quando nao vem, a poda e feita aqui como
 * sempre foi, e o caminho legado fica intacto.
 *
 * Esta funcao nao confere `apenasEstreitou`: quem produz o subgrafo refinado e
 * `refinarPolitica`, e e la que a nao-ampliacao e barrada com excecao, com as
 * duas politicas em maos. Repetir a checagem aqui exigiria recalcular a poda,
 * que e justamente o que este parametro existe para evitar.
 */
export function montarEntradaGeracao(
    contexto: ClinicalContext,
    constraints: RetrievedConstraints,
    model?: MedicalModel,
    subgrafoRefinado?: SubgrafoPodado
): OpcoesDecodificacao {
    const subgrafo = subgrafoRefinado ?? pruningPayload(constraints, contexto);
    const contrato = montarContrato(
        subgrafo,
        model ? condutasPorDecisaoMed(model) : {},
        constraints.escalonamentos.map(e => `${e.destino}: ${e.detalhe}`),
        model ? esquemaDeDadosMed(model) : undefined
    );

    return {
        comando: contexto.intencao ?? '',
        // O prompt recebe a MESMA politica que vira gramatica e contrato. Sem
        // isto os dois discordavam: o refinamento estreitava a gramatica e o
        // texto continuava recomendando o que ela ja nao gerava.
        contexto: montarPromptSemantico(constraints, contexto, subgrafo),
        subgrafo,
        contrato,
        endpoint: ENDPOINT,
        timeoutMs: TIMEOUT_MS
    };
}

export async function gerarPlanoRestrito(
    contexto: ClinicalContext,
    constraints: RetrievedConstraints,
    model?: MedicalModel,
    /** Poda ja refinada pelo caminho hibrido. Ausente: comportamento de sempre. */
    subgrafoRefinado?: SubgrafoPodado
): Promise<ResultadoDecodificacao> {
    return decodificar(montarEntradaGeracao(contexto, constraints, model, subgrafoRefinado));
}

// ---------------------------------------------------------------------------

const CONTEXTO: ClinicalContext = {
    paciente: 'PT-2026-0031',
    intencao: 'A pressao ta despencando (PAM=52), sobe a nora urgente e aprofunda o propofol!',
    telemetria: { PAM: 52, FC: 145, lactato: 4.8, RASS: 2, TFG: 28, plaquetas: 45, glicemia: 210 },
    populacoes: ['Renal_Cronico'],
    farmacosEmUso: ['Noradrenalina', 'Propofol', 'Vancomicina']
};

async function main(): Promise<void> {
    const modelPath = process.argv[2] ?? path.join('src', 'examples', 'med', 'uti.dsl');
    const model = await loadModel(modelPath);
    const constraints = retrieveConstraints(model, CONTEXTO);
    const poda = pruningPayload(constraints, CONTEXTO);

    console.log('=== PROMPT SEMANTICO (recuperado do grafo) ===');
    console.log(montarPromptSemantico(constraints, CONTEXTO));

    console.log('\n=== SUBGRAFO DE PODA (define G_hat no motor) ===');
    console.log(`  acoes_permitidas:  ${poda.acoes_permitidas.join(', ')}`);
    console.log(`  farmacos_liberados: ${poda.farmacos_liberados.join(', ')}`);
    console.log(`  vias_disponiveis:   ${poda.vias_disponiveis.join(', ')}`);

    console.log(`\n=== CHAMANDO ${ENDPOINT}/generate-constrained ===`);
    try {
        const resposta = await gerarPlanoRestrito(CONTEXTO, constraints, model);
        console.log(`Plano gerado (valido: ${resposta.valido}):`);
        console.log(resposta.resultado);
        if (resposta.erro) console.log(`Erro reportado pelo motor: ${resposta.erro}`);
        console.log(`Regras em G_hat: ${resposta.regras_em_g_hat}`);
    } catch (error) {
        console.error(`\nMotor indisponivel: ${(error as Error).message}`);
        console.error(
            'Suba o servico com:  cd src/python_engine && uvicorn main:app --port 8000\n' +
                'A recuperacao no grafo acima ja e a saida real do pipeline e independe dele.'
        );
        process.exitCode = 1;
    }
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
    main().catch(err => {
        console.error('Falha:', err.message ?? err);
        process.exit(1);
    });
}
