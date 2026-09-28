/**
 * Validacao DETERMINISTICA do plano completo.
 *
 *     PlanoComposto (artefato + PIs + resultados) x conhecimento da requisicao
 *        -> ResultadoValidacao<PlanoComposto>: VALID | INVALID | UNRESOLVED
 *
 * Todo PI ja passou na validacao individual. Isso nao prova o plano: A e B
 * podem ser validos sozinhos e o par nao. Aqui se julga o que so existe no
 * conjunto. Nenhum LLM julga nada; a sintaxe (L(Ĝ)) e do motor (`/verify`),
 * conferida antes, pelo orquestrador.
 *
 * REUSADO, NAO REESCRITO:
 *
 *   clausulas e artefato    verificarContrato (contrato.ts) sobre a POLITICA
 *                           EFETIVA inteira — admissibilidade de cada clausula,
 *                           unicidade por item, sujeito, contexto em foco,
 *                           sequencia x clausulas, escalonamento obrigatorio,
 *                           artefato vazio. Codigos: os de `TipoViolacao`
 *   itens do pedido         itensCitados + condutasDoItem (validacao-sequencia.ts):
 *                           `cobertura_insuficiente`, `pedido_incompativel`
 *   decisao do pedido       decisoesCitadasNoPedido (validacao-pi.ts)
 *   medida afirmada         medidasDivergentes (validacao-pi.ts), agora contra a
 *                           telemetria INTEIRA do cenario
 *   medida que falta        classificar + `Lacuna` (como na sequencia e no PI)
 *
 * NOVO, so onde o conjunto decide algo que nenhuma parte decide:
 *
 *   incompatibilidade_global      dois PIs aumentam a exposicao a itens que uma
 *                                 regra relacional de RISCO e gravidade alta liga
 *                                 (`interacao` med, `incompativel` agro). Com
 *                                 gravidade menor: aviso `interacao_entre_pis`.
 *                                 `agravante` (fut) nao reprova: agrava a sancao,
 *                                 nao proibe a combinacao (`relacionalDeRisco`).
 *   telemetria_global_incompativel  uma clausula incrementa um item que um bloqueio
 *                                 com condicao medida tirou da politica.
 *   dependencia_global_invalida   `dependeDe` que o artefato composto nao respeita.
 *   pedido_global_incompativel    o pedido cita SO um item e nomeia uma decisao
 *                                 que a politica admite para ele, e o plano usou
 *                                 outra — erro de escolha de conduta, do Planner.
 *   pedido_global_indeterminado   (UNRESOLVED) o pedido nao cita item nenhum do
 *                                 conhecimento: nao ha como concluir que foi
 *                                 atendido, e nao se inventa a conclusao.
 *
 * FRONTEIRA: SO O ESTRUTURADO DECIDE.
 *
 *   executavel  campos com forma: o par da regra relacional (`entre`), a
 *               `gravidade`, a palavra-chave do dominio (`relacionalDeRisco`), a
 *               classe da decisao (`decisoesDeIncremento`), a politica, os fatos
 *               avaliados pela recuperacao, as condicoes do Cypher.
 *   textual     `mecanismo` e `conduta` das regras relacionais ("nao associar sem
 *               indicacao de choque refratario documentada") e as `regra_global`
 *               ("vasopressor em acesso periferico so por ate 6 h"). Vao como
 *               EVIDENCIA — ao feedback do Planner, ao historico —, e NUNCA como
 *               criterio: nenhum texto, sozinho, produz INVALID, e nenhum texto
 *               absolve o que o estruturado reprova. Sem NLP, sem LLM.
 *
 * As `regra_global` textuais do cenario aparecem num aviso
 * (`regras_globais_textuais`), para o historico dizer o que NAO foi conferido.
 */

import {
    condutasDoItem,
    verificarContrato,
    type TipoViolacao
} from './contrato.js';
import type { PlanoComposto } from './composicao.js';
import { relacionalDeRisco, vistaDoCenario, type ConhecimentoDaDecomposicao } from './decompositor.js';
import { itensDaRelacao, type RegraRelacional } from './item-geracao.js';
import { explicarRegra } from './recuperacao-hibrida.js';
import { classificar } from './recuperacao-politica.js';
import { contemPalavra, normalizar, tokensDoNome } from './foco.js';
import { alvoDoPedido, type CodigoSequencia } from './validacao-sequencia.js';
import { decisoesCitadasNoPedido, medidasDivergentes, type CodigoPI } from './validacao-pi.js';
import {
    invalido,
    naoResolvido,
    valido,
    type ProblemaValidacao,
    type ResultadoValidacao
} from './validacao.js';

