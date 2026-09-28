/**
 * A extracao de `recuperarConhecimento` (src/inference/recuperacao-conhecimento.ts)
 * NAO muda o que o servidor produz.
 *
 * O bloco de recuperacao que `processarMed`, `processarAgro` e `processarFut`
 * repetiam em src/web/server.ts esta COPIADO LITERALMENTE abaixo (`antigo*`),
 * como estava no commit 085c1f0, antes da extracao. Cada cenario roda pelos
 * dois caminhos, com as mesmas entradas e os mesmos dubles, e a saida tem de
 * ser identica: restricoes depois do foco, foco, falha do foco, auditoria,
 * poda, politica efetiva, Prompt Semantico, a sequencia de estagios do SSE e a
 * abertura/fechamento da sessao. Por cima disso, a entrada da geracao
 * (`montarEntradaGeracao*`) montada a partir de cada saida tambem tem de ser
 * igual — e o que chega ao motor.
 *
 * Cinco configuracoes cobrem todos os ramos do bloco: deterministica com e sem
 * embedding, hibrida com o grafo fiel, hibrida com uma regra sintetica que
 * FORCA o refinamento a estreitar (sem ela, grafo e AST concordam e o ramo
 * `subgrafoRefinado` ficaria sem exercicio real), e hibrida degradada. No fim,
 * o teste exige que cada ramo tenha de fato sido percorrido — uma suite de
 * equivalencia que compara zero casos passaria calada.
 *
 * Roda OFFLINE. O embedding vem de um servidor HTTP local deste proprio teste
 * (o `SPC_CML_ENDPOINT` aponta para ele ANTES de qualquer modulo ler a
 * variavel — por isso os imports de valor sao dinamicos). O Neo4j e uma
 * `Session` dublada que responde as duas consultas do caminho: o indice
 * vetorial e `CYPHER_VALIDACAO`, esta a partir das regras com `parametro` lidas
 * da AST, como em `restricoes-hibridas.test.ts`.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

import type { Session } from 'neo4j-driver';

import type { AgroModel, FutModel, MedicalModel } from '../generated/ast.js';
import type { ClinicalContext } from '../knowledge/graphrag.js';
import type { AgroContext } from '../knowledge/graphrag-agro.js';
import type { FutContext } from '../knowledge/graphrag-fut.js';
import type { SinalVetorial } from '../knowledge/foco.js';
import type { SubgrafoPodado } from '../knowledge/politica.js';
import type { Dominio } from '../knowledge/recuperacao.js';
import type { AuditoriaRecuperacao } from '../knowledge/recuperacao-hibrida.js';
import type { LinhaRegra } from '../knowledge/recuperacao-cypher.js';

let falhas = 0;
function teste(nome: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok   ${nome}`))
        .catch((erro: Error) => {
            falhas++;
            console.log(`  FALHA ${nome}\n       ${erro.message.split('\n').slice(0, 12).join('\n       ')}`);
        });
}

// =============================================================================
// Embedding dublado: servidor HTTP local
// =============================================================================

/** FNV-1a: deterministico, sem dependencia, bom o bastante para espalhar escores. */
function hash(texto: string): number {
    let h = 2166136261;
    for (const ch of texto) {
        h ^= ch.codePointAt(0)!;
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

let embeddingNoAr = true;

const servidorEmbed = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', parte => (corpo += parte));
    req.on('end', () => {
        if (req.url !== '/embed' || !embeddingNoAr) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('embedding dublado fora do ar');
            return;
        }
        const { texto } = JSON.parse(corpo) as { texto: string };
        // O vetor so precisa ser deterministico e variar com o texto: e a
        // Session dublada que o transforma em escore.
        const vetor = [hash(texto), hash(`${texto}#1`), hash(`${texto}#2`)].map(h => (h % 1000) / 1000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ vetor, dimensoes: vetor.length }));
    });
});

// =============================================================================
// Neo4j dublado
// =============================================================================

type RegraDoGrafo = Omit<LinhaRegra, 'observado' | 'satisfeita'>;

function comparar(observado: number, operador: string, limite: number): boolean | null {
    switch (operador) {
        case '<': return observado < limite;
        case '>': return observado > limite;
        case '<=': return observado <= limite;
        case '>=': return observado >= limite;
        case '==': return observado === limite;
        case '!=': return observado !== limite;
        default: return null;
    }
}

function registro(obj: Record<string, unknown>): { get(chave: string): unknown } {
    return { get: chave => obj[chave] };
}

interface Placar {
    abertas: number;
    fechadas: number;
}

