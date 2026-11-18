/**
 * Gate da geracao (src/inference/geracao-validada.ts): gera, avalia com a
 * cascata da tela de avaliacao e regera enquanto o critério reprovar — pelo
 * oraculo, pelo juiz LLM, ou pelos dois.
 * Executar: npx tsx src/test/gate-geracao.test.ts
 *
 * O laco e testado com dubles de geracao e de avaliacao — sem motor, sem Neo4j
 * e sem parser: o que se cobra aqui e a POLITICA do gate, nao a avaliacao (essa
 * esta em avaliar-oraculo.test.ts).
 *
 * O que se cobra:
 *   1. aprovado de primeira: uma geracao, uma avaliacao, nada descartado;
 *   2. INVALID/UNRESOLVED do oraculo voltam para a geracao;
 *   3. juiz INVALID/UNRESOLVED tambem voltam, quando ele e critério — e NAO voltam
 *      quando o critério e so o oraculo;
 *   4. `ambos` exige os dois VALID; `juiz` deixa passar plano que o oraculo reprovou
 *      (e o registro mostra os dois vereditos, sempre);
 *   5. teto de tentativas: para, devolve o ultimo plano reprovado e marca `limiteAtingido`;
 *   6. falha tecnica (avaliacao impossivel, juiz sem resposta) nao e defeito do plano:
 *      nao repete, salvo quando pedido;
 *   7. geracao sem plano: nada e avaliado nem repetido;
 *   8. o par devolvido e sempre consistente (a avaliacao e DO plano devolvido);
 *   9. cancelamento nao comeca tentativa nova;
 *  10. os tempos separam a geracao que ficou, as descartadas e as avaliacoes;
 *  11. o resumo da reprovacao: codigos do oraculo, justificativa do juiz, quem reprovou.
 */

import assert from 'node:assert/strict';

import type { DetalheLado, StatusJuiz, Veredito } from '../inference/avaliar-grafo.js';
import {
    codigosReprovacao,
    decidirGate,
    gerarComGate,
    vereditoDoGate,
    type CriterioGate
} from '../inference/geracao-validada.js';

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

/** O que a geracao devolve, no minimo do que o gate le. */
interface Geracao {
    aceito: boolean;
    resultado?: string;
}

const pausa = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Uma avaliacao com veredito do oraculo e status do juiz — so o que o gate consulta. */
function avaliado(veredito: Veredito, plano: string, juiz: StatusJuiz = 'VALID'): DetalheLado {
    return {
        plano,
        naoAvaliado: false,
        validacaoSintatica: { veredito: 'VALID', erros: [] },
        validacaoSemantica: {
            veredito,
            erros: veredito === 'INVALID' ? [{ etapa: 'global', codigo: 'item_bloqueado', mensagem: 'bloqueado' }] : [],
            avisos: [],
            dadosFaltantes: veredito === 'UNRESOLVED' ? ['TFG'] : [],
            etapas: [],
            naoFormalizado: []
        },
        oraculo: { veredito, origem: 'semantica' },
        julgamentoLLM: {
            status: juiz,
            ...(juiz === 'INVALID' || juiz === 'UNRESOLVED' ? { justificativa: 'a dose contraria a regra de TFG' } : {}),
            ...(juiz === 'NO_RESPONSE' ? { motivo: 'motor inacessivel' } : {})
        },
        tempos: { sintaxeMs: 1, oraculoMs: 2, llmJudgeMs: 3, totalMs: 7 }
    };
}

/** Falha tecnica: nenhuma camada deu veredito. */
function naoAvaliado(plano: string, motivo = 'grafo fora do ar'): DetalheLado {
    return { plano, naoAvaliado: true, motivo };
}

/** Um passo do roteiro do duble: o veredito do oraculo (juiz VALID), ou os dois. */
type Passo = Veredito | 'NAO_AVALIADO' | { oraculo: Veredito; juiz: StatusJuiz };

/**
 * Monta um gate de brinquedo: cada tentativa gera `plano-<n>` e recebe o passo
 * da lista (o ultimo vale para as tentativas seguintes).
 */
