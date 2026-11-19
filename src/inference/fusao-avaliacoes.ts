/**
 * Fusão de CENÁRIO + RESULTADO + AVALIAÇÃO num registro por plano, de vários
 * domínios no mesmo arquivo.
 *
 * O `evalueted_*.jsonl` já junta duas das três partes: o resultado (o `plano`
 * gerado e o bloco `geracao`) e a avaliação (sintaxe, semântica, oráculo, juiz).
 * O que falta nele é a ENTRADA completa — a telemetria, as áreas/populações/
 * contextos e os itens em uso só existem no `cenarios-*.jsonl`. Sem ela não se
 * consegue perguntar "o veredito muda com a leitura?", que é a pergunta da tese.
 *
 * Esta função faz a junção e nada mais: não recalcula veredito, não reavalia,
 * não estima campo ausente. Campo que nenhuma das fontes trouxe fica ausente, e
 * o RESUMO diz quantas linhas ficaram sem cada parte — é assim que uma avaliação
 * interrompida no meio aparece como cobertura incompleta em vez de passar por
 * lote completo.
 *
 * Camada pura: recebe os registros já lidos e devolve os fundidos. Quem toca o
 * disco é `src/web/server.ts` (rota) — aqui não há `fs`, para o teste poder
 * montar as fontes à mão.
 */

import type { RegistroAvaliacaoImportado } from './avaliacao-jsonl.js';

export type DominioFusao = 'med' | 'agro' | 'fut';

/** O campo que identifica o SUJEITO do cenário em cada domínio. */
export const CHAVE_SUJEITO: Record<DominioFusao, string> = {
    med: 'paciente',
    agro: 'talhao',
    fut: 'partida'
};

/** O campo que lista os itens já em curso em cada domínio. */
export const CHAVE_EM_USO: Record<DominioFusao, string> = {
    med: 'farmacosEmUso',
    agro: 'produtosEmUso',
    fut: 'infracoesEmUso'
};

/** O campo que lista os contextos/recortes do cenário em cada domínio. */
export const CHAVE_CONTEXTOS: Record<DominioFusao, string> = {
    med: 'populacoes',
    agro: 'areas',
    fut: 'contextos'
};

export const DOMINIOS: DominioFusao[] = ['med', 'agro', 'fut'];

export function ehDominio(valor: unknown): valor is DominioFusao {
    return valor === 'med' || valor === 'agro' || valor === 'fut';
}

/** Um registro de cenário, como está no `cenarios-*.jsonl`. */
export type RegistroCenario = Record<string, unknown>;

/**
 * As três PARTES que a fusão pode juntar — o "modo de fusão" da tela. Quem
 * escolhe só `cenario` tem o conjunto de entradas; quem tira `cenario` tem os
 * vereditos sem a leitura. A identidade da linha (domínio, lado, linha, sujeito)
 * e a procedência (`fusao`) ficam SEMPRE: sem elas o registro não se liga a nada.
 */
export type ParteFusao = 'cenario' | 'resultado' | 'avaliacao';

export const PARTES: ParteFusao[] = ['cenario', 'resultado', 'avaliacao'];

export function ehParte(valor: unknown): valor is ParteFusao {
    return valor === 'cenario' || valor === 'resultado' || valor === 'avaliacao';
}

/**
 * Uma fonte da fusão.
 *
 * `tipo: 'avaliacao'` é um `evalueted_*.jsonl`, com o cenário que o acompanha
 * (descoberto pelo nome ou escolhido na tela). `tipo: 'cenario'` é um
 * `cenarios-*.jsonl` escolhido sozinho: ele não tem avaliação nenhuma, e todas
 * as suas linhas entram — é o caso de querer só as entradas, de vários domínios,
 * num arquivo só.
 */
export interface FonteFusao {
    /** Nome do arquivo de avaliação, ou o caminho do cenário numa fonte `cenario`. */
    arquivo: string;
    /** O que esta fonte é. Ausente: `avaliacao`, como era antes de haver escolha. */
    tipo?: 'avaliacao' | 'cenario';
    /**
     * O domínio da fonte, quando quem a montou sabe. Numa fonte `cenario` é a
     * ÚNICA origem possível: sem avaliação não há campo `dominio` em registro
     * nenhum, e sem domínio a fusão não sabe que `talhao` é o sujeito nem que
     * `areas` são os contextos — resolveria por tentativa.
     */
    dominio?: string;
    avaliacoes: RegistroAvaliacaoImportado[];
    /** O `cenarios-*.jsonl` correspondente, quando localizado. */
    cenarios?: { arquivo: string; registros: RegistroCenario[] };
    /** O `*.meta.jsonl` do mesmo lote, quando existir (só os domínios que o têm). */
    meta?: { arquivo: string; registros: RegistroCenario[] };
}

