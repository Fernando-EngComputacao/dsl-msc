/**
 * Validacao DETERMINISTICA da sequencia do Planner contra o conhecimento da
 * requisicao.
 *
 *     PIPlanejado[] (proposta do Qwen)
 *        x  politica efetiva + contrato + regras validadas + pedido
 *        -> ResultadoValidacao: VALID | INVALID | UNRESOLVED
 *
 * O Qwen PROPOE; quem decide e isto. Gramatica e parser aceitarem a saida nao
 * prova nada alem da forma: o item existe, a conduta existe — e o par pode
 * continuar impossivel, a conduta obrigatoria pode faltar, o pedido pode ter
 * ficado sem resposta.
 *
 * E UMA CAMADA DE ORQUESTRACAO. Nenhum criterio abaixo e novo; cada um e o que
 * o fluxo incremental ja usa, aplicado a pares (item, conduta):
 *
 *   forma e dependencias   validarSequenciaPlanejada (contrato-pi.ts)
 *   item na politica       contrato.politicas — o `item_fora_da_poda` de verificarClausulas
 *   conduta conhecida      contrato.condutaPorDecisao — o mapa do esquema_dados
 *   conduta realizavel     condutasRealizaveis (contrato.ts)
 *   par (item, conduta)    decisoesDaConduta + restringirADecisoes — o recorte da
 *                          fase de clausulas do incremental
 *   unicidade              contrato.unicidade — o `item_repetido` de verificarClausulas
 *   obrigatorias           condutasObrigatorias — o `escalonamento_ignorado` de verificarArtefato
 *   itens citados          casamentoLexical (foco.ts) — o casamento que ancora o foco
 *   telemetria sem medida  classificar (recuperacao-politica.ts) + `Lacuna` do Cypher
 *
 * A telemetria entra pela politica: um bloqueio que incide ja tirou a decisao
 * de incremento do item, e o par que dependia dela aparece como incompativel,
 * com o motivo (`PAM 52 < 60`) como evidencia.
 *
 * `verificarConduta` NAO e reusada, de proposito: ela proibe a mesma conduta
 * duas vezes na sequencia, o que e uma restricao do ALGORITMO incremental (uma
 * clausula por conduta). O contrato do artefato (`verificarArtefato`) compara
 * conjuntos e admite duas clausulas da mesma conduta para itens diferentes —
 * `Manter_Bloqueio` para dois farmacos bloqueados e um caso real.
 *
 * INVALID x UNRESOLVED:
 *   INVALID     o conhecimento basta, e o plano viola uma regra. Tem erro.
 *   UNRESOLVED  o conhecimento nao basta para decidir. Tem `dadosFaltantes`, e
 *               o porque vai em `avisos`, com codigo. Nao e culpa do Planner, e
 *               outra proposta nao resolveria: nao se pede ao modelo que
 *               adivinhe o que o conhecimento nao diz.
 * Havendo erro, INVALID prevalece: um plano que viola uma regra comprovada e
 * invalido mesmo que outra parte dele seja indecidivel.
 *
 * O QUE NAO E VALIDADO, POR NAO EXISTIR NO CONHECIMENTO: precedencia entre
 * itens ou condutas. Nenhuma das tres DSLs declara "A antes de B" (`requer_var`
 * nao e ordem: `Acionar_Revisao_VAR` o tem e exigiria a si mesma). As
 * dependencias sao conferidas na forma — so para tras, para PIs que existem —
 * e nenhuma e inventada.
 */

import {
    condutasDoItem,
    condutasObrigatorias,
    condutasRealizaveis,
    decisoesDaConduta,
    estadoVazio,
    restringirADecisoes,
    type ContratoArtefato,
    type TipoViolacao
} from './contrato.js';
import {
    validarPIPlanejado,
    validarSequenciaPlanejada,
    type CodigoContratoPI,
    type PIPlanejado
} from './contrato-pi.js';
import { casamentoLexical } from './foco.js';
import type { SubgrafoPodado } from './politica.js';
import type { RegraValidada } from './recuperacao-cypher.js';
import { explicarRegra } from './recuperacao-hibrida.js';
import { classificar } from './recuperacao-politica.js';
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

