/**
 * Decompositor — da sequencia VALIDADA a um contexto independente por PI.
 *
 *     SEQUENCE_VALID -> PIPlanejado[] -> decomporPIs -> ContextoGeracaoItem[]
 *
 * Responde "o que este PI precisa saber?" — e so. Nao escolhe item, conduta,
 * decisao, meio nem valor; nao reordena, nao acrescenta nem retira PI; nao
 * escreve justificativa. O `PIPlanejado` e a autoridade sobre item, conduta,
 * ordem e dependencias, e o Decompositor apenas associa a ele o conhecimento
 * que o atinge. Decidir o que fazer com o par e do PI Agent, na etapa seguinte.
 *
 * RESTRICAO PROGRESSIVA — cada passo ve menos que o anterior:
 *
 *     politica global + regras recuperadas + fatos do cenario    (o que o Planner viu)
 *       -> o item do PI              contrato.politicas / subgrafoDeItem
 *       -> a conduta do PI           decisoesDaConduta + restringirADecisoes
 *       -> o que cita o item ou a conduta: fatos, regras, relacionais
 *       -> a telemetria que essas regras e esses textos leem
 *
 * COMO A RELEVANCIA E DECIDIDA — sempre por estrutura, nunca por modelo:
 *   fatos        os que a recuperacao registrou sobre o item (`vistaDoCenario`)
 *                e, se a conduta e obrigatoria (`condutasObrigatorias`), os
 *                escalonamentos que a tornam obrigatoria.
 *   regras       as `RegraValidada` do item (`r.item`); os gatilhos que INCIDEM
 *                nos contextos citados pelos fatos do PI; os escalonamentos que
 *                incidem nos contextos cujos escalonamentos obrigam a conduta.
 *   relacionais  as que citam o item (`itensDaRelacao`).
 *   telemetria   a que as regras do PI leram (`evidencia`) e todo parametro cujo
 *                nome aparece INTEIRO nos textos do PI: pedido, motivos, fatos,
 *                relacionais, obrigacoes. Na duvida preserva: parametro citado
 *                entra, mesmo que a citacao seja so do pedido.
 *   decisoes     `item.decisoes` ∩ `decisoesDaConduta`. O resto do universo vai
 *                para `bloqueadas` (o que as restricoes tiraram do item) ou
 *                `foraDaConduta` (o que o item admite para outra conduta) —
 *                nenhuma decisao some sem deixar registro.
 *   valores      os que a gramatica alcancaria para essas decisoes.
 *
 * O QUE NAO E INVENTADO: precedencia (`dependeDe` e o que o Planner declarou;
 * nenhuma DSL declara "A antes de B"), semantica para `requer_var`,
 * `requer_dupla_checagem` e `justificativa_obrigatoria` (viajam como atributos
 * declarados da conduta), valor fora do reticulo, evidencia fora da recuperacao.
 *
 * INDEPENDENCIA. Cada contexto passa pelo JSON e e congelado: dado puro, sem
 * referencia compartilhada com a execucao nem com outro PI, sem Map, closure,
 * sessao ou conexao — o objeto devolvido E a sua forma serializada. Nao depende
 * de prefixo de artefato nem de clausula aceita (nenhum dos dois existe quando
 * ele e montado), e do outro PI so conhece ordem, item e conduta. E o que
 * permite, adiante, gerar os PIs em qualquer ordem ou em outro processo. Nada
 * aqui paraleliza.
 *
 * INCONSISTENCIA NAO E CORRIGIDA. A sequencia chega validada: item fora da
 * politica, conduta sem decisao ou par sem decisao em comum, neste ponto, e
 * defeito interno — `InconsistenciaDecomposicao`, sem fallback.
 */

