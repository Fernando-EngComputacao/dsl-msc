/**
 * Decodificacao sob contrato — a volta que fecha o ciclo da Figura 5.1.
 *
 * A decodificacao restrita garante que a saida pertence a L(Ĝ). Com a
 * especializacao por item (ver `knowledge/politica.ts`), Ĝ ja carrega quase toda
 * a semantica: item, decisao, meio e valor sao escolhidos juntos, nao em
 * vocabularios independentes. O que sobra fora do alcance de uma gramatica livre
 * de contexto sao as propriedades do artefato INTEIRO — unicidade por item,
 * concordancia entre a `sequencia` declarada e as clausulas emitidas,
 * escalonamento disparado que nao virou ordem.
 *
 * Este modulo verifica exatamente essas propriedades e, quando a saida as viola,
 * NAO se limita a reprovar: ele repoda o subgrafo tirando o par (item, decisao)
 * que falhou e gera de novo. A gramatica da tentativa seguinte e estritamente
 * menor que a da anterior, entao o mesmo erro deixa de ser exprimivel — a
 * verificacao semantica realimenta a poda, em vez de so julgar no fim.
 *
 * Tudo aqui e agnostico de dominio: o contrato e derivado dos papeis declarados
 * por cada `graphrag-*.ts`, e este arquivo nunca menciona farmaco, produto nem
 * infracao.
 */

import {
    condutasObrigatorias,
    condutasRealizaveis,
    decisoesDaConduta,
    estadoVazio,
    lerClausula,
    montarArtefato,
    podarPorViolacoes,
    relatorioDeViolacoes,
    restringirACondutas,
    restringirADecisoes,
    verificarClausulaNova,
    verificarConduta,
    verificarContrato,
    type ContratoArtefato,
    type Violacao
} from '../knowledge/contrato.js';
import type { SubgrafoPodado } from '../knowledge/politica.js';

const ENDPOINT_PADRAO = process.env.SPC_CML_ENDPOINT ?? 'http://127.0.0.1:8000';
const TIMEOUT_PADRAO = Number(process.env.SPC_CML_TIMEOUT_MS ?? 600_000);

/**
 * Quantas geracoes no maximo por cenario. Cada tentativa custa uma decodificacao
 * inteira; o valor 3 cobre o caso tipico (uma violacao, uma repoda, um acerto)
 * sem transformar um cenario patologico em lote travado.
 */
const MAX_TENTATIVAS = Number(process.env.SPC_CML_MAX_TENTATIVAS ?? 3);

/** Resposta crua de `POST /generate-constrained` (ver python_engine/main.py). */
export interface RespostaMotor {
    resultado: string;
    valido: boolean;
    erro: string | null;
    g_hat_utilizada: string | null;
    regras_em_g_hat: number;
    /** `false` denuncia motor desatualizado: recebeu politicas e nao especializou. */
    especializada?: boolean;
}

export interface ResultadoDecodificacao extends RespostaMotor {
    /** Quantas geracoes foram necessarias (1 quando saiu certo de primeira). */
    tentativas: number;
    /** Violacoes que ainda restavam na ultima tentativa. */
    violacoes: Violacao[];
    /** O que cada tentativa violou — material de auditoria e de tese. */
    historico: { tentativa: number; violacoes: Violacao[] }[];
    conforme: boolean;
}

export async function chamarMotor(
    payload: { comando_humano: string; contexto_neo4j: string; subgrafo_regras: SubgrafoPodado },
    endpoint: string = ENDPOINT_PADRAO,
    timeoutMs: number = TIMEOUT_PADRAO
): Promise<RespostaMotor> {
    let response: Response;
    try {
        response = await fetch(`${endpoint}/generate-constrained`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs)
        });
    } catch (error) {
        const causa =
            (error as Error).name === 'TimeoutError'
                ? `sem resposta em ${timeoutMs / 1000}s (ajuste SPC_CML_TIMEOUT_MS)`
                : (error as Error).message;
        throw new Error(`${endpoint} inacessivel: ${causa}`);
    }

    if (!response.ok) {
        throw new Error(`${endpoint} respondeu ${response.status}: ${await response.text()}`);
    }
    const dados = (await response.json()) as RespostaMotor;

    // Um motor no ar com codigo antigo poda so pelos tres vocabularios e devolve
    // um artefato de aparencia normal — a correcao ja aplicada parece nao ter
    // efeito. Melhor falhar alto do que gerar sob a gramatica errada.
    if (payload.subgrafo_regras.politicas?.length > 0 && dados.especializada === false) {
        throw new Error(
            `${endpoint} ignorou a politica por item: o motor esta desatualizado. ` +
                'Reinicie o servico (uvicorn) para carregar grammar_from_kg.py atual.'
        );
    }
    return dados;
}

