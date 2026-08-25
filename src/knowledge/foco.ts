/**
 * Nucleo da recuperacao do subgrafo em foco (etapa 2 da Figura 5.1).
 *
 * Este modulo e AGNOSTICO DE DOMINIO por construcao: nao conhece produto,
 * farmaco nem infracao, nao carrega lista de palavras de dominio nenhum e nao
 * tem constante calibrada para um modelo especifico. Tudo o que ele sabe, ele le
 * do modelo carregado — os nomes dos nos — e do indice vetorial do Neo4j.
 * Acrescentar um quarto dominio nao exige tocar em nada aqui.
 *
 * O que ele decide, dado o texto digitado pelo usuario:
 *
 *   1. QUAIS NOS o pedido alcanca, por similaridade de cosseno contra o indice
 *      vetorial (o documento de cada no e montado em `documentos.ts`, a partir
 *      da gramatica de cada dominio).
 *   2. QUANTOS deles sobrevivem, por um corte RELATIVO ao melhor candidato — ver
 *      `selecionarPorSimilaridade` e a nota sobre a compressao dos cossenos.
 *   3. DE QUE LADO partir, quando o pedido nao nomeia nada: do indice que se
 *      compromete mais com a propria resposta (`ladoMaisDecidido`).
 *
 * A expansao pelas arestas — achou o item, traz o contexto dele e vice-versa —
 * fica em cada `graphrag-*.ts`, que e quem conhece a forma do proprio grafo.
 *
 * O foco decide apenas O QUE E MOSTRADO no Prompt Semantico. Quem decide o que e
 * PERMITIDO continua sendo a comparacao numerica deterministica em
 * `retrieve*Constraints` — o embedding nunca ganha autoridade sobre a seguranca.
 */

import neo4j, { type Session } from 'neo4j-driver';

// =============================================================================
// 1) Normalizacao textual
// =============================================================================

/**
 * Minusculas, sem acento e com separadores reduzidos a espaco. O usuario digita
 * acentuado e com pontuacao; os nos tem nome em ID de gramatica, com underscore.
 * Sem passar os dois pela mesma normalizacao, nenhuma comparacao textual entre
 * eles e possivel.
 */
