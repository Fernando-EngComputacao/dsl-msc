/**
 * Os dois juizes no mesmo plano (src/inference/comparacao-juizes.ts).
 * Executar (da raiz): npm run test:comparacao-juizes
 *
 * O modulo nao julga nada: ele CASA o plano rejulgado com o julgamento que o
 * arquivo importado ja tinha, e conta. O que se cobra:
 *
 *   1. o pareamento e por CONTEUDO (sujeito + pedido + plano), e sobrevive a
 *      avaliacao que renumerou as linhas — o caso real de `evalueted_*` em que
 *      `linha` e o indice do lote;
 *   2. plano sem par NAO recebe veredito emprestado: fica em `semPar` e fora de
 *      toda conta, e nunca e casado pela ordem;
 *   3. cada juiz entra na sua fonte pelo PROVEDOR que o julgou, nao pelo nome do
 *      campo (um arquivo rejulgado reaberto depois tem de dar a mesma leitura);
 *   4. as contas sao as de analise-avaliacao.ts (concordancia, matriz, kappa),
 *      com os denominadores explicitos: juiz sem veredito (NOT_CALLED,
 *      NO_RESPONSE) sai do par, nao conta como erro;
 *   5. `contraOraculo` separa quem acompanha o oraculo plano a plano — e a
 *      leitura de "a avaliacao esta certa?";
 *   6. as divergencias trazem os dois vereditos, as duas justificativas e quem
 *      acompanhou o oraculo.
 */

import assert from 'node:assert/strict';

import type { RegistroAvaliacaoImportado } from '../inference/avaliacao-jsonl.js';
import type { DetalheLado, DetalheLinha, StatusJuiz } from '../inference/avaliar-grafo.js';
import { anexarJulgamentoAnterior, compararJuizes } from '../inference/comparacao-juizes.js';
import type { Veredito } from '../knowledge/validacao.js';

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

const FRONTEIRA = { provedor: 'claude', modelo: 'claude-opus-5-5' };

/** Um lado rejulgado: o veredito do oraculo e o do juiz de fronteira. */
function lado(o: {
    plano: string;
    sujeito?: string;
    oraculo?: Veredito;
    fronteira?: StatusJuiz;
    justificativa?: string;
}): DetalheLado {
    return {
        plano: o.plano,
        ...(o.sujeito ? { sujeito: o.sujeito } : {}),
        naoAvaliado: false,
        ...(o.oraculo ? { oraculo: { veredito: o.oraculo, origem: 'semantica' as const } } : {}),
        julgamentoLLM: {
            ...FRONTEIRA,
            status: o.fronteira ?? 'VALID',
            ...(o.justificativa ? { justificativa: o.justificativa } : {})
        }
    };
}

function linha(numero: number, intencao: string, arquitetura: DetalheLado, baseline?: DetalheLado): DetalheLinha {
    return {
        linha: numero,
        intencao,
        arquitetura,
        ...(baseline ? { baseline } : {}),
        temDivergencia: false,
        temDiscordancia: false
    };
}

/** Um registro do arquivo importado, com o julgamento do juiz LOCAL. */
function importado(o: {
    linha?: number;
    intencao?: string;
    plano?: string;
    sujeito?: string;
    lado?: 'arquitetura' | 'baseline';
    local?: StatusJuiz;
    justificativa?: string;
}): RegistroAvaliacaoImportado {
    return {
        dominio: 'med',
        lado: o.lado ?? 'arquitetura',
        ...(o.linha !== undefined ? { linha: o.linha } : {}),
        ...(o.intencao !== undefined ? { intencao: o.intencao } : {}),
        ...(o.plano !== undefined ? { plano: o.plano } : {}),
        ...(o.sujeito !== undefined ? { sujeito: o.sujeito } : {}),
        julgamentoLLM: {
            status: o.local ?? 'VALID',
            ...(o.justificativa ? { justificativa: o.justificativa } : {})
        }
    };
}

// ===========================================================================
console.log('\nPareamento: o mesmo plano nos dois arquivos');

