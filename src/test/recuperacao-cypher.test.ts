/**
 * Verificacao da validacao deterministica por Cypher
 * (`knowledge/recuperacao-cypher.ts`).
 *
 * A propriedade que estes testes existem para proteger e uma so:
 *
 *     NENHUM ESCORE DE EMBEDDING SOBRESCREVE UMA CONDICAO NUMERICA.
 *
 * Por isso os casos aparecem em pares deliberadamente desconfortaveis: escore
 * 0.99 com condicao falsa tem de ser rejeitado, e escore 0.70 com condicao
 * verdadeira tem de poder passar. Se algum dia alguem introduzir um desempate
 * por relevancia, e aqui que quebra.
 *
 * O caso base e o R17 do enunciado, que existe de verdade no grafo deste
 * projeto: `Propofol`, `RegraSeguranca PAM < 60`. Os dubles abaixo reproduzem
 * as linhas que o Cypher devolve — conferidas contra o Neo4j real durante a
 * implementacao.
 *
 * Nada depende de Neo4j, do motor Python nem de GPU.
 */

import assert from 'node:assert/strict';

import { construirContextoRecuperacao } from '../knowledge/recuperacao.js';
import type { CandidatoRegra } from '../knowledge/recuperacao-rag.js';
import {
    validarCandidato,
    validarCandidatos,
    consultaPara,
    type ExecutorCypher,
    type LinhaRegra
} from '../knowledge/recuperacao-cypher.js';
import type { ClinicalContext } from '../knowledge/graphrag.js';

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

/** Contexto clinico com a telemetria que o teste quiser. */
function ctx(telemetria: Record<string, number>) {
    const med: ClinicalContext = {
        intencao: 'avaliar hipotensao persistente',
        paciente: 'PT-2026-0031',
        telemetria,
        populacoes: [],
        farmacosEmUso: ['Noradrenalina']
    };
    return construirContextoRecuperacao('med', med);
}

/** Candidato do RAG, com o escore que o teste quiser. */
function candidato(
    item: string,
    escore: number,
    over: Partial<CandidatoRegra> = {}
): CandidatoRegra {
    return {
        regraId: `Farmaco:${item}`,
        nodeId: '4:db:31',
        escore,
        cosseno: 2 * escore - 1,
        dominio: 'med',
        item,
        metadados: { rotulo: 'Farmaco', indice: 'farmaco_embedding', papel: 'item', posicao: 0 },
        ...over
    };
}

/** Linha crua como o Cypher a devolve. */
function linha(over: Partial<LinhaRegra> = {}): LinhaRegra {
    return {
        tipoRegra: 'RegraSeguranca',
        relacao: 'BLOQUEIA_INCREMENTO',
        nodeId: '4:db:900',
        parametro: 'PAM',
        operador: '<',
        esperado: 60,
        unidade: 'mmHg',
        razao: 'risco de hipotensao severa',
        acao: null,
        detalhe: null,
        observado: null,
        satisfeita: null,
        ...over
    };
}

/**
 * Executor duble que avalia as condicoes exatamente como o CASE do Cypher:
 * le o parametro do mapa `$telemetria` e compara. Assim os testes exercitam a
 * MESMA semantica, sem precisar do banco.
 */
function executorCom(regras: LinhaRegra[]): { executor: ExecutorCypher; chamadas: unknown[] } {
    const chamadas: unknown[] = [];
    const executor: ExecutorCypher = async (consulta, params) => {
        chamadas.push({ consulta, params });
        const telemetria = params.telemetria as Record<string, number>;
        return regras.map(r => {
            const observado = telemetria[r.parametro] ?? null;
            let satisfeita: boolean | null = null;
            if (observado !== null) {
                satisfeita =
                    r.operador === '<' ? observado < r.esperado
                    : r.operador === '>' ? observado > r.esperado
                    : r.operador === '<=' ? observado <= r.esperado
                    : r.operador === '>=' ? observado >= r.esperado
                    : r.operador === '==' ? observado === r.esperado
                    : r.operador === '!=' ? observado !== r.esperado
                    : null;
            }
            return { ...r, observado, satisfeita };
        });
    };
    return { executor, chamadas };
}

const R17 = linha();

