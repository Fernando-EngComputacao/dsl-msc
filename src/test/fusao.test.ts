/**
 * A fusao de cenario + resultado + avaliacao (src/inference/fusao-avaliacoes.ts).
 * Executar (da raiz): npm run test:fusao
 *
 * O foco e a JUNCAO e a COBERTURA, nao as contas (nao ha contas): o modulo so
 * casa registros e conta o que sobrou de fora. O que se cobra:
 *
 *   1. a juncao pelo SUJEITO sobrevive a avaliacao que renumerou as linhas —
 *      o caso real de `evalueted_cenarios-400-agro`, em que `linha` e o indice
 *      do lote e nao a linha do arquivo de cenarios;
 *   2. sem sujeito, cai no numero de linha, e o registro diz qual chave usou;
 *   3. cenario que nenhuma avaliacao alcancou vira LACUNA no resumo e, se
 *      pedido, linha com `avaliacao: null` — e assim que lote incompleto
 *      aparece em vez de desaparecer;
 *   4. avaliacao sem cenario localizado nao e descartada: entra com a intencao
 *      que ela mesma gravou e `juncao: 'nenhuma'`;
 *   5. varios dominios no mesmo arquivo, com a uniao de sensores por dominio;
 *   6. nada e inventado: campo que nenhuma fonte trouxe fica ausente;
 *   7. CSV: uniao das colunas de telemetria, vereditos achatados, plano fora;
 *   8. o nome do arquivo de avaliacao da o `<base>` do cenario de entrada;
 *   9. o MODO DE FUSAO (`partes`) decide quais blocos existem no registro e
 *      quais colunas existem no CSV — parte fora do modo nao vira campo vazio;
 *  10. fonte do tipo `cenario` entra inteira, sem depender de avaliacao nenhuma.
 */

import assert from 'node:assert/strict';

import type { RegistroAvaliacaoImportado } from '../inference/avaliacao-jsonl.js';
import {
    baseDoArquivoAvaliacao,
    ehParte,
    fundirAvaliacoes,
    fusaoParaCsv,
    fusaoParaJsonl,
    nomeArquivoFusao,
    sujeitoDoCenario,
    type FonteFusao
} from '../inference/fusao-avaliacoes.js';

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

/** Um registro de avaliacao como o `evalueted_*.jsonl` o grava. */
function avaliado(o: Partial<RegistroAvaliacaoImportado>): RegistroAvaliacaoImportado {
    return {
        dominio: 'agro',
        lado: 'arquitetura',
        plano: 'missao M para Soja { }',
        oraculo: { veredito: 'VALID', origem: 'semantica' },
        validacaoSintatica: { veredito: 'VALID' },
        validacaoSemantica: { veredito: 'VALID' },
        julgamentoLLM: { status: 'VALID' },
        concordancia: true,
        classificacao: 'VALIDO_PELO_ORACULO',
        tempos: { totalMs: 1000 },
        geracao: { tempoTotalMs: 9000, charsPlano: 900, charsPrompt: 3000 },
        ...o
    };
}

const cenarioAgro = (talhao: string, vento: number) => ({
    intencao: `pedido do ${talhao}`,
    talhao,
    telemetria: { vento, umidade: 70 },
    areas: ['Faixa_Manancial'],
    produtosEmUso: ['Glifosato']
});

const cenarioFut = (partida: string) => ({
    intencao: `pedido da ${partida}`,
    partida,
    telemetria: { minuto_partida: 41, distancia_bola: 3.2 },
    contextos: [],
    infracoesEmUso: []
});

console.log('\n[juncao]');

// O caso real: a avaliacao cobriu 3 dos 4 cenarios e renumerou `linha` 1..3.
// Casar por linha colocaria o cenario errado em cada registro; por sujeito, nao.
const FONTE_RENUMERADA: FonteFusao = {
    arquivo: 'evalueted_cenarios-4-agro_20261119-190227.jsonl',
    avaliacoes: [
        avaliado({ linha: 1, sujeito: 'TL-1' }),
        avaliado({ linha: 2, sujeito: 'TL-3' }),
        avaliado({ linha: 3, sujeito: 'TL-4' })
    ],
    cenarios: {
        arquivo: 'src/examples/agro/cenarios-4-agro.jsonl',
        registros: [cenarioAgro('TL-1', 5), cenarioAgro('TL-2', 8), cenarioAgro('TL-3', 12), cenarioAgro('TL-4', 20)]
    }
};

