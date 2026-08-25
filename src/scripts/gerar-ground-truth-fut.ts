/**
 * Ground truth do domínio de arbitragem (fut) — gabarito de referência para 25
 * cenários distintos e curados, usado para validar automaticamente a saída da
 * arquitetura (o "resultado" que o LLM gera sob decodificação restrita) contra
 * a decisão de arbitragem corretamente derivada do modelo.
 *
 * Espelha src/scripts/gerar-ground-truth-med.ts no dominio da arbitragem, com
 * uma diferença deliberada de escala: o gabarito clínico classifica 500
 * cenários auto-gerados em 28 templates repetidos; aqui os 25 cenários são
 * TODOS distintos e escritos à mão — não há necessidade de um classificador
 * por texto, cada cenário já mapeia 1:1 para o seu próprio resolvedor.
 *
 * Mesma metodologia do gabarito clínico:
 *
 *   1. Reaproveita `retrieveFutConstraints` (src/knowledge/graphrag-fut.ts) —
 *      a MESMA função determinística que a arquitetura usa para decidir o que
 *      está bloqueado/vetado/recomendado/escalado a partir da leitura da
 *      partida. Nenhuma regra_seguranca é reimplementada aqui.
 *   2. Para regras estruturadas DECLARADAS no modelo mas que a recuperação em
 *      tempo real ainda não avalia automaticamente — `zona_penal` (a zona é
 *      categórica, não um `MatchParameter` numérico) e `limiar` quando citado
 *      apenas como reforço textual de uma regra_seguranca já avaliada — a
 *      decisão aplica o texto do futebol.fut diretamente, do mesmo jeito que
 *      um árbitro especialista aplicaria a regra escrita. Isso é citado
 *      explicitamente em `description` sempre que ocorre, para não confundir
 *      "avaliado pelo grafo" com "aplicado por conhecimento de domínio" — a
 *      mesma distinção que o gabarito clínico já faz (ex.: prioridade entre
 *      protocolos simultâneos em T1).
 *   3. Resolve a decisão final por `resolverDecisaoFut`: tenta a decisão
 *      pretendida; se `retrieveFutConstraints` já removeu essa decisão da
 *      política da infração (bloqueio por regra_seguranca ou veto total por
 *      lance/contexto), cai para o fallback consistente com a MESMA política
 *      computada (nunca inventa uma decisão fora do que `policy.decisoes`
 *      permite).
 *   4. Monta o texto `arbitragem` no formato gramatical do futebol.fut (mesma
 *      sintaxe do exemplar `Arbitragem_Referencia_Penalti`), e um campo extra
 *      `description` em prosa citando a regra exata (lance/regra_seguranca/
 *      contexto) que determinou o resultado.
 *
 * Campo OMITIDO de propósito: `regrasEmGHat` — mesma razão do gabarito clínico
 * (mede a poda no MOTOR, pós-foco-semântico; grandeza diferente do que este
 * gabarito usa, que são as restrições COMPLETAS).
 *
 * Uso:
 *   npx tsx src/scripts/gerar-ground-truth-fut.ts
 *
 * Gera:
 *   src/examples/fut/cenarios-25-fut.jsonl   (25 linhas, entrada para o lote)
 *   src/examples/fut/ground_truth_fut.jsonl  (25 linhas, gabarito)
 * A partir da MESMA lista de cenários — as duas saídas nunca podem divergir.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadFutModel } from '../database/neo4j-fut.js';
import { retrieveFutConstraints, type FutContext, type RetrievedFutConstraints } from '../knowledge/graphrag-fut.js';
import { montarPromptSemanticoFut } from '../inference/fut-client.js';
import type { RegistroGroundTruth } from '../inference/avaliar.js';

// -----------------------------------------------------------------------------
// Estruturas intermediárias — análogas a Ordem/Alerta/Resultado do gabarito
// clínico, mas no vocabulário da arbitragem (marcação em vez de ordem, sem o
// conceito de dose/via).
// -----------------------------------------------------------------------------

interface Marcacao {
    infracao: string;
    decisao: string;
    minuto: number;
    reinicio: string;
    justificativa: string;
    bloqueado: boolean;
}

interface AlertaFut {
    nivel: 'INFORMATIVO' | 'ATENCAO' | 'CRITICO' | 'BLOQUEANTE';
    texto: string;
    regra?: string;
}

interface ResultadoFut {
    lance?: string;
    marcacoes: Marcacao[];
    alertas: AlertaFut[];
    descricao: string;
}

/** Conduta nomeada do esquema_dados por decisão — TIRO_LIVRE_DIRETO,
 *  TIRO_LIVRE_INDIRETO, CONFIRMAR_GOL e PARALISAR_JOGO não têm conduta própria
 *  no futebol.fut (só o código de decisão existe nesses casos), então ficam de
 *  fora de `sequencia`: não inventamos uma conduta que o modelo não define. */
const CONDUTA_POR_DECISAO: Record<string, string> = {
    ADVERTENCIA_VERBAL: 'Emitir_Advertencia_Verbal',
    CARTAO_AMARELO: 'Aplicar_Cartao_Amarelo',
    CARTAO_VERMELHO: 'Aplicar_Cartao_Vermelho',
    EXPULSAR: 'Aplicar_Cartao_Vermelho',
    PENALTI: 'Marcar_Penalti',
    MANTER_JOGO: 'Manter_Jogo',
    ACIONAR_VAR: 'Acionar_Revisao_VAR',
    ANULAR_GOL: 'Anular_Gol',
    BLOQUEAR_DECISAO: 'Bloquear_Decisao_Insegura'
};

/**
 * Tenta a decisão pretendida para `infracao`; se `retrieveFutConstraints` já
 * removeu essa decisão da política (bloqueio de regra_seguranca ou veto total
 * por lance/contexto), cai para o fallback que a PRÓPRIA política ainda
 * permite — nunca inventa uma saída fora de `policy.decisoes`.
 */