/** Os codigos que esta validacao acrescenta — so onde nao havia equivalente. */
export type CodigoSequencia =
    /** A conduta nao existe no `esquema_dados` (ex.: `marcacao`, literal da clausula). */
    | 'conduta_inexistente'
    /** A conduta existe, mas nenhum item da politica efetiva a realiza. */
    | 'conduta_nao_realizavel'
    /** Outros itens a realizam; este, com a politica que tem, nao. */
    | 'item_conduta_incompativel'
    /** O pedido cita um item, e nenhum PI o trata. */
    | 'cobertura_insuficiente'
    /** O pedido cita itens, e o plano nao trata nenhum deles. */
    | 'pedido_incompativel'
    /** Aviso: o pedido nao cita item nenhum pelo nome; a cobertura nao e conferivel. */
    | 'cobertura_indeterminada'
    /** UNRESOLVED: uma regra que decidiria o par nao pode ser avaliada sem uma medida. */
    | 'telemetria_insuficiente'
    /** UNRESOLVED: o conhecimento nao tem o que a decisao exige. */
    | 'conhecimento_insuficiente'
    /** UNRESOLVED antes do Planner: o pedido nao cita item nenhum da politica efetiva. */
    | 'pedido_sem_alvo';

/** Todos os codigos que a validacao da sequencia pode devolver. */
export type CodigoValidacaoSequencia =
    | CodigoSequencia
    | CodigoContratoPI
    | Extract<TipoViolacao, 'item_fora_da_poda' | 'item_repetido' | 'escalonamento_ignorado'>;

type Problema = ProblemaValidacao<CodigoValidacaoSequencia>;

// =============================================================================
// Entrada
// =============================================================================

/** O conhecimento contra o qual a sequencia e julgada. Nada aqui e copia: sao os objetos da execucao. */
export interface ConhecimentoDaSequencia {
    /** O mesmo contrato da geracao: mapa decisao -> conduta, politicas, unicidade, escalonamentos. */
    contrato: ContratoArtefato;
    /** A politica efetiva — a mesma de `contrato.politicas`, como `SubgrafoPodado`. */
    politica: SubgrafoPodado;
    /** Regras validadas pelo Cypher (modo hibrido). Vazio no deterministico. */
    regras: RegraValidada[];
    /** O pedido original. */
    pedido: string;
}

/** Itens da politica que o pedido cita pelo nome — o mesmo casamento que ancora o foco. */
export function itensCitados(k: ConhecimentoDaSequencia): string[] {
    return [...casamentoLexical(k.pedido, k.politica.politicas.map(p => p.item))];
}

/** As regras restritivas que INCIDEM sobre o item, explicadas com o valor observado. */
function evidenciaDasRegras(k: ConhecimentoDaSequencia, item: string): string[] {
    return k.regras.filter(r => r.item === item && classificar(r) === 'bloqueio_condicional').map(explicarRegra);
}

// =============================================================================
// Alvo do pedido: decidido antes de qualquer plano
// =============================================================================

/**
 * O ALVO do pedido: os itens da politica efetiva que ele cita pelo nome
 * (`itensCitados` — `casamentoLexical`, o mesmo criterio do foco e da cobertura).
 *
 * Sem nenhum, o alvo do plano nao e determinavel, e NENHUM plano muda isso: a
 * validacao global concluiria `pedido_global_indeterminado` para qualquer
 * sequencia, porque o criterio so depende do pedido e da politica. Por isso o
 * orquestrador decide aqui, antes do Planner, e nao gasta chamada cognitiva.
 *
 * Com item citado, VALID com os itens — o que o pedido pede a cada um (a
 * decisao) continua sendo do Planner e da politica, como antes. Politica vazia
 * nao e falta de alvo: e lacuna do conhecimento (`lacunasDoConhecimento`).
 */
