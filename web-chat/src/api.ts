import type { Mensagem } from './types';
// As contas da comparação dos dois juízes são as do módulo puro — a tela não
// recalcula nada, só mostra (ver src/inference/comparacao-juizes.ts).
import type { ComparacaoJuizes, DivergenciaJuizes } from '../../src/inference/comparacao-juizes';

export type { ComparacaoJuizes, DivergenciaJuizes };

export interface Dominio {
    id: 'med' | 'agro' | 'fut';
    nome: string;
    descricao: string;
}

export interface ChatResumo {
    id: string;
    titulo: string;
    dominio: 'med' | 'agro' | 'fut';
    criadoEm: string;
    atualizadoEm: string;
}

export interface ChatCompleto extends ChatResumo {
    mensagens: Mensagem[];
}

/** Espelho de src/inference/avaliar-grafo.ts e avaliar-sintaxe.ts — o contrato de POST /api/avaliar. */
export type Veredito = 'VALID' | 'INVALID' | 'UNRESOLVED';

/** Veredito de uma camada que pode não ter rodado. */
export type VereditoSemantico = Veredito | 'NOT_EVALUATED';

/** O que o juiz disse — ou por que não disse. */
export type StatusJuiz = Veredito | 'NOT_CALLED' | 'NO_RESPONSE';

export type ClassificacaoAvaliacao = 'VALIDO_PELO_ORACULO' | 'INVALIDO_PELO_ORACULO' | 'UNRESOLVIDO_PELO_ORACULO' | 'DISCORDANCIA_LLM';

export interface ContagemVereditos {
    VALID: number;
    INVALID: number;
    UNRESOLVED: number;
}

export interface MetricasAvaliacao {
    /** Só linhas efetivamente avaliadas. */
    total: number;
    sintaxe: { VALID: number; INVALID: number };
    semantica: ContagemVereditos & { NOT_EVALUATED: number };
    oraculo: ContagemVereditos;
    juiz: ContagemVereditos & { NOT_CALLED: number; NO_RESPONSE: number };
    concordantes: number;
    discordantes: number;
    /** `<oraculo>+<juiz>` -> quantas linhas. */
    pares: Record<string, number>;
    violacoes: number;
}

/** Erro da validação sintática: de G (`/verify` sem política), do parser Langium ou da ligação de referências. */
export interface ErroSintatico {
    codigo: string;
    mensagem: string;
    fonte: 'gramatica' | 'parser' | 'ligacao' | 'artefato';
    linha?: number;
    coluna?: number;
    regra?: string;
    campo?: string;
    encontrado?: string;
    esperado?: string[];
}

/** 1. Sintaxe: G + parser da DSL -> AST oficial. */
export interface ValidacaoSintatica {
    veredito: 'VALID' | 'INVALID';
    erros: ErroSintatico[];
    /** O que cada peça disse. Ausente quando nenhuma foi chamada (artefato vazio). */
    pecas?: { gramatica: 'ACEITO' | 'RECUSADO'; parser: 'ACEITO' | 'RECUSADO' };
}

/** O AST oficial (Langium), serializado — o mesmo objeto que a semântica leu. */
export type AstArtefato = { $type: string; name?: string } & Record<string, unknown>;

export interface ProblemaValidacao {
    codigo: string;
    mensagem: string;
    pi?: number;
    pis?: number[];
    item?: string;
    conduta?: string;
    regra?: string;
    evidencias?: string[];
    alternativas?: string[];
}

export interface ProblemaSemantico extends ProblemaValidacao {
    etapa: string;
}

export interface EtapaSemantica {
    etapa: 'gramatica_da_politica' | 'sequencia' | 'pis' | 'global';
    validador: string;
    veredito: VereditoSemantico;
    erros: ProblemaValidacao[];
    avisos: ProblemaValidacao[];
    dadosFaltantes: string[];
    motivo?: string;
}

/** 2. Semântica determinística, sobre o AST: os validadores da geração. */
export interface ValidacaoSemantica {
    veredito: VereditoSemantico;
    erros: ProblemaSemantico[];
    avisos: ProblemaSemantico[];
    dadosFaltantes: string[];
    etapas: EtapaSemantica[];
    /** Conhecimento que é só texto: vai como evidência, nenhuma etapa o confere. */
    naoFormalizado: string[];
    motivo?: string;
}

/** 3. Oráculo: sintaxe + semântica, com a camada que decidiu. */
export interface Oraculo {
    veredito: Veredito;
    origem: 'sintaxe' | 'semantica';
}

