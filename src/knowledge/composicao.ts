/**
 * Composicao — dos `ResultadoPI[]` validados ao artefato completo.
 *
 *     PIPlanejado[] (ordem do Planner) + ResultadoPI[] -> montarArtefato -> artefato
 *
 * NAO E UM SEGUNDO COMPOSITOR. O artefato e montado por `montarArtefato`
 * (contrato.ts), o mesmo do incremental, com o mesmo gabarito: cabecalho com
 * identificador, contexto, esquema, sujeito e `sequencia`, as clausulas, e a
 * `auditoria`. A clausula de cada PI e escrita por `textoDaClausula`, o mesmo
 * texto que o PI Agent produziu depois do cabecalho do PI.
 *
 * A ORDEM E A DO PLANNER. A clausula i e o resultado do PI de ordem i; nada e
 * reordenado por item, conduta, nome ou decisao. A `sequencia` do cabecalho
 * lista as condutas na ordem em que aparecem pela primeira vez — como no
 * incremental, uma conduta cumprida por dois itens aparece uma vez (o contrato
 * compara conjuntos: `verificarArtefato`).
 *
 * A IDENTIDADE E DA COMPOSICAO. O PI Agent nao escreve identificador,
 * cabecalho nem auditoria. O identificador e deterministico (artefato, execucao
 * e ciclo), o contexto e o primeiro em foco (o mesmo criterio do incremental),
 * e nao ha alerta: nenhum agente o produziu, e a composicao nao inventa.
 *
 * NADA E ALTERADO. Item, conduta, decisao, meio, valor e justificativa vao como
 * vieram. O artefato montado e RELIDO (`lerArtefato`) e cada clausula conferida
 * campo a campo com o seu resultado: qualquer diferenca — ou um resultado que
 * nao responde ao seu PI — e `InconsistenciaComposicao`, defeito interno, sem
 * correcao.
 */

import {
    lerArtefato,
    montarArtefato,
    type ArtefatoLido,
    type ContratoArtefato
} from './contrato.js';
import {
    comoClausulaLida,
    textoDaClausula,
    validarResultadoPI,
    type PIPlanejado,
    type ResultadoPI
} from './contrato-pi.js';
import { comoDadoPuro } from './decompositor.js';
import { naoResolvido, valido, type ResultadoValidacao } from './validacao.js';

/** O artefato composto e de onde ele veio. Dado puro e congelado. */
export interface PlanoComposto {
    /** O artefato, como `montarArtefato` o escreveu. */
    texto: string;
    identificador: string;
    /** O contexto do cabecalho (protocolo | cultura | lance). */
    contexto: string;
    /** As condutas do cabecalho, na ordem do Planner, sem repeticao. */
    sequencia: string[];
    /** O texto de cada clausula, na ordem do Planner. */
    clausulas: string[];
    /** A sequencia validada que o plano cumpre. */
    pis: PIPlanejado[];
    /** Os resultados, um por PI, na ordem do Planner. */
    resultados: ResultadoPI[];
    /** A releitura do artefato — a mesma que o contrato julga. */
    lido: ArtefatoLido;
}

/** Defeito interno: os resultados nao se deixam compor, ou o artefato nao e o que os resultados dizem. */
export class InconsistenciaComposicao extends Error {
    constructor(mensagem: string) {
        super(mensagem);
        this.name = 'InconsistenciaComposicao';
    }
}

export interface OpcoesComposicao {
    requestId: string;
    /** Ciclo global que produziu os resultados (a partir de 1). */
    ciclo: number;
}

