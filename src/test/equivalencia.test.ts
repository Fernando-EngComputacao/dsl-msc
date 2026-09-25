/**
 * Equivalencia entre os DOIS avaliadores deterministicos.
 *
 * O projeto avalia as mesmas condicoes da DSL por dois caminhos:
 *
 *   `retrieve*Constraints`      sobre a AST do Langium
 *   `recuperacao-cypher.ts`     sobre os nos sincronizados no Neo4j
 *
 * A AST e a REFERENCIA SEMANTICA: a DSL define o significado, o grafo e uma
 * persistencia dele. Esta suite executa os mesmos cenarios pelos dois caminhos e
 * exige concordancia — exceto nas duas diferencas de ESCOPO ja identificadas e
 * documentadas, que sao verificadas nominalmente para nao poderem crescer em
 * silencio.
 *
 * Os cenarios sao GERADOS a partir dos limiares reais do grafo, com valores de
 * borda (igual ao limiar, +-1, +-0.01) — e nao escritos a mao, que foi como uma
 * primeira versao deste harness acabou medindo `fut` com parametros inexistentes
 * e reportando 0 comparacoes como se fosse sucesso.
 *
 * EXIGE NEO4J. Por isso NAO entra em `npm test`, que roda inteiramente offline.
 * Rode com `npm run test:equivalencia` (o script pula com aviso se o banco nao
 * estiver acessivel).
 */

import neo4j from 'neo4j-driver';
import assert from 'node:assert/strict';
import { loadModel } from '../database/neo4j.js';
import { loadAgroModel } from '../database/neo4j-agro.js';
import { loadFutModel } from '../database/neo4j-fut.js';
import { retrieveConstraints, type ClinicalContext } from '../knowledge/graphrag.js';
import { retrieveAgroConstraints, type AgroContext } from '../knowledge/graphrag-agro.js';
import { retrieveFutConstraints, type FutContext } from '../knowledge/graphrag-fut.js';
import { validarCandidato, executorPorSessao, type RegraValidada } from '../knowledge/recuperacao-cypher.js';
import { INDICES_POR_DOMINIO, type CandidatoRegra } from '../knowledge/recuperacao-rag.js';
import { construirContextoRecuperacao, type ContextoDominio, type Dominio } from '../knowledge/recuperacao.js';

/** Todos os nos indexados de um dominio, como candidatos sinteticos. */
async function todosOsNos(session: any, dominio: Dominio): Promise<CandidatoRegra[]> {
    const idx = INDICES_POR_DOMINIO[dominio];
    const out: CandidatoRegra[] = [];
    for (const papel of ['item', 'contexto'] as const) {
        const { rotulo, indice } = idx[papel];
        const r = await session.run(`MATCH (n:\`${rotulo}\`) RETURN n.nome AS nome`);
        for (const rec of r.records) {
            const nome = rec.get('nome') as string;
            out.push({
                regraId: `${rotulo}:${nome}`, nodeId: '', escore: 0, cosseno: 0,
                dominio, item: nome,
                metadados: { rotulo, indice, papel, posicao: 0 }
            });
        }
    }
    return out;
}

/** O veredito da AST para a regra que o Cypher descreve. */
function vereditoAst(dominio: Dominio, c: any, r: RegraValidada): boolean | 'nao-avalia' {
    const cond = r.condicoesSatisfeitas[0] ?? r.condicoesFalhas[0];
    if (!cond) return 'nao-avalia';
    const item = r.item;

    // A AST emite a regra como texto: "<parametro> <observado> <operador> <valor> <unidade>".
    // Casar so pelo parametro confunde duas regras do MESMO dono sobre o MESMO
    // parametro (Vancomicina tem TFG<50 e TFG<20). A identidade e a tripla.
    // A AST emite a regra como texto: "<parametro> <observado> <operador> <valor> <unidade>".
    // Casar so pelo parametro confunde duas regras do MESMO dono sobre o MESMO
    // parametro (Vancomicina tem TFG<50 e TFG<20). A identidade e a tripla.
    // Parsing por tokens, nao regex: em template literal do TS, \s e \b sao
    // escapes da STRING e nao chegam ao motor de regex.
    const casa = (txt: string): boolean => {
        const t = txt.split(/\s+/);
        for (let k = 0; k < t.length - 3; k++) {
            if (t[k] === cond.campo && t[k + 2] === cond.operador && Number(t[k + 3]) === cond.limite) {
                return true;
            }
        }
        return false;
    };

    switch (r.relacao) {
        case 'BLOQUEIA_INCREMENTO':
        case 'BLOQUEIA': {
            const chave = dominio === 'med' ? 'farmaco' : dominio === 'agro' ? 'produto' : 'infracao';
            return c.bloqueios.some((b: any) => b[chave] === item && casa(b.regra));
        }
        case 'EXIGE_AJUSTE': {
            const chave = dominio === 'med' ? 'farmaco' : 'produto';
            return c.ajustes.some((a: any) => a[chave] === item && casa(String(a.origem)));
        }
        case 'DISPARA': {
            const ativos = c.protocolosAtivos ?? c.culturasAtivas ?? c.lancesAtivos ?? [];
            const dono = ativos.find((x: any) => x.nome === item);
            return !!dono && dono.gatilhos.some((g: string) => casa(g));
        }
        case 'ESCALONA': {
            // A AST nao guarda o parametro do escalonamento, so destino/detalhe.
            // `detalhe` e o unico campo que os DOIS lados carregam.
            const chave = dominio === 'med' ? 'protocolo' : dominio === 'agro' ? 'cultura' : 'lance';
            return c.escalonamentos.some((e: any) =>
                e[chave] === item && e.detalhe === (r.efeito.detalhe ?? ''));
        }
        case 'TEM_LIMIAR':
            return 'nao-avalia';
        default:
            return 'nao-avalia';
    }
}

