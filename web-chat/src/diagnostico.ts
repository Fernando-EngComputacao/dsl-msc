import type {
    DiagnosticoIndeterminacao,
    FormalizacaoRegra,
    JulgamentoLLM,
    StatusDiagnostico,
    TipoInformacaoAusente,
    Veredito
} from './api';

/**
 * Como a tela lê o diagnóstico da indeterminação do juiz
 * (`julgamentoLLM.diagnostico`, ver src/inference/diagnostico-juiz.ts).
 *
 * Só apresentação: nada aqui decide, corrige ou completa o diagnóstico. A vista
 * existe apenas com o juiz UNRESOLVED e um diagnóstico com status conhecido;
 * fora disso, não há seção. O que vem de um JSONL importado é tratado como dado
 * solto: lista ausente vira lista vazia, item sem os campos de texto é ignorado
 * — a tela nunca quebra, e nada é inventado para preencher o que falta.
 */

export type GrupoEvidencia = 'observado' | 'conhecimento' | 'alegado' | 'plano' | 'julgamento';

export interface EvidenciaVista {
    referencia: string;
    descricao: string;
}

export interface InformacaoVista {
    tipo: TipoInformacaoAusente;
    rotuloTipo: string;
    explicacaoTipo: string;
    referencia: string;
    regra: string;
    formalizacao?: FormalizacaoRegra;
    descricao: string;
}

export interface CaminhoVista {
    condicoes: string;
    regras: string[];
    fundamentacao?: FormalizacaoRegra | 'nenhuma';
}

export interface VistaDiagnostico {
    status: StatusDiagnostico;
    rotuloStatus: string;
    /** Fora de DIAGNOSED: o aviso de que não há diagnóstico fundamentado (nunca um erro da avaliação). */
    aviso?: string;
    motivoIndeterminacao?: string;
    regrasAfetadas: { regra: string; formalizacao?: FormalizacaoRegra; motivo: string }[];
    /** Só os grupos com item, na ordem: observado, conhecimento, alegado, plano, julgamento. */
    evidencias: { grupo: GrupoEvidencia; rotulo: string; itens: EvidenciaVista[] }[];
    informacoesAusentes: InformacaoVista[];
    /** Só os resultados com caminho, na ordem VALID, INVALID, UNRESOLVED. */
    caminhos: { resultado: Veredito; itens: CaminhoVista[] }[];
    incertezaRemanescente?: string;
    limitacoesConhecimento: string[];
    limitacoesModelo: string[];
    referenciasRejeitadas: { secao: string; referencia: string; motivo: string }[];
    respostaBruta?: string;
    /** A resposta do diagnóstico foi lida (DIAGNOSED ou INSUFFICIENT_GROUNDING): as seções de conteúdo valem.
     *  Em MALFORMED e NO_RESPONSE não há conteúdo — só o aviso, as limitações do conhecimento e a auditoria. */
    respostaLida: boolean;
}

export const ROTULO_STATUS: Record<StatusDiagnostico, string> = {
    DIAGNOSED: 'fundamentado no conhecimento recuperado',
    INSUFFICIENT_GROUNDING: 'sem fundamentação suficiente',
    MALFORMED: 'resposta fora do formato',
    NO_RESPONSE: 'não disponível'
};

const AVISO_PADRAO: Record<Exclude<StatusDiagnostico, 'DIAGNOSED'>, string> = {
    INSUFFICIENT_GROUNDING: 'nenhum elemento da explicação se apoiou no conhecimento recuperado',
    MALFORMED: 'a resposta do diagnóstico não pôde ser lida',
    NO_RESPONSE: 'o diagnóstico não foi obtido'
};

export const ROTULO_GRUPO: Record<GrupoEvidencia, string> = {
    observado: 'Observado na leitura do cenário',
    conhecimento: 'Do conhecimento recuperado',
    alegado: 'Alegado no pedido — não é leitura do cenário',
    plano: 'Afirmado pelo plano avaliado',
    julgamento: 'Dito pelo LLM Judge'
};

const GRUPO_DA_FONTE: Record<string, GrupoEvidencia> = {
    telemetria: 'observado',
    regra: 'conhecimento',
    pedido: 'alegado',
    plano: 'plano',
    julgamento: 'julgamento'
};

export const TIPO_INFORMACAO: Record<TipoInformacaoAusente, { rotulo: string; explicacao: string }> = {
    campo_sem_valor: { rotulo: 'Campo sem valor', explicacao: 'o campo existe no modelo e é lido por uma regra formal, mas não foi medido neste cenário' },
    evidencia_insuficiente: { rotulo: 'Evidência insuficiente', explicacao: 'o dado existe, mas não basta para concluir' },
    fato_nao_observado: { rotulo: 'Fato não observado', explicacao: 'nenhum campo do modelo registra este fato' },
    regra_nao_formalizada: { rotulo: 'Regra não formalizada', explicacao: 'a regra só existe como texto: não é avaliada formalmente' }
};

export const ROTULO_FORMALIZACAO: Record<FormalizacaoRegra | 'nenhuma', string> = {
    formal: 'regra formal',
    parcial: 'parcialmente estruturada',
    texto: 'só texto',
    nenhuma: 'sem regra citada'
};

