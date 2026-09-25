/**
 * Contexto de Recuperacao — separa o que e LIDO por similaridade do que e
 * AVALIADO por comparacao.
 *
 * Ate aqui as duas metades da recuperacao (ver `graphrag*.ts`) recebiam entradas
 * diferentes sem que isso estivesse escrito em lugar nenhum:
 *
 *   - `retrieverFoco*` embute a `intencao` CRUA e so ela. Um pedido como
 *     "avaliar hipotensao persistente" chega ao indice vetorial sem PAM, sem o
 *     que ja esta em infusao e sem a populacao do paciente — exatamente os
 *     fatos que aproximariam o vetor do no certo.
 *   - `retrieve*Constraints` recebe o contexto inteiro e compara numero com
 *     limiar. Para ele a fala nao vale nada, e o numero tem de chegar intacto.
 *
 * Sao dois consumos legitimamente distintos da MESMA entrada, e a distincao
 * vivia implicita em quem chamava o que. Este modulo torna a separacao um tipo:
 *
 *     ContextoRecuperacao
 *        |-- consultaSemantica  -> embedding -> indice vetorial (aproximado)
 *        `-- contextoEstruturado -> Cypher / comparacao numerica (deterministico)
 *
 * REGRA QUE SUSTENTA A SEPARACAO: a consulta semantica NAO substitui a
 * telemetria estruturada. Ela pode citar "PAM 52" em prosa para melhorar a
 * similaridade, e ao mesmo tempo `contextoEstruturado.telemetria.PAM` continua
 * sendo o numero 52. Quem decide bloqueio le o numero; quem decide o que mostrar
 * le a prosa. Nenhum dos dois le o do outro.
 *
 * Duas consequencias praticas desta etapa:
 *
 *   - O identificador do sujeito (`PT-2026-0031`, `T-04`) FICA DE FORA da
 *     consulta semantica: e um ID interno, nao tem correspondente no indice, e
 *     so afasta o vetor dos nos de farmaco/protocolo. Ele e preservado exato em
 *     `contextoEstruturado.sujeito`, que e onde o Cypher o usa. A separacao
 *     existe justamente para isso.
 *   - Este modulo e uma PROJECAO: `origem` carrega o contexto do pipeline
 *     intacto, e nada aqui e fonte de verdade. Ninguem precisa deixar de usar
 *     `ClinicalContext`/`AgroContext`/`FutContext` para usar este tipo.
 *
 * Nada aqui conhece farmaco, produto ou infracao: o modulo fala em PAPEIS
 * (sujeito, enquadramento, estado de curso, sinais), como `politica.ts` ja faz.
 */

import type { ClinicalContext } from './graphrag.js';
import type { AgroContext } from './graphrag-agro.js';
import type { FutContext } from './graphrag-fut.js';
// Type-only (apagado na compilacao): `Dominio` ja existe e nao ha por que
// duplicar o literal em mais um arquivo. O lugar natural dele seria esta camada
// e nao a de avaliacao — mover exige um re-export em `avaliar-grafo.ts`, e nao e
// assunto desta etapa.
import type { Dominio } from '../inference/avaliar-grafo.js';
import { contemPalavra, montarDocumento, normalizar, numeroDeEnv, variantesDoNome } from './foco.js';

export type { Dominio };

/** Os tres contextos que o pipeline ja usa. Nenhum e alterado por este modulo. */
export type ContextoDominio = ClinicalContext | AgroContext | FutContext;

/**
 * Leitura dos campos que cada dominio nomeia a sua maneira. Derivado dos
 * proprios contextos (`Pick`), e nao redigitado: renomear `farmacosEmUso` em
 * `graphrag.ts` quebra aqui na compilacao, em vez de silenciosamente devolver
 * lista vazia.
 */
type CamposDoCenario = Partial<
    Pick<ClinicalContext, 'paciente' | 'populacoes' | 'farmacosEmUso'> &
        Pick<AgroContext, 'talhao' | 'areas' | 'produtosEmUso'> &
        Pick<FutContext, 'partida' | 'contextos' | 'infracoesEmUso'>
>;