import { condutasObrigatorias, decisoesDaConduta, restringirADecisoes, type ContratoArtefato } from './contrato.js';
import { validarSequenciaPlanejada, type PIPlanejado } from './contrato-pi.js';
import { contemPalavra, normalizar, tokensDoNome } from './foco.js';
import {
    evidenciasDe,
    itensDaRelacao,
    subgrafoDeItem,
    type ContextoGeracaoItem,
    type FatoRecuperado,
    type RegraRelacional,
    type RelacaoPI
} from './item-geracao.js';
import type { EsquemaDeclarado, PoliticaItem, SubgrafoPodado, ValorAdmissivel } from './politica.js';
import type { RegraValidada } from './recuperacao-cypher.js';
import { classificar } from './recuperacao-politica.js';
import type { Dominio } from './recuperacao.js';

// =============================================================================
// Os fatos do cenario, sem o nome do dominio
// =============================================================================

/** As restricoes do dominio (`Retrieved*Constraints`) no vocabulario comum. */
export interface VistaCenario {
    /** item -> o que a recuperacao registrou sobre ele. */
    fatosPorItem: Record<string, FatoRecuperado[]>;
    /** Os escalonamentos disparados. */
    escalonamentos: FatoRecuperado[];
    /** `interacoes` | `incompatibilidades` | `agravantes`. */
    relacionais: RegraRelacional[];
    /**
     * As `regra_global` do cenario, como a DSL as escreve: TEXTO (descricao e
     * severidade). Nao tem forma avaliavel — sao contexto e evidencia, nunca
     * criterio de validacao (ver `validacao-global.ts`).
     */
    regrasGlobais: { descricao: string; severidade: string }[];
}

/**
 * Como cada dominio nomeia os MESMOS campos das restricoes — o principio de
 * `PapeisDominio`, aplicado a `Retrieved*Constraints`. As listas comuns
 * (`bloqueios`, `vetados`, `ajustes`, `recomendados`, `escalonamentos`) tem o
 * mesmo nome nos tres; muda o nome do item, do contexto, da lista de contextos
 * ativos, da relacional, e a lista extra que so um dominio tem.
 */
const CAMPOS_DAS_RESTRICOES: Record<
    Dominio,
    {
        item: string; contexto: string; ativos: string; relacionais: string; extra?: [string, 'proibicao' | 'isencao'];
        /** A relacao entre itens e um RISCO de combina-los (ver `relacionalDeRisco`). */
        relacionalDeRisco: boolean;
    }
> = {
    med: { item: 'farmaco', contexto: 'protocolo', ativos: 'protocolosAtivos', relacionais: 'interacoes', relacionalDeRisco: true },
    agro: {
        item: 'produto', contexto: 'cultura', ativos: 'culturasAtivas', relacionais: 'incompatibilidades',
        extra: ['proibicoes', 'proibicao'], relacionalDeRisco: true
    },
    fut: { item: 'infracao', contexto: 'lance', ativos: 'lancesAtivos', relacionais: 'agravantes', extra: ['isencoes', 'isencao'], relacionalDeRisco: false }
};

/**
 * A regra relacional do dominio descreve um RISCO de combinar os dois itens?
 * E o que a palavra-chave da DSL declara: `interacao` (med) e `incompativel`
 * (agro) sim — efeito aditivo, precipitacao no tanque; `agravante` (fut) nao —
 * a combinacao eleva a sancao, nao e proibida. So a relacao de risco pode
 * reprovar uma combinacao de PIs (validacao global).
 */
export function relacionalDeRisco(dominio: Dominio): boolean {
    return CAMPOS_DAS_RESTRICOES[dominio].relacionalDeRisco;
}

/**
 * Achata as restricoes do dominio em fatos por item. Nada e reavaliado: os
 * textos sao os que `retrieve*Constraints` escreveu. Restricoes ausentes (ou de
 * outro formato) viram vista vazia — o que falta aqui e so contexto a menos,
 * nunca uma decisao a mais.
 */
