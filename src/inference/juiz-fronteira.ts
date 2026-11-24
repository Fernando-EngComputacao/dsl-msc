/**
 * O LLM JUDGE EM UM MODELO DE FRONTEIRA — a mesma pergunta, outro modelo.
 *
 * O juiz padrão da avaliação é o modelo LOCAL (Qwen) servido pelo motor do
 * domínio: `juizLLMHttp` (avaliar-grafo.ts) chama `POST /validar-plano`, e lá o
 * prompt (`JULGAMENTO_INSTRUCAO`), a gramática da saída (`JULGAMENTO_GBNF`) e a
 * leitura da resposta (`ler_julgamento`) vivem em src/python_engine/julgamento.py.
 *
 * Este módulo põe, no MESMO lugar da cascata, um modelo de fronteira (Claude,
 * GPT, Gemini, DeepSeek) chamado pela API do provedor com a chave de quem está
 * avaliando. Não é uma camada nova e não corrige ninguém: é o LLM Judge com
 * outro modelo por baixo, continuando independente do oráculo. Serve para
 * MEDIR o juiz local — a tela de importação rejulga planos já avaliados e
 * compara os dois juízes entre si e contra o oráculo (ver comparacao-juizes.ts).
 *
 * TRÊS INVARIANTES, para a troca ser uma troca de MODELO e nada mais:
 *
 *  1. MESMO PROMPT. `INSTRUCAO_JULGAMENTO` é cópia literal de
 *     `JULGAMENTO_INSTRUCAO` e `montarPromptJulgamento` repete
 *     `montar_prompt_julgamento`, inclusive os textos de campo vazio. O teste
 *     (src/test/juiz-fronteira.test.ts) lê o .py e cobra a igualdade: mudar um
 *     lado sem o outro quebra o teste.
 *  2. MESMO CONTEXTO. A entrada é o `PedidoJuiz` que `pedidoDoJuiz` monta da
 *     MESMA recuperação que a semântica usou — nada das camadas
 *     determinísticas entra, como no juiz local.
 *  3. NADA É INVENTADO. Sem GBNF para prender a saída, a resposta pode vir fora
 *     do formato: `lerJulgamento` levanta `JulgamentoIlegivel`, a cascata
 *     registra `NO_RESPONSE` e nenhum veredito é escolhido no lugar do modelo. A
 *     tolerância é só de FORMATAÇÃO (cercas de código, negrito, acentos, ordem
 *     das linhas, texto em volta): os três campos continuam obrigatórios e o
 *     veredito continua tendo de ser um dos três.
 *
 * O CENÁRIO DO EXPERIMENTO É A VERDADE, não o mundo real. A telemetria da linha é
 * fato medido: o prompt proíbe duvidar de um valor por parecer improvável e
 * proíbe opor ao cenário data, lugar, preço, faixa típica de sensor, estatística
 * ou prática usual que o modelo saiba de fora — nem para confirmar, nem para
 * contestar. E AS REGRAS SÃO FECHADAS: o conhecimento recuperado do grafo do
 * especialista é o universo normativo inteiro — norma, protocolo, limite ou boa
 * prática de fora não entra nem para reprovar nem para aprovar, as regras
 * recuperadas valem como dadas (não se discutem nem se completam), a evidência
 * citada tem de estar no contexto enviado, e sem a regra que decidiria o caso a
 * resposta é UNRESOLVED. É o que mantém ruído externo fora da medida do modelo do
 * especialista.
 *
 * A regra é a mesma do juiz local (está no texto copiado), mas pesa
 * mais aqui: o modelo de fronteira tem muito mais mundo real para opor, e os
 * cenários são sintéticos, datas incluídas. No transporte a garantia é de que ele
 * não consulta nada: nenhum corpo de `PROVEDORES` liga busca, grounding ou
 * ferramenta — só o prompt entra, e o teste cobra isso.
 *
 * ORÇAMENTO POR PLANO. Um provedor que não responde custava `timeoutMs ×
 * tentativas` no MESMO plano — 3 × 180 s = 543 s parados num plano só, medido em
 * data/avaliacoes — enquanto os planos que respondem levam de 5 a 21 s. Agora o
 * julgamento inteiro tem um teto (`orcamentoMs`): cada tentativa recebe o que
 * resta dele, a espera entre tentativas não consome o que sobrou, e quando
 * acaba a falha diz isso no motivo. O lote segue em frente com `NO_RESPONSE`, e
 * as camadas determinísticas continuam valendo — nenhum veredito é inventado
 * para preencher o buraco.
 *
 * O PEDIDO NÃO É ORDEM. A `[POLITICA VIGENTE]` do contexto pode não admitir a
 * decisão que o pedido nomeia (ou não admitir nenhuma para o item): aí o plano que
 * NÃO atende o usuário é o certo, e o prompt proíbe reprovar por isso. Os três
 * casos são os do oráculo (`conferirDecisaoDoPedido`, knowledge/validacao-global.ts):
 * pedido inatendível é aviso e não reprova; pedido atendível com outra decisão
 * escolhida é erro; pedido que não cita item do conhecimento é UNRESOLVED. Importa
 * mais aqui do que no juiz local: um modelo de fronteira é treinado para atender
 * quem pede, e sem essa regra ele reprovaria o plano que corretamente recusa — a
 * discordância medida seria do prompt, não do modelo.
 *
 * A CHAVE DE API não é gravada em lugar nenhum: chega no corpo do pedido
 * (`POST /api/rejulgar`), vive na memória do processo durante o rejulgamento e
 * nunca entra em log, mensagem de erro, resultado ou JSONL. Sem chave no
 * pedido, `chaveDoAmbiente` procura a variável de ambiente do provedor — é como
 * rodar sem digitar nada na tela.
 *
 * TESTE DE CONEXÃO: `testarConexaoJuiz` faz UM julgamento de brinquedo
 * (`PEDIDO_TESTE_CONEXAO`) por este mesmo caminho e devolve o que aconteceu em
 * vez de levantar — é o que a tela chama antes de uma avaliação inteira
 * depender de uma chave errada ou de um modelo que não existe. Não mede juiz
 * nenhum: o veredito que volta é prova de vida.
 *
 * Camada de transporte própria (não reusa `postarJsonNoMotor`): cada provedor
 * tem cabeçalho de autenticação, formato de corpo e formato de resposta
 * diferentes, e aqui há repetição com espera (429/5xx) que o motor local não
 * precisa.
 */

