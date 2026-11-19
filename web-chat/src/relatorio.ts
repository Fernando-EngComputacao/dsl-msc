/**
 * Exportação do relatório do "Resultado da avaliação" — quais tópicos entram no PDF.
 *
 * Só a lógica: a lista de tópicos, o que está DISPONÍVEL no resultado em mão, a
 * seleção e os dados da capa. A tela (RelatorioModal.vue) mostra, e as duas
 * telas de resultado (AvaliarResultados.vue e ResultadosImportados.vue) usam o
 * mesmo módulo — o relatório é o mesmo nas duas.
 *
 * COMO O PDF É FEITO: não há biblioteca de PDF aqui. Os tópicos escolhidos
 * continuam sendo as MESMAS seções já renderizadas na tela (nada é redesenhado
 * para o papel: o que sai no PDF é o que se vê), as não escolhidas são
 * escondidas, e a janela de impressão do navegador ("Salvar como PDF") grava o
 * arquivo. Texto vetorial, sem rasterizar gráfico e sem dependência nova.
 *
 * REGRA: tópico sem dado no arquivo não é oferecido — fica desabilitado com o
 * motivo. Um relatório com uma página escrita "sem medições" é pior do que um
 * relatório que não traz a seção, e a decisão fica visível para quem exporta.
 */
import type { RespostaAvaliacao } from './api';
import { ladosPresentes, pilhaDeTempos, tempoPorPlano, tempoPorTamanho } from './tempos-plano';

/** Um tópico do relatório. Granularidade fina: as 5 seções de tempo entram separadas. */
export type TopicoRelatorio =
    | 'capa'
    | 'metricas'
    | 'analise'
    | 'graficos'
    | 'estatisticos'
    | 'tempoGeracao'
    | 'tempoAvaliacao'
    | 'tempoPilha'
    | 'tempoTamanho'
    | 'tempoPlano';

export type GrupoRelatorio = 'documento' | 'resultado' | 'tempo';

/**
 * A seção da tela onde o tópico mora — as mesmas chaves de `AbaResultado`
 * (NavegacaoResultado.vue), sem `todas`. Fica aqui como literal, e não
 * importada do .vue, para este módulo ser carregável fora do bundler (os testes
 * rodam em tsx).
 */
export type SecaoDaTela = 'metricas' | 'analise' | 'graficos' | 'avaliacaoLlm' | 'tempo';

export interface DefinicaoTopico {
    chave: TopicoRelatorio;
    rotulo: string;
    /** O que a seção traz — aparece no modal, para a escolha não ser às cegas. */
    descricao: string;
    grupo: GrupoRelatorio;
    /** A aba em que a seção aparece na tela; `capa` não existe na tela. */
    secao?: SecaoDaTela;
}

export const GRUPOS: Record<GrupoRelatorio, { nome: string; descricao: string }> = {
    documento: { nome: 'Documento', descricao: 'Identificação do relatório' },
    resultado: { nome: 'Resultado', descricao: 'Métricas, linhas avaliadas e estatística' },
    tempo: { nome: 'Tempo', descricao: 'As cinco análises da aba Tempo' }
};

export const TOPICOS: readonly DefinicaoTopico[] = [
    {
        chave: 'capa',
        rotulo: 'Capa e identificação',
        descricao: 'Domínio, arquivo avaliado, data da exportação, contagem de planos e a lista de tópicos incluídos',
        grupo: 'documento'
    },
    {
        chave: 'metricas',
        rotulo: 'Métricas consolidadas',
        descricao: 'Os cartões por lado: sintaxe, semântica, oráculo, LLM Judge, concordância e violações',
        grupo: 'resultado',
        secao: 'metricas'
    },
    {
        chave: 'analise',
        rotulo: 'Comparação por linha',
        descricao: 'A tabela cenário por cenário; as linhas que estiverem expandidas na tela saem expandidas no PDF',
        grupo: 'resultado',
        secao: 'analise'
    },
    {
        chave: 'graficos',
        rotulo: 'Gráficos',
        descricao: 'Distribuição dos vereditos e da concordância entre oráculo e juiz',
        grupo: 'resultado',
        secao: 'graficos'
    },
    {
        chave: 'estatisticos',
        rotulo: 'Testes estatísticos',
        descricao: 'Concordância (Kappa), testes de hipótese e o diagnóstico do LLM Judge, com a metodologia',
        grupo: 'resultado',
        secao: 'avaliacaoLlm'
    },
    {
        chave: 'tempoGeracao',
        rotulo: 'Tempo de geração dos planos',
        descricao: 'Total da geração e, no modo multiagente, as parcelas de sequências, PIs válidas e validação',
        grupo: 'tempo',
        secao: 'tempo'
    },
    {
        chave: 'tempoAvaliacao',
        rotulo: 'Tempo da avaliação',
        descricao: 'Total da avaliação e as parcelas de sintaxe, oráculo, LLM Judge e diagnóstico',
        grupo: 'tempo',
        secao: 'tempo'
    },
    {
        chave: 'tempoPilha',
        rotulo: 'Tempo total da pilha',
        descricao: 'Geração + avaliação, parcela por parcela, com o custo do gate à parte',
        grupo: 'tempo',
        secao: 'tempo'
    },
    {
        chave: 'tempoTamanho',
        rotulo: 'Tempo por tamanho do input',
        descricao: 'Tempo por caractere e por token, com correlação e regressão entre tamanho e tempo',
        grupo: 'tempo',
        secao: 'tempo'
    },
    {
        chave: 'tempoPlano',
        rotulo: 'Tempo de um plano',
        descricao: 'Geração + validação no gate por plano: média, desvio padrão, intervalo de confiança e quartis',
        grupo: 'tempo',
        secao: 'tempo'
    }
];

