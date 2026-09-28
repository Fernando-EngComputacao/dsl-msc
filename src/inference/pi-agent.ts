/**
 * PI Agent — o segundo agente cognitivo da arquitetura multiagente.
 *
 *     ContextoGeracaoItem (um PI)
 *        -> montarPromptPIAgent   o contexto DAQUELE PI + regras de saida + formato
 *        -> MotorPIAgent          POST /generate-pi: o MESMO `_gerar` do motor, sob
 *                                 a gramatica do PI (`gramatica_do_pi`), derivada
 *                                 no motor do payload do PI
 *        -> lerSaidaPIAgent       saida bruta -> ResultadoPI (sem correcao)
 *        -> validarPI             ResultadoPI x contexto do PI (validacao-pi.ts)
 *
 * O Planner escolheu o par (item, conduta), a ordem e as dependencias; o PI
 * Agent escolhe a ACAO — decisao, meio, valor — e escreve a JUSTIFICATIVA. Nada
 * alem disso. A separacao esta em quatro lugares, de proposito redundantes: no
 * prompt, na gramatica (ordem, conduta e item sao literais; decisao, meio e
 * valor saem das listas do PI), no parser (que recusa PI, item, conduta ou
 * ordem trocados) e na validacao (`validarResultadoPI` confere o par).
 *
 * FORMATO: a clausula da propria DSL, com a identidade do PI na frente —
 *
 *     PI 1 | Manter_Bloqueio | ordem Propofol decisao MANTER_BLOQUEADO dose 0.0 mg/kg/h
 *          via ACESSO_CENTRAL justificativa '...' FIM
 *
 * Nao e um formato paralelo: e a `ordem`/`aplicacao`/`marcacao` que o artefato ja
 * usa, lida pelos papeis do dominio, e que a composicao vai usar como esta. A
 * justificativa e o `texto` da DSL — o unico campo livre, entre aspas simples.
 *
 * SEM PREFIXO. O prompt nao traz artefato parcial, clausula aceita nem outro PI:
 * so o contexto do PI. E o que permite, adiante, resolver PIs em qualquer ordem.
 *
 * POR ONDAS, EM SERIE. `resolverPIs` segue as ondas do DAG (`pi-scheduler.ts`):
 * um PI so comeca com todos os predecessores VALID, e PIs independentes ficam na
 * mesma onda, qualquer que seja a ordem deles. Dentro da onda, um PI por vez, na
 * ordem do Planner — sem `Promise.all`, worker nem processo extra; o
 * `_LLAMA_LOCK` do motor nao muda. A retentativa e so do PI que falhou: o
 * historico, a restricao progressiva e o feedback de um PI nunca tocam outro.
 *
 * NADA DE COMPOSICAO. Com todos os PIs validos, a execucao guarda
 * `resultadosPI` e para em PI_ALL_VALID. `montarArtefato` e o contrato do
 * artefato inteiro sao do proximo estagio.
 */

import {
    textoDaClausula,
    validarResultadoPI,
    type CodigoContratoPI,
    type ResultadoPI
} from '../knowledge/contrato-pi.js';
import { montarPromptPI } from '../knowledge/decompositor.js';
import type { ContextoGeracaoItem } from '../knowledge/item-geracao.js';
import type { SubgrafoPodado } from '../knowledge/politica.js';
import {
    invalido,
    naoResolvido,
    type ProblemaValidacao,
    type ResultadoValidacao
} from '../knowledge/validacao.js';
import { relatorioDoPI, restringirAposErrosPI, validarPI } from '../knowledge/validacao-pi.js';
import {
    avancarStatus,
    type ContextoExecucaoMultiagente,
    type FasePI,
    type MetricasPI,
    type TentativaPI
} from './multiagente.js';
import { executarOndas, registrosDeOndas, type DesfechoPI } from './pi-scheduler.js';

// =============================================================================
// Prompt
// =============================================================================

