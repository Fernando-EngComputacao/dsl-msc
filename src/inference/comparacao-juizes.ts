/**
 * DOIS JUÍZES NO MESMO PLANO — o juiz local (Qwen, no motor do domínio) contra
 * um juiz de fronteira (Claude, GPT, Gemini, DeepSeek), com o oráculo
 * determinístico como referência normativa dos dois.
 *
 * É o que a tela de importação (`/avaliar?modo=importar`) produz: ela carrega um
 * `evalueted_*.jsonl` JÁ AVALIADO, rejulga os MESMOS planos com o modelo de
 * fronteira escolhido (ver juiz-fronteira.ts) e põe os dois julgamentos lado a
 * lado. A pergunta que isso responde é a acurácia do JUIZ, não a do plano: o
 * oráculo já disse se o plano vale, e aqui se mede quanto cada juiz acompanha o
 * oráculo e quanto os dois juízes concordam entre si.
 *
 * Camada pura, em cima de analise-avaliacao.ts: as contas (concordância, matriz
 * de confusão, precision/recall/F1, κ) são as MESMAS da sessão "Avaliação LLM",
 * com as mesmas fórmulas e os mesmos denominadores explícitos — o juiz de
 * fronteira entra como a fonte `llmFronteira` e nada é recalculado por fora.
 *
 * Nada aqui julga, reavalia ou corrige: o rejulgamento é quem chama o modelo, e
 * este módulo só casa os registros e conta. Plano sem par entre os dois arquivos
 * não é comparado — ele aparece em `semPar`, nunca com veredito emprestado.
 */

import {
    coberturaJuiz,
    comparar,
    distribuicao,
    fonteDoJulgamento,
    FONTES,
    LADOS,
    normalizarLinhas,
    type CoberturaJuiz,
    type Comparacao,
    type Distribuicao,
    type Lado
} from './analise-avaliacao.js';
import type { Veredito } from '../knowledge/validacao.js';
import type { RegistroAvaliacaoImportado } from './avaliacao-jsonl.js';
import type { DetalheLado, DetalheLinha, IdentidadeJuiz, JulgamentoLLM } from './avaliar-grafo.js';

// =============================================================================
// Pareamento: o plano do arquivo importado e o mesmo plano rejulgado
// =============================================================================