/** Resultado vazio: deixa as telas calcularem disponibilidade/capa antes de haver resultado. */
export const SEM_RESULTADO: RespostaAvaliacao = { naoAvaliados: 0, linhas: [] };

export type SelecaoRelatorio = Record<TopicoRelatorio, boolean>;

function selecao(valor: boolean): SelecaoRelatorio {
    return Object.fromEntries(TOPICOS.map(t => [t.chave, valor])) as SelecaoRelatorio;
}

export const selecaoTotal = (): SelecaoRelatorio => selecao(true);
export const selecaoVazia = (): SelecaoRelatorio => selecao(false);

export function definicaoTopico(chave: TopicoRelatorio): DefinicaoTopico {
    const achado = TOPICOS.find(t => t.chave === chave);
    if (!achado) throw new Error(`tópico desconhecido: ${chave}`);
    return achado;
}

/** Os tópicos marcados, na ordem do relatório. */
export function topicosSelecionados(sel: SelecaoRelatorio): DefinicaoTopico[] {
    return TOPICOS.filter(t => sel[t.chave]);
}

export function contarSelecionados(sel: SelecaoRelatorio): number {
    return topicosSelecionados(sel).length;
}

/** Os tópicos de um grupo, na ordem do relatório. */
export function topicosDoGrupo(grupo: GrupoRelatorio): DefinicaoTopico[] {
    return TOPICOS.filter(t => t.grupo === grupo);
}

export interface SituacaoTopico {
    disponivel: boolean;
    /** Por que não dá para incluir — mostrado no modal, ao lado do tópico desabilitado. */
    motivo?: string;
}

export type DisponibilidadeRelatorio = Record<TopicoRelatorio, SituacaoTopico>;

const DISPONIVEL: SituacaoTopico = { disponivel: true };
const ausente = (motivo: string): SituacaoTopico => ({ disponivel: false, motivo });

/**
 * O que este resultado tem para contar. As seções de tempo são consultadas pelas
 * MESMAS funções que as desenham (`pilhaDeTempos`, `tempoPorTamanho`,
 * `tempoPorPlano`): se a seção diria "sem medições", o tópico não é oferecido.
 */
export function disponibilidade(resposta: RespostaAvaliacao): DisponibilidadeRelatorio {
    const temLado = !!(resposta.arquitetura || resposta.baseline);
    const semLado = ausente('nenhum lado avaliado neste resultado');
    const lados = ladosPresentes(resposta);

    const temAlgum = (...valores: (number | undefined)[]): boolean => valores.some(v => typeof v === 'number');

    return {
        capa: DISPONIVEL,
        metricas: temLado ? DISPONIVEL : semLado,
        analise: resposta.linhas.length > 0 ? DISPONIVEL : ausente('nenhuma linha avaliada'),
        graficos: temLado ? DISPONIVEL : semLado,
        estatisticos: temLado ? DISPONIVEL : semLado,
        tempoGeracao: temAlgum(
            resposta.tempoGeracaoTotalSegundos,
            resposta.tempoGeracaoSequenciasSegundos,
            resposta.tempoGeracaoPIsValidasSegundos,
            resposta.tempoGeracaoValidacaoPlanosSegundos
        )
            ? DISPONIVEL
            : ausente('o arquivo não traz tempos de geração'),
        tempoAvaliacao: temAlgum(
            resposta.tempoTotalSegundos,
            resposta.tempoSintaxeSegundos,
            resposta.tempoOraculoSegundos,
            resposta.tempoLlmJudgeSegundos,
            resposta.tempoDiagnosticoSegundos
        )
            ? DISPONIVEL
            : ausente('o arquivo não traz tempos de avaliação'),
        tempoPilha: pilhaDeTempos(resposta).algumaMedida ? DISPONIVEL : ausente('nenhuma parcela da pilha foi medida'),
        tempoTamanho: lados.some(l => tempoPorTamanho(resposta, l).algumaMedida)
            ? DISPONIVEL
            : ausente('nenhum plano tem tempo de geração e tamanho medidos'),
        tempoPlano: lados.some(l => tempoPorPlano(resposta, l).algumaMedida)
            ? DISPONIVEL
            : ausente('nenhum plano tem tempo medido')
    };
}

