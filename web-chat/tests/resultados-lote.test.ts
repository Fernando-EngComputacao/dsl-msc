/**
 * O JSONL que o lote baixa (web-chat/src/resultados-lote.ts) depois de rodar
 * com o gate do oraculo: cada linha ja sai avaliada, no mesmo formato do JSONL
 * da avaliacao.
 * Executar (da raiz): npm run test:web-lote
 *
 * O arquivo e lido aqui pelo parser DE VERDADE do backend
 * (`parseRegistrosAvaliacao`, o mesmo de "Importar resultado") e pelo mesmo
 * filtro que POST /api/avaliar usa para separar registro de resultado da linha
 * de resumo — e isso que garante que o arquivo serve nas duas telas.
 *
 * O que se cobra:
 *   1. com o gate: cada cenario vira um registro avaliado, com `dominio`, `lado`
 *      e as camadas separadas (sintaxe, semantica, oraculo, juiz);
 *   2. o `plano` da linha e o da GERACAO — a avaliacao nao o sobrescreve;
 *   3. a linha de resumo nao e registro de resultado em nenhuma das duas telas;
 *   4. os agregados do arquivo: tempo da avaliacao com nome proprio (para nao
 *      colidir com o tempo de geracao do cenario) e os tempos de geracao somados;
 *   5. os tempos do cenario nao se misturam: `tempoTotalMs` e so a geracao que ficou;
 *   6. o resumo conta vereditos (oraculo e juiz), regeracoes, quem reprovou e quem bateu o teto;
 *   6b. descarte pelo JUIZ: a justificativa dele e os dois vereditos ficam no arquivo;
 *   7. sem o gate, o formato antigo fica intacto (nada de `lado` nem de camadas);
 *   8. linha que falhou na geracao continua saindo, com o erro.
 */

import assert from 'node:assert/strict';

import { parseRegistrosAvaliacao, type RegistroAvaliacaoImportado } from '../../src/inference/avaliacao-jsonl.js';
import type { DetalheLado, ResumoGate, StatusJuiz, Veredito } from '../src/api';
import { agregadosDoLote, conteudoDoArquivo, resumoVereditos } from '../src/resultados-lote';
import type { ItemResultadoLote, LoteEstado } from '../src/types';

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

/** O mesmo filtro de `parseRegistrosAvaliar` (src/web/server.ts): registro de resultado tem plano. */
const ehRegistroDeResultado = (r: RegistroAvaliacaoImportado): boolean =>
    typeof r.plano === 'string' || typeof r.resultado === 'string';

function avaliacaoDe(veredito: Veredito, plano: string, juiz: StatusJuiz = 'VALID'): DetalheLado {
    return {
        plano,
        sujeito: 'PT-0001',
        naoAvaliado: false,
        violacao: false,
        contextoGrafo: 'PROMPT SEMANTICO RECONSTRUIDO (nao deve ir para o arquivo)',
        validacaoSintatica: { veredito: 'VALID', erros: [] },
        validacaoSemantica: { veredito, erros: [], avisos: [], dadosFaltantes: [], etapas: [], naoFormalizado: [] },
        oraculo: { veredito, origem: 'semantica' },
        julgamentoLLM: { status: juiz, justificativa: 'coerente com as regras' },
        concordancia: veredito === juiz,
        classificacao: veredito === 'VALID' ? 'VALIDO_PELO_ORACULO' : 'INVALIDO_PELO_ORACULO',
        tempos: { sintaxeMs: 20, recuperacaoMs: 30, oraculoMs: 50, llmJudgeMs: 400, paraleloMs: 450, totalMs: 500 }
    };
}