/** A linha de formato: o que a gramatica do PI gera, com os campos a escolher entre < >. */
export function formatoPI(c: ContextoGeracaoItem): string {
    const p = c.subgrafoDoItem.papeis;
    return `PI ${c.pi!.ordem} | ${c.pi!.conduta} | ${p.clausula} ${c.pi!.item} ${p.decisao} <decisao> ` +
        `${p.campoQuantidade} <valor> <unidade> ${p.meio} <${p.meio}> justificativa '<texto>' FIM`;
}

/**
 * O prompt do PI Agent: o contexto do PI (`montarPromptPI`, o mesmo que o
 * Decompositor mede), o papel, as regras de saida e o formato. Muito menor que
 * o do Planner: nao traz o Prompt Semantico global, a politica inteira, outro
 * PI, o artefato nem exemplares.
 *
 * Entre tentativas, o prompt base e o MESMO: so a secao
 * [FEEDBACK DA VALIDACAO ANTERIOR] entra, com o que a validacao reprovou. A
 * restricao progressiva vai a gramatica (payload), nao ao texto base.
 */
export function montarPromptPIAgent(c: ContextoGeracaoItem, feedback?: string): string {
    if (!c.pi || !c.conduta) throw new Error('montarPromptPIAgent recebe o contexto de um PI (saida de decomporPIs)');
    const p = c.subgrafoDoItem.papeis;
    return [
        'Voce e um PI Agent. Resolva SOMENTE o PI abaixo: escolha UMA acao admissivel e justifique-a.',
        'O item, a conduta, a ordem e as dependencias ja foram decididos pelo Planner e validados: nao os altere.',
        '',
        montarPromptPI(c),
        '',
        '[REGRAS DE SAIDA]',
        '- escolha exatamente UMA decisao de DECISOES ADMISSIVEIS;',
        `- use um ${p.meio} da lista e um valor listado para a decisao escolhida, escritos exatamente como aparecem;`,
        '- a justificativa diz por que a decisao e sustentada: cite a regra, a evidencia e a telemetria acima, com os valores e as unidades exatamente como aparecem;',
        '- a justificativa tem uma ou duas frases curtas e completas, em portugues;',
        '- nao invente regra, protocolo, medida nem valor que nao esteja acima;',
        '- nao altere ordem, item nem conduta; nao produza outro PI nem outra acao;',
        '- a justificativa vai entre aspas simples, sem aspa simples dentro;',
        '- responda somente no formato abaixo, em uma linha.',
        ...(feedback ? ['', '[FEEDBACK DA VALIDACAO ANTERIOR]', feedback] : []),
        '',
        '[FORMATO]',
        formatoPI(c),
        '',
        'resposta:',
        ''
    ].join('\n');
}

// =============================================================================
// Leitura da saida
// =============================================================================

export type CodigoPIAgent =
    | 'saida_vazia'
    | 'cabecalho_ausente'
    | 'terminador_ausente'
    | 'multiplos_pis'
    | 'multiplas_acoes'
    | 'campo_ausente'
    | 'acao_malformada'
    | 'decisao_desconhecida'
    | 'meio_desconhecido';

/** Os codigos da leitura: os do protocolo e os do contrato estrutural do resultado. */
export type CodigoLeituraPIAgent = CodigoPIAgent | CodigoContratoPI;

type Problema = ProblemaValidacao<CodigoLeituraPIAgent>;