export function alvoDoPedido(k: ConhecimentoDaSequencia): ResultadoValidacao<string[], CodigoValidacaoSequencia> {
    const citados = itensCitados(k);
    if (citados.length > 0 || k.politica.politicas.length === 0) return valido(citados);
    const candidatos = k.politica.politicas
        .map(p => ({ item: p.item, condutas: condutasDoItem(k.contrato, p.item) }))
        .filter(x => x.condutas.length > 0);
    return naoResolvido(['alvo do pedido: nenhum item da politica efetiva citado pelo nome'], {
        avisos: [{
            codigo: 'pedido_sem_alvo',
            mensagem: 'o pedido nao cita pelo nome nenhum item da politica efetiva: o alvo do plano nao e determinavel, e nenhum plano o tornaria',
            evidencias: [`pedido: ${k.pedido}`],
            alternativas: candidatos.map(x => x.item)
        }],
        promptRecomendado: [
            '[ALVO DO PEDIDO NAO DETERMINAVEL]',
            `pedido: ${k.pedido}`,
            'O pedido nao cita pelo nome nenhum item que o conhecimento admite neste cenario.',
            'Itens trataveis agora (e as condutas que cada um pode cumprir):',
            ...candidatos.map(x => `- ${x.item}: ${x.condutas.join(', ')}`),
            'Reformule o pedido citando o item a tratar.'
        ].join('\n')
    });
}

// =============================================================================
// Lacunas: o que o conhecimento nao permite decidir, com ou sem plano
// =============================================================================

/**
 * O que falta no conhecimento para que QUALQUER sequencia possa ser validada.
 * Nao depende do plano, e por isso roda antes da primeira chamada ao Planner:
 * se o conhecimento nao basta, nao ha tentativa a gastar.
 *
 *   - politica sem item, ou sem mapa decisao -> conduta;
 *   - escalonamento disparado cuja conduta nenhum item realiza (a regra obriga
 *     o que o conhecimento nao permite cumprir);
 *   - item citado no pedido sem conduta nenhuma que o realize.
 */
export function lacunasDoConhecimento(k: ConhecimentoDaSequencia): ResultadoValidacao<never, CodigoValidacaoSequencia> {
    const faltas: string[] = [];
    const avisos: Problema[] = [];
    const lacuna = (falta: string, p: Omit<Problema, 'codigo'>): void => {
        faltas.push(falta);
        avisos.push({ codigo: 'conhecimento_insuficiente', ...p });
    };

    if (k.politica.politicas.length === 0) {
        lacuna('itens na politica efetiva', { mensagem: 'a politica efetiva nao tem item com decisao admissivel' });
    }
    if (Object.keys(k.contrato.condutaPorDecisao).length === 0) {
        lacuna('mapa decisao -> conduta do esquema_dados', {
            mensagem: 'sem o esquema_dados nao ha como ligar conduta a decisao'
        });
    }

    if (faltas.length === 0) {
        const realizaveis = condutasRealizaveis(k.contrato, estadoVazio());
        const regra = `escalonamento disparado: ${k.contrato.escalonamentos.join('; ')}`;
        for (const c of condutasObrigatorias(k.contrato)) {
            if (realizaveis.includes(c)) continue;
            lacuna(`item que realize ${c}`, {
                conduta: c,
                regra,
                mensagem: `o escalonamento disparado obriga ${c}, mas nenhum item da politica efetiva o realiza`
            });
        }
        for (const item of itensCitados(k)) {
            if (condutasDoItem(k.contrato, item).length > 0) continue;
            lacuna(`conduta para ${item}`, {
                item,
                mensagem: `o pedido cita ${item}, mas nenhuma decisao admissivel dele mapeia para uma conduta do esquema_dados`,
                evidencias: k.contrato.politicas.get(item)?.motivos ?? []
            });
        }
    }

    if (faltas.length === 0) return valido();
    return naoResolvido(faltas, { avisos, promptRecomendado: relatorioDeLacunas(faltas, avisos) });
}

// =============================================================================
// Validacao
// =============================================================================