/** Desliga o que não existe; mantém o resto como estava. */
export function ajustarSelecao(sel: SelecaoRelatorio, disp: DisponibilidadeRelatorio): SelecaoRelatorio {
    return Object.fromEntries(
        TOPICOS.map(t => [t.chave, sel[t.chave] === true && disp[t.chave].disponivel])
    ) as SelecaoRelatorio;
}

/** Tudo o que este resultado tem, marcado. É o que o modal abre mostrando. */
export function selecaoPadrao(disp: DisponibilidadeRelatorio): SelecaoRelatorio {
    return ajustarSelecao(selecaoTotal(), disp);
}

/** Capa sozinha não é relatório: precisa de ao menos um tópico de conteúdo. */
export function podeGerar(sel: SelecaoRelatorio, disp: DisponibilidadeRelatorio): boolean {
    return TOPICOS.some(t => t.chave !== 'capa' && sel[t.chave] === true && disp[t.chave].disponivel);
}

export const NOME_DOMINIO: Record<string, string> = {
    med: 'Clínico (UTI) — uti.dsl',
    agro: 'Agrícola (drone) — lavoura.agro',
    fut: 'Arbitragem (futebol) — futebol.fut'
};

function doisDigitos(n: number): string {
    return n.toString().padStart(2, '0');
}

/**
 * O nome do arquivo. Vira o `document.title` antes de imprimir, que é o que o
 * navegador sugere ao salvar como PDF — é o único jeito de influenciar esse
 * nome sem gerar o PDF por conta própria.
 */
export function nomeDoRelatorio(opcoes: { dominio?: string; em?: Date } = {}): string {
    const d = opcoes.em ?? new Date();
    const data = `${d.getFullYear()}-${doisDigitos(d.getMonth() + 1)}-${doisDigitos(d.getDate())}`;
    const hora = `${doisDigitos(d.getHours())}h${doisDigitos(d.getMinutes())}`;
    return `relatorio-avaliacao-${opcoes.dominio ?? 'spc-cml'}-${data}_${hora}`;
}

export interface ResumoCapa {
    titulo: string;
    /** Data e hora da exportação, já formatadas em pt-BR. */
    geradoEm: string;
    /** Linhas de identificação: o que foi avaliado. */
    itens: { rotulo: string; valor: string }[];
    /** Os rótulos dos tópicos incluídos, na ordem do relatório (a capa não se lista). */
    topicos: string[];
}

/** Os dados da capa. Nada de inventado: campo ausente no resultado não vira linha. */
export function resumoDaCapa(
    resposta: RespostaAvaliacao,
    sel: SelecaoRelatorio,
    opcoes: { dominio?: string; em?: Date } = {}
): ResumoCapa {
    const d = opcoes.em ?? new Date();
    const itens: { rotulo: string; valor: string }[] = [];

    if (opcoes.dominio) itens.push({ rotulo: 'Domínio', valor: NOME_DOMINIO[opcoes.dominio] ?? opcoes.dominio });
    if (resposta.arquivoJsonl) itens.push({ rotulo: 'Arquivo', valor: resposta.arquivoJsonl });

    const lados = ladosPresentes(resposta).map(l => (l === 'arquitetura' ? 'Arquitetura SPC-CML' : 'Baseline'));
    if (lados.length) itens.push({ rotulo: lados.length > 1 ? 'Lados avaliados' : 'Lado avaliado', valor: lados.join(' e ') });

    itens.push({ rotulo: 'Cenários', valor: String(resposta.linhas.length) });

    const planos = (resposta.arquitetura?.total ?? 0) + (resposta.baseline?.total ?? 0);
    if (planos > 0) itens.push({ rotulo: 'Planos avaliados', valor: String(planos) });
    if (resposta.naoAvaliados > 0) itens.push({ rotulo: 'Não avaliados', valor: String(resposta.naoAvaliados) });

    return {
        titulo: 'Relatório da avaliação — SPC-CML',
        geradoEm: d.toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' }),
        itens,
        topicos: topicosSelecionados(sel)
            .filter(t => t.chave !== 'capa')
            .map(t => t.rotulo)
    };
}