/**
 * O lado DETERMINISTICO: os valores como o cenario os entregou, sem conversao.
 *
 * Numero continua numero, com a precisao que veio; o identificador do sujeito
 * continua a string exata; as listas continuam listas. E o que
 * `retrieve*Constraints` compara com limiar e o que um Cypher parametrizado
 * recebe como parametro — arredondar ou descrever aqui seria trocar o fato pela
 * impressao dele.
 */
export interface ContextoEstruturado {
    /** paciente | talhao | partida — o identificador, exato. */
    sujeito?: string;
    /** Parametro observado -> valor, exatamente como medido. */
    telemetria: Record<string, number>;
    /** populacoes | areas | contextos — em que o sujeito se enquadra. */
    enquadramentos: string[];
    /** farmacosEmUso | produtosEmUso | infracoesEmUso — o estado de curso. */
    emCurso: string[];
}

/**
 * A projecao que atravessa a recuperacao. `origem` mantem o contexto do
 * pipeline; os demais campos sao vistas dele.
 */
export interface ContextoRecuperacao {
    dominio: Dominio;
    /** A fala do profissional/operador, como foi digitada. */
    intencao: string;
    /** O texto que vai ao embedding — ver `montarConsultaSemantica`. */
    consultaSemantica: string;
    /** Atalho para `contextoEstruturado.sujeito`. */
    sujeito?: string;
    /** Atalho para `contextoEstruturado.telemetria` (o MESMO objeto). */
    telemetria: Record<string, number>;
    contextoEstruturado: ContextoEstruturado;
    /** O contexto do pipeline, intacto. A fonte de verdade continua sendo ele. */
    origem: ContextoDominio;
}

export interface OpcoesContextoRecuperacao {
    /**
     * Restringe quais parametros da telemetria entram na consulta SEMANTICA.
     * Ausente ou vazio: entram todos.
     *
     * Existe porque "telemetria relevante" so pode ser decidido por quem conhece
     * o modelo do especialista — e o modelo nao chega ate aqui. Em vez de
     * inventar um criterio de relevancia neste arquivo, a decisao fica
     * disponivel para quem a tem. O contexto ESTRUTURADO nunca e filtrado: o que
     * a comparacao deterministica ve nao depende desta opcao.
     */
    parametrosRelevantes?: string[];
}

// =============================================================================
// Vocabulario de composicao
// =============================================================================

/**
 * Como cada dominio se apresenta na consulta. Sao rotulos de PROSA, no mesmo
 * registro dos documentos que `documentos.ts` manda ao indice ("Populacoes
 * especiais", "Vias", "Vetado no protocolo") — sem acento, frases curtas.
 * Consulta e documento sao comparados pelo mesmo modelo: escrever os dois no
 * mesmo registro e o unico jeito de a distancia medir conteudo, e nao estilo.
 *
 * Nao sao os rotulos da interface (ver `/api/dominios` em `web/server.ts`),
 * que sao texto de tela e podem mudar sem afetar recuperacao nenhuma.
 */
const VOCABULARIO: Record<
    Dominio,
    { ambiente: string; enquadramento: string; emCurso: string; sinais: string }
> = {
    med: {
        ambiente: 'Ambiente clinico de terapia intensiva',
        enquadramento: 'Populacoes especiais',
        emCurso: 'Em infusao neste momento',
        // O PAPEL do sujeito ("paciente"), nunca o identificador dele. A palavra
        // corresponde a `PapeisDominio.campoSujeito`; nao a importamos daqui
        // para nao arrastar `graphrag*.ts` em runtime, mas as duas tem de
        // concordar — se o papel mudar num dominio, muda aqui tambem.
        sinais: 'Sinais do paciente'
    },
    agro: {
        ambiente: 'Pulverizacao aerea por drone',
        enquadramento: 'Areas especiais',
        emCurso: 'No tanque neste momento',
        sinais: 'Leitura do talhao'
    },
    fut: {
        ambiente: 'Arbitragem de futebol',
        enquadramento: 'Contextos da partida',
        emCurso: 'Ja marcadas nesta partida',
        sinais: 'Leitura da partida'
    }
};

