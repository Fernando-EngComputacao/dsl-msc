/**
 * As três análises de tempo POR PLANO da tela de avaliação, montadas a partir
 * do que cada plano trouxe:
 *
 *   1. `pilhaDeTempos`      o tempo total da pilha: geração + avaliação;
 *   2. `tempoPorTamanho`    tempo de geração por caractere e por token, com o
 *                           tamanho médio do input e quanto ele explica do tempo;
 *   3. `tempoPorPlano`      o tempo de UM plano (geração + validação no gate),
 *                           com média, desvio padrão e intervalo de confiança.
 *
 * As contas são de estatistica-tempos.ts (o mesmo módulo do backend, puro e
 * testado); aqui é só leitura e normalização. Campo que o arquivo não trouxe
 * fica `null` e a tela mostra "—": nada é estimado, nada é preenchido com zero.
 *
 * Duas origens, um formato: na avaliação ao vivo o servidor escreve o bloco
 * `geracao` em cada plano; num `results_*.jsonl` do lote os mesmos números
 * estão no nível de cima do registro. `geracaoDoRegistroImportado` reduz as
 * duas formas a uma.
 *
 * ATENÇÃO à soma: `tempoGeracaoMs` é a geração do plano que FICOU; a validação
 * do gate (oráculo/juiz durante a geração) e as gerações descartadas são
 * parcelas separadas, de propósito — somar tudo num número só esconderia o
 * custo do reparo por reamostragem, que é justamente o que se quer medir.
 */

import type { RegistroAvaliacaoImportado } from '../../src/inference/avaliacao-jsonl';
import {
    resumirAmostra,
    tempoPorUnidade,
    type ResumoAmostra,
    type TempoPorUnidade
} from '../../src/inference/estatistica-tempos';
import type { DetalheLado, RespostaAvaliacao } from './api';
import type { IdDetalhePlano, IdDetalheTamanho } from './detalhe-tempo';

export type LadoAvaliado = 'arquitetura' | 'baseline';

/** As medidas de UM plano, já normalizadas. Tudo em ms e em unidades inteiras. */
export interface MedidasDoPlano {
    /** Geração do plano que ficou (não inclui tentativas descartadas). */
    tempoGeracaoMs?: number;
    /** Validação feita DURANTE a geração (o gate: oráculo e/ou juiz), somando as tentativas do cenário. */
    tempoValidacaoGateMs?: number;
    /** Gerações que o gate reprovou e descartou. */
    tempoGeracaoDescartadaMs?: number;
    /** Relógio de parede do cenário inteiro no lote. */
    tempoCenarioMs?: number;
    tentativasGeracao?: number;
    /** Avaliação deste plano nesta tela (sintaxe + semântica, juiz em paralelo). */
    tempoAvaliacaoMs?: number;
    charsPedido?: number;
    charsPrompt?: number;
    charsPlano?: number;
    tokensPrompt?: number;
    tokensPlano?: number;
}

/** Soma só o que existe; `undefined` quando nenhuma parcela existe (não 0). */
function somar(...partes: (number | undefined)[]): number | undefined {
    const presentes = partes.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return presentes.length > 0 ? presentes.reduce((a, b) => a + b, 0) : undefined;
}

const numero = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** As medidas de um plano avaliado, do bloco `geracao` e dos tempos da avaliação. */
export function medidasDoPlano(lado: DetalheLado): MedidasDoPlano {
    const g = lado.geracao;
    return {
        tempoGeracaoMs: numero(g?.tempoTotalMs),
        tempoValidacaoGateMs: numero(g?.tempoValidacaoMs),
        tempoGeracaoDescartadaMs: numero(g?.tempoGeracaoDescartadaMs),
        tempoCenarioMs: numero(g?.tempoCenarioMs),
        tentativasGeracao: numero(g?.tentativasGeracao),
        tempoAvaliacaoMs: numero(lado.tempos?.totalMs),
        charsPedido: numero(g?.charsPedido),
        charsPrompt: numero(g?.charsPrompt),
        // Sem o bloco (arquivo antigo), o tamanho do plano ainda é mensurável: o texto está aqui.
        charsPlano: numero(g?.charsPlano) ?? (typeof lado.plano === 'string' && lado.plano.length > 0 ? lado.plano.length : undefined),
        tokensPrompt: numero(g?.tokensPrompt),
        tokensPlano: numero(g?.tokensPlano)
    };
}