function resolverDecisaoFut(
    constraints: RetrievedFutConstraints,
    infracao: string,
    desejada: string
): { decisao: string; bloqueado: boolean; motivo: string } {
    const policy = constraints.politicas.get(infracao);
    if (!policy) return { decisao: desejada, bloqueado: false, motivo: '' };
    if (policy.decisoes.includes(desejada)) return { decisao: desejada, bloqueado: false, motivo: '' };

    const vetoTotal = constraints.vetados.some(v => v.infracao === infracao);
    let fallback: string;
    if (vetoTotal) {
        fallback = policy.decisoes.includes('MANTER_JOGO')
            ? 'MANTER_JOGO'
            : policy.decisoes.includes('ACIONAR_VAR')
              ? 'ACIONAR_VAR'
              : 'BLOQUEAR_DECISAO';
    } else {
        fallback = policy.decisoes.includes('BLOQUEAR_DECISAO')
            ? 'BLOQUEAR_DECISAO'
            : policy.decisoes.includes('MANTER_JOGO')
              ? 'MANTER_JOGO'
              : 'ACIONAR_VAR';
    }
    return { decisao: fallback, bloqueado: true, motivo: policy.motivos.join('; ') };
}

function marcar(
    constraints: RetrievedFutConstraints,
    minuto: number,
    infracao: string,
    desejada: string,
    reinicioDesejado: string,
    justificativaBase: string
): Marcacao {
    const { decisao, bloqueado, motivo } = resolverDecisaoFut(constraints, infracao, desejada);
    return {
        infracao,
        decisao,
        minuto,
        reinicio: bloqueado ? 'SEM_PARALISACAO' : reinicioDesejado,
        justificativa: bloqueado ? motivo : justificativaBase,
        bloqueado
    };
}

function alertaBloqueio(m: Marcacao, regra: string): AlertaFut[] {
    return m.bloqueado ? [{ nivel: 'BLOQUEANTE', texto: `${m.infracao}: ${m.justificativa}`, regra }] : [];
}

function alertasEscalonamentoFut(constraints: RetrievedFutConstraints): AlertaFut[] {
    return constraints.escalonamentos.map(e => ({
        nivel: 'CRITICO',
        texto: `${e.destino}: ${e.detalhe}`,
        regra: `${e.lance}/escalonar`
    }));
}

// -----------------------------------------------------------------------------
// Leitura de partida "neutra" — nenhum GATILHO DE LANCE dispara com estes
// valores (logo nenhum veto indireto por lance incide à toa); cada cenário
// sobrescreve só os parâmetros que importam. Duas regra_seguranca partem
// ativas mesmo na base (cartoes_amarelos_jogador=0 bloqueia Reincidencia_Amarelo;
// jogadores_entre_bola_e_gol=3 bloqueia Impedimento) — isso é intencional e
// correto: são os valores "sem advertência prévia" e "posição legal", os
// mais comuns numa partida real. Cenários que testam essas duas infrações
// desbloqueadas sobrescrevem os respectivos parâmetros.
// -----------------------------------------------------------------------------

function baseTelemetria(overrides: Partial<Record<string, number>> = {}): Record<string, number> {
    return {
        minuto_partida: 50,
        acrescimo: 0,
        cartoes_amarelos_jogador: 0,
        distancia_ultimo_defensor: 1.0,
        velocidade_bola: 0,
        distancia_gol: 25,
        jogadores_entre_bola_e_gol: 3,
        tempo_revisao_var: 1,
        placar_diferenca: 0,
        faltas_acumuladas_time: 1,
        distancia_bola: 1.5,
        ...overrides
    };
}

// -----------------------------------------------------------------------------
// Os 25 cenários — cada um com o contexto de entrada e o resolvedor dedicado.
// -----------------------------------------------------------------------------

interface Cenario {
    partida: string;
    intencao: string;
    telemetria: Record<string, number>;
    contextos: string[];
    infracoesEmUso: string[];
    resolver: (constraints: RetrievedFutConstraints, contexto: FutContext) => ResultadoFut;
}