/** 4. Juiz LLM — avaliação experimental, comparada com o oráculo, nunca no lugar dele. */
export interface JulgamentoLLM {
    status: StatusJuiz;
    justificativa?: string;
    evidencias?: string[];
    respostaBruta?: string;
    /**
     * Quem julgou. AUSENTE = o juiz local (Qwen, no motor do domínio), que é o
     * padrão; presente (`claude`, `gpt`, `gemini`, `deepseek`) é um
     * rejulgamento com modelo de fronteira — ver juiz-fronteira.ts.
     */
    provedor?: string;
    modelo?: string;
    /** Em NOT_CALLED, por que não foi chamado; em NO_RESPONSE, a falha. */
    motivo?: string;
    /** Só com status UNRESOLVED, e só em avaliações feitas depois do diagnóstico. Não muda status, oráculo nem classificação. */
    diagnostico?: DiagnosticoIndeterminacao;
}

// ---------------------------------------------------------------------------
// Diagnóstico da indeterminação do juiz — espelho de src/inference/diagnostico-juiz.ts.
// ---------------------------------------------------------------------------

/** formal: condição estruturada sobre a telemetria; parcial: ligação estruturada sem medida que a decida; texto: só descrição. */
export type FormalizacaoRegra = 'formal' | 'parcial' | 'texto';

/** DIAGNOSED: fundamentado no catálogo; INSUFFICIENT_GROUNDING: nada se apoiou nele; MALFORMED: fora do formato; NO_RESPONSE: falha técnica. */
export type StatusDiagnostico = 'DIAGNOSED' | 'INSUFFICIENT_GROUNDING' | 'MALFORMED' | 'NO_RESPONSE';

export type TipoInformacaoAusente = 'campo_sem_valor' | 'fato_nao_observado' | 'evidencia_insuficiente' | 'regra_nao_formalizada';

export interface DiagnosticoIndeterminacao {
    status: StatusDiagnostico;
    /** Fora de DIAGNOSED: por que não há diagnóstico fundamentado. */
    motivo?: string;
    /** Por que o juiz não concluiu. */
    motivoIndeterminacao?: string;
    regrasAfetadas?: { regra: string; formalizacao: FormalizacaoRegra; motivo: string }[];
    evidenciasDisponiveis?: { fonte: 'telemetria' | 'regra' | 'pedido' | 'plano' | 'julgamento'; referencia: string; descricao: string }[];
    informacoesAusentes?: { tipo: TipoInformacaoAusente; referencia: string; regra: string; formalizacao: FormalizacaoRegra; descricao: string }[];
    /** Possibilidades condicionais, não vereditos. */
    caminhosPossiveis?: { resultado: Veredito; condicoes: string; regras: string[]; fundamentacao: FormalizacaoRegra | 'nenhuma' }[];
    incertezaRemanescente?: string;
    /** conhecimento: derivada do catálogo (determinística); modelo: escrita pelo modelo. */
    limitacoes: { origem: 'conhecimento' | 'modelo'; descricao: string }[];
    /** O que a resposta citou sem apoio no catálogo — fora do diagnóstico. */
    referenciasRejeitadas?: { secao: 'regrasAfetadas' | 'evidenciasDisponiveis' | 'informacoesAusentes' | 'caminhosPossiveis'; referencia: string; motivo: string }[];
    respostaBruta?: string;
}

export interface DetalheLado {
    plano: string;
    sujeito?: string;
    /** Incremento em item bloqueado/vetado, lido do AST. Ausente sem AST. */
    violacao?: boolean;
    /** Prompt Semântico reconstruído para este registro — o que o juiz leu. */
    contextoGrafo?: string;
    /** Falha técnica (grafo, motor): nenhuma camada tem veredito. */
    naoAvaliado: boolean;
    motivo?: string;
    validacaoSintatica?: ValidacaoSintatica;
    /** Só com sintaxe VALID. */
    ast?: AstArtefato;
    validacaoSemantica?: ValidacaoSemantica;
    oraculo?: Oraculo;
    julgamentoLLM?: JulgamentoLLM;
    /** Num rejulgamento, o julgamento que o arquivo importado já tinha para este mesmo plano. */
    julgamentoAnterior?: JulgamentoLLM;
    concordancia?: boolean;
    classificacao?: ClassificacaoAvaliacao;
    /** Tempos e tamanhos da GERAÇÃO deste plano — repassados, não medidos na avaliação. */
    geracao?: GeracaoDoPlano;
    /** Durações do plano em ms; oráculo e juiz rodam concorrentes (paraleloMs ≈ max dos dois). */
    tempos?: {
        sintaxeMs?: number;
        recuperacaoMs?: number;
        oraculoMs: number | null;
        llmJudgeMs: number | null;
        /** Só o diagnóstico da indeterminação (fora de llmJudgeMs). Ausente sem diagnóstico. */
        diagnosticoMs?: number;
        paraleloMs?: number;
        totalMs?: number;
    };
}

/**
 * Espelho de `GeracaoDoPlano` (src/inference/avaliar-grafo.ts): o que se sabe da
 * GERAÇÃO de cada plano — tempos repassados do registro (a avaliação não os
 * mede) e tamanhos. Campo ausente é campo que o arquivo não trouxe: a tela
 * mostra "—", nunca uma estimativa.
 */