export function vistaDoCenario(dominio: Dominio, restricoes: unknown): VistaCenario {
    const vista: VistaCenario = { fatosPorItem: {}, escalonamentos: [], relacionais: [], regrasGlobais: [] };
    if (typeof restricoes !== 'object' || restricoes === null) return vista;

    const campos = CAMPOS_DAS_RESTRICOES[dominio];
    const r = restricoes as Record<string, unknown>;
    type Registro = Record<string, string | undefined>;
    const lista = <T = Registro>(nome: string): T[] => (Array.isArray(r[nome]) ? (r[nome] as T[]) : []);

    const gatilhos = new Map<string, string[]>();
    for (const a of lista<{ nome: string; gatilhos: string[] }>(campos.ativos)) gatilhos.set(a.nome, [...a.gatilhos]);
    /** O contexto de origem e os gatilhos que o ativaram — a evidencia de que ele vale. */
    const doContexto = (nome: string | undefined): Pick<FatoRecuperado, 'contexto' | 'condicoes'> =>
        nome ? { contexto: nome, condicoes: gatilhos.get(nome) ?? [] } : { condicoes: [] };
    const registrar = (item: string | undefined, fato: FatoRecuperado): void => {
        if (item) (vista.fatosPorItem[item] ??= []).push(fato);
    };

    for (const b of lista('bloqueios')) {
        registrar(b[campos.item], { tipo: 'bloqueio', descricao: b.razao ?? '', condicoes: b.regra ? [b.regra] : [] });
    }
    for (const v of lista('vetados')) {
        registrar(v[campos.item], { tipo: 'veto', descricao: v.motivo ?? '', origem: v.origem, ...doContexto(v[campos.contexto]) });
    }
    for (const a of lista('ajustes')) {
        registrar(a[campos.item], {
            tipo: 'ajuste', descricao: a.detalhe ? `${a.acao}: ${a.detalhe}` : a.acao ?? '', origem: a.origem, condicoes: []
        });
    }
    for (const x of lista('recomendados')) {
        const contexto = x[campos.contexto];
        registrar(x[campos.item], {
            tipo: 'recomendacao', descricao: x.indicacao ?? '', origem: `${campos.contexto} ${contexto}`, ...doContexto(contexto)
        });
    }
    if (campos.extra) {
        const [nome, tipo] = campos.extra;
        for (const x of lista(nome)) {
            registrar(x[campos.item], {
                tipo, descricao: x.excecao ? `${x.condicao} (excecao: ${x.excecao})` : x.condicao ?? '', condicoes: []
            });
        }
    }
    vista.escalonamentos = lista('escalonamentos').map(e => ({
        tipo: 'escalonamento' as const,
        // O mesmo texto de `ContratoArtefato.escalonamentos`.
        descricao: `${e.destino}: ${e.detalhe}`,
        origem: `${campos.contexto} ${e[campos.contexto]}`,
        ...doContexto(e[campos.contexto])
    }));
    vista.relacionais = lista<RegraRelacional>(campos.relacionais);
    vista.regrasGlobais = lista<{ descricao: string; severidade: string }>('regrasGlobais');
    return vista;
}

// =============================================================================
// Decomposicao
// =============================================================================

/** O conhecimento contra o qual cada PI e recortado. Tudo vem da execucao; nada e buscado de novo. */
export interface ConhecimentoDaDecomposicao {
    requestId: string;
    dominio: Dominio;
    pedido: string;
    /** A telemetria inteira do cenario; cada PI recebe o recorte dele. */
    telemetria: Record<string, number>;
    /** O mesmo contrato que validou a sequencia. */
    contrato: ContratoArtefato;
    /** A politica efetiva — a mesma de `contrato.politicas`. */
    politica: SubgrafoPodado;
    /** Regras validadas pelo Cypher (modo hibrido). Vazio no deterministico. */
    regras: RegraValidada[];
    /** As restricoes do dominio depois do foco (`Retrieved*Constraints`). */
    restricoes: unknown;
    /** O que o `esquema_dados` declara. Ausente: `bloqueadas` e `conduta.atributos` saem vazios. */
    esquema?: EsquemaDeclarado;
}