/** Identificador da gramatica (`[A-Za-z_][A-Za-z_0-9]*`), a partir do artefato, da execucao e do ciclo. */
export function identificadorDoPlano(artefato: string, requestId: string, ciclo: number): string {
    return `${artefato}_${requestId}_c${ciclo}`.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Compoe o artefato na ordem do Planner.
 *
 * VALID com o plano; UNRESOLVED quando o conhecimento nao tem contexto em foco
 * para o cabecalho (sem ele, o artefato nao e exprimivel). Lanca
 * `InconsistenciaComposicao` quando os resultados nao correspondem a sequencia
 * ou a releitura do artefato nao devolve exatamente os resultados.
 */
export function comporPlano(
    pis: readonly PIPlanejado[],
    resultados: readonly ResultadoPI[],
    contrato: ContratoArtefato,
    opcoes: OpcoesComposicao
): ResultadoValidacao<PlanoComposto, 'conhecimento_insuficiente'> {
    const falha = (m: string): InconsistenciaComposicao => new InconsistenciaComposicao(`composicao: ${m}`);
    if (pis.length === 0) throw falha('sequencia vazia');
    if (resultados.length !== pis.length) {
        throw falha(`${resultados.length} resultado(s) para ${pis.length} PI(s)`);
    }
    for (const [i, pi] of pis.entries()) {
        if (pi.ordem !== i + 1) throw falha(`o PI na posicao ${i + 1} tem ordem ${pi.ordem}`);
        const r = resultados[i];
        const forma = validarResultadoPI(r, pi);
        if (forma.veredito !== 'VALID') {
            throw falha(`o resultado na posicao ${i + 1} nao responde ao PI ${pi.ordem} (${pi.item}, ${pi.conduta}): ` +
                forma.erros.map(e => e.mensagem).join('; '));
        }
    }

    const contexto = contrato.contextos[0];
    if (!contexto) {
        return naoResolvido(['contexto (protocolo/cultura/lance) em foco para o cabecalho do artefato'], {
            avisos: [{ codigo: 'conhecimento_insuficiente', mensagem: 'o foco nao deixou contexto algum: o cabecalho do artefato nao e exprimivel' }]
        });
    }

    const papeis = contrato.papeis;
    const identificador = identificadorDoPlano(papeis.artefato, opcoes.requestId, opcoes.ciclo);
    const sequencia = [...new Set(pis.map(p => p.conduta))];
    const clausulas = resultados.map(r => textoDaClausula(r, papeis));
    const auditoria =
        `artefato composto de ${pis.length} PI(s) validado(s) individualmente, na ordem do Planner ` +
        `(execucao ${opcoes.requestId}, ciclo ${opcoes.ciclo})`;
    const texto = montarArtefato(
        contrato,
        identificador,
        contexto,
        { sequencia, clausulas: resultados.map((r, i) => comoClausulaLida(r, i)) },
        clausulas,
        [],
        auditoria
    );

    // A releitura tem de devolver exatamente o que foi composto.
    const lido = lerArtefato(texto, papeis);
    if (lido.identificador !== identificador || lido.contexto !== contexto) {
        throw falha(`o cabecalho relido (${lido.identificador} para ${lido.contexto}) nao e o composto (${identificador} para ${contexto})`);
    }
    if (contrato.sujeito && lido.sujeito !== contrato.sujeito) {
        throw falha(`o sujeito relido (${lido.sujeito}) nao e o do cenario (${contrato.sujeito})`);
    }
    if (JSON.stringify(lido.sequencia) !== JSON.stringify(sequencia)) {
        throw falha(`a sequencia relida [${lido.sequencia.join(', ')}] nao e a composta [${sequencia.join(', ')}]`);
    }
    if (lido.clausulas.length !== resultados.length) {
        throw falha(`${lido.clausulas.length} clausula(s) relida(s) para ${resultados.length} resultado(s)`);
    }
    for (const [i, r] of resultados.entries()) {
        const esperada = comoClausulaLida(r, i);
        const relida = lido.clausulas[i];
        const campos = (['item', 'decisao', 'valor', 'unidade', 'meio', 'justificativa'] as const).filter(c => relida[c] !== esperada[c]);
        if (campos.length > 0) {
            throw falha(`a clausula ${i + 1} relida difere do resultado do PI ${r.ordem} em ${campos.join(', ')}`);
        }
    }

    return valido(comoDadoPuro({ texto, identificador, contexto, sequencia, clausulas, pis: [...pis], resultados: [...resultados], lido }));
}