/**
 * O bloco `geracao` de um registro importado. Aceita as duas formas: o bloco
 * escrito pela avaliação (`evalueted_*.jsonl`) e os campos no nível de cima que
 * o lote grava (`results_*.jsonl`). Os tamanhos em caracteres são medidos do
 * próprio registro quando não vieram prontos.
 */
export function geracaoDoRegistroImportado(registro: RegistroAvaliacaoImportado): DetalheLado['geracao'] {
    const g = (registro.geracao ?? {}) as Record<string, unknown>;
    const campo = (nome: string): number | undefined => numero(g[nome]) ?? numero(registro[nome]);
    const texto = (valor: unknown): number | undefined => (typeof valor === 'string' && valor.length > 0 ? valor.length : undefined);

    const bloco = {
        tempoTotalMs: campo('tempoTotalMs'),
        tempoSequenciasMs: campo('tempoSequenciasMs'),
        tempoPIsValidasMs: campo('tempoPIsValidasMs'),
        tempoValidacaoPlanosMs: campo('tempoValidacaoPlanosMs'),
        tempoValidacaoMs: campo('tempoValidacaoMs'),
        tempoGeracaoDescartadaMs: campo('tempoGeracaoDescartadaMs'),
        tempoCenarioMs: campo('tempoCenarioMs'),
        tentativasGeracao: campo('tentativasGeracao'),
        charsPedido: numero(g.charsPedido) ?? texto(registro.intencao),
        charsPrompt: numero(g.charsPrompt) ?? texto(registro.promptSemantico),
        charsPlano: numero(g.charsPlano) ?? texto(registro.plano),
        tokensPrompt: numero(g.tokensPrompt),
        tokensPlano: numero(g.tokensPlano)
    };
    const definidos = Object.entries(bloco).filter(([, v]) => v !== undefined);
    return definidos.length > 0 ? (Object.fromEntries(definidos) as DetalheLado['geracao']) : undefined;
}

/** Os planos de um lado, na ordem das linhas. */
export function planosDoLado(resposta: RespostaAvaliacao, lado: LadoAvaliado): DetalheLado[] {
    return resposta.linhas.map(l => l[lado]).filter((d): d is DetalheLado => !!d);
}

export function medidasDoLado(resposta: RespostaAvaliacao, lado: LadoAvaliado): MedidasDoPlano[] {
    return planosDoLado(resposta, lado).map(medidasDoPlano);
}

/** Os lados presentes na resposta (um ou dois). */
export function ladosPresentes(resposta: RespostaAvaliacao): LadoAvaliado[] {
    return (['arquitetura', 'baseline'] as const).filter(l => !!resposta[l]);
}

// ---------------------------------------------------------------------------
// 1. Tempo total da pilha
// ---------------------------------------------------------------------------

/** ms → s, com a mesma precisão dos agregados do servidor (2 casas). */
const emSegundos = (ms: number | null | undefined): number | null =>
    typeof ms === 'number' && Number.isFinite(ms) ? Math.round(ms / 10) / 100 : null;

export interface ParcelaDaPilha {
    rotulo: string;
    dica: string;
    segundos: number | null;
    /** Parcela medida fora da pilha pedida (geração + avaliação) — mostrada à parte. */
    extra?: boolean;
}

export interface PilhaDeTempos {
    parcelas: ParcelaDaPilha[];
    /** Geração + avaliação, como pedido. `null` se faltar uma das duas. */
    totalSegundos: number | null;
    /** O mesmo total com a validação do gate (quando o lote usou gate). */
    totalComGateSegundos: number | null;
    /** Houve alguma medida. Sem isto, a seção explica a ausência em vez de mostrar zeros. */
    algumaMedida: boolean;
}