import type { Veredito } from '../knowledge/validacao.js';
import type { JuizLLM, PedidoJuiz, RespostaJuizLLM } from './avaliar-grafo.js';

// =============================================================================
// Provedores
// =============================================================================

/** Os modelos de fronteira que podem ocupar o lugar do juiz. */
export const PROVEDORES_FRONTEIRA = ['claude', 'gpt', 'gemini', 'deepseek'] as const;

export type ProvedorFronteira = (typeof PROVEDORES_FRONTEIRA)[number];

/** `local` é o Qwen do motor do domínio (`juizLLMHttp`), o juiz padrão. */
export type ProvedorJuiz = 'local' | ProvedorFronteira;

export function ehProvedorFronteira(valor: unknown): valor is ProvedorFronteira {
    return typeof valor === 'string' && (PROVEDORES_FRONTEIRA as readonly string[]).includes(valor);
}

export function ehProvedorJuiz(valor: unknown): valor is ProvedorJuiz {
    return valor === 'local' || ehProvedorFronteira(valor);
}

/** Como se fala com um provedor: endereço, autenticação, corpo e onde está o texto. */
export interface DefinicaoProvedor {
    /** Nome de tela. */
    nome: string;
    /** O modelo usado quando o pedido não nomeia nenhum. */
    modeloPadrao: string;
    /** Variáveis de ambiente aceitas como chave, na ordem de preferência. */
    variaveisDeAmbiente: readonly string[];
    url: (modelo: string) => string;
    cabecalhos: (chave: string) => Record<string, string>;
    corpo: (prompt: string, modelo: string) => unknown;
    /** O texto da resposta do modelo. Levanta `Error` quando a carga não tem texto. */
    texto: (resposta: unknown) => string;
}

/** Teto de saída onde o provedor exige um: três linhas de no máximo
 *  `MAX_CHARS_LINHA` caracteres cabem com folga. */
const MAX_TOKENS_RESPOSTA = 1024;

const campo = (valor: unknown, nome: string): unknown =>
    valor && typeof valor === 'object' ? (valor as Record<string, unknown>)[nome] : undefined;

/** O texto de um `choices[0].message.content` (OpenAI e compatíveis). */
function textoOpenAI(resposta: unknown): string {
    const escolhas = campo(resposta, 'choices');
    const mensagem = campo(Array.isArray(escolhas) ? escolhas[0] : undefined, 'message');
    const conteudo = campo(mensagem, 'content');
    if (typeof conteudo === 'string' && conteudo.length > 0) return conteudo;
    const recusa = campo(mensagem, 'refusal');
    if (typeof recusa === 'string' && recusa.length > 0) throw new Error(`o modelo recusou responder: ${recusa}`);
    throw new Error('resposta sem texto em choices[0].message.content');
}

/** Corpo mínimo do formato OpenAI: sem `temperature` nem teto de tokens, que os
 *  modelos de raciocínio recusam — a resposta pedida já é curta. */
const corpoOpenAI = (prompt: string, modelo: string): unknown => ({
    model: modelo,
    messages: [{ role: 'user', content: prompt }]
});

/**
 * Cada provedor do jeito que ele pede — e SÓ o prompt: nenhum corpo aqui liga
 * busca na web, grounding nem ferramenta (sem `tools`, sem
 * `google_search_retrieval`, sem `web_search`). O juiz julga o cenário do
 * experimento com o contexto que recebeu; dado do mundo real atual não entra
 * nem por aqui.
 */