async function rodar(
    dominio: Dominio, model: any, contexto: ContextoDominio,
    retrieve: (m: any, c: any) => any, session: any
) {
    const c = retrieve(model, contexto);
    const rc = construirContextoRecuperacao(dominio, contexto);
    const executor = executorPorSessao(session);
    const candidatos = await todosOsNos(session, dominio);

    let total = 0, concorda = 0;
    const divergencias: string[] = [];
    const naoAvaliadas: string[] = [];

    for (const cand of candidatos) {
        const validadas = await validarCandidato(rc, cand, executor);
        for (const r of validadas) {
            if (r.lacunas.length > 0) continue;            // sem dado: nenhum lado afirma
            const ast = vereditoAst(dominio, c, r);
            if (ast === 'nao-avalia') { naoAvaliadas.push(`${r.tipo}/${r.relacao} ${r.regraId}`); continue; }
            total++;
            const cy = r.aplicavel;
            if (ast === cy) concorda++;
            else divergencias.push(`${r.regraId}  AST=${ast} CYPHER=${cy}  [${r.validacaoCypher.motivo}]`);
        }
    }
    return { total, concorda, divergencias, naoAvaliadas };
}

/** Todos os (parametro, limiar) que o grafo declara para um dominio. */
async function limiaresDoDominio(session: any, dominio: Dominio): Promise<Map<string, number[]>> {
    const idx = INDICES_POR_DOMINIO[dominio];
    const rotulos = [idx.item.rotulo, idx.contexto.rotulo];
    const r = await session.run(
        `MATCH (alvo)-[]-(regra) WHERE regra.parametro IS NOT NULL
           AND any(l IN labels(alvo) WHERE l IN $rotulos)
         RETURN DISTINCT regra.parametro AS p, coalesce(regra.limiar, regra.valor) AS v`,
        { rotulos });
    const m = new Map<string, number[]>();
    for (const rec of r.records) {
        const p = rec.get('p') as string;
        const v = Number(rec.get('v'));
        m.set(p, [...(m.get(p) ?? []), v]);
    }
    return m;
}

/**
 * Cenarios de BORDA gerados a partir dos limiares reais: cada parametro recebe
 * o seu k-esimo limiar deslocado por delta. Cobre igual-ao-limiar (o caso que
 * separa < de <=), acima, abaixo e casas decimais.
 */
function cenariosDeBorda(limiares: Map<string, number[]>): Record<string, number>[] {
    const deltas = [0, -1, 1, -0.01, 0.01];
    const maxK = Math.max(...[...limiares.values()].map(v => v.length));
    const out: Record<string, number>[] = [];
    for (let k = 0; k < maxK; k++) {
        for (const d of deltas) {
            const t: Record<string, number> = {};
            for (const [p, vs] of limiares) t[p] = Math.round((vs[k % vs.length] + d) * 100) / 100;
            out.push(t);
        }
    }
    out.push({});   // telemetria ausente: tudo vira lacuna
    return out;
}

/** As duas diferencas de escopo conhecidas, classificadas na auditoria. */
const DIFERENCAS_CONHECIDAS = {
    /** (E) A AST le so a UNIDADE de `limiar` em fut; nunca avalia a condicao. */
    TEM_LIMIAR: 'a AST nao avalia Limiar (graphrag-fut.ts le apenas a unidade)',
    /** (D) A AST so coleta escalonamento/gatilho de contexto ATIVO. */
    ESCALONA: 'a AST escopa por ativacao de contexto; o Cypher avalia por no'
};