export interface OpcoesFusao {
    /** As partes que vão no registro. Ausente ou vazio: as três. */
    partes?: ParteFusao[];
    /**
     * Inclui o texto do plano gerado. Desligar deixa o arquivo muito menor
     * quando a análise é só dos vereditos e dos tempos.
     */
    incluirPlano?: boolean;
    /** Inclui o desenho do cenário (família, dimensão controlada, classe esperada). */
    incluirDesenho?: boolean;
    /**
     * Inclui as linhas do cenário que NÃO têm registro de avaliação, com
     * `avaliacao: null`. É o que torna visível a avaliação interrompida.
     */
    incluirSemAvaliacao?: boolean;
}

/** Como a linha foi casada com o cenário. */
export type Juncao = 'sujeito' | 'linha' | 'nenhuma';

export interface RegistroFundido {
    /** Procedência: de que arquivos esta linha veio e por que chave casou. */
    fusao: {
        arquivoAvaliacao: string | null;
        arquivoCenario: string | null;
        juncao: Juncao;
    };
    dominio: string | null;
    lado: string | null;
    linha: number | null;
    sujeito: string | null;
    /** A ENTRADA: o pedido e a leitura que o sistema recebeu. Ausente fora do modo. */
    cenario?: {
        intencao: string | null;
        telemetria: Record<string, unknown> | null;
        contextos: unknown[] | null;
        emUso: unknown[] | null;
    } | null;
    /** O RESULTADO: o artefato gerado e os tempos/tamanhos da geração. */
    resultado?: {
        plano?: string;
        geracao: Record<string, unknown> | null;
    } | null;
    /** A AVALIAÇÃO: cada camada separada, como o `evalueted_*.jsonl` as guarda. */
    avaliacao?: {
        naoAvaliado: boolean;
        violacao: unknown;
        validacaoSintatica: unknown;
        validacaoSemantica: unknown;
        oraculo: unknown;
        julgamentoLLM: unknown;
        concordancia: unknown;
        classificacao: unknown;
        tempos: unknown;
    } | null;
    /** O DESENHO do cenário, quando o lote tem `*.meta.jsonl`. */
    desenho?: RegistroCenario;
}

export interface ResumoFonte {
    arquivo: string;
    tipo: 'avaliacao' | 'cenario';
    arquivoCenario: string | null;
    arquivoMeta: string | null;
    dominios: string[];
    lados: string[];
    /** Registros de avaliação lidos. */
    avaliacoes: number;
    /** Linhas do arquivo de cenários, quando localizado. */
    cenarios: number | null;
    /** Linhas fundidas que saíram desta fonte. */
    fundidos: number;
    casadosPorSujeito: number;
    casadosPorLinha: number;
    /** Avaliações que não acharam cenário — junção `nenhuma`. */
    semCenario: number;
    /** Cenários sem avaliação: a assinatura de lote interrompido ou filtrado. */
    semAvaliacao: number;
    /** Os números de linha dos cenários sem avaliação (até `LIMITE_LACUNAS`). */
    lacunas: number[];
    /** Verdadeiro quando `lacunas` foi truncada. */
    lacunasTruncadas: boolean;
}

export interface ResumoFusao {
    /** As partes efetivamente incluídas — o modo de fusão que valeu. */
    partes: ParteFusao[];
    registros: number;
    dominios: string[];
    fontes: ResumoFonte[];
    /** Soma das lacunas de todas as fontes. */
    totalSemAvaliacao: number;
    totalSemCenario: number;
    /** Chaves de telemetria vistas, por domínio — as colunas do CSV. */
    telemetriaPorDominio: Record<string, string[]>;
}

export interface ResultadoFusao {
    registros: RegistroFundido[];
    resumo: ResumoFusao;
}

/** Quantos números de linha o resumo lista antes de truncar. */
export const LIMITE_LACUNAS = 50;

const texto = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const objeto = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const lista = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);