/**
 * Teto de sinais na consulta semantica.
 *
 * Nao e um juizo sobre quais parametros importam clinicamente — e um limite de
 * DILUICAO: uma telemetria de quarenta campos afogaria a fala do usuario no meio
 * de numeros, e o vetor passaria a descrever o monitor em vez do pedido. O
 * contexto estruturado NUNCA e cortado por este teto; ele vale so para o texto
 * que vai ao embedding.
 */
const MAX_SINAIS = numeroDeEnv(process.env.SPC_CML_RAG_MAX_SINAIS, 8);

/** Espacos colapsados; o texto do usuario segue no mais intacto — acentos,
 *  maiusculas e pontuacao sao dele. */
function limpar(texto: string): string {
    return texto.trim().replace(/\s+/g, ' ');
}

/**
 * O numero como foi medido. NAO usa `formatarNumero` de `politica.ts`: aquele
 * arredonda e forca casa decimal porque produz LITERAL DE GRAMATICA, onde o
 * formato e a regra. Aqui o numero so vai ser lido, e "52" e o que o operador
 * reconhece — nao "52.0".
 */
function numero(valor: number): string {
    return String(valor);
}

function clausula(rotulo: string, itens: string[]): string | undefined {
    return itens.length > 0 ? `${rotulo}: ${itens.join(', ')}` : undefined;
}

/**
 * Quais sinais entram no TEXTO da consulta, e em que ordem.
 *
 * O criterio e ESTRUTURAL, e essa e a parte que nao pode escorregar: este modulo
 * nao sabe — e nao pode passar a saber — que 52 de PAM "e hipotensao". Julgar
 * isso e trabalho do Cypher contra os limiares da DSL. Aqui so se decide o que
 * ajuda a RECUPERAR, por tres criterios que nao envolvem juizo nenhum:
 *
 *   1. o chamador declarou explicitamente quais parametros interessam
 *      (`parametrosRelevantes`) — e o unico caminho que conhece o modelo do
 *      especialista, e por isso tem precedencia absoluta;
 *   2. o proprio usuario citou o parametro pelo nome na fala ("PAM 52 e lactato
 *      4.2: subo a nora?") — se ele escreveu, e relevante, e vai na frente;
 *   3. o resto entra na ordem em que o cenario o entregou, ate o teto.
 *
 * Nenhum valor e comparado com nada. Um PAM 52 e um PAM 82 recebem exatamente o
 * mesmo tratamento: os dois sao citados, com o numero que foi medido.
 *
 * Valor nao finito (NaN, Infinity) fica de fora do texto — nao e sinal, e
 * defeito de leitura. Continua intacto no contexto estruturado, onde quem sabe
 * o que fazer com ele decide.
 */
function sinaisParaTexto(
    telemetria: Record<string, number>,
    intencao: string,
    declarados?: string[]
): string[] {
    const entradas = Object.entries(telemetria).filter(([, v]) => Number.isFinite(v));

    if (declarados && declarados.length > 0) {
        const permitidos = new Set(declarados);
        return entradas
            .filter(([parametro]) => permitidos.has(parametro))
            .map(([parametro, valor]) => `${parametro} ${numero(valor)}`);
    }

    const texto = normalizar(intencao);
    const citado = (parametro: string): boolean => contemPalavra(texto, normalizar(parametro));

    // Estavel: `filter` preserva a ordem de origem dentro de cada grupo, entao a
    // mesma entrada produz sempre a mesma sequencia.
    const ordenadas = [
        ...entradas.filter(([p]) => citado(p)),
        ...entradas.filter(([p]) => !citado(p))
    ];

    return ordenadas
        .slice(0, MAX_SINAIS)
        .map(([parametro, valor]) => `${parametro} ${numero(valor)}`);
}

