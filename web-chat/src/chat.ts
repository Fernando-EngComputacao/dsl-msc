import { computed, nextTick, ref } from 'vue';
import {
    buscarDominios,
    enviarComandoStream,
    criarChat,
    atualizarChat,
    type Dominio,
} from './api';
import type { Mensagem, ItemResultadoLote } from './types';
import { parseArquivoLote, type CenarioLote } from './lote';

/** Estado do chat vive fora de qualquer componente (mesmo padrao de theme.ts)
 *  para sobreviver a navegacao entre "/" e "/avaliar" sem depender de
 *  KeepAlive nem de repassar refs entre rotas. */

export const dominios = ref<Dominio[]>([]);
export const dominioAtual = ref<'med' | 'agro' | 'fut'>('med');
export const erroCarregamento = ref<string | null>(null);

export const mensagens = ref<Mensagem[]>([]);
export const textoInput = ref('');
export const enviando = ref(false);
export const areaMensagens = ref<HTMLElement | null>(null);
let proximoId = 1;

export const controladorAtual = ref<AbortController | null>(null);
export const modalTrocaAberto = ref(false);
export const dominioPendente = ref<'med' | 'agro' | 'fut' | null>(null);

export const chatIdAtual = ref<string | null>(null);

export const inputArquivoLote = ref<HTMLInputElement | null>(null);
export const loteAtivo = ref(false);
export const loteControlador = ref<AbortController | null>(null);
export const modalPararLoteAberto = ref(false);
export const modalEscolherModeloLoteAberto = ref(false);
export const dominioLoteSelecionado = ref<'med' | 'agro' | 'fut' | null>(null);

export function nomeDominio(id: 'med' | 'agro' | 'fut'): string {
    return dominios.value.find((d) => d.id === id)?.nome ?? id;
}

const SUGESTOES: Record<'med' | 'agro' | 'fut', string[]> = {
    med: [
        'A pressão caiu, PAM 52. Sobe a noradrenalina.',
        'Paciente agitado no ventilador, aumenta a sedação.',
        'Glicemia deu 320, inicia insulina em bomba.',
    ],
    agro: [
        'Vento forte mas a janela fecha hoje, manda o glifosato na soja.',
        'NDVI despencou e o talhão fica perto do córrego. Aplica atrazina?',
        'A cana tá com a folha fervendo, começa o imidacloprido.',
    ],
    fut: [
        'O zagueiro chegou atrasado e bateu na canela do atacante dentro da área, marca o pênalti!',
        'O jogador já tem amarelo e entrou forte de novo, dá a segunda amarela.',
        'O atacante saiu na cara do gol mas tava impedido antes do passe, anula o gol.',
    ],
};

export const sugestoesAtuais = computed(() => SUGESTOES[dominioAtual.value]);

export async function carregarDominios(): Promise<void> {
    try {
        dominios.value = await buscarDominios();
        if (dominios.value.length > 0) dominioAtual.value = dominios.value[0].id;
    } catch (error) {
        erroCarregamento.value = (error as Error).message;
    }
}

/** Cria o chat na primeira mensagem e atualiza o mesmo arquivo dali em diante —
 *  fica so como registro local do experimento, sem navegacao no sidebar.
 *  Chamadas (no envio, na resposta, no lote, na troca de dominio...) disparam
 *  sem await em paralelo — encadeadas numa fila, senão duas chamadas correndo
 *  antes da primeira preencher chatIdAtual criam dois chats em vez de um so
 *  sendo atualizado. Falha ao persistir localmente nao deve travar o chat em
 *  memoria. */
let filaSalvarChat: Promise<void> = Promise.resolve();
function salvarChatAtual(): void {
    if (mensagens.value.length === 0) return;
    filaSalvarChat = filaSalvarChat.then(async () => {
        try {
            const chat = chatIdAtual.value
                ? await atualizarChat(chatIdAtual.value, dominioAtual.value, mensagens.value)
                : await criarChat(dominioAtual.value, mensagens.value);
            chatIdAtual.value = chat.id;
        } catch {
            // idem
        }
    });
}

export function novoChat(): void {
    if (enviando.value) pararGeracao();
    if (loteAtivo.value) loteControlador.value?.abort();
    mensagens.value = [];
    chatIdAtual.value = null;
    textoInput.value = '';
}

async function rolarParaFinal(): Promise<void> {
    await nextTick();
    if (areaMensagens.value) {
        areaMensagens.value.scrollTop = areaMensagens.value.scrollHeight;
    }
}

