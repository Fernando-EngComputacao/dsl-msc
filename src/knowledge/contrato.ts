/**
 * Contrato do artefato — a camada que a gramatica livre de contexto nao alcanca.
 *
 * A especializacao por item (ver `politica.ts` e a fase de especializacao em
 * `python_engine/grammar_from_kg.py`) torna inexprimivel tudo o que depende de
 * UMA clausula isolada: item errado, decisao inadmissivel para aquele item, meio
 * fora da lista, valor fora do reticulo. O que sobra sao propriedades do
 * artefato INTEIRO, e essas nenhuma CFG expressa sem explodir:
 *
 *   - o mesmo item aparecer duas vezes com decisoes que se cancelam
 *     (INICIAR_INFUSAO seguido de AUMENTAR_VAZAO para o mesmo farmaco);
 *   - a `sequencia` declarada no cabecalho nao corresponder as clausulas
 *     emitidas;
 *   - um escalonamento que o grafo disparou nao virar clausula nenhuma;
 *   - o identificador do sujeito nao ser o do cenario.
 *
 * Por isso o contrato e verificado CLAUSULA A CLAUSULA, na ordem em que foram
 * geradas, e a primeira violacao devolve um `reparo`: o par (item, decisao) que
 * deve sair da politica antes da proxima tentativa. A gramatica da tentativa
 * seguinte e estritamente menor que a da anterior — a verificacao semantica
 * realimenta a poda, em vez de so reprovar no fim.
 *
 * O modulo continua agnostico de dominio: tudo que ele sabe vem de
 * `PapeisDominio` e das politicas, nunca de um nome de farmaco, produto ou
 * infracao.
 */

import type { PapeisDominio, PoliticaItem, SubgrafoPodado } from './politica.js';

// =============================================================================
// 1) Contrato
// =============================================================================

export interface ContratoArtefato {
    papeis: PapeisDominio;
    politicas: Map<string, PoliticaItem>;
    /** Identificador do cenario (paciente/talhao/partida), sem aspas. */
    sujeito?: string;
    /** Contextos que o foco deixou em pe (protocolo/cultura/lance). */
    contextos: string[];
    /** decisao -> conduta do esquema_dados; o cabecalho lista condutas, as
     *  clausulas listam decisoes, e o contrato precisa ligar as duas. */
    condutaPorDecisao: Record<string, string>;
    /** Escalonamentos disparados pelo grafo (so a contagem importa aqui). */
    escalonamentos: string[];
    /** No maximo uma clausula por item. */
    unicidade: boolean;
}

export function montarContrato(
    subgrafo: SubgrafoPodado,
    condutaPorDecisao: Record<string, string>,
    escalonamentos: string[]
): ContratoArtefato {
    return {
        papeis: subgrafo.papeis,
        politicas: new Map(subgrafo.politicas.map(p => [p.item, p])),
        sujeito: subgrafo.constantes.sujeito,
        contextos: subgrafo.constantes.contextos,
        condutaPorDecisao,
        escalonamentos,
        unicidade: true
    };
}

// =============================================================================
// 2) Leitura do artefato gerado
// =============================================================================

export interface ClausulaLida {
    indice: number;
    item: string;
    decisao: string;
    valor: string;
    unidade: string;
    meio: string;
    justificativa: string;
}

export interface ArtefatoLido {
    identificador?: string;
    contexto?: string;
    sujeito?: string;
    sequencia: string[];
    clausulas: ClausulaLida[];
}

function escapar(texto: string): string {
    return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Le o artefato pelos papeis, nao por um formato fixo. O texto gerado ja passou
 * pelo parser de Ĝ no motor; aqui basta extrair os campos que o contrato julga.
 */
export function lerArtefato(texto: string, papeis: PapeisDominio): ArtefatoLido {
    const p = {
        artefato: escapar(papeis.artefato),
        clausula: escapar(papeis.clausula),
        decisao: escapar(papeis.decisao),
        quantidade: escapar(papeis.campoQuantidade),
        meio: escapar(papeis.meio),
        sujeito: escapar(papeis.campoSujeito)
    };

    const cabecalho = new RegExp(`\\b${p.artefato}\\s+(\\S+)\\s+para\\s+(\\S+)`).exec(texto);
    const sujeito = new RegExp(`\\b${p.sujeito}\\s+'([^']*)'`).exec(texto);
    const sequencia = /\bsequencia\s*\[([^\]]*)\]/.exec(texto);

    const clausulaRe = new RegExp(
        `\\b${p.clausula}\\s+(\\S+)\\s+${p.decisao}\\s+(\\S+)\\s+${p.quantidade}\\s+` +
            `(\\S+)\\s+(\\S+)\\s+${p.meio}\\s+(\\S+)\\s+justificativa\\s+'([^']*)'`,
        'g'
    );

    const clausulas: ClausulaLida[] = [];
    for (let m = clausulaRe.exec(texto); m !== null; m = clausulaRe.exec(texto)) {
        clausulas.push({
            indice: clausulas.length,
            item: m[1],
            decisao: m[2],
            valor: m[3],
            unidade: m[4],
            meio: m[5],
            justificativa: m[6]
        });
    }

    return {
        identificador: cabecalho?.[1],
        contexto: cabecalho?.[2],
        sujeito: sujeito?.[1],
        sequencia: (sequencia?.[1] ?? '')
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0),
        clausulas
    };
}