/**
 * O total da pilha: a soma do tempo de GERAÇÃO dos planos com o tempo de
 * AVALIAÇÃO dos planos.
 *
 * Prefere os agregados que o arquivo/servidor já trazem (são a medição
 * autoritativa, a mesma das outras duas seções) e só cai na soma dos planos
 * quando o agregado não existe — assim um arquivo antigo, sem agregado, ainda
 * mostra o que dá para somar, e um arquivo novo nunca mostra dois números
 * diferentes para a mesma coisa.
 *
 * A validação do gate NÃO entra no total pedido: ela é de outra etapa (roda
 * dentro da geração, no lote) e aparece como parcela própria, mais o total
 * ampliado em `totalComGateSegundos`.
 */
export function pilhaDeTempos(resposta: RespostaAvaliacao): PilhaDeTempos {
    const porPlano = (['arquitetura', 'baseline'] as const).flatMap(l => medidasDoLado(resposta, l));

    const somaPlanos = (ler: (m: MedidasDoPlano) => number | undefined): number | null => {
        const valores = porPlano.map(ler).filter((v): v is number => typeof v === 'number');
        return valores.length > 0 ? valores.reduce((a, b) => a + b, 0) : null;
    };

    const geracao = resposta.tempoGeracaoTotalSegundos ?? emSegundos(somaPlanos(m => m.tempoGeracaoMs));
    const avaliacao = resposta.tempoTotalSegundos ?? emSegundos(somaPlanos(m => m.tempoAvaliacaoMs));
    const gate = emSegundos(somaPlanos(m => m.tempoValidacaoGateMs));
    const descartada = emSegundos(somaPlanos(m => m.tempoGeracaoDescartadaMs));

    const parcelas: ParcelaDaPilha[] = [
        {
            rotulo: 'Geração dos planos',
            dica: 'Soma do pipeline de geração de cada plano que ficou (Planner, PI Agents, validação global)',
            segundos: geracao
        },
        {
            rotulo: 'Avaliação dos planos',
            dica: 'Duração da avaliação inteira nesta tela (sintaxe, semântica e LLM Judge)',
            segundos: avaliacao
        },
        ...(gate !== null
            ? [
                  {
                      rotulo: 'Validação no gate',
                      dica: 'Validação que rodou DURANTE a geração, no lote (oráculo e/ou juiz, uma vez por tentativa). Fora do total de geração + avaliação',
                      segundos: gate,
                      extra: true
                  }
              ]
            : []),
        ...(descartada !== null
            ? [
                  {
                      rotulo: 'Gerações descartadas',
                      dica: 'Soma das gerações que o gate reprovou e jogou fora — o custo do reparo por reamostragem. Fora do total',
                      segundos: descartada,
                      extra: true
                  }
              ]
            : [])
    ];

    const total = geracao !== null && avaliacao !== null ? Math.round((geracao + avaliacao) * 100) / 100 : null;
    return {
        parcelas,
        totalSegundos: total,
        totalComGateSegundos: total !== null && gate !== null ? Math.round((total + gate) * 100) / 100 : null,
        algumaMedida: parcelas.some(p => p.segundos !== null)
    };
}

// ---------------------------------------------------------------------------
// 2. Tempo de geração por tamanho (caracteres, tokens) e influência do input
// ---------------------------------------------------------------------------

/** Uma unidade de tamanho confrontada com o tempo de geração. */
export interface TempoPorTamanhoItem {
    /** Chave do detalhe em `detalhe-tempo.ts` — o que o "?" da tabela abre. */
    id: IdDetalheTamanho;
    rotulo: string;
    dica: string;
    /** `input`: tamanho do que ENTRA na geração; `saida`: tamanho do plano gerado. */
    papel: 'input' | 'saida';
    unidade: 'caractere' | 'token';
    analise: TempoPorUnidade;
}

export interface TempoPorTamanho {
    /** Planos com tempo de geração medido. */
    n: number;
    /** O tempo de geração em si, resumido (média ± dp, IC). */
    geracao: ResumoAmostra | null;
    itens: TempoPorTamanhoItem[];
    /** Nenhuma unidade tem par usável: a seção explica em vez de mostrar tabela vazia. */
    algumaMedida: boolean;
    /** Tokens ausentes em todos os planos (motor sem `/tokenizar`, ou arquivo antigo). */
    semTokens: boolean;
}