/** Defeito interno: a sequencia dita validada nao se sustenta contra o conhecimento. */
export class InconsistenciaDecomposicao extends Error {
    constructor(mensagem: string, readonly pi?: number) {
        super(mensagem);
        this.name = 'InconsistenciaDecomposicao';
    }
}

/**
 * As condicoes observadas dos fatos, sem repeticao: o gatilho de um protocolo
 * sustenta a recomendacao E o escalonamento dele, mas e UMA observacao.
 * Rotulada pelo contexto que ativou, ou pelo tipo quando e a condicao da
 * propria regra.
 */
export function evidenciasDosFatos(fatos: FatoRecuperado[], rotuloContexto = 'contexto'): string[] {
    return [
        ...new Set(fatos.flatMap(f => f.condicoes.map(c => (f.contexto ? `${rotuloContexto} ${f.contexto} ativo: ${c}` : `${f.tipo}: ${c}`))))
    ];
}

/** Congela o objeto inteiro, em profundidade. */
function congelar<T>(x: T): T {
    if (typeof x === 'object' && x !== null && !Object.isFrozen(x)) {
        for (const v of Object.values(x)) congelar(v);
        Object.freeze(x);
    }
    return x;
}

/**
 * Copia pelo JSON e congela: o objeto devolvido E a sua forma serializada, sem
 * referencia compartilhada com a entrada. E como todo contexto de PI nasce — e
 * como nasce a vista restrita de uma nova tentativa do mesmo PI.
 */
export function comoDadoPuro<T>(x: T): T {
    return congelar(JSON.parse(JSON.stringify(x)) as T);
}

/**
 * Um contexto por PI, na ordem da sequencia.
 *
 * Funcao pura: nao gera, nao chama modelo, nao consulta grafo, nao muda a
 * sequencia nem o conhecimento. A sequencia e conferida de novo — forma, ordem
 * na lista, item na politica, conduta no esquema, par com decisao em comum — e
 * qualquer falha lanca `InconsistenciaDecomposicao`: nesta altura ela ja
 * deveria ter passado pela validacao, e nao se decompoe plano nao validado.
 */
export function decomporPIs(sequencia: readonly PIPlanejado[], k: ConhecimentoDaDecomposicao): ContextoGeracaoItem[] {
    const forma = validarSequenciaPlanejada(sequencia);
    if (forma.veredito !== 'VALID') {
        throw new InconsistenciaDecomposicao(`a sequencia nao tem a forma de um plano: ${forma.erros.map(e => e.mensagem).join('; ')}`);
    }
    sequencia.forEach((p, i) => {
        if (p.ordem !== i + 1) {
            throw new InconsistenciaDecomposicao(`o PI na posicao ${i + 1} da lista veio numerado ${p.ordem}`, p.ordem);
        }
    });

    const vista = vistaDoCenario(k.dominio, k.restricoes);
    const obrigatorias = new Set(condutasObrigatorias(k.contrato));
    return sequencia.map((pi, i) => comoDadoPuro(contextoDoPI(pi, i, sequencia, k, vista, obrigatorias)));
}