teste('casa pelo sujeito mesmo com a avaliacao renumerando as linhas', () => {
    const r = fundirAvaliacoes([FONTE_RENUMERADA]);
    assert.equal(r.registros.length, 3);
    assert.deepEqual(
        r.registros.map(x => [x.sujeito, x.cenario?.telemetria?.vento]),
        [
            ['TL-1', 5],
            ['TL-3', 12],
            ['TL-4', 20]
        ],
        'a linha 2 da avaliacao e o TL-3 (vento 12), nao o TL-2 (vento 8)'
    );
    assert.ok(r.registros.every(x => x.fusao.juncao === 'sujeito'));
    assert.equal(r.resumo.fontes[0].casadosPorSujeito, 3);
    assert.equal(r.resumo.fontes[0].casadosPorLinha, 0);
});

teste('sem sujeito na avaliacao, cai no numero de linha e declara a chave', () => {
    const r = fundirAvaliacoes([
        {
            arquivo: 'evalueted_x_20261119-190227.jsonl',
            avaliacoes: [avaliado({ linha: 2, sujeito: undefined })],
            cenarios: FONTE_RENUMERADA.cenarios
        }
    ]);
    assert.equal(r.registros[0].fusao.juncao, 'linha');
    assert.equal(r.registros[0].cenario?.telemetria?.vento, 8, 'linha 2 = TL-2');
    // Sem sujeito na avaliacao, o do cenario preenche o campo.
    assert.equal(r.registros[0].sujeito, 'TL-2');
    assert.equal(r.resumo.fontes[0].casadosPorLinha, 1);
});

console.log('\n[cobertura: o que ficou de fora]');

teste('cenario sem avaliacao vira lacuna no resumo', () => {
    const r = fundirAvaliacoes([FONTE_RENUMERADA]);
    const f = r.resumo.fontes[0];
    assert.equal(f.cenarios, 4);
    assert.equal(f.avaliacoes, 3);
    assert.equal(f.semAvaliacao, 1);
    assert.deepEqual(f.lacunas, [2], 'o TL-2 e a linha 2 do arquivo de cenarios');
    assert.equal(f.lacunasTruncadas, false);
    assert.equal(r.resumo.totalSemAvaliacao, 1);
});

teste('com incluirSemAvaliacao, a lacuna entra como linha de avaliacao nula', () => {
    const r = fundirAvaliacoes([FONTE_RENUMERADA], { incluirSemAvaliacao: true });
    assert.equal(r.registros.length, 4);
    const orfao = r.registros.find(x => x.sujeito === 'TL-2')!;
    assert.equal(orfao.avaliacao, null, 'avaliacao nula e o que marca a lacuna');
    assert.equal(orfao.resultado, null);
    assert.equal(orfao.cenario?.telemetria?.vento, 8, 'a entrada continua inteira');
    assert.equal(orfao.fusao.arquivoAvaliacao, null);
});

teste('avaliacao sem cenario localizado nao e descartada', () => {
    const r = fundirAvaliacoes([
        {
            arquivo: 'evalueted_sem-cenario_20261119-190227.jsonl',
            avaliacoes: [avaliado({ linha: 1, sujeito: 'TL-9', intencao: 'pedido do TL-9' })]
        }
    ]);
    assert.equal(r.registros.length, 1);
    const x = r.registros[0];
    assert.equal(x.fusao.juncao, 'nenhuma');
    assert.equal(x.fusao.arquivoCenario, null);
    assert.equal(x.cenario?.intencao, 'pedido do TL-9', 'a intencao gravada pela avaliacao ainda e entrada');
    assert.equal(x.cenario?.telemetria, null, 'sem cenario nao ha telemetria — e nada e estimado');
    assert.ok(x.avaliacao, 'a avaliacao continua inteira');
    // Sem arquivo de cenarios, `semCenario` nao acusa: nao havia o que casar.
    assert.equal(r.resumo.fontes[0].semCenario, 0);
    assert.equal(r.resumo.fontes[0].cenarios, null);
});

teste('avaliacao que nao acha o sujeito no cenario conta como semCenario', () => {
    const r = fundirAvaliacoes([
        {
            arquivo: 'evalueted_x_20261119-190227.jsonl',
            avaliacoes: [avaliado({ linha: 99, sujeito: 'TL-FORA' })],
            cenarios: FONTE_RENUMERADA.cenarios
        }
    ]);
    assert.equal(r.resumo.fontes[0].semCenario, 1);
    assert.equal(r.registros[0].fusao.juncao, 'nenhuma');
});