const CENARIOS: Cenario[] = [
    // 1 — Pênalti confirmado (Mão_Deliberada dentro da área, sem bloqueio de proximidade)
    {
        partida: 'FUT-GT-001',
        intencao: 'O zagueiro tocou na bola com a mão dentro da própria área, o assistente sinalizou. Confirma o pênalti?',
        telemetria: baseTelemetria({ distancia_gol: 8, distancia_bola: 1.5 }),
        contextos: [],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Mao_Deliberada', 'PENALTI', 'PENALTI', 'toque de mão dentro da própria área penal (Lei 12.1 — Handling the ball), zona_penal do futebol.fut converte a infração em pênalti');
            return {
                lance: 'Penalti_Na_Area',
                marcacoes: [m],
                alertas: [...alertaBloqueio(m, 'regra_seguranca/Mao_Deliberada'), ...alertasEscalonamentoFut(c)],
                descricao:
                    `A leitura ativa o lance Penalti_Na_Area (distância do gol <= 16.5 m) e a infração Mao_Deliberada ` +
                    `não está bloqueada (distância da bola 1.5 m, acima do limiar de 1.0 m que caracterizaria contato ` +
                    `natural). A conversão para PENALTI não vem de um parâmetro numérico avaliado pelo grafo — vem da ` +
                    `declaração \`zona_penal: AREA_PROPRIA -> PENALTI\` de Mao_Deliberada no futebol.fut, aplicada aqui ` +
                    `por conhecimento de domínio (a zona do campo é categórica, não um MatchParameter numérico que a ` +
                    `recuperação em tempo real avalie sozinha). Decisão: ${m.decisao}.`
            };
        }
    },

    // 2 — Toque a queima-roupa dentro da área: bloqueado pela regra_seguranca de proximidade
    {
        partida: 'FUT-GT-002',
        intencao: 'A bola bateu na mão do zagueiro a queima-roupa dentro da área, marca o pênalti?',
        telemetria: baseTelemetria({ distancia_gol: 10, distancia_bola: 0.4 }),
        contextos: [],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Mao_Deliberada', 'PENALTI', 'PENALTI', '');
            return {
                lance: 'Penalti_Na_Area',
                marcacoes: [m],
                alertas: alertaBloqueio(m, 'regra_seguranca/Mao_Deliberada'),
                descricao:
                    `regra_seguranca bloqueia Mao_Deliberada quando distancia_bola < 1.0 m (aqui 0.4 m) — contato a ` +
                    `curtíssima distância caracteriza reação natural do corpo, não infração deliberada. O incremento ` +
                    `(PENALTI) fica inexprimível pela gramática podada; a decisão correta é ${m.decisao}, mantendo o ` +
                    `jogo em andamento.`
            };
        }
    },

    // 3 — Segunda amarela válida (já havia advertência prévia registrada)
    {
        partida: 'FUT-GT-003',
        intencao: 'O lateral já tinha cartão amarelo e cometeu outra falta dura agora, dá a segunda amarela?',
        telemetria: baseTelemetria({ cartoes_amarelos_jogador: 1 }),
        contextos: [],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Reincidencia_Amarelo', 'CARTAO_VERMELHO', 'TIRO_LIVRE_INDIRETO', 'segunda advertência amarela registrada na partida: expulsão automática pela Lei 12.3 (Second caution)');
            return {
                marcacoes: [m],
                alertas: alertaBloqueio(m, 'regra_seguranca/Reincidencia_Amarelo'),
                descricao:
                    `regra_seguranca só bloqueia Reincidencia_Amarelo quando cartoes_amarelos_jogador < 1 (sem ` +
                    `advertência prévia). Aqui o jogador já tem 1 cartão registrado, então a condição de bloqueio não ` +
                    `se aplica: a segunda amarela é válida e converte automaticamente em ${m.decisao}, exatamente a ` +
                    `\`sancao ... reincidencia CARTAO_VERMELHO\` declarada no futebol.fut.`
            };
        }
    },

    // 4 — "Segunda amarela" sem primeira registrada: bloqueada
    {
        partida: 'FUT-GT-004',
        intencao: 'Ele fez uma falta feia agora, já dá pra falar que é a segunda amarela?',
        telemetria: baseTelemetria({ cartoes_amarelos_jogador: 0 }),
        contextos: [],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Reincidencia_Amarelo', 'CARTAO_VERMELHO', 'TIRO_LIVRE_INDIRETO', '');
            return {
                marcacoes: [m],
                alertas: alertaBloqueio(m, 'regra_seguranca/Reincidencia_Amarelo'),
                descricao:
                    `regra_seguranca bloqueia Reincidencia_Amarelo quando cartoes_amarelos_jogador < 1 (aqui 0) — não ` +
                    `há advertência prévia registrada nesta partida para configurar reincidência. Decisão: ${m.decisao}. ` +
                    `A conduta correta para a falta em si, isoladamente, seria uma primeira advertência comum ` +
                    `(Aplicar_Cartao_Amarelo via infracao Carga_Imprudente ou Entrada_Violenta, conforme a intensidade ` +
                    `do lance) — não a citação de Reincidencia_Amarelo, que pressupõe um cartão anterior inexistente aqui.`
            };
        }
    },

    // 5 — Impedimento anula o gol
    {
        partida: 'FUT-GT-005',
        intencao: 'O atacante recebeu o passe mas parecia adiantado antes da bola sair do companheiro, anula o gol?',
        telemetria: baseTelemetria({ distancia_ultimo_defensor: -0.5, jogadores_entre_bola_e_gol: 1 }),
        contextos: [],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Impedimento', 'ANULAR_GOL', 'TIRO_LIVRE_INDIRETO', 'linha de impedimento semiautomática confirma posição adiantada do atacante no momento do passe (Lei 11 — Offside)');
            return {
                lance: 'Impedimento_Ataque',
                marcacoes: [m],
                alertas: alertasEscalonamentoFut(c),
                descricao:
                    `O lance ativa Impedimento_Ataque (distancia_ultimo_defensor < 0, atacante à frente do penúltimo ` +
                    `defensor) e Impedimento não está bloqueado (jogadores_entre_bola_e_gol = 1, abaixo do limiar de 2 ` +
                    `que caracterizaria posição legal). Decisão: ${m.decisao}.`
            };
        }
    },

    // 6 — Posição legal (dois ou mais adversários entre atacante e linha de fundo): gol mantido
    {
        partida: 'FUT-GT-006',
        intencao: 'Pareceu impedimento mas tinha bastante gente na linha, confirma o gol?',
        telemetria: baseTelemetria({ distancia_ultimo_defensor: 0.8, jogadores_entre_bola_e_gol: 3 }),
        contextos: [],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Impedimento', 'CONFIRMAR_GOL', 'SEM_PARALISACAO', '');
            return {
                marcacoes: [m],
                alertas: alertaBloqueio(m, 'regra_seguranca/Impedimento'),
                descricao:
                    `regra_seguranca bloqueia Impedimento quando jogadores_entre_bola_e_gol >= 2 (aqui 3) — há ao menos ` +
                    `dois adversários mais próximos da linha de fundo, posição legal. Além disso o próprio gatilho de ` +
                    `Impedimento_Ataque (jogadores_entre_bola_e_gol < 2) não dispara com esse valor: o lance nem fica ` +
                    `ativo. Decisão: ${m.decisao} — o gol é válido.`
            };
        }
    },

    // 7 — Entrada violenta longe da disputa: vermelho direto
    {
        partida: 'FUT-GT-007',
        intencao: 'O volante chegou de sola muito longe da disputa da bola e pegou o tornozelo do adversário, expulsa?',
        telemetria: baseTelemetria({ distancia_bola: 3.5 }),
        contextos: [],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Entrada_Violenta', 'CARTAO_VERMELHO', 'TIRO_LIVRE_DIRETO', 'contato ocorre a 3.5 m da disputa da bola, muito acima do raio normal — jogo violento (Lei 12.3 — Serious foul play)');
            return {
                lance: 'Conduta_Violenta_Jogo',
                marcacoes: [m],
                alertas: alertasEscalonamentoFut(c),
                descricao:
                    `O lance ativa Conduta_Violenta_Jogo (distancia_bola > 2 m) e Entrada_Violenta não está bloqueada ` +
                    `(distancia_bola 3.5 m, acima do limiar de 1.0 m que protegeria a disputa normal). O próprio limiar ` +
                    `declarado na infração ("distancia_bola > 2.0 m -> CARTAO_VERMELHO") reforça a mesma conclusão. ` +
                    `Decisão: ${m.decisao}.`
            };
        }
    },

    // 8 — Entrada dura dentro do raio normal de disputa: bloqueada
    {
        partida: 'FUT-GT-008',
        intencao: 'Foi uma entrada dura mas dentro da disputa normal pela bola, dá pra expulsar mesmo assim?',
        telemetria: baseTelemetria({ distancia_bola: 0.8 }),
        contextos: [],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Entrada_Violenta', 'CARTAO_VERMELHO', 'TIRO_LIVRE_DIRETO', '');
            return {
                marcacoes: [m],
                alertas: alertaBloqueio(m, 'regra_seguranca/Entrada_Violenta'),
                descricao:
                    `regra_seguranca bloqueia Entrada_Violenta quando distancia_bola <= 1.0 m (aqui 0.8 m) — o contato ` +
                    `ocorre dentro do raio normal de disputa pela bola. Decisão: ${m.decisao}. A citação correta para o ` +
                    `lance em si seria Carga_Imprudente (falta pessoal comum, no máximo advertência), não jogo violento.`
            };
        }
    },

    // 9 — DOGSO do goleiro dentro da área: pênalti + expulsão
    {
        partida: 'FUT-GT-009',
        intencao: 'O goleiro saiu errado e derrubou o atacante sozinho na cara do gol, dentro da área. Expulsa e marca o pênalti?',
        telemetria: baseTelemetria({ distancia_gol: 6 }),
        contextos: [],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const min = ctx.telemetria.minuto_partida;
            const mPenalti = marcar(c, min, 'Contato_Goleiro_Area', 'PENALTI', 'PENALTI', 'infração do goleiro dentro da própria área penal, negando chance clara e óbvia de gol (DOGSO — Lei 12.3)');
            const mCartao = marcar(c, min, 'Contato_Goleiro_Area', 'CARTAO_VERMELHO', 'SEM_PARALISACAO', 'DOGSO confirmado: goleiro é o único defensor entre o atacante e o gol, distância 6 m do gol');
            return {
                lance: 'Penalti_Na_Area',
                marcacoes: [mPenalti, mCartao],
                alertas: [...alertaBloqueio(mPenalti, 'regra_seguranca/Contato_Goleiro_Area'), ...alertaBloqueio(mCartao, 'regra_seguranca/Contato_Goleiro_Area'), ...alertasEscalonamentoFut(c)],
                descricao:
                    `O lance ativa Penalti_Na_Area (distância do gol <= 16.5 m) e Contato_Goleiro_Area não está ` +
                    `bloqueada (distância do gol 6 m, abaixo do limiar de 40 m que descaracterizaria oportunidade clara ` +
                    `e óbvia). A conversão em pênalti vem da declaração \`zona_penal: AREA_PROPRIA -> PENALTI\` ` +
                    `(aplicada por conhecimento de domínio, como em FUT-GT-001), e a sanção base de Contato_Goleiro_Area ` +
                    `já é CARTAO_VERMELHO. Duas marcações resultam: ${mPenalti.decisao} (reinício) e ${mCartao.decisao} ` +
                    `(disciplina).`
            };
        }
    },

    // 10 — Falta do goleiro longe do gol: DOGSO automático bloqueado
    {
        partida: 'FUT-GT-010',
        intencao: 'O goleiro empurrou o atacante só que foi lá pela intermediária, ainda é vermelho automático?',
        telemetria: baseTelemetria({ distancia_gol: 55 }),
        contextos: [],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Contato_Goleiro_Area', 'CARTAO_VERMELHO', 'TIRO_LIVRE_DIRETO', '');
            return {
                marcacoes: [m],
                alertas: alertaBloqueio(m, 'regra_seguranca/Contato_Goleiro_Area'),
                descricao:
                    `regra_seguranca bloqueia Contato_Goleiro_Area quando distancia_gol > 40 m (aqui 55 m) — a distância ` +
                    `da meta não caracteriza oportunidade clara e óbvia de gol (não é DOGSO). Decisão: ${m.decisao}. A ` +
                    `infração em si permanece citável como falta pessoal comum (Carga_Imprudente), não como negação de ` +
                    `chance clara de gol.`
            };
        }
    },

    // 11 — Cusparada: vermelho sempre, sem isenção possível
    {
        partida: 'FUT-GT-011',
        intencao: 'O atacante cuspiu no zagueiro depois do lance, dá pra confirmar a expulsão pelas imagens?',
        telemetria: baseTelemetria(),
        contextos: [],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Cusparada', 'CARTAO_VERMELHO', 'TIRO_LIVRE_DIRETO', 'cuspe confirmado por revisão de imagem — conduta sempre sancionável quando confirmada (Lei 12.3 — Spitting), sem isenção possível');
            return {
                marcacoes: [m],
                alertas: alertaBloqueio(m, 'regra_seguranca/Cusparada'),
                descricao:
                    `Cusparada não tem regra_seguranca associada — nenhum parâmetro de leitura da partida bloqueia essa ` +
                    `sanção. A isenção declarada no futebol.fut é textual ("nenhuma — sempre sancionável quando ` +
                    `confirmada", exceção apenas para impossibilidade de identificar o autor) e não se aplica aqui, pois ` +
                    `a autoria foi confirmada pelas imagens. Decisão: ${m.decisao}.`
            };
        }
    },

    // 12 — Simulação sem contato algum (isenção não se aplica: exceção confirmada)
    {
        partida: 'FUT-GT-012',
        intencao: 'O atacante caiu sozinho dentro da área sem contato nenhum, é simulação?',
        telemetria: baseTelemetria({ distancia_gol: 12 }),
        contextos: [],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Simulacao', 'CARTAO_AMARELO', 'TIRO_LIVRE_INDIRETO', 'ausência total de contato comprovada — exceção à isenção de simulação do futebol.fut, conduta antidesportiva (Lei 12.3)');
            return {
                lance: 'Penalti_Na_Area',
                marcacoes: [m],
                alertas: [],
                descricao:
                    `A isenção de Simulacao no futebol.fut protege quedas com contato real, mesmo exagerado; a exceção ` +
                    `(que a torna simulação de fato) é "ausência total de contato comprovada pela revisão do VAR" — ` +
                    `exatamente o caso aqui ("sem contato nenhum"). Nenhuma regra_seguranca restringe Simulacao. ` +
                    `Decisão: ${m.decisao}.`
            };
        }
    },

    // 13 — Dissenso simples, abaixo do limiar de escalonamento
    {
        partida: 'FUT-GT-013',
        intencao: 'O meio-campista reclamou muito da marcação mas sem ofender ninguém, dá cartão?',
        telemetria: baseTelemetria({ faltas_acumuladas_time: 2 }),
        contextos: [],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Dissenso', 'CARTAO_AMARELO', 'TIRO_LIVRE_INDIRETO', 'reclamação da marcação sem linguagem ofensiva — conduta antidesportiva (Lei 12.3 — Dissent), sanção base');
            return {
                marcacoes: [m],
                alertas: [],
                descricao:
                    `faltas_acumuladas_time = 2, abaixo do limiar de 5 declarado em Dissenso para escalar a ` +
                    `CARTAO_VERMELHO — permanece a sanção base. Decisão: ${m.decisao}.`
            };
        }
    },

    // 14 — Dissenso coletivo, acima do limiar: escala a vermelho
    {
        partida: 'FUT-GT-014',
        intencao: 'O time inteiro cercou o árbitro gritando depois da marcação, isso já passa de amarelo?',
        telemetria: baseTelemetria({ faltas_acumuladas_time: 6 }),
        contextos: [],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Dissenso', 'CARTAO_VERMELHO', 'TIRO_LIVRE_INDIRETO', 'faltas_acumuladas_time = 6, acima do limiar de 5 declarado em Dissenso: linguagem ofensiva/insultuosa coletiva dirigida à arbitragem');
            return {
                marcacoes: [m],
                alertas: [],
                descricao:
                    `O limiar declarado em Dissenso ("faltas_acumuladas_time >= 5 -> CARTAO_VERMELHO") é avaliado aqui ` +
                    `por conhecimento de domínio — retrieveFutConstraints não avalia limiares de infração em tempo ` +
                    `real (só regra_seguranca de nível superior), mas o próprio futebol.fut declara esse limiar ` +
                    `explicitamente para Dissenso. Com faltas_acumuladas_time = 6, a condição é atingida. Decisão: ` +
                    `${m.decisao}, e não a sanção base de CARTAO_AMARELO.`
            };
        }
    },

    // 15 — Perda de tempo legítima (fora dos acréscimos)
    {
        partida: 'FUT-GT-015',
        intencao: 'O goleiro ficou repondo a bola devagar demais perto do fim do jogo, dá amarelo por perda de tempo?',
        telemetria: baseTelemetria({ minuto_partida: 88, acrescimo: 0 }),
        contextos: [],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Perda_Tempo', 'CARTAO_AMARELO', 'TIRO_LIVRE_INDIRETO', 'atraso deliberado na reposição de bola perto do fim do jogo, ainda fora do acréscimo (Lei 12.3 — Delaying the restart of play)');
            return {
                marcacoes: [m],
                alertas: [],
                descricao:
                    `regra_seguranca só bloqueia Perda_Tempo quando acrescimo > 0 min; aqui acrescimo = 0 (ainda no ` +
                    `tempo regulamentar), a condição de bloqueio não se aplica. Decisão: ${m.decisao}.`
            };
        }
    },

    // 16 — Perda de tempo já nos acréscimos: bloqueada (tempo já compensado) + reforço do contexto
    {
        partida: 'FUT-GT-016',
        intencao: 'Já estamos nos acréscimos e o lateral ainda demora pra cobrar o escanteio, marca por perda de tempo?',
        telemetria: baseTelemetria({ minuto_partida: 93, acrescimo: 3 }),
        contextos: ['Acrescimos'],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Perda_Tempo', 'CARTAO_AMARELO', 'TIRO_LIVRE_INDIRETO', '');
            return {
                marcacoes: [m],
                alertas: alertaBloqueio(m, 'regra_seguranca/Perda_Tempo'),
                descricao:
                    `Duas restrições reforçam a mesma conclusão: (1) regra_seguranca bloqueia Perda_Tempo quando ` +
                    `acrescimo > 0 min (aqui 3 min) — o tempo perdido já está compensado pelo acréscimo em andamento; ` +
                    `(2) o contexto Acrescimos proíbe Perda_Tempo explicitamente ("critério de perda de tempo já ` +
                    `embutido no cálculo do acréscimo pelo quarto árbitro"). Decisão: ${m.decisao}.`
            };
        }
    },

    // 17 — Falta simples, sem cartão
    {
        partida: 'FUT-GT-017',
        intencao: 'Foi só uma disputa normal de bola no meio-campo, mas o lance foi duro. É só falta mesmo?',
        telemetria: baseTelemetria(),
        contextos: [],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Carga_Imprudente', 'TIRO_LIVRE_DIRETO', 'TIRO_LIVRE_DIRETO', 'disputa normal de bola com contato mínimo, sem risco ao adversário (Lei 12.1 — Careless charging), sanção NENHUM');
            return {
                marcacoes: [m],
                alertas: [],
                descricao:
                    `Carga_Imprudente tem sanção base NENHUM (sem cartão) e nenhuma regra_seguranca a restringe. ` +
                    `Decisão: ${m.decisao} — apenas o reinício de jogo, sem disciplina.`
            };
        }
    },

    // 18 — Carga imprudente dentro da própria área: converte em pênalti (zona_penal, conhecimento de domínio)
    {
        partida: 'FUT-GT-018',
        intencao: 'A carga foi imprudente mas aconteceu dentro da própria área, ainda é só tiro livre?',
        telemetria: baseTelemetria({ distancia_gol: 9 }),
        contextos: [],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Carga_Imprudente', 'PENALTI', 'PENALTI', 'carga imprudente cometida dentro da própria área penal — zona_penal do futebol.fut converte o reinício em pênalti');
            return {
                lance: 'Penalti_Na_Area',
                marcacoes: [m],
                alertas: [],
                descricao:
                    `Não é só tiro livre: a declaração \`zona_penal: AREA_PROPRIA -> PENALTI\` de Carga_Imprudente no ` +
                    `futebol.fut converte a mesma infração em pênalti quando ocorre dentro da própria área — aplicada ` +
                    `aqui por conhecimento de domínio (zona é categórica, fora do que retrieveFutConstraints avalia ` +
                    `automaticamente). Decisão: ${m.decisao}, sem disciplina adicional (a sanção base de Carga_Imprudente ` +
                    `continua NENHUM).`
            };
        }
    },

    // 19 — Regra da vantagem aplicada
    {
        partida: 'FUT-GT-019',
        intencao: 'Teve contato mas o time prejudicado ficou com a bola e foi pro ataque, para o jogo?',
        telemetria: baseTelemetria({ velocidade_bola: 15 }),
        contextos: [],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Carga_Imprudente', 'MANTER_JOGO', 'SEM_PARALISACAO', 'time prejudicado manteve controle e progressão da jogada — regra da vantagem (regra_global, IFAB Law 5)');
            return {
                lance: 'Disputa_Bola_Dividida',
                marcacoes: [m],
                alertas: [],
                descricao:
                    `O lance ativa Disputa_Bola_Dividida (velocidade_bola > 0, bola em jogo no momento do contato). A ` +
                    `regra_global "a regra da vantagem prevalece quando o time prejudicado mantém controle e ` +
                    `progressão da jogada" (IFAB Law 5) determina que o jogo NÃO deve ser paralisado. Decisão: ` +
                    `${m.decisao}, não TIRO_LIVRE_DIRETO.`
            };
        }
    },

    // 20 — Dissenso repetido nos acréscimos: contexto eleva a gravidade e muda o desfecho
    {
        partida: 'FUT-GT-020',
        intencao: 'Já nos acréscimos, o capitão reclamou bastante de novo da marcação. Ainda é só amarelo?',
        telemetria: baseTelemetria({ minuto_partida: 92, acrescimo: 2, faltas_acumuladas_time: 3 }),
        contextos: ['Acrescimos'],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Dissenso', 'CARTAO_VERMELHO', 'TIRO_LIVRE_INDIRETO', 'reclamação repetida do capitão nos acréscimos — contexto Acrescimos ajusta a gravidade de Dissenso em fator 1.5 (tolerância reduzida no encerramento do jogo), configurando reincidência de conduta antidesportiva');
            return {
                marcacoes: [m],
                alertas: [],
                descricao:
                    `faltas_acumuladas_time = 3 sozinho não atingiria o limiar de 5 de Dissenso, mas o contexto ` +
                    `Acrescimos ajusta Dissenso por fator 1.5 ("maior tensão no encerramento do jogo exige tolerância ` +
                    `reduzida a reclamações") — e a reclamação é explicitamente repetida ("de novo"). Combinando o ` +
                    `ajuste contextual com a reincidência da mesma conduta na mesma parada, a sanção correta escala de ` +
                    `CARTAO_AMARELO para ${m.decisao}, não permanece "só amarelo".`
            };
        }
    },

    // 21 — Disputa de pênaltis: impedimento não se aplica
    {
        partida: 'FUT-GT-021',
        intencao: 'Já estamos nos pênaltis, o goleiro saiu da linha antes da cobrança, é impedimento dele?',
        telemetria: baseTelemetria(),
        contextos: ['Disputa_Penaltis'],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Impedimento', 'MANTER_JOGO', 'SEM_PARALISACAO', '');
            return {
                marcacoes: [m],
                alertas: alertaBloqueio(m, 'contexto/Disputa_Penaltis'),
                descricao:
                    `O contexto Disputa_Penaltis proíbe Impedimento explicitamente ("regra de impedimento não se ` +
                    `aplica durante a disputa de pênaltis") — a citação fica vetada. Decisão: ${m.decisao}. O avanço ` +
                    `do goleiro na linha antes da cobrança é uma infração de disputa de pênaltis (encroachment), que ` +
                    `não está modelada como \`infracao\` própria no futebol.fut — fora do universo fechado deste ` +
                    `esquema_dados, a conduta correta é não inventar uma citação sem lastro no modelo.`
            };
        }
    },

    // 22 — Competição sem VAR: DOGSO automático não pode ser confirmado só pela leitura
    {
        partida: 'FUT-GT-022',
        intencao: 'Sem VAR nessa competição, o goleiro parece ter derrubado o atacante sozinho na área. Dá pra confirmar sem rever?',
        telemetria: baseTelemetria({ distancia_gol: 7 }),
        contextos: ['Competicao_Sem_VAR'],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Contato_Goleiro_Area', 'CARTAO_VERMELHO', 'SEM_PARALISACAO', '');
            return {
                marcacoes: [m],
                alertas: alertaBloqueio(m, 'contexto/Competicao_Sem_VAR'),
                descricao:
                    `O contexto Competicao_Sem_VAR proíbe Contato_Goleiro_Area explicitamente ("confirmação de DOGSO ` +
                    `sem VAR depende exclusivamente da visão de campo do árbitro") — a citação automática fica vetada, ` +
                    `mesmo com a leitura de distância favorável (7 m, dentro do limiar de 40 m). Decisão: ${m.decisao}. ` +
                    `A confirmação depende do julgamento visual direto do árbitro principal, fora do que este ` +
                    `esquema_dados decide automaticamente.`
            };
        }
    },

    // 23 — Categoria de base: entrada dura sem risco grave não é expulsão automática
    {
        partida: 'FUT-GT-023',
        intencao: 'Numa categoria de base, o zagueiro entrou forte mas sem risco grave, já expulsa direto?',
        telemetria: baseTelemetria({ distancia_bola: 2.5 }),
        contextos: ['Categoria_Base'],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Entrada_Violenta', 'CARTAO_VERMELHO', 'TIRO_LIVRE_DIRETO', '');
            return {
                marcacoes: [m],
                alertas: alertaBloqueio(m, 'contexto/Categoria_Base'),
                descricao:
                    `Sem o contexto, distancia_bola = 2.5 m (acima de 2.0) tornaria Entrada_Violenta um vermelho direto. ` +
                    `Mas o contexto Categoria_Base proíbe Entrada_Violenta explicitamente ("protocolo de categoria de ` +
                    `base prioriza cartão amarelo educativo antes da expulsão, salvo risco grave") — e o próprio ` +
                    `enunciado descarta risco grave. Decisão: ${m.decisao}. A citação correta é Carga_Imprudente com ` +
                    `CARTAO_AMARELO educativo, não expulsão direta.`
            };
        }
    },

    // 24 — Agravante: contato violento do goleiro soma-se ao DOGSO
    {
        partida: 'FUT-GT-024',
        intencao: 'O goleiro usou força excessiva ao derrubar o atacante sozinho na área, isso agrava para expulsão mesmo sem o pênalti sozinho já justificar?',
        telemetria: baseTelemetria({ distancia_gol: 8 }),
        contextos: [],
        infracoesEmUso: ['Entrada_Violenta'],
        resolver: (c, ctx) => {
            const min = ctx.telemetria.minuto_partida;
            const mPenalti = marcar(c, min, 'Contato_Goleiro_Area', 'PENALTI', 'PENALTI', 'infração do goleiro dentro da área — zona_penal converte em pênalti');
            const mCartao = marcar(c, min, 'Contato_Goleiro_Area', 'CARTAO_VERMELHO', 'SEM_PARALISACAO', 'agravante confirmado: contato de goleiro com uso excessivo de força soma-se à negação da chance clara de gol — confirmar via VAR antes de expulsar');
            const agravanteAlerta: AlertaFut[] = c.agravantes.length > 0
                ? c.agravantes.map(a => ({ nivel: 'ATENCAO' as const, texto: `${a.entre} [${a.gravidade}]: ${a.mecanismo}. ${a.conduta}`, regra: 'agravante/Contato_Goleiro_Area' }))
                : [];
            return {
                lance: 'Penalti_Na_Area',
                marcacoes: [mPenalti, mCartao],
                alertas: [...agravanteAlerta, ...alertaBloqueio(mPenalti, 'regra_seguranca/Contato_Goleiro_Area'), ...alertaBloqueio(mCartao, 'regra_seguranca/Contato_Goleiro_Area')],
                descricao:
                    `Contato_Goleiro_Area já é vermelho por sanção base (DOGSO), então a pergunta ("agrava mesmo sem o ` +
                    `pênalti sozinho já justificar") parte de uma premissa equivocada: o próprio DOGSO, com ` +
                    `distancia_gol = 8 m (não bloqueado), já basta para ${mCartao.decisao}. O agravante declarado ` +
                    `("Contato_Goleiro_Area + Entrada_Violenta", só considerado porque Entrada_Violenta consta em ` +
                    `infracoesEmUso) reforça a gravidade e exige confirmação via VAR antes de confirmar a expulsão, ` +
                    `mas não é ele quem cria a base para o cartão. Decisões: ${mPenalti.decisao} (reinício) e ` +
                    `${mCartao.decisao} (disciplina).`
            };
        }
    },

    // 25 — Revisão do VAR além do prazo protocolar: aciona confirmação formal
    {
        partida: 'FUT-GT-025',
        intencao: 'A revisão do lance já passou de cinco minutos, o árbitro precisa ir ao monitor confirmar?',
        telemetria: baseTelemetria({ distancia_gol: 11, tempo_revisao_var: 7 }),
        contextos: [],
        infracoesEmUso: [],
        resolver: (c, ctx) => {
            const m = marcar(c, ctx.telemetria.minuto_partida, 'Mao_Deliberada', 'ACIONAR_VAR', 'SEM_PARALISACAO', 'revisão do VAR ultrapassou o prazo protocolar de 5 minutos — exige confirmação formal do árbitro no monitor de campo (OFR)');
            return {
                lance: 'Penalti_Na_Area',
                marcacoes: [m],
                alertas: alertasEscalonamentoFut(c),
                descricao:
                    `O lance ativa Penalti_Na_Area por dois gatilhos simultâneos: distância do gol <= 16.5 m e ` +
                    `tempo_revisao_var > 5 min (aqui 7 min). O segundo gatilho também dispara o escalonamento para VAR ` +
                    `("revisão além do prazo protocolar exige confirmação formal do VAR") e a regra_global ("toda ` +
                    `revisão do VAR deve ser concluída em até 5 minutos, exceto verificação de identidade de ` +
                    `jogador"). Decisão: ${m.decisao} — o árbitro precisa ir ao monitor de campo antes de confirmar ` +
                    `qualquer sanção sobre a infração revisada.`
            };
        }
    }
];