teste('casa pelo conteudo mesmo quando a avaliacao renumerou as linhas', () => {
    const linhas = [
        linha(1, 'pedido A', lado({ plano: 'P-A', sujeito: 'PT-1' })),
        linha(2, 'pedido B', lado({ plano: 'P-B', sujeito: 'PT-2' }))
    ];
    // No arquivo importado as MESMAS linhas estao numeradas 41 e 42.
    const importados = [
        importado({ linha: 42, intencao: 'pedido B', plano: 'P-B', sujeito: 'PT-2', local: 'INVALID' }),
        importado({ linha: 41, intencao: 'pedido A', plano: 'P-A', sujeito: 'PT-1', local: 'VALID' })
    ];
    const p = anexarJulgamentoAnterior(linhas, importados);
    assert.equal(p.pareados, 2);
    assert.equal(p.semPar, 0);
    assert.equal(p.importadosSemPar, 0);
    assert.equal(p.linhas[0].arquitetura!.julgamentoAnterior?.status, 'VALID');
    assert.equal(p.linhas[1].arquitetura!.julgamentoAnterior?.status, 'INVALID');
});

teste('casa pelo numero da linha quando o conteudo nao basta', () => {
    const linhas = [linha(7, 'pedido', lado({ plano: 'P' }))];
    const importados = [importado({ linha: 7, local: 'UNRESOLVED' })];
    const p = anexarJulgamentoAnterior(linhas, importados);
    assert.equal(p.pareados, 1);
    assert.equal(p.linhas[0].arquitetura!.julgamentoAnterior?.status, 'UNRESOLVED');
});

teste('sem chave nenhuma em comum, fica SEM PAR — nunca casado pela ordem', () => {
    const linhas = [linha(1, 'pedido A', lado({ plano: 'P-A', sujeito: 'PT-1' }))];
    const importados = [importado({ linha: 99, intencao: 'outro pedido', plano: 'OUTRO', sujeito: 'PT-9', local: 'INVALID' })];
    const p = anexarJulgamentoAnterior(linhas, importados);
    assert.equal(p.pareados, 0);
    assert.equal(p.semPar, 1);
    assert.equal(p.importadosSemPar, 1);
    assert.equal(p.linhas[0].arquitetura!.julgamentoAnterior, undefined, 'nao pode herdar o veredito de outro plano');
});

teste('cada registro importado e usado uma vez so', () => {
    const iguais = [linha(1, 'p', lado({ plano: 'P' })), linha(2, 'p', lado({ plano: 'P' }))];
    const importados = [importado({ linha: 1, intencao: 'p', plano: 'P', local: 'VALID' })];
    const p = anexarJulgamentoAnterior(iguais, importados);
    assert.equal(p.pareados, 1, 'o segundo plano nao tem par');
    assert.equal(p.semPar, 1);
});

teste('os lados nao se misturam: arquitetura casa com arquitetura', () => {
    const linhas = [linha(1, 'p', lado({ plano: 'A', sujeito: 'PT-1' }), lado({ plano: 'B', sujeito: 'PT-1' }))];
    const importados = [
        importado({ lado: 'baseline', linha: 1, intencao: 'p', plano: 'B', sujeito: 'PT-1', local: 'INVALID' }),
        importado({ lado: 'arquitetura', linha: 1, intencao: 'p', plano: 'A', sujeito: 'PT-1', local: 'VALID' })
    ];
    const p = anexarJulgamentoAnterior(linhas, importados);
    assert.equal(p.linhas[0].arquitetura!.julgamentoAnterior?.status, 'VALID');
    assert.equal(p.linhas[0].baseline!.julgamentoAnterior?.status, 'INVALID');
});

teste('registro importado sem julgamento do juiz nao e candidato a par', () => {
    const linhas = [linha(1, 'p', lado({ plano: 'P' }))];
    const semJuiz: RegistroAvaliacaoImportado = { dominio: 'med', lado: 'arquitetura', linha: 1, plano: 'P' };
    const p = anexarJulgamentoAnterior(linhas, [semJuiz]);
    assert.equal(p.pareados, 0);
    assert.equal(p.semPar, 1);
});