const chaveTexto = (texto: string | undefined): string => (texto ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** O que basta para reconhecer o mesmo plano nos dois arquivos. */
interface AlvoPareamento {
    sujeito?: string;
    intencao?: string;
    plano?: string;
    linha?: number;
}

/**
 * As chaves de pareamento, da mais específica para a menos. As três primeiras
 * são de CONTEÚDO (o rejulgamento recebe o plano e o pedido do próprio arquivo
 * importado, então elas casam sempre que os campos existem); `linha` é o último
 * recurso, porque a avaliação pode ter renumerado as linhas. Sem nenhuma chave,
 * o plano fica SEM PAR — nunca casado pela ordem.
 */
const NIVEIS: readonly ((a: AlvoPareamento) => string | null)[] = [
    a => (a.sujeito && a.intencao && a.plano ? `${a.sujeito}##${chaveTexto(a.intencao)}##${chaveTexto(a.plano)}` : null),
    a => (a.sujeito && a.intencao ? `${a.sujeito}##${chaveTexto(a.intencao)}` : null),
    a => (a.intencao && a.plano ? `${chaveTexto(a.intencao)}##${chaveTexto(a.plano)}` : null),
    a => (a.linha !== undefined ? `linha:${a.linha}` : null)
];

/**
 * Casa cada item de `novos` com um de `antigos`, nível a nível, cada antigo uma
 * vez só. Determinístico: a ordem dos arrays decide os empates.
 */
function parear<N extends AlvoPareamento, A extends AlvoPareamento>(novos: readonly N[], antigos: readonly A[]): Map<N, A> {
    const pares = new Map<N, A>();
    const livres = new Set<A>(antigos);

    for (const nivel of NIVEIS) {
        if (pares.size === novos.length || livres.size === 0) break;
        const indice = new Map<string, A[]>();
        for (const a of antigos) {
            if (!livres.has(a)) continue;
            const chave = nivel(a);
            if (chave === null) continue;
            const fila = indice.get(chave);
            if (fila) fila.push(a);
            else indice.set(chave, [a]);
        }
        for (const n of novos) {
            if (pares.has(n)) continue;
            const chave = nivel(n);
            if (chave === null) continue;
            const fila = indice.get(chave);
            const a = fila?.shift();
            if (!a) continue;
            livres.delete(a);
            pares.set(n, a);
        }
    }
    return pares;
}

export interface Pareamento {
    /** As linhas do rejulgamento, cada lado com `julgamentoAnterior` quando houve par. */
    linhas: DetalheLinha[];
    /** Planos rejulgados que acharam o julgamento anterior. */
    pareados: number;
    /** Planos rejulgados sem par no arquivo importado. */
    semPar: number;
    /** Registros do arquivo importado que nenhum plano rejulgado alcançou. */
    importadosSemPar: number;
}

/** Só o essencial do julgamento anterior; o texto fica no arquivo importado. */
const anterior = (r: RegistroAvaliacaoImportado): JulgamentoLLM | undefined => {
    const j = r.julgamentoLLM;
    if (!j || typeof j.status !== 'string') return undefined;
    return {
        status: j.status as JulgamentoLLM['status'],
        ...(typeof j.justificativa === 'string' ? { justificativa: j.justificativa } : {}),
        ...(Array.isArray(j.evidencias) ? { evidencias: j.evidencias.filter((e): e is string => typeof e === 'string') } : {}),
        ...(typeof j.motivo === 'string' ? { motivo: j.motivo } : {}),
        ...(typeof j.provedor === 'string' ? { provedor: j.provedor } : {}),
        ...(typeof j.modelo === 'string' ? { modelo: j.modelo } : {})
    };
};

/**
 * Anexa a cada plano rejulgado o julgamento que o arquivo importado já tinha
 * para ele. O resultado do rejulgamento não é alterado em mais nada: as linhas
 * voltam novas, com o mesmo conteúdo e o campo a mais.
 */
export function anexarJulgamentoAnterior(
    linhas: readonly DetalheLinha[],
    importados: readonly RegistroAvaliacaoImportado[]
): Pareamento {
    let pareados = 0;
    let semPar = 0;
    let importadosUsados = 0;
    let importadosElegiveis = 0;

    const novas: DetalheLinha[] = linhas.map(l => ({ ...l }));
    for (const lado of LADOS) {
        const alvos: Array<AlvoPareamento & { destino: DetalheLinha }> = [];
        for (const l of novas) {
            const d = l[lado];
            if (!d) continue;
            alvos.push({ sujeito: d.sujeito, intencao: l.intencao, plano: d.plano, linha: l.linha, destino: l });
        }
        const candidatos: Array<AlvoPareamento & { julgamento: JulgamentoLLM }> = [];
        for (const r of importados) {
            if (r.lado !== lado) continue;
            const julgamento = anterior(r);
            if (!julgamento) continue;
            candidatos.push({ sujeito: r.sujeito, intencao: r.intencao, plano: r.plano, linha: r.linha, julgamento });
        }
        importadosElegiveis += candidatos.length;

        const pares = parear(alvos, candidatos);
        for (const alvo of alvos) {
            const par = pares.get(alvo);
            if (!par) {
                semPar++;
                continue;
            }
            pareados++;
            importadosUsados++;
            alvo.destino[lado] = { ...alvo.destino[lado]!, julgamentoAnterior: par.julgamento };
        }
    }

    return { linhas: novas, pareados, semPar, importadosSemPar: importadosElegiveis - importadosUsados };
}

// =============================================================================
// A comparação
// =============================================================================

/** Um plano em que os dois juízes deram veredito e discordaram. */
export interface DivergenciaJuizes {
    linha: number;
    lado: Lado;
    sujeito?: string;
    intencao: string;
    /** O veredito normativo, quando existe. */
    oraculo?: Veredito;
    local: Veredito;
    fronteira: Veredito;
    /** Qual dos dois acompanha o oráculo (ausente sem veredito do oráculo). */
    acompanhaOraculo?: 'local' | 'fronteira' | 'nenhum';
    justificativaLocal?: string;
    justificativaFronteira?: string;
}

/** Sobre os planos em que o oráculo e OS DOIS juízes deram veredito. */
export interface ContraOraculo {
    /** O denominador: planos com os três vereditos. */
    n: number;
    /** Os dois juízes acompanham o oráculo. */
    ambos: number;
    /** Só o juiz local acompanha. */
    soLocal: number;
    /** Só o juiz de fronteira acompanha. */
    soFronteira: number;
    /** Nenhum dos dois acompanha. */
    nenhum: number;
}

export interface ComparacaoJuizes {
    /** Quem julgou no rejulgamento (o juiz de fronteira). */
    fronteira: IdentidadeJuiz;
    /** Planos no recorte (todos os planos rejulgados). */
    total: number;
    /** Planos que não têm OS DOIS juízes: ficam fora de toda comparação. */
    semPar: number;
    /** A distribuição dos vereditos de cada juiz. */
    distribuicoes: { local: Distribuicao; fronteira: Distribuicao };
    /** Quanto cada juiz respondeu (taxa de resposta e cobertura). */
    cobertura: { local: CoberturaJuiz; fronteira: CoberturaJuiz };
    /** Oráculo (referência) × juiz local — a concordância que o arquivo importado já media. */
    oraculoLocal: Comparacao;
    /** Oráculo (referência) × juiz de fronteira. */
    oraculoFronteira: Comparacao;
    /**
     * Juiz de fronteira como REFERÊNCIA × juiz local como avaliador: é esta a
     * leitura de "a acurácia do juiz local medida por um juiz mais forte".
     * O oráculo continua sendo a referência normativa — esta é uma segunda
     * leitura, entre avaliadores.
     */
    entreJuizes: Comparacao;
    /** Quem acompanha o oráculo, plano a plano. */
    contraOraculo: ContraOraculo;
    /** Os planos em que os dois juízes divergiram, do primeiro ao último. */
    divergencias: DivergenciaJuizes[];
}

const VEREDITOS: readonly string[] = ['VALID', 'INVALID', 'UNRESOLVED'];
const ehVeredito = (v: string | undefined): v is Veredito => v !== undefined && VEREDITOS.includes(v);

/**
 * Os dois julgamentos de um plano, cada um no lugar de QUEM o fez — a mesma
 * regra de `normalizarLinhas`: o `provedor` decide, não o nome do campo. Assim
 * um arquivo rejulgado dá a mesma leitura reaberto depois, com os juízes em
 * campos trocados, e as contas daqui não podem divergir das distribuições.
 */
function juizesDoPlano(d: DetalheLado): { local?: JulgamentoLLM; fronteira?: JulgamentoLLM } {
    const saida: { local?: JulgamentoLLM; fronteira?: JulgamentoLLM } = {};
    for (const bruto of [d.julgamentoLLM, d.julgamentoAnterior]) {
        if (!bruto) continue;
        const chave = fonteDoJulgamento(bruto) === 'llmFronteira' ? 'fronteira' : 'local';
        if (saida[chave] === undefined) saida[chave] = bruto;
    }
    return saida;
}

/**
 * As contas do rejulgamento. `linhas` são as do rejulgamento JÁ com
 * `julgamentoAnterior` (ver `anexarJulgamentoAnterior`); `fronteira` é quem
 * julgou agora.
 */
export function compararJuizes(
    linhas: readonly DetalheLinha[],
    fronteira: IdentidadeJuiz,
    dominio?: string
): ComparacaoJuizes {
    const planos = normalizarLinhas(linhas, dominio);

    const divergencias: DivergenciaJuizes[] = [];
    const contra: ContraOraculo = { n: 0, ambos: 0, soLocal: 0, soFronteira: 0, nenhum: 0 };
    let semPar = 0;

    for (const l of linhas) {
        for (const lado of LADOS) {
            const d = l[lado];
            if (!d) continue;
            const juizes = juizesDoPlano(d);
            if (!juizes.local || !juizes.fronteira) semPar++;
            const local = juizes.local?.status;
            const novo = juizes.fronteira?.status;
            if (!ehVeredito(local) || !ehVeredito(novo)) continue;

            const oraculo = d.oraculo?.veredito;
            let acompanha: DivergenciaJuizes['acompanhaOraculo'];
            if (ehVeredito(oraculo)) {
                const certoLocal = local === oraculo;
                const certoNovo = novo === oraculo;
                contra.n++;
                if (certoLocal && certoNovo) contra.ambos++;
                else if (certoLocal) contra.soLocal++;
                else if (certoNovo) contra.soFronteira++;
                else contra.nenhum++;
                acompanha = certoLocal ? 'local' : certoNovo ? 'fronteira' : 'nenhum';
            }

            if (local === novo) continue;
            divergencias.push({
                linha: l.linha,
                lado,
                ...(d.sujeito ? { sujeito: d.sujeito } : {}),
                intencao: l.intencao,
                ...(ehVeredito(oraculo) ? { oraculo } : {}),
                local,
                fronteira: novo,
                ...(acompanha ? { acompanhaOraculo: acompanha } : {}),
                ...(juizes.local?.justificativa ? { justificativaLocal: juizes.local.justificativa } : {}),
                ...(juizes.fronteira?.justificativa ? { justificativaFronteira: juizes.fronteira.justificativa } : {})
            });
        }
    }

    return {
        fronteira,
        total: planos.length,
        semPar,
        distribuicoes: {
            local: distribuicao(planos, FONTES.llmJudge),
            fronteira: distribuicao(planos, FONTES.llmFronteira)
        },
        cobertura: {
            local: coberturaJuiz(planos, 'llmJudge'),
            fronteira: coberturaJuiz(planos, 'llmFronteira')
        },
        oraculoLocal: comparar(planos, FONTES.oraculo, FONTES.llmJudge),
        oraculoFronteira: comparar(planos, FONTES.oraculo, FONTES.llmFronteira),
        entreJuizes: comparar(planos, FONTES.llmFronteira, FONTES.llmJudge),
        contraOraculo: contra,
        divergencias
    };
}