/** O resumo do gate de um cenário: `fonteDoDescarte` diz quem reprovou as tentativas jogadas fora. */
function gate(
    tentativas: number,
    aceita: boolean,
    limiteAtingido = false,
    fonteDoDescarte: 'oraculo' | 'juiz' = 'oraculo'
): ResumoGate {
    return {
        tentativas,
        maxTentativas: 5,
        criterio: 'ambos',
        aceita,
        veredito: aceita ? 'VALID' : 'INVALID',
        fonte: fonteDoDescarte,
        oraculo: 'VALID',
        juiz: aceita ? 'VALID' : 'INVALID',
        limiteAtingido,
        tempoGeracaoAceitaMs: 1000,
        tempoGeracaoDescartadaMs: (tentativas - 1) * 1000,
        tempoAvaliacaoMs: tentativas * 500,
        descartadas: Array.from({ length: tentativas - 1 }, (_valor, i) => ({
            tentativa: i + 1,
            plano: `descartado-${i + 1}`,
            veredito: 'INVALID' as const,
            fonte: fonteDoDescarte,
            oraculo: (fonteDoDescarte === 'juiz' ? 'VALID' : 'INVALID') as Veredito,
            juiz: 'INVALID' as const,
            ...(fonteDoDescarte === 'oraculo' ? { origem: 'semantica' as const } : {}),
            codigos: fonteDoDescarte === 'oraculo' ? ['item_bloqueado'] : [],
            ...(fonteDoDescarte === 'juiz' ? { justificativaJuiz: 'a dose contraria a regra de TFG' } : {}),
            tempoGeracaoMs: 1000,
            tempoAvaliacaoMs: 500
        }))
    };
}

/** Um cenario do lote como `rodarLote` o monta, com o gate ligado. */
function itemComGate(
    linha: number,
    veredito: Veredito,
    tentativas: number,
    limiteAtingido = false,
    juiz: StatusJuiz = 'VALID',
    fonteDoDescarte: 'oraculo' | 'juiz' = 'oraculo'
): ItemResultadoLote {
    const plano = `PLANO DA LINHA ${linha}`;
    return {
        linha,
        intencao: `intencao ${linha}`,
        aceito: true,
        valido: true,
        erroMotor: null,
        regrasEmGHat: 7,
        telemetria: { paciente: 'PT-0001', telemetria: { PAM: 52 }, populacoes: [], farmacosEmUso: [] },
        promptSemantico: 'PROMPT SEMANTICO DA GERACAO',
        plano,
        avaliacao: avaliacaoDe(veredito, plano, juiz),
        geracaoValidada: gate(tentativas, veredito === 'VALID' && juiz === 'VALID', limiteAtingido, fonteDoDescarte),
        // Tempos da geracao (tempoTotalMs = so a geracao que ficou) e do gate.
        tempoTotalMs: 1000,
        tempoTotalSegundos: 1,
        tempoSequenciasMs: 300,
        tempoSequenciasSegundos: 0.3,
        tempoPIsValidasMs: 500,
        tempoPIsValidasSegundos: 0.5,
        tempoValidacaoPlanosMs: 200,
        tempoValidacaoPlanosSegundos: 0.2,
        tentativasGeracao: tentativas,
        tempoGeracaoDescartadaMs: (tentativas - 1) * 1000,
        tempoGeracaoDescartadaSegundos: (tentativas - 1) * 1,
        tempoValidacaoMs: tentativas * 500,
        tempoValidacaoSegundos: tentativas * 0.5,
        tempoCenarioMs: tentativas * 1500,
        tempoCenarioSegundos: tentativas * 1.5
    };
}

function lote(resultados: ItemResultadoLote[], comGate: boolean): LoteEstado {
    return {
        nomeArquivo: 'cenarios.jsonl',
        total: resultados.length,
        concluidos: resultados.length,
        ...(comGate ? { validacao: { maxTentativas: 5, criterio: 'ambos' as const, juiz: true } } : {}),
        cancelado: false,
        finalizado: true,
        resultados,
        iniciadoEm: Date.now() - 60_000,
        duracaoSegundos: 60,
        tempoTotalBatchMs: 59_000
    };
}

