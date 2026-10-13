/**
 * Diagnóstico da indeterminação do LLM Judge — explicação complementar, nunca
 * veredito.
 *
 * Quando o juiz responde UNRESOLVED (e só então), `avaliarPlano` faz uma segunda
 * chamada ao mesmo motor, `/diagnosticar-indeterminacao`, que explica por que o
 * juiz não concluiu, o que falta e sob que condições o plano poderia sustentar
 * VALID ou INVALID. O diagnóstico:
 *
 *   - não muda o status do juiz, o oráculo nem a classificação
 *     (`compararAvaliacoes` só lê `julgamentoLLM.status`): UNRESOLVED continua
 *     UNRESOLVED, e os caminhos são possibilidades explicativas, não vereditos;
 *   - não lê sintaxe, semântica nem oráculo: o mesmo contexto do juiz
 *     (`PedidoJuiz`), a resposta dele e o CATÁLOGO DE FUNDAMENTAÇÃO abaixo;
 *   - só pode citar o que o catálogo contém. A gramática do motor já restringe
 *     as referências aos identificadores do catálogo; `validarDiagnostico`
 *     confere de novo (defesa em profundidade, e o que vale para qualquer motor)
 *     e REJEITA, sem corrigir nem completar, o que não se apoia nele.
 *
 * O CATÁLOGO é determinístico e sai da MESMA recuperação que o juiz leu:
 *
 *   regras   as do Cypher (`RegraValidada`: condição estruturada, `formal`); os
 *            fatos da `vistaDoCenario` — `formal` quando sustentados por uma
 *            condição observada na telemetria, `parcial` quando a ligação é
 *            estruturada (item, contexto) mas nenhuma medida a decide, `texto`
 *            quando são só descrição (isenção, proibição); as relações entre
 *            itens (`parcial`: o par e a gravidade são estruturados, o
 *            mecanismo é texto) e as `regra_global` (`texto`).
 *   campos   os da telemetria do cenário, com valor, e os que uma regra formal lê
 *            sem que o cenário os tenha medido (as `lacunas` do Cypher) — o único
 *            "campo existente sem valor" que se pode afirmar.
 *
 * Identificadores: o `regraId` do Cypher quando há; senão, composto dos nomes da
 * DSL (`veto:Impedimento@Posicao_Legal_No_Passe`, `relacional:A + B`). As
 * `regra_global` não têm nome na DSL e ficam `regra_global#<n>`, na ordem da
 * recuperação.
 */

import { vistaDoCenario } from '../knowledge/decompositor.js';
import type { FatoRecuperado } from '../knowledge/item-geracao.js';
import type { RegraValidada } from '../knowledge/recuperacao-cypher.js';
import { explicarRegra } from '../knowledge/recuperacao-hibrida.js';
import type { Dominio } from '../knowledge/recuperacao.js';
import type { Veredito } from '../knowledge/validacao.js';
import { partesDaRelacao } from '../knowledge/validacao-global.js';
import type { PedidoJuiz } from './avaliar-grafo.js';
import type { AstArtefato } from './avaliar-sintaxe.js';
import { postarJsonNoMotor } from './motor-http.js';

// =============================================================================
// Catálogo de fundamentação
// =============================================================================

/** formal: condição estruturada sobre a telemetria; parcial: ligação estruturada sem medida que a decida; texto: só descrição. */
export type FormalizacaoRegra = 'formal' | 'parcial' | 'texto';

export type OrigemRegra = 'cypher' | 'restricao' | 'escalonamento' | 'relacional' | 'regra_global';

export interface RegraDoCatalogo {
    id: string;
    origem: OrigemRegra;
    formalizacao: FormalizacaoRegra;
    item?: string;
    descricao: string;
    /** Campos que a condição da regra lê. Vazio quando a regra não tem condição sobre a telemetria. */
    campos: string[];
}

export interface CampoDoCatalogo {
    campo: string;
    /** O valor medido no cenário. Ausente: o campo é lido por regra formal e o cenário não o mediu. */
    valor?: number;
    /** As regras do catálogo que leem o campo. */
    regras: string[];
}