/**
 * O `<base>` de um `evalueted_<base>_<AAAAMMDD-HHmmss>[-n].jsonl` — é por ele
 * que se acha o `cenarios-*.jsonl` da entrada. Devolve `null` nos nomes antigos
 * (`<carimbo>-<dominio>.jsonl`), que não guardam o nome da entrada.
 */
export function baseDoArquivoAvaliacao(nome: string): string | null {
    const m = /^evalueted_(.+)_\d{8}-\d{6}(?:-\d+)?\.jsonl$/.exec(nome);
    return m ? m[1] : null;
}

/** O sujeito de um registro de cenário, no campo do domínio. */
export function sujeitoDoCenario(cenario: RegistroCenario, dominio: string | null): string | null {
    if (ehDominio(dominio)) return texto(cenario[CHAVE_SUJEITO[dominio]]);
    // Domínio desconhecido: tenta os três, que não colidem entre si.
    for (const d of DOMINIOS) {
        const v = texto(cenario[CHAVE_SUJEITO[d]]);
        if (v !== null) return v;
    }
    return null;
}

/** A parte de ENTRADA de um registro de cenário, nos nomes neutros da fusão. */
function entradaDoCenario(cenario: RegistroCenario, dominio: string | null): RegistroFundido['cenario'] {
    const chaves = ehDominio(dominio)
        ? { ctx: CHAVE_CONTEXTOS[dominio], uso: CHAVE_EM_USO[dominio] }
        : { ctx: null, uso: null };
    const primeiro = (nomes: string[]): unknown[] | null => {
        for (const n of nomes) {
            const v = lista(cenario[n]);
            if (v !== null) return v;
        }
        return null;
    };
    return {
        intencao: texto(cenario.intencao),
        telemetria: objeto(cenario.telemetria),
        contextos: chaves.ctx ? lista(cenario[chaves.ctx]) : primeiro(DOMINIOS.map(d => CHAVE_CONTEXTOS[d])),
        emUso: chaves.uso ? lista(cenario[chaves.uso]) : primeiro(DOMINIOS.map(d => CHAVE_EM_USO[d]))
    };
}

function avaliacaoDoRegistro(r: RegistroAvaliacaoImportado): RegistroFundido['avaliacao'] {
    return {
        naoAvaliado: r.naoAvaliado === true,
        violacao: r.violacao,
        validacaoSintatica: r.validacaoSintatica,
        validacaoSemantica: r.validacaoSemantica,
        oraculo: r.oraculo,
        julgamentoLLM: r.julgamentoLLM,
        concordancia: r.concordancia,
        classificacao: r.classificacao,
        tempos: r.tempos
    };
}

function unicos(valores: (string | null | undefined)[]): string[] {
    return [...new Set(valores.filter((v): v is string => typeof v === 'string' && v.length > 0))].sort();
}

/**
 * Funde as fontes num registro por plano avaliado (mais, opcionalmente, um por
 * cenário sem avaliação). A ordem é a das fontes, e dentro de cada fonte a do
 * número de linha — para o arquivo baixado ser estável entre execuções.
 */