console.log('\n[varios dominios]');

const FONTE_FUT: FonteFusao = {
    arquivo: 'evalueted_cenarios-2-fut_20261118-153251.jsonl',
    avaliacoes: [
        avaliado({ dominio: 'fut', linha: 1, sujeito: 'PT-1', plano: 'arbitragem A para L { }' }),
        avaliado({ dominio: 'fut', linha: 2, sujeito: 'PT-2', lado: 'baseline' })
    ],
    cenarios: {
        arquivo: 'src/examples/fut/cenarios-2-fut.jsonl',
        registros: [cenarioFut('PT-1'), cenarioFut('PT-2')]
    }
};

teste('funde dominios diferentes num resultado so, com a uniao de sensores', () => {
    const r = fundirAvaliacoes([FONTE_RENUMERADA, FONTE_FUT]);
    assert.equal(r.registros.length, 5);
    assert.deepEqual(r.resumo.dominios, ['agro', 'fut']);
    assert.deepEqual(r.resumo.telemetriaPorDominio.agro, ['umidade', 'vento']);
    assert.deepEqual(r.resumo.telemetriaPorDominio.fut, ['distancia_bola', 'minuto_partida']);
    assert.equal(r.resumo.fontes.length, 2);
    // Os campos de contexto/em uso de cada dominio chegam nos nomes neutros.
    const agro = r.registros.find(x => x.dominio === 'agro')!;
    const fut = r.registros.find(x => x.dominio === 'fut')!;
    assert.deepEqual(agro.cenario?.contextos, ['Faixa_Manancial']);
    assert.deepEqual(agro.cenario?.emUso, ['Glifosato']);
    assert.deepEqual(fut.cenario?.contextos, []);
    assert.deepEqual(r.resumo.fontes[1].lados, ['arquitetura', 'baseline']);
});

console.log('\n[opcoes e desenho]');

teste('o desenho do lote casa pelo sujeito quando existe', () => {
    const r = fundirAvaliacoes([
        {
            ...FONTE_RENUMERADA,
            meta: {
                arquivo: 'src/examples/agro/cenarios-4-agro.meta.jsonl',
                registros: [{ linha: 3, talhao: 'TL-3', familia: 'FR-VENTO-GLIFO', esperado: { classe: 'APLICAVEL' } }]
            }
        }
    ]);
    const comDesenho = r.registros.filter(x => x.desenho);
    assert.equal(comDesenho.length, 1, 'so o TL-3 tem desenho — os outros ficam sem o campo');
    assert.equal(comDesenho[0].sujeito, 'TL-3');
    assert.equal(comDesenho[0].desenho!.familia, 'FR-VENTO-GLIFO');
});

teste('o desenho NAO cai na linha da avaliacao renumerada (regressao)', () => {
    // A avaliacao renumerou: seu `linha: 3` e o TL-4. O desenho declara `linha: 3`
    // para o TL-3. Cair na linha da avaliacao colaria o desenho do TL-3 no TL-4.
    const r = fundirAvaliacoes([
        {
            ...FONTE_RENUMERADA,
            meta: {
                arquivo: 'm.jsonl',
                registros: [{ linha: 3, talhao: 'TL-3', familia: 'FR-VENTO-GLIFO' }]
            }
        }
    ]);
    const tl4 = r.registros.find(x => x.sujeito === 'TL-4')!;
    assert.equal(tl4.desenho, undefined, 'o TL-4 nao tem desenho e nao pode herdar o do TL-3');
    assert.equal(r.registros.find(x => x.sujeito === 'TL-3')!.desenho!.familia, 'FR-VENTO-GLIFO');
});

teste('incluirPlano: false tira o texto do plano e mantem o resto', () => {
    const r = fundirAvaliacoes([FONTE_RENUMERADA], { incluirPlano: false });
    assert.ok(!('plano' in r.registros[0].resultado!), 'o plano sai do registro');
    assert.equal(r.registros[0].resultado!.geracao!.tempoTotalMs, 9000, 'o bloco geracao fica');
    const comPlano = fundirAvaliacoes([FONTE_RENUMERADA], { incluirPlano: true });
    assert.equal(comPlano.registros[0].resultado!.plano, 'missao M para Soja { }');
});