export const PROVEDORES: Record<ProvedorFronteira, DefinicaoProvedor> = {
    claude: {
        nome: 'Claude (Anthropic)',
        modeloPadrao: 'claude-opus-5-5',
        variaveisDeAmbiente: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
        url: () => 'https://api.anthropic.com/v1/messages',
        cabecalhos: chave => ({ 'x-api-key': chave, 'anthropic-version': '2023-06-01' }),
        corpo: (prompt, modelo) => ({
            model: modelo,
            max_tokens: MAX_TOKENS_RESPOSTA,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }]
        }),
        texto: resposta => {
            const partes = campo(resposta, 'content');
            if (Array.isArray(partes)) {
                const texto = partes
                    .filter(p => campo(p, 'type') === 'text')
                    .map(p => campo(p, 'text'))
                    .filter((t): t is string => typeof t === 'string')
                    .join('');
                if (texto.length > 0) return texto;
            }
            throw new Error('resposta sem bloco de texto em content[]');
        }
    },
    gpt: {
        nome: 'GPT (OpenAI)',
        modeloPadrao: 'gpt-5.1',
        variaveisDeAmbiente: ['OPENAI_API_KEY'],
        url: () => 'https://api.openai.com/v1/chat/completions',
        cabecalhos: chave => ({ Authorization: `Bearer ${chave}` }),
        corpo: corpoOpenAI,
        texto: textoOpenAI
    },
    gemini: {
        nome: 'Gemini (Google)',
        modeloPadrao: 'gemini-2.5-pro',
        variaveisDeAmbiente: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
        // A chave vai no cabeçalho, não na query: assim não entra em log de proxy.
        url: modelo => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`,
        cabecalhos: chave => ({ 'x-goog-api-key': chave }),
        corpo: prompt => ({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0 }
        }),
        texto: resposta => {
            const candidatos = campo(resposta, 'candidates');
            const partes = campo(campo(Array.isArray(candidatos) ? candidatos[0] : undefined, 'content'), 'parts');
            if (Array.isArray(partes)) {
                const texto = partes
                    .map(p => campo(p, 'text'))
                    .filter((t): t is string => typeof t === 'string')
                    .join('');
                if (texto.length > 0) return texto;
            }
            const motivo = campo(Array.isArray(candidatos) ? candidatos[0] : undefined, 'finishReason');
            throw new Error(
                `resposta sem texto em candidates[0].content.parts[]${typeof motivo === 'string' ? ` (finishReason: ${motivo})` : ''}`
            );
        }
    },
    deepseek: {
        nome: 'DeepSeek',
        modeloPadrao: 'deepseek-chat',
        variaveisDeAmbiente: ['DEEPSEEK_API_KEY'],
        url: () => 'https://api.deepseek.com/v1/chat/completions',
        cabecalhos: chave => ({ Authorization: `Bearer ${chave}` }),
        corpo: (prompt, modelo) => ({ ...(corpoOpenAI(prompt, modelo) as object), stream: false }),
        texto: textoOpenAI
    }
};

/** O modelo que vai ser chamado: o pedido manda, senão o padrão do provedor. */
export function modeloDoJuiz(provedor: ProvedorFronteira, modelo?: string): string {
    const pedido = modelo?.trim();
    return pedido && pedido.length > 0 ? pedido : PROVEDORES[provedor].modeloPadrao;
}

/** A chave do provedor no ambiente do servidor, quando a tela não mandou nenhuma. */
export function chaveDoAmbiente(
    provedor: ProvedorFronteira,
    ambiente: Record<string, string | undefined> = process.env
): string | undefined {
    for (const nome of PROVEDORES[provedor].variaveisDeAmbiente) {
        const valor = ambiente[nome]?.trim();
        if (valor) return valor;
    }
    return undefined;
}

// =============================================================================
// O prompt — cópia literal de src/python_engine/julgamento.py
// =============================================================================

/** Teto por linha livre da resposta: o PADRÃO de `MAX_CHARS_LINHA` em
 *  julgamento.py, que o motor local lê de `SPC_CML_JULGAMENTO_MAX_CHARS_LINHA`.
 *  Aqui é documentação do contrato (o provedor de fronteira não tem GBNF para
 *  prender a linha): a leitura da resposta não impõe tamanho. */
export const MAX_CHARS_LINHA = 400;

export const VEREDITOS: readonly Veredito[] = ['VALID', 'INVALID', 'UNRESOLVED'];

/**
 * `JULGAMENTO_INSTRUCAO` de src/python_engine/julgamento.py, caractere a
 * caractere, com os mesmos marcadores `{...}`. NÃO EDITAR de um lado só: o
 * teste compara os dois textos.
 */
export const INSTRUCAO_JULGAMENTO = `Voce e um avaliador independente de planos gerados por outro sistema.

Avalie se o PLANO e semanticamente compativel com:
1. o CENARIO;
2. o PEDIDO;
3. a POLITICA;
4. as REGRAS;
5. a TELEMETRIA;
6. as EVIDENCIAS fornecidas.

O CENARIO, as REGRAS e a POLITICA estao no bloco [CONHECIMENTO RECUPERADO]; a
lista [POLITICA VIGENTE] dele e a autoridade sobre as decisoes admissiveis.

A TELEMETRIA E A BASE DA VERDADE. Os dados vem de um cenario de experimento, nao
do mundo real: os valores da [TELEMETRIA] foram medidos no cenario, e e sobre
eles que as REGRAS e a POLITICA do [CONHECIMENTO RECUPERADO] se avaliam. A
[TELEMETRIA] e a autoridade sobre o estado do cenario, como a [POLITICA VIGENTE]
e sobre as decisoes admissiveis. Nao confronte o cenario com o mundo real atual:
data, lugar, nome, preco, faixa tipica de sensor, estatistica e pratica usual que
voce conheca de fora nao valem aqui, nem para confirmar nem para contestar.

AS REGRAS SAO FECHADAS. O [CONHECIMENTO RECUPERADO] e o universo normativo
INTEIRO deste julgamento: ele foi recuperado do grafo do especialista para este
cenario, e o que nao esta nele nao existe aqui. As regras e a politica de la
valem como dadas; nao as discuta, nao as corrija nem as complete, e julgue o
PLANO por elas. Nenhuma norma, protocolo, diretriz, limite ou boa pratica que
voce conheca de fora entra no julgamento, nem para reprovar o plano nem para
aprova-lo. Toda evidencia que voce citar tem de estar na [TELEMETRIA], no
[CONHECIMENTO RECUPERADO], nas [EVIDENCIAS], no [PEDIDO] ou no [PLANO].

O PEDIDO E INTENCAO, NAO OBRIGACAO. Nem todo pedido pode ser atendido: a
[POLITICA VIGENTE] pode marcar o item [RESTRITO], nao admitir a decisao que o
pedido nomeia, ou nao admitir decisao nenhuma para ele. Quando e assim, o plano
que NAO faz o que foi pedido e o plano certo: nao reprove por isso, e cite a
restricao como evidencia. Atender o pedido tambem nao justifica nada: plano que
faz o que foi pedido contra uma regra do [CONHECIMENTO RECUPERADO] e INVALID.
Reprove por causa do pedido so quando a [POLITICA VIGENTE] admite para o item a
decisao que o pedido nomeia e o plano escolheu outra. E se o pedido nao cita item
nenhum do [CONHECIMENTO RECUPERADO], nao ha como concluir que foi atendido:
responda UNRESOLVED.

Criterios:
- Nao exija igualdade textual com um plano de referencia: planos diferentes podem ser igualmente corretos.
- Nao considere uma justificativa diferente como erro se ela continuar sustentada pelas evidencias fornecidas.
- Nao invente regras, restricoes, valores nem telemetria que nao estejam no contexto abaixo.
- Nao duvide de um valor da TELEMETRIA por parecer improvavel, extremo, fora de faixa tipica ou incompativel com o mundo real: ele foi medido no cenario e vale como esta.
- Nao corrija, arredonde, converta unidade nem reinterprete um valor da TELEMETRIA.
- Nao traga norma, diretriz, protocolo, limite nem boa pratica de fora: o que nao esta no [CONHECIMENTO RECUPERADO] nao existe para este julgamento.
- Nao exija uma decisao que a POLITICA nao admite.
- Nao reprove o plano por nao fazer o que o pedido pede quando a POLITICA VIGENTE nao admite a decisao pedida: ai nao atender e o correto.
- Nao reprove so porque voce trataria o caso de outro modo.
- Nao use conhecimento externo como autoridade, nem contra nem a favor do contexto fornecido.
- Nao transforme conhecimento ausente em reprovacao.
- Se a regra que decidiria o caso nao esta no [CONHECIMENTO RECUPERADO], ou se houver informacao insuficiente para concluir, responda UNRESOLVED e diga o que faltou.
- Se houver uma violacao concreta e demonstravel a partir do contexto, responda INVALID e cite-a.
- Caso contrario, responda VALID.

[PEDIDO]
{pedido}

[TELEMETRIA]
{telemetria}

[CONHECIMENTO RECUPERADO]
{conhecimento}

[EVIDENCIAS]
{evidencias}

[PLANO]
{plano}

Responda exatamente neste formato, sem mais nada:
evidencias: <fatos concretos do contexto acima que sustentam o veredito, separados por ;>
justificativa: <por que o plano e compativel, qual violacao concreta ele comete, ou o que falta para concluir>
veredito: <VALID, INVALID ou UNRESOLVED>

resposta:
`;

const CAMPOS_PROMPT = ['pedido', 'telemetria', 'conhecimento', 'evidencias', 'plano'] as const;

/**
 * O prompt do juiz para um `PedidoJuiz` — o mesmo que
 * `montar_prompt_julgamento` monta no motor, com os mesmos textos de campo
 * vazio ("(nao informado)", "(plano vazio)").
 *
 * Uma passada só sobre o molde, como `str.format`: um `{plano}` que apareça
 * DENTRO do conhecimento recuperado é texto, não marcador.
 */
export function montarPromptJulgamento(pedido: PedidoJuiz): string {
    const vazio = '(nao informado)';
    const valores: Record<(typeof CAMPOS_PROMPT)[number], string> = {
        pedido: pedido.pedido.trim() || vazio,
        telemetria: pedido.telemetria.trim() || vazio,
        conhecimento: pedido.conhecimento.trim() || vazio,
        evidencias: pedido.evidencias.trim() || vazio,
        plano: pedido.plano.trim() || '(plano vazio)'
    };
    return INSTRUCAO_JULGAMENTO.replace(
        /\{(pedido|telemetria|conhecimento|evidencias|plano)\}/g,
        (_, chave: (typeof CAMPOS_PROMPT)[number]) => valores[chave]
    );
}

// =============================================================================
// A leitura da resposta — `ler_julgamento` sem a garantia da GBNF
// =============================================================================

/** A saída do juiz não tem o formato de `JULGAMENTO_GBNF`: não é um veredito. */
export class JulgamentoIlegivel extends Error {
    constructor(mensagem: string) {
        super(mensagem);
        this.name = 'JulgamentoIlegivel';
    }
}

const CAMPOS_RESPOSTA = ['evidencias', 'justificativa', 'veredito'] as const;

/** Sem acentos, sem negrito/cerca, minúsculo: `**Evidências**` -> `evidencias`. */
function normalizarChave(bruta: string): string {
    return bruta
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[*`_#\s]/g, '')
        .toLowerCase();
}