export function normalizar(texto: string): string {
    return texto
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/**
 * Tamanho minimo para um token do nome contar como distintivo.
 *
 * O criterio e ESTRUTURAL, nao um vocabulario: abaixo deste tamanho ficam os
 * artigos e preposicoes que costuram nomes compostos (`X_de_Y`, `X_Na_Y`) e as
 * iniciais soltas. Nenhuma palavra de nenhum dominio precisa ser listada — e por
 * isso que este arquivo nao muda quando entra um dominio novo.
 */
const MIN_TOKEN_DISTINTIVO = 4;

/** Tokens do nome de um no, ja normalizados. */
export function tokensDoNome(nome: string): string[] {
    return normalizar(nome)
        .split(' ')
        .filter(t => t.length > 0);
}

/**
 * Variantes de escrita do nome, para entrar no documento que vai ao indice
 * vetorial. Um ID de gramatica com underscore tokeniza mal no embedder;
 * acompanhado da forma com espacos, ele embute como o texto que o usuario de
 * fato digita.
 */
export function variantesDoNome(nome: string): string {
    const legivel = nome.replace(/_/g, ' ');
    return legivel === nome ? nome : `${nome} (${legivel})`;
}

// =============================================================================
// 2) Casamento por nome
// =============================================================================

function contemPalavra(textoNormalizado: string, palavra: string): boolean {
    // Fronteira de palavra sobre o texto ja normalizado, para um nome curto nao
    // casar por acidente dentro de uma palavra maior.
    return new RegExp(`(^| )${palavra}( |$)`).test(textoNormalizado);
}

/**
 * Nos cujo nome o usuario escreveu por extenso.
 *
 * Exige o nome INTEIRO — a forma com espacos, ou todos os seus tokens
 * distintivos espalhados pela frase. Um unico token de um nome composto nao
 * basta: seria a porta por onde uma palavra corrente do dominio ancoraria o foco
 * no no errado, e fechar essa porta com uma lista de excecoes e justamente o que
 * tornaria este modulo dependente do dominio.
 *
 * O caso que fica de fora — o usuario cita um nome composto pela metade — nao se
 * perde: quem o resolve e o indice vetorial, e resolve bem, porque o documento
 * do no carrega o nome, o alvo e a vizinhanca no grafo. O casamento por nome
 * existe so para quando nao ha duvida nenhuma a resolver.
 */
export function casamentoLexical(intencao: string, nomes: string[]): Set<string> {
    const texto = normalizar(intencao);
    const casados = new Set<string>();

    for (const nome of nomes) {
        const tokens = tokensDoNome(nome);
        if (tokens.length === 0) continue;

        // Nome feito so de tokens curtos (uma sigla, por exemplo): ai os curtos
        // sao a unica evidencia que existe e passam a valer.
        const distintivos = tokens.filter(t => t.length >= MIN_TOKEN_DISTINTIVO);
        const exigidos = distintivos.length > 0 ? distintivos : tokens;

        if (contemPalavra(texto, tokens.join(' ')) || exigidos.every(t => contemPalavra(texto, t))) {
            casados.add(nome);
        }
    }

    return casados;
}

// =============================================================================
// 3) Recuperacao vetorial
// =============================================================================

export interface ItemPontuado {
    nome: string;
    /** Cosseno bruto em [-1, 1], ja desfeita a normalizacao do Neo4j. */
    cosseno: number;
}

/**
 * O indice vetorial do Neo4j com similaridade `cosine` NAO devolve o cosseno:
 * devolve (1 + cos) / 2, remapeado para [0, 1]. Comparar esse escore contra um
 * limiar pensado em cosseno bruto aprova todo mundo — nessa escala nada cai
 * abaixo de ~0.65.
 */
export function escoreParaCosseno(escore: number): number {
    return 2 * escore - 1;
}

export async function topKPorVetor(
    session: Session,
    indice: string,
    vetor: number[],
    topK: number
): Promise<ItemPontuado[]> {
    const resultado = await session.run(
        `CALL db.index.vector.queryNodes($indice, $topK, $vetor) YIELD node, score
         RETURN node.nome AS nome, score`,
        { indice, topK: neo4j.int(Math.max(1, topK)), vetor }
    );
    return resultado.records.map(r => ({
        nome: r.get('nome') as string,
        cosseno: escoreParaCosseno(r.get('score') as number)
    }));
}

function num(bruto: string | undefined, padrao: number): number {
    const valor = Number(bruto);
    return Number.isFinite(valor) ? valor : padrao;
}

/**
 * Piso absoluto de cosseno. Serve so para o caso degenerado em que NADA no grafo
 * tem relacao com o pedido; a discriminacao util e feita pela margem relativa.
 */
const COS_MINIMO = num(process.env.SPC_CML_FOCO_COS_MINIMO, 0.3);

/**
 * Distancia maxima, em cosseno, entre um candidato e o melhor deles.
 *
 * Esta constante descreve o EMBEDDER, nao os modelos: com o bge-m3 os cossenos
 * de textos curtos vivem comprimidos numa faixa estreita, e o que separa
 * relevante de irrelevante e a posicao relativa, nao o valor absoluto. Medido
 * nos grafos deste repositorio, o primeiro colocado correto abre de 0.06 a 0.09
 * sobre o primeiro incorreto, enquanto empates legitimos ficam abaixo de 0.02 —
 * 0.05 separa os dois regimes.
 *
 * Trocar de embedder muda o regime: ajuste por SPC_CML_FOCO_MARGEM e confira com
 * `npm run foco:inspecionar -- <dominio> "<pedido>" --todos`, que imprime o
 * cosseno e a margem de cada no.
 */
const MARGEM_COS = num(process.env.SPC_CML_FOCO_MARGEM, 0.05);

/** Teto de nos vindos do sinal vetorial, para o foco nao virar o grafo inteiro. */
const MAX_FOCO_VETORIAL = num(process.env.SPC_CML_FOCO_MAX, 4);

/** Teto de vizinhos pedidos ao indice, para grafos grandes. */
const TOP_K_MAX = num(process.env.SPC_CML_FOCO_TOPK_MAX, 10);

/**
 * Quantos vizinhos pedir ao indice. Pedir mais do que o grafo tem devolve o
 * grafo inteiro e transforma o topK num filtro que nao filtra; quem decide aqui
 * e o corte por margem, e ao topK basta nao cortar antes da hora.
 */
export function topKParaGrafo(totalDeNos: number): number {
    return Math.max(1, Math.min(totalDeNos, TOP_K_MAX));
}

export interface SelecaoVetorial {
    nomes: Set<string>;
    /** Primeiro colocado, ou `undefined` num indice vazio. */
    melhor?: string;
    /**
     * Distancia em cosseno entre o primeiro e o segundo colocado: o quanto o
     * indice se compromete com a propria resposta. Uma margem proxima de zero
     * diz que ele praticamente sorteou o vencedor.
     */
    margem: number;
}

/**
 * Mantem quem esta a menos de `MARGEM_COS` do melhor candidato. Sem ninguem
 * acima do piso absoluto, mantem so o melhor: um foco impreciso ainda e melhor
 * que um Prompt Semantico vazio.
 */
export function selecionarPorSimilaridade(itens: ItemPontuado[]): SelecaoVetorial {
    if (itens.length === 0) return { nomes: new Set(), margem: 0 };

    const ordenados = [...itens].sort((a, b) => b.cosseno - a.cosseno);
    const melhor = ordenados[0].cosseno;
    const margem = ordenados.length > 1 ? melhor - ordenados[1].cosseno : melhor;

    const relevantes = ordenados.filter(
        i => i.cosseno >= COS_MINIMO && melhor - i.cosseno <= MARGEM_COS
    );
    const escolhidos = relevantes.length > 0 ? relevantes : ordenados.slice(0, 1);

    return {
        nomes: new Set(escolhidos.slice(0, MAX_FOCO_VETORIAL).map(i => i.nome)),
        melhor: ordenados[0].nome,
        margem
    };
}

// =============================================================================
// 4) Composicao dos sinais
// =============================================================================

/**
 * De que lado semear o foco quando o pedido nao nomeia nada.
 *
 * Cada dominio tem duas familias de no: os ITENS, que o plano cita (o que se
 * aplica, se prescreve, se marca), e os CONTEXTOS, que os agrupam e restringem.
 * Cada familia tem seu indice, e nem sempre as duas sabem responder.
 *
 * Semear os dois lados pelo vetor reconstroi o grafo inteiro: cada contexto
 * arrasta todos os itens dele, e bastam dois contextos empatados para nao sobrar
 * nada de fora. Semear um lado so, e deixar o outro vir pelas ARESTAS, mantem o
 * subgrafo coeso — uma aresta do modelo e um fato, enquanto alguns centesimos de
 * cosseno a mais sao ruido.
 *
 * O lado escolhido e aquele em que o indice hesita menos, e a margem entre o
 * primeiro e o segundo colocado e exatamente a medida dessa hesitacao.
 */
export function ladoMaisDecidido(
    itens: SelecaoVetorial,
    contexto: SelecaoVetorial
): 'itens' | 'contexto' {
    return contexto.margem > itens.margem ? 'contexto' : 'itens';
}

/**
 * Monta o documento de um no para o indice vetorial. Descarta partes vazias e
 * junta o resto em frases curtas — o formato que o embedder aproveita melhor que
 * uma lista de campos soltos.
 */
export function montarDocumento(partes: (string | undefined | null)[]): string {
    return partes
        .map(p => (p ?? '').trim().replace(/\.\s*$/, ''))
        .filter(p => p.length > 0)
        .join('. ');
}

/** Remove repeticoes preservando a ordem de insercao. */
export function dedup<T>(itens: T[], chave: (item: T) => string): T[] {
    const vistos = new Set<string>();
    return itens.filter(item => {
        const k = chave(item);
        if (vistos.has(k)) return false;
        vistos.add(k);
        return true;
    });
}