export function tempoPorTamanho(resposta: RespostaAvaliacao, lado: LadoAvaliado): TempoPorTamanho {
    const medidas = medidasDoLado(resposta, lado);
    const porUnidade = (ler: (m: MedidasDoPlano) => number | undefined): TempoPorUnidade =>
        tempoPorUnidade(medidas.map(m => ({ tempoMs: m.tempoGeracaoMs, tamanho: ler(m) })));

    const itens: TempoPorTamanhoItem[] = [
        {
            id: 'input-chars',
            rotulo: 'Caracteres do input (Prompt Semântico)',
            dica: 'O contexto recuperado do grafo mais o pedido, como foi gravado na geração. Não é o prompt completo do motor (exemplos e gramática não são gravados)',
            papel: 'input',
            unidade: 'caractere',
            analise: porUnidade(m => m.charsPrompt)
        },
        {
            id: 'input-tokens',
            rotulo: 'Tokens do input (Prompt Semântico)',
            dica: 'O mesmo texto, contado com o tokenizador do modelo que gerou os planos (/tokenizar)',
            papel: 'input',
            unidade: 'token',
            analise: porUnidade(m => m.tokensPrompt)
        },
        {
            id: 'pedido-chars',
            rotulo: 'Caracteres do pedido',
            dica: 'Só a fala do usuário (intencao), sem o contexto do grafo',
            papel: 'input',
            unidade: 'caractere',
            analise: porUnidade(m => m.charsPedido)
        },
        {
            id: 'plano-chars',
            rotulo: 'Caracteres do plano',
            dica: 'Tamanho do artefato gerado — é a saída, não a entrada',
            papel: 'saida',
            unidade: 'caractere',
            analise: porUnidade(m => m.charsPlano)
        },
        {
            id: 'plano-tokens',
            rotulo: 'Tokens do plano',
            dica: 'O plano gerado, contado com o tokenizador do motor (/tokenizar)',
            papel: 'saida',
            unidade: 'token',
            analise: porUnidade(m => m.tokensPlano)
        }
    ];

    return {
        n: medidas.filter(m => typeof m.tempoGeracaoMs === 'number').length,
        geracao: resumirAmostra(medidas.map(m => m.tempoGeracaoMs)),
        itens,
        algumaMedida: itens.some(i => i.analise.n > 0),
        semTokens: itens.filter(i => i.unidade === 'token').every(i => i.analise.n === 0)
    };
}

// ---------------------------------------------------------------------------
// 3. Tempo de UM plano: geração + validação no gate
// ---------------------------------------------------------------------------

export interface AmostraDePlano {
    /** Chave do detalhe em `detalhe-tempo.ts` — o que o "?" da tabela abre. */
    id: IdDetalhePlano;
    rotulo: string;
    dica: string;
    /** A amostra principal da seção (geração + validação). */
    principal?: boolean;
    resumo: ResumoAmostra | null;
}

export interface TempoPorPlano {
    amostras: AmostraDePlano[];
    algumaMedida: boolean;
}

/**
 * O tempo de produzir UM plano: a geração mais a validação que rodou durante
 * ela (o gate — oráculo e/ou LLM Judge, uma vez por tentativa). É de propósito
 * que esta validação não apareça nas seções "tempo de geração" nem "tempo da
 * avaliação": ela não é nenhuma das duas.
 *
 * As parcelas e a avaliação desta tela vêm ao lado, com a MESMA estatística, para
 * que a soma possa ser conferida e para que se veja de onde vem a dispersão.
 */