export interface GeracaoDoPlano {
    /** Geração do plano que ficou (sem as tentativas que o gate descartou). */
    tempoTotalMs?: number;
    tempoSequenciasMs?: number | null;
    tempoPIsValidasMs?: number | null;
    tempoValidacaoPlanosMs?: number | null;
    /** Validação feita DURANTE a geração (o gate), somando as tentativas do cenário. */
    tempoValidacaoMs?: number;
    tempoGeracaoDescartadaMs?: number;
    tempoCenarioMs?: number;
    tentativasGeracao?: number;
    charsPedido?: number;
    charsPrompt?: number;
    charsPlano?: number;
    /** Contados no motor (`/tokenizar`), com o tokenizador do modelo da geração. */
    tokensPrompt?: number;
    tokensPlano?: number;
}

export interface DetalheLinha {
    linha: number;
    intencao: string;
    arquitetura?: DetalheLado;
    baseline?: DetalheLado;
    /** Algum lado avaliado não saiu VALID pelo oráculo, ou teve violação. */
    temDivergencia: boolean;
    /** Em algum lado, o juiz discordou do oráculo. */
    temDiscordancia: boolean;
}

export interface RespostaAvaliacao {
    arquitetura?: MetricasAvaliacao;
    baseline?: MetricasAvaliacao;
    /** Registros que não puderam ser avaliados, somando os dois arquivos. */
    naoAvaliados: number;
    linhas: DetalheLinha[];
    /** Nome do JSONL experimental gravado pelo servidor — ver `urlAvaliacaoJsonl`. */
    arquivoJsonl?: string;
    /** O juiz desta avaliação, quando não foi o modelo local. */
    juiz?: { provedor: string; modelo?: string };
    /** Tempo total (s) que o servidor levou para processar a avaliação inteira. */
    tempoTotalSegundos?: number;
    /** Soma dos tempos da validação sintática, em segundos. */
    tempoSintaxeSegundos?: number;
    /** Soma dos tempos da validação semântica (oráculo), em segundos. */
    tempoOraculoSegundos?: number;
    /** Soma dos tempos do LLM Judge, em segundos. */
    tempoLlmJudgeSegundos?: number;
    /** Soma dos tempos do diagnóstico da indeterminação, em segundos. Ausente sem nenhum diagnóstico. */
    tempoDiagnosticoSegundos?: number;
    /**
     * Tempos de GERAÇÃO dos cenários avaliados (os dois arquivos), em
     * segundos — não medidos na avaliação, repassados do lote (ver
     * tempos-lote.ts) e agregados. Ausente quando nenhum registro os trouxe.
     */
    tempoGeracaoTotalSegundos?: number;
    tempoGeracaoSequenciasSegundos?: number;
    tempoGeracaoPIsValidasSegundos?: number;
    tempoGeracaoValidacaoPlanosSegundos?: number;
}

// ---------------------------------------------------------------------------
// Gate da geração em lote — espelho de src/inference/geracao-validada.ts.
// O lote (ChatView) liga isto em POST /api/comando: cada cenário gera o plano,
// passa pela MESMA cascata da tela de avaliação e, quando a avaliação reprova,
// volta para a geração, até aprovar ou bater o teto de tentativas.
// ---------------------------------------------------------------------------

/**
 * Quem reprova o plano e manda gerar de novo:
 * `oraculo` só o veredito normativo (o juiz, se rodar, só entra no registro);
 * `juiz` o LLM Judge decide — e aí pode ficar plano que o oráculo reprovou;
 * `ambos` o plano só fica se os dois derem VALID (o mais estrito).
 */
export type CriterioGate = 'oraculo' | 'juiz' | 'ambos';

/**
 * O veredito que fechou (ou não) o gate. `NAO_AVALIADO`: falha técnica — nenhuma
 * camada deu veredito. `NOT_CALLED`/`NO_RESPONSE`: o juiz era critério e não
 * respondeu (ou não foi chamado).
 */
export type VereditoGate = Veredito | 'NAO_AVALIADO' | 'NOT_CALLED' | 'NO_RESPONSE';

/** Uma geração reprovada e descartada pelo gate. */
export interface TentativaDescartada {
    tentativa: number;
    plano: string;
    /** O veredito que reprovou. */
    veredito: VereditoGate;
    /** Quem reprovou. */
    fonte: 'oraculo' | 'juiz';
    /** O veredito normativo desta tentativa, mesmo quando quem reprovou foi o juiz. */
    oraculo?: Veredito;
    /** O status do juiz nesta tentativa, mesmo quando quem reprovou foi o oráculo. */
    juiz?: StatusJuiz;
    /** A camada do oráculo que reprovou, quando foi ele. */
    origem?: 'sintaxe' | 'semantica';
    /** Em falha técnica, o motivo. */
    motivo?: string;
    /** Códigos dos erros de sintaxe/semântica e os dados que faltaram. */
    codigos: string[];
    /** O que o juiz escreveu ao reprovar. */
    justificativaJuiz?: string;
    tempoGeracaoMs: number;
    tempoAvaliacaoMs: number | null;
}