teste('incluirDesenho: false nao traz o desenho nem nas lacunas', () => {
    const fonte: FonteFusao = {
        ...FONTE_RENUMERADA,
        meta: {
            arquivo: 'm.jsonl',
            registros: [{ talhao: 'TL-2', familia: 'X' }, { talhao: 'TL-3', familia: 'Y' }]
        }
    };
    const r = fundirAvaliacoes([fonte], { incluirDesenho: false, incluirSemAvaliacao: true });
    assert.ok(r.registros.every(x => x.desenho === undefined));
});

teste('nada e inventado: registro pobre continua pobre', () => {
    const r = fundirAvaliacoes([
        {
            arquivo: 'evalueted_pobre_20261119-190227.jsonl',
            avaliacoes: [{ linha: 1, sujeito: 'TL-1' }]
        }
    ]);
    const x = r.registros[0];
    assert.equal(x.dominio, null);
    assert.equal(x.lado, null);
    assert.equal(x.resultado!.geracao, null);
    assert.equal(x.avaliacao!.oraculo, undefined);
    assert.equal(x.avaliacao!.naoAvaliado, false);
    assert.equal(x.cenario!.intencao, null);
});

console.log('\n[serializacao]');

teste('JSONL: uma linha por registro, relida sem perda', () => {
    const r = fundirAvaliacoes([FONTE_RENUMERADA, FONTE_FUT]);
    const texto = fusaoParaJsonl(r);
    const linhas = texto.split('\n').filter(l => l.length > 0);
    assert.equal(linhas.length, 5);
    assert.ok(texto.endsWith('\n'));
    // Compara contra o proprio registro passado por JSON: campo `undefined`
      // simplesmente nao existe no arquivo, e e isso que se quer.
    assert.deepEqual(JSON.parse(linhas[0]), JSON.parse(JSON.stringify(r.registros[0])));
    assert.equal(JSON.parse(linhas[0]).sujeito, 'TL-1');
    assert.ok(!linhas[0].includes('"violacao"'), 'campo ausente na fonte nao aparece no arquivo');
});

teste('CSV: uniao das colunas de telemetria, vereditos achatados e plano fora', () => {
    const r = fundirAvaliacoes([FONTE_RENUMERADA, FONTE_FUT]);
    const linhas = fusaoParaCsv(r).split('\n').filter(l => l.length > 0);
    const cabecalho = linhas[0].split(',');
    assert.equal(linhas.length, 6, 'cabecalho + 5 registros');
    for (const c of ['tel_vento', 'tel_umidade', 'tel_minuto_partida', 'tel_distancia_bola']) {
        assert.ok(cabecalho.includes(c), `faltou a coluna ${c}`);
    }
    assert.ok(!cabecalho.includes('plano'), 'o plano nao vai para o CSV');
    assert.ok(cabecalho.includes('oraculo') && cabecalho.includes('juiz'));
    // O registro de fut nao tem `vento`: a celula fica VAZIA, nao zero.
    const iVento = cabecalho.indexOf('tel_vento');
    const linhaFut = linhas.find(l => l.includes('PT-1'))!.split(',');
    assert.equal(linhaFut[iVento], '', 'sensor de outro dominio fica vazio, nunca 0');
    const iOraculo = cabecalho.indexOf('oraculo');
    assert.equal(linhas[1].split(',')[iOraculo], 'VALID');
});

