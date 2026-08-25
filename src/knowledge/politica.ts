/**
 * Vocabulario COMUM aos tres dominios para a especializacao da gramatica.
 *
 * Ate aqui a poda viajava para o motor como tres listas planas — acoes, itens e
 * meios permitidos — e o motor podava tres vocabularios INDEPENDENTES sobre uma
 * regra que e um produto cartesiano:
 *
 *     ordem ::= "ordem" farmaco "decisao" decisao "dose" quantidade "via" via ...
 *
 * O efeito e que basta um item admitir INICIAR_INFUSAO para que TODOS a admitam.
 * A politica por item — que `retrieve*Constraints` ja calcula e guarda em
 * `politicas` — era achatada e perdida exatamente no ponto em que decidia algo.
 *
 * Este modulo carrega essa politica intacta ate o motor, junto com duas coisas
 * que nunca chegavam la:
 *
 *   - os VALORES admissiveis de cada item (o reticulo de dose/vazao/minuto
 *     derivado do proprio modelo), para o numero deixar de ser folha livre;
 *   - as CONSTANTES do cenario (sujeito e contextos em foco), que sao dado e nao
 *     decisao — e por isso viram literal na gramatica, nao slot a preencher.
 *
 * Nada aqui conhece farmaco, produto ou infracao: o modulo fala em PAPEIS
 * (item, decisao, meio, quantidade, sujeito, contexto), e cada dominio declara
 * como nomeia os seus em `PAPEIS_MED` / `PAPEIS_AGRO` / `PAPEIS_FUT`. Um quarto
 * dominio entra declarando os papeis dele, como ja acontece no MAPA_PODA do
 * motor Python.
 */

/** Um par valor+unidade admissivel para o campo quantitativo de uma clausula. */
export interface ValorAdmissivel {
    valor: string;
    unidade: string;
}

/**
 * Politica de saida de UM item, no formato que atravessa o fio.
 * Espelha `DrugPolicy` / `ProductPolicy` / `InfractionPolicy` sem o nome de
 * dominio no campo-chave.
 */
export interface PoliticaItem {
    item: string;
    decisoes: string[];
    meios: string[];
    unidades: string[];
    /** Vazio significa "o modelo nao declara limite": o numero segue livre. */
    valores: ValorAdmissivel[];
    /**
     * Valores por DECISAO, quando o modelo permite ser mais preciso que a uniao
     * acima: o degrau de titulacao vale para AUMENTAR/REDUZIR, a dose inicial
     * para INICIAR, e zero para toda decisao que nao movimenta a bomba. E o que
     * torna inexprimivel um "AUMENTAR_VAZAO dose 0.4" quando o modelo declara
     * `titulacao 0.05` — antes, so o limite superior do farmaco era checado.
     */
    valoresPorDecisao?: Record<string, ValorAdmissivel[]>;
    bloqueado: boolean;
    motivos: string[];
}

/**
 * Como cada DSL nomeia os papeis da gramatica de saida. Sao os nomes das regras
 * da BNF exportada (src/cli/export-bnf*.ts) mais os literais que introduzem os
 * campos dentro da clausula e do cabecalho do artefato.
 */