/** O desfecho e o custo do gate num cenário. */
export interface ResumoGate {
    /** Quantas gerações rodaram (1 = aprovado de primeira). */
    tentativas: number;
    maxTentativas: number;
    criterio: CriterioGate;
    /** O critério aprovou o plano que ficou. */
    aceita: boolean;
    /** O veredito que decidiu a tentativa que ficou. */
    veredito: VereditoGate;
    /** Quem decidiu. */
    fonte: 'oraculo' | 'juiz';
    /** O veredito normativo do plano que ficou. */
    oraculo?: Veredito;
    /** O status do juiz no plano que ficou. */
    juiz?: StatusJuiz;
    /** Teto batido sem aprovação: o plano que ficou é o último reprovado. */
    limiteAtingido: boolean;
    /** A geração que ficou — é este o tempo de geração do cenário. */
    tempoGeracaoAceitaMs: number;
    /** Soma das gerações descartadas: o custo do gate, fora do tempo do plano que ficou. */
    tempoGeracaoDescartadaMs: number;
    /** Soma das avaliações de todas as tentativas. */
    tempoAvaliacaoMs: number;
    descartadas: TentativaDescartada[];
}

/** O que o lote manda para ligar o gate (ausente: a geração roda como sempre, sem avaliar). */
export interface OpcoesGateLote {
    ativa: boolean;
    maxTentativas: number;
    criterio: CriterioGate;
    /** Com `criterio: 'oraculo'`, chamar o juiz só para o registro. Ignorado nos outros critérios. */
    juiz?: boolean;
    repetirNaoAvaliado?: boolean;
}

export interface RespostaComando {
    aceito: boolean;
    motivoValidacao?: string;
    sorteio?: Record<string, unknown>;
    foco?: {
        farmacos?: string[];
        protocolos?: string[];
        produtos?: string[];
        culturas?: string[];
        infracoes?: string[];
        lances?: string[];
    } | null;
    focoIndisponivel?: string;
    promptSemantico?: string;
    decisoesAdmissiveis?: string[];
    resultado?: string;
    valido?: boolean;
    erroMotor?: string | null;
    regrasEmGHat?: number;
    erro?: string;
    /** Só no modo multiagente (`SPC_CML_DECODIFICACAO=multiagente`): a execução resumida. */
    execucaoMultiagente?: ExecucaoMultiagenteResposta;
    /**
     * Só com o gate ligado: a avaliação do plano que ficou, nas MESMAS camadas
     * separadas que /api/avaliar devolve (sintaxe, semântica, oráculo, juiz) —
     * sem `contextoGrafo`, que já vem em `promptSemantico`.
     */
    avaliacao?: DetalheLado;
    /** Só com o gate ligado: tentativas, vereditos descartados e o custo de cada parte. */
    geracaoValidada?: ResumoGate;
}

/**
 * O que o web-chat lê de `execucaoMultiagente`. O servidor manda o
 * `ResumoExecucao` inteiro (src/inference/multiagente.ts); aqui só os campos
 * usados: o status e a sequência (avaliador) e os cronômetros que o próprio
 * pipeline grava (tempos do lote, ver tempos-lote.ts).
 */
export interface ExecucaoMultiagenteResposta {
    status: string;
    sequenciaValidada?: PIPlanejado[];
    /**
     * O custo da execução inteira. `temposFases` é o relógio de parede de cada
     * fase da geração, medido direto no pipeline (início → fim, retries e ciclos
     * somados, mesmo com exceção); fase que não começou fica ausente.
     */
    metricasExecucao?: {
        temposFases?: { sequenciasMs?: number; pisMs?: number; validacaoPlanosMs?: number };
    };
}

/** Um PI da sequência do Planner — o que o avaliador lê (`dependeDe` não está na DSL do artefato). */
export interface PIPlanejado {
    ordem: number;
    item: string;
    conduta: string;
    dependeDe: number[];
    motivo?: string;
}

// Usa o mesmo host pelo qual o chat foi aberto (localhost, IP do Tailscale etc.),
// para que o navegador de outra maquina alcance a API na porta 4000.
const BASE_URL =
    import.meta.env.VITE_API_URL ?? `${window.location.protocol}//${window.location.hostname}:4000`;

export async function buscarDominios(): Promise<Dominio[]> {
    const resp = await fetch(`${BASE_URL}/api/dominios`);
    if (!resp.ok) throw new Error(`falha ao listar dominios: ${resp.status}`);
    return resp.json();
}

export async function listarChats(): Promise<ChatResumo[]> {
    const resp = await fetch(`${BASE_URL}/api/chats`);
    if (!resp.ok) throw new Error(`falha ao listar chats: ${resp.status}`);
    return resp.json();
}