export interface OpcoesDecodificacao {
    comando: string;
    /** Prompt Semantico ja montado pelo dominio. */
    contexto: string;
    subgrafo: SubgrafoPodado;
    contrato: ContratoArtefato;
    endpoint?: string;
    timeoutMs?: number;
    maxTentativas?: number;
}

/**
 * Gera, verifica o contrato e — se preciso — repoda e gera de novo.
 *
 * Devolve sempre a ULTIMA saida, conforme ou nao, com as violacoes que restaram:
 * esconder uma saida nao conforme seria pior que devolve-la marcada, porque o
 * lote perderia o caso mais informativo que existe.
 */
export async function decodificarSobContrato(
    opts: OpcoesDecodificacao
): Promise<ResultadoDecodificacao> {
    const maxTentativas = opts.maxTentativas ?? MAX_TENTATIVAS;
    const historico: { tentativa: number; violacoes: Violacao[] }[] = [];

    let subgrafo = opts.subgrafo;
    let contrato = opts.contrato;
    let contexto = opts.contexto;
    let ultima: RespostaMotor | undefined;
    let violacoes: Violacao[] = [];

    for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
        ultima = await chamarMotor(
            {
                comando_humano: opts.comando,
                contexto_neo4j: contexto,
                subgrafo_regras: subgrafo
            },
            opts.endpoint,
            opts.timeoutMs
        );

        const veredito = verificarContrato(contrato, ultima.resultado);
        violacoes = veredito.violacoes;
        if (veredito.conforme) {
            return { ...ultima, tentativas: tentativa, violacoes: [], historico, conforme: true };
        }

        historico.push({ tentativa, violacoes });

        // Repoda: o par que falhou sai da politica, e com ele sai da gramatica.
        const menor = podarPorViolacoes(subgrafo, violacoes);
        const encolheu =
            menor.politicas.length < subgrafo.politicas.length ||
            menor.acoes_permitidas.length < subgrafo.acoes_permitidas.length;

        if (menor.politicas.length === 0 || !encolheu) {
            // Ou nao sobrou item algum, ou a violacao e do artefato (sequencia,
            // escalonamento) e nao ha o que retirar: insistir com a MESMA
            // gramatica so gastaria geracao. O relatorio vai no prompt e a
            // proxima tentativa e a ultima.
            if (!encolheu && tentativa < maxTentativas) {
                contexto = `${opts.contexto}\n\n${relatorioDeViolacoes(violacoes)}`;
                continue;
            }
            break;
        }

        subgrafo = menor;
        contrato = { ...contrato, politicas: new Map(menor.politicas.map(p => [p.item, p])) };
        contexto = `${opts.contexto}\n\n${relatorioDeViolacoes(violacoes)}`;
    }

    return {
        ...(ultima ?? {
            resultado: '',
            valido: false,
            erro: 'nenhuma tentativa concluida',
            g_hat_utilizada: null,
            regras_em_g_hat: 0
        }),
        tentativas: historico.length || 1,
        violacoes,
        historico,
        conforme: violacoes.length === 0
    };
}

/**
 * Modo de decodificacao. `incremental` (padrao) valida elemento a elemento no
 * grafo durante a montagem; `monolitica` gera o artefato inteiro e verifica o
 * contrato depois, com repoda e nova tentativa. A segunda existe para comparar
 * as duas na avaliacao — e como caminho de emergencia se o motor nao expuser
 * `/generate-fragment`.
 */
export async function decodificar(opts: OpcoesIncremental): Promise<ResultadoDecodificacao> {
    const modo = process.env.SPC_CML_DECODIFICACAO ?? 'incremental';
    return modo === 'monolitica'
        ? decodificarSobContrato(opts)
        : decodificarIncremental(opts);
}

// =============================================================================
// Decodificacao INCREMENTAL: um elemento por vez, validado no grafo
// =============================================================================