function escapar(texto: string): string {
    return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trecho(texto: string): string {
    const t = texto.trim().replace(/\s+/g, ' ');
    return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

/** Quantas vezes a palavra aparece inteira. */
function ocorrencias(texto: string, palavra: string): number {
    return [...texto.matchAll(new RegExp(`(?<![A-Za-z0-9_])${escapar(palavra)}(?![A-Za-z0-9_])`, 'g'))].length;
}

/**
 * Le a saida bruta do PI Agent para o PI do contexto.
 *
 *   1. So espaco em branco nas pontas e removido.
 *   2. `PI <ordem> | <conduta> |` no inicio, `FIM` no fim, e entre eles UMA
 *      clausula da DSL, com todos os campos, na ordem da gramatica.
 *   3. Ordem, conduta ou item diferentes dos do PI: INVALID (`pi_divergente`).
 *      Segundo PI, segunda clausula ou mais de uma decisao: INVALID.
 *   4. Decisao fora do universo do dominio e meio fora do vocabulario do
 *      dominio: INVALID (desconhecidos). Decisao ou meio CONHECIDOS mas nao
 *      admissiveis para este PI passam: isso e da validacao do PI.
 *   5. O que foi lido passa pelo contrato estrutural (`validarResultadoPI`):
 *      numero fora do formato da gramatica, justificativa vazia ou com aspa.
 *
 * Nada e corrigido nem aproximado: nome parecido nao e o nome, e texto livre
 * nao e garimpado.
 */
export function lerSaidaPIAgent(
    bruto: string,
    c: ContextoGeracaoItem
): ResultadoValidacao<ResultadoPI, CodigoLeituraPIAgent> {
    if (!c.pi || !c.conduta) throw new Error('lerSaidaPIAgent recebe o contexto de um PI (saida de decomporPIs)');
    const pi = c.pi;
    const papeis = c.subgrafoDoItem.papeis;
    const recusar = (codigo: CodigoLeituraPIAgent, mensagem: string) =>
        invalido<ResultadoPI, CodigoLeituraPIAgent>([{ codigo, mensagem, pi: pi.ordem, item: pi.item, conduta: pi.conduta } as Problema]);

    const texto = bruto.trim();
    if (texto.length === 0) return recusar('saida_vazia', 'o PI Agent nao devolveu nada');
    // A justificativa e texto livre: as contagens de palavra-chave ignoram o que esta entre aspas.
    const semTexto = texto.replace(/'[^']*'/g, "''");

    if (!/^PI\s/.test(texto)) {
        return recusar('cabecalho_ausente', `a saida precisa comecar com "PI ${pi.ordem} | ${pi.conduta} |"; comecou com "${trecho(texto)}"`);
    }
    if ([...semTexto.matchAll(/(?<![A-Za-z0-9_])PI\s+\S+\s*\|/g)].length > 1 || ocorrencias(semTexto, 'FIM') > 1) {
        return recusar('multiplos_pis', 'a saida traz mais de um PI: o PI Agent resolve so o seu');
    }
    if (!/(^|\s)FIM$/.test(texto)) {
        return recusar('terminador_ausente', `a saida precisa terminar com FIM; terminou com "${trecho(texto.slice(-80))}"`);
    }

    const cabecalho = /^PI\s+(\S+)\s*\|\s*([^|\s]+)\s*\|\s*/.exec(texto);
    if (!cabecalho) return recusar('cabecalho_ausente', `cabecalho fora do protocolo: "${trecho(texto)}"`);
    if (!/^[0-9]+$/.test(cabecalho[1]) || Number(cabecalho[1]) < 1) {
        return recusar('ordem_invalida', `a ordem do PI precisa ser inteiro >= 1 (veio ${cabecalho[1]})`);
    }
    if (Number(cabecalho[1]) !== pi.ordem) {
        return recusar('pi_divergente', `a saida responde ao PI ${cabecalho[1]}, e este e o PI ${pi.ordem}: a ordem nao e do PI Agent`);
    }
    if (cabecalho[2] !== pi.conduta) {
        return recusar('pi_divergente', `a saida traz a conduta ${cabecalho[2]}, e o Planner fixou ${pi.conduta}: a conduta nao e do PI Agent`);
    }

    const corpo = texto.slice(cabecalho[0].length, texto.length - 'FIM'.length).trim();
    const corpoSemTexto = corpo.replace(/'[^']*'/g, "''");
    const campos = [papeis.clausula, papeis.decisao, papeis.campoQuantidade, papeis.meio, 'justificativa'];
    if (ocorrencias(corpoSemTexto, papeis.clausula) > 1 || ocorrencias(corpoSemTexto, papeis.decisao) > 1) {
        return recusar('multiplas_acoes', 'a saida traz mais de uma acao: cada PI produz exatamente uma decisao');
    }
    const ausentes = campos.filter(k => ocorrencias(corpoSemTexto, k) === 0);
    if (ausentes.length > 0) return recusar('campo_ausente', `faltam os campos ${ausentes.join(', ')} na acao`);

    const entreDecisaoEQuantidade = new RegExp(
        `(?<![A-Za-z0-9_])${escapar(papeis.decisao)}\\s+(.*?)\\s+${escapar(papeis.campoQuantidade)}(?![A-Za-z0-9_])`
    ).exec(corpoSemTexto);
    if (entreDecisaoEQuantidade && entreDecisaoEQuantidade[1].trim().split(/\s+/).length > 1) {
        return recusar('multiplas_acoes', `mais de uma decisao ou alternativa no campo decisao: "${trecho(entreDecisaoEQuantidade[1])}"`);
    }

    const clausula = new RegExp(
        `^${escapar(papeis.clausula)}\\s+(\\S+)\\s+${escapar(papeis.decisao)}\\s+(\\S+)\\s+${escapar(papeis.campoQuantidade)}\\s+` +
            `(\\S+)\\s+(\\S+)\\s+${escapar(papeis.meio)}\\s+(\\S+)\\s+justificativa\\s+'([^']*)'$`
    ).exec(corpo);
    if (!clausula) {
        return recusar('acao_malformada', `a acao precisa ser "${papeis.clausula} <item> ${papeis.decisao} <decisao> ${papeis.campoQuantidade} <valor> <unidade> ${papeis.meio} <${papeis.meio}> justificativa '<texto>'"; veio "${trecho(corpo)}"`);
    }
    const [, item, decisao, valor, unidade, meio, justificativa] = clausula;
    if (item !== pi.item) {
        return recusar('pi_divergente', `a acao e para ${item}, e o PI e de ${pi.item}: o item nao e do PI Agent`);
    }
    const decisoesConhecidas = new Set([...c.decisoes.admissiveis, ...c.decisoes.bloqueadas, ...c.decisoes.foraDaConduta, ...c.conduta.decisoes]);
    if (!decisoesConhecidas.has(decisao)) {
        return recusar('decisao_desconhecida', `${decisao} nao e decisao do dominio; admissiveis neste PI: ${c.decisoes.admissiveis.join(', ')}`);
    }
    const meiosConhecidos = [...c.meios.admissiveis, ...c.meios.foraDoItem];
    if (meiosConhecidos.length > 0 && !meiosConhecidos.includes(meio)) {
        return recusar('meio_desconhecido', `${meio} nao e ${papeis.meio} do dominio; admissiveis neste PI: ${c.meios.admissiveis.join(', ')}`);
    }

    return validarResultadoPI(
        { ordem: pi.ordem, item, conduta: pi.conduta, acao: { decisao, meio, valor: { valor, unidade } }, justificativa },
        pi
    );
}

/** O resultado de volta ao formato do protocolo, para o PI Agent ver o que propos. */
export function comoProtocoloPI(r: ResultadoPI, c: ContextoGeracaoItem): string {
    return `PI ${r.ordem} | ${r.conduta} | ${textoDaClausula(r, c.subgrafoDoItem.papeis)} FIM`;
}

// =============================================================================
// Chamada ao modelo
// =============================================================================

/** Corpo de `POST /generate-pi` (ver python_engine/main.py). */
export interface PedidoPIAgent {
    prompt: string;
    /** O payload do PI: `subgrafoDoItem`, ja com a restricao progressiva desta tentativa. */
    subgrafo_regras: SubgrafoPodado;
    ordem: number;
    conduta: string;
}

/** Resposta de `POST /generate-pi`. `saida` e crua. */
export interface RespostaPIAgent {
    saida: string;
    valida_na_gramatica?: boolean;
    erro?: string | null;
    tokens_prompt?: number | null;
    regras_na_gramatica?: number;
    gbnf?: string;
}

/** Quem gera a acao. Injetavel para teste sem motor nem GPU; o real e `motorPIAgentHttp`. */
export type MotorPIAgent = (pedido: PedidoPIAgent) => Promise<RespostaPIAgent>;

export interface TentativaExecutada {
    /** O prompt enviado — a entrada exata do modelo. */
    prompt: string;
    /** A saida como o modelo a devolveu. */
    bruto: string;
    leitura: ResultadoValidacao<ResultadoPI, CodigoLeituraPIAgent>;
    metricas: MetricasPI;
    /** A GBNF que mascarou a geracao, quando o motor a informa. */
    gbnf?: string;
}

export interface OpcoesExecucaoPI {
    /** Feedback da tentativa anterior do MESMO PI. */
    feedback?: string;
    /**
     * A vista restrita desta tentativa (`restringirAposErrosPI`). So o payload
     * dela vai ao motor; o prompt base continua sendo o do contexto original.
     */
    restrito?: ContextoGeracaoItem;
    agora?: () => number;
}

/**
 * UMA tentativa do PI Agent para UM PI: monta o prompt, pede ao motor sob a
 * gramatica do PI (derivada no motor do payload) e le a saida.
 *
 * Nao valida semanticamente, nao tenta de novo, nao toca outro PI nem a
 * sequencia, nao compoe nada. Falha tecnica do motor sobe como excecao; saida
 * fora do protocolo volta como INVALID, com a saida bruta preservada.
 */
export async function executarPI(
    contexto: ContextoGeracaoItem,
    motor: MotorPIAgent,
    opcoes: OpcoesExecucaoPI = {}
): Promise<TentativaExecutada> {
    const agora = opcoes.agora ?? (() => performance.now());
    const vista = opcoes.restrito ?? contexto;
    const prompt = montarPromptPIAgent(contexto, opcoes.feedback);
    const inicio = agora();
    const resposta = await motor({
        prompt,
        subgrafo_regras: vista.subgrafoDoItem,
        ordem: contexto.pi!.ordem,
        conduta: contexto.pi!.conduta
    });
    const duracaoMs = Math.round(agora() - inicio);
    const bruto = typeof resposta.saida === 'string' ? resposta.saida : '';
    const leitura = lerSaidaPIAgent(bruto, vista);

    const metricas: MetricasPI = { caracteresPrompt: prompt.length, duracaoMs };
    if (typeof resposta.tokens_prompt === 'number') metricas.tokensPrompt = resposta.tokens_prompt;
    if (typeof resposta.valida_na_gramatica === 'boolean') metricas.validaNaGramatica = resposta.valida_na_gramatica;
    if (opcoes.feedback) metricas.caracteresFeedback = opcoes.feedback.length;
    return { prompt, bruto, leitura, metricas, gbnf: resposta.gbnf };
}

// =============================================================================
// Realimentacao
// =============================================================================

function recorte(texto: string, limite = 400): string {
    const t = texto.trim();
    return t.length > limite ? `${t.slice(0, limite)}…` : t;
}

/**
 * O feedback que vai na secao [FEEDBACK DA VALIDACAO ANTERIOR] da proxima
 * tentativa do MESMO PI. `c` e a vista da proxima tentativa — ja restrita —,
 * para as decisoes e valores listados serem os que a gramatica vai admitir.
 * So entra o que a validacao reprovou na tentativa anterior deste PI.
 */
export function montarFeedbackPI(
    fase: FasePI,
    bruto: string,
    validacao: ResultadoValidacao,
    c: ContextoGeracaoItem
): string {
    const fecho = ['Gere novamente SOMENTE o resultado deste PI.'];
    if (fase === 'protocolo') {
        return [
            'A saida anterior NAO respeitou o protocolo do PI Agent.',
            `saida anterior: ${recorte(bruto)}`,
            'problemas:',
            ...validacao.erros.map(e => `- ${e.codigo}: ${e.mensagem}`),
            `Responda somente no formato: ${formatoPI(c)}`,
            ...fecho
        ].join('\n');
    }
    const valores = c.decisoes.admissiveis.map(d => {
        const vs = c.valores.porDecisao[d] ?? c.valores.gerais;
        return `${d}: ${vs.length > 0 ? vs.map(v => `${v.valor} ${v.unidade}`).join(', ') : '(livre)'}`;
    });
    return [
        'O resultado anterior foi REJEITADO pela validacao deste PI.',
        `resultado anterior: ${recorte(bruto)}`,
        'erros:',
        relatorioDoPI(validacao.erros as ProblemaValidacao<never>[]),
        `decisoes admissiveis agora: ${c.decisoes.admissiveis.join(', ')}`,
        `valores admissiveis: ${valores.join(' | ')}`,
        ...fecho
    ].join('\n');
}

// =============================================================================
// Orquestracao: onda por onda, um PI por vez, retry so do PI que falhou
// =============================================================================

/**
 * PI_DECOMPOSED -> (PI_EXECUTING -> PI_VALIDATING)+ -> PI_ALL_VALID, ou UNRESOLVED.
 *
 * Os PIs sao resolvidos pelas ondas do DAG (`ctx.planoExecucaoPI`, via
 * `executarOndas`): uma onda so comeca com a anterior terminada, e um PI so
 * comeca com todos os predecessores VALID. Dentro da onda, um PI por vez, na
 * ordem do Planner. Para cada um:
 *
 *     PI_EXECUTING -> executarPI -> PI_VALIDATING -> leitura + validarPI
 *        VALID       -> guarda o resultado; o proximo PI liberado
 *        UNRESOLVED  -> UNRESOLVED (outra tentativa nao supre dado que falta)
 *        INVALID     -> feedback + restricao progressiva -> PI_EXECUTING do MESMO PI,
 *                       se houver orcamento (`orcamento.porPI`); senao UNRESOLVED
 *
 * O retry nao regenera nenhum outro PI: o resultado, o historico e a vista de
 * cada PI sao so dele. O primeiro PI que termina sem ser VALID encerra a
 * execucao; os dependentes dele ficam PENDENTES e aparecem em `bloqueados` na
 * onda deles. `ctx.resultadosPI` fica na ordem do Planner, qualquer que tenha
 * sido a da execucao. A guarda de PI_EXECUTING (`impedimentoDeExecutarPI`)
 * recusa PI com predecessor nao VALID e tentativa alem do orcamento. Falha
 * tecnica do motor marca o PI FAILED e sobe como excecao — o orquestrador a
 * transforma em FAILED.
 */
export async function resolverPIs(
    ctx: ContextoExecucaoMultiagente,
    motor: MotorPIAgent,
    agora: () => number = () => performance.now()
): Promise<void> {
    if (ctx.status !== 'PI_DECOMPOSED' || !ctx.contextosPI) {
        throw new Error(`os PI Agents comecam em PI_DECOMPOSED, com os contextos de PI (status ${ctx.status})`);
    }
    if (!ctx.planoExecucaoPI) throw new Error('os PI Agents precisam do DAG dos PIs (planoExecucaoPI), montado na decomposicao');
    ctx.execucoesPI = ctx.contextosPI.map(c => ({
        ordem: c.pi!.ordem, item: c.pi!.item, conduta: c.pi!.conduta, status: 'PENDENTE', tentativas: [], proibidas: []
    }));
    ctx.ondasPI = registrosDeOndas(ctx.planoExecucaoPI);
    const posicao = new Map(ctx.contextosPI.map((c, i) => [c.pi!.ordem, i]));

    const execucao = await executarOndas(
        ctx.planoExecucaoPI,
        ctx.ondasPI,
        ordem => resolverUmPI(ctx, posicao.get(ordem)!, posicao, motor, agora),
        agora
    );
    if (execucao.desfecho !== 'VALID') return; // o PI que parou ja levou a execucao a UNRESOLVED

    avancarStatus(ctx, 'PI_ALL_VALID', `${ctx.resultadosPI.length} PI(s) com resultado valido em ${ctx.ondasPI.length} onda(s)`);
}

/**
 * UM PI, com o seu retry, ate o desfecho: VALID, UNRESOLVED ou INVALID com o
 * orcamento esgotado (nos dois ultimos a execucao ja foi a UNRESOLVED). E o laco
 * que `resolverPIs` sempre teve para cada PI, sem mudanca de semantica.
 */
async function resolverUmPI(
    ctx: ContextoExecucaoMultiagente,
    i: number,
    posicao: ReadonlyMap<number, number>,
    motor: MotorPIAgent,
    agora: () => number
): Promise<DesfechoPI> {
    const contexto = ctx.contextosPI![i];
    const execucao = ctx.execucoesPI[i];
    let restrito = contexto;
    let feedback: string | undefined;

    for (;;) {
        const numero = execucao.tentativas.length + 1;
        const rotulo = `PI ${execucao.ordem} (${execucao.item} -> ${execucao.conduta}), tentativa ${numero}`;
        avancarStatus(ctx, 'PI_EXECUTING', rotulo);
        execucao.status = 'EM_EXECUCAO';
        let executada: TentativaExecutada;
        try {
            executada = await executarPI(contexto, motor, { feedback, restrito, agora });
        } catch (erro) {
            execucao.status = 'FAILED';
            throw erro;
        }
        avancarStatus(ctx, 'PI_VALIDATING', rotulo);

        let fase: FasePI = 'protocolo';
        let validacao: ResultadoValidacao<ResultadoPI> = executada.leitura;
        let duracaoValidacaoMs: number | undefined;
        if (executada.leitura.veredito === 'VALID') {
            fase = 'semantica';
            const inicio = agora();
            const julgada = validarPI(executada.leitura.valor!, restrito);
            duracaoValidacaoMs = Math.round((agora() - inicio) * 1000) / 1000;
            validacao = { ...julgada, avisos: [...executada.leitura.avisos, ...julgada.avisos] };
        }

        const tentativa: TentativaPI = {
            ordem: execucao.ordem,
            tentativa: numero,
            prompt: executada.prompt,
            saida: executada.bruto,
            fase,
            validacao,
            admissiveis: [...restrito.decisoes.admissiveis],
            metricas: duracaoValidacaoMs === undefined ? executada.metricas : { ...executada.metricas, duracaoValidacaoMs },
            ...(executada.leitura.valor ? { resultado: executada.leitura.valor } : {})
        };
        execucao.tentativas.push(tentativa);

        if (validacao.veredito === 'VALID') {
            execucao.status = 'VALID';
            execucao.resultado = validacao.valor!;
            // Na ordem do Planner, nao na da execucao: e dela que a composicao le.
            const depois = ctx.resultadosPI.findIndex(r => posicao.get(r.ordem)! > i);
            if (depois < 0) ctx.resultadosPI.push(validacao.valor!);
            else ctx.resultadosPI.splice(depois, 0, validacao.valor!);
            return 'VALID';
        }
        ctx.errosValidacao.push(validacao);
        if (validacao.veredito === 'UNRESOLVED') {
            execucao.status = 'UNRESOLVED';
            avancarStatus(ctx, 'UNRESOLVED', `PI ${execucao.ordem}: conhecimento insuficiente para validar o resultado: ${validacao.dadosFaltantes.join('; ')}`);
            return 'UNRESOLVED';
        }

        execucao.status = 'INVALID';
        const codigos = validacao.erros.map(e => e.codigo).join(', ');
        const proxima = fase === 'semantica' ? restringirAposErrosPI(restrito, validacao) : { contexto: restrito, proibidas: [] };
        const proximoFeedback = montarFeedbackPI(fase, executada.bruto, validacao, proxima.contexto);
        if (execucao.tentativas.length >= ctx.orcamento.porPI) {
            // Orcamento esgotado: o historico fica, e o feedback que iria para a
            // proxima tentativa vira o prompt recomendado do UNRESOLVED.
            ctx.errosValidacao.push(
                naoResolvido([`resultado valido para o PI ${execucao.ordem} em ${ctx.orcamento.porPI} tentativa(s)`], {
                    avisos: [{ codigo: 'orcamento_esgotado', pi: execucao.ordem, item: execucao.item, mensagem: `ultima reprovacao (${fase}): ${codigos}` }],
                    promptRecomendado: proximoFeedback
                })
            );
            avancarStatus(ctx, 'UNRESOLVED', `orcamento do PI ${execucao.ordem} esgotado (${execucao.tentativas.length}/${ctx.orcamento.porPI}); ultima reprovacao (${fase}): ${codigos}`);
            return 'INVALID';
        }
        tentativa.realimentacao = proximoFeedback;
        feedback = proximoFeedback;
        restrito = proxima.contexto;
        execucao.proibidas.push(...proxima.proibidas);
    }
}