export function tempoPorPlano(resposta: RespostaAvaliacao, lado: LadoAvaliado): TempoPorPlano {
    const medidas = medidasDoLado(resposta, lado);
    const amostras: AmostraDePlano[] = [
        {
            id: 'gate-total',
            rotulo: 'Geração + validação no gate',
            dica: 'Por plano: a geração que ficou mais a validação feita durante a geração, somando as tentativas do cenário',
            principal: true,
            resumo: resumirAmostra(medidas.map(m => somar(m.tempoGeracaoMs, m.tempoValidacaoGateMs)))
        },
        {
            id: 'geracao',
            rotulo: 'Geração (parcela)',
            dica: 'Só o pipeline de geração do plano que ficou',
            resumo: resumirAmostra(medidas.map(m => m.tempoGeracaoMs))
        },
        {
            id: 'validacao-gate',
            rotulo: 'Validação no gate (parcela)',
            dica: 'Só a validação feita durante a geração, no lote (oráculo e/ou LLM Judge)',
            resumo: resumirAmostra(medidas.map(m => m.tempoValidacaoGateMs))
        },
        {
            id: 'descartadas',
            rotulo: 'Gerações descartadas',
            dica: 'Tempo jogado fora em planos que o gate reprovou — zero nos cenários aprovados de primeira',
            resumo: resumirAmostra(medidas.map(m => m.tempoGeracaoDescartadaMs))
        },
        {
            id: 'cenario',
            rotulo: 'Cenário inteiro (relógio do lote)',
            dica: 'Relógio de parede de cada cenário no lote: todas as gerações, todas as validações e a rede',
            resumo: resumirAmostra(medidas.map(m => m.tempoCenarioMs))
        },
        {
            id: 'avaliacao-tela',
            rotulo: 'Avaliação nesta tela',
            dica: 'Por plano: sintaxe, semântica e LLM Judge desta avaliação (não é a validação do gate)',
            resumo: resumirAmostra(medidas.map(m => m.tempoAvaliacaoMs))
        }
    ];
    return { amostras, algumaMedida: amostras.some(a => a.resumo !== null) };
}

// ---------------------------------------------------------------------------
// Formatação (compartilhada com as seções antigas de tempo)
// ---------------------------------------------------------------------------

/**
 * Até 60 s: segundos com decimais. Acima disso: a unidade maior necessária,
 * sempre com as menores (min + s; h + min + s; d + h + min + s), em segundos
 * inteiros. Arredonda antes de decompor, para o resto não "vazar"
 * (59,7 min → 60 min 0 s).
 */
export function formatarSegundos(segundos: number): string {
    if (segundos <= 60) return `${segundos.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} s`;
    const total = Math.round(segundos);
    const s = total % 60;
    if (total <= 3600) return `${Math.floor(total / 60)} min ${s} s`;
    const min = Math.floor(total / 60) % 60;
    if (total <= 86400) return `${Math.floor(total / 3600)} h ${min} min ${s} s`;
    return `${Math.floor(total / 86400)} d ${Math.floor(total / 3600) % 24} h ${min} min ${s} s`;
}

/** Duração em ms, na escala legível: ms abaixo de 1 s, senão o formato de segundos. */
export function formatarDuracaoMs(ms: number | null | undefined): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${ms.toLocaleString('pt-BR', { maximumFractionDigits: ms < 10 ? 2 : 0 })} ms`;
    return formatarSegundos(ms / 1000);
}

/** Número com casas fixas; "—" quando não existe. Nunca imprime NaN. */
export function formatarNumero(valor: number | null | undefined, casas = 2): string {
    if (typeof valor !== 'number' || !Number.isFinite(valor)) return '—';
    return valor.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}

export function formatarInteiro(valor: number | null | undefined): string {
    if (typeof valor !== 'number' || !Number.isFinite(valor)) return '—';
    return Math.round(valor).toLocaleString('pt-BR');
}

/** Percentual com uma casa; "—" quando não existe. */
export function formatarPercentual(fracao: number | null | undefined): string {
    if (typeof fracao !== 'number' || !Number.isFinite(fracao)) return '—';
    return `${(100 * fracao).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

/** "x̄ ± margem" do IC da média, na escala de ms. */
export function formatarIntervalo(resumo: ResumoAmostra | null): string {
    if (!resumo?.ic) return '—';
    return `${formatarDuracaoMs(resumo.ic.inferior)} – ${formatarDuracaoMs(resumo.ic.superior)}`;
}