/**
 * Um passo da montagem: o elemento proposto pelo modelo e o que o contrato
 * decidiu sobre ele. E a trilha de auditoria da geracao — mostra nao so o que
 * ficou, mas o que foi descartado e por que.
 */
export interface PassoIncremental {
    fase: 'identificador' | 'sequencia' | 'clausula' | 'alerta' | 'auditoria';
    tentativa: number;
    proposto: string;
    aceito: boolean;
    motivo?: string;
}

export interface PedidoFragmento {
    simbolo: string;
    prefixo: string;
    subgrafo: SubgrafoPodado;
    /** Literal de controle que o modelo pode emitir para encerrar a lista. */
    encerramento?: string;
}

export interface RespostaFragmento {
    fragmento: string;
    encerrou: boolean;
    especializada?: boolean;
    regras_em_g_hat?: number;
}

/** Funcao que gera um fragmento. Injetavel para teste sem motor nem GPU. */
export type MotorFragmento = (
    pedido: PedidoFragmento,
    contexto: { comando: string; contexto: string }
) => Promise<RespostaFragmento>;

export interface OpcoesIncremental extends OpcoesDecodificacao {
    motor?: MotorFragmento;
    /** Tentativas por ELEMENTO antes de desistir daquela posicao. */
    maxTentativasPorElemento?: number;
    maxCondutas?: number;
    maxAlertas?: number;
}

export interface ResultadoIncremental extends ResultadoDecodificacao {
    passos: PassoIncremental[];
    /** Quantos elementos o contrato reprovou durante a montagem. */
    descartados: number;
}

const MAX_TENTATIVAS_ELEMENTO = Number(process.env.SPC_CML_MAX_TENTATIVAS_ELEMENTO ?? 3);
const MAX_CONDUTAS = Number(process.env.SPC_CML_MAX_CONDUTAS ?? 5);
const MAX_ALERTAS = Number(process.env.SPC_CML_MAX_ALERTAS ?? 2);

/** Motor padrao: `POST /generate-fragment` no servico Python. */
export function motorHttp(
    endpoint: string = ENDPOINT_PADRAO,
    timeoutMs: number = TIMEOUT_PADRAO
): MotorFragmento {
    return async (pedido, ctx) => {
        let response: Response;
        try {
            response = await fetch(`${endpoint}/generate-fragment`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    simbolo: pedido.simbolo,
                    prefixo: pedido.prefixo,
                    comando_humano: ctx.comando,
                    contexto_neo4j: ctx.contexto,
                    subgrafo_regras: pedido.subgrafo,
                    encerramento: pedido.encerramento ?? null
                }),
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (error) {
            const causa =
                (error as Error).name === 'TimeoutError'
                    ? `sem resposta em ${timeoutMs / 1000}s (ajuste SPC_CML_TIMEOUT_MS)`
                    : (error as Error).message;
            throw new Error(`${endpoint} inacessivel: ${causa}`);
        }
        if (!response.ok) {
            throw new Error(`${endpoint} respondeu ${response.status}: ${await response.text()}`);
        }
        const dados = (await response.json()) as RespostaFragmento;

        // Motor no ar com codigo velho poda so pelos tres vocabularios e devolve
        // um artefato de aparencia normal. Sem esta checagem, uma correcao ja
        // aplicada parece nao ter efeito — foi o que aconteceu uma vez.
        if (pedido.subgrafo.politicas.length > 0 && dados.especializada === false) {
            throw new Error(
                `${endpoint} ignorou a politica por item: o motor esta desatualizado. ` +
                    'Reinicie o servico (uvicorn) para carregar grammar_from_kg.py atual.'
            );
        }
        return dados;
    };
}

function limpar(texto: string): string {
    return texto.trim().replace(/\s+/g, ' ');
}

/**
 * Gera o artefato ELEMENTO A ELEMENTO, validando cada um no grafo antes de
 * aceita-lo.
 *
 * A ordem dos passos e a do proprio artefato: primeiro a `sequencia` de
 * condutas, depois uma clausula para cada conduta declarada. Isso resolve por
 * construcao a concordancia entre as duas — a clausula so pode usar as decisoes
 * que realizam a conduta daquela posicao, porque a gramatica do passo nao gera
 * as outras.
 *
 * Quando um elemento viola alguma regra, ele e DESCARTADO e a posicao e refeita
 * com o par reprovado fora da gramatica; a posicao so avanca quando o contrato
 * aceita. Nenhum elemento invalido chega ao artefato final.
 */