export interface PapeisDominio {
    /** Simbolo inicial: plano | missao | arbitragem. */
    artefato: string;
    /** Regra repetida dentro do artefato: ordem | aplicacao | marcacao. */
    clausula: string;
    /** Vocabulario do que se decide sobre: farmaco | produto | infracao. */
    item: string;
    /** Vocabulario da decisao — `decisao` nos tres dominios, mas nao presumido. */
    decisao: string;
    /** Vocabulario do meio: via | modo | reinicio. */
    meio: string;
    /** Regra da quantidade (tipicamente `quantidade ::= numero unidade`). */
    quantidade: string;
    /** Literal que introduz a quantidade na clausula: dose | vazao | minuto. */
    campoQuantidade: string;
    /** Literal que introduz o sujeito no cabecalho: paciente | talhao | partida. */
    campoSujeito: string;
    /** Vocabulario do contexto do artefato: protocolo | cultura | lance. */
    contexto: string;
    /** Vocabulario das condutas listadas na `sequencia` do cabecalho. */
    conduta: string;
    /** Decisoes que aumentam a exposicao — usadas pelo contrato. */
    decisoesDeIncremento: string[];
    /** Decisao que materializa um escalonamento disparado, se o dominio tiver uma. */
    decisaoDeEscalonamento?: string;
    /**
     * Decisoes que PRESSUPOEM que o item ainda nao esta em curso (iniciar) e
     * decisoes que pressupoem que ele JA esta (titular, reduzir, suspender).
     *
     * O contexto ja informa o que esta em curso — `farmacosEmUso`,
     * `produtosEmUso`, `infracoesEmUso` — e essa informacao nunca chegava a
     * gramatica: dai "INICIAR_INFUSAO Noradrenalina" num paciente cuja
     * noradrenalina ja estava correndo. Dominio em que o item nao tem estado de
     * curso (uma infracao nao "esta em andamento") simplesmente nao declara
     * nenhuma das duas listas.
     */
    decisoesQueIniciam?: string[];
    decisoesQueContinuam?: string[];
}

/** Constantes do cenario: valores DADOS, que a geracao nao deve escolher. */
export interface ConstantesCenario {
    /** Identificador do paciente/talhao/partida, sem aspas. */
    sujeito?: string;
    /** Contextos (protocolo/cultura/lance) que o foco deixou em pe. */
    contextos: string[];
    /**
     * Condutas ainda admissiveis para a `sequencia`. Muda a cada passo da
     * decodificacao incremental: o que ja foi listado sai, e o fecho do vetor so
     * entra quando nao ha conduta obrigatoria pendente.
     */
    condutas?: string[];
}

/**
 * Payload de poda enviado ao motor. As tres chaves legadas continuam sendo
 * emitidas: um motor que ainda nao entenda `politicas` poda como antes, e a
 * atualizacao dos dois lados deixa de ser simultanea.
 */
export interface SubgrafoPodado {
    acoes_permitidas: string[];
    farmacos_liberados: string[];
    vias_disponiveis: string[];
    politicas: PoliticaItem[];
    papeis: PapeisDominio;
    constantes: ConstantesCenario;
}

/**
 * Numero como a gramatica o aceita (`numero ::= /[0-9]+(\.[0-9]+)?/`) e como os
 * exemplares o escrevem: sempre com casa decimal, sem cauda de zeros do ponto
 * flutuante (0.15000000000000002 -> "0.15").
 */
export function formatarNumero(valor: number): string {
    const arredondado = Math.round(valor * 1000) / 1000;
    return Number.isInteger(arredondado) ? arredondado.toFixed(1) : String(arredondado);
}

/** Teto de valores por item: a gramatica cresce com isso, e um menu longo demais
 *  volta a ser, na pratica, um campo livre. */
const MAX_VALORES = 10;

/**
 * Reticulo de valores admissiveis a partir do que o modelo declara.
 *
 * `base` sao as doses nomeadas (inicial, ataque, manutencao, recomendada...),
 * `passo` o degrau de titulacao, `teto` o limite que nenhum valor pode passar.
 * Zero entra sempre: e o valor que as decisoes de nao-incremento usam
 * (`MANTER_BLOQUEADO dose 0.0`, como no plano de referencia do proprio modelo).
 *
 * Sem `teto` e sem `passo` o resultado e so o que foi declarado — e se nada foi
 * declarado, a lista volta vazia e o campo permanece livre. O modulo nunca
 * inventa um limite que o especialista nao escreveu.
 */
export function reticuloDeValores(
    unidade: string,
    base: number[],
    passo?: number,
    teto?: number,
    fatores: number[] = []
): ValorAdmissivel[] {
    const valores = new Set<number>([0]);

    for (const v of base) {
        if (Number.isFinite(v) && v >= 0) valores.add(v);
        // Ajuste por populacao/area: o modelo manda multiplicar a dose por um
        // fator, entao a dose ajustada tambem e um valor legitimo.
        for (const f of fatores) if (Number.isFinite(v * f)) valores.add(v * f);
    }

    if (passo && passo > 0) {
        const limite = teto ?? Math.max(...base, passo) ;
        for (let k = 1; k <= MAX_VALORES && passo * k <= limite; k++) valores.add(passo * k);
    }

    const ordenados = [...valores]
        .filter(v => teto === undefined || v <= teto + 1e-9)
        .sort((a, b) => a - b)
        .slice(0, MAX_VALORES);

    return ordenados.map(v => ({ valor: formatarNumero(v), unidade }));
}