function gateDeBrinquedo(
    roteiro: Passo[],
    opcoes: {
        maxTentativas: number;
        criterio?: CriterioGate;
        repetirNaoAvaliado?: boolean;
        semPlano?: boolean;
        atrasoMs?: number;
        sinal?: AbortSignal;
    }
) {
    const geradas: string[] = [];
    const avaliadas: string[] = [];
    const estagios: string[] = [];
    const resultado = gerarComGate<Geracao>(
        {
            gerar: async tentativa => {
                const plano = `plano-${tentativa}`;
                geradas.push(plano);
                if (opcoes.atrasoMs) await pausa(opcoes.atrasoMs);
                return opcoes.semPlano ? { aceito: false } : { aceito: true, resultado: plano };
            },
            avaliar: async (resposta, tentativa) => {
                const plano = resposta.resultado!;
                avaliadas.push(plano);
                if (opcoes.atrasoMs) await pausa(opcoes.atrasoMs);
                const passo = roteiro[Math.min(tentativa - 1, roteiro.length - 1)];
                if (passo === 'NAO_AVALIADO') return naoAvaliado(plano);
                return typeof passo === 'string' ? avaliado(passo, plano) : avaliado(passo.oraculo, plano, passo.juiz);
            },
            planoDe: r => (r.aceito && typeof r.resultado === 'string' ? r.resultado : undefined),
            aoEstagio: texto => {
                estagios.push(texto);
            },
            sinal: opcoes.sinal
        },
        {
            maxTentativas: opcoes.maxTentativas,
            ...(opcoes.criterio ? { criterio: opcoes.criterio } : {}),
            repetirNaoAvaliado: opcoes.repetirNaoAvaliado
        }
    );
    return { resultado, geradas, avaliadas, estagios };
}