teste('o julgamento anterior chega com justificativa e identidade preservadas', () => {
    const linhas = [linha(1, 'p', lado({ plano: 'P' }))];
    const anterior: RegistroAvaliacaoImportado = {
        dominio: 'med',
        lado: 'arquitetura',
        linha: 1,
        plano: 'P',
        julgamentoLLM: { status: 'INVALID', justificativa: 'viola a politica', evidencias: ['PAM 52'], provedor: 'local' }
    };
    const p = anexarJulgamentoAnterior(linhas, [anterior]);
    const j = p.linhas[0].arquitetura!.julgamentoAnterior!;
    assert.equal(j.justificativa, 'viola a politica');
    assert.deepEqual(j.evidencias, ['PAM 52']);
    assert.equal(j.provedor, 'local');
});

// ===========================================================================
console.log('\nAs contas');

/** Quatro planos: concorda, local acerta, fronteira acerta, nenhum acerta. */
function cenarioCompleto(): DetalheLinha[] {
    const linhas = [
        linha(1, 'p1', lado({ plano: 'P1', sujeito: 'PT-1', oraculo: 'VALID', fronteira: 'VALID' })),
        linha(2, 'p2', lado({ plano: 'P2', sujeito: 'PT-2', oraculo: 'INVALID', fronteira: 'VALID' })),
        linha(3, 'p3', lado({ plano: 'P3', sujeito: 'PT-3', oraculo: 'INVALID', fronteira: 'INVALID' })),
        linha(4, 'p4', lado({ plano: 'P4', sujeito: 'PT-4', oraculo: 'UNRESOLVED', fronteira: 'VALID' }))
    ];
    const importados = [
        importado({ linha: 1, intencao: 'p1', plano: 'P1', sujeito: 'PT-1', local: 'VALID' }),
        importado({ linha: 2, intencao: 'p2', plano: 'P2', sujeito: 'PT-2', local: 'INVALID' }),
        importado({ linha: 3, intencao: 'p3', plano: 'P3', sujeito: 'PT-3', local: 'VALID' }),
        importado({ linha: 4, intencao: 'p4', plano: 'P4', sujeito: 'PT-4', local: 'INVALID' })
    ];
    return anexarJulgamentoAnterior(linhas, importados).linhas;
}

teste('concordancia entre os juizes, com o denominador explicito', () => {
    const c = compararJuizes(cenarioCompleto(), FRONTEIRA, 'med');
    assert.equal(c.total, 4);
    assert.equal(c.semPar, 0);
    assert.equal(c.entreJuizes.comparaveis, 4);
    // Os dois disseram a mesma coisa so em p1; p2, p3 e p4 divergem.
    assert.equal(c.entreJuizes.concordancia.n, 1);
    assert.equal(c.entreJuizes.concordancia.denominador, 4);
    assert.equal(c.entreJuizes.discordancia.n, 3);
});

teste('quem acompanha o oraculo, plano a plano', () => {
    const c = compararJuizes(cenarioCompleto(), FRONTEIRA, 'med');
    assert.equal(c.contraOraculo.n, 4);
    assert.equal(c.contraOraculo.ambos, 1, 'p1: os dois disseram VALID como o oraculo');
    assert.equal(c.contraOraculo.soLocal, 1, 'p2: o local acertou INVALID e a fronteira disse VALID');
    assert.equal(c.contraOraculo.soFronteira, 1, 'p3: a fronteira acertou INVALID e o local disse VALID');
    assert.equal(c.contraOraculo.nenhum, 1, 'p4: oraculo UNRESOLVED, nenhum dos dois');
    assert.equal(
        c.contraOraculo.ambos + c.contraOraculo.soLocal + c.contraOraculo.soFronteira + c.contraOraculo.nenhum,
        c.contraOraculo.n,
        'as quatro caixas somam o denominador'
    );
});

