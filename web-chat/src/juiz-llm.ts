/**
 * QUEM FAZ O PAPEL DO LLM JUDGE na tela de avaliação — e a memória disso neste
 * navegador.
 *
 * O juiz padrão é o LLM LOCAL (Qwen, servido pelo motor do domínio): é ele que
 * roda quando nada é escolhido, e é o único que não precisa de chave. Escolher
 * um modelo de FRONTEIRA (Claude, GPT, Gemini, DeepSeek) troca só o modelo
 * dentro do LLM Judge: mesmo prompt, mesmo contexto, mesmas três respostas
 * possíveis (ver src/inference/juiz-fronteira.ts). O oráculo determinístico
 * continua decidindo a validade, e a geração dos planos não é afetada por nada
 * disto — o juiz só olha planos JÁ gerados.
 *
 * A MEMÓRIA é por provedor: trocar de Claude para Gemini e voltar não apaga o
 * que foi digitado para o Claude. Fica em `localStorage`, que é por navegador e
 * por origem — não vai para o servidor e não acompanha o usuário em outra
 * máquina.
 *
 * ONDE A CHAVE FICA, exatamente: aqui (localStorage deste navegador) e, durante
 * um pedido de avaliação, na memória do processo do servidor. Ela NÃO é gravada
 * em disco pelo servidor, não entra no JSONL da avaliação e não aparece em
 * mensagem de erro. Guardar chave em localStorage é cômodo e assumido: qualquer
 * script rodando nesta origem a alcança, e por isso existe `limparProvedor` —
 * e, no servidor, a alternativa de pôr a chave numa variável de ambiente e
 * deixar o campo em branco.
 */

/** O provedor do juiz local — o Qwen do motor do domínio. */
export const JUIZ_LOCAL = 'local';

export interface DadosProvedor {
    /** O modelo do provedor. Vazio: o padrão que o servidor informa. */
    modelo: string;
    /** A chave de API. Vazia: a do ambiente do servidor, quando existir. */
    apiKey: string;
}

export interface ConfigJuiz {
    /** `local` ou o `id` de um `JuizDisponivel`. */
    provedor: string;
    /** O que já foi digitado para cada provedor de fronteira. */
    porProvedor: Record<string, DadosProvedor>;
}

/** O que vai no corpo do pedido de avaliação. */
export interface PedidoJuizLLM {
    provedor: string;
    modelo?: string;
    apiKey?: string;
}

const CHAVE_ARMAZENADA = 'spc-cml-juiz-llm';

export const SEM_DADOS: DadosProvedor = { modelo: '', apiKey: '' };

export function configInicial(): ConfigJuiz {
    return { provedor: JUIZ_LOCAL, porProvedor: {} };
}

const texto = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Lê o que está guardado. Qualquer problema — localStorage bloqueado (janela
 * privada), conteúdo de outra versão, JSON corrompido — devolve a configuração
 * inicial: a tela abre no juiz local em vez de quebrar.
 */
export function carregarConfig(): ConfigJuiz {
    try {
        const bruto = localStorage.getItem(CHAVE_ARMAZENADA);
        if (!bruto) return configInicial();
        const lido = JSON.parse(bruto) as unknown;
        if (!lido || typeof lido !== 'object') return configInicial();
        const { provedor, porProvedor } = lido as { provedor?: unknown; porProvedor?: unknown };
        const dados: Record<string, DadosProvedor> = {};
        if (porProvedor && typeof porProvedor === 'object') {
            for (const [id, valor] of Object.entries(porProvedor as Record<string, unknown>)) {
                if (!valor || typeof valor !== 'object') continue;
                const { modelo, apiKey } = valor as { modelo?: unknown; apiKey?: unknown };
                dados[id] = { modelo: texto(modelo), apiKey: texto(apiKey) };
            }
        }
        return { provedor: texto(provedor) || JUIZ_LOCAL, porProvedor: dados };
    } catch {
        return configInicial();
    }
}

/** Grava. Falha de localStorage não derruba a tela: a escolha vale na sessão. */
export function salvarConfig(config: ConfigJuiz): void {
    try {
        localStorage.setItem(CHAVE_ARMAZENADA, JSON.stringify(config));
    } catch {
        /* janela privada ou armazenamento cheio: segue sem persistir */
    }
}

export function dadosDoProvedor(config: ConfigJuiz, provedor: string): DadosProvedor {
    return config.porProvedor[provedor] ?? SEM_DADOS;
}

/** Já há o que usar para este provedor? Chave digitada, ou modelo escolhido. */
export function temDados(config: ConfigJuiz, provedor: string): boolean {
    const d = config.porProvedor[provedor];
    return !!d && (d.apiKey.trim().length > 0 || d.modelo.trim().length > 0);
}

/** Escolhe o provedor, opcionalmente gravando os dados dele. */
export function escolherProvedor(config: ConfigJuiz, provedor: string, dados?: DadosProvedor): ConfigJuiz {
    return {
        provedor,
        porProvedor: dados
            ? { ...config.porProvedor, [provedor]: { modelo: dados.modelo.trim(), apiKey: dados.apiKey.trim() } }
            : config.porProvedor
    };
}

/**
 * Apaga o que estava guardado para um provedor e volta ao juiz local — é o
 * "limpar os dados da LLM selecionada". O juiz local não tem dados a limpar.
 */
export function limparProvedor(config: ConfigJuiz, provedor: string): ConfigJuiz {
    const porProvedor = { ...config.porProvedor };
    delete porProvedor[provedor];
    return { provedor: config.provedor === provedor ? JUIZ_LOCAL : config.provedor, porProvedor };
}

/**
 * O juiz pedido ao servidor. Com o juiz local devolve `undefined`: o servidor
 * já usa o modelo do motor por padrão, e assim nenhum campo vazio viaja.
 */
export function pedidoDoJuizLLM(config: ConfigJuiz): PedidoJuizLLM | undefined {
    if (config.provedor === JUIZ_LOCAL) return undefined;
    const d = dadosDoProvedor(config, config.provedor);
    return {
        provedor: config.provedor,
        ...(d.modelo.trim() ? { modelo: d.modelo.trim() } : {}),
        ...(d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : {})
    };
}