export async function buscarChat(id: string): Promise<ChatCompleto> {
    const resp = await fetch(`${BASE_URL}/api/chats/${id}`);
    if (!resp.ok) throw new Error(`falha ao carregar chat: ${resp.status}`);
    return resp.json();
}

/**
 * Envia o(s) arquivo(s) para avaliação e acompanha o progresso via SSE: cada
 * julgamento é uma geração no modelo local, então um arquivo grande pode levar
 * minutos — o servidor emite um evento "progresso" a cada linha julgada, antes
 * do evento final "final"/"erro".
 */
export async function avaliarResultados(
    dominio: 'med' | 'agro' | 'fut',
    arquiteturaJsonl: string | undefined,
    baselineJsonl: string | undefined,
    aoProgresso: (processados: number, total: number) => void,
    signal?: AbortSignal,
    /** Nome do arquivo de entrada: o servidor o usa para nomear o arquivo da avaliação (`evalueted_<nome>_<carimbo>.jsonl`). */
    nomeEntrada?: string,
    /** Quem julga. Ausente: o modelo local do motor. */
    juiz?: JuizPedido
): Promise<RespostaAvaliacao> {
    return pedirComProgresso<RespostaAvaliacao>(
        '/api/avaliar',
        { dominio, arquiteturaJsonl, baselineJsonl, nomeEntrada, juiz },
        aoProgresso,
        signal
    );
}

/**
 * Um POST que responde em SSE: eventos `progresso` até o `final` (ou `erro`).
 * É o transporte da avaliação e do rejulgamento — os dois chamam o modelo uma
 * vez por plano, e os dois podem ser cancelados fechando a conexão.
 */