teste('cada juiz contra o oraculo, com as contas de analise-avaliacao', () => {
    const c = compararJuizes(cenarioCompleto(), FRONTEIRA, 'med');
    assert.equal(c.oraculoLocal.concordancia.n, 2, 'o local acertou p1 e p2');
    assert.equal(c.oraculoFronteira.concordancia.n, 2, 'a fronteira acertou p1 e p3');
    assert.equal(c.oraculoLocal.concordancia.denominador, 4);
    for (const comp of [c.oraculoLocal, c.oraculoFronteira, c.entreJuizes]) {
        assert.ok(comp.kappa.po !== null && comp.kappa.pe !== null, 'po e pe calculados');
        assert.deepEqual(comp.classes, ['VALID', 'INVALID', 'UNRESOLVED']);
    }
});

teste('a matriz e fronteira (linha) x local (coluna), e soma os comparaveis', () => {
    const c = compararJuizes(cenarioCompleto(), FRONTEIRA, 'med');
    const m = c.entreJuizes.matriz;
    assert.equal(m.VALID.VALID, 1, 'p1');
    assert.equal(m.VALID.INVALID, 2, 'p2 e p4: a fronteira disse VALID e o local INVALID');
    assert.equal(m.INVALID.VALID, 1, 'p3');
    const soma = Object.values(m).reduce((s, linhaM) => s + Object.values(linhaM).reduce((a, b) => a + b, 0), 0);
    assert.equal(soma, c.entreJuizes.comparaveis);
});

teste('juiz sem veredito sai do par em vez de contar como erro', () => {
    const linhas = [
        linha(1, 'p1', lado({ plano: 'P1', sujeito: 'PT-1', oraculo: 'VALID', fronteira: 'NO_RESPONSE' })),
        linha(2, 'p2', lado({ plano: 'P2', sujeito: 'PT-2', oraculo: 'VALID', fronteira: 'VALID' }))
    ];
    const importados = [
        importado({ linha: 1, intencao: 'p1', plano: 'P1', sujeito: 'PT-1', local: 'VALID' }),
        importado({ linha: 2, intencao: 'p2', plano: 'P2', sujeito: 'PT-2', local: 'NOT_CALLED' })
    ];
    const c = compararJuizes(anexarJulgamentoAnterior(linhas, importados).linhas, FRONTEIRA, 'med');
    assert.equal(c.entreJuizes.comparaveis, 0, 'nenhum plano tem os dois vereditos');
    assert.equal(c.contraOraculo.n, 0);
    assert.equal(c.divergencias.length, 0, 'sem veredito nao e divergencia');
    assert.equal(c.cobertura.fronteira.cobertura.n, 1, 'a fronteira respondeu 1 de 2');
    assert.equal(c.cobertura.local.cobertura.n, 1);
    assert.equal(c.distribuicoes.fronteira.porEstado.NO_RESPONSE.n, 1);
    assert.equal(c.distribuicoes.local.porEstado.NOT_CALLED.n, 1);
});

teste('plano sem par nao entra em conta nenhuma, e aparece em semPar', () => {
    const linhas = [
        linha(1, 'p1', lado({ plano: 'P1', sujeito: 'PT-1', oraculo: 'VALID', fronteira: 'INVALID' })),
        linha(2, 'p2', lado({ plano: 'P2', sujeito: 'PT-2', oraculo: 'VALID', fronteira: 'VALID' }))
    ];
    const importados = [importado({ linha: 2, intencao: 'p2', plano: 'P2', sujeito: 'PT-2', local: 'VALID' })];
    const c = compararJuizes(anexarJulgamentoAnterior(linhas, importados).linhas, FRONTEIRA, 'med');
    assert.equal(c.total, 2);
    assert.equal(c.semPar, 1);
    assert.equal(c.entreJuizes.comparaveis, 1, 'so o plano pareado e comparavel');
    assert.equal(c.contraOraculo.n, 1);
    assert.equal(c.divergencias.length, 0);
});

// ===========================================================================
console.log('\nAs divergencias');