export async function decodificarIncremental(
    opts: OpcoesIncremental
): Promise<ResultadoIncremental> {
    const contrato = opts.contrato;
    const papeis = contrato.papeis;
    const motor = opts.motor ?? motorHttp(opts.endpoint, opts.timeoutMs);
    const maxTent = opts.maxTentativasPorElemento ?? MAX_TENTATIVAS_ELEMENTO;
    const ctx = { comando: opts.comando, contexto: opts.contexto };
    const passos: PassoIncremental[] = [];

    const contextoArtefato = contrato.contextos[0];
    if (!contextoArtefato || contrato.politicas.size === 0) {
        // Sem contexto recuperado ou sem item admissivel nao ha artefato a
        // montar: cai para o caminho monolitico, que sabe reportar isso.
        const saida = await decodificarSobContrato(opts);
        return { ...saida, passos, descartados: 0 };
    }

    let subgrafo = opts.subgrafo;
    const estado = estadoVazio();
    const clausulasTexto: string[] = [];
    const alertas: string[] = [];
    let descartados = 0;

    const prefixo = (fechado: boolean): string => {
        const cabeca =
            `${papeis.artefato} @ para ${contextoArtefato} {` +
            (contrato.esquema ? ` esquema_referencia ${contrato.esquema}` : '') +
            (contrato.sujeito ? ` ${papeis.campoSujeito} '${contrato.sujeito}'` : '') +
            ` sequencia [ ${estado.sequencia.join(' , ')}`;
        return fechado ? `${cabeca} ] ${clausulasTexto.join(' ')} ` : `${cabeca} `;
    };

    // ---------------------------------------------------------- identificador
    let identificador = `${papeis.artefato}_gerado`;
    try {
        const r = await motor(
            { simbolo: 'identificador', prefixo: `${papeis.artefato} `, subgrafo },
            ctx
        );
        const proposto = limpar(r.fragmento);
        if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(proposto)) identificador = proposto;
        passos.push({ fase: 'identificador', tentativa: 1, proposto, aceito: identificador === proposto });
    } catch (erro) {
        if ((erro as Error).message.includes('desatualizado')) throw erro;
        passos.push({ fase: 'identificador', tentativa: 1, proposto: '', aceito: false, motivo: (erro as Error).message });
    }

    // ------------------------------------------------------------- sequencia
    const maxCondutas = opts.maxCondutas ?? MAX_CONDUTAS;
    for (let posicao = 0; posicao < maxCondutas; posicao++) {
        const obrigatorias = condutasObrigatorias(contrato).filter(
            c => !estado.sequencia.includes(c)
        );
        const restante = maxCondutas - posicao;
        let admissiveis = condutasRealizaveis(contrato, estado);
        // Perto do teto, so as obrigatorias continuam admissiveis: o escalonamento
        // que o grafo disparou nao pode ficar de fora por falta de espaco.
        if (obrigatorias.length > 0 && restante <= obrigatorias.length) admissiveis = obrigatorias;
        if (admissiveis.length === 0) break;

        const podeEncerrar = estado.sequencia.length > 0 && obrigatorias.length === 0;
        let aceitou = false;
        let fechou = false;

        for (let tentativa = 1; tentativa <= maxTent && !aceitou; tentativa++) {
            const r = await motor(
                {
                    simbolo: papeis.conduta,
                    prefixo: prefixo(false),
                    subgrafo: restringirACondutas(subgrafo, admissiveis),
                    encerramento: podeEncerrar ? ']' : undefined
                },
                ctx
            );
            if (r.encerrou) {
                // Fechar a sequencia so encerra ESTA fase: as clausulas que
                // realizam as condutas declaradas ainda serao geradas, uma a uma.
                fechou = true;
                break;
            }

            const conduta = limpar(r.fragmento);
            const violacao = verificarConduta(contrato, estado, conduta);
            if (violacao) {
                descartados++;
                admissiveis = admissiveis.filter(c => c !== conduta);
                passos.push({
                    fase: 'sequencia', tentativa, proposto: conduta,
                    aceito: false, motivo: violacao.mensagem
                });
                if (admissiveis.length === 0) break;
                continue;
            }

            estado.sequencia.push(conduta);
            passos.push({ fase: 'sequencia', tentativa, proposto: conduta, aceito: true });
            aceitou = true;
        }

        if (fechou || !aceitou) break;
    }

    // --------------------------------------------------------------- ordens
    const condutasCumpridas: string[] = [];
    for (const conduta of [...estado.sequencia]) {
        const decisoes = decisoesDaConduta(contrato, conduta);
        let sub = restringirADecisoes(
            subgrafo,
            decisoes,
            contrato.unicidade ? estado.clausulas.map(c => c.item) : []
        );
        let aceitou = false;

        for (let tentativa = 1; tentativa <= maxTent && !aceitou; tentativa++) {
            if (sub.politicas.length === 0) {
                passos.push({
                    fase: 'clausula', tentativa, proposto: '', aceito: false,
                    motivo: `nenhum item disponivel realiza ${conduta} neste contexto`
                });
                break;
            }

            const r = await motor(
                { simbolo: papeis.clausula, prefixo: prefixo(true), subgrafo: sub },
                ctx
            );
            const texto = limpar(r.fragmento);
            const clausula = lerClausula(texto, papeis);

            if (!clausula) {
                descartados++;
                passos.push({
                    fase: 'clausula', tentativa, proposto: texto, aceito: false,
                    motivo: 'fragmento nao pode ser lido como clausula'
                });
                continue;
            }

            const violacoes = verificarClausulaNova(contrato, estado, clausula, conduta);
            if (violacoes.length > 0) {
                descartados++;
                // Repoda: o par que falhou sai da gramatica deste passo, entao a
                // tentativa seguinte nao consegue repetir o mesmo erro.
                sub = podarPorViolacoes(sub, violacoes);
                passos.push({
                    fase: 'clausula', tentativa, proposto: texto, aceito: false,
                    motivo: violacoes.map(v => v.mensagem).join(' | ')
                });
                continue;
            }

            estado.clausulas.push({ ...clausula, indice: estado.clausulas.length });
            clausulasTexto.push(texto);
            passos.push({ fase: 'clausula', tentativa, proposto: texto, aceito: true });
            aceitou = true;
        }

        if (aceitou) {
            condutasCumpridas.push(conduta);
        } else {
            // Conduta declarada que nenhuma clausula conseguiu cumprir sai da
            // sequencia: manter no cabecalho uma promessa que o corpo nao
            // realiza e exatamente a incoerencia que o contrato reprova.
            descartados++;
            passos.push({
                fase: 'sequencia', tentativa: maxTent, proposto: conduta, aceito: false,
                motivo: 'retirada da sequencia: nenhuma clausula valida a cumpriu'
            });
        }
    }
    estado.sequencia = condutasCumpridas;

    // -------------------------------------------------------------- alertas
    const maxAlertas = opts.maxAlertas ?? MAX_ALERTAS;
    for (let i = 0; i < maxAlertas; i++) {
        const r = await motor(
            { simbolo: 'alerta', prefixo: prefixo(true), subgrafo, encerramento: 'encerrar' },
            ctx
        );
        if (r.encerrou) break;
        const texto = limpar(r.fragmento);
        if (!texto.startsWith('alerta')) {
            passos.push({ fase: 'alerta', tentativa: 1, proposto: texto, aceito: false, motivo: 'fragmento nao e um alerta' });
            break;
        }
        alertas.push(texto);
        passos.push({ fase: 'alerta', tentativa: 1, proposto: texto, aceito: true });
    }

    return finalizar();

    // ------------------------------------------------------------- montagem
    function finalizar(): ResultadoIncremental {
        const auditoria =
            `artefato montado elemento a elemento sob verificacao no grafo: ` +
            `${estado.clausulas.length} clausula(s) aceitas, ${descartados} descartada(s)`;

        const artefato = montarArtefato(
            contrato,
            identificador,
            contextoArtefato!,
            estado,
            clausulasTexto,
            alertas,
            auditoria
        );

        const veredito = verificarContrato(contrato, artefato);
        return {
            resultado: artefato,
            valido: veredito.conforme,
            erro: veredito.conforme ? null : veredito.violacoes.map(v => v.mensagem).join(' | '),
            g_hat_utilizada: null,
            regras_em_g_hat: 0,
            tentativas: 1,
            violacoes: veredito.violacoes,
            historico: [],
            conforme: veredito.conforme,
            passos,
            descartados
        };
    }
}