async function pedirComProgresso<T>(
    rota: string,
    corpo: unknown,
    aoProgresso: (processados: number, total: number) => void,
    signal?: AbortSignal
): Promise<T> {
    const resp = await fetch(`${BASE_URL}${rota}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
        signal
    });

    if (!resp.ok || !resp.body) {
        const erro = await resp.json().catch(() => ({}) as { erro?: string });
        throw new Error((erro as { erro?: string }).erro ?? `o servidor respondeu ${resp.status}`);
    }

    const leitor = resp.body.getReader();
    const decodificador = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await leitor.read();
        if (done) break;
        buffer += decodificador.decode(value, { stream: true });

        let fimBloco: number;
        while ((fimBloco = buffer.indexOf('\n\n')) !== -1) {
            const bloco = buffer.slice(0, fimBloco);
            buffer = buffer.slice(fimBloco + 2);

            let evento = 'message';
            let dadosTexto = '';
            for (const linha of bloco.split('\n')) {
                if (linha.startsWith('event: ')) evento = linha.slice(7);
                else if (linha.startsWith('data: ')) dadosTexto += linha.slice(6);
            }
            if (!dadosTexto) continue;
            const dados = JSON.parse(dadosTexto);

            if (evento === 'progresso') aoProgresso(dados.processados, dados.total);
            else if (evento === 'final') return dados as T;
            else if (evento === 'erro') throw new Error(dados.erro ?? 'falha desconhecida no servidor');
        }
    }

    throw new Error('conexão encerrada antes do resultado final');
}

// ---------------------------------------------------------------------------
// Rejulgamento: os mesmos planos, outro juiz
// (espelho de src/inference/juiz-fronteira.ts e POST /api/rejulgar)
// ---------------------------------------------------------------------------

/**
 * Quem faz o papel do LLM Judge num pedido de avaliação: ausente ou
 * `provedor: 'local'` é o modelo do motor (o padrão). A geração dos planos não
 * é afetada — o juiz só olha planos já gerados.
 */
export interface JuizPedido {
    provedor: string;
    /** Vazio: o modelo padrão do provedor. */
    modelo?: string;
    /** Vazia: a chave do ambiente do servidor, quando existir. */
    apiKey?: string;
}

/** Um provedor que pode ocupar o lugar do juiz local. */
export interface JuizDisponivel {
    /** `claude`, `gpt`, `gemini`, `deepseek`. */
    id: string;
    nome: string;
    /** O modelo usado quando o pedido não nomeia nenhum. */
    modeloPadrao: string;
    /** O servidor já tem a chave deste provedor no ambiente: não precisa digitar. */
    chaveNoServidor: boolean;
    /** As variáveis de ambiente que o servidor aceita como chave. */
    variaveisDeAmbiente: string[];
}

/** Os juízes possíveis: o modelo local do motor e os provedores de fronteira. */
export interface JuizesDisponiveis {
    /** O juiz padrão: o modelo que o motor do domínio informa em `/health`. */
    local: { provedor: string; modelo: string };
    fronteira: JuizDisponivel[];
}

/** O modelo local depende do domínio (um motor por domínio). */
export async function listarJuizes(dominio?: 'med' | 'agro' | 'fut'): Promise<JuizesDisponiveis> {
    const resp = await fetch(`${BASE_URL}/api/juizes${dominio ? `?dominio=${dominio}` : ''}`);
    if (!resp.ok) throw new Error(`falha ao listar os juizes: ${resp.status}`);
    return resp.json();
}

/** O que se manda testar: o provedor, com o modelo e a chave a conferir. */
export interface PedidoTesteJuiz {
    /** O `id` de um `JuizDisponivel`. */
    provedor: string;
    /** O modelo a testar. Vazio: o padrão do provedor. */
    modelo?: string;
    /** A chave a testar. Vazia: a do ambiente do servidor, quando existir. */
    apiKey?: string;
}

/**
 * QUE PEÇA a falha do teste acusa (espelho de `CausaFalhaJuiz` em
 * src/inference/juiz-fronteira.ts). É o que a tela lê para dizer o que rever —
 * ver `diagnosticoDoTeste` em src/teste-juiz.ts. `cota`, `provedor` e `formato`
 * NÃO acusam a chave nem o modelo: o provedor só chega a eles depois de
 * autenticar o pedido e achar o modelo.
 */
export type CausaFalhaTeste = 'chave' | 'modelo' | 'cota' | 'provedor' | 'rede' | 'formato' | 'desconhecida';

/**
 * O que o teste descobriu (espelho de `ResultadoTesteConexao` em
 * src/inference/juiz-fronteira.ts, mais de onde saiu a chave).
 */
export interface ResultadoTesteJuiz {
    /** A chave foi aceita, o modelo respondeu e a resposta tinha o formato do juiz. */
    ok: boolean;
    provedor: string;
    /** O modelo que foi chamado: o pedido, ou o padrão do provedor. */
    modelo: string;
    /** Quanto a chamada levou, em ms — a ordem de grandeza de um plano na avaliação. */
    ms: number;
    /** O veredito do julgamento de brinquedo, quando houve: prova de vida, não nota. */
    veredito?: Veredito;
    /** Por que falhou — a mensagem do provedor, já sem a chave. */
    erro?: string;
    /** Que peça a falha acusa. Ausente num servidor antigo: trate como `desconhecida`. */
    causa?: CausaFalhaTeste;
    /** O status HTTP do provedor, quando houve resposta. */
    status?: number;
    /** O teste usou a chave do ambiente do servidor (nada foi digitado). */
    chaveDoAmbiente: boolean;
}

/**
 * Testa provedor, modelo e chave com UM julgamento de brinquedo, pelo mesmo
 * caminho da avaliação (ver POST /api/juizes/testar). Chave recusada, modelo
 * inexistente, cota estourada e resposta ilegível voltam em
 * `{ ok: false, erro }` — não levantam. `signal` cancela o teste.
 *
 * A chave vai no corpo do pedido e não é gravada em lugar nenhum: nem no
 * servidor, nem no resultado, nem no JSONL.
 */
export async function testarJuiz(pedido: PedidoTesteJuiz, signal?: AbortSignal): Promise<ResultadoTesteJuiz> {
    const resp = await fetch(`${BASE_URL}/api/juizes/testar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pedido),
        signal
    });
    const corpo = (await resp.json().catch(() => null)) as Partial<ResultadoTesteJuiz> | null;
    // 400 é pedido mal formado (provedor desconhecido, nenhuma chave em lugar
    // nenhum): vira o mesmo `ok: false` da falha de conexão, com o motivo que o
    // servidor deu — a tela mostra os dois do mesmo jeito.
    if (!resp.ok || typeof corpo?.ok !== 'boolean') {
        return {
            ok: false,
            provedor: pedido.provedor,
            modelo: pedido.modelo?.trim() ?? '',
            ms: 0,
            erro: corpo?.erro ?? `o servidor respondeu ${resp.status}`,
            // Recusa do servidor da avaliação, não do provedor: nada foi
            // provado sobre a chave nem sobre o modelo.
            causa: corpo?.causa ?? 'desconhecida',
            chaveDoAmbiente: !pedido.apiKey?.trim()
        };
    }
    return corpo as ResultadoTesteJuiz;
}

export interface PedidoRejulgamento {
    /** O provedor do juiz de fronteira (`id` de `JuizDisponivel`). */
    provedor: string;
    /** O modelo do provedor. Vazio: o padrão dele. */
    modelo?: string;
    /** A chave de API. Vazia: a do ambiente do servidor, quando existir. */
    apiKey?: string;
    /** O `evalueted_*.jsonl` já avaliado, inteiro. */
    avaliacaoJsonl: string;
    /** Nome do arquivo importado — acha o cenário de entrada pelo nome. */
    nomeArquivo?: string;
    /** `<dominio>/<arquivo>` para escolher o cenário à mão. */
    cenario?: string;
    dominio?: 'med' | 'agro' | 'fut';
}