async function main(): Promise<void> {
    await teste('aprovado de primeira (oraculo e juiz VALID): uma geracao, nada descartado', async () => {
        const g = gateDeBrinquedo(['VALID'], { maxTentativas: 5 });
        const { resposta, avaliacao, resumo } = await g.resultado;
        assert.deepEqual(g.geradas, ['plano-1']);
        assert.deepEqual(g.avaliadas, ['plano-1']);
        assert.equal(resposta.resultado, 'plano-1');
        assert.equal(avaliacao?.plano, 'plano-1');
        assert.equal(resumo.tentativas, 1);
        assert.equal(resumo.aceita, true);
        assert.equal(resumo.criterio, 'ambos', 'o padrao do gate e exigir os dois');
        assert.equal(resumo.veredito, 'VALID');
        assert.equal(resumo.fonte, 'juiz', 'em `ambos`, quem fecha a aprovacao e o juiz');
        assert.deepEqual([resumo.oraculo, resumo.juiz], ['VALID', 'VALID']);
        assert.equal(resumo.limiteAtingido, false);
        assert.deepEqual(resumo.descartadas, []);
        assert.equal(resumo.tempoGeracaoDescartadaMs, 0);
    });

    await teste('oraculo INVALID volta para a geracao; o que fica e o plano aprovado', async () => {
        const g = gateDeBrinquedo(['INVALID', 'VALID'], { maxTentativas: 5 });
        const { resposta, avaliacao, resumo } = await g.resultado;
        assert.deepEqual(g.geradas, ['plano-1', 'plano-2']);
        assert.equal(resposta.resultado, 'plano-2');
        assert.equal(avaliacao?.oraculo?.veredito, 'VALID');
        assert.equal(resumo.tentativas, 2);
        assert.equal(resumo.aceita, true);
        assert.equal(resumo.descartadas.length, 1);
        assert.deepEqual(
            resumo.descartadas.map(d => [d.tentativa, d.plano, d.veredito, d.fonte, d.origem]),
            [[1, 'plano-1', 'INVALID', 'oraculo', 'semantica']]
        );
        assert.deepEqual(resumo.descartadas[0].codigos, ['item_bloqueado']);
        assert.equal(resumo.descartadas[0].juiz, 'VALID', 'o que o juiz disse na tentativa descartada fica registrado');
        assert.equal(resumo.descartadas[0].justificativaJuiz, undefined, 'quem reprovou foi o oraculo');
    });

    await teste('oraculo UNRESOLVED tambem volta para a geracao', async () => {
        const g = gateDeBrinquedo(['UNRESOLVED', 'UNRESOLVED', 'VALID'], { maxTentativas: 5 });
        const { resumo } = await g.resultado;
        assert.equal(resumo.tentativas, 3);
        assert.equal(resumo.aceita, true);
        assert.deepEqual(
            resumo.descartadas.map(d => d.veredito),
            ['UNRESOLVED', 'UNRESOLVED']
        );
        // A causa usual do UNRESOLVED fica registrada: o dado que faltou.
        assert.deepEqual(resumo.descartadas[0].codigos, ['dado_faltante:TFG']);
    });

    await teste('juiz INVALID manda o plano de volta (criterio `ambos`), com a justificativa dele', async () => {
        const g = gateDeBrinquedo([{ oraculo: 'VALID', juiz: 'INVALID' }, 'VALID'], { maxTentativas: 5 });
        const { resposta, resumo } = await g.resultado;
        assert.deepEqual(g.geradas, ['plano-1', 'plano-2'], 'o plano reprovado pelo juiz foi gerado de novo');
        assert.equal(resposta.resultado, 'plano-2');
        assert.equal(resumo.aceita, true);
        const descartada = resumo.descartadas[0];
        assert.deepEqual([descartada.veredito, descartada.fonte], ['INVALID', 'juiz']);
        assert.equal(descartada.oraculo, 'VALID', 'o oraculo tinha aprovado — e isso fica no registro');
        assert.equal(descartada.juiz, 'INVALID');
        assert.equal(descartada.justificativaJuiz, 'a dose contraria a regra de TFG');
        assert.deepEqual(descartada.codigos, [], 'o juiz nao reprova por codigo');
    });

    await teste('juiz UNRESOLVED tambem manda de volta quando ele e critério', async () => {
        const g = gateDeBrinquedo([{ oraculo: 'VALID', juiz: 'UNRESOLVED' }, 'VALID'], { maxTentativas: 4 });
        const { resumo } = await g.resultado;
        assert.equal(resumo.tentativas, 2);
        assert.deepEqual([resumo.descartadas[0].veredito, resumo.descartadas[0].fonte], ['UNRESOLVED', 'juiz']);
    });

    await teste('criterio `oraculo`: o juiz reprovando NAO manda o plano de volta', async () => {
        const g = gateDeBrinquedo([{ oraculo: 'VALID', juiz: 'INVALID' }], { maxTentativas: 5, criterio: 'oraculo' });
        const { resumo, avaliacao } = await g.resultado;
        assert.deepEqual(g.geradas, ['plano-1'], 'uma geracao so');
        assert.equal(resumo.aceita, true);
        assert.equal(resumo.fonte, 'oraculo');
        assert.equal(resumo.juiz, 'INVALID', 'a discordancia do juiz fica registrada, sem decidir nada');
        assert.equal(avaliacao?.julgamentoLLM?.status, 'INVALID');
    });

    await teste('criterio `juiz`: o juiz aprova mesmo com o oraculo reprovando — e o registro mostra', async () => {
        const g = gateDeBrinquedo([{ oraculo: 'INVALID', juiz: 'VALID' }], { maxTentativas: 5, criterio: 'juiz' });
        const { resumo, avaliacao } = await g.resultado;
        assert.deepEqual(g.geradas, ['plano-1']);
        assert.equal(resumo.aceita, true);
        assert.equal(resumo.fonte, 'juiz');
        assert.equal(resumo.oraculo, 'INVALID', 'o veredito normativo continua no resumo, intacto');
        assert.equal(avaliacao?.oraculo?.veredito, 'INVALID', 'e na avaliacao da linha');
    });

    await teste('criterio `juiz`: o juiz reprovando repete, mesmo com o oraculo VALID', async () => {
        const g = gateDeBrinquedo([{ oraculo: 'VALID', juiz: 'INVALID' }, { oraculo: 'INVALID', juiz: 'VALID' }], {
            maxTentativas: 5,
            criterio: 'juiz'
        });
        const { resumo } = await g.resultado;
        assert.equal(resumo.tentativas, 2);
        assert.equal(resumo.aceita, true);
        assert.deepEqual(
            resumo.descartadas.map(d => [d.fonte, d.veredito, d.oraculo]),
            [['juiz', 'INVALID', 'VALID']]
        );
    });

    await teste('teto de tentativas: para, devolve o ultimo reprovado e marca limiteAtingido', async () => {
        const g = gateDeBrinquedo([{ oraculo: 'VALID', juiz: 'INVALID' }], { maxTentativas: 3 });
        const { resposta, avaliacao, resumo } = await g.resultado;
        assert.deepEqual(g.geradas, ['plano-1', 'plano-2', 'plano-3']);
        assert.equal(resposta.resultado, 'plano-3');
        assert.equal(avaliacao?.plano, 'plano-3', 'a avaliacao devolvida e a do plano devolvido');
        assert.equal(resumo.tentativas, 3);
        assert.equal(resumo.aceita, false);
        assert.deepEqual([resumo.veredito, resumo.fonte], ['INVALID', 'juiz']);
        assert.equal(resumo.oraculo, 'VALID', 'o plano que ficou passou no oraculo e so caiu no juiz');
        assert.equal(resumo.limiteAtingido, true);
        assert.equal(resumo.descartadas.length, 2, 'o plano que ficou nao entra entre os descartados');
    });

    await teste('maxTentativas menor que 1 vira 1', async () => {
        const g = gateDeBrinquedo(['INVALID'], { maxTentativas: 0 });
        const { resumo } = await g.resultado;
        assert.deepEqual(g.geradas, ['plano-1']);
        assert.equal(resumo.maxTentativas, 1);
        assert.equal(resumo.limiteAtingido, true);
    });

    await teste('falha tecnica na avaliacao nao repete a geracao (padrao)', async () => {
        const g = gateDeBrinquedo(['NAO_AVALIADO'], { maxTentativas: 4 });
        const { avaliacao, resumo } = await g.resultado;
        assert.deepEqual(g.geradas, ['plano-1']);
        assert.equal(resumo.tentativas, 1);
        assert.equal(resumo.aceita, false);
        assert.equal(resumo.veredito, 'NAO_AVALIADO');
        assert.equal(resumo.limiteAtingido, false, 'parou por falha tecnica, nao por teto');
        assert.equal(avaliacao?.naoAvaliado, true);
        assert.equal(avaliacao?.motivo, 'grafo fora do ar', 'a linha sai marcada com o motivo');
        assert.deepEqual(resumo.descartadas, []);
    });

    await teste('juiz sem resposta e falha tecnica: nao repete, e a linha sai marcada', async () => {
        const g = gateDeBrinquedo([{ oraculo: 'VALID', juiz: 'NO_RESPONSE' }], { maxTentativas: 4 });
        const { resumo } = await g.resultado;
        assert.deepEqual(g.geradas, ['plano-1'], 'regerar nao faz o juiz responder');
        assert.equal(resumo.aceita, false);
        assert.deepEqual([resumo.veredito, resumo.fonte], ['NO_RESPONSE', 'juiz']);
        assert.equal(resumo.oraculo, 'VALID');
        assert.equal(resumo.limiteAtingido, false);
    });

    await teste('juiz nao chamado com o oraculo VALID (juiz desligado): para, sem repetir', async () => {
        const g = gateDeBrinquedo([{ oraculo: 'VALID', juiz: 'NOT_CALLED' }], { maxTentativas: 4 });
        const { resumo } = await g.resultado;
        assert.deepEqual(g.geradas, ['plano-1']);
        assert.equal(resumo.aceita, false);
        assert.equal(resumo.veredito, 'NOT_CALLED');
    });

    await teste('juiz nao chamado porque a sintaxe e INVALID: isso E defeito do plano, repete', async () => {
        const g = gateDeBrinquedo([{ oraculo: 'INVALID', juiz: 'NOT_CALLED' }, 'VALID'], {
            maxTentativas: 4,
            criterio: 'juiz'
        });
        const { resumo } = await g.resultado;
        assert.equal(resumo.tentativas, 2);
        assert.equal(resumo.aceita, true);
        assert.deepEqual([resumo.descartadas[0].veredito, resumo.descartadas[0].oraculo], ['NOT_CALLED', 'INVALID']);
    });

    await teste('com repetirNaoAvaliado, a falha tecnica entra no laco', async () => {
        const g = gateDeBrinquedo(['NAO_AVALIADO', 'VALID'], { maxTentativas: 4, repetirNaoAvaliado: true });
        const { resumo } = await g.resultado;
        assert.equal(resumo.tentativas, 2);
        assert.equal(resumo.aceita, true);
        assert.deepEqual(
            resumo.descartadas.map(d => [d.veredito, d.motivo]),
            [['NAO_AVALIADO', 'grafo fora do ar']]
        );
    });

    await teste('geracao sem plano: nada e avaliado nem repetido', async () => {
        const g = gateDeBrinquedo(['VALID'], { maxTentativas: 4, semPlano: true });
        const { avaliacao, resumo } = await g.resultado;
        assert.deepEqual(g.geradas, ['plano-1']);
        assert.deepEqual(g.avaliadas, [], 'sem plano, o avaliador nao e chamado');
        assert.equal(avaliacao, undefined);
        assert.equal(resumo.tentativas, 1);
        assert.equal(resumo.aceita, false);
        assert.equal(resumo.veredito, 'NAO_AVALIADO');
    });

    await teste('cancelamento nao comeca tentativa nova', async () => {
        const controlador = new AbortController();
        const g = gateDeBrinquedo(['INVALID'], { maxTentativas: 10, sinal: controlador.signal });
        controlador.abort();
        const { resumo } = await g.resultado;
        assert.equal(resumo.tentativas, 1, 'a tentativa em curso termina, nenhuma outra comeca');
        assert.equal(resumo.aceita, false);
        assert.equal(resumo.limiteAtingido, false, 'parou por cancelamento, nao por teto');
    });

    await teste('os tempos separam a geracao que ficou, as descartadas e as avaliacoes', async () => {
        const g = gateDeBrinquedo(['INVALID', 'VALID'], { maxTentativas: 3, atrasoMs: 12 });
        const { resumo } = await g.resultado;
        assert.ok(resumo.tempoGeracaoAceitaMs >= 10, `geracao aceita medida (${resumo.tempoGeracaoAceitaMs}ms)`);
        assert.ok(resumo.tempoGeracaoDescartadaMs >= 10, `geracao descartada medida (${resumo.tempoGeracaoDescartadaMs}ms)`);
        assert.ok(resumo.tempoAvaliacaoMs >= 20, `as duas avaliacoes somadas (${resumo.tempoAvaliacaoMs}ms)`);
        const descartada = resumo.descartadas[0];
        assert.ok(descartada.tempoGeracaoMs >= 10 && (descartada.tempoAvaliacaoMs ?? 0) >= 10);
        assert.equal(
            resumo.tempoGeracaoDescartadaMs,
            descartada.tempoGeracaoMs,
            'o descartado e exatamente a soma das tentativas reprovadas — a geracao que ficou nao entra'
        );
    });

    await teste('os estagios dizem quem reprovou e a tentativa', async () => {
        const g = gateDeBrinquedo([{ oraculo: 'VALID', juiz: 'INVALID' }, 'VALID'], { maxTentativas: 3 });
        await g.resultado;
        assert.ok(
            g.estagios.some(e => e.includes('Juiz LLM: INVALID') && e.includes('tentativa 2 de 3')),
            `os estagios anunciam quem reprovou: ${JSON.stringify(g.estagios)}`
        );
        assert.ok(g.estagios.some(e => e.includes('juiz LLM')), 'a cascata anunciada inclui o juiz');
        assert.ok(g.estagios.some(e => e.includes('VALID') && e.includes('aceito')));
    });

    await teste('estagio do criterio `oraculo` nao anuncia o juiz na cascata', async () => {
        const g = gateDeBrinquedo(['VALID'], { maxTentativas: 2, criterio: 'oraculo' });
        await g.resultado;
        assert.ok(g.estagios.some(e => e.includes('sintaxe → semântica → oráculo)')));
        assert.ok(!g.estagios.some(e => e.includes('juiz LLM')));
    });

    await teste('decidirGate: a tabela de decisao, critério por critério', () => {
        const oraculoValidJuizInvalid = avaliado('VALID', 'p', 'INVALID');
        assert.equal(decidirGate(oraculoValidJuizInvalid, 'oraculo').aprovado, true);
        assert.equal(decidirGate(oraculoValidJuizInvalid, 'juiz').aprovado, false);
        assert.equal(decidirGate(oraculoValidJuizInvalid, 'ambos').aprovado, false);

        const oraculoInvalidJuizValid = avaliado('INVALID', 'p', 'VALID');
        assert.equal(decidirGate(oraculoInvalidJuizValid, 'oraculo').aprovado, false);
        assert.equal(decidirGate(oraculoInvalidJuizValid, 'juiz').aprovado, true);
        assert.equal(decidirGate(oraculoInvalidJuizValid, 'ambos').aprovado, false);

        const osDois = avaliado('VALID', 'p', 'VALID');
        for (const criterio of ['oraculo', 'juiz', 'ambos'] as CriterioGate[]) {
            assert.equal(decidirGate(osDois, criterio).aprovado, true, `${criterio} aprova os dois VALID`);
        }

        // Falha tecnica nunca aprova, e nunca e tratada como defeito do plano.
        const tecnica = decidirGate(naoAvaliado('p'), 'ambos');
        assert.deepEqual([tecnica.aprovado, tecnica.veredito, tecnica.falhaTecnica], [false, 'NAO_AVALIADO', true]);
        const semJuiz = decidirGate(avaliado('VALID', 'p', 'NO_RESPONSE'), 'ambos');
        assert.deepEqual([semJuiz.aprovado, semJuiz.fonte, semJuiz.falhaTecnica], [false, 'juiz', true]);
        // `oraculo` nao olha o juiz: a falha dele nao reprova nem trava a linha.
        assert.equal(decidirGate(avaliado('VALID', 'p', 'NO_RESPONSE'), 'oraculo').aprovado, true);
        // O padrao, sem criterio explicito, e `ambos`.
        assert.equal(decidirGate(oraculoValidJuizInvalid).aprovado, false);
    });

    await teste('vereditoDoGate: oraculo ausente ou linha nao avaliada viram NAO_AVALIADO', () => {
        assert.equal(vereditoDoGate(avaliado('VALID', 'p')), 'VALID');
        assert.equal(vereditoDoGate(avaliado('INVALID', 'p')), 'INVALID');
        assert.equal(vereditoDoGate(naoAvaliado('p')), 'NAO_AVALIADO');
        assert.equal(vereditoDoGate({ plano: 'p', naoAvaliado: false }), 'NAO_AVALIADO');
    });

    await teste('codigosReprovacao: sintaxe, semantica e dados faltantes, sem repetir', () => {
        const codigos = codigosReprovacao({
            plano: 'p',
            naoAvaliado: false,
            validacaoSintatica: {
                veredito: 'INVALID',
                erros: [
                    { codigo: 'token_inesperado', mensagem: 'x', fonte: 'parser' },
                    { codigo: 'token_inesperado', mensagem: 'y', fonte: 'parser' }
                ]
            },
            validacaoSemantica: {
                veredito: 'INVALID',
                erros: [
                    { etapa: 'pis', codigo: 'conduta_fora_do_contrato', mensagem: 'x' },
                    { etapa: 'global', codigo: 'item_bloqueado', mensagem: 'y' }
                ],
                avisos: [],
                dadosFaltantes: ['TFG', 'plaquetas'],
                etapas: [],
                naoFormalizado: []
            }
        });
        assert.deepEqual(codigos, [
            'token_inesperado',
            'conduta_fora_do_contrato',
            'item_bloqueado',
            'dado_faltante:TFG',
            'dado_faltante:plaquetas'
        ]);
    });

    await teste('codigosReprovacao: avaliacao sem camadas nao inventa codigo', () => {
        assert.deepEqual(codigosReprovacao(naoAvaliado('p')), []);
    });

    console.log(falhas === 0 ? '\nTodos os testes do gate passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