const SEM_ENFEITE = /^[*`_\s]+|[*`_\s]+$/g;

/**
 * Lê a resposta do juiz: veredito, justificativa, evidências (lista) e a
 * resposta bruta. Levanta `JulgamentoIlegivel` se faltar qualquer campo ou o
 * veredito não for um dos três — sem valor padrão, como no motor.
 *
 * Diferença em relação a `ler_julgamento`: ali a GBNF já garantia as três
 * linhas exatas, aqui não há gramática nenhuma. Então a FORMATAÇÃO é tolerada
 * (cerca de código, `-`/`#` no começo, `**negrito**`, acento em "evidências",
 * linhas a mais em volta) e do veredito lê-se só o primeiro termo
 * (`veredito: VALID (o plano...)` -> `VALID`). O CONTEÚDO não é tolerado: três
 * campos obrigatórios, veredito entre os três, nada deduzido do resto do texto.
 */
export function lerJulgamento(texto: string): RespostaJuizLLM {
    const campos = new Map<string, string>();
    for (const bruta of texto.split(/\r?\n/)) {
        const linha = bruta.replace(/^[\s>*\-+#•]+/, '');
        const corte = linha.indexOf(':');
        if (corte < 0) continue;
        const chave = normalizarChave(linha.slice(0, corte));
        if (!(CAMPOS_RESPOSTA as readonly string[]).includes(chave) || campos.has(chave)) continue;
        campos.set(chave, linha.slice(corte + 1).replace(SEM_ENFEITE, ''));
    }

    const faltando = CAMPOS_RESPOSTA.filter(c => !campos.get(c));
    if (faltando.length > 0) {
        throw new JulgamentoIlegivel(`resposta do juiz sem ${faltando.join(', ')}: ${JSON.stringify(texto)}`);
    }

    const bruto = campos.get('veredito')!;
    const primeiroTermo = /[A-Za-z_]+/.exec(bruto)?.[0].toUpperCase();
    if (!primeiroTermo || !(VEREDITOS as readonly string[]).includes(primeiroTermo)) {
        throw new JulgamentoIlegivel(`veredito do juiz fora de ${VEREDITOS.join(', ')}: ${JSON.stringify(bruto)}`);
    }

    return {
        veredito: primeiroTermo as Veredito,
        justificativa: campos.get('justificativa')!,
        evidencias: campos
            .get('evidencias')!
            .split(';')
            .map(e => e.trim())
            .filter(e => e.length > 0),
        respostaBruta: texto
    };
}

// =============================================================================
// A chamada
// =============================================================================

/** Repetições automáticas: o que o provedor diz ser temporário. */
const STATUS_TEMPORARIO = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/**
 * QUAL PEÇA a falha acusa — é o que separa "a chave está errada" de "o modelo
 * não existe" de "o provedor está sobrecarregado", que na tela são três
 * conselhos diferentes:
 *
 *  - `chave`: a credencial foi recusada (ou não há nenhuma);
 *  - `modelo`: a credencial passou, o nome do modelo é que não existe para ela;
 *  - `cota`: chave e modelo certos, limite de uso estourado;
 *  - `provedor`: o provedor aceitou e não conseguiu atender agora (5xx);
 *  - `rede`: não se chegou ao provedor (DNS, proxy, timeout da tentativa);
 *  - `formato`: o modelo respondeu, mas fora do contrato do juiz;
 *  - `desconhecida`: o provedor recusou por outro motivo — leia a mensagem.
 */
export type CausaFalhaJuiz = 'chave' | 'modelo' | 'cota' | 'provedor' | 'rede' | 'formato' | 'desconhecida';

/** A falha de uma chamada ao juiz, já dizendo que peça ela acusa. */
export class FalhaJuiz extends Error {
    constructor(
        mensagem: string,
        readonly causa: CausaFalhaJuiz,
        /** O status HTTP do provedor, quando houve resposta. */
        readonly status?: number
    ) {
        super(mensagem);
        this.name = 'FalhaJuiz';
    }
}

/**
 * A peça acusada por uma recusa do provedor. O status manda; o corpo só desempata
 * os genéricos, porque os provedores discordam entre si: o Gemini recusa chave
 * inválida com 400 INVALID_ARGUMENT (`API_KEY_INVALID`), onde OpenAI, Anthropic
 * e DeepSeek usam 401. Modelo inexistente é 404 nos quatro.
 *
 * O que NÃO se deduz daqui: 5xx e 429 não dizem nada contra a chave nem contra
 * o nome do modelo — o provedor só chega a eles depois de autenticar o pedido
 * e achar o modelo.
 */
export function causaDoStatus(status: number, corpo = ''): CausaFalhaJuiz {
    const texto = corpo.toLowerCase();
    if (status === 401 || status === 403) return 'chave';
    if (status === 429) return 'cota';
    if (status >= 500) return 'provedor';
    if (status === 404) return 'modelo';
    if (status === 400 || status === 422) {
        if (/api[-_ ]?key|api_key_invalid|unauthenticated|credential|permission/.test(texto)) return 'chave';
        if (/model/.test(texto)) return 'modelo';
    }
    return 'desconhecida';
}

function cancelado(): Error {
    const erro = new Error('julgamento cancelado');
    erro.name = 'AbortError';
    return erro;
}

/** Espera `ms`, ou desiste assim que `sinal` abortar. */
function esperarPadrao(ms: number, sinal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (sinal.aborted) {
            reject(cancelado());
            return;
        }
        let id: ReturnType<typeof setTimeout> | undefined;
        const abortar = (): void => {
            clearTimeout(id);
            reject(cancelado());
        };
        id = setTimeout(() => {
            sinal.removeEventListener('abort', abortar);
            resolve();
        }, ms);
        sinal.addEventListener('abort', abortar, { once: true });
    });
}