/** O que o rejulgamento deixou de fora, e de onde veio a leitura do cenário. */
export interface ResumoRejulgamento {
    arquivoImportado?: string;
    arquivoCenario: string;
    registrosImportados: number;
    rejulgados: number;
    casadosPorSujeito: number;
    casadosPorLinha: number;
    semCenario: number;
    semPlano: number;
}

export interface RespostaRejulgamento extends RespostaAvaliacao {
    comparacaoJuizes: ComparacaoJuizes;
    rejulgamento: ResumoRejulgamento;
}

/**
 * Rejulga os planos de um arquivo já avaliado com o modelo de fronteira
 * escolhido. O servidor refaz a recuperação a partir do `cenarios-*.jsonl` de
 * entrada, monta o MESMO prompt do juiz local e só troca o modelo — ver o bloco
 * REJULGAMENTO em src/web/server.ts.
 *
 * A chave de API vai no corpo do pedido e não é gravada em lugar nenhum: nem no
 * servidor, nem no resultado, nem no JSONL.
 */
export async function rejulgarAvaliacao(
    pedido: PedidoRejulgamento,
    aoProgresso: (processados: number, total: number) => void,
    signal?: AbortSignal
): Promise<RespostaRejulgamento> {
    return pedirComProgresso<RespostaRejulgamento>('/api/rejulgar', pedido, aoProgresso, signal);
}

// ---------------------------------------------------------------------------
// Fusão de cenários, resultados e avaliações
// ---------------------------------------------------------------------------

/** Uma avaliação gravada em `data/avaliacoes/`, com o cenário de entrada que a fusão junta. */
export interface AvaliacaoGravada {
    arquivo: string;
    bytes: number;
    modificadoEm: string;
    registros: number;
    dominios: string[];
    lados: string[];
    /** O `<base>` do nome — é por ele que o servidor acha o cenário de entrada. */
    base: string | null;
    cenario: { arquivo: string; linhas: number; desenho: boolean } | null;
    /** Linhas do cenário sem registro de avaliação; `null` quando o cenário não foi localizado. */
    semAvaliacao: number | null;
    /** Preenchido quando o arquivo não pôde ser lido — ele ainda aparece na lista. */
    erro?: string;
}

/** Um `cenarios-*.jsonl` escolhível, identificado por `<dominio>/<arquivo>`. */
export interface CenarioDisponivel {
    id: string;
    dominio: string;
    arquivo: string;
    caminho: string;
    linhas: number;
    bytes: number;
    chaveSujeito: string;
    desenho: boolean;
}

/** As três partes que a fusão pode juntar — o modo de fusão. */
export type ParteFusao = 'cenario' | 'resultado' | 'avaliacao';

export interface ResumoFonteFusao {
    arquivo: string;
    tipo: 'avaliacao' | 'cenario';
    arquivoCenario: string | null;
    arquivoMeta: string | null;
    dominios: string[];
    lados: string[];
    avaliacoes: number;
    cenarios: number | null;
    fundidos: number;
    casadosPorSujeito: number;
    casadosPorLinha: number;
    semCenario: number;
    semAvaliacao: number;
    lacunas: number[];
    lacunasTruncadas: boolean;
}

export interface OpcoesFusao {
    partes?: ParteFusao[];
    incluirPlano: boolean;
    incluirDesenho: boolean;
    incluirSemAvaliacao: boolean;
}

/** A seleção de arquivos: avaliações, cenários avulsos e o cenário de cada avaliação. */
export interface SelecaoFusao {
    avaliacoes: string[];
    cenarios?: string[];
    /** avaliação -> id do cenário, ou `'nenhum'` para não casar com nenhum. */
    cenarioDe?: Record<string, string>;
}

export interface ResumoFusao {
    opcoes: OpcoesFusao;
    partes: ParteFusao[];
    registros: number;
    dominios: string[];
    fontes: ResumoFonteFusao[];
    totalSemAvaliacao: number;
    totalSemCenario: number;
    telemetriaPorDominio: Record<string, string[]>;
}

export type FormatoFusao = 'jsonl' | 'csv';

function paramsFusao(selecao: SelecaoFusao, opcoes: Partial<OpcoesFusao>): URLSearchParams {
    const p = new URLSearchParams();
    for (const a of selecao.avaliacoes) p.append('avaliacao', a);
    for (const c of selecao.cenarios ?? []) p.append('cenario', c);
    for (const [avaliacao, cenario] of Object.entries(selecao.cenarioDe ?? {})) {
        // Só o que muda o padrão vira parâmetro: o automático é a ausência dele.
        if (cenario && selecao.avaliacoes.includes(avaliacao)) p.append('cenarioDe', `${avaliacao}:${cenario}`);
    }
    for (const parte of opcoes.partes ?? []) p.append('parte', parte);
    if (opcoes.incluirPlano === false) p.set('plano', '0');
    if (opcoes.incluirDesenho === false) p.set('desenho', '0');
    if (opcoes.incluirSemAvaliacao) p.set('semAvaliacao', '1');
    return p;
}