/**
 * Julga a sequencia. Todos os erros encontrados sao devolvidos juntos — o
 * feedback ao Planner precisa de todos, nao do primeiro —, cada um com o PI, o
 * item, a conduta, a regra e, quando ha, a evidencia e as alternativas que o
 * conhecimento admite. Nada e corrigido nem retirado: o valor, quando VALID, e
 * a propria sequencia (ordenada pelo contrato estrutural).
 */
export function validarSequencia(
    sequencia: PIPlanejado[],
    k: ConhecimentoDaSequencia
): ResultadoValidacao<PIPlanejado[], CodigoValidacaoSequencia> {
    const lacunas = lacunasDoConhecimento(k);
    const erros: Problema[] = [];
    const avisos: Problema[] = [...lacunas.avisos];
    const faltas: string[] = [...lacunas.dadosFaltantes];

    // ------------------------------------------------------------ 1. forma
    const forma = validarSequenciaPlanejada(sequencia);
    const bemFormados = Array.isArray(sequencia) && sequencia.every(p => validarPIPlanejado(p).veredito === 'VALID');
    if (!bemFormados) {
        // Com PI malformado, nenhum julgamento semantico e confiavel.
        return invalido(forma.erros, { avisos: forma.avisos, promptRecomendado: relatorioDaSequencia(forma.erros) });
    }
    erros.push(...forma.erros);
    avisos.push(...forma.avisos);
    const ordensCoerentes = !forma.erros.some(e => e.codigo === 'ordem_repetida' || e.codigo === 'ordem_fora_de_sequencia');
    sequencia.forEach((p, i) => {
        if (ordensCoerentes && p.ordem !== i + 1) {
            erros.push({
                codigo: 'ordem_fora_de_posicao', pi: p.ordem, item: p.item, conduta: p.conduta,
                mensagem: `o PI na posicao ${i + 1} da lista veio numerado ${p.ordem}: a lista tem de estar na ordem do plano`
            });
        }
    });

    if (lacunas.veredito === 'UNRESOLVED' && (k.politica.politicas.length === 0 || Object.keys(k.contrato.condutaPorDecisao).length === 0)) {
        // Sem politica ou sem mapa nao ha contra o que julgar par nenhum.
        return erros.length > 0
            ? invalido(erros, { avisos, promptRecomendado: relatorioDaSequencia(erros) })
            : naoResolvido(faltas, { avisos, promptRecomendado: relatorioDeLacunas(faltas, avisos) });
    }

    // ------------------------------------------------------------ 2. cada PI
    const { contrato } = k;
    const condutasConhecidas = new Set(Object.values(contrato.condutaPorDecisao));
    const realizaveis = new Set(condutasRealizaveis(contrato, estadoVazio()));
    const incrementos = new Set(contrato.papeis.decisoesDeIncremento);
    const compativeis: PIPlanejado[] = [];

    for (const p of sequencia) {
        const base = { pi: p.ordem, item: p.item, conduta: p.conduta };
        const politica = contrato.politicas.get(p.item);
        if (!politica) {
            erros.push({
                ...base, codigo: 'item_fora_da_poda', reparo: { item: p.item },
                mensagem: `"${p.item}" nao esta entre os itens que o grafo liberou neste contexto`,
                alternativas: k.politica.politicas.map(x => x.item).filter(i => condutasDoItem(contrato, i).length > 0)
            });
            continue;
        }
        const possiveis = condutasDoItem(contrato, p.item);
        if (!condutasConhecidas.has(p.conduta)) {
            erros.push({
                ...base, codigo: 'conduta_inexistente',
                mensagem: `"${p.conduta}" nao e conduta do esquema_dados`,
                alternativas: possiveis
            });
            continue;
        }
        const decisoesDaCond = decisoesDaConduta(contrato, p.conduta);
        if (!realizaveis.has(p.conduta)) {
            erros.push({
                ...base, codigo: 'conduta_nao_realizavel',
                regra: `${p.conduta} exige ${decisoesDaCond.join(' ou ')}`,
                mensagem: `nenhum item da politica efetiva admite ${decisoesDaCond.join(' ou ')} neste contexto`,
                alternativas: possiveis
            });
            continue;
        }
        const capazes = restringirADecisoes(k.politica, decisoesDaCond).politicas.map(x => x.item);
        if (!capazes.includes(p.item)) {
            erros.push({
                ...base, codigo: 'item_conduta_incompativel',
                regra: `${p.conduta} exige ${decisoesDaCond.join(' ou ')}; ${p.item} admite ${politica.decisoes.join(', ') || 'nenhuma decisao'}`,
                mensagem: `${p.item} nao pode cumprir ${p.conduta} neste contexto`,
                evidencias: [...politica.motivos, ...evidenciaDasRegras(k, p.item)],
                alternativas: possiveis
            });
            continue;
        }

        // Telemetria: o par so se realiza por incremento, e uma regra que o
        // bloquearia nao pode ser avaliada porque a medida nao veio. A mesma
        // classificacao de `refinarPolitica`, perguntando o que a regra SERIA
        // se incidisse.
        const decisoesDoPar = politica.decisoes.filter(d => decisoesDaCond.includes(d));
        if (decisoesDoPar.every(d => incrementos.has(d))) {
            const semMedida = k.regras.filter(
                r => r.item === p.item && r.lacunas.length > 0 &&
                    classificar({ ...r, lacunas: [], aplicavel: true }) === 'bloqueio_condicional'
            );
            for (const r of semMedida) {
                faltas.push(...r.lacunas.map(l => `telemetria.${l.campo}`));
                avisos.push({
                    ...base, codigo: 'telemetria_insuficiente', regra: r.regraId, evidencias: [explicarRegra(r)],
                    mensagem: `${p.conduta} so se realiza por incremento (${decisoesDoPar.join(', ')}), e a regra ${r.regraId}, que bloquearia o incremento, nao pode ser avaliada sem ${r.lacunas.map(l => l.campo).join(', ')}`
                });
            }
        }
        compativeis.push(p);
    }

    // ------------------------------------------------------------ 3. unicidade
    if (contrato.unicidade) {
        const porItem = new Map<string, PIPlanejado[]>();
        for (const p of sequencia) porItem.set(p.item, [...(porItem.get(p.item) ?? []), p]);
        for (const [item, pis] of porItem) {
            if (pis.length < 2 || !contrato.politicas.has(item)) continue;
            erros.push({
                codigo: 'item_repetido', pi: pis[1].ordem, item, reparo: { item },
                mensagem: `${item} aparece nos PIs ${pis.map(p => p.ordem).join(', ')}: o contrato admite uma clausula por item`,
                evidencias: pis.map(p => `PI ${p.ordem}: ${p.item} -> ${p.conduta}`)
            });
        }
    }

    // ------------------------------------------------------------ 4. obrigatorias
    const cumpridas = new Set(compativeis.map(p => p.conduta));
    for (const c of condutasObrigatorias(contrato)) {
        // Conduta obrigatoria que ninguem realiza e lacuna, ja registrada acima.
        if (cumpridas.has(c) || !realizaveis.has(c)) continue;
        erros.push({
            codigo: 'escalonamento_ignorado', conduta: c,
            regra: `escalonamento disparado: ${contrato.escalonamentos.join('; ')}`,
            mensagem:
                `falta um PI com a conduta ${c}: o grafo disparou ${contrato.escalonamentos.length} ` +
                `escalonamento(s), que a torna(m) obrigatoria, e nenhum PI compativel a cumpre`,
            evidencias: sequencia.map(p => `PI ${p.ordem}: ${p.item} -> ${p.conduta}`),
            alternativas: restringirADecisoes(k.politica, decisoesDaConduta(contrato, c)).politicas.map(x => x.item)
        });
    }

    // ------------------------------------------------------------ 5. pedido
    const citados = itensCitados(k);
    const exigidos = citados.filter(i => condutasDoItem(contrato, i).length > 0);
    if (citados.length === 0) {
        avisos.push({
            codigo: 'cobertura_indeterminada',
            mensagem: 'o pedido nao cita item do conhecimento pelo nome: a cobertura do pedido nao e conferivel deterministicamente'
        });
    } else if (exigidos.length > 0) {
        const tratados = new Set(sequencia.map(p => p.item));
        const faltando = exigidos.filter(i => !tratados.has(i));
        if (faltando.length === exigidos.length) {
            erros.push({
                codigo: 'pedido_incompativel',
                mensagem: `o pedido cita ${exigidos.join(', ')}, e o plano nao trata nenhum deles (itens do plano: ${[...tratados].join(', ')})`,
                alternativas: exigidos.map(i => `${i}: ${condutasDoItem(contrato, i).join(', ')}`)
            });
        } else {
            for (const item of faltando) {
                erros.push({
                    codigo: 'cobertura_insuficiente', item,
                    mensagem: `o pedido cita ${item}, e nenhum PI o trata`,
                    alternativas: condutasDoItem(contrato, item)
                });
            }
        }
    }

    // ------------------------------------------------------------ veredito
    if (erros.length > 0) return invalido(erros, { avisos, promptRecomendado: relatorioDaSequencia(erros) });
    if (faltas.length > 0) {
        const unicas = [...new Set(faltas)];
        return naoResolvido(unicas, { avisos, promptRecomendado: relatorioDeLacunas(unicas, avisos) });
    }
    return valido(forma.valor!, avisos);
}