export interface OpcoesJuizFronteira {
    /** O modelo do provedor. Ausente: `PROVEDORES[provedor].modeloPadrao`. */
    modelo?: string;
    /** Teto de UMA chamada, em ms. */
    timeoutMs?: number;
    /**
     * Teto do julgamento INTEIRO (todas as tentativas mais as esperas), em ms.
     * Sem ele, um provedor que não responde custava `timeoutMs × tentativas` num
     * único plano — 3 × 180 s = 9 minutos de lote parado, medido. Nunca é menor
     * que `timeoutMs`: a primeira tentativa sempre tem a janela inteira.
     * Padrão: o dobro de `timeoutMs`.
     */
    orcamentoMs?: number;
    /** Chamadas por julgamento, contando a primeira (1 = não repete). */
    tentativas?: number;
    /** Injeção de teste: o `fetch` usado. */
    buscar?: typeof fetch;
    /** Injeção de teste: a espera entre as repetições. */
    esperar?: (ms: number, sinal: AbortSignal) => Promise<void>;
    /** Injeção de teste: o relógio que mede o orçamento. */
    agora?: () => number;
}

/** Quanto esperar antes de repetir: o `retry-after` do provedor, senão 1s, 2s, 4s… (teto de 30s). */
function esperaAntesDeRepetir(resposta: Response | null, tentativa: number): number {
    const cabecalho = resposta?.headers.get('retry-after');
    const segundos = cabecalho ? Number(cabecalho) : NaN;
    if (Number.isFinite(segundos) && segundos >= 0) return Math.min(segundos * 1000, 60_000);
    return Math.min(1000 * 2 ** (tentativa - 1), 30_000);
}