function contextoDoPI(
    pi: PIPlanejado,
    indice: number,
    sequencia: readonly PIPlanejado[],
    k: ConhecimentoDaDecomposicao,
    vista: VistaCenario,
    obrigatorias: Set<string>
): ContextoGeracaoItem {
    const falha = (mensagem: string): InconsistenciaDecomposicao =>
        new InconsistenciaDecomposicao(`PI ${pi.ordem} (${pi.item} -> ${pi.conduta}): ${mensagem}`, pi.ordem);

    // ----------------------------------------------------- item: a politica dele
    const politica = k.politica.politicas.find(p => p.item === pi.item);
    if (!politica || !k.contrato.politicas.has(pi.item)) throw falha('o item nao esta na politica efetiva');

    // ----------------------------------------------------- conduta: o recorte
    const daConduta = decisoesDaConduta(k.contrato, pi.conduta);
    if (daConduta.length === 0) throw falha('a conduta nao esta no esquema_dados');
    const restrito = restringirADecisoes(subgrafoDeItem(k.politica, pi.item)!, daConduta);
    if (restrito.politicas.length !== 1) {
        throw falha(`${pi.item} nao admite nenhuma decisao de ${pi.conduta} (${daConduta.join(', ')})`);
    }
    const admissiveis = restrito.politicas[0].decisoes;
    const doItem = new Set(politica.decisoes);
    const doPI = new Set(admissiveis);

    // A politica DO PI: as decisoes da conduta e so os valores que elas
    // alcancam. Meios, unidades, `bloqueado` e `motivos` ficam intactos — valem
    // para o item. A gramatica que ela gera e a mesma de `restrito` (ver
    // `valoresDoPI`), sem carregar valor de decisao que o PI nao pode usar.
    const valores = valoresDoPI(politica, admissiveis);
    const politicaDoPI: PoliticaItem = { ...politica, decisoes: admissiveis, valores: valores.gerais, valoresPorDecisao: valores.porDecisao };
    const subgrafoDoItem: SubgrafoPodado = { ...restrito, politicas: [politicaDoPI] };

    // ----------------------------------------------------- o que atinge o par
    const obrigatoria = obrigatorias.has(pi.conduta);
    const fatos = [...(vista.fatosPorItem[pi.item] ?? []), ...(obrigatoria ? vista.escalonamentos : [])];
    const ativadores = new Set(fatos.map(f => f.contexto).filter((c): c is string => Boolean(c)));
    const escalonadores = new Set(fatos.filter(f => f.tipo === 'escalonamento').map(f => f.contexto));
    const regras = k.regras.filter(r =>
        r.item === pi.item ||
        (ativadores.has(r.item) && classificar(r) === 'ativacao_de_contexto') ||
        (escalonadores.has(r.item) && classificar(r) === 'escalonamento'));
    const regrasRelacionais = vista.relacionais.filter(r => itensDaRelacao(r).includes(pi.item));
    const obrigatoriaPor = obrigatoria ? [...k.contrato.escalonamentos] : [];

    const textos = [
        k.pedido,
        ...politica.motivos,
        ...fatos.flatMap(f => [f.descricao, f.origem ?? '', ...f.condicoes]),
        ...regrasRelacionais.flatMap(r => [r.mecanismo, r.conduta]),
        ...obrigatoriaPor
    ];

    return {
        item: politicaDoPI,
        subgrafoDoItem,
        regras,
        evidencias: evidenciasDe(regras),
        fatos,
        metadata: { itemId: pi.item, dominio: k.dominio, requestId: k.requestId, ordemOriginal: indice },
        pi,
        conduta: {
            nome: pi.conduta,
            decisoes: daConduta,
            atributos: k.esquema?.condutas[pi.conduta] ?? {},
            obrigatoriaPor
        },
        pedido: k.pedido,
        telemetriaRelevante: telemetriaDoPI(k.telemetria, textos, regras),
        regrasRelacionais,
        decisoes: {
            admissiveis,
            bloqueadas: (k.esquema?.decisoes ?? []).filter(d => !doItem.has(d)),
            foraDaConduta: politica.decisoes.filter(d => !doPI.has(d))
        },
        meios: meiosDoPI(politica, k.esquema?.meios ?? []),
        valores,
        relacoes: relacoesDoPI(pi, sequencia, regrasRelacionais),
        restricoes: politica.motivos
    };
}

/**
 * A telemetria que o PI le: a que as regras dele usaram e a que os textos dele
 * citam pelo nome inteiro, na ordem do cenario. O valor e sempre o do cenario.
 */