// Um lote de tres cenarios: VALID de primeira, VALID na terceira tentativa e um
// INVALID que bateu o teto.
const COM_GATE = lote([itemComGate(1, 'VALID', 1), itemComGate(2, 'VALID', 3), itemComGate(3, 'INVALID', 5, true)], true);
const REGISTROS = parseRegistrosAvaliacao(conteudoDoArquivo('med', COM_GATE));
const PLANOS = REGISTROS.filter(ehRegistroDeResultado);
const RESUMO = REGISTROS[REGISTROS.length - 1];

teste('o arquivo tem um registro por cenario mais a linha de resumo', () => {
    assert.equal(REGISTROS.length, 4);
    assert.equal(PLANOS.length, 3);
});

teste('cada registro sai avaliado, com dominio, lado e as camadas separadas', () => {
    for (const r of PLANOS) {
        assert.equal(r.dominio, 'med');
        assert.equal(r.lado, 'arquitetura', 'o lote do chat gera pela arquitetura');
        assert.equal(r.naoAvaliado, false);
        assert.equal(r.validacaoSintatica?.veredito, 'VALID');
        assert.ok(r.validacaoSemantica?.veredito, 'a semantica vai no registro');
        assert.ok(r.oraculo?.veredito, 'o oraculo vai no registro');
        assert.equal(r.oraculo?.origem, 'semantica');
        assert.equal(r.julgamentoLLM?.status, 'VALID', 'o juiz LLM vai no registro, sem decidir nada');
        assert.ok(r.classificacao, 'a classificacao final vai no registro');
        assert.equal(r.tempos?.totalMs, 500, 'os tempos daquela avaliacao vao no registro');
        assert.equal(r.sujeito, 'PT-0001');
    }
    assert.deepEqual(
        PLANOS.map(r => r.oraculo?.veredito),
        ['VALID', 'VALID', 'INVALID'],
        'o teto batido sai com o veredito real do ultimo plano — nada e maquiado'
    );
});

teste('o plano da linha e o da geracao, e o Prompt Semantico reconstruido nao vai', () => {
    assert.deepEqual(
        PLANOS.map(r => r.plano),
        ['PLANO DA LINHA 1', 'PLANO DA LINHA 2', 'PLANO DA LINHA 3']
    );
    for (const r of PLANOS) {
        assert.equal(r.promptSemantico, 'PROMPT SEMANTICO DA GERACAO');
        assert.equal(r.contextoGrafo, undefined, '`contextoGrafo` fica fora do arquivo');
        assert.ok(r.telemetria, 'a telemetria do cenario continua na linha (da para reavaliar)');
    }
});

teste('a linha de resumo nao e registro de resultado em nenhuma das duas telas', () => {
    assert.equal(ehRegistroDeResultado(RESUMO), false, '/api/avaliar a ignora: nao tem plano');
    assert.equal(RESUMO.lado, undefined, 'a tela de importacao a ignora: nao tem lado');
    assert.equal(RESUMO.quantidadeCenariosProcessados, 3);
    assert.equal(RESUMO.duracaoSegundos, 60);
    assert.equal(RESUMO.tempoTotalBatchSegundos, 59);
});

teste('os agregados do arquivo: o tempo da avaliacao tem nome proprio', () => {
    for (const r of PLANOS) {
        // 3 planos x 500ms de avaliacao.
        assert.equal(r.tempoAvaliacaoTotalSegundos, 1.5);
        assert.equal(r.tempoSintaxeSegundos, 0.06);
        assert.equal(r.tempoOraculoSegundos, 0.15);
        assert.equal(r.tempoLlmJudgeSegundos, 1.2);
        assert.equal(r.tempoDiagnosticoSegundos, undefined, 'sem diagnostico, o campo nao existe');
        // `tempoTotalSegundos` aqui continua sendo o do CENARIO (geracao), nao o da avaliacao.
        assert.equal(r.tempoTotalSegundos, 1);
    }
});