/** No máximo isto do corpo de erro vai para a mensagem — provedor pode devolver HTML inteiro. */
const MAX_CHARS_ERRO = 400;

/**
 * O corpo de erro do provedor, pronto para entrar numa mensagem: recortado e
 * SEM a chave. A mensagem de uma falha do juiz vira `julgamentoLLM.motivo` e é
 * gravada no JSONL — se o provedor ecoar a chave no erro dele (alguns ecoam o
 * pedido), ela não pode viajar junto.
 */
function saneado(texto: string, chave: string): string {
    const sem = chave.length > 0 ? texto.split(chave).join('[chave omitida]') : texto;
    return sem.length > MAX_CHARS_ERRO ? `${sem.slice(0, MAX_CHARS_ERRO)}…` : sem;
}

/** Uma falha que vale repetir (status temporário, rede, timeout da tentativa). */
class FalhaTemporaria extends Error {
    constructor(
        mensagem: string,
        readonly resposta: Response | null,
        /** A peça acusada, para quando as tentativas acabarem. */
        readonly causa: CausaFalhaJuiz
    ) {
        super(mensagem);
        this.name = 'FalhaTemporaria';
    }
}

/**
 * O juiz LLM num modelo de fronteira: monta o MESMO prompt do motor, chama a
 * API do provedor e lê a resposta com `lerJulgamento`. `sinal` cancela a
 * chamada em andamento e a espera entre repetições.
 *
 * Erros (chave recusada, modelo inexistente, resposta ilegível, provedor fora
 * do ar) sobem como `Error`: a cascata os registra como `NO_RESPONSE` com o
 * motivo e segue com as camadas determinísticas — nenhum veredito é inventado.
 * A mensagem nomeia provedor e modelo, e nunca contém a chave.
 */