// =============================================================================
// Relatorios
// =============================================================================

/** O que as alternativas SAO, para o texto nao deixar o leitor adivinhar. */
function rotuloDasAlternativas(e: Problema): string {
    switch (e.codigo) {
        case 'escalonamento_ignorado':
            return `itens que podem cumprir ${e.conduta}`;
        case 'item_fora_da_poda':
            return 'itens candidatos';
        case 'pedido_incompativel':
            return 'itens citados no pedido e as condutas que cada um pode cumprir';
        default:
            return e.item ? `condutas que ${e.item} pode cumprir` : 'permitido';
    }
}

function linhasDoProblema(e: Problema): string[] {
    const linhas = [`- ${e.codigo}: ${e.mensagem}`];
    if (e.regra) linhas.push(`  regra: ${e.regra}`);
    for (const ev of e.evidencias ?? []) linhas.push(`  evidencia: ${ev}`);
    if (e.alternativas && e.alternativas.length > 0) linhas.push(`  ${rotuloDasAlternativas(e)}: ${e.alternativas.join(', ')}`);
    return linhas;
}

/**
 * Os erros agrupados por PI e, depois, os do plano inteiro — a parte factual
 * do feedback ao Planner. Nao diz o que fazer alem do que o conhecimento
 * admite (`permitido`).
 */