teste('CSV: campo com virgula, aspas ou quebra de linha e escapado', () => {
    const r = fundirAvaliacoes([
        {
            arquivo: 'evalueted_esc_20261119-190227.jsonl',
            avaliacoes: [avaliado({ linha: 1, sujeito: 'TL-1', intencao: 'tem "aspas", virgula\ne quebra' })]
        }
    ]);
    const csv = fusaoParaCsv(r);
    assert.ok(csv.includes('"tem ""aspas"", virgula\ne quebra"'), `escape errado: ${csv}`);
    // O campo escapado nao parte a linha em duas no parser: as aspas o delimitam.
    // 6 aspas: 2 de delimitacao do campo + as 2 originais, cada uma dobrada.
    assert.equal(csv.split('"').length - 1, 6);
    // O campo escapado nao parte a linha: fora dele, o CSV tem cabecalho + 1 registro.
    assert.equal(csv.replace(/"[^"]*(?:""[^"]*)*"/g, 'X').split('\n').filter(l => l.length > 0).length, 2);
});

console.log('\n[nomes de arquivo]');

teste('o nome da avaliacao da a base do cenario de entrada', () => {
    assert.equal(baseDoArquivoAvaliacao('evalueted_cenarios-400-agro_20261119-190227.jsonl'), 'cenarios-400-agro');
    assert.equal(baseDoArquivoAvaliacao('evalueted_cenarios-400-fut_20261118-153251-2.jsonl'), 'cenarios-400-fut');
    // Nome antigo (`<carimbo>-<dominio>.jsonl`) nao guarda a entrada.
    assert.equal(baseDoArquivoAvaliacao('20261118-153251-agro.jsonl'), null);
});

teste('o sujeito sai do campo do dominio, e sem dominio tenta os tres', () => {
    assert.equal(sujeitoDoCenario({ talhao: 'TL-1' }, 'agro'), 'TL-1');
    assert.equal(sujeitoDoCenario({ partida: 'PT-1' }, 'fut'), 'PT-1');
    assert.equal(sujeitoDoCenario({ paciente: 'P-1' }, 'med'), 'P-1');
    assert.equal(sujeitoDoCenario({ partida: 'PT-1' }, null), 'PT-1', 'sem dominio, acha pelos tres campos');
    assert.equal(sujeitoDoCenario({ talhao: 'TL-1' }, 'fut'), null, 'o campo do dominio errado nao vale');
});

teste('o arquivo baixado carrega dominios, MODO e carimbo no nome', () => {
    const agora = new Date(2026, 10, 19, 19, 2, 27);
    assert.equal(nomeArquivoFusao(['agro', 'fut'], agora, 'jsonl'), 'fusao_agro-fut_completo_20261119-190227.jsonl');
    assert.equal(nomeArquivoFusao([], agora, 'csv'), 'fusao_vazio_completo_20261119-190227.csv');
    // Modo parcial entra no nome: dois downloads do mesmo lote com partes
    // diferentes sao arquivos diferentes.
    assert.equal(
        nomeArquivoFusao(['agro'], agora, 'csv', ['cenario']),
        'fusao_agro_cenario_20261119-190227.csv'
    );
    assert.equal(
        nomeArquivoFusao(['agro'], agora, 'jsonl', ['avaliacao', 'resultado']),
        'fusao_agro_resultado-avaliacao_20261119-190227.jsonl',
        'a ordem do nome e a canonica, nao a que o usuario clicou'
    );
});

console.log('\n[modo de fusao]');

teste('sem escolha, as tres partes; o resumo diz qual modo valeu', () => {
    const r = fundirAvaliacoes([FONTE_RENUMERADA]);
    assert.deepEqual(r.resumo.partes, ['cenario', 'resultado', 'avaliacao']);
    const x = r.registros[0];
    assert.ok(x.cenario && x.resultado && x.avaliacao);
    // Escolha vazia tambem vale as tres: identidade sozinha nao serve a ninguem.
    assert.deepEqual(fundirAvaliacoes([FONTE_RENUMERADA], { partes: [] }).resumo.partes, [
        'cenario',
        'resultado',
        'avaliacao'
    ]);
});

teste('parte fora do modo nao existe no registro — nem como nulo', () => {
    const r = fundirAvaliacoes([FONTE_RENUMERADA], { partes: ['cenario'] });
    const x = r.registros[0];
    assert.ok('cenario' in x, 'a parte pedida fica');
    assert.ok(!('resultado' in x), 'a parte fora do modo nao vira campo nulo');
    assert.ok(!('avaliacao' in x));
    // A identidade e a procedencia ficam SEMPRE: sem elas a linha nao se liga a nada.
    assert.equal(x.sujeito, 'TL-1');
    assert.equal(x.dominio, 'agro');
    assert.equal(x.fusao.juncao, 'sujeito');
    assert.ok(!JSON.stringify(x).includes('"avaliacao"'), 'nao aparece no arquivo gravado');
});

teste('modo sem cenario deixa a entrada fora e mantem veredito e tempos', () => {
    const r = fundirAvaliacoes([FONTE_RENUMERADA], { partes: ['resultado', 'avaliacao'] });
    const x = r.registros[0];
    assert.ok(!('cenario' in x));
    assert.equal(x.resultado!.geracao!.tempoTotalMs, 9000);
    assert.equal((x.avaliacao!.oraculo as { veredito: string }).veredito, 'VALID');
    assert.deepEqual(r.resumo.partes, ['resultado', 'avaliacao'], 'a ordem e a canonica');
});

teste('a ordem das partes e canonica, nao a da escolha', () => {
    const r = fundirAvaliacoes([FONTE_RENUMERADA], { partes: ['avaliacao', 'cenario'] });
    assert.deepEqual(r.resumo.partes, ['cenario', 'avaliacao']);
    assert.ok(ehParte('cenario') && ehParte('resultado') && ehParte('avaliacao'));
    assert.ok(!ehParte('desenho'));
});

teste('CSV: as colunas seguem o modo', () => {
    const soCenario = fusaoParaCsv(fundirAvaliacoes([FONTE_RENUMERADA], { partes: ['cenario'] }));
    const cab = soCenario.split('\n')[0].split(',');
    assert.ok(cab.includes('intencao') && cab.includes('tel_vento'));
    assert.ok(!cab.includes('oraculo'), 'sem a parte avaliacao, nao ha coluna de veredito');
    assert.ok(!cab.includes('chars_plano'), 'sem a parte resultado, nao ha coluna de tamanho');
    assert.ok(cab.includes('sujeito'), 'a identidade fica sempre');

    const semCenario = fusaoParaCsv(fundirAvaliacoes([FONTE_RENUMERADA], { partes: ['avaliacao'] }));
    const cab2 = semCenario.split('\n')[0].split(',');
    assert.ok(!cab2.some(c => c.startsWith('tel_')), 'sem a parte cenario, nenhuma coluna de sensor');
    assert.ok(cab2.includes('oraculo'));
});

console.log('\n[cenario como fonte propria]');

const FONTE_SO_CENARIO: FonteFusao = {
    arquivo: 'src/examples/agro/cenarios-4-agro.jsonl',
    tipo: 'cenario',
    // Numa fonte de cenario o dominio tem de vir declarado: nao ha registro de
    // avaliacao de onde tira-lo, e e ele que diz que o sujeito e `talhao`.
    dominio: 'agro',
    avaliacoes: [],
    cenarios: FONTE_RENUMERADA.cenarios
};

teste('fonte de cenario sem dominio declarado nao adivinha os campos do dominio', () => {
    const { dominio, ...semDominio } = FONTE_SO_CENARIO;
    void dominio;
    const r = fundirAvaliacoes([semDominio], { partes: ['cenario'] });
    assert.equal(r.registros.length, 4, 'as linhas entram de todo jeito');
    assert.equal(r.registros[0].dominio, null, 'o dominio fica nulo em vez de ser inventado');
    assert.equal(r.registros[0].sujeito, 'TL-1', 'o sujeito ainda sai tentando os tres campos');
    assert.deepEqual(r.resumo.dominios, [], 'e o resumo nao afirma dominio que ninguem declarou');
});

teste('fonte de cenario entra inteira, sem depender de incluirSemAvaliacao', () => {
    const r = fundirAvaliacoes([FONTE_SO_CENARIO], { partes: ['cenario'] });
    assert.equal(r.registros[0].dominio, 'agro', 'o dominio declarado chega ao registro');
    assert.equal(r.registros.length, 4, 'as quatro linhas do cenario, sem pedir semAvaliacao');
    assert.deepEqual(
        r.registros.map(x => x.sujeito),
        ['TL-1', 'TL-2', 'TL-3', 'TL-4']
    );
    const f = r.resumo.fontes[0];
    assert.equal(f.tipo, 'cenario');
    assert.equal(f.avaliacoes, 0);
    assert.equal(f.cenarios, 4);
    assert.equal(f.fundidos, 4);
    assert.equal(f.semAvaliacao, 4, 'todas as linhas sao "sem avaliacao" — e o que a fonte e');
});

teste('cenario avulso convive com avaliacao de outro dominio na mesma fusao', () => {
    const r = fundirAvaliacoes([FONTE_SO_CENARIO, FONTE_FUT], { partes: ['cenario'] });
    assert.equal(r.registros.length, 6, '4 linhas de cenario + 2 avaliacoes de fut');
    assert.deepEqual(r.resumo.dominios, ['agro', 'fut']);
    assert.deepEqual(r.resumo.fontes.map(f => f.tipo), ['cenario', 'avaliacao']);
    // O CSV cruza os sensores dos dois dominios numa tabela so.
    const cab = fusaoParaCsv(r).split('\n')[0];
    assert.ok(cab.includes('tel_vento') && cab.includes('tel_minuto_partida'));
});

console.log(falhas === 0 ? '\nTodos os testes da fusao passaram.' : `\n${falhas} teste(s) falharam.`);
if (falhas > 0) process.exit(1);