export function juizFronteira(provedor: ProvedorFronteira, apiKey: string, opcoes: OpcoesJuizFronteira = {}): JuizLLM {
    const definicao = PROVEDORES[provedor];
    const modelo = modeloDoJuiz(provedor, opcoes.modelo);
    const timeoutMs = opcoes.timeoutMs ?? 120_000;
    // Nunca abaixo de timeoutMs: a primeira tentativa tem sempre a janela inteira.
    const orcamentoMs = Math.max(opcoes.orcamentoMs ?? timeoutMs * 2, timeoutMs);
    const tentativas = Math.max(1, opcoes.tentativas ?? 3);
    const buscar = opcoes.buscar ?? fetch;
    const esperar = opcoes.esperar ?? esperarPadrao;
    const agora = opcoes.agora ?? Date.now;
    const chave = apiKey.trim();

    const rotular = (detalhe: string, causa: CausaFalhaJuiz, status?: number): FalhaJuiz =>
        new FalhaJuiz(`juiz ${provedor} (${modelo}): ${detalhe}`, causa, status);

    const umaTentativa = async (prompt: string, sinal: AbortSignal, janelaMs: number): Promise<string> => {
        const timeout = AbortSignal.timeout(janelaMs);
        const combinado = new AbortController();
        const abortar = (): void => combinado.abort();
        timeout.addEventListener('abort', abortar);
        sinal.addEventListener('abort', abortar);

        let resposta: Response;
        try {
            resposta = await buscar(definicao.url(modelo), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...definicao.cabecalhos(chave) },
                body: JSON.stringify(definicao.corpo(prompt, modelo)),
                signal: combinado.signal
            });
        } catch (error) {
            if (sinal.aborted) throw cancelado();
            const motivo = timeout.aborted ? `sem resposta em ${Math.round(janelaMs / 1000)}s` : (error as Error).message;
            throw new FalhaTemporaria(`provedor inacessivel: ${motivo}`, null, 'rede');
        } finally {
            timeout.removeEventListener('abort', abortar);
            sinal.removeEventListener('abort', abortar);
        }

        if (!resposta.ok) {
            const corpo = saneado(await resposta.text().catch(() => ''), chave);
            const causa = causaDoStatus(resposta.status, corpo);
            if (resposta.status === 401 || resposta.status === 403) {
                throw rotular(`chave de API recusada (${resposta.status}): ${corpo}`, causa, resposta.status);
            }
            const detalhe = `o provedor respondeu ${resposta.status}: ${corpo}`;
            if (STATUS_TEMPORARIO.has(resposta.status)) throw new FalhaTemporaria(detalhe, resposta, causa);
            throw rotular(detalhe, causa, resposta.status);
        }

        let carga: unknown;
        try {
            carga = await resposta.json();
        } catch (error) {
            if (sinal.aborted) throw cancelado();
            // Respondeu 2xx com algo que não é JSON: isso é formato, não rede —
            // mas vale repetir, que é o que um proxy no meio costuma pedir.
            throw new FalhaTemporaria(`resposta nao e JSON: ${(error as Error).message}`, resposta, 'formato');
        }
        return definicao.texto(carga);
    };

    return async (pedido, sinal) => {
        if (!chave) throw rotular('nenhuma chave de API informada', 'chave');
        const prompt = montarPromptJulgamento(pedido);

        // O orçamento vale para o julgamento inteiro: cada tentativa recebe o que
        // resta dele, e a espera entre tentativas não pode consumir o que sobrou.
        const fim = agora() + orcamentoMs;
        const restante = (): number => fim - agora();

        let ultima: FalhaTemporaria | null = null;
        let feitas = 0;
        let porOrcamento = false;
        for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
            if (sinal.aborted) throw cancelado();
            const janela = Math.min(timeoutMs, restante());
            if (janela <= 0) {
                porOrcamento = true;
                break;
            }
            feitas = tentativa;
            try {
                return lerJulgamento(await umaTentativa(prompt, sinal, janela));
            } catch (error) {
                if (!(error instanceof FalhaTemporaria)) {
                    // Resposta ilegível e erro definitivo não se repetem: o modelo
                    // respondeu, e repetir só gastaria chamada.
                    if (error instanceof JulgamentoIlegivel) throw rotular(error.message, 'formato');
                    if (error instanceof FalhaJuiz || (error as Error).name === 'AbortError') throw error;
                    // Sobra o que `definicao.texto` recusou: carga 2xx sem texto
                    // no lugar que o formato do provedor manda, ou recusa dele.
                    throw rotular((error as Error).message, 'formato');
                }
                ultima = error;
                if (tentativa >= tentativas) continue;
                // Não vale esperar se, depois da espera, não sobra janela para tentar.
                const espera = Math.min(esperaAntesDeRepetir(error.resposta, tentativa), restante());
                if (espera <= 0 || restante() <= espera) {
                    porOrcamento = true;
                    break;
                }
                await esperar(espera, sinal);
            }
        }
        const conta = `${feitas} tentativa(s)${porOrcamento ? `, orcamento de ${Math.round(orcamentoMs / 1000)}s esgotado` : ''}`;
        throw rotular(`${ultima!.message} (${conta})`, ultima!.causa, ultima!.resposta?.status);
    };
}