// =============================================================================
// Codigos
// =============================================================================

export type CodigoGlobal =
    | 'incompatibilidade_global'
    | 'telemetria_global_incompativel'
    | 'dependencia_global_invalida'
    | 'pedido_global_incompativel'
    /** UNRESOLVED: o pedido nao cita item do conhecimento. */
    | 'pedido_global_indeterminado'
    /** Aviso: regra relacional entre itens do plano que nao chega a reprovar. */
    | 'interacao_entre_pis'
    /** Aviso: o pedido nomeia uma decisao que a politica nao admite para o item — o plano nao podia atende-la. */
    | 'pedido_nao_atendivel'
    /** Aviso: as `regra_global` do cenario sao so texto e nao foram conferidas. */
    | 'regras_globais_textuais';

export type CodigoValidacaoGlobal =
    | CodigoGlobal
    | TipoViolacao
    | Extract<CodigoSequencia, 'cobertura_insuficiente' | 'pedido_incompativel' | 'telemetria_insuficiente'>
    | Extract<CodigoPI, 'justificativa_telemetria_divergente' | 'pedido_indeterminado'>;

type Problema = ProblemaValidacao<CodigoValidacaoGlobal>;

/** O conhecimento contra o qual o plano e julgado: o MESMO que decompos a sequencia. */
export type ConhecimentoGlobal = ConhecimentoDaDecomposicao;

// =============================================================================
// Validacao
// =============================================================================

/**
 * Julga o plano composto. Todos os erros vao juntos, cada um com os PIs
 * envolvidos (`pis`), a regra, a evidencia e o reparo possivel (`alternativas`)
 * — e o material do feedback ao Planner. Nada e corrigido: quando VALID, o
 * valor e o proprio plano.
 */