/** Le os campos do cenario pelos papeis, seja qual for o dominio. */
function camposDe(contexto: ContextoDominio): {
    sujeito?: string;
    enquadramentos: string[];
    emCurso: string[];
} {
    // Upcast, nao coercao: todo membro da uniao satisfaz `CamposDoCenario`,
    // porque ele e derivado dos tres.
    const c: CamposDoCenario = contexto;
    const sujeito = c.paciente ?? c.talhao ?? c.partida;
    return {
        sujeito: sujeito !== undefined && sujeito.trim().length > 0 ? sujeito : undefined,
        enquadramentos: [...(c.populacoes ?? c.areas ?? c.contextos ?? [])],
        emCurso: [...(c.farmacosEmUso ?? c.produtosEmUso ?? c.infracoesEmUso ?? [])]
    };
}

// =============================================================================
// Consulta semantica
// =============================================================================

/**
 * Compoe o texto que vai ao embedding, por segmentos fixos e nesta ordem:
 *
 *   1. a fala, como foi digitada — e o que se esta perguntando;
 *   2. o ambiente do dominio — ancora o registro;
 *   3. os enquadramentos do sujeito — sao NOS do grafo, e puxam o subgrafo deles;
 *   4. o estado de curso — tambem sao nos, e mudam a decisao licita;
 *   5. os sinais observados, em prosa.
 *
 * Determinismo: a mesma entrada produz sempre a mesma string. Dentro do bloco de
 * sinais, os parametros que o usuario citou pelo nome vem primeiro e o resto
 * segue na ordem em que o cenario os entregou (ver `sinaisParaTexto`); as duas
 * listas preservam a ordem de origem, entao nao ha empate a desempatar.
 *
 * O que NAO entra, por decisao: o identificador do sujeito (ID interno, sem
 * correspondente no indice), qualquer campo de controle do pipeline e qualquer
 * serializacao de estrutura. O criterio e simples — entra o que existe como no
 * no grafo ou como fato clinico/agronomico/de jogo; o resto e metadado.
 *
 * A montagem final usa `montarDocumento`, a MESMA funcao que monta os documentos
 * indexados em `documentos.ts`.
 */
export function montarConsultaSemantica(
    dominio: Dominio,
    contexto: ContextoDominio,
    parametrosRelevantes?: string[]
): string {
    const vocabulario = VOCABULARIO[dominio];
    const { enquadramentos, emCurso } = camposDe(contexto);
    const intencao = limpar(contexto.intencao ?? '');
    const sinais = sinaisParaTexto(contexto.telemetria, intencao, parametrosRelevantes);

    return montarDocumento([
        intencao,
        vocabulario.ambiente,
        // `variantesDoNome` acompanha o ID de gramatica da forma com espacos
        // (`Renal_Cronico (Renal Cronico)`), que e como o indice guarda o no e
        // como o usuario escreveria.
        clausula(vocabulario.enquadramento, enquadramentos.map(variantesDoNome)),
        clausula(vocabulario.emCurso, emCurso.map(variantesDoNome)),
        clausula(vocabulario.sinais, sinais)
    ]);
}

// =============================================================================
// Context Builder
// =============================================================================

/**
 * Constroi a projecao a partir do contexto que o pipeline ja montou.
 *
 * Nao le arquivo, nao consulta grafo, nao chama modelo: e uma funcao pura sobre
 * o que ja esta em memoria. O contexto de entrada nao e modificado.
 */
export function construirContextoRecuperacao(
    dominio: Dominio,
    contexto: ContextoDominio,
    opcoes: OpcoesContextoRecuperacao = {}
): ContextoRecuperacao {
    const { sujeito, enquadramentos, emCurso } = camposDe(contexto);

    // Copia rasa: os valores sao numeros, entao copiar preserva cada um
    // exatamente. O que a copia evita e o contexto estruturado mudar de valor
    // porque alguem mexeu no objeto original depois.
    const telemetria: Record<string, number> = { ...contexto.telemetria };

    const contextoEstruturado: ContextoEstruturado = {
        sujeito,
        telemetria,
        enquadramentos,
        emCurso
    };

    return {
        dominio,
        intencao: contexto.intencao ?? '',
        consultaSemantica: montarConsultaSemantica(dominio, contexto, opcoes.parametrosRelevantes),
        sujeito,
        // Mesmo objeto do contexto estruturado: uma telemetria so, dois caminhos
        // para ela.
        telemetria,
        contextoEstruturado,
        origem: contexto
    };
}