export async function enviar(textoForcado?: string): Promise<void> {
    const texto = (textoForcado ?? textoInput.value).trim();
    if (!texto || enviando.value || loteAtivo.value) return;

    textoInput.value = '';
    enviando.value = true;
    const controlador = new AbortController();
    controladorAtual.value = controlador;

    mensagens.value.push({
        id: proximoId++,
        autor: 'usuario',
        dominio: dominioAtual.value,
        texto,
    });
    const idResposta = proximoId++;
    mensagens.value.push({
        id: idResposta,
        autor: 'assistente',
        dominio: dominioAtual.value,
        carregando: true,
    });
    rolarParaFinal();
    salvarChatAtual();

    try {
        const resposta = await enviarComandoStream(
            dominioAtual.value,
            texto,
            (textoEstagio) => {
                const alvo = mensagens.value.find((m) => m.id === idResposta);
                if (alvo) alvo.estagio = textoEstagio;
                rolarParaFinal();
            },
            controlador.signal,
        );
        const alvo = mensagens.value.find((m) => m.id === idResposta);
        if (alvo) {
            alvo.carregando = false;
            alvo.resposta = resposta;
            alvo.texto = texto;
        }
    } catch (error) {
        // Abortado por causa de uma troca de modelo confirmada: essa mensagem ja
        // foi marcada como interrompida em confirmarTrocaDominio, nada a fazer aqui.
        if ((error as Error).name === 'AbortError') return;

        const alvo = mensagens.value.find((m) => m.id === idResposta);
        if (alvo) {
            alvo.carregando = false;
            alvo.erro = (error as Error).message;
        }
    } finally {
        enviando.value = false;
        controladorAtual.value = null;
        rolarParaFinal();
        salvarChatAtual();
    }
}

/** Botao de enviar vira "parar" enquanto uma geracao esta em andamento. */
export function pararGeracao(): void {
    const emAndamento = mensagens.value.find((m) => m.autor === 'assistente' && m.carregando);
    if (emAndamento) {
        emAndamento.carregando = false;
        emAndamento.erro = 'Interrompido pelo usuário.';
    }
    controladorAtual.value?.abort();
}

export function aoTeclar(evento: KeyboardEvent): void {
    if (evento.key === 'Enter' && !evento.shiftKey) {
        evento.preventDefault();
        enviar();
    }
}

/** Aplica a troca de dominio de fato: atualiza o estado e anuncia na conversa. */
function trocarDominio(novo: 'med' | 'agro' | 'fut'): void {
    dominioAtual.value = novo;
    if (mensagens.value.length > 0) {
        mensagens.value.push({
            id: proximoId++,
            autor: 'sistema',
            dominio: novo,
            dominioNome: nomeDominio(novo),
        });
        rolarParaFinal();
        salvarChatAtual();
    }
}

/** Handler do DomainPicker: so troca na hora se nao houver nada em andamento. */
export function aoEscolherDominio(novo: string): void {
    const alvo = novo as 'med' | 'agro' | 'fut';
    if (alvo === dominioAtual.value) return;

    if (enviando.value || loteAtivo.value) {
        dominioPendente.value = alvo;
        modalTrocaAberto.value = true;
        return;
    }
    trocarDominio(alvo);
}

export function confirmarTrocaDominio(): void {
    if (!dominioPendente.value) return;

    const emAndamento = mensagens.value.find((m) => m.autor === 'assistente' && m.carregando);
    if (emAndamento) {
        emAndamento.carregando = false;
        emAndamento.erro = 'Interrompido: o modelo foi alterado antes da resposta terminar.';
    }
    controladorAtual.value?.abort();

    const loteEmAndamento = mensagens.value.find((m) => m.autor === 'lote' && m.lote && !m.lote.finalizado);
    if (loteEmAndamento?.lote) loteEmAndamento.lote.cancelado = true;
    loteControlador.value?.abort();

    const novo = dominioPendente.value;
    modalTrocaAberto.value = false;
    dominioPendente.value = null;
    trocarDominio(novo);
}

export function cancelarTrocaDominio(): void {
    modalTrocaAberto.value = false;
    dominioPendente.value = null;
}

export function abrirSeletorArquivo(): void {
    if (enviando.value || loteAtivo.value) return;
    modalEscolherModeloLoteAberto.value = true;
}

export function escolherModeloLote(id: string): void {
    modalEscolherModeloLoteAberto.value = false;
    const dominio = id as 'med' | 'agro' | 'fut';
    dominioLoteSelecionado.value = dominio;
    if (dominio !== dominioAtual.value) trocarDominio(dominio);
    inputArquivoLote.value?.click();
}