export function validarPlanoGlobal(
    plano: PlanoComposto,
    k: ConhecimentoGlobal
): ResultadoValidacao<PlanoComposto, CodigoValidacaoGlobal> {
    const erros: Problema[] = [];
    const avisos: Problema[] = [];
    const faltas: string[] = [];
    const incrementos = new Set(k.contrato.papeis.decisoesDeIncremento);
    const vista = vistaDoCenario(k.dominio, k.restricoes);
    const politicaDe = (item: string) => k.politica.politicas.find(p => p.item === item);
    const clausulas = plano.resultados.map((r, i) => ({ r, pi: plano.pis[i] }));
    const rotulo = (x: { r: { ordem: number; item: string; conduta: string } }): string =>
        `PI ${x.r.ordem} (${x.r.item} -> ${x.r.conduta})`;

    // ------------------------------------------------------------ 1. telemetria do conjunto
    // Uma clausula que incrementa um item cuja politica o bloqueio medido tirou.
    const telemetria = new Set<number>();
    for (const x of clausulas) {
        const D = x.r.acao.decisao;
        if (!incrementos.has(D) || politicaDe(x.r.item)?.decisoes.includes(D)) continue;
        const fatos = (vista.fatosPorItem[x.r.item] ?? []).filter(f => f.tipo === 'bloqueio' && f.condicoes.length > 0);
        const regras = k.regras.filter(r => r.item === x.r.item && classificar(r) === 'bloqueio_condicional');
        if (fatos.length === 0 && regras.length === 0) continue;
        const condicoes = [...fatos.flatMap(f => f.condicoes), ...regras.map(explicarRegra)];
        const texto = normalizar(condicoes.join(' '));
        const medidas = Object.entries(k.telemetria)
            .filter(([p]) => contemPalavra(texto, tokensDoNome(p).join(' ')))
            .map(([p, v]) => `${p} = ${v}`);
        telemetria.add(x.r.ordem);
        erros.push({
            codigo: 'telemetria_global_incompativel', pi: x.r.ordem, pis: [x.r.ordem], item: x.r.item, conduta: x.r.conduta,
            reparo: { item: x.r.item, decisao: D },
            regra: [...fatos.map(f => f.descricao), ...regras.map(r => r.regraId)].join('; '),
            mensagem: `${rotulo(x)} decide ${D}, que aumenta a exposicao, e a telemetria observada bloqueia o incremento de ${x.r.item}`,
            evidencias: [...condicoes, ...medidas],
            alternativas: [`escolher para ${x.r.item} uma conduta que a politica admite: ${condutasDoItem(k.contrato, x.r.item).join(', ') || 'nenhuma'}`]
        });
    }

    // ------------------------------------------------------------ 2. contrato do artefato
    for (const v of verificarContrato(k.contrato, plano.texto).violacoes) {
        const x = v.clausula === null ? undefined : clausulas[v.clausula];
        if (x && v.tipo === 'decisao_inadmissivel' && telemetria.has(x.r.ordem)) continue; // ja explicado acima
        erros.push({
            codigo: v.tipo, mensagem: v.mensagem, reparo: v.reparo,
            ...(x ? { pi: x.r.ordem, pis: [x.r.ordem], item: x.r.item, conduta: x.r.conduta } : { pis: plano.pis.map(p => p.ordem) })
        });
    }

    // ------------------------------------------------------------ 3. dependencias
    const posicao = new Map(plano.resultados.map((r, i) => [r.ordem, i]));
    for (const [i, pi] of plano.pis.entries()) {
        for (const d of pi.dependeDe) {
            const j = posicao.get(d);
            if (j === undefined || j >= i) {
                erros.push({
                    codigo: 'dependencia_global_invalida', pi: pi.ordem, pis: [pi.ordem, d], item: pi.item, conduta: pi.conduta,
                    mensagem: `o PI ${pi.ordem} depende do PI ${d}, que ${j === undefined ? 'nao esta no artefato' : 'vem depois dele no artefato'}`,
                    alternativas: ['reordenar a sequencia para que cada PI venha depois dos PIs de que depende']
                });
            }
        }
    }

    // ------------------------------------------------------------ 4. combinacoes entre PIs
    // So o ESTRUTURADO da regra decide (par, gravidade, tipo da relacao) junto da
    // classe das duas decisoes; o texto (mecanismo, conduta) so vira evidencia.
    if (relacionalDeRisco(k.dominio)) {
        for (let a = 0; a < clausulas.length; a++) {
            for (let b = a + 1; b < clausulas.length; b++) {
                const [x, y] = [clausulas[a], clausulas[b]];
                for (const regra of vista.relacionais) {
                    const { estruturado, texto } = partesDaRelacao(regra);
                    if (!(estruturado.itens.includes(x.r.item) && estruturado.itens.includes(y.r.item)) || x.r.item === y.r.item) continue;
                    const ambos = incrementos.has(x.r.acao.decisao) && incrementos.has(y.r.acao.decisao);
                    if (!ambos) continue;
                    const base = {
                        pi: x.r.ordem, pis: [x.r.ordem, y.r.ordem], item: x.r.item,
                        regra: `${regra.entre} [${estruturado.gravidade}]: ${texto.mecanismo}`,
                        evidencias: [
                            `${rotulo(x)}: ${x.r.acao.decisao}`,
                            `${rotulo(y)}: ${y.r.acao.decisao}`,
                            ...(texto.conduta ? [`o conhecimento orienta (texto, nao avaliado): ${texto.conduta}`] : [])
                        ]
                    };
                    if (estruturado.gravidade === 'alta') {
                        erros.push({
                            ...base, codigo: 'incompatibilidade_global',
                            mensagem: `${rotulo(x)} e ${rotulo(y)} aumentam juntos a exposicao a ${regra.entre}, uma combinacao de gravidade alta`,
                            alternativas: [
                                `nao incrementar os dois: escolher para ${x.r.item} ou para ${y.r.item} uma conduta sem incremento`,
                                `condutas de ${x.r.item}: ${condutasDoItem(k.contrato, x.r.item).join(', ')}`,
                                `condutas de ${y.r.item}: ${condutasDoItem(k.contrato, y.r.item).join(', ')}`
                            ]
                        });
                    } else {
                        avisos.push({ ...base, codigo: 'interacao_entre_pis', mensagem: `${rotulo(x)} e ${rotulo(y)} combinam ${regra.entre} (gravidade ${regra.gravidade})` });
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------ 5. pedido
    // O mesmo criterio que o orquestrador aplica ANTES do Planner (`alvoDoPedido`):
    // no fluxo, um pedido sem alvo ja terminou la; aqui fica como defesa.
    const ks = { contrato: k.contrato, politica: k.politica, regras: k.regras, pedido: k.pedido };
    const alvo = alvoDoPedido(ks);
    const citados = alvo.valor ?? [];
    const tratados = new Set(plano.resultados.map(r => r.item));
    if (citados.length === 0) {
        faltas.push('item do pedido identificavel no conhecimento');
        avisos.push({
            codigo: 'pedido_global_indeterminado', pis: plano.pis.map(p => p.ordem),
            mensagem: 'o pedido nao cita pelo nome nenhum item do conhecimento: nao ha como concluir deterministicamente que o plano o atende',
            evidencias: [`pedido: ${k.pedido}`, `itens do plano: ${[...tratados].join(', ')}`]
        });
    } else {
        const exigidos = citados.filter(i => condutasDoItem(k.contrato, i).length > 0);
        const faltando = exigidos.filter(i => !tratados.has(i));
        if (exigidos.length > 0 && faltando.length === exigidos.length) {
            erros.push({
                codigo: 'pedido_incompativel', pis: plano.pis.map(p => p.ordem),
                mensagem: `o pedido cita ${exigidos.join(', ')}, e o plano composto nao trata nenhum deles (itens do plano: ${[...tratados].join(', ')})`,
                alternativas: exigidos.map(i => `incluir ${i}: ${condutasDoItem(k.contrato, i).join(', ')}`)
            });
        } else {
            for (const item of faltando) {
                erros.push({
                    codigo: 'cobertura_insuficiente', item, pis: plano.pis.map(p => p.ordem),
                    mensagem: `o pedido cita ${item}, e nenhuma clausula do plano o trata`,
                    alternativas: [`incluir ${item}: ${condutasDoItem(k.contrato, item).join(', ')}`]
                });
            }
        }
        const pedidoDaDecisao = conferirDecisaoDoPedido(k, citados, clausulas);
        if (pedidoDaDecisao.erro) erros.push(pedidoDaDecisao.erro);
        if (pedidoDaDecisao.aviso) avisos.push(pedidoDaDecisao.aviso);
    }

    // ------------------------------------------------------------ 6. o que as justificativas afirmam, contra o cenario inteiro
    for (const x of clausulas) {
        for (const d of medidasDivergentes(x.r.justificativa, k.telemetria)) {
            erros.push({
                codigo: 'justificativa_telemetria_divergente', pi: x.r.ordem, pis: [x.r.ordem], item: x.r.item, conduta: x.r.conduta,
                mensagem: `a justificativa de ${rotulo(x)} da ${d.parametro} ${d.citados.join(', ')}, e o cenario observou ${d.observado}`,
                evidencias: [`${d.parametro} = ${d.observado}`]
            });
        }
    }

    // ------------------------------------------------------------ 7. medida que falta
    for (const x of clausulas) {
        if (!incrementos.has(x.r.acao.decisao)) continue;
        const semMedida = k.regras.filter(
            r => r.item === x.r.item && r.lacunas.length > 0 && classificar({ ...r, lacunas: [], aplicavel: true }) === 'bloqueio_condicional'
        );
        for (const r of semMedida) {
            faltas.push(...r.lacunas.map(l => `telemetria.${l.campo}`));
            avisos.push({
                codigo: 'telemetria_insuficiente', pi: x.r.ordem, pis: [x.r.ordem], item: x.r.item, regra: r.regraId, evidencias: [explicarRegra(r)],
                mensagem: `${rotulo(x)} incrementa ${x.r.item}, e a regra ${r.regraId} nao pode ser avaliada sem ${r.lacunas.map(l => l.campo).join(', ')}`
            });
        }
    }

    // ------------------------------------------------------------ 8. regra_global: texto, nao criterio
    if (vista.regrasGlobais.length > 0) {
        avisos.push({
            codigo: 'regras_globais_textuais',
            mensagem: `${vista.regrasGlobais.length} regra(s) global(is) do cenario sao so texto: contexto e evidencia, nao conferidas deterministicamente`,
            evidencias: vista.regrasGlobais.map(r => `[${r.severidade}] ${r.descricao}`)
        });
    }

    // ------------------------------------------------------------ veredito
    if (erros.length > 0) return invalido(erros, { avisos, promptRecomendado: relatorioGlobal(erros) });
    if (faltas.length > 0) {
        return naoResolvido([...new Set(faltas)], { avisos, promptRecomendado: relatorioGlobal(avisos.filter(a => a.codigo === 'pedido_global_indeterminado' || a.codigo === 'telemetria_insuficiente')) });
    }
    return valido(plano, avisos);
}

/**
 * As duas partes de uma regra relacional: o que tem FORMA (os itens do par e a
 * gravidade) e o que e TEXTO (mecanismo e conduta). So a primeira decide; a
 * segunda e evidencia. Separadas aqui para a fronteira ser visivel no codigo.
 */
export function partesDaRelacao(regra: RegraRelacional): {
    estruturado: { itens: string[]; gravidade: string };
    texto: { mecanismo: string; conduta: string };
} {
    return {
        estruturado: { itens: itensDaRelacao(regra), gravidade: regra.gravidade },
        texto: { mecanismo: regra.mecanismo, conduta: regra.conduta }
    };
}

/**
 * Pedido x decisao no plano inteiro. So se conclui quando o pedido cita UM item
 * e nomeia decisao (`decisoesCitadasNoPedido`): se alguma das nomeadas e
 * admissivel para o item na politica e a clausula dele usa outra, o Planner
 * escolheu a conduta errada.
 */
function conferirDecisaoDoPedido(
    k: ConhecimentoGlobal,
    citados: string[],
    clausulas: { r: { ordem: number; item: string; conduta: string; acao: { decisao: string } } }[]
): { erro?: Problema; aviso?: Problema } {
    if (citados.length !== 1) {
        return { aviso: { codigo: 'pedido_indeterminado', mensagem: `o pedido cita ${citados.join(', ')}: nao se conclui qual decisao ele pede para cada um` } };
    }
    const item = citados[0];
    const universo = [...new Set([...(k.esquema?.decisoes ?? []), ...Object.keys(k.contrato.condutaPorDecisao), ...k.politica.politicas.flatMap(p => p.decisoes)])];
    const pedidas = decisoesCitadasNoPedido(k.pedido, universo);
    const x = clausulas.find(c => c.r.item === item);
    if (pedidas.length === 0 || !x) {
        return pedidas.length === 0 ? { aviso: { codigo: 'pedido_indeterminado', item, mensagem: `o pedido cita ${item}, mas nao nomeia decisao` } } : {};
    }
    if (pedidas.includes(x.r.acao.decisao)) return {};
    const admitidas = k.politica.politicas.find(p => p.item === item)?.decisoes ?? [];
    const atendiveis = pedidas.filter(d => admitidas.includes(d));
    if (atendiveis.length === 0) {
        return { aviso: { codigo: 'pedido_nao_atendivel', item, mensagem: `o pedido nomeia ${pedidas.join(', ')} para ${item}, e a politica nao admite: o plano nao podia atende-lo` } };
    }
    const condutas = [...new Set(atendiveis.map(d => k.contrato.condutaPorDecisao[d]).filter(Boolean))];
    return {
        erro: {
            codigo: 'pedido_global_incompativel', pi: x.r.ordem, pis: [x.r.ordem], item, conduta: x.r.conduta,
            regra: `o pedido nomeia ${atendiveis.join(', ')} para ${item}, e a politica admite`,
            mensagem: `o pedido pede ${atendiveis.join(' ou ')} para ${item}, e o plano decidiu ${x.r.acao.decisao} (conduta ${x.r.conduta})`,
            evidencias: [`pedido: ${k.pedido}`],
            alternativas: [`dar a ${item} a conduta ${condutas.join(' ou ') || '(nenhuma no esquema_dados)'}`]
        }
    };
}

// =============================================================================
// Relatorio
// =============================================================================

/** Os problemas do plano em texto: PIs envolvidos, regra, evidencia e reparo. */
export function relatorioGlobal(problemas: ProblemaValidacao[]): string {
    return problemas.flatMap(e => {
        const linhas = [`- ${e.codigo}: ${e.mensagem}`];
        if (e.pis && e.pis.length > 0) linhas.push(`  PIs: ${e.pis.join(', ')}`);
        if (e.regra) linhas.push(`  regra: ${e.regra}`);
        for (const ev of e.evidencias ?? []) linhas.push(`  evidencia: ${ev}`);
        for (const a of e.alternativas ?? []) linhas.push(`  reparo possivel: ${a}`);
        return linhas;
    }).join('\n');
}