// =============================================================================
// 3) Verificacao
// =============================================================================

export type TipoViolacao =
    | 'item_fora_da_poda'
    | 'decisao_inadmissivel'
    | 'meio_inadmissivel'
    | 'valor_inadmissivel'
    | 'item_repetido'
    | 'sujeito_incorreto'
    | 'contexto_fora_do_foco'
    | 'sequencia_incoerente'
    | 'escalonamento_ignorado'
    | 'artefato_vazio';

export interface Violacao {
    /** Indice da clausula, ou `null` quando a violacao e do artefato inteiro. */
    clausula: number | null;
    tipo: TipoViolacao;
    mensagem: string;
    /** O que retirar da politica antes da proxima tentativa, quando aplicavel. */
    reparo?: { item: string; decisao?: string };
}

/**
 * Verificacao incremental: percorre as clausulas na ordem de geracao e para na
 * primeira que viola o contrato. Parar na primeira e deliberado — as clausulas
 * seguintes foram escritas sob uma premissa que ja caiu, e reprova-las em bloco
 * so poluiria o reparo.
 */
export function verificarClausulas(
    contrato: ContratoArtefato,
    clausulas: ClausulaLida[]
): Violacao[] {
    const vistos = new Set<string>();

    for (const c of clausulas) {
        const politica = contrato.politicas.get(c.item);

        if (!politica) {
            return [{
                clausula: c.indice,
                tipo: 'item_fora_da_poda',
                mensagem: `"${c.item}" nao esta entre os itens que o grafo liberou neste contexto`,
                reparo: { item: c.item }
            }];
        }

        if (!politica.decisoes.includes(c.decisao)) {
            return [{
                clausula: c.indice,
                tipo: 'decisao_inadmissivel',
                mensagem:
                    `${c.decisao} nao e admissivel para ${c.item} neste contexto` +
                    (politica.motivos.length > 0 ? ` (${politica.motivos.join('; ')})` : '') +
                    `. Admissiveis: ${politica.decisoes.join(', ')}`,
                reparo: { item: c.item, decisao: c.decisao }
            }];
        }

        if (politica.meios.length > 0 && !politica.meios.includes(c.meio)) {
            return [{
                clausula: c.indice,
                tipo: 'meio_inadmissivel',
                mensagem: `${c.meio} nao esta entre os meios de ${c.item}: ${politica.meios.join(', ')}`,
                reparo: { item: c.item }
            }];
        }

        // O mapa por decisao e mais estrito que a uniao: com ele, o degrau de
        // titulacao vale para AUMENTAR e zero vale para MANTER_BLOQUEADO.
        const admissiveis = politica.valoresPorDecisao?.[c.decisao] ?? politica.valores;
        if (admissiveis.length > 0) {
            const admissivel = admissiveis.some(
                v => v.valor === c.valor && v.unidade === c.unidade
            );
            if (!admissivel) {
                return [{
                    clausula: c.indice,
                    tipo: 'valor_inadmissivel',
                    mensagem:
                        `${c.valor} ${c.unidade} esta fora do que o modelo declara para ` +
                        `${c.item} com ${c.decisao}: ` +
                        admissiveis.map(v => `${v.valor} ${v.unidade}`).join(', '),
                    reparo: { item: c.item }
                }];
            }
        }

        if (contrato.unicidade && vistos.has(c.item)) {
            return [{
                clausula: c.indice,
                tipo: 'item_repetido',
                mensagem: `${c.item} ja recebeu uma decisao neste artefato: duas ordens para o mesmo item se cancelam`,
                reparo: { item: c.item }
            }];
        }
        vistos.add(c.item);
    }

    return [];
}