// -----------------------------------------------------------------------------
// Montagem do texto `arbitragem` no formato gramatical do futebol.fut (mesma
// sintaxe do exemplar Arbitragem_Referencia_Penalti).
// -----------------------------------------------------------------------------

/** Justificativas às vezes citam trechos entre aspas duplas do próprio
 *  futebol.fut — como cada citação vira o conteúdo de um literal `"..."` na
 *  gramática, uma aspa dupla embutida fecharia a string cedo demais.
 *  Substituímos por aspas simples só no texto embutido na sintaxe da DSL; o
 *  campo `description` (JSON puro) não passa por aqui. */
function paraDsl(texto: string): string {
    return texto.replace(/"/g, "'");
}

function montarArbitragem(linha: number, contexto: FutContext, resultado: ResultadoFut): string {
    const nome = `Arbitragem_L${linha}`;
    const paraTexto = resultado.lance ? ` para ${resultado.lance}` : '';
    const condutas = [...new Set(resultado.marcacoes.map(m => CONDUTA_POR_DECISAO[m.decisao]).filter((c): c is string => Boolean(c)))];

    const linhas: string[] = [];
    linhas.push(`arbitragem ${nome}${paraTexto} {`);
    linhas.push(`    esquema_referencia AssistenteArbitragem_v1`);
    linhas.push(`    partida "${paraDsl(contexto.partida ?? '')}"`);
    if (condutas.length > 0) linhas.push(`    sequencia [ ${condutas.join(' , ')} ]`);
    for (const m of resultado.marcacoes) {
        linhas.push(`    marcacao ${m.infracao} decisao ${m.decisao} minuto ${m.minuto.toFixed(1)} min reinicio ${m.reinicio} justificativa "${paraDsl(m.justificativa)}"`);
    }
    for (const a of resultado.alertas) {
        linhas.push(`    alerta ${a.nivel} "${paraDsl(a.texto)}"${a.regra ? ` regra "${paraDsl(a.regra)}"` : ''}`);
    }
    linhas.push(`    auditoria "arbitragem derivada deterministicamente das regras do futebol.fut (ground truth)"`);
    linhas.push(`}`);
    return linhas.join('\n');
}

async function main(): Promise<void> {
    const modelPath = path.join('src', 'examples', 'fut', 'futebol.fut');
    const cenariosOutPath = path.join('src', 'examples', 'fut', 'cenarios-25-fut.jsonl');
    const groundTruthOutPath = path.join('src', 'examples', 'fut', 'ground_truth_fut.jsonl');

    console.log(`Carregando modelo de arbitragem (${modelPath})...`);
    const model = await loadFutModel(modelPath);

    const cenariosLinhas: string[] = [];
    const registros: RegistroGroundTruth[] = [];
    const contagemPorDecisao = new Map<string, number>();

    for (const [i, cenario] of CENARIOS.entries()) {
        const linha = i + 1;
        const contexto: FutContext = {
            partida: cenario.partida,
            telemetria: cenario.telemetria,
            contextos: cenario.contextos,
            infracoesEmUso: cenario.infracoesEmUso,
            intencao: cenario.intencao
        };

        cenariosLinhas.push(
            JSON.stringify({
                intencao: cenario.intencao,
                partida: cenario.partida,
                telemetria: cenario.telemetria,
                contextos: cenario.contextos,
                infracoesEmUso: cenario.infracoesEmUso
            })
        );

        const constraints = retrieveFutConstraints(model, contexto);
        const resultado = cenario.resolver(constraints, contexto);

        for (const m of resultado.marcacoes) contagemPorDecisao.set(m.decisao, (contagemPorDecisao.get(m.decisao) ?? 0) + 1);

        const infracoesFoco = new Set<string>([
            ...resultado.marcacoes.map(m => m.infracao).filter(Boolean),
            ...constraints.bloqueios.map(b => b.infracao),
            ...constraints.vetados.map(v => v.infracao)
        ]);

        registros.push({
            linha,
            intencao: cenario.intencao,
            aceito: true,
            valido: true,
            erroMotor: null,
            telemetria: {
                partida: cenario.partida,
                telemetria: cenario.telemetria,
                contextos: cenario.contextos,
                infracoesEmUso: cenario.infracoesEmUso
            },
            foco: {
                farmacos: [...infracoesFoco],
                protocolos: constraints.lancesAtivos.map(l => l.nome)
            },
            promptSemantico: montarPromptSemanticoFut(constraints),
            plano: montarArbitragem(linha, contexto, resultado),
            description: resultado.descricao,
            ordensEsperadas: resultado.marcacoes.map(m => ({ farmaco: m.infracao, decisao: m.decisao })),
            seguranca: {
                bloqueados: constraints.bloqueios.map(b => b.infracao),
                vetados: constraints.vetados.map(v => v.infracao)
            }
        });
    }

    fs.writeFileSync(cenariosOutPath, cenariosLinhas.join('\n') + '\n', 'utf-8');
    fs.writeFileSync(groundTruthOutPath, registros.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

    console.log(`\n${cenariosLinhas.length} cenários escritos em ${cenariosOutPath}`);
    console.log(`${registros.length} registros de gabarito escritos em ${groundTruthOutPath}\n`);
    console.log('Distribuição por decisão final:');
    for (const [nome, n] of [...contagemPorDecisao.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${n.toString().padStart(3)}  ${nome}`);
    }
}

main().catch(err => {
    console.error('Falha ao gerar ground truth de arbitragem:', err.message ?? err);
    process.exit(1);
});