export function cancelarEscolhaModeloLote(): void {
    modalEscolherModeloLoteAberto.value = false;
}

export async function aoSelecionarArquivo(evento: Event): Promise<void> {
    const input = evento.target as HTMLInputElement;
    const arquivo = input.files?.[0];
    input.value = '';
    const dominio = dominioLoteSelecionado.value ?? dominioAtual.value;
    dominioLoteSelecionado.value = null;
    if (!arquivo || enviando.value || loteAtivo.value) return;

    let cenarios: CenarioLote[];
    try {
        const conteudo = await arquivo.text();
        cenarios = parseArquivoLote(arquivo.name, conteudo, dominio);
    } catch (error) {
        mensagens.value.push({
            id: proximoId++,
            autor: 'assistente',
            dominio,
            erro: `Falha ao ler "${arquivo.name}": ${(error as Error).message}`,
        });
        rolarParaFinal();
        return;
    }

    const idLote = proximoId++;
    mensagens.value.push({
        id: idLote,
        autor: 'lote',
        dominio,
        lote: {
            nomeArquivo: arquivo.name,
            total: cenarios.length,
            concluidos: 0,
            cancelado: false,
            finalizado: false,
            resultados: [],
            iniciadoEm: Date.now(),
        },
    });
    rolarParaFinal();
    salvarChatAtual();
    await rodarLote(cenarios, idLote, dominio);
}

/** Roda o pipeline completo uma vez por cenario do lote, sequencialmente — permite
 *  acompanhar "N/total concluidos" e cancelar entre um cenario e outro. */
async function rodarLote(cenarios: CenarioLote[], idLote: number, dominio: 'med' | 'agro' | 'fut'): Promise<void> {
    const msg = mensagens.value.find((m) => m.id === idLote);
    if (!msg?.lote) return;

    loteAtivo.value = true;
    const controlador = new AbortController();
    loteControlador.value = controlador;

    for (const [i, cenario] of cenarios.entries()) {
        if (controlador.signal.aborted) break;

        let item: ItemResultadoLote;
        try {
            const resposta = await enviarComandoStream(
                dominio,
                cenario.intencao,
                (textoEstagio) => {
                    msg.lote!.estagioAtual = textoEstagio;
                },
                controlador.signal,
                cenario.contexto,
            );
            item = {
                linha: i + 1,
                intencao: cenario.intencao,
                aceito: resposta.aceito,
                valido: resposta.valido,
                erroMotor: resposta.erroMotor,
                regrasEmGHat: resposta.regrasEmGHat,
                telemetria: resposta.sorteio,
                promptSemantico: resposta.promptSemantico,
                foco: resposta.foco,
                plano: resposta.resultado,
            };
        } catch (error) {
            if ((error as Error).name === 'AbortError') break;
            item = {
                linha: i + 1,
                intencao: cenario.intencao,
                aceito: false,
                erro: (error as Error).message,
            };
        }

        msg.lote.resultados.push(item);
        msg.lote.concluidos++;
        rolarParaFinal();
    }

    msg.lote.finalizado = true;
    msg.lote.estagioAtual = undefined;
    msg.lote.duracaoSegundos = Number(((Date.now() - msg.lote.iniciadoEm) / 1000).toFixed(1));
    loteAtivo.value = false;
    loteControlador.value = null;
    salvarChatAtual();
}

export function pedirPararLote(): void {
    modalPararLoteAberto.value = true;
}

export function confirmarPararLote(): void {
    modalPararLoteAberto.value = false;
    const msg = mensagens.value.find((m) => m.autor === 'lote' && m.lote && !m.lote.finalizado);
    if (msg?.lote) msg.lote.cancelado = true;
    loteControlador.value?.abort();
}

export function cancelarPararLote(): void {
    modalPararLoteAberto.value = false;
}

function nomeArquivoLote(): string {
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}_${d.getFullYear()}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jsonl`;
}

export function baixarResultadosLote(msg: Mensagem): void {
    const l = msg.lote;
    if (!l) return;

    const linhas = l.resultados.map((r) => JSON.stringify(r));
    linhas.push(
        JSON.stringify({
            duracaoSegundos: l.duracaoSegundos ?? Number(((Date.now() - l.iniciadoEm) / 1000).toFixed(1)),
        }),
    );
    const conteudo = linhas.join('\n');
    const blob = new Blob([conteudo], { type: 'application/x-ndjson;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `results/${nomeArquivoLote()}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