async function main(): Promise<void> {
    const driver = neo4j.driver(
        process.env.NEO4J_URI ?? 'bolt://localhost:7687',
        neo4j.auth.basic(process.env.NEO4J_USER ?? 'neo4j', process.env.NEO4J_PASSWORD ?? '#UFG2026'));
    try {
        await driver.verifyConnectivity();
    } catch {
        console.log('  (pulado: Neo4j inacessivel — esta suite compara os dois avaliadores');
        console.log('   e precisa do grafo sincronizado. Suba com `docker compose up -d neo4j`');
        console.log('   e `npm run graph:sync` nos tres dominios.)');
        await driver.close();
        process.exit(0);
    }
    const session = driver.session();

    const med = await loadModel('src/examples/med/uti.dsl');
    const agro = await loadAgroModel('src/examples/agro/lavoura.agro');
    const fut = await loadFutModel('src/examples/fut/futebol.fut');
    const base: Record<Dominio, any> = {
        med: { paciente: 'P', populacoes: [], farmacosEmUso: [] },
        agro: { talhao: 'T', areas: [], produtosEmUso: [] },
        fut: { partida: 'M', contextos: [], infracoesEmUso: [] }
    };

    let T = 0, C = 0, NCEN = 0, falhas = 0;
    const inesperadas: string[] = [];
    const porEscopo = new Map<string, number>();

    for (const [dom, model, retrieve] of [
        ['med', med, retrieveConstraints],
        ['agro', agro, retrieveAgroConstraints],
        ['fut', fut, retrieveFutConstraints]
    ] as const) {
        const limiares = await limiaresDoDominio(session, dom as Dominio);
        const telemetrias = cenariosDeBorda(limiares);
        let t = 0, c = 0;
        for (const telemetria of telemetrias) {
            const cen = { ...base[dom as Dominio], intencao: 'x', telemetria };
            const r = await rodar(dom as Dominio, model, cen as any, retrieve as any, session);
            t += r.total; c += r.concorda;
            for (const d of r.divergencias) {
                // Divergencia legitima: escalonamento de contexto nao ativo.
                if (d.includes('/Escalonamento/')) {
                    porEscopo.set('ESCALONA', (porEscopo.get('ESCALONA') ?? 0) + 1);
                } else {
                    inesperadas.push(`[${dom}] ${d}`);
                }
            }
            for (const na of r.naoAvaliadas) {
                const tipo = na.includes('TEM_LIMIAR') ? 'TEM_LIMIAR' : na.split('/')[0];
                porEscopo.set(tipo, (porEscopo.get(tipo) ?? 0) + 1);
            }
        }
        console.log(`  ${dom}: ${c}/${t} concordam | ${telemetrias.length} cenarios | ${limiares.size} parametros`);
        T += t; C += c; NCEN += telemetrias.length;
    }

    console.log(`\n  TOTAL: ${NCEN} cenarios, ${T} comparacoes, ${C} concordancias`);
    console.log('\n  [diferencas de escopo conhecidas]');
    for (const [k, n] of porEscopo) {
        const nota = (DIFERENCAS_CONHECIDAS as any)[k];
        console.log(`    ${k}: ${n} ocorrencias — ${nota ?? 'NAO CLASSIFICADA'}`);
    }

    const teste = (nome: string, fn: () => void): void => {
        try { fn(); console.log(`  ok   ${nome}`); }
        catch (e) { falhas++; console.log(`  FALHA ${nome}\n       ${(e as Error).message}`); }
    };

    console.log('');
    teste('nenhuma divergencia fora das diferencas de escopo conhecidas', () => {
        assert.deepEqual(inesperadas, [],
            `os dois avaliadores discordaram onde deveriam concordar:\n${inesperadas.join('\n')}`);
    });
    teste('a comparacao cobriu os tres dominios com volume significativo', () => {
        assert.ok(T > 500, `so ${T} comparacoes: cobertura insuficiente para concluir`);
        assert.ok(NCEN > 30, `so ${NCEN} cenarios`);
    });
    teste('toda diferenca de escopo observada esta classificada', () => {
        for (const k of porEscopo.keys()) {
            assert.ok(k in DIFERENCAS_CONHECIDAS, `diferenca nao classificada: ${k}`);
        }
    });

    await session.close();
    await driver.close();
    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => { console.error('Falha:', err); process.exit(1); });