/** Uma regra que o próprio plano cita (`alerta ... regra '...'`), e se ela existe no catálogo. */
export interface RegraCitadaPeloPlano {
    texto: string;
    noCatalogo: boolean;
}

export interface CatalogoFundamentacao {
    regras: RegraDoCatalogo[];
    campos: CampoDoCatalogo[];
    citadasPeloPlano: RegraCitadaPeloPlano[];
}

const escaparRegex = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Os campos medidos que aparecem, como palavra inteira, nas condições observadas. */
function camposCitados(condicoes: string[], medidos: string[]): string[] {
    return medidos.filter(campo => {
        const re = new RegExp(`(^|[^\\w])${escaparRegex(campo)}($|[^\\w])`);
        return condicoes.some(c => re.test(c));
    });
}

function formalizacaoDoFato(f: FatoRecuperado): FormalizacaoRegra {
    if (f.condicoes.length > 0) return 'formal';
    return f.tipo === 'isencao' || f.tipo === 'proibicao' ? 'texto' : 'parcial';
}

function descricaoDoFato(f: FatoRecuperado): string {
    return `${f.descricao}${f.origem ? ` (origem: ${f.origem})` : ''}${f.condicoes.length > 0 ? ` — observado: ${f.condicoes.join('; ')}` : ''}`;
}