const STATUS: readonly StatusDiagnostico[] = ['DIAGNOSED', 'INSUFFICIENT_GROUNDING', 'MALFORMED', 'NO_RESPONSE'];
const RESULTADOS: readonly Veredito[] = ['VALID', 'INVALID', 'UNRESOLVED'];
const FORMALIZACOES: readonly string[] = ['formal', 'parcial', 'texto'];

const ehObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const texto = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const objetos = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(ehObjeto) : []);
const formalizacao = (v: unknown): FormalizacaoRegra | undefined => (typeof v === 'string' && FORMALIZACOES.includes(v) ? (v as FormalizacaoRegra) : undefined);

/** A vista do diagnóstico, ou `null` quando não há seção a mostrar (juiz não UNRESOLVED, avaliação antiga, status desconhecido). */
export function vistaDoDiagnostico(julgamento: JulgamentoLLM | undefined): VistaDiagnostico | null {
    if (julgamento?.status !== 'UNRESOLVED') return null;
    const d: unknown = julgamento.diagnostico;
    if (!ehObjeto(d) || !STATUS.includes(d.status as StatusDiagnostico)) return null;
    const bruto = d as Partial<DiagnosticoIndeterminacao> & Record<string, unknown>;
    const status = bruto.status as StatusDiagnostico;

    const regrasAfetadas = objetos(bruto.regrasAfetadas).flatMap(r => {
        const regra = texto(r.regra);
        return regra ? [{ regra, formalizacao: formalizacao(r.formalizacao), motivo: texto(r.motivo) ?? '' }] : [];
    });

    const porGrupo = new Map<GrupoEvidencia, EvidenciaVista[]>();
    for (const e of objetos(bruto.evidenciasDisponiveis)) {
        const grupo = typeof e.fonte === 'string' ? GRUPO_DA_FONTE[e.fonte] : undefined;
        const referencia = texto(e.referencia);
        if (!grupo || !referencia) continue;
        porGrupo.set(grupo, [...(porGrupo.get(grupo) ?? []), { referencia, descricao: texto(e.descricao) ?? '' }]);
    }
    const evidencias = (Object.keys(ROTULO_GRUPO) as GrupoEvidencia[])
        .filter(g => porGrupo.has(g))
        .map(grupo => ({ grupo, rotulo: ROTULO_GRUPO[grupo], itens: porGrupo.get(grupo)! }));

    const informacoesAusentes = objetos(bruto.informacoesAusentes).flatMap((i): InformacaoVista[] => {
        const tipo = typeof i.tipo === 'string' && i.tipo in TIPO_INFORMACAO ? (i.tipo as TipoInformacaoAusente) : undefined;
        const referencia = texto(i.referencia);
        if (!tipo || !referencia) return [];
        return [{
            tipo,
            rotuloTipo: TIPO_INFORMACAO[tipo].rotulo,
            explicacaoTipo: TIPO_INFORMACAO[tipo].explicacao,
            referencia,
            regra: texto(i.regra) ?? '',
            formalizacao: formalizacao(i.formalizacao),
            descricao: texto(i.descricao) ?? ''
        }];
    });

    const caminhos = RESULTADOS.map(resultado => ({
        resultado,
        itens: objetos(bruto.caminhosPossiveis)
            .filter(c => c.resultado === resultado && texto(c.condicoes))
            .map((c): CaminhoVista => ({
                condicoes: texto(c.condicoes)!,
                regras: Array.isArray(c.regras) ? c.regras.filter((r): r is string => typeof r === 'string' && r.trim().length > 0) : [],
                fundamentacao: c.fundamentacao === 'nenhuma' ? 'nenhuma' : formalizacao(c.fundamentacao)
            }))
    })).filter(c => c.itens.length > 0);

    const limitacoes = objetos(bruto.limitacoes).flatMap(l => {
        const descricao = texto(l.descricao);
        return descricao ? [{ origem: l.origem === 'modelo' ? 'modelo' : 'conhecimento', descricao }] : [];
    });
    const referenciasRejeitadas = objetos(bruto.referenciasRejeitadas).flatMap(r => {
        const referencia = texto(r.referencia);
        return referencia ? [{ secao: texto(r.secao) ?? '', referencia, motivo: texto(r.motivo) ?? '' }] : [];
    });

    const vista: VistaDiagnostico = {
        status,
        rotuloStatus: ROTULO_STATUS[status],
        ...(status === 'DIAGNOSED' ? {} : { aviso: texto(bruto.motivo) ?? AVISO_PADRAO[status] }),
        motivoIndeterminacao: texto(bruto.motivoIndeterminacao),
        regrasAfetadas,
        evidencias,
        informacoesAusentes,
        caminhos,
        incertezaRemanescente: texto(bruto.incertezaRemanescente),
        limitacoesConhecimento: limitacoes.filter(l => l.origem === 'conhecimento').map(l => l.descricao),
        limitacoesModelo: limitacoes.filter(l => l.origem === 'modelo').map(l => l.descricao),
        referenciasRejeitadas,
        respostaBruta: texto(bruto.respostaBruta),
        respostaLida: status === 'DIAGNOSED' || status === 'INSUFFICIENT_GROUNDING'
    };
    return vista;
}