export function fundirAvaliacoes(fontes: FonteFusao[], opcoes: OpcoesFusao = {}): ResultadoFusao {
    const registros: RegistroFundido[] = [];
    const resumos: ResumoFonte[] = [];
    const telemetriaPorDominio: Record<string, Set<string>> = {};

    // Modo de fusão: sem escolha, as três partes. Escolha vazia também vale as
    // três — um arquivo só com a identidade das linhas não serve a ninguém.
    const pedidas = (opcoes.partes ?? []).filter(ehParte);
    const partes = pedidas.length > 0 ? PARTES.filter(p => pedidas.includes(p)) : [...PARTES];
    const quer = (p: ParteFusao): boolean => partes.includes(p);

    for (const fonte of fontes) {
        const tipo = fonte.tipo ?? 'avaliacao';
        // O domínio declarado pela fonte serve de base; as avaliações, quando
        // existem e concordam, mandam (é o que está gravado em cada registro).
        const dominioDaFonte = unicos([...fonte.avaliacoes.map(r => texto(r.dominio)), fonte.dominio ?? null]);
        const dominioDasAvaliacoes = unicos(fonte.avaliacoes.map(r => texto(r.dominio)));
        const dominioUnico =
            dominioDasAvaliacoes.length === 1 ? dominioDasAvaliacoes[0] : (fonte.dominio ?? null);

        // Índices do cenário: por sujeito (chave forte) e por número de linha
        // (1-based, a ordem do arquivo — é o que a avaliação grava em `linha`).
        const porSujeito = new Map<string, { indice: number; registro: RegistroCenario }>();
        const porLinha = new Map<number, RegistroCenario>();
        for (const [i, c] of (fonte.cenarios?.registros ?? []).entries()) {
            const s = sujeitoDoCenario(c, dominioUnico);
            if (s !== null && !porSujeito.has(s)) porSujeito.set(s, { indice: i + 1, registro: c });
            porLinha.set(i + 1, c);
        }

        // Índice do desenho, pelo sujeito e pelo número de linha que ele declara.
        const metaPorSujeito = new Map<string, RegistroCenario>();
        const metaPorLinha = new Map<number, RegistroCenario>();
        for (const m of fonte.meta?.registros ?? []) {
            const s = sujeitoDoCenario(m, dominioUnico);
            if (s !== null) metaPorSujeito.set(s, m);
            if (typeof m.linha === 'number') metaPorLinha.set(m.linha, m);
        }

        let casadosPorSujeito = 0;
        let casadosPorLinha = 0;
        let semCenario = 0;
        const usados = new Set<number>();

        const ordenadas = [...fonte.avaliacoes].sort(
            (a, b) => (typeof a.linha === 'number' ? a.linha : 0) - (typeof b.linha === 'number' ? b.linha : 0)
        );

        for (const r of ordenadas) {
            const dominio = texto(r.dominio) ?? dominioUnico;
            const sujeito = texto(r.sujeito);
            const linha = typeof r.linha === 'number' ? r.linha : null;

            // Sujeito primeiro: ele sobrevive a reordenação do arquivo de cenários.
            // `indiceCenario` é a linha do cenário CASADO (1-based no arquivo de
            // cenários) — espaço de numeração diferente do `linha` da avaliação,
            // que numa avaliação renumerada é o índice dentro do lote.
            let cenario: RegistroCenario | undefined;
            let indiceCenario: number | null = null;
            let juncao: Juncao = 'nenhuma';
            if (sujeito !== null && porSujeito.has(sujeito)) {
                const achado = porSujeito.get(sujeito)!;
                cenario = achado.registro;
                indiceCenario = achado.indice;
                juncao = 'sujeito';
                usados.add(achado.indice);
                casadosPorSujeito++;
            } else if (linha !== null && porLinha.has(linha)) {
                cenario = porLinha.get(linha);
                indiceCenario = linha;
                juncao = 'linha';
                usados.add(linha);
                casadosPorLinha++;
            } else if (fonte.cenarios) {
                semCenario++;
            }

            if (cenario && objeto(cenario.telemetria)) {
                const chave = dominio ?? 'desconhecido';
                telemetriaPorDominio[chave] ??= new Set();
                for (const k of Object.keys(objeto(cenario.telemetria)!)) telemetriaPorDominio[chave].add(k);
            }

            // O `*.meta.jsonl` numera pelo arquivo de CENÁRIOS: cair no `linha` da
            // avaliação colaria o desenho do vizinho quando o lote renumerou.
            const desenho =
                opcoes.incluirDesenho !== false
                    ? (sujeito !== null ? metaPorSujeito.get(sujeito) : undefined) ??
                      (indiceCenario !== null ? metaPorLinha.get(indiceCenario) : undefined)
                    : undefined;

            registros.push({
                fusao: {
                    arquivoAvaliacao: fonte.arquivo,
                    arquivoCenario: cenario ? (fonte.cenarios?.arquivo ?? null) : null,
                    juncao
                },
                dominio,
                lado: texto(r.lado),
                linha,
                // Sem sujeito na avaliação (arquivo antigo), o do cenário serve.
                sujeito: sujeito ?? (cenario ? sujeitoDoCenario(cenario, dominio) : null),
                ...(quer('cenario')
                    ? {
                          cenario: cenario
                              ? entradaDoCenario(cenario, dominio)
                              : // Sem cenário, o pedido que a própria avaliação gravou ainda é entrada.
                                { intencao: texto(r.intencao), telemetria: null, contextos: null, emUso: null }
                      }
                    : {}),
                ...(quer('resultado')
                    ? {
                          resultado: {
                              ...(opcoes.incluirPlano === false ? {} : { plano: texto(r.plano) ?? undefined }),
                              geracao: objeto(r.geracao)
                          }
                      }
                    : {}),
                ...(quer('avaliacao') ? { avaliacao: avaliacaoDoRegistro(r) } : {}),
                ...(desenho ? { desenho } : {})
            });
        }

        // Cenários que nenhuma avaliação alcançou.
        const lacunas: number[] = [];
        for (const [linha] of porLinha) if (!usados.has(linha)) lacunas.push(linha);
        lacunas.sort((a, b) => a - b);

        // Numa fonte `cenario` TODAS as linhas são "sem avaliação" — é o que a fonte
        // é. Pedir que `incluirSemAvaliacao` as libere devolveria um arquivo vazio
        // para quem escolheu o cenário de propósito.
        if (opcoes.incluirSemAvaliacao || tipo === 'cenario') {
            for (const linha of lacunas) {
                const cenario = porLinha.get(linha)!;
                const sujeito = sujeitoDoCenario(cenario, dominioUnico);
                const tel = objeto(cenario.telemetria);
                if (tel) {
                    const chave = dominioUnico ?? 'desconhecido';
                    telemetriaPorDominio[chave] ??= new Set();
                    for (const k of Object.keys(tel)) telemetriaPorDominio[chave].add(k);
                }
                registros.push({
                    fusao: {
                        arquivoAvaliacao: null,
                        arquivoCenario: fonte.cenarios?.arquivo ?? null,
                        juncao: 'linha'
                    },
                    dominio: dominioUnico,
                    lado: null,
                    linha,
                    sujeito,
                    ...(quer('cenario') ? { cenario: entradaDoCenario(cenario, dominioUnico) } : {}),
                    ...(quer('resultado') ? { resultado: null } : {}),
                    ...(quer('avaliacao') ? { avaliacao: null } : {}),
                    ...(opcoes.incluirDesenho !== false
                        ? (() => {
                              const d =
                                  (sujeito !== null ? metaPorSujeito.get(sujeito) : undefined) ?? metaPorLinha.get(linha);
                              return d ? { desenho: d } : {};
                          })()
                        : {})
                });
            }
        }

        resumos.push({
            arquivo: fonte.arquivo,
            tipo,
            arquivoCenario: fonte.cenarios?.arquivo ?? null,
            arquivoMeta: fonte.meta?.arquivo ?? null,
            dominios: dominioDaFonte,
            lados: unicos(fonte.avaliacoes.map(r => texto(r.lado))),
            avaliacoes: fonte.avaliacoes.length,
            cenarios: fonte.cenarios ? fonte.cenarios.registros.length : null,
            fundidos: fonte.avaliacoes.length + (opcoes.incluirSemAvaliacao || tipo === 'cenario' ? lacunas.length : 0),
            casadosPorSujeito,
            casadosPorLinha,
            semCenario,
            semAvaliacao: lacunas.length,
            lacunas: lacunas.slice(0, LIMITE_LACUNAS),
            lacunasTruncadas: lacunas.length > LIMITE_LACUNAS
        });
    }

    return {
        registros,
        resumo: {
            partes,
            registros: registros.length,
            dominios: unicos(registros.map(r => r.dominio)),
            fontes: resumos,
            totalSemAvaliacao: resumos.reduce((s, f) => s + f.semAvaliacao, 0),
            totalSemCenario: resumos.reduce((s, f) => s + f.semCenario, 0),
            telemetriaPorDominio: Object.fromEntries(
                Object.entries(telemetriaPorDominio).map(([d, s]) => [d, [...s].sort()])
            )
        }
    };
}