function telemetriaDoPI(
    telemetria: Record<string, number>,
    textos: string[],
    regras: RegraValidada[]
): Record<string, number> {
    const lidas = new Set(regras.flatMap(r => Object.keys(r.evidencia)));
    const texto = normalizar(textos.join(' '));
    const saida: Record<string, number> = {};
    for (const [parametro, valor] of Object.entries(telemetria)) {
        const nome = tokensDoNome(parametro).join(' ');
        if (lidas.has(parametro) || (nome.length > 0 && contemPalavra(texto, nome))) saida[parametro] = valor;
    }
    return saida;
}

/**
 * Os meios que a gramatica alcancaria: os do item; sem nenhum declarado, o meio
 * e livre no vocabulario do dominio (`grammar_from_kg.py` so especializa o meio
 * quando a politica traz `meios`).
 */
function meiosDoPI(politica: PoliticaItem, universo: string[]): { admissiveis: string[]; foraDoItem: string[] } {
    if (politica.meios.length === 0) return { admissiveis: [...universo], foraDoItem: [] };
    const doItem = new Set(politica.meios);
    return { admissiveis: [...politica.meios], foraDoItem: universo.filter(m => !doItem.has(m)) };
}

/**
 * Os valores que a gramatica alcancaria para as decisoes do PI — o mesmo
 * criterio de `grammar_from_kg.py`: com mapa por decisao, cada decisao usa a
 * sua lista e, sem entrada, a uniao; sem mapa, todas usam a uniao.
 */
function valoresDoPI(
    politica: PoliticaItem,
    admissiveis: string[]
): { gerais: ValorAdmissivel[]; porDecisao: Record<string, ValorAdmissivel[]> } {
    const mapa = politica.valoresPorDecisao ?? {};
    const temMapa = Object.keys(mapa).length > 0;
    const porDecisao: Record<string, ValorAdmissivel[]> = {};
    let usaGerais = !temMapa;
    for (const d of admissiveis) {
        const valores = temMapa ? mapa[d] : undefined;
        if (valores && valores.length > 0) porDecisao[d] = valores;
        else usaGerais = true;
    }
    return { gerais: usaGerais ? politica.valores : [], porDecisao };
}

/** De cada outro PI, so ordem, item e conduta — e o motivo da relacao. */
function relacoesDoPI(pi: PIPlanejado, sequencia: readonly PIPlanejado[], relacionais: RegraRelacional[]): RelacaoPI[] {
    const resumo = (q: PIPlanejado) => ({ ordem: q.ordem, item: q.item, conduta: q.conduta });
    const relacoes: RelacaoPI[] = pi.dependeDe.map(d => ({ tipo: 'depende_de' as const, ...resumo(sequencia[d - 1]) }));
    for (const q of sequencia) {
        if (q.dependeDe.includes(pi.ordem)) relacoes.push({ tipo: 'dependente', ...resumo(q) });
    }
    for (const q of sequencia) {
        if (q.ordem === pi.ordem) continue;
        for (const regra of relacionais) {
            if (itensDaRelacao(regra).includes(q.item)) relacoes.push({ tipo: 'relacional', ...resumo(q), regra });
        }
    }
    return relacoes;
}

// =============================================================================
// Prompt por PI — preparado, nunca enviado nesta etapa
// =============================================================================

/**
 * O prompt do PI Agent, montado SO do contexto do PI: nao ha politica inteira,
 * nem outro PI por completo, nem artefato parcial. Nesta etapa nada o envia a
 * modelo algum; ele existe para ser medido e conferido. Instrucao de tarefa e
 * formato de saida sao do PI Agent, que ainda nao existe.
 *
 * Bloqueio e veto nao se repetem em REGRAS: `retrieve*Constraints` escreve
 * cada um, com a condicao, nos `motivos` da politica, que ja estao em
 * RESTRICOES; a condicao observada deles aparece em EVIDENCIAS.
 */