teste('os tempos de geracao somados batem com o que a avaliacao agregaria', () => {
    const r = PLANOS[0];
    assert.equal(r.tempoGeracaoTotalSegundos, 3, '3 cenarios x 1000ms da geracao que ficou');
    assert.equal(r.tempoGeracaoSequenciasSegundos, 0.9);
    assert.equal(r.tempoGeracaoPIsValidasSegundos, 1.5);
    assert.equal(r.tempoGeracaoValidacaoPlanosSegundos, 0.6);
});

teste('os tempos do cenario nao se misturam: tempoTotalMs e so a geracao que ficou', () => {
    const r = PLANOS[1];
    assert.equal(r.tempoTotalMs, 1000, 'as tentativas descartadas nao entram aqui');
    assert.equal(r.tempoGeracaoDescartadaMs, 2000, 'duas tentativas reprovadas');
    assert.equal(r.tempoValidacaoMs, 1500, 'as tres avaliacoes do cenario');
    assert.equal(r.tempoCenarioMs, 4500, 'o relogio do cenario inteiro');
    assert.equal(r.tentativasGeracao, 3);
});

teste('o resumo conta vereditos, regeracoes e quem bateu o teto', () => {
    const g = RESUMO.gate as Record<string, unknown>;
    assert.equal(g.criterio, 'ambos', 'o resumo diz QUEM reprovava neste lote');
    assert.equal(g.maxTentativas, 5);
    assert.equal(g.juizLLM, true);
    assert.equal(g.avaliados, 3);
    assert.equal(g.valid, 2);
    assert.equal(g.invalid, 1);
    assert.equal(g.unresolved, 0);
    assert.equal(g.naoAvaliados, 0);
    assert.equal(g.juizValid, 3, 'o juiz aprovou as tres linhas que ficaram');
    assert.equal(g.juizReprovou, 0);
    assert.equal(g.juizSemVeredito, 0);
    assert.equal(g.naoAprovados, 1, 'a linha que bateu o teto nao foi aprovada pelo gate');
    assert.equal(g.aceitosDePrimeira, 1);
    assert.equal(g.limiteAtingido, 1);
    assert.equal(g.geracoes, 9, '1 + 3 + 5 geracoes');
    assert.equal(g.descartesPeloOraculo, 6, '2 + 4 tentativas reprovadas pelo oraculo');
    assert.equal(g.descartesPeloJuiz, 0);
    assert.equal(RESUMO.tempoValidacaoTotalSegundos, 4.5);
    assert.equal(RESUMO.tempoGeracaoDescartadaTotalSegundos, 6);
});

teste('descarte pelo JUIZ: o arquivo guarda a justificativa dele e os dois vereditos', () => {
    // Oraculo aprovou todas as tentativas; o juiz reprovou, e o teto foi batido.
    const registros = parseRegistrosAvaliacao(
        conteudoDoArquivo('med', lote([itemComGate(1, 'VALID', 3, true, 'INVALID', 'juiz')], true))
    );
    const linha = registros[0];
    assert.equal(linha.oraculo?.veredito, 'VALID', 'o oraculo aprovou o plano que ficou');
    assert.equal(linha.julgamentoLLM?.status, 'INVALID', 'e o juiz reprovou — a linha nao esconde isso');

    const g = linha.geracaoValidada as ResumoGate;
    assert.equal(g.criterio, 'ambos');
    assert.equal(g.aceita, false);
    assert.equal(g.fonte, 'juiz', 'quem reprovou foi o juiz');
    assert.equal(g.limiteAtingido, true);
    assert.equal(g.descartadas.length, 2);
    assert.deepEqual(
        g.descartadas.map(d => d.fonte),
        ['juiz', 'juiz']
    );
    assert.equal(g.descartadas[0].justificativaJuiz, 'a dose contraria a regra de TFG');
    assert.equal(g.descartadas[0].oraculo, 'VALID', 'o veredito normativo da tentativa descartada fica registrado');
    assert.deepEqual(g.descartadas[0].codigos, [], 'o juiz nao reprova por codigo');

    const bloco = registros[1].gate as Record<string, unknown>;
    assert.equal(bloco.descartesPeloJuiz, 2);
    assert.equal(bloco.descartesPeloOraculo, 0);
    assert.equal(bloco.juizReprovou, 1);
    assert.equal(bloco.valid, 1, 'o oraculo aprovou a linha que ficou');
    assert.equal(bloco.naoAprovados, 1, 'mas o gate nao a aprovou');
});