/** Propriedades do artefato inteiro — avaliadas so depois das clausulas. */
export function verificarArtefato(contrato: ContratoArtefato, lido: ArtefatoLido): Violacao[] {
    const violacoes: Violacao[] = [];

    if (lido.clausulas.length === 0) {
        violacoes.push({
            clausula: null,
            tipo: 'artefato_vazio',
            mensagem: `nenhuma clausula "${contrato.papeis.clausula}" foi emitida`
        });
    }

    if (contrato.sujeito && lido.sujeito && lido.sujeito !== contrato.sujeito) {
        violacoes.push({
            clausula: null,
            tipo: 'sujeito_incorreto',
            mensagem: `${contrato.papeis.campoSujeito} '${lido.sujeito}' nao e o do cenario ('${contrato.sujeito}')`
        });
    }

    if (contrato.contextos.length > 0 && lido.contexto && !contrato.contextos.includes(lido.contexto)) {
        violacoes.push({
            clausula: null,
            tipo: 'contexto_fora_do_foco',
            mensagem: `${lido.contexto} nao esta entre os contextos recuperados: ${contrato.contextos.join(', ')}`
        });
    }

    // sequencia <-> clausulas: cada conduta declarada precisa de uma clausula com
    // a decisao que o esquema_dados associa a ela, e vice-versa. Sem o mapa do
    // esquema (chamador que nao passou o modelo) a checagem nao roda: acusar
    // incoerencia sem saber a correspondencia seria inventar violacao.
    if (Object.keys(contrato.condutaPorDecisao).length === 0) return violacoes;

    const condutasDasClausulas = new Set(
        lido.clausulas
            .map(c => contrato.condutaPorDecisao[c.decisao])
            .filter((c): c is string => Boolean(c))
    );
    const declaradas = new Set(lido.sequencia);

    const semClausula = [...declaradas].filter(c => !condutasDasClausulas.has(c));
    const semDeclaracao = [...condutasDasClausulas].filter(c => !declaradas.has(c));

    if (semClausula.length > 0 || semDeclaracao.length > 0) {
        const partes: string[] = [];
        if (semClausula.length > 0) partes.push(`declaradas na sequencia sem clausula: ${semClausula.join(', ')}`);
        if (semDeclaracao.length > 0) partes.push(`clausulas fora da sequencia: ${semDeclaracao.join(', ')}`);
        violacoes.push({
            clausula: null,
            tipo: 'sequencia_incoerente',
            mensagem: partes.join(' | ')
        });
    }

    const escalonar = contrato.papeis.decisaoDeEscalonamento;
    if (escalonar && contrato.escalonamentos.length > 0) {
        const cobriu = lido.clausulas.some(c => c.decisao === escalonar);
        if (!cobriu) {
            violacoes.push({
                clausula: null,
                tipo: 'escalonamento_ignorado',
                mensagem:
                    `o grafo disparou ${contrato.escalonamentos.length} escalonamento(s) ` +
                    `(${contrato.escalonamentos.join('; ')}) e nenhuma clausula usa ${escalonar}`
            });
        }
    }

    return violacoes;
}

export interface VereditoContrato {
    lido: ArtefatoLido;
    violacoes: Violacao[];
    conforme: boolean;
}

export function verificarContrato(contrato: ContratoArtefato, texto: string): VereditoContrato {
    const lido = lerArtefato(texto, contrato.papeis);
    const violacoes = [
        ...verificarClausulas(contrato, lido.clausulas),
        ...verificarArtefato(contrato, lido)
    ];
    return { lido, violacoes, conforme: violacoes.length === 0 };
}

// =============================================================================
// 4) Realimentacao da poda
// =============================================================================

/**
 * Devolve um subgrafo ESTRITAMENTE MENOR, sem o que a tentativa anterior violou.
 * Um reparo com decisao retira so aquele par; sem decisao, retira o item todo.
 * Politica que ficou sem decisao alguma sai do payload — e o item deixa de ser
 * citavel na proxima gramatica.
 */
export function podarPorViolacoes(
    subgrafo: SubgrafoPodado,
    violacoes: Violacao[]
): SubgrafoPodado {
    const politicas = subgrafo.politicas
        .map(p => {
            const meus = violacoes.filter(v => v.reparo?.item === p.item);
            if (meus.length === 0) return p;
            if (meus.some(v => v.reparo && v.reparo.decisao === undefined)) {
                return { ...p, decisoes: [] };
            }
            const proibidas = new Set(meus.map(v => v.reparo!.decisao!));
            return { ...p, decisoes: p.decisoes.filter(d => !proibidas.has(d)) };
        })
        .filter(p => p.decisoes.length > 0);

    const acoes = new Set<string>();
    const meios = new Set<string>();
    for (const p of politicas) {
        for (const d of p.decisoes) acoes.add(d);
        for (const m of p.meios) meios.add(m);
    }

    return {
        ...subgrafo,
        politicas,
        acoes_permitidas: [...acoes],
        farmacos_liberados: politicas.map(p => p.item),
        vias_disponiveis: [...meios]
    };
}

/** Bloco legivel das violacoes, para reentrar no prompt da proxima tentativa. */
export function relatorioDeViolacoes(violacoes: Violacao[]): string {
    if (violacoes.length === 0) return '';
    const linhas = ['[A TENTATIVA ANTERIOR FOI REJEITADA PELO CONTRATO]'];
    for (const v of violacoes) {
        const onde = v.clausula === null ? 'artefato' : `clausula ${v.clausula + 1}`;
        linhas.push(`- ${onde}: ${v.mensagem}`);
    }
    return linhas.join('\n');
}