export function montarPromptPI(c: ContextoGeracaoItem): string {
    if (!c.pi || !c.conduta) throw new Error('montarPromptPI recebe o contexto de um PI (saida de decomporPIs)');
    const papeis = c.subgrafoDoItem.papeis;
    const linhas: string[] = [];
    const bloco = (titulo: string, conteudo: string[]): void => {
        linhas.push('', `[${titulo}]`, ...(conteudo.length > 0 ? conteudo : ['(nenhum)']));
    };
    const pi = (o: { ordem: number; item: string; conduta: string }): string => `PI ${o.ordem} (${o.item} -> ${o.conduta})`;
    const valores = (vs: ValorAdmissivel[]): string =>
        vs.length > 0 ? vs.map(v => `${v.valor} ${v.unidade}`).join(', ') : '(livre: o modelo nao declara limite)';

    linhas.push('[CONTEXTO DA REQUISICAO]', `dominio: ${c.metadata.dominio ?? '?'}`);
    if (c.subgrafoDoItem.constantes.sujeito) linhas.push(`${papeis.campoSujeito}: ${c.subgrafoDoItem.constantes.sujeito}`);

    bloco('PEDIDO', [c.pedido || '(vazio)']);
    bloco('TELEMETRIA RELEVANTE', Object.entries(c.telemetriaRelevante).map(([p, v]) => `- ${p}: ${v}`));
    bloco('PI A SER RESOLVIDO', [
        `ordem: ${c.pi.ordem}`,
        `${papeis.item}: ${c.pi.item}`,
        `${papeis.conduta}: ${c.pi.conduta}`,
        `depende de: ${c.pi.dependeDe.length > 0 ? c.pi.dependeDe.map(d => `PI ${d}`).join(', ') : 'nenhum'}`
    ]);
    bloco('REGRAS RELEVANTES', [
        ...c.fatos
            .filter(f => f.tipo !== 'bloqueio' && f.tipo !== 'veto')
            .map(f => `- ${f.tipo}: ${f.descricao}` + (f.origem ? ` [${f.origem}]` : '')),
        ...c.regras.map(r => {
            const estado = r.lacunas.length > 0 ? 'sem medida' : r.aplicavel ? 'incide' : 'nao incide';
            return `- ${r.regraId} (${estado})` + (r.efeito.razao ? `: ${r.efeito.razao}` : '');
        }),
        ...c.regrasRelacionais.map(r => `- ${r.entre} [${r.gravidade}]: ${r.mecanismo}` + (r.conduta ? ` — orienta: ${r.conduta}` : ''))
    ]);
    bloco('EVIDENCIAS', [
        ...c.evidencias.map(e => `- ${e.regraId}: ${e.campo} observado ${e.observado}, exigido ${e.esperado}`),
        ...evidenciasDosFatos(c.fatos, papeis.contexto).map(e => `- ${e}`)
    ]);
    bloco('DECISOES ADMISSIVEIS', [
        ...c.decisoes.admissiveis.map(d => `- ${d}`),
        `${papeis.meio}: ${c.meios.admissiveis.join(', ') || '(livre)'}`,
        ...(c.decisoes.bloqueadas.length > 0 ? [`bloqueadas para ${c.pi.item}: ${c.decisoes.bloqueadas.join(', ')}`] : []),
        ...(c.decisoes.foraDaConduta.length > 0
            ? [`admitidas por ${c.pi.item}, mas de outra ${papeis.conduta}: ${c.decisoes.foraDaConduta.join(', ')}`]
            : [])
    ]);
    bloco('VALORES ADMISSIVEIS', c.decisoes.admissiveis.map(d => `- ${d}: ${valores(c.valores.porDecisao[d] ?? c.valores.gerais)}`));
    bloco('RESTRICOES', [
        ...c.restricoes.map(m => `- ${m}`),
        ...Object.entries(c.conduta.atributos).map(([a, v]) => `- ${c.conduta!.nome} declara ${a} ${v}`),
        ...c.conduta.obrigatoriaPor.map(e => `- ${c.conduta!.nome} e obrigatoria: escalonamento disparado ${e}`)
    ]);
    bloco('RELACOES', c.relacoes.map(r => {
        switch (r.tipo) {
            case 'depende_de':
                return `- depende do ${pi(r)}: so a dependencia declarada no plano; o resultado dele nao faz parte deste contexto`;
            case 'dependente':
                return `- o ${pi(r)} depende deste`;
            case 'relacional':
                return `- ${pi(r)}: ${r.regra?.entre} [${r.regra?.gravidade}]`;
        }
    }));
    return linhas.join('\n');
}