interface Grafo {
    dominio: Dominio;
    /** indice vetorial -> nomes dos nos indexados. */
    nomesPorIndice: Map<string, string[]>;
    /** `Rotulo:nome` -> regras com `parametro` penduradas no no. */
    regras: Map<string, RegraDoGrafo[]>;
    rotuloItem: string;
    relacaoBloqueio: string;
}

/**
 * A Session que o caminho recebe. Responde:
 *   - `db.index.vector.queryNodes`: todos os nos do indice, com escore
 *     deterministico em [0.6, 0.95] derivado do nome e do vetor;
 *   - `CYPHER_VALIDACAO`: as regras do no, avaliadas contra a telemetria, com a
 *     mesma comparacao e a mesma lacuna do `CASE` real.
 * Com `sintetica`, todo no de ITEM ganha uma RegraSeguranca sempre satisfeita:
 * e o que obriga `refinarPolitica` a estreitar de verdade.
 */
function sessaoDublada(grafo: Grafo, placar: Placar, sintetica: boolean): Session {
    placar.abertas++;
    const responder = (consulta: string, params: Record<string, unknown>): Record<string, unknown>[] => {
        if (consulta.includes('db.index.vector.queryNodes')) {
            const indice = params.indice as string;
            const vetor = params.vetor as number[];
            const topK = (params.topK as { toNumber(): number }).toNumber();
            const chaveVetor = hash(vetor.join(','));
            return (grafo.nomesPorIndice.get(indice) ?? [])
                .map(nome => ({
                    nome,
                    score: 0.6 + 0.35 * (((hash(nome) ^ chaveVetor) >>> 0) / 0xffffffff),
                    nodeId: `no:${nome}`
                }))
                .sort((a, b) => b.score - a.score)
                .slice(0, topK);
        }
        if (consulta.includes('MATCH (alvo:')) {
            const rotulo = /MATCH \(alvo:`([^`]+)`/.exec(consulta)?.[1];
            const nome = String(params.nome);
            const telemetria = params.telemetria as Record<string, number>;
            const regras = [...(grafo.regras.get(`${rotulo}:${nome}`) ?? [])];
            const parametro = Object.keys(telemetria)[0];
            if (sintetica && rotulo === grafo.rotuloItem && parametro !== undefined) {
                regras.push({
                    tipoRegra: 'RegraSeguranca', relacao: grafo.relacaoBloqueio, nodeId: `sintetica:${nome}`,
                    parametro, operador: '>=', esperado: -1e9, unidade: null,
                    razao: 'regra sintetica do teste', acao: null, detalhe: null
                });
            }
            return regras.map(r => {
                const observado = telemetria[r.parametro] ?? null;
                return {
                    ...r,
                    observado,
                    satisfeita: observado === null ? null : comparar(observado, r.operador, r.esperado)
                };
            });
        }
        throw new Error(`consulta inesperada na Session dublada: ${consulta.slice(0, 60)}`);
    };

    return {
        run: async (consulta: string, params: Record<string, unknown>) => ({
            records: responder(consulta, params).map(registro)
        }),
        close: async () => {
            placar.fechadas++;
        }
    } as unknown as Session;
}

// =============================================================================
// Cenarios
// =============================================================================

function linhasDe(arquivo: string, passo = 1): string[] {
    return fs
        .readFileSync(arquivo, 'utf-8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .filter((_, i) => i % passo === 0);
}

const EXEMPLOS = path.join('src', 'examples');
const CENARIOS: Record<Dominio, string[]> = {
    med: [
        ...linhasDe(path.join(EXEMPLOS, 'med', 'cenarios.jsonl')),
        ...linhasDe(path.join(EXEMPLOS, 'med', 'cenarios-200-med.jsonl'), 4)
    ],
    agro: [
        ...linhasDe(path.join(EXEMPLOS, 'agro', 'cenarios-agro.jsonl')),
        ...linhasDe(path.join(EXEMPLOS, 'agro', 'cenarios-200-agro.jsonl'), 4)
    ],
    fut: [
        ...linhasDe(path.join(EXEMPLOS, 'fut', 'cenarios-fut.jsonl')),
        ...linhasDe(path.join(EXEMPLOS, 'fut', 'cenarios-25-fut.jsonl')),
        ...linhasDe(path.join(EXEMPLOS, 'fut', 'cenarios-200-fut.jsonl'), 4)
    ]
};

interface Configuracao {
    nome: string;
    recuperacao?: string;
    embedding: boolean;
    sintetica: boolean;
}

const CONFIGURACOES: Configuracao[] = [
    { nome: 'deterministica, embedding no ar', embedding: true, sintetica: false },
    { nome: 'deterministica, embedding fora do ar', embedding: false, sintetica: false },
    { nome: 'hibrida, grafo fiel a AST', recuperacao: 'hibrida_rag_cypher', embedding: true, sintetica: false },
    { nome: 'hibrida, regra sintetica que estreita', recuperacao: 'hibrida_rag_cypher', embedding: true, sintetica: true },
    { nome: 'hibrida degradada (embedding fora)', recuperacao: 'hibrida_rag_cypher', embedding: false, sintetica: false }
];

type EmitirEstagio = (texto: string) => Promise<void>;

/** O que os dois caminhos devolvem, com os tipos apagados para comparacao. */
interface Saida {
    constraints: unknown;
    foco: unknown;
    focoIndisponivel?: string;
    auditoriaRecuperacao: AuditoriaRecuperacao;
    poda: SubgrafoPodado;
    politicaEfetiva: SubgrafoPodado;
    promptSemantico: string;
}

/** O id da auditoria sai de um relogio e de um contador: e o unico campo que difere por construcao. */
function semId(s: Saida): Saida {
    return { ...s, auditoriaRecuperacao: { ...s.auditoriaRecuperacao, id: '<id>' } };
}

interface Cobertura {
    execucoes: number;
    comFoco: number;
    focoIndisponivel: number;
    comValidacao: number;
    refinamentoEstreitou: number;
    degradou: number;
}

async function main(): Promise<void> {
    await new Promise<void>(resolve => servidorEmbed.listen(0, '127.0.0.1', resolve));
    const porta = (servidorEmbed.address() as AddressInfo).port;
    process.env.SPC_CML_ENDPOINT = `http://127.0.0.1:${porta}`;
    const recuperacaoOriginal = process.env.SPC_CML_RECUPERACAO;

    // Imports de valor DEPOIS de apontar o endpoint: `embeddings.ts` le a
    // variavel na carga do modulo.
    const { loadModel } = await import('../database/neo4j.js');
    const { loadAgroModel } = await import('../database/neo4j-agro.js');
    const { loadFutModel } = await import('../database/neo4j-fut.js');
    const { retrieveConstraints, pruningPayload, retrieverFoco, filtrarPorFoco } = await import('../knowledge/graphrag.js');
    const { retrieveAgroConstraints, agroPruningPayload, retrieverFocoAgro, filtrarPorFocoAgro } =
        await import('../knowledge/graphrag-agro.js');
    const { retrieveFutConstraints, futPruningPayload, retrieverFocoFut, filtrarPorFocoFut } =
        await import('../knowledge/graphrag-fut.js');
    const { montarPromptSemantico, montarEntradaGeracao } = await import('../inference/llm-client.js');
    const { montarPromptSemanticoAgro, montarEntradaGeracaoAgro } = await import('../inference/agro-client.js');
    const { montarPromptSemanticoFut, montarEntradaGeracaoFut } = await import('../inference/fut-client.js');
    const { modoRecuperacao, prepararHibridoTolerante, resumoAuditoria, auditoriaVazia } =
        await import('../knowledge/recuperacao-hibrida.js');
    const { refinarPolitica } = await import('../knowledge/recuperacao-politica.js');
    const { nomesMed, nomesAgro, nomesFut } = await import('../knowledge/documentos.js');
    const { INDICES_POR_DOMINIO } = await import('../knowledge/recuperacao-rag.js');
    const ast = await import('../generated/ast.js');
    const { recuperarConhecimento, ADAPTADOR_MED, ADAPTADOR_AGRO, ADAPTADOR_FUT } =
        await import('../inference/recuperacao-conhecimento.js');

    const modeloMed = await loadModel(path.join(EXEMPLOS, 'med', 'uti.dsl'));
    const modeloAgro = await loadAgroModel(path.join(EXEMPLOS, 'agro', 'lavoura.agro'));
    const modeloFut = await loadFutModel(path.join(EXEMPLOS, 'fut', 'futebol.fut'));

    // ------------------------------------------------------------ gemeo do grafo
    function regrasDoGrafo(dominio: Dominio, model: MedicalModel | AgroModel | FutModel): Map<string, RegraDoGrafo[]> {
        const { item, contexto } = INDICES_POR_DOMINIO[dominio];
        const mapa = new Map<string, RegraDoGrafo[]>();
        const vazio = { unidade: null, razao: null, acao: null, detalhe: null };
        const pendurar = (rotulo: string, dono: string, r: Omit<RegraDoGrafo, 'nodeId'>): void => {
            const nodeId = `${r.tipoRegra}:${dono}:${r.parametro}${r.operador}${r.esperado}`;
            mapa.set(`${rotulo}:${dono}`, [...(mapa.get(`${rotulo}:${dono}`) ?? []), { ...r, nodeId }]);
        };
        const seguranca = (
            relacao: string,
            r: { parameter: string; operator: string; threshold: { value: number; unit: string }; reason: string }
        ): Omit<RegraDoGrafo, 'nodeId'> => ({
            ...vazio, tipoRegra: 'RegraSeguranca', relacao, parametro: r.parameter, operador: r.operator,
            esperado: r.threshold.value, unidade: r.threshold.unit, razao: r.reason
        });

        for (const el of model.elements as unknown[]) {
            if (ast.isBlockRule(el)) pendurar(item.rotulo, el.drug.$refText, seguranca('BLOQUEIA_INCREMENTO', el));
            else if (ast.isAgroBlockRule(el)) pendurar(item.rotulo, el.product.$refText, seguranca('BLOQUEIA', el));
            else if (ast.isFutBlockRule(el)) pendurar(item.rotulo, el.infraction.$refText, seguranca('BLOQUEIA', el));
            else if (ast.isDrugDef(el)) {
                for (const a of el.attributes) {
                    if (!ast.isRenalAdjustAttr(a)) continue;
                    pendurar(item.rotulo, el.name, {
                        ...vazio, tipoRegra: 'AjusteRenal', relacao: 'EXIGE_AJUSTE', parametro: a.parameter,
                        operador: a.operator, esperado: a.threshold.value, unidade: a.threshold.unit,
                        acao: a.action, detalhe: a.detail
                    });
                }
            } else if (ast.isInfractionDef(el)) {
                for (const a of el.attributes) {
                    if (!ast.isLimiarAttr(a)) continue;
                    pendurar(item.rotulo, el.name, {
                        ...vazio, tipoRegra: 'Limiar', relacao: 'TEM_LIMIAR', parametro: a.parameter,
                        operador: a.operator, esperado: a.threshold.value, unidade: a.threshold.unit,
                        acao: a.action, detalhe: a.detail
                    });
                }
            } else if (ast.isProtocolDef(el) || ast.isCultureDef(el) || ast.isSituationDef(el)) {
                for (const a of el.attributes as unknown[]) {
                    if (ast.isTriggerAttr(a)) {
                        pendurar(contexto.rotulo, el.name, {
                            ...vazio, tipoRegra: 'Gatilho', relacao: 'DISPARA', parametro: a.parameter,
                            operador: a.operator, esperado: a.value.value, unidade: a.value.unit, acao: a.action
                        });
                    } else if (ast.isEscalationAttr(a)) {
                        pendurar(contexto.rotulo, el.name, {
                            ...vazio, tipoRegra: 'Escalonamento', relacao: 'ESCALONA', parametro: a.parameter,
                            operador: a.operator, esperado: a.value.value, detalhe: a.detail
                        });
                    }
                }
            }
        }
        return mapa;
    }

    function grafoDe(
        dominio: Dominio,
        model: MedicalModel | AgroModel | FutModel,
        nomes: { itens: string[]; contextos: string[] },
        relacaoBloqueio: string
    ): Grafo {
        const { item, contexto } = INDICES_POR_DOMINIO[dominio];
        return {
            dominio,
            nomesPorIndice: new Map([[item.indice, nomes.itens], [contexto.indice, nomes.contextos]]),
            regras: regrasDoGrafo(dominio, model),
            rotuloItem: item.rotulo,
            relacaoBloqueio
        };
    }

    const nMed = nomesMed(modeloMed);
    const nAgro = nomesAgro(modeloAgro);
    const nFut = nomesFut(modeloFut);
    const GRAFOS: Record<Dominio, Grafo> = {
        med: grafoDe('med', modeloMed, { itens: nMed.farmacos, contextos: nMed.protocolos }, 'BLOQUEIA_INCREMENTO'),
        agro: grafoDe('agro', modeloAgro, { itens: nAgro.produtos, contextos: nAgro.culturas }, 'BLOQUEIA'),
        fut: grafoDe('fut', modeloFut, { itens: nFut.infracoes, contextos: nFut.lances }, 'BLOQUEIA')
    };

    // A Session da vez: o bloco antigo chama `driver.session()`, literalmente.
    let sessaoDaVez: () => Session = () => {
        throw new Error('sessao nao configurada');
    };
    const driver = { session: (): Session => sessaoDaVez() };

    // =========================================================================
    // COPIA LITERAL do bloco de src/web/server.ts @ 085c1f0 (antes da extracao):
    // todo o codigo executavel e o de la, linha a linha; so alguns comentarios
    // foram encurtados. Nao editar: e a referencia contra a qual a funcao
    // extraida e comparada.
    // =========================================================================

    interface RespostaComando {
        foco?: {
            farmacos?: string[];
            protocolos?: string[];
            produtos?: string[];
            culturas?: string[];
            infracoes?: string[];
            lances?: string[];
        } | null;
    }

    function descreverFoco(nomes: Set<string>, origem: Map<string, string>): string {
        if (nomes.size === 0) return '—';
        return [...nomes].map(n => `${n} (${origem.get(n) ?? 'grafo'})`).join(', ');
    }

    async function antigoMed(texto: string, contexto: ClinicalContext, estagio: EmitirEstagio): Promise<Saida> {
        await estagio('Buscando regras no grafo de conhecimento…');
        let constraints = retrieveConstraints(modeloMed, contexto);
        await estagio(
            `Regras recuperadas: ${constraints.protocolosAtivos.length} protocolos ativos, ` +
                `${constraints.bloqueios.length} bloqueios, ${constraints.vetados.length} vetos`
        );

        let foco: RespostaComando['foco'] = null;
        let focoIndisponivel: string | undefined;

        // Modo de recuperacao: o padrao continua sendo o caminho deterministico.
        // No modo hibrido, o RAG embute a consulta semantica e consulta os dois
        // indices UMA vez; o foco reaproveita esse sinal em vez de buscar de novo.
        const modo = modoRecuperacao();
        let auditoriaRecuperacao: AuditoriaRecuperacao = auditoriaVazia(modo, 'med', texto);
        let sinal: SinalVetorial | undefined;

        await estagio('Calculando foco por embedding no subgrafo…');
        const session = driver.session();
        try {
            if (modo === 'hibrida_rag_cypher') {
                const hibrido = await prepararHibridoTolerante('med', contexto, session);
                auditoriaRecuperacao = hibrido.auditoria;
                sinal = hibrido.preparo?.sinal;
                await estagio(resumoAuditoria(auditoriaRecuperacao));
            }
            const f = await retrieverFoco(session, texto, modeloMed, sinal);
            constraints = filtrarPorFoco(constraints, f, modeloMed, contexto);
            auditoriaRecuperacao.foco = { itens: [...f.farmacos], contextos: [...f.protocolos] };
            foco = { farmacos: [...f.farmacos], protocolos: [...f.protocolos] };
            await estagio(
                `Foco recuperado: farmacos [${descreverFoco(f.farmacos, f.origem)}], ` +
                    `protocolos [${descreverFoco(f.protocolos, f.origem)}]`
            );
        } catch (error) {
            focoIndisponivel = (error as Error).message;
            await estagio('Foco por embedding indisponível — seguindo com o grafo completo');
        } finally {
            await session.close();
        }

        const poda = pruningPayload(constraints, contexto);
        let subgrafoRefinado: SubgrafoPodado | undefined;
        if (auditoriaRecuperacao.validacao.length > 0) {
            const rec = refinarPolitica(poda, auditoriaRecuperacao.validacao);
            auditoriaRecuperacao.reconciliacaoPolitica = {
                concordam: rec.concordam, ajustes: rec.ajustes, divergencias: rec.divergencias
            };
            subgrafoRefinado = rec.subgrafo;
        }
        const politicaEfetiva = subgrafoRefinado ?? poda;
        auditoriaRecuperacao.politicas = politicaEfetiva.politicas.map(pi => ({
            item: pi.item, decisoes: pi.decisoes, bloqueado: pi.bloqueado
        }));
        const promptSemantico = montarPromptSemantico(constraints, contexto, politicaEfetiva);
        return { constraints, foco, focoIndisponivel, auditoriaRecuperacao, poda, politicaEfetiva, promptSemantico };
    }

    async function antigoAgro(texto: string, contexto: AgroContext, estagio: EmitirEstagio): Promise<Saida> {
        await estagio('Buscando regras no grafo de conhecimento…');
        let constraints = retrieveAgroConstraints(modeloAgro, contexto);
        await estagio(
            `Regras recuperadas: ${constraints.culturasAtivas.length} culturas ativas, ` +
                `${constraints.bloqueios.length} bloqueios, ${constraints.vetados.length} vetos`
        );

        let foco: RespostaComando['foco'] = null;
        let focoIndisponivel: string | undefined;

        const modo = modoRecuperacao();
        let auditoriaRecuperacao: AuditoriaRecuperacao = auditoriaVazia(modo, 'agro', texto);
        let sinal: SinalVetorial | undefined;

        await estagio('Calculando foco por embedding no subgrafo…');
        const session = driver.session();
        try {
            if (modo === 'hibrida_rag_cypher') {
                const hibrido = await prepararHibridoTolerante('agro', contexto, session);
                auditoriaRecuperacao = hibrido.auditoria;
                sinal = hibrido.preparo?.sinal;
                await estagio(resumoAuditoria(auditoriaRecuperacao));
            }
            const f = await retrieverFocoAgro(session, texto, modeloAgro, sinal);
            constraints = filtrarPorFocoAgro(constraints, f, modeloAgro, contexto);
            auditoriaRecuperacao.foco = { itens: [...f.produtos], contextos: [...f.culturas] };
            foco = { produtos: [...f.produtos], culturas: [...f.culturas] };
            await estagio(
                `Foco recuperado: produtos [${descreverFoco(f.produtos, f.origem)}], ` +
                    `culturas [${descreverFoco(f.culturas, f.origem)}]`
            );
        } catch (error) {
            focoIndisponivel = (error as Error).message;
            await estagio('Foco por embedding indisponível — seguindo com o grafo completo');
        } finally {
            await session.close();
        }

        const poda = agroPruningPayload(constraints, contexto);
        let subgrafoRefinado: SubgrafoPodado | undefined;
        if (auditoriaRecuperacao.validacao.length > 0) {
            const rec = refinarPolitica(poda, auditoriaRecuperacao.validacao);
            auditoriaRecuperacao.reconciliacaoPolitica = {
                concordam: rec.concordam, ajustes: rec.ajustes, divergencias: rec.divergencias
            };
            subgrafoRefinado = rec.subgrafo;
        }
        const politicaEfetiva = subgrafoRefinado ?? poda;
        auditoriaRecuperacao.politicas = politicaEfetiva.politicas.map(pi => ({
            item: pi.item, decisoes: pi.decisoes, bloqueado: pi.bloqueado
        }));
        const promptSemantico = montarPromptSemanticoAgro(constraints, contexto, politicaEfetiva);
        return { constraints, foco, focoIndisponivel, auditoriaRecuperacao, poda, politicaEfetiva, promptSemantico };
    }

    async function antigoFut(texto: string, contexto: FutContext, estagio: EmitirEstagio): Promise<Saida> {
        await estagio('Buscando regras no grafo de conhecimento…');
        let constraints = retrieveFutConstraints(modeloFut, contexto);
        await estagio(
            `Regras recuperadas: ${constraints.lancesAtivos.length} lances ativos, ` +
                `${constraints.bloqueios.length} bloqueios, ${constraints.vetados.length} vetos`
        );

        let foco: RespostaComando['foco'] = null;
        let focoIndisponivel: string | undefined;

        const modo = modoRecuperacao();
        let auditoriaRecuperacao: AuditoriaRecuperacao = auditoriaVazia(modo, 'fut', texto);
        let sinal: SinalVetorial | undefined;

        await estagio('Calculando foco por embedding no subgrafo…');
        const session = driver.session();
        try {
            if (modo === 'hibrida_rag_cypher') {
                const hibrido = await prepararHibridoTolerante('fut', contexto, session);
                auditoriaRecuperacao = hibrido.auditoria;
                sinal = hibrido.preparo?.sinal;
                await estagio(resumoAuditoria(auditoriaRecuperacao));
            }
            const f = await retrieverFocoFut(session, texto, modeloFut, sinal);
            constraints = filtrarPorFocoFut(constraints, f, modeloFut, contexto);
            auditoriaRecuperacao.foco = { itens: [...f.infracoes], contextos: [...f.lances] };
            foco = { infracoes: [...f.infracoes], lances: [...f.lances] };
            await estagio(
                `Foco recuperado: infracoes [${descreverFoco(f.infracoes, f.origem)}], ` +
                    `lances [${descreverFoco(f.lances, f.origem)}]`
            );
        } catch (error) {
            focoIndisponivel = (error as Error).message;
            await estagio('Foco por embedding indisponível — seguindo com o grafo completo');
        } finally {
            await session.close();
        }

        const poda = futPruningPayload(constraints, contexto);
        let subgrafoRefinado: SubgrafoPodado | undefined;
        if (auditoriaRecuperacao.validacao.length > 0) {
            const rec = refinarPolitica(poda, auditoriaRecuperacao.validacao);
            auditoriaRecuperacao.reconciliacaoPolitica = {
                concordam: rec.concordam, ajustes: rec.ajustes, divergencias: rec.divergencias
            };
            subgrafoRefinado = rec.subgrafo;
        }
        const politicaEfetiva = subgrafoRefinado ?? poda;
        auditoriaRecuperacao.politicas = politicaEfetiva.politicas.map(pi => ({
            item: pi.item, decisoes: pi.decisoes, bloqueado: pi.bloqueado
        }));
        const promptSemantico = montarPromptSemanticoFut(constraints, contexto, politicaEfetiva);
        return { constraints, foco, focoIndisponivel, auditoriaRecuperacao, poda, politicaEfetiva, promptSemantico };
    }

    // =========================================================================
    // Os dois caminhos, lado a lado
    // =========================================================================

    /** Cenario do lote como `processar*` o monta a partir de `corpo.contexto`. */
    function cenarioDe(dominio: Dominio, linha: string): { texto: string; contexto: ClinicalContext | AgroContext | FutContext } {
        const b = JSON.parse(linha) as Record<string, unknown>;
        const texto = String(b.intencao ?? '').trim();
        const telemetria = (b.telemetria as Record<string, number>) ?? {};
        if (dominio === 'med') {
            return { texto, contexto: {
                paciente: b.paciente as string | undefined, populacoes: (b.populacoes as string[]) ?? [],
                farmacosEmUso: (b.farmacosEmUso as string[]) ?? [], telemetria, intencao: texto
            } };
        }
        if (dominio === 'agro') {
            return { texto, contexto: {
                talhao: b.talhao as string | undefined, areas: (b.areas as string[]) ?? [],
                produtosEmUso: (b.produtosEmUso as string[]) ?? [], telemetria, intencao: texto
            } };
        }
        return { texto, contexto: {
            partida: b.partida as string | undefined, contextos: (b.contextos as string[]) ?? [],
            infracoesEmUso: (b.infracoesEmUso as string[]) ?? [], telemetria, intencao: texto
        } };
    }

    type Caminho = (texto: string, contexto: never, estagio: EmitirEstagio, id?: string) => Promise<Saida>;

    const ANTIGO: Record<Dominio, Caminho> = {
        med: (t, c, e) => antigoMed(t, c, e),
        agro: (t, c, e) => antigoAgro(t, c, e),
        fut: (t, c, e) => antigoFut(t, c, e)
    };
    const NOVO: Record<Dominio, Caminho> = {
        med: (t, c, e, id) =>
            recuperarConhecimento(ADAPTADOR_MED, modeloMed, c, t, e, () => driver.session(), id ? { id } : undefined),
        agro: (t, c, e, id) =>
            recuperarConhecimento(ADAPTADOR_AGRO, modeloAgro, c, t, e, () => driver.session(), id ? { id } : undefined),
        fut: (t, c, e, id) =>
            recuperarConhecimento(ADAPTADOR_FUT, modeloFut, c, t, e, () => driver.session(), id ? { id } : undefined)
    };
    /** O que chega ao motor, montado a partir de cada saida. */
    const ENTRADA: Record<Dominio, (contexto: never, s: Saida) => unknown> = {
        med: (c, s) => montarEntradaGeracao(c, s.constraints as never, modeloMed, s.politicaEfetiva),
        agro: (c, s) => montarEntradaGeracaoAgro(c, s.constraints as never, modeloAgro, s.politicaEfetiva),
        fut: (c, s) => montarEntradaGeracaoFut(c, s.constraints as never, modeloFut, s.politicaEfetiva)
    };

    interface Execucao {
        saida: Saida;
        estagios: string[];
        placar: Placar;
        entrada: unknown;
    }

    async function executar(dominio: Dominio, caminho: Caminho, linha: string, cfg: Configuracao, id?: string): Promise<Execucao> {
        // Cenario parseado de novo a cada caminho: nenhum dos dois ve o que o
        // outro possa ter mutado.
        const { texto, contexto } = cenarioDe(dominio, linha);
        const placar: Placar = { abertas: 0, fechadas: 0 };
        sessaoDaVez = () => sessaoDublada(GRAFOS[dominio], placar, cfg.sintetica);
        const estagios: string[] = [];
        const saida = await caminho(texto, contexto as never, async t => { estagios.push(t); }, id);
        // O resumo do modo hibrido cita o id da auditoria; fora ele, o texto
        // do estagio tem de ser o mesmo.
        const idDaVez = saida.auditoriaRecuperacao.id;
        return {
            saida,
            estagios: estagios.map(e => e.split(idDaVez).join('<id>')),
            placar,
            entrada: ENTRADA[dominio](contexto as never, saida)
        };
    }

    function configurar(cfg: Configuracao): void {
        if (cfg.recuperacao === undefined) delete process.env.SPC_CML_RECUPERACAO;
        else process.env.SPC_CML_RECUPERACAO = cfg.recuperacao;
        embeddingNoAr = cfg.embedding;
    }

    const cobertura: Cobertura = {
        execucoes: 0, comFoco: 0, focoIndisponivel: 0, comValidacao: 0, refinamentoEstreitou: 0, degradou: 0
    };

    console.log('\nEquivalencia: bloco antigo de server.ts x recuperarConhecimento');
    for (const dominio of ['med', 'agro', 'fut'] as Dominio[]) {
        for (const cfg of CONFIGURACOES) {
            await teste(`${dominio}: ${cfg.nome} (${CENARIOS[dominio].length} cenarios)`, async () => {
                configurar(cfg);
                for (const [i, linha] of CENARIOS[dominio].entries()) {
                    const antigo = await executar(dominio, ANTIGO[dominio], linha, cfg);
                    const novo = await executar(dominio, NOVO[dominio], linha, cfg);
                    const onde = `cenario ${i}`;

                    assert.deepStrictEqual(novo.estagios, antigo.estagios, `${onde}: estagios do SSE`);
                    assert.deepStrictEqual(semId(novo.saida), semId(antigo.saida), `${onde}: saida da recuperacao`);
                    assert.deepStrictEqual(novo.entrada, antigo.entrada, `${onde}: entrada da geracao`);
                    assert.deepStrictEqual(novo.placar, { abertas: 1, fechadas: 1 }, `${onde}: sessao do caminho novo`);
                    assert.deepStrictEqual(antigo.placar, { abertas: 1, fechadas: 1 }, `${onde}: sessao do caminho antigo`);

                    const s = novo.saida;
                    cobertura.execucoes++;
                    if (s.foco !== null) cobertura.comFoco++;
                    if (s.focoIndisponivel !== undefined) cobertura.focoIndisponivel++;
                    if (s.auditoriaRecuperacao.validacao.length > 0) cobertura.comValidacao++;
                    if ((s.auditoriaRecuperacao.reconciliacaoPolitica?.ajustes.length ?? 0) > 0) {
                        cobertura.refinamentoEstreitou++;
                        assert.notEqual(s.politicaEfetiva, s.poda, `${onde}: estreitou, mas a politica efetiva e a poda`);
                    }
                    if (s.auditoriaRecuperacao.degradou !== undefined) cobertura.degradou++;
                }
            });
        }
    }

    console.log('\nO id opcional so muda o id');
    await teste('com `id`, a auditoria carrega esse id e o resto da saida nao muda', async () => {
        for (const dominio of ['med', 'agro', 'fut'] as Dominio[]) {
            for (const cfg of CONFIGURACOES) {
                configurar(cfg);
                const linha = CENARIOS[dominio][0];
                const semOpcao = await executar(dominio, NOVO[dominio], linha, cfg);
                const comId = await executar(dominio, NOVO[dominio], linha, cfg, 'req-fixo');
                assert.equal(comId.saida.auditoriaRecuperacao.id, 'req-fixo', `${dominio} / ${cfg.nome}`);
                assert.deepStrictEqual(semId(comId.saida), semId(semOpcao.saida), `${dominio} / ${cfg.nome}`);
                assert.deepStrictEqual(comId.estagios, semOpcao.estagios, `${dominio} / ${cfg.nome}`);
            }
        }
    });

    console.log('\nCobertura dos ramos');
    await teste('cada ramo do bloco foi exercitado pelo menos uma vez', () => {
        console.log(`       ${JSON.stringify(cobertura)}`);
        assert.ok(cobertura.execucoes >= 500, 'poucas comparacoes para sustentar a equivalencia');
        assert.ok(cobertura.comFoco > 0, 'nenhuma execucao com foco');
        assert.ok(cobertura.focoIndisponivel > 0, 'nenhuma execucao com foco indisponivel');
        assert.ok(cobertura.comValidacao > 0, 'nenhuma execucao com regras validadas');
        assert.ok(cobertura.refinamentoEstreitou > 0, 'o refinamento nunca estreitou a politica');
        assert.ok(cobertura.degradou > 0, 'o modo hibrido nunca degradou');
    });

    if (recuperacaoOriginal === undefined) delete process.env.SPC_CML_RECUPERACAO;
    else process.env.SPC_CML_RECUPERACAO = recuperacaoOriginal;
    servidorEmbed.closeAllConnections();
    servidorEmbed.close();

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