// =============================================================================
// Teste de conexão — a mesma chamada, com um julgamento de brinquedo
// =============================================================================

/**
 * O julgamento MÍNIMO do teste de conexão: um pedido, uma medida, uma política
 * de uma linha e um plano que a satisfaz. Não mede qualidade de juiz nenhum e
 * não entra em avaliação alguma — existe para a chamada ser REAL e barata: a
 * mesma URL, o mesmo cabeçalho de autenticação, o mesmo formato de corpo, o
 * mesmo prompt (`montarPromptJulgamento`) e a mesma leitura da resposta
 * (`lerJulgamento`) que o rejulgamento usa. Se isto passa, o que falta para
 * avaliar é só tempo.
 */
export const PEDIDO_TESTE_CONEXAO: PedidoJuiz = {
    pedido: 'Teste de conexao do avaliador. Confirme que o plano respeita a politica.',
    telemetria: 'temperatura_c: 20',
    conhecimento: '[CENARIO]\nUm sensor mediu a temperatura.\n\n[REGRAS]\n- R1: temperatura_c abaixo de 30 permite registrar a medida.\n\n[POLITICA VIGENTE]\n- registrar_medida',
    evidencias: 'R1 satisfeita: temperatura_c = 20, abaixo de 30.',
    plano: 'registrar_medida(temperatura_c: 20)'
};

export interface OpcoesTesteConexao extends OpcoesJuizFronteira {
    /** Cancela o teste em andamento (a tela fechou, o usuário desistiu). */
    sinal?: AbortSignal;
}

/** O que o teste de conexão descobriu — pronto para ir para a tela. */
export interface ResultadoTesteConexao {
    /** A chave foi aceita, o modelo respondeu e a resposta tinha o formato do juiz. */
    ok: boolean;
    provedor: ProvedorFronteira;
    /** O modelo que foi chamado: o pedido, ou o padrão do provedor. */
    modelo: string;
    /** Quanto a chamada levou, em ms — é a ordem de grandeza por plano na avaliação. */
    ms: number;
    /** O veredito do julgamento de brinquedo, quando houve. Serve de prova de vida, não de nota. */
    veredito?: Veredito;
    /** Por que falhou: a mensagem de `juizFronteira`, já sem a chave. */
    erro?: string;
    /** QUE PEÇA a falha acusa — é o que a tela usa para dizer o que rever. */
    causa?: CausaFalhaJuiz;
    /** O status HTTP do provedor, quando houve resposta. */
    status?: number;
}

/**
 * Testa provedor + modelo + chave com UMA chamada de verdade, e devolve o
 * resultado em vez de levantar: chave recusada, modelo inexistente, provedor
 * fora do ar e resposta ilegível viram `{ ok: false, erro, causa }` — a
 * mensagem é a de `juizFronteira`, que nomeia provedor e modelo e nunca contém
 * a chave, e `causa` diz QUE PEÇA ela acusa, para a tela não obrigar ninguém a
 * decifrar o corpo do provedor.
 * Cancelamento (`sinal`) é a única coisa que sobe como exceção (`AbortError`).
 *
 * SEM REPETIÇÃO por padrão (`tentativas: 1`): quem está testando quer a falha
 * na hora, com o status que o provedor deu, e não a espera exponencial da
 * avaliação. Um 429 ou um 503, que ali seriam repetidos, aqui voltam como
 * falha do teste — com o status na mensagem, que é o que diz se o problema é
 * de cota ou de credencial.
 */
export async function testarConexaoJuiz(
    provedor: ProvedorFronteira,
    apiKey: string,
    opcoes: OpcoesTesteConexao = {}
): Promise<ResultadoTesteConexao> {
    const { sinal, ...resto } = opcoes;
    const modelo = modeloDoJuiz(provedor, opcoes.modelo);
    const juiz = juizFronteira(provedor, apiKey, { tentativas: 1, ...resto, modelo });
    const comeco = Date.now();
    try {
        const resposta = await juiz(PEDIDO_TESTE_CONEXAO, sinal ?? new AbortController().signal);
        return { ok: true, provedor, modelo, ms: Date.now() - comeco, veredito: resposta.veredito };
    } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        const falha = error instanceof FalhaJuiz ? error : null;
        return {
            ok: false,
            provedor,
            modelo,
            ms: Date.now() - comeco,
            erro: (error as Error).message,
            causa: falha?.causa ?? 'desconhecida',
            ...(falha?.status !== undefined ? { status: falha.status } : {})
        };
    }
}