teste('as tentativas descartadas ficam no registro: a taxa de acerto de primeira nao se perde', () => {
    const r = PLANOS[1];
    const g = r.geracaoValidada as ResumoGate;
    assert.equal(g.tentativas, 3);
    assert.equal(g.descartadas.length, 2);
    assert.deepEqual(g.descartadas[0].codigos, ['item_bloqueado']);
});

teste('sem o gate, o formato antigo fica intacto', () => {
    const semGate: ItemResultadoLote = {
        linha: 1,
        intencao: 'sobe a nora',
        aceito: true,
        valido: true,
        plano: 'PLANO',
        telemetria: { paciente: 'PT-0001', telemetria: { PAM: 52 } },
        tempoTotalMs: 900,
        tempoTotalSegundos: 0.9
    };
    const registros = parseRegistrosAvaliacao(conteudoDoArquivo('med', lote([semGate], false)));
    assert.equal(registros.length, 2);
    const linha = registros[0];
    assert.equal(linha.plano, 'PLANO');
    assert.equal(linha.lado, undefined, 'sem avaliacao nao ha lado');
    assert.equal(linha.oraculo, undefined);
    assert.equal(linha.dominio, undefined);
    assert.equal(linha.tempoAvaliacaoTotalSegundos, undefined, 'nenhum tempo de avaliacao inventado');
    assert.equal(linha.tempoGeracaoTotalSegundos, 0.9, 'o tempo de geracao continua agregado');
    assert.equal(registros[1].gate, undefined, 'o resumo nao fala de um gate que nao rodou');
    assert.equal(ehRegistroDeResultado(linha), true, 'continua valendo para "Julgar resultado"');
});

teste('linha que falhou na geracao continua saindo, com o erro', () => {
    const comErro: ItemResultadoLote = { linha: 2, intencao: 'x', aceito: false, erro: 'motor inacessivel' };
    const registros = parseRegistrosAvaliacao(conteudoDoArquivo('med', lote([itemComGate(1, 'VALID', 1), comErro], true)));
    const falhou = registros[1];
    assert.equal(falhou.erro, 'motor inacessivel');
    assert.equal(falhou.plano, undefined);
    assert.equal(falhou.lado, undefined, 'sem plano avaliado, a linha nao entra como lado na importacao');
    assert.equal(ehRegistroDeResultado(falhou), false, 'e /api/avaliar tambem a ignora');
});

teste('resumoVereditos conta a falha tecnica separada do veredito', () => {
    const item = itemComGate(1, 'VALID', 1);
    const naoAvaliado: ItemResultadoLote = {
        ...itemComGate(2, 'INVALID', 1),
        avaliacao: { plano: 'P', naoAvaliado: true, motivo: 'grafo fora do ar' }
    };
    const r = resumoVereditos([item, naoAvaliado]);
    assert.equal(r.avaliados, 1);
    assert.equal(r.valid, 1);
    assert.equal(r.invalid, 0);
    assert.equal(r.naoAvaliados, 1);
});

teste('agregadosDoLote nao inventa campo que nenhum registro trouxe', () => {
    assert.deepEqual(agregadosDoLote([{ linha: 1, intencao: 'x', aceito: false, erro: 'falhou' }]), {});
});

console.log(falhas === 0 ? '\nTodos os testes do JSONL do lote passaram.' : `\n${falhas} teste(s) falharam.`);
if (falhas > 0) process.exit(1);