// =============================================================================
// Medicao
// =============================================================================

export interface MetricasContextoPI {
    ordem: number;
    item: string;
    conduta: string;
    regras: number;
    fatos: number;
    regrasRelacionais: number;
    /** Evidencias das regras mais as condicoes observadas dos fatos (`evidenciasDosFatos`). */
    evidencias: number;
    decisoesAdmissiveis: number;
    /** Pares valor+unidade distintos que as decisoes admissiveis alcancam. */
    valoresAdmissiveis: number;
    telemetria: number;
    /** `JSON.stringify` do contexto — o que iria a outro processo. */
    caracteresContexto: number;
    caracteresPrompt: number;
}

/**
 * O antes e o depois da restricao progressiva. `global` e o conhecimento
 * inteiro da requisicao na MESMA forma que o contexto por PI (JSON da politica,
 * regras, fatos e relacionais), e o Prompt Semantico que o Planner leu. Tokens
 * nao sao medidos: a unica contagem do projeto e a do tokenizador do motor
 * (`tokens_prompt`), e obte-la exigiria chamar o motor.
 */
export interface MetricasDecomposicao {
    pis: number;
    duracaoMs: number;
    global: {
        itens: number;
        regras: number;
        fatos: number;
        regrasRelacionais: number;
        evidencias: number;
        telemetria: number;
        caracteresConhecimento: number;
        caracteresPromptSemantico?: number;
    };
    porPI: MetricasContextoPI[];
}

export function medirDecomposicao(
    contextos: ContextoGeracaoItem[],
    k: ConhecimentoDaDecomposicao,
    duracaoMs: number,
    promptSemantico?: string
): MetricasDecomposicao {
    const vista = vistaDoCenario(k.dominio, k.restricoes);
    const fatos = [...Object.values(vista.fatosPorItem).flat(), ...vista.escalonamentos];

    return {
        pis: contextos.length,
        duracaoMs,
        global: {
            itens: k.politica.politicas.length,
            regras: k.regras.length,
            fatos: fatos.length,
            regrasRelacionais: vista.relacionais.length,
            evidencias: evidenciasDe(k.regras).length + evidenciasDosFatos(fatos).length,
            telemetria: Object.keys(k.telemetria).length,
            caracteresConhecimento: JSON.stringify({
                politica: k.politica, regras: k.regras, fatos, relacionais: vista.relacionais, telemetria: k.telemetria
            }).length,
            ...(promptSemantico === undefined ? {} : { caracteresPromptSemantico: promptSemantico.length })
        },
        porPI: contextos.map(c => {
            const alcancados = new Set(
                c.decisoes.admissiveis.flatMap(d => (c.valores.porDecisao[d] ?? c.valores.gerais).map(v => `${v.valor} ${v.unidade}`))
            );
            return {
                ordem: c.pi!.ordem,
                item: c.pi!.item,
                conduta: c.pi!.conduta,
                regras: c.regras.length,
                fatos: c.fatos.length,
                regrasRelacionais: c.regrasRelacionais.length,
                evidencias: c.evidencias.length + evidenciasDosFatos(c.fatos).length,
                decisoesAdmissiveis: c.decisoes.admissiveis.length,
                valoresAdmissiveis: alcancados.size,
                telemetria: Object.keys(c.telemetriaRelevante).length,
                caracteresContexto: JSON.stringify(c).length,
                caracteresPrompt: montarPromptPI(c).length
            };
        })
    };
}