/**
 * Acrescenta ao reticulo os valores multiplicados por um fator declarado pelo
 * modelo (ajuste por populacao, por area). O valor cheio continua admissivel: o
 * ajuste muda o que se RECOMENDA, e cabe ao contrato e ao prompt cobrarem o
 * ajuste — a gramatica so nao pode tornar a dose ajustada inexprimivel.
 */
export function escalar(valores: ValorAdmissivel[], fator: number): ValorAdmissivel[] {
    if (!Number.isFinite(fator) || fator <= 0 || fator === 1) return valores;
    const vistos = new Map<string, ValorAdmissivel>();
    for (const v of valores) {
        vistos.set(`${v.valor} ${v.unidade}`, v);
        const escalado = { valor: formatarNumero(Number(v.valor) * fator), unidade: v.unidade };
        vistos.set(`${escalado.valor} ${escalado.unidade}`, escalado);
    }
    return [...vistos.values()]
        .sort((a, b) => Number(a.valor) - Number(b.valor))
        .slice(0, MAX_VALORES);
}

/** `escalar` aplicado a cada balde do mapa por decisao. */
export function escalarMapa(
    mapa: Record<string, ValorAdmissivel[]> | undefined,
    fator: number
): Record<string, ValorAdmissivel[]> | undefined {
    if (!mapa) return mapa;
    const saida: Record<string, ValorAdmissivel[]> = {};
    for (const [decisao, valores] of Object.entries(mapa)) saida[decisao] = escalar(valores, fator);
    return saida;
}

/**
 * Distribui os valores admissiveis entre as decisoes: cada balde declara quais
 * decisoes carregam qual conjunto, e o que sobra recebe `padrao` (tipicamente
 * so o zero, para as decisoes que nao movimentam dose alguma).
 *
 * Os baldes sao declarados por cada dominio, porque so o dominio sabe que
 * "titular" e AUMENTAR_VAZAO ali e AUMENTAR_VAZAO/REDUZIR_VAZAO acola. O
 * mecanismo — valor amarrado ao par (item, decisao) — e o mesmo para todos.
 */
export function valoresPorDecisao(
    decisoes: string[],
    baldes: { decisoes: string[]; valores: ValorAdmissivel[] }[],
    padrao: ValorAdmissivel[]
): Record<string, ValorAdmissivel[]> {
    const mapa: Record<string, ValorAdmissivel[]> = {};
    for (const decisao of decisoes) {
        const balde = baldes.find(b => b.decisoes.includes(decisao));
        const valores = balde ? balde.valores : padrao;
        if (valores.length > 0) mapa[decisao] = valores;
    }
    return mapa;
}

/** Monta o payload completo a partir das politicas ja calculadas. */
export function montarSubgrafo(
    politicas: PoliticaItem[],
    papeis: PapeisDominio,
    constantes: ConstantesCenario
): SubgrafoPodado {
    const acoes = new Set<string>();
    const meios = new Set<string>();
    const itens: string[] = [];

    for (const p of politicas) {
        if (p.decisoes.length === 0) continue;
        itens.push(p.item);
        for (const d of p.decisoes) acoes.add(d);
        for (const m of p.meios) meios.add(m);
    }

    return {
        // Chaves legadas: uniao global, como antes. Continuam corretas como
        // sobre-aproximacao — o motor novo usa `politicas` e ignora estas.
        acoes_permitidas: [...acoes],
        farmacos_liberados: itens,
        vias_disponiveis: [...meios],
        politicas: politicas.filter(p => p.decisoes.length > 0),
        papeis,
        constantes
    };
}