/** As regras que o plano cita nos alertas, lidas do AST oficial (sem AST, nenhuma). */
function regrasCitadasNoAst(ast: AstArtefato | undefined): string[] {
    const alertas = ast?.['alerts'];
    if (!Array.isArray(alertas)) return [];
    const regras = alertas
        .map(a => (a && typeof a === 'object' ? (a as Record<string, unknown>)['rule'] : undefined))
        .filter((r): r is string => typeof r === 'string')
        .map(r => r.replace(/^(['"])([\s\S]*)\1$/, '$2').trim())
        .filter(r => r.length > 0);
    return [...new Set(regras)];
}

/**
 * O catálogo de um cenário: as regras e os campos que o diagnóstico pode citar.
 * `restricoes` e `regrasCypher` são os da recuperação que o juiz leu
 * (`conhecimento.constraints`, `auditoriaRecuperacao.validacao`).
 */
export function catalogoDeFundamentacao(
    dominio: Dominio,
    telemetria: Record<string, number>,
    restricoes: unknown,
    regrasCypher: readonly RegraValidada[],
    ast?: AstArtefato
): CatalogoFundamentacao {
    const regras: RegraDoCatalogo[] = [];
    const vistos = new Map<string, number>();
    const idUnico = (base: string): string => {
        const n = (vistos.get(base) ?? 0) + 1;
        vistos.set(base, n);
        return n === 1 ? base : `${base}#${n}`;
    };
    const medidos = Object.keys(telemetria);

    for (const r of regrasCypher) {
        const campos = [...new Set([...r.condicoesSatisfeitas, ...r.condicoesFalhas].map(c => c.campo).concat(r.lacunas.map(l => l.campo)))];
        regras.push({ id: idUnico(r.regraId), origem: 'cypher', formalizacao: 'formal', item: r.item, descricao: explicarRegra(r), campos });
    }

    const vista = vistaDoCenario(dominio, restricoes);
    for (const [item, fatos] of Object.entries(vista.fatosPorItem)) {
        for (const f of fatos) {
            regras.push({
                id: idUnico(`${f.tipo}:${item}${f.contexto ? `@${f.contexto}` : ''}`),
                origem: 'restricao',
                formalizacao: formalizacaoDoFato(f),
                item,
                descricao: descricaoDoFato(f),
                campos: camposCitados(f.condicoes, medidos)
            });
        }
    }
    for (const e of vista.escalonamentos) {
        const destino = e.descricao.split(':')[0].trim();
        regras.push({
            id: idUnico(`escalonamento:${destino}${e.contexto ? `@${e.contexto}` : ''}`),
            origem: 'escalonamento',
            formalizacao: formalizacaoDoFato(e),
            descricao: descricaoDoFato(e),
            campos: camposCitados(e.condicoes, medidos)
        });
    }
    for (const r of vista.relacionais) {
        const { estruturado, texto } = partesDaRelacao(r);
        regras.push({
            id: idUnico(`relacional:${r.entre}`),
            origem: 'relacional',
            formalizacao: 'parcial',
            descricao: `${estruturado.itens.join(' + ')} [${estruturado.gravidade}] — so o par e a gravidade sao estruturados; em texto: ${texto.mecanismo}${texto.conduta ? `; ${texto.conduta}` : ''}`,
            campos: []
        });
    }
    vista.regrasGlobais.forEach((g, i) =>
        regras.push({ id: idUnico(`regra_global#${i + 1}`), origem: 'regra_global', formalizacao: 'texto', descricao: `[${g.severidade}] ${g.descricao}`, campos: [] })
    );

    const campos = new Map<string, CampoDoCatalogo>(Object.entries(telemetria).map(([campo, valor]) => [campo, { campo, valor, regras: [] }]));
    for (const r of regras) {
        for (const c of r.campos) {
            const entrada = campos.get(c) ?? { campo: c, regras: [] };
            entrada.regras.push(r.id);
            campos.set(c, entrada);
        }
    }

    const ids = new Set(regras.map(r => r.id));
    return {
        regras,
        campos: [...campos.values()],
        citadasPeloPlano: regrasCitadasNoAst(ast).map(texto => ({ texto, noCatalogo: ids.has(texto) }))
    };
}

/** O catálogo como o modelo o lê: identificadores citáveis, campos e as regras que o plano cita. */
export function catalogoComoTexto(c: CatalogoFundamentacao): string {
    const regras = c.regras.map(
        r => `- ${r.id} [${r.formalizacao}; ${r.origem}${r.item ? `; item ${r.item}` : ''}]: ${r.descricao}${r.campos.length > 0 ? ` | campos: ${r.campos.join(', ')}` : ''}`
    );
    const campos = c.campos.map(k =>
        k.valor !== undefined ? `- ${k.campo} = ${k.valor}` : `- ${k.campo}: SEM VALOR neste cenario (lido por ${k.regras.join(', ')})`
    );
    const citadas = c.citadasPeloPlano.map(x => `- '${x.texto}': ${x.noCatalogo ? 'esta no catalogo' : 'NAO existe no conhecimento recuperado'}`);
    return [
        '[REGRAS — os unicos identificadores que podem ser citados]',
        ...(regras.length > 0 ? regras : ['(nenhuma)']),
        '',
        '[CAMPOS DO MODELO NESTE CENARIO]',
        ...(campos.length > 0 ? campos : ['(nenhum)']),
        ...(citadas.length > 0 ? ['', '[REGRAS CITADAS PELO PLANO]', ...citadas] : [])
    ].join('\n');
}

// =============================================================================
// Contrato do diagnóstico
// =============================================================================

/**
 * DIAGNOSED: há regra afetada ou informação ausente fundamentada no catálogo.
 * INSUFFICIENT_GROUNDING: nada da resposta se apoiou no catálogo (ou o catálogo
 * está vazio, e o modelo nem foi chamado). MALFORMED: a resposta não tem o
 * formato do contrato. NO_RESPONSE: falha técnica (motor, timeout, defeito
 * interno) — nunca confundida com a do juiz, que fica intacta.
 */
export type StatusDiagnostico = 'DIAGNOSED' | 'INSUFFICIENT_GROUNDING' | 'MALFORMED' | 'NO_RESPONSE';

/**
 * campo_sem_valor: campo do modelo, lido por regra formal, que o cenário não mediu.
 * evidencia_insuficiente: dado que existe (campo com valor ou regra), mas não basta.
 * fato_nao_observado: fato que nenhum campo do modelo registra, exigido por uma regra do catálogo.
 * regra_nao_formalizada: a regra que decidiria só existe em texto (ou só em parte estruturada).
 */
export type TipoInformacaoAusente = 'campo_sem_valor' | 'fato_nao_observado' | 'evidencia_insuficiente' | 'regra_nao_formalizada';

export type FonteEvidencia = 'telemetria' | 'regra' | 'pedido' | 'plano' | 'julgamento';

export type SecaoDiagnostico = 'regrasAfetadas' | 'evidenciasDisponiveis' | 'informacoesAusentes' | 'caminhosPossiveis';

export interface RegraAfetada {
    regra: string;
    formalizacao: FormalizacaoRegra;
    motivo: string;
}

export interface EvidenciaDisponivel {
    fonte: FonteEvidencia;
    /** Campo (telemetria), id de regra (regra) ou trecho literal da fonte (pedido, plano, julgamento). */
    referencia: string;
    descricao: string;
}

export interface InformacaoAusente {
    tipo: TipoInformacaoAusente;
    /** O campo, a regra ou o fato que falta. */
    referencia: string;
    /** A regra do catálogo que exige a informação — a fundamentação. */
    regra: string;
    formalizacao: FormalizacaoRegra;
    descricao: string;
}

export interface CaminhoPossivel {
    resultado: Veredito;
    condicoes: string;
    regras: string[];
    /** A melhor formalização entre as regras citadas; `nenhuma` só em UNRESOLVED. */
    fundamentacao: FormalizacaoRegra | 'nenhuma';
}

export interface LimitacaoDiagnostico {
    /** conhecimento: derivada do catálogo, determinística; modelo: escrita pelo modelo. */
    origem: 'conhecimento' | 'modelo';
    descricao: string;
}

export interface ReferenciaRejeitada {
    secao: SecaoDiagnostico;
    referencia: string;
    motivo: string;
}

/** Guardado em `julgamentoLLM.diagnostico`, só quando o juiz respondeu UNRESOLVED. */
export interface DiagnosticoIndeterminacao {
    status: StatusDiagnostico;
    /** Fora de DIAGNOSED: por que não há diagnóstico fundamentado. */
    motivo?: string;
    /** Por que o juiz não concluiu, nas palavras do modelo. */
    motivoIndeterminacao?: string;
    regrasAfetadas?: RegraAfetada[];
    evidenciasDisponiveis?: EvidenciaDisponivel[];
    informacoesAusentes?: InformacaoAusente[];
    caminhosPossiveis?: CaminhoPossivel[];
    incertezaRemanescente?: string;
    /** Sempre presente: as do catálogo e, com resposta legível, as do modelo. */
    limitacoes: LimitacaoDiagnostico[];
    /** O que a resposta citou e o catálogo não sustenta — fora do diagnóstico, registrado. */
    referenciasRejeitadas?: ReferenciaRejeitada[];
    /** A saída do modelo, sem tratamento — auditoria. */
    respostaBruta?: string;
}

/** O que o diagnóstico lê: o contexto do juiz, a resposta UNRESOLVED dele e o catálogo. */
export interface PedidoDiagnostico {
    juiz: PedidoJuiz;
    julgamento: { justificativa: string; evidencias: string[] };
    catalogo: CatalogoFundamentacao;
}

export interface RespostaDiagnosticoLLM {
    respostaBruta: string;
    /** A saída parou no teto de tokens do motor. */
    cortada?: boolean;
}

export type DiagnosticadorLLM = (pedido: PedidoDiagnostico, sinal: AbortSignal) => Promise<RespostaDiagnosticoLLM>;

// =============================================================================
// Limitações determinísticas do catálogo
// =============================================================================

export function limitacoesDoCatalogo(c: CatalogoFundamentacao): LimitacaoDiagnostico[] {
    const l: string[] = [];
    if (c.regras.length === 0) {
        l.push('o conhecimento recuperado nao tem regra a citar: nenhum diagnostico fundamentado e possivel');
    } else if (!c.regras.some(r => r.formalizacao === 'formal')) {
        l.push('nenhuma regra formal (condicao estruturada sobre a telemetria) foi recuperada para este cenario: nenhum caminho se apoia em avaliacao formal');
    }
    if (!c.campos.some(k => k.valor === undefined)) {
        l.push('nenhum campo lido por regra formal esta sem valor neste cenario: o diagnostico nao aponta medida especifica a registrar');
    }
    for (const x of c.citadasPeloPlano.filter(x => !x.noCatalogo)) {
        l.push(`o plano cita a regra '${x.texto}', que nao corresponde a nenhuma regra do conhecimento recuperado`);
    }
    return l.map(descricao => ({ origem: 'conhecimento', descricao }));
}

// =============================================================================
// Leitura e validação da resposta
// =============================================================================

class FormatoInvalido extends Error {}

const ehObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function objeto(v: unknown, onde: string): Record<string, unknown> {
    if (!ehObjeto(v)) throw new FormatoInvalido(`${onde} nao e objeto`);
    return v;
}

function texto(o: Record<string, unknown>, campo: string, onde: string): string {
    const v = o[campo];
    if (typeof v !== 'string' || !v.trim()) throw new FormatoInvalido(`${onde}.${campo} ausente ou vazio`);
    return v.trim();
}

function lista(o: Record<string, unknown>, campo: string, onde: string): unknown[] {
    const v = o[campo];
    if (!Array.isArray(v)) throw new FormatoInvalido(`${onde}.${campo} ausente ou nao e lista`);
    return v;
}

function umDe<T extends string>(o: Record<string, unknown>, campo: string, valores: readonly T[], onde: string): T {
    const v = o[campo];
    if (typeof v !== 'string' || !(valores as readonly string[]).includes(v)) {
        throw new FormatoInvalido(`${onde}.${campo} fora de ${valores.join(' | ')}: ${JSON.stringify(v)}`);
    }
    return v as T;
}

const FONTES: readonly FonteEvidencia[] = ['telemetria', 'regra', 'pedido', 'plano', 'julgamento'];
const TIPOS: readonly TipoInformacaoAusente[] = ['campo_sem_valor', 'fato_nao_observado', 'evidencia_insuficiente', 'regra_nao_formalizada'];
const RESULTADOS: readonly Veredito[] = ['VALID', 'INVALID', 'UNRESOLVED'];

/** A resposta no formato do contrato, ainda sem conferir referências. Fora do formato: `FormatoInvalido`, sem nada completado. */
interface RespostaLida {
    motivo: string;
    regrasAfetadas: { regra: string; motivo: string }[];
    evidenciasDisponiveis: EvidenciaDisponivel[];
    informacoesAusentes: { tipo: TipoInformacaoAusente; referencia: string; regra: string; descricao: string }[];
    caminhosPossiveis: { resultado: Veredito; condicoes: string; regras: string[] }[];
    incertezaRemanescente: string;
    limitacoes: string[];
}

function lerResposta(respostaBruta: string): RespostaLida {
    let valor: unknown;
    try {
        valor = JSON.parse(respostaBruta);
    } catch (erro) {
        throw new FormatoInvalido(`a resposta nao e JSON: ${(erro as Error).message}`);
    }
    const o = objeto(valor, 'diagnostico');
    return {
        motivo: texto(o, 'motivo', 'diagnostico'),
        regrasAfetadas: lista(o, 'regrasAfetadas', 'diagnostico').map((v, i) => {
            const x = objeto(v, `regrasAfetadas[${i}]`);
            return { regra: texto(x, 'regra', `regrasAfetadas[${i}]`), motivo: texto(x, 'motivo', `regrasAfetadas[${i}]`) };
        }),
        evidenciasDisponiveis: lista(o, 'evidenciasDisponiveis', 'diagnostico').map((v, i) => {
            const onde = `evidenciasDisponiveis[${i}]`;
            const x = objeto(v, onde);
            return { fonte: umDe(x, 'fonte', FONTES, onde), referencia: texto(x, 'referencia', onde), descricao: texto(x, 'descricao', onde) };
        }),
        informacoesAusentes: lista(o, 'informacoesAusentes', 'diagnostico').map((v, i) => {
            const onde = `informacoesAusentes[${i}]`;
            const x = objeto(v, onde);
            return { tipo: umDe(x, 'tipo', TIPOS, onde), referencia: texto(x, 'referencia', onde), regra: texto(x, 'regra', onde), descricao: texto(x, 'descricao', onde) };
        }),
        caminhosPossiveis: lista(o, 'caminhosPossiveis', 'diagnostico').map((v, i) => {
            const onde = `caminhosPossiveis[${i}]`;
            const x = objeto(v, onde);
            const regras = lista(x, 'regras', onde);
            if (!regras.every(r => typeof r === 'string')) throw new FormatoInvalido(`${onde}.regras tem item que nao e texto`);
            return { resultado: umDe(x, 'resultado', RESULTADOS, onde), condicoes: texto(x, 'condicoes', onde), regras: regras as string[] };
        }),
        incertezaRemanescente: texto(o, 'incertezaRemanescente', 'diagnostico'),
        limitacoes: lista(o, 'limitacoes', 'diagnostico').map((v, i) => {
            if (typeof v !== 'string' || !v.trim()) throw new FormatoInvalido(`limitacoes[${i}] ausente ou vazio`);
            return v.trim();
        })
    };
}

/** Sem acento, sem caixa, espaços colapsados: trecho "literal" da fonte, sem depender de formatação. */
function normalizar(t: string): string {
    return t.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Forma de nome de campo (`visao_do_lance`): um fato não observado não pode ser um campo que o modelo não tem. */
const FORMA_DE_CAMPO = /^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)+$/;

const ORDEM_FORMALIZACAO: Record<FormalizacaoRegra, number> = { formal: 0, parcial: 1, texto: 2 };

/** Os textos em que um trecho citado como evidência tem de aparecer. */
export interface FontesDoDiagnostico {
    pedido: string;
    plano: string;
    julgamento: string;
}

/**
 * Lê a resposta do diagnóstico e confere cada referência contra o catálogo. Fora
 * do formato: MALFORMED, com a resposta bruta e nada completado. No formato: o
 * que o catálogo não sustenta sai do diagnóstico e fica em
 * `referenciasRejeitadas`, com o motivo; o que sobra é o diagnóstico.
 */
export function validarDiagnostico(resposta: RespostaDiagnosticoLLM, catalogo: CatalogoFundamentacao, fontes: FontesDoDiagnostico): DiagnosticoIndeterminacao {
    const { respostaBruta } = resposta;
    const doCatalogo = limitacoesDoCatalogo(catalogo);

    let lida: RespostaLida;
    try {
        lida = lerResposta(respostaBruta);
    } catch (erro) {
        if (!(erro instanceof FormatoInvalido)) throw erro;
        const corte = resposta.cortada ? 'a resposta parou no teto de tokens do motor; ' : '';
        return { status: 'MALFORMED', motivo: `diagnostico fora do formato: ${corte}${erro.message}`, limitacoes: doCatalogo, respostaBruta };
    }

    const porId = new Map(catalogo.regras.map(r => [r.id, r]));
    const porCampo = new Map(catalogo.campos.map(k => [k.campo, k]));
    const rejeitadas: ReferenciaRejeitada[] = [];
    const rejeitar = (secao: SecaoDiagnostico, referencia: string, motivo: string): void => {
        rejeitadas.push({ secao, referencia, motivo });
    };
    const inexistente = (id: string): string => `a regra '${id}' nao existe no conhecimento recuperado`;
    const semCampo = (campo: string): string => `o campo '${campo}' nao existe no modelo deste cenario`;

    // Regras afetadas: só as do catálogo.
    const regrasAfetadas: RegraAfetada[] = [];
    for (const x of lida.regrasAfetadas) {
        const r = porId.get(x.regra);
        if (r) regrasAfetadas.push({ regra: r.id, formalizacao: r.formalizacao, motivo: x.motivo });
        else rejeitar('regrasAfetadas', x.regra, inexistente(x.regra));
    }

    // Evidências: campo com valor, regra do catálogo, ou trecho literal do pedido, do plano ou do julgamento.
    const conferirEvidencia = (e: EvidenciaDisponivel): string | undefined => {
        if (e.fonte === 'telemetria') {
            const k = porCampo.get(e.referencia);
            if (!k) return semCampo(e.referencia);
            return k.valor === undefined ? `o campo '${e.referencia}' nao tem valor neste cenario: nao e evidencia disponivel` : undefined;
        }
        if (e.fonte === 'regra') return porId.has(e.referencia) ? undefined : inexistente(e.referencia);
        return normalizar(fontes[e.fonte]).includes(normalizar(e.referencia)) ? undefined : `o trecho nao aparece no ${e.fonte}: evidencia nao fornecida`;
    };
    const evidenciasDisponiveis: EvidenciaDisponivel[] = [];
    for (const e of lida.evidenciasDisponiveis) {
        const motivo = conferirEvidencia(e);
        if (motivo) rejeitar('evidenciasDisponiveis', e.referencia, motivo);
        else evidenciasDisponiveis.push(e);
    }

    // Informações ausentes: sempre ligadas a uma regra do catálogo, e do tipo que a referência de fato é.
    const conferirInformacao = (x: RespostaLida['informacoesAusentes'][number], r: RegraDoCatalogo): string | undefined => {
        const k = porCampo.get(x.referencia);
        switch (x.tipo) {
            case 'campo_sem_valor':
                if (!k) return semCampo(x.referencia);
                if (k.valor !== undefined) return `o campo '${x.referencia}' tem valor (${k.valor}) neste cenario`;
                return r.campos.includes(x.referencia) ? undefined : `a regra '${r.id}' nao le o campo '${x.referencia}'`;
            case 'evidencia_insuficiente':
                if (k) return k.valor === undefined ? `o campo '${x.referencia}' nao tem valor: e campo_sem_valor, nao evidencia insuficiente` : undefined;
                return porId.has(x.referencia) ? undefined : `'${x.referencia}' nao e campo com valor nem regra do conhecimento recuperado`;
            case 'fato_nao_observado':
                if (k) return `'${x.referencia}' e campo do modelo: o que falta nele e campo_sem_valor ou evidencia_insuficiente`;
                return FORMA_DE_CAMPO.test(x.referencia) ? `${semCampo(x.referencia)}: um fato nao observado nao inventa campo` : undefined;
            case 'regra_nao_formalizada': {
                const alvo = porId.get(x.referencia);
                if (!alvo) return inexistente(x.referencia);
                return alvo.formalizacao === 'formal' ? `a regra '${alvo.id}' e formal: tem condicao estruturada` : undefined;
            }
        }
    };
    const informacoesAusentes: InformacaoAusente[] = [];
    for (const x of lida.informacoesAusentes) {
        const r = porId.get(x.regra);
        const motivo = r ? conferirInformacao(x, r) : inexistente(x.regra);
        if (motivo !== undefined) rejeitar('informacoesAusentes', x.referencia, motivo);
        else informacoesAusentes.push({ ...x, formalizacao: r!.formalizacao });
    }

    // Caminhos: VALID e INVALID só com regra do catálogo; UNRESOLVED pode não citar nenhuma.
    const derivadas: string[] = [];
    const caminhosPossiveis: CaminhoPossivel[] = [];
    for (const c of lida.caminhosPossiveis) {
        const validas: RegraDoCatalogo[] = [];
        for (const id of c.regras) {
            const r = porId.get(id);
            if (r) validas.push(r);
            else rejeitar('caminhosPossiveis', id, `${inexistente(id)} (caminho ${c.resultado})`);
        }
        if (c.resultado !== 'UNRESOLVED' && validas.length === 0) {
            rejeitar('caminhosPossiveis', c.resultado, `o caminho ${c.resultado} nao cita regra do conhecimento recuperado: sem fundamentacao, nao e apresentado`);
            continue;
        }
        const fundamentacao = validas.length === 0 ? 'nenhuma' : validas.map(r => r.formalizacao).sort((a, b) => ORDEM_FORMALIZACAO[a] - ORDEM_FORMALIZACAO[b])[0];
        caminhosPossiveis.push({ resultado: c.resultado, condicoes: c.condicoes, regras: validas.map(r => r.id), fundamentacao });
        if (c.resultado !== 'UNRESOLVED' && fundamentacao === 'texto') {
            derivadas.push(`o caminho ${c.resultado} se apoia so em regra em texto livre (${validas.map(r => r.id).join(', ')}): e explicacao, sem avaliacao formal`);
        }
    }

    const emTexto = [...new Set([...regrasAfetadas, ...informacoesAusentes.map(i => ({ regra: i.regra, formalizacao: i.formalizacao }))].filter(r => r.formalizacao === 'texto').map(r => r.regra))];
    if (emTexto.length > 0) derivadas.unshift(`regra(s) so em texto livre no diagnostico (${emTexto.join(', ')}): servem de evidencia, nao sao avaliadas formalmente`);

    const fundamentado = regrasAfetadas.length > 0 || informacoesAusentes.length > 0;
    return {
        status: fundamentado ? 'DIAGNOSED' : 'INSUFFICIENT_GROUNDING',
        ...(fundamentado ? {} : { motivo: 'nenhuma regra afetada nem informacao ausente da resposta se apoia no conhecimento recuperado' }),
        motivoIndeterminacao: lida.motivo,
        regrasAfetadas,
        evidenciasDisponiveis,
        informacoesAusentes,
        caminhosPossiveis,
        incertezaRemanescente: lida.incertezaRemanescente,
        limitacoes: [
            ...doCatalogo,
            ...derivadas.map(descricao => ({ origem: 'conhecimento' as const, descricao })),
            ...lida.limitacoes.map(descricao => ({ origem: 'modelo' as const, descricao }))
        ],
        referenciasRejeitadas: rejeitadas,
        respostaBruta
    };
}

/**
 * O diagnóstico de UMA indeterminação. Catálogo sem regra: o modelo nem é
 * chamado (não haveria o que citar). Falha da chamada: NO_RESPONSE, com o
 * motivo; cancelamento (`sinal`) propaga. Nunca lança por resposta ruim.
 */
export async function diagnosticarIndeterminacao(pedido: PedidoDiagnostico, diagnosticador: DiagnosticadorLLM, sinal: AbortSignal): Promise<DiagnosticoIndeterminacao> {
    const { catalogo } = pedido;
    if (catalogo.regras.length === 0) {
        return {
            status: 'INSUFFICIENT_GROUNDING',
            motivo: 'o conhecimento recuperado nao tem regra a citar: o diagnostico nao foi pedido ao modelo',
            limitacoes: limitacoesDoCatalogo(catalogo)
        };
    }
    let resposta: RespostaDiagnosticoLLM;
    try {
        resposta = await diagnosticador(pedido, sinal);
    } catch (erro) {
        if (sinal.aborted) throw erro;
        return { status: 'NO_RESPONSE', motivo: `Falha ao diagnosticar com o modelo local: ${(erro as Error).message}`, limitacoes: limitacoesDoCatalogo(catalogo) };
    }
    return validarDiagnostico(resposta, catalogo, {
        pedido: pedido.juiz.pedido,
        plano: pedido.juiz.plano,
        julgamento: [pedido.julgamento.justificativa, ...pedido.julgamento.evidencias].join('\n')
    });
}

// =============================================================================
// O diagnosticador real
// =============================================================================

/**
 * `POST /diagnosticar-indeterminacao` no motor do domínio (ver
 * python_engine/diagnostico.py). O motor decodifica sob uma gramática que só
 * deixa citar os identificadores enviados aqui, e devolve a saída sem
 * interpretá-la: a leitura e a conferência são de `validarDiagnostico`.
 */
export function diagnosticadorLLMHttp(motor: string, timeoutMs: number): DiagnosticadorLLM {
    return async (pedido, sinal) => {
        const { juiz, julgamento, catalogo } = pedido;
        const corpo = {
            plano: juiz.plano,
            intencao: juiz.pedido,
            telemetria: juiz.telemetria,
            contexto_neo4j: juiz.conhecimento,
            evidencias: juiz.evidencias,
            justificativa_juiz: julgamento.justificativa,
            evidencias_juiz: julgamento.evidencias,
            catalogo: catalogoComoTexto(catalogo),
            regras: catalogo.regras.map(r => r.id),
            regras_formais: catalogo.regras.filter(r => r.formalizacao === 'formal').map(r => r.id),
            regras_nao_formais: catalogo.regras.filter(r => r.formalizacao !== 'formal').map(r => r.id),
            campos_com_valor: catalogo.campos.filter(k => k.valor !== undefined).map(k => k.campo),
            campos_sem_valor: catalogo.campos.filter(k => k.valor === undefined).map(k => k.campo)
        };
        const r = (await postarJsonNoMotor(motor, '/diagnosticar-indeterminacao', corpo, timeoutMs, sinal)) as { resposta_bruta?: unknown; cortada?: unknown };
        if (typeof r.resposta_bruta !== 'string') throw new Error('motor respondeu sem resposta_bruta');
        return { respostaBruta: r.resposta_bruta, cortada: r.cortada === true };
    };
}