// ---------------------------------------------------------------------------
// Serialização
// ---------------------------------------------------------------------------

export function fusaoParaJsonl(resultado: ResultadoFusao): string {
    return resultado.registros.map(r => JSON.stringify(r)).join('\n') + (resultado.registros.length > 0 ? '\n' : '');
}

const campoCsv = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const veredito = (v: unknown): unknown => objeto(v)?.veredito ?? null;

/**
 * CSV achatado, uma linha por registro. As colunas de telemetria são a UNIÃO das
 * chaves vistas em todos os domínios selecionados (`tel_<parâmetro>`), porque os
 * sensores de med, agro e fut não são os mesmos — célula vazia é parâmetro que
 * não existe naquele domínio, não zero.
 *
 * O plano fica fora: é texto multilinha de DSL, que não cabe em célula. Para o
 * artefato, baixe o JSONL.
 */
export function fusaoParaCsv(resultado: ResultadoFusao): string {
    const partes = resultado.resumo.partes;
    const quer = (p: ParteFusao): boolean => partes.includes(p);
    const telemetria = quer('cenario')
        ? [...new Set(Object.values(resultado.resumo.telemetriaPorDominio).flat())].sort()
        : [];
    const temDesenho = resultado.registros.some(r => r.desenho);

    // As colunas seguem o modo de fusão: parte fora do modo não vira coluna vazia.
    const colunas = [
        'arquivo_avaliacao',
        'arquivo_cenario',
        'juncao',
        'dominio',
        'lado',
        'linha',
        'sujeito',
        ...(quer('cenario') ? ['intencao', 'contextos', 'em_uso', ...telemetria.map(t => `tel_${t}`)] : []),
        ...(quer('avaliacao')
            ? ['sintaxe', 'semantica', 'oraculo', 'juiz', 'concordancia', 'classificacao', 'violacao', 'nao_avaliado']
            : []),
        ...(quer('resultado')
            ? [
                  'chars_plano',
                  'tokens_plano',
                  'chars_prompt',
                  'tokens_prompt',
                  'tempo_geracao_ms',
                  'tempo_validacao_gate_ms'
              ]
            : []),
        ...(quer('avaliacao') ? ['tempo_avaliacao_ms'] : []),
        ...(temDesenho ? ['familia', 'classe_esperada'] : [])
    ];

    const linhas = [colunas.join(',')];
    for (const r of resultado.registros) {
        const g = r.resultado?.geracao ?? {};
        const esperado = objeto(r.desenho?.esperado);
        const celulas = [
            r.fusao.arquivoAvaliacao,
            r.fusao.arquivoCenario,
            r.fusao.juncao,
            r.dominio,
            r.lado,
            r.linha,
            r.sujeito,
            ...(quer('cenario')
                ? [
                      r.cenario?.intencao ?? null,
                      r.cenario?.contextos?.join('|') ?? null,
                      r.cenario?.emUso?.join('|') ?? null,
                      ...telemetria.map(t => r.cenario?.telemetria?.[t] ?? null)
                  ]
                : []),
            ...(quer('avaliacao')
                ? [
                      veredito(r.avaliacao?.validacaoSintatica),
                      veredito(r.avaliacao?.validacaoSemantica),
                      veredito(r.avaliacao?.oraculo),
                      objeto(r.avaliacao?.julgamentoLLM)?.status ?? null,
                      r.avaliacao?.concordancia ?? null,
                      r.avaliacao?.classificacao ?? null,
                      r.avaliacao?.violacao ?? null,
                      r.avaliacao ? r.avaliacao.naoAvaliado : null
                  ]
                : []),
            ...(quer('resultado')
                ? [
                      g.charsPlano ?? null,
                      g.tokensPlano ?? null,
                      g.charsPrompt ?? null,
                      g.tokensPrompt ?? null,
                      g.tempoTotalMs ?? null,
                      g.tempoValidacaoMs ?? null
                  ]
                : []),
            ...(quer('avaliacao') ? [objeto(r.avaliacao?.tempos)?.totalMs ?? null] : []),
            ...(temDesenho ? [r.desenho?.familia ?? null, esperado?.classe ?? null] : [])
        ];
        linhas.push(celulas.map(campoCsv).join(','));
    }
    return linhas.join('\n') + '\n';
}

/**
 * Nome do arquivo baixado: `fusao_<dominios>_<modo>_<AAAAMMDD-HHmmss>.<ext>`.
 * O modo entra no nome porque dois downloads do mesmo lote com partes
 * diferentes são arquivos diferentes — e seis meses depois ninguém lembra qual
 * era qual. Com as três partes, o modo é `completo`.
 */
export function nomeArquivoFusao(
    dominios: string[],
    agora: Date,
    extensao: 'jsonl' | 'csv',
    partes: ParteFusao[] = PARTES
): string {
    const p = (n: number): string => String(n).padStart(2, '0');
    const carimbo = `${agora.getFullYear()}${p(agora.getMonth() + 1)}${p(agora.getDate())}-${p(agora.getHours())}${p(agora.getMinutes())}${p(agora.getSeconds())}`;
    const dom = dominios.length > 0 ? dominios.join('-') : 'vazio';
    const modo = partes.length === PARTES.length ? 'completo' : PARTES.filter(x => partes.includes(x)).join('-');
    return `fusao_${dom}_${modo || 'vazio'}_${carimbo}.${extensao}`;
}