export function relatorioDaSequencia(erros: Problema[]): string {
    const porPI = new Map<number, Problema[]>();
    const doPlano: Problema[] = [];
    for (const e of erros) {
        if (e.pi === undefined) doPlano.push(e);
        else porPI.set(e.pi, [...(porPI.get(e.pi) ?? []), e]);
    }
    const linhas: string[] = [];
    for (const [pi, doPI] of [...porPI].sort((a, b) => a[0] - b[0])) {
        const { item, conduta } = doPI[0];
        linhas.push(`PI ${pi}` + (item ? ` (${item}${conduta ? ` -> ${conduta}` : ''})` : '') + ':');
        for (const e of doPI) linhas.push(...linhasDoProblema(e));
    }
    if (doPlano.length > 0) {
        linhas.push('Plano inteiro:');
        for (const e of doPlano) linhas.push(...linhasDoProblema(e));
    }
    return linhas.join('\n');
}

/** O porque de um UNRESOLVED, para quem opera o sistema — nao para o Planner. */
export function relatorioDeLacunas(faltas: string[], avisos: Problema[]): string {
    const motivos = avisos.filter(a => a.codigo === 'conhecimento_insuficiente' || a.codigo === 'telemetria_insuficiente');
    return [
        '[CONHECIMENTO INSUFICIENTE PARA VALIDAR A SEQUENCIA]',
        `faltam: ${faltas.join(', ')}`,
        ...motivos.flatMap(linhasDoProblema),
        'Nenhuma sequencia deve ser aceita sem esses dados: outra proposta do Planner nao os supre.'
    ].join('\n');
}