/** As avaliações gravadas, da mais recente para a mais antiga. */
export async function listarAvaliacoes(): Promise<AvaliacaoGravada[]> {
    const resp = await fetch(`${BASE_URL}/api/avaliacoes`);
    if (!resp.ok) throw new Error(`falha ao listar avaliacoes: ${resp.status}`);
    return resp.json();
}

/** Os `cenarios-*.jsonl` de `src/examples`, escolhíveis na fusão. */
export async function listarCenarios(): Promise<CenarioDisponivel[]> {
    const resp = await fetch(`${BASE_URL}/api/cenarios`);
    if (!resp.ok) throw new Error(`falha ao listar cenarios: ${resp.status}`);
    return resp.json();
}

/** A cobertura da fusão, sem baixar nada — é o que a tela mostra antes do download. */
export async function resumirFusao(selecao: SelecaoFusao, opcoes: Partial<OpcoesFusao> = {}): Promise<ResumoFusao> {
    const p = paramsFusao(selecao, opcoes);
    p.set('formato', 'resumo');
    const resp = await fetch(`${BASE_URL}/api/fusao?${p}`);
    if (!resp.ok) throw new Error(((await resp.json().catch(() => null)) as { erro?: string })?.erro ?? `falha ao resumir a fusao: ${resp.status}`);
    return resp.json();
}

/** URL de download do arquivo fundido. Sem seleção nenhuma, o servidor funde todas as avaliações. */
export function urlFusao(selecao: SelecaoFusao, formato: FormatoFusao, opcoes: Partial<OpcoesFusao> = {}): string {
    const p = paramsFusao(selecao, opcoes);
    p.set('formato', formato);
    return `${BASE_URL}/api/fusao?${p}`;
}

/** Download do JSONL experimental de uma avaliação (oráculo e juiz LLM separados, um plano por linha). */
export function urlAvaliacaoJsonl(arquivo: string): string {
    return `${BASE_URL}/api/avaliacoes/${encodeURIComponent(arquivo)}`;
}

export async function criarChat(dominio: 'med' | 'agro' | 'fut', mensagens: Mensagem[]): Promise<ChatCompleto> {
    const resp = await fetch(`${BASE_URL}/api/chats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dominio, mensagens })
    });
    if (!resp.ok) throw new Error(`falha ao salvar chat: ${resp.status}`);
    return resp.json();
}

export async function atualizarChat(id: string, dominio: 'med' | 'agro' | 'fut', mensagens: Mensagem[]): Promise<ChatCompleto> {
    const resp = await fetch(`${BASE_URL}/api/chats/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dominio, mensagens })
    });
    if (!resp.ok) throw new Error(`falha ao salvar chat: ${resp.status}`);
    return resp.json();
}

/**
 * Envia o comando e acompanha o fluxo em tempo real via SSE: o servidor emite
 * um evento "estagio" a cada etapa (validacao -> sorteio -> grafo -> embedding
 * -> grammar prompting) antes do evento final "final"/"erro".
 */
export async function enviarComandoStream(
    dominio: string,
    texto: string,
    aoEstagio: (texto: string) => void,
    signal?: AbortSignal,
    contexto?: Record<string, unknown>,
    /** Gate da geração (só o lote manda): gera, avalia e regera até ser aprovado. */
    validacao?: OpcoesGateLote
): Promise<RespostaComando> {
    const resp = await fetch(`${BASE_URL}/api/comando`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dominio, texto, ...(contexto ? { contexto } : {}), ...(validacao?.ativa ? { validacao } : {}) }),
        signal
    });

    if (!resp.ok || !resp.body) {
        const corpo = await resp.json().catch(() => ({}) as RespostaComando);
        throw new Error((corpo as RespostaComando).erro ?? `o servidor respondeu ${resp.status}`);
    }

    const leitor = resp.body.getReader();
    const decodificador = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await leitor.read();
        if (done) break;
        buffer += decodificador.decode(value, { stream: true });

        let fimBloco: number;
        while ((fimBloco = buffer.indexOf('\n\n')) !== -1) {
            const bloco = buffer.slice(0, fimBloco);
            buffer = buffer.slice(fimBloco + 2);

            let evento = 'message';
            let dadosTexto = '';
            for (const linha of bloco.split('\n')) {
                if (linha.startsWith('event: ')) evento = linha.slice(7);
                else if (linha.startsWith('data: ')) dadosTexto += linha.slice(6);
            }
            if (!dadosTexto) continue;
            const dados = JSON.parse(dadosTexto);

            if (evento === 'estagio') aoEstagio(dados.texto);
            else if (evento === 'final') return dados as RespostaComando;
            else if (evento === 'erro') throw new Error(dados.erro ?? 'falha desconhecida no servidor');
        }
    }

    throw new Error('conexão encerrada antes do resultado final');
}