teste('divergencia traz os dois vereditos, as duas justificativas e quem acompanhou o oraculo', () => {
    const linhas = [
        linha(
            3,
            'pedido do caso',
            lado({ plano: 'P3', sujeito: 'PT-3', oraculo: 'INVALID', fronteira: 'INVALID', justificativa: 'viola o limite' })
        )
    ];
    const importados = [
        importado({
            linha: 3,
            intencao: 'pedido do caso',
            plano: 'P3',
            sujeito: 'PT-3',
            local: 'VALID',
            justificativa: 'me parece correto'
        })
    ];
    const c = compararJuizes(anexarJulgamentoAnterior(linhas, importados).linhas, FRONTEIRA, 'med');
    assert.equal(c.divergencias.length, 1);
    const d = c.divergencias[0];
    assert.equal(d.linha, 3);
    assert.equal(d.lado, 'arquitetura');
    assert.equal(d.sujeito, 'PT-3');
    assert.equal(d.intencao, 'pedido do caso');
    assert.equal(d.oraculo, 'INVALID');
    assert.equal(d.local, 'VALID');
    assert.equal(d.fronteira, 'INVALID');
    assert.equal(d.acompanhaOraculo, 'fronteira');
    assert.equal(d.justificativaLocal, 'me parece correto');
    assert.equal(d.justificativaFronteira, 'viola o limite');
});

teste('sem veredito do oraculo, a divergencia existe sem dizer quem acertou', () => {
    const linhas = [linha(1, 'p', lado({ plano: 'P', sujeito: 'PT-1', fronteira: 'INVALID' }))];
    const importados = [importado({ linha: 1, intencao: 'p', plano: 'P', sujeito: 'PT-1', local: 'VALID' })];
    const c = compararJuizes(anexarJulgamentoAnterior(linhas, importados).linhas, FRONTEIRA, 'med');
    assert.equal(c.divergencias.length, 1);
    assert.equal(c.divergencias[0].oraculo, undefined);
    assert.equal(c.divergencias[0].acompanhaOraculo, undefined);
    assert.equal(c.contraOraculo.n, 0);
});

// ===========================================================================
console.log('\nQuem e quem: o provedor decide a fonte, nao o campo');

teste('arquivo rejulgado reaberto da a mesma leitura (fronteira em julgamentoLLM)', () => {
    // O que `ResultadosImportados.vue` monta ao reabrir um `evalueted_*` rejulgado:
    // o juiz de fronteira em `julgamentoLLM` (com provedor) e o local ao lado.
    const linhas: DetalheLinha[] = [
        {
            linha: 1,
            intencao: 'p',
            temDivergencia: false,
            temDiscordancia: false,
            arquitetura: {
                plano: 'P',
                naoAvaliado: false,
                oraculo: { veredito: 'INVALID', origem: 'semantica' },
                julgamentoLLM: { ...FRONTEIRA, status: 'INVALID' },
                julgamentoAnterior: { status: 'VALID' }
            }
        }
    ];
    const c = compararJuizes(linhas, FRONTEIRA, 'med');
    assert.equal(c.distribuicoes.fronteira.porEstado.INVALID.n, 1, 'o com provedor e o de fronteira');
    assert.equal(c.distribuicoes.local.porEstado.VALID.n, 1, 'o sem provedor e o local');
    assert.equal(c.contraOraculo.soFronteira, 1);
});

teste('invertido (o local em julgamentoLLM) da a MESMA leitura', () => {
    const linhas: DetalheLinha[] = [
        {
            linha: 1,
            intencao: 'p',
            temDivergencia: false,
            temDiscordancia: false,
            arquitetura: {
                plano: 'P',
                naoAvaliado: false,
                oraculo: { veredito: 'INVALID', origem: 'semantica' },
                julgamentoLLM: { status: 'VALID' },
                julgamentoAnterior: { ...FRONTEIRA, status: 'INVALID' }
            }
        }
    ];
    const c = compararJuizes(linhas, FRONTEIRA, 'med');
    assert.equal(c.distribuicoes.fronteira.porEstado.INVALID.n, 1);
    assert.equal(c.distribuicoes.local.porEstado.VALID.n, 1);
    assert.equal(c.contraOraculo.soFronteira, 1);
});

console.log(falhas === 0 ? '\nTodos os testes da comparacao dos juizes passaram.' : `\n${falhas} teste(s) falharam.`);
if (falhas > 0) process.exit(1);