async function main(): Promise<void> {
    console.log('\n[o par que define a arquitetura]');

    await teste('TESTE 1. RAG relevante + condicao satisfeita -> ACCEPT', async () => {
        const { executor } = executorCom([R17]);
        const [r] = await validarCandidato(ctx({ PAM: 52, FC: 128 }), candidato('Propofol', 0.88), executor);

        assert.equal(r.aplicavel, true);
        assert.equal(r.condicoesSatisfeitas.length, 1);
        assert.equal(r.condicoesFalhas.length, 0);
        assert.deepEqual(r.evidencia, { PAM: 52 });
        assert.match(r.validacaoCypher.motivo, /condicao satisfeita/);
    });

    await teste('TESTE 2. RAG relevante + condicao NAO satisfeita -> REJECT', async () => {
        const { executor } = executorCom([R17]);
        const [r] = await validarCandidato(ctx({ PAM: 82, FC: 128 }), candidato('Propofol', 0.88), executor);

        assert.equal(r.aplicavel, false);
        assert.equal(r.condicoesFalhas.length, 1);
        assert.deepEqual(r.condicoesFalhas[0], {
            campo: 'PAM', observado: 82, esperado: '< 60 mmHg',
            operador: '<', limite: 60, unidade: 'mmHg', satisfeita: false
        });
        assert.match(r.validacaoCypher.motivo, /PAM 82 nao satisfaz < 60/);
    });

    await teste('TESTE 3. escore 0.99 + condicao falsa -> REJECT', async () => {
        const { executor } = executorCom([R17]);
        const [r] = await validarCandidato(ctx({ PAM: 82 }), candidato('Propofol', 0.99), executor);

        assert.equal(r.rag.escore, 0.99, 'o escore e preservado para auditoria');
        assert.equal(r.aplicavel, false, 'escore altissimo nao pode salvar condicao falsa');
        assert.equal(r.validacaoCypher.valida, false);
    });

    await teste('TESTE 4. escore 0.70 + condicao verdadeira -> pode ACCEPT', async () => {
        const { executor } = executorCom([R17]);
        const [r] = await validarCandidato(ctx({ PAM: 52 }), candidato('Propofol', 0.7), executor);

        assert.equal(r.rag.escore, 0.7);
        assert.equal(r.aplicavel, true, 'escore baixo nao pode derrubar condicao verdadeira');
    });

    await teste('o veredito NAO muda quando so o escore muda', async () => {
        const { executor } = executorCom([R17]);
        const vereditos = [];
        for (const escore of [0.05, 0.5, 0.99]) {
            const [r] = await validarCandidato(ctx({ PAM: 82 }), candidato('Propofol', escore), executor);
            vereditos.push(r.aplicavel);
        }
        assert.deepEqual(vereditos, [false, false, false], 'o escore nao pode mover o veredito');
    });

    console.log('\n[conjuncao de condicoes]');

    await teste('TESTE 5. multiplas condicoes, todas satisfeitas -> ACCEPT', async () => {
        // Duas condicoes no MESMO no de regra (mesmo nodeId): o veredito e a
        // conjuncao delas.
        const { executor } = executorCom([
            linha({ nodeId: '4:db:901', parametro: 'PAM', operador: '<', esperado: 60 }),
            linha({ nodeId: '4:db:901', parametro: 'FC', operador: '>', esperado: 120, unidade: 'bpm' })
        ]);
        const [r] = await validarCandidato(ctx({ PAM: 52, FC: 128 }), candidato('Propofol', 0.8), executor);

        assert.equal(r.aplicavel, true);
        assert.equal(r.condicoesSatisfeitas.length, 2);
        assert.deepEqual(r.evidencia, { PAM: 52, FC: 128 });
    });

    await teste('TESTE 6. uma condicao falha -> REJECT, e o relatorio diz qual', async () => {
        const { executor } = executorCom([
            linha({ nodeId: '4:db:901', parametro: 'PAM', operador: '<', esperado: 60 }),
            linha({ nodeId: '4:db:901', parametro: 'FC', operador: '>', esperado: 120, unidade: 'bpm' })
        ]);
        const [r] = await validarCandidato(ctx({ PAM: 82, FC: 128 }), candidato('Propofol', 0.8), executor);

        assert.equal(r.aplicavel, false);
        assert.equal(r.condicoesSatisfeitas.length, 1, 'a condicao verdadeira continua registrada');
        assert.equal(r.condicoesSatisfeitas[0].campo, 'FC');
        assert.equal(r.condicoesFalhas.length, 1);
        assert.equal(r.condicoesFalhas[0].campo, 'PAM');
    });

    console.log('\n[varios candidatos, nenhum candidato]');

    await teste('TESTE 7. cada candidato e validado independentemente', async () => {
        const executor: ExecutorCypher = async (_c, params) => {
            const nome = params.nome as string;
            const telemetria = params.telemetria as Record<string, number>;
            const porItem: Record<string, LinhaRegra> = {
                Propofol: linha({ nodeId: 'n1', parametro: 'PAM', operador: '<', esperado: 60 }),
                Vancomicina: linha({
                    nodeId: 'n2', tipoRegra: 'AjusteRenal', relacao: 'EXIGE_AJUSTE',
                    parametro: 'TFG', operador: '<', esperado: 50, unidade: 'mL/min', acao: 'aumentar_intervalo'
                })
            };
            const r = porItem[nome];
            if (!r) return [];
            const observado = telemetria[r.parametro] ?? null;
            return [{ ...r, observado, satisfeita: observado === null ? null : observado < r.esperado }];
        };

        const validadas = await validarCandidatos(
            ctx({ PAM: 82, TFG: 28 }),
            [candidato('Propofol', 0.99), candidato('Vancomicina', 0.41), candidato('Adrenalina', 0.9)],
            executor
        );

        assert.equal(validadas.length, 2, 'Adrenalina nao tem regra condicional ligada');
        const propofol = validadas.find(r => r.item === 'Propofol')!;
        const vanco = validadas.find(r => r.item === 'Vancomicina')!;

        // O de MAIOR escore e rejeitado; o de MENOR escore e aceito.
        assert.equal(propofol.aplicavel, false);
        assert.equal(vanco.aplicavel, true);
        assert.ok(propofol.rag.escore > vanco.rag.escore);
        assert.equal(vanco.tipo, 'AjusteRenal');
        assert.equal(vanco.efeito.acao, 'aumentar_intervalo');
    });

    await teste('TESTE 8. nenhum candidato -> resultado vazio', async () => {
        const { executor, chamadas } = executorCom([R17]);
        const validadas = await validarCandidatos(ctx({ PAM: 52 }), [], executor);
        assert.deepEqual(validadas, []);
        assert.equal(chamadas.length, 0, 'sem candidato nao se consulta o grafo');
    });

    console.log('\n[incompatibilidade e lacuna]');

    await teste('TESTE 9. contexto incompativel: parametro ausente vira LACUNA, nao falso', async () => {
        const { executor } = executorCom([
            linha({ parametro: 'qSOFA', operador: '>=', esperado: 2, unidade: null })
        ]);
        // Cenario real do grafo: o protocolo pede qSOFA e a telemetria nao mede.
        const [r] = await validarCandidato(ctx({ PAM: 52, FC: 128 }), candidato('Propofol', 0.95), executor);

        assert.equal(r.aplicavel, false, 'sem evidencia nao se afirma a regra');
        assert.equal(r.condicoesFalhas.length, 0, 'ausencia de medida NAO e condicao falsa');
        assert.equal(r.lacunas.length, 1);
        assert.equal(r.lacunas[0].campo, 'qSOFA');
        assert.match(r.lacunas[0].motivo, /nao mediu 'qSOFA'/);
        assert.deepEqual(r.evidencia, {}, 'nada foi observado, nada vira evidencia');
    });

    await teste('TESTE 10. dominio incompativel -> REJECT sem consultar o grafo', async () => {
        const { executor, chamadas } = executorCom([R17]);
        const agroNoMed = candidato('Imidacloprido', 0.97, {
            dominio: 'agro',
            regraId: 'Produto:Imidacloprido',
            metadados: { rotulo: 'Produto', indice: 'produto_embedding', papel: 'item', posicao: 0 }
        });
        const [r] = await validarCandidato(ctx({ PAM: 52 }), agroNoMed, executor);

        assert.equal(r.aplicavel, false);
        assert.match(r.validacaoCypher.motivo, /dominio 'agro' num contexto 'med'/);
        assert.equal(chamadas.length, 0, 'candidato de outro dominio nao chega a consultar');
    });

    await teste('10b. label que o dominio nao indexa -> REJECT estrutural', async () => {
        const { executor, chamadas } = executorCom([R17]);
        const estranho = candidato('Cana_de_Acucar', 0.9, {
            regraId: 'Cultura:Cana_de_Acucar',
            metadados: { rotulo: 'Cultura', indice: 'cultura_embedding', papel: 'contexto', posicao: 0 }
        });
        const [r] = await validarCandidato(ctx({ PAM: 52 }), estranho, executor);

        assert.equal(r.aplicavel, false);
        assert.match(r.validacaoCypher.motivo, /nao indexa nos 'Cultura'/);
        assert.equal(chamadas.length, 0);
    });

    console.log('\n[a telemetria manda]');

    await teste('TESTE 11. telemetria alterada muda o veredito, de forma deterministica', async () => {
        const { executor } = executorCom([R17]);
        const c = candidato('Propofol', 0.88);

        const baixa = await validarCandidato(ctx({ PAM: 52 }), c, executor);
        const normal = await validarCandidato(ctx({ PAM: 82 }), c, executor);

        assert.equal(baixa[0].aplicavel, true);
        assert.equal(normal[0].aplicavel, false);
        assert.equal(baixa[0].evidencia.PAM, 52);
        assert.equal(normal[0].evidencia.PAM, 82);
    });

    await teste('11b. parametro que a regra nao usa nao muda nada', async () => {
        const { executor } = executorCom([R17]);
        const c = candidato('Propofol', 0.88);
        const a = await validarCandidato(ctx({ PAM: 52, FC: 100 }), c, executor);
        const b = await validarCandidato(ctx({ PAM: 52, FC: 180 }), c, executor);
        assert.equal(a[0].aplicavel, b[0].aplicavel);
        assert.deepEqual(a[0].evidencia, b[0].evidencia);
    });

    await teste('TESTE 12. mesma consulta semantica, telemetrias diferentes -> vereditos diferentes', async () => {
        const { executor } = executorCom([R17]);
        const c = candidato('Propofol', 0.88);

        const grave = ctx({ PAM: 52, FC: 128 });
        const estavel = ctx({ PAM: 82, FC: 128 });

        // O embedding veria o cenario de forma quase identica...
        assert.equal(grave.intencao, estavel.intencao);
        // ...mas o lado estruturado e diferente, e e ele que decide.
        assert.notDeepEqual(
            grave.contextoEstruturado.telemetria,
            estavel.contextoEstruturado.telemetria
        );

        const rg = await validarCandidato(grave, c, executor);
        const re = await validarCandidato(estavel, c, executor);
        assert.equal(rg[0].aplicavel, true);
        assert.equal(re[0].aplicavel, false);
    });

    console.log('\n[os tres dominios, com as diferencas reais do schema]');

    await teste('agro: RegraSeguranca/BLOQUEIA sobre Produto, valor em `limiar`', async () => {
        const agro = construirContextoRecuperacao('agro', {
            intencao: 'pulverizar a cana',
            talhao: 'T-04',
            telemetria: { temperatura_foliar: 41, vento: 12 },
            areas: [],
            produtosEmUso: []
        });
        const { executor } = executorCom([
            linha({
                tipoRegra: 'RegraSeguranca', relacao: 'BLOQUEIA', nodeId: 'a1',
                parametro: 'temperatura_foliar', operador: '>', esperado: 38, unidade: 'C',
                razao: 'estresse hidrico reduz absorcao'
            })
        ]);
        const cand: CandidatoRegra = {
            regraId: 'Produto:Imidacloprido', nodeId: '4:agro:1', escore: 0.62, cosseno: 0.24,
            dominio: 'agro', item: 'Imidacloprido',
            metadados: { rotulo: 'Produto', indice: 'produto_embedding', papel: 'item', posicao: 0 }
        };

        const [r] = await validarCandidato(agro, cand, executor);
        assert.equal(r.aplicavel, true, '41 > 38 incide');
        assert.equal(r.relacao, 'BLOQUEIA', 'agro usa BLOQUEIA, med usa BLOQUEIA_INCREMENTO');
        assert.equal(r.evidencia.temperatura_foliar, 41);
        assert.ok(r.validacaoCypher.consulta.includes('MATCH (alvo:`Produto`'));
    });

    await teste('fut: Limiar/TEM_LIMIAR sobre Infracao, valor em `valor`', async () => {
        const fut = construirContextoRecuperacao('fut', {
            intencao: 'entrada dura pelas costas',
            partida: 'PARTIDA-2026-07',
            telemetria: { minuto: 78, forca_impacto: 8 },
            contextos: [],
            infracoesEmUso: []
        });
        const { executor } = executorCom([
            linha({
                tipoRegra: 'Limiar', relacao: 'TEM_LIMIAR', nodeId: 'f1',
                parametro: 'forca_impacto', operador: '>=', esperado: 7, unidade: null,
                razao: null, acao: 'cartao_vermelho', detalhe: 'conduta violenta'
            })
        ]);
        const cand: CandidatoRegra = {
            regraId: 'Infracao:Falta_Tatica', nodeId: '4:fut:1', escore: 0.88, cosseno: 0.76,
            dominio: 'fut', item: 'Falta_Tatica',
            metadados: { rotulo: 'Infracao', indice: 'infracao_embedding', papel: 'item', posicao: 0 }
        };

        const [r] = await validarCandidato(fut, cand, executor);
        assert.equal(r.aplicavel, true, '8 >= 7 incide');
        assert.equal(r.tipo, 'Limiar');
        assert.equal(r.efeito.acao, 'cartao_vermelho');
        assert.equal(r.efeito.detalhe, 'conduta violenta');
        assert.ok(r.validacaoCypher.consulta.includes('MATCH (alvo:`Infracao`'));

        // E o mesmo candidato, com a leitura abaixo do limiar, deixa de incidir.
        const fraco = construirContextoRecuperacao('fut', {
            intencao: 'entrada dura pelas costas',
            partida: 'PARTIDA-2026-07',
            telemetria: { minuto: 78, forca_impacto: 3 },
            contextos: [], infracoesEmUso: []
        });
        const [r2] = await validarCandidato(fraco, cand, executor);
        assert.equal(r2.aplicavel, false);
        assert.equal(r2.condicoesFalhas[0].observado, 3);
    });

    console.log('\n[auditabilidade]');

    await teste('a decisao carrega condicao, observado, esperado, regra e no do grafo', async () => {
        const { executor } = executorCom([R17]);
        const [r] = await validarCandidato(ctx({ PAM: 82 }), candidato('Propofol', 0.88), executor);

        assert.equal(r.regraId, 'Farmaco:Propofol/RegraSeguranca/PAM<60');
        assert.equal(r.tipo, 'RegraSeguranca');
        assert.equal(r.relacao, 'BLOQUEIA_INCREMENTO');
        assert.equal(r.validacaoCypher.nodeId, '4:db:900', 'o no que fundamentou fica preservado');
        assert.equal(r.efeito.razao, 'risco de hipotensao severa');
        assert.ok(r.validacaoCypher.consulta.includes('MATCH (alvo:`Farmaco`'));
        assert.ok(r.validacaoCypher.consulta.includes('regra.parametro IS NOT NULL'));
    });

    await teste('a consulta e montada so a partir do mapa fechado de labels', () => {
        const q = consultaPara('Farmaco');
        assert.ok(q.includes('MATCH (alvo:`Farmaco` { nome: $nome })'));
        assert.ok(!q.includes('{{ROTULO}}'));
        // O nome do no e o valor da telemetria viajam como PARAMETRO, nunca
        // interpolados.
        assert.ok(q.includes('$nome') && q.includes('$telemetria'));
    });

    await teste('a saida nao e reordenada por escore', async () => {
        const executor: ExecutorCypher = async (_c, params) => {
            const nome = params.nome as string;
            return [{ ...R17, nodeId: `n-${nome}`, observado: 82, satisfeita: false }];
        };
        const validadas = await validarCandidatos(
            ctx({ PAM: 82 }),
            [candidato('Propofol', 0.2), candidato('Midazolam', 0.99)],
            executor
        );
        assert.deepEqual(validadas.map(r => r.item), ['Propofol', 'Midazolam'],
            'a ordem e a dos candidatos recebidos, nao a do escore');
    });

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
