/**
 * Ground truth do domínio clínico (med) — gabarito de referência para os 500
 * cenários de `src/examples/med/cenarios-500.jsonl`, usado para validar
 * automaticamente a saída da arquitetura (o "resultado" que o LLM gera sob
 * decodificação restrita) contra a decisão clinicamente correta.
 *
 * NÃO é um LLM re-respondendo os cenários — isso reproduziria exatamente o
 * componente que está sendo avaliado. Em vez disso, este script:
 *
 *   1. Reaproveita `retrieveConstraints` (src/knowledge/graphrag.ts) — a MESMA
 *      função determinística que a arquitetura usa para decidir o que está
 *      bloqueado/vetado/ajustado/recomendado/escalado a partir da telemetria.
 *      Nenhuma regra de segurança é reimplementada ou "reinterpretada" aqui.
 *   2. Classifica os 500 `intencao` em 28 templates (verificado por análise
 *      prévia: as 28 contagens somam exatamente 500). Cada template mapeia
 *      para um fármaco-alvo e uma ação pretendida, com a justificativa citando
 *      a linha/regra do uti.dsl no comentário do handler correspondente.
 *   3. Resolve a decisão final por `resolverDecisao`: tenta a ação pretendida;
 *      se `retrieveConstraints` já removeu essa decisão da política do
 *      fármaco (bloqueio de incremento ou veto total), cai para o fallback
 *      consistente com a MESMA política computada (nunca inventa uma decisão
 *      fora do que `policy.decisoes` permite).
 *   4. Monta o texto `plano` no formato gramatical do uti.dsl (mesma sintaxe
 *      do exemplar `Plano_Referencia_Choque`), e um campo extra `description`
 *      em prosa citando a regra exata (protocolo/regra_seguranca/ajuste
 *      renal/população) que determinou o resultado.
 *
 * Campo OMITIDO de propósito: `regrasEmGHat`. Esse número mede quantas regras
 * sobreviveram à poda gramatical no MOTOR de decodificação (Python), que por
 * sua vez roda sobre o subconjunto pós-foco-semântico (embedding) — uma etapa
 * heurística que este gabarito propositalmente não reproduz (o ground truth
 * usa as restrições COMPLETAS, não a aproximação por similaridade). Incluir
 * um número aqui seria comparar grandezas diferentes; melhor omitir do que
 * fabricar um valor que pareça comparável e não seja.
 *
 * Uso:
 *   npx tsx src/scripts/gerar-ground-truth-med.ts
 *
 * Gera: src/examples/med/ground_truth_med.jsonl (500 linhas, 1 por cenário)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadModel } from '../database/neo4j.js';
import { retrieveConstraints, type ClinicalContext, type RetrievedConstraints } from '../knowledge/graphrag.js';
import { montarPromptSemantico } from '../inference/llm-client.js';
import type { RegistroGroundTruth } from '../inference/avaliar.js';

// -----------------------------------------------------------------------------
// Metadados de dose por fármaco (uti.dsl) — "inicial" para INICIAR_INFUSAO,
// "step" (titulacao) para AUMENTAR_VAZAO/REDUZIR_VAZAO/AJUSTAR_DOSE. O plano de
// referência do próprio uti.dsl reporta o INCREMENTO/degrau na dose, não uma
// dose absoluta acumulada (que o cenário nem fornece).
// -----------------------------------------------------------------------------
interface DoseMeta {
    inicial: { valor: string; unidade: string };
    step: { valor: string; unidade: string };
}

const FARMACOS: Record<string, DoseMeta> = {
    Noradrenalina: { inicial: { valor: '0.05', unidade: 'mcg/kg/min' }, step: { valor: '0.05', unidade: 'mcg/kg/min' } },
    Adrenalina: { inicial: { valor: '0.05', unidade: 'mcg/kg/min' }, step: { valor: '0.05', unidade: 'mcg/kg/min' } },
    Vasopressina: { inicial: { valor: '0.01', unidade: 'U/min' }, step: { valor: '0.01', unidade: 'U/min' } },
    Dobutamina: { inicial: { valor: '2.5', unidade: 'mcg/kg/min' }, step: { valor: '2.5', unidade: 'mcg/kg/min' } },
    Propofol: { inicial: { valor: '0.5', unidade: 'mg/kg/h' }, step: { valor: '0.5', unidade: 'mg/kg/h' } },
    Midazolam: { inicial: { valor: '0.02', unidade: 'mg/kg/h' }, step: { valor: '0.02', unidade: 'mg/kg/h' } },
    Fentanil: { inicial: { valor: '0.5', unidade: 'mcg/kg/h' }, step: { valor: '0.25', unidade: 'mcg/kg/h' } },
    Cisatracurio: { inicial: { valor: '1.0', unidade: 'mcg/kg/min' }, step: { valor: '0.5', unidade: 'mcg/kg/min' } },
    Vancomicina: { inicial: { valor: '25.0', unidade: 'mg/kg' }, step: { valor: '15.0', unidade: 'mg/kg' } },
    Piperacilina_Tazobactam: { inicial: { valor: '4500.0', unidade: 'mg' }, step: { valor: '4500.0', unidade: 'mg' } },
    Heparina: { inicial: { valor: '12.0', unidade: 'UI/kg' }, step: { valor: '100.0', unidade: 'UI/h' } },
    Insulina_Regular: { inicial: { valor: '1.0', unidade: 'UI/h' }, step: { valor: '1.0', unidade: 'UI/h' } }
};

/** Conduta nomeada do esquema_dados por decisão — MANTER_VAZAO, AJUSTAR_DOSE e
 *  SUBSTITUIR não têm conduta própria no uti.dsl (só o código de decisão existe
 *  nesses casos), então ficam de fora de `sequencia`: não inventamos uma
 *  conduta que o modelo não define. */
const CONDUTA_POR_DECISAO: Record<string, string> = {
    INICIAR_INFUSAO: 'Iniciar_Vasopressor',
    AUMENTAR_VAZAO: 'Titular_Vasopressor',
    REDUZIR_VAZAO: 'Reduzir_Infusao',
    MANTER_BLOQUEADO: 'Manter_Bloqueio',
    SUSPENDER: 'Suspender_Farmaco',
    SOLICITAR_EXAME: 'Solicitar_Exame_Controle',
    ESCALAR_EQUIPE: 'Acionar_Equipe',
    BLOQUEAR_ORDEM: 'Bloquear_Ordem_Insegura'
};

const VIA_PADRAO = 'ACESSO_CENTRAL';

interface Ordem {
    farmaco: string;
    decisao: string;
    dose: string;
    via: string;
    justificativa: string;
    bloqueado: boolean;
}

interface Alerta {
    nivel: 'INFORMATIVO' | 'ATENCAO' | 'CRITICO' | 'BLOQUEANTE';
    texto: string;
    regra?: string;
}

interface Resultado {
    protocolo?: string;
    ordens: Ordem[];
    alertas: Alerta[];
    descricao: string;
}

function doseTexto(farmaco: string, decisao: string): string {
    const meta = FARMACOS[farmaco];
    if (!meta) return '0.0';
    if (decisao === 'INICIAR_INFUSAO') return `${meta.inicial.valor} ${meta.inicial.unidade}`;
    if (decisao === 'AUMENTAR_VAZAO' || decisao === 'AJUSTAR_DOSE' || decisao === 'REDUZIR_VAZAO') {
        return `${meta.step.valor} ${meta.step.unidade}`;
    }
    return `0.0 ${meta.inicial?.unidade ?? ''}`.trim();
}

/**
 * Tenta a decisão pretendida para `farmaco`; se `retrieveConstraints` já
 * removeu essa decisão da política (bloqueio de incremento ou veto total),
 * cai para o fallback que a PRÓPRIA política ainda permite — nunca inventa
 * uma saída fora de `policy.decisoes`.
 */
function resolverDecisao(
    constraints: RetrievedConstraints,
    farmaco: string,
    desejada: string
): { decisao: string; bloqueado: boolean; motivo: string } {
    const policy = constraints.politicas.get(farmaco);
    if (!policy) return { decisao: desejada, bloqueado: false, motivo: '' };
    if (policy.decisoes.includes(desejada)) return { decisao: desejada, bloqueado: false, motivo: '' };

    const vetoTotal = constraints.vetados.some(v => v.farmaco === farmaco);
    let fallback: string;
    if (vetoTotal) {
        fallback = policy.decisoes.includes('SUSPENDER')
            ? 'SUSPENDER'
            : policy.decisoes.includes('BLOQUEAR_ORDEM')
              ? 'BLOQUEAR_ORDEM'
              : 'ESCALAR_EQUIPE';
    } else {
        fallback = policy.decisoes.includes('MANTER_BLOQUEADO')
            ? 'MANTER_BLOQUEADO'
            : policy.decisoes.includes('MANTER_VAZAO')
              ? 'MANTER_VAZAO'
              : 'SOLICITAR_EXAME';
    }
    return { decisao: fallback, bloqueado: true, motivo: policy.motivos.join('; ') };
}

function farmacoEmUso(contexto: ClinicalContext, farmaco: string): boolean {
    return (contexto.farmacosEmUso ?? []).includes(farmaco);
}

/** Ordem de incremento "natural": AUMENTAR_VAZAO se já em uso, senão INICIAR_INFUSAO. */
function ordemIncremento(constraints: RetrievedConstraints, contexto: ClinicalContext, farmaco: string, justificativaBase: string): Ordem {
    const desejada = farmacoEmUso(contexto, farmaco) ? 'AUMENTAR_VAZAO' : 'INICIAR_INFUSAO';
    const { decisao, bloqueado, motivo } = resolverDecisao(constraints, farmaco, desejada);
    return { farmaco, decisao, dose: doseTexto(farmaco, decisao), via: VIA_PADRAO, justificativa: bloqueado ? motivo : justificativaBase, bloqueado };
}

function ordemDecremento(constraints: RetrievedConstraints, farmaco: string, justificativaBase: string): Ordem {
    const { decisao, bloqueado, motivo } = resolverDecisao(constraints, farmaco, 'REDUZIR_VAZAO');
    return { farmaco, decisao, dose: doseTexto(farmaco, decisao), via: VIA_PADRAO, justificativa: bloqueado ? motivo : justificativaBase, bloqueado };
}

function ordemSuspensao(farmaco: string, justificativa: string): Ordem {
    return { farmaco, decisao: 'SUSPENDER', dose: doseTexto(farmaco, 'SUSPENDER'), via: VIA_PADRAO, justificativa, bloqueado: false };
}

function ordemEscalar(justificativa: string): Ordem {
    return { farmaco: '', decisao: 'ESCALAR_EQUIPE', dose: doseTexto('', 'ESCALAR_EQUIPE'), via: VIA_PADRAO, justificativa, bloqueado: false };
}

function ordemExame(farmaco: string, justificativa: string): Ordem {
    return { farmaco, decisao: 'SOLICITAR_EXAME', dose: doseTexto(farmaco, 'SOLICITAR_EXAME'), via: VIA_PADRAO, justificativa, bloqueado: false };
}

/** MANTER_VAZAO nunca é removido por bloqueio de incremento (só decisões de
 *  incremento saem da política) — usamos MANTER_BLOQUEADO quando disponível
 *  por ser mais comunicativo (é literalmente a conduta "Manter_Bloqueio"). */
function ordemManter(constraints: RetrievedConstraints, farmaco: string, justificativa: string): Ordem {
    const policy = constraints.politicas.get(farmaco);
    const decisao = policy?.decisoes.includes('MANTER_BLOQUEADO') ? 'MANTER_BLOQUEADO' : 'MANTER_VAZAO';
    return { farmaco, decisao, dose: doseTexto(farmaco, decisao), via: VIA_PADRAO, justificativa, bloqueado: decisao === 'MANTER_BLOQUEADO' };
}

function sedativosAtivos(contexto: ClinicalContext): string[] {
    return ['Propofol', 'Midazolam'].filter(f => farmacoEmUso(contexto, f));
}

function vasopressoresAtivos(contexto: ClinicalContext): string[] {
    return ['Noradrenalina', 'Adrenalina', 'Vasopressina'].filter(f => farmacoEmUso(contexto, f));
}

function protocoloAtivo(constraints: RetrievedConstraints, nome: string): boolean {
    return constraints.protocolosAtivos.some(p => p.nome === nome);
}

function gatilhosDe(constraints: RetrievedConstraints, nome: string): string {
    return constraints.protocolosAtivos.find(p => p.nome === nome)?.gatilhos.join('; ') ?? '';
}

function alertaBloqueio(o: Ordem, regra: string): Alerta[] {
    return o.bloqueado ? [{ nivel: 'BLOQUEANTE', texto: `${o.farmaco}: ${o.justificativa}`, regra }] : [];
}

function alertasEscalonamento(constraints: RetrievedConstraints): Alerta[] {
    return constraints.escalonamentos.map(e => ({
        nivel: 'CRITICO',
        texto: `${e.destino}: ${e.detalhe}`,
        regra: `${e.protocolo}/escalonar`
    }));
}

// -----------------------------------------------------------------------------
// Um handler por template (28 no total, cobrindo os 500 cenários). Cada um cita
// a linha/regra do uti.dsl que justifica a decisão.
// -----------------------------------------------------------------------------

type Handler = (constraints: RetrievedConstraints, contexto: ClinicalContext) => Resultado;

// T1 (n=38): PAM sempre <65 (choque), RASS sempre 1-3 (agitado), glicemia
// elevada — três achados simultâneos, a pergunta pede explicitamente a
// PRIORIDADE. Choque_Septico (PAM<65) é o único dos três com escalonamento
// hemodinâmico automático (uti.dsl protocolo Choque_Septico, escalonar
// lactato>4/PAM<55) — precede Sedacao_Analgesia_VM (RASS>0 só pede "avaliar
// dor antes de sedar") e Controle_Glicemico_UTI (glicemia>180 é eletivo).
const handlerT1: Handler = (constraints, contexto) => {
    const ordem = ordemIncremento(constraints, contexto, 'Noradrenalina', 'PAM abaixo de 65 mmHg: vasopressor de primeira linha per Choque_Septico (protocolo mais urgente entre os achados)');
    const outrosAtivos = constraints.protocolosAtivos.filter(p => p.nome !== 'Choque_Septico').map(p => p.nome);
    return {
        protocolo: 'Choque_Septico',
        ordens: [ordem],
        alertas: [...alertaBloqueio(ordem, 'regra_seguranca/Noradrenalina'), ...alertasEscalonamento(constraints)],
        descricao:
            `Dos três achados (PAM baixa, agitação RASS positivo, hiperglicemia), a prioridade é a instabilidade ` +
            `hemodinâmica: Choque_Septico é o único protocolo com escalonamento automático nesses valores (uti.dsl, ` +
            `protocolo Choque_Septico). A ação correta "primeiro" é ${ordem.decisao} em Noradrenalina` +
            (ordem.bloqueado ? ` — mas está bloqueada: ${ordem.justificativa} (regra_seguranca).` : `.`) +
            (outrosAtivos.length > 0
                ? ` Os protocolos ${outrosAtivos.join(' e ')} também estão ativos, mas nenhum tem gatilho de urgência ` +
                  `equivalente ao de Choque_Septico — devem ser endereçados na sequência, não antes.`
                : ` A agitação e a glicemia elevadas não têm gatilho de urgência equivalente e devem ser reavaliadas na sequência.`)
    };
};

// T2/T4/T6 (n=26+23+23=72): pedido explícito de subir/iniciar noradrenalina com
// PAM<65 — caso direto de Choque_Septico, recomenda Noradrenalina (uti.dsl:338).
const handlerVasopressorDireto: Handler = (constraints, contexto) => {
    const ordem = ordemIncremento(
        constraints,
        contexto,
        'Noradrenalina',
        `PAM abaixo de 65 mmHg: ${gatilhosDe(constraints, 'Choque_Septico') || 'iniciar vasopressor'} — Noradrenalina é recomendada como primeira linha por Choque_Septico`
    );
    return {
        protocolo: protocoloAtivo(constraints, 'Choque_Septico') ? 'Choque_Septico' : undefined,
        ordens: [ordem],
        alertas: [...alertaBloqueio(ordem, 'regra_seguranca/Noradrenalina'), ...alertasEscalonamento(constraints)],
        descricao: ordem.bloqueado
            ? `Pedido negado: ${ordem.justificativa} (regra_seguranca em uti.dsl) — o incremento de Noradrenalina fica ` +
              `inexprimível pela gramática podada nesse contexto, mesmo com PAM baixa.`
            : `Pedido consistente com o protocolo: Choque_Septico recomenda Noradrenalina como vasopressor de primeira ` +
              `linha para PAM < 65 mmHg (uti.dsl, "recomenda Noradrenalina indicacao ..."). Decisão: ${ordem.decisao}, ` +
              `dose ${ordem.dose} via ${ordem.via}.`
    };
};

// T3/T5 (n=24+23=47): RASS muito negativo (-4/-5), pedido de reduzir o
// sedativo — corresponde ao gatilho Sedacao_Analgesia_VM RASS<-4 ("sedação
// excessiva: reduzir infusão e despertar diário", uti.dsl:357). REDUZIR_VAZAO
// nunca é removido por bloqueio de incremento; só um veto total (ex.:
// Midazolam em Gestante) o remove — nesse caso o fallback vira SUSPENDER.
const handlerReduzirSedativoPedido: Handler = (constraints, contexto) => {
    const ativos = sedativosAtivos(contexto);
    if (ativos.length === 0) {
        return {
            protocolo: protocoloAtivo(constraints, 'Sedacao_Analgesia_VM') ? 'Sedacao_Analgesia_VM' : undefined,
            ordens: [ordemExame('', 'nenhum sedativo contínuo em uso neste momento — nada a reduzir')],
            alertas: [],
            descricao: `RASS muito negativo, mas não há Propofol nem Midazolam em infusão contínua no contexto informado — não há o que reduzir. Provável inconsistência do pedido com o estado atual do paciente.`
        };
    }
    const ordens = ativos.map(f => ordemDecremento(constraints, f, `RASS muito negativo: gatilho de sedação excessiva de Sedacao_Analgesia_VM (uti.dsl: "RASS<-4 -> reduzir infusão e despertar diário")`));
    return {
        protocolo: 'Sedacao_Analgesia_VM',
        ordens,
        alertas: ordens.flatMap(o => alertaBloqueio(o, `regra_seguranca/${o.farmaco}`)),
        descricao:
            `RASS muito negativo corresponde exatamente ao gatilho de Sedacao_Analgesia_VM para sedação excessiva ` +
            `(uti.dsl: "RASS < -4 -> reduzir infusão e despertar diário"). Reduzir não é bloqueado por nenhuma ` +
            `regra_seguranca (essas regras só restringem incremento) — a única forma de a decisão não ser ` +
            `REDUZIR_VAZAO é um veto total do fármaco (ex.: Midazolam em população Gestante), caso em que o correto ` +
            `é SUSPENDER, não apenas reduzir. Fármaco(s) alvo: ${ativos.join(', ')}.`
    };
};

// T7/T20 (n=20+13=33): hiperglicemia, pedido de iniciar/corrigir com insulina.
// Controle_Glicemico_UTI gatilho glicemia>180 (uti.dsl:379), recomenda
// Insulina_Regular. regra_seguranca só bloqueia incremento se glicemia<140,
// nunca o caso aqui (valores sempre >180 no template).
const handlerHiperglicemia: Handler = (constraints, contexto) => {
    const ordem = ordemIncremento(constraints, contexto, 'Insulina_Regular', 'glicemia acima de 180 mg/dL: gatilho de Controle_Glicemico_UTI, recomenda Insulina_Regular');
    return {
        protocolo: protocoloAtivo(constraints, 'Controle_Glicemico_UTI') ? 'Controle_Glicemico_UTI' : undefined,
        ordens: [ordem],
        alertas: alertaBloqueio(ordem, 'regra_seguranca/Insulina_Regular'),
        descricao: `Hiperglicemia dispara o gatilho de Controle_Glicemico_UTI (glicemia > 180 mg/dL -> iniciar insulina regular em infusão contínua), que recomenda diretamente Insulina_Regular. Decisão: ${ordem.decisao}, dose ${ordem.dose} via ${ordem.via}.`
    };
};

// T8/T15/T17 (n=20+18+16=54): RASS positivo (agitado), pedido de "sedar mais".
// Sedacao_Analgesia_VM gatilho RASS>0 diz "avaliar dor ANTES de sedar" e
// etapa 1/2 exigem analgesia preemptiva primeiro (uti.dsl:356-360) — a
// resposta correta redireciona para Fentanil (recomendado como analgesia de
// primeira linha), não para aumentar diretamente um sedativo. RASS>2 também
// dispara escalonamento para MEDICO_PLANTONISTA (uti.dsl:368).
const handlerAgitacaoRedirecionaAnalgesia: Handler = (constraints, contexto) => {
    const ordem = ordemIncremento(constraints, contexto, 'Fentanil', 'RASS acima de 0 (agitação): Sedacao_Analgesia_VM exige avaliar/tratar dor com analgesia antes de sedar — Fentanil é a analgesia de primeira linha recomendada');
    return {
        protocolo: 'Sedacao_Analgesia_VM',
        ordens: [ordem],
        alertas: [...alertaBloqueio(ordem, 'regra_seguranca/Fentanil'), ...alertasEscalonamento(constraints)],
        descricao:
            `O pedido literal ("aumenta/precisa sedar mais") não é a conduta correta: Sedacao_Analgesia_VM define que, ` +
            `com RASS > 0, o primeiro passo é "avaliar dor antes de sedar" (gatilho) e a etapa 1 do protocolo é ` +
            `"tratar dor primeiro (analgesia preemptiva com opioide)" — só titular sedativo depois, se RASS ainda ` +
            `acima do alvo. Fentanil é o analgésico de primeira linha recomendado (uti.dsl). Decisão: ${ordem.decisao} ` +
            `em Fentanil, não em um sedativo direto.` +
            (constraints.escalonamentos.length > 0 ? ` Como RASS > 2, também há escalonamento para MEDICO_PLANTONISTA por risco de autoextubação.` : '')
    };
};

// T9 (n=19): FC sempre >130, "e agora?" sem pedir fármaco específico. Nenhum
// gatilho de protocolo no uti.dsl usa FC isoladamente — só a
// regra_seguranca de Noradrenalina (FC>130 bloqueia incremento) toca FC, e só
// se Noradrenalina já estiver em uso (raro neste template: 2/19). Sem droga
// implicada, a conduta correta é escalar para avaliação médica, não inventar
// uma ação farmacológica sem lastro no modelo.
const handlerTaquicardiaSemCausa: Handler = (constraints, contexto) => {
    if (farmacoEmUso(contexto, 'Noradrenalina')) {
        const ordem = ordemManter(constraints, 'Noradrenalina', `FC acima de 130 bpm: regra_seguranca bloqueia incremento de Noradrenalina (risco de taquiarritmia)`);
        return {
            ordens: [ordem],
            alertas: alertaBloqueio(ordem, 'regra_seguranca/Noradrenalina'),
            descricao: `Paciente já em Noradrenalina com FC > 130 bpm: a regra_seguranca de bloqueio de incremento (uti.dsl) é diretamente aplicável — qualquer aumento fica bloqueado; manter a vazão atual é a conduta segura.`
        };
    }
    const ordem = ordemEscalar('taquicardia significativa (FC>130) sem protocolo automático associado no modelo e sem fármaco vasoativo em uso a que atribuí-la');
    return {
        ordens: [ordem],
        alertas: [],
        descricao:
            `FC muito elevada, mas nenhum protocolo ou regra_seguranca do uti.dsl usa frequência cardíaca isolada como ` +
            `gatilho (só a regra_seguranca de Noradrenalina cita FC, e o paciente não está em uso desse fármaco aqui). ` +
            `Sem base no modelo para uma ação farmacológica específica, a conduta correta é ESCALAR_EQUIPE para ` +
            `avaliação médica direta, evitando que o sistema hallucine uma decisão sem respaldo nas regras.`
    };
};

// T10/T27 (n=19+12=31): choque com PAM baixa e lactato alto, pedido explícito
// de escalar. Choque_Septico: lactato>4 -> TIME_RESPOSTA_RAPIDA, PAM<55 ->
// INTENSIVISTA (uti.dsl:344-345) — ambos batem nos valores do template.
const handlerEscalonamentoChoque: Handler = (constraints, contexto) => {
    const ordem = ordemEscalar(`${gatilhosDe(constraints, 'Choque_Septico')}`);
    const nora = farmacoEmUso(contexto, 'Noradrenalina') ? ordemManter(constraints, 'Noradrenalina', 'já em vasopressor de primeira linha — manter enquanto a equipe é acionada') : null;
    return {
        protocolo: 'Choque_Septico',
        ordens: nora ? [ordem, nora] : [ordem],
        alertas: alertasEscalonamento(constraints),
        descricao:
            `Choque refratário/recorrente com PAM e lactato nos limiares de escalonamento de Choque_Septico ` +
            `(uti.dsl: "lactato > 4.0 -> TIME_RESPOSTA_RAPIDA", "PAM < 55.0 -> INTENSIVISTA"). Ambos os escalonamentos ` +
            `disparam nesses valores — a conduta correta é ESCALAR_EQUIPE para os destinos indicados. ` +
            (nora ? `Noradrenalina, já em uso, deve ser mantida enquanto a equipe é acionada.` : '')
    };
};

// T11 (n=19): FC sempre >130, pergunta explicitamente se é a noradrenalina
// ("nora"). Só 1/19 tem Noradrenalina em uso — na maioria dos casos a
// resposta correta é justamente que NÃO É a nora (não está em uso).
const handlerTaquicardiaSeraNora: Handler = (constraints, contexto) => {
    if (farmacoEmUso(contexto, 'Noradrenalina')) {
        const ordem = ordemManter(constraints, 'Noradrenalina', 'FC acima de 130 bpm com Noradrenalina em uso: regra_seguranca bloqueia incremento — pode de fato ser a causa');
        return {
            ordens: [ordem],
            alertas: alertaBloqueio(ordem, 'regra_seguranca/Noradrenalina'),
            descricao: `Sim, pode ser a Noradrenalina: o paciente está em uso dela e a regra_seguranca (FC>130 bloqueia incremento de Noradrenalina) é diretamente aplicável — o incremento fica bloqueado; manter a vazão atual e não escalar a dose.`
        };
    }
    const ordem = ordemExame('', 'FC elevada sem Noradrenalina em uso — a taquicardia não é atribuível a ela; investigar outra causa (dor, febre, hipovolemia, agitação)');
    return {
        ordens: [ordem],
        alertas: [],
        descricao: `Não, não é a Noradrenalina: o contexto não lista esse fármaco entre os em uso, logo a regra_seguranca que a relaciona a FC>130 nem se aplica. A taquicardia tem outra causa, que não é modelada automaticamente no uti.dsl — a conduta é investigar (SOLICITAR_EXAME), não ajustar um vasopressor que não está em infusão.`
    };
};

// T12 (n=18): hipoglicemia (glicemia<70, muitas vezes <50). Controle_Glicemico_UTI
// gatilho glicemia<70 -> "suspender insulina e corrigir hipoglicemia
// imediatamente" (uti.dsl:380); glicemia<50 escalona TIME_RESPOSTA_RAPIDA.
// O uti.dsl NÃO modela um fármaco de reposição de glicose — a única ação
// farmacológica lícita no esquema é suspender a insulina, se em uso.
const handlerHipoglicemiaUrgente: Handler = (constraints, contexto) => {
    const insulinaEmUso = farmacoEmUso(contexto, 'Insulina_Regular');
    const ordens: Ordem[] = [];
    if (insulinaEmUso) ordens.push(ordemSuspensao('Insulina_Regular', `glicemia abaixo de 70 mg/dL: gatilho de Controle_Glicemico_UTI ("suspender insulina e corrigir hipoglicemia imediatamente")`));
    else ordens.push(ordemExame('', 'hipoglicemia, mas insulina não está em infusão — nada a suspender; ainda assim a correção da glicemia se impõe'));
    return {
        protocolo: 'Controle_Glicemico_UTI',
        ordens,
        alertas: alertasEscalonamento(constraints),
        descricao:
            `Hipoglicemia dispara o gatilho de Controle_Glicemico_UTI (glicemia < 70 mg/dL -> suspender insulina e ` +
            `corrigir imediatamente).` +
            (insulinaEmUso ? ' Insulina em uso: a ação correta é SUSPENDER.' : ' Insulina NÃO está em uso: não há o que suspender.') +
            ` Importante: o uti.dsl não modela nenhum fármaco de reposição de glicose (dextrose/glicose não constam ` +
            `entre os \`farmaco\` definidos) — dentro do universo fechado do esquema_dados, a única ação farmacológica ` +
            `lícita é a suspensão da insulina; a correção glicêmica propriamente dita está fora do escopo de decisão ` +
            `deste modelo.` +
            (constraints.escalonamentos.length > 0 ? ' Como a glicemia está abaixo de 50 mg/dL, há também escalonamento para TIME_RESPOSTA_RAPIDA (hipoglicemia grave).' : '')
    };
};

// T13 (n=18): "sedação excessiva... despertar diário" — igual T3/T5 (mesmo
// gatilho RASS<-4 de Sedacao_Analgesia_VM), mas aqui é onde a população
// Gestante + Midazolam aparece com mais frequência: nesse caso Midazolam é
// vetado (uti.dsl, populacao Gestante "proibe Midazolam"), e reduzir não
// basta — o correto é SUSPENDER.
const handlerDespertarDiario: Handler = handlerReduzirSedativoPedido;

// T14 (n=18): TFG muito baixa, pergunta se muda algo na infusão. Ajuste renal
// modelado só para Vancomicina/Piperacilina_Tazobactam/Midazolam/Fentanil
// (uti.dsl ajuste_renal). Maioria dos casos (11/18) não tem nenhum desses em
// uso — resposta correta é que nada muda automaticamente para os fármacos
// atuais, sem inventar um ajuste não modelado.
const handlerFuncaoRenal: Handler = (constraints, contexto) => {
    const candidatos = ['Vancomicina', 'Piperacilina_Tazobactam', 'Midazolam', 'Fentanil'].filter(f => farmacoEmUso(contexto, f));
    if (candidatos.length === 0) {
        return {
            ordens: [ordemExame('', 'nenhum fármaco em uso está sujeito a ajuste renal modelado no uti.dsl (Vancomicina, Piperacilina_Tazobactam, Midazolam, Fentanil)')],
            alertas: [],
            descricao: `TFG baixa, mas nenhum dos fármacos atualmente em uso tem \`ajuste_renal\` definido no uti.dsl para o valor observado — não há ação automática correta a tomar sobre a infusão atual; a conduta é reavaliar função renal e antibioticoterapia caso algum desses fármacos venha a ser prescrito.`
        };
    }
    const ordens = candidatos.map(f => {
        const ajustes = constraints.ajustes.filter(a => a.farmaco === f);
        if (ajustes.length === 0) return ordemManter(constraints, f, `TFG atual não atinge o limiar de ajuste_renal definido para ${f} no uti.dsl`);
        const suspender = ajustes.some(a => a.acao === 'suspender');
        const justificativa = ajustes.map(a => `${a.acao} — ${a.detalhe}`).join('; ');
        return suspender ? ordemSuspensao(f, justificativa) : { farmaco: f, decisao: 'AJUSTAR_DOSE', dose: doseTexto(f, 'AJUSTAR_DOSE'), via: VIA_PADRAO, justificativa, bloqueado: false };
    });
    return {
        ordens,
        alertas: [],
        descricao: `Sim, muda: ${candidatos.join(', ')} está(ão) em uso e sujeito(s) a \`ajuste_renal\` no uti.dsl para a TFG observada — ${ordens.map(o => `${o.farmaco}: ${o.decisao} (${o.justificativa})`).join('; ')}.`
    };
};

// T16/T24 (n=17+13=30): plaquetas sempre <50 com Heparina sempre em uso.
// regra_seguranca bloqueia incremento de Heparina se plaquetas<50 (uti.dsl) —
// mas isso não impede MANTER a vazão atual, só um aumento. Não há regra no
// modelo que suspenda automaticamente por plaquetopenia isolada (o
// contraindicado é TIH PRÉVIA, não avaliável a partir de uma única contagem).
const handlerPlaquetopeniaHeparina: Handler = (constraints, contexto) => {
    const ordem = ordemManter(constraints, 'Heparina', 'plaquetas abaixo de 50 mil: regra_seguranca bloqueia incremento de Heparina (risco hemorrágico) — manutenção da dose atual permanece lícita');
    return {
        ordens: [ordem],
        alertas: alertaBloqueio(ordem, 'regra_seguranca/Heparina'),
        descricao:
            `Plaquetas abaixo de 50 mil ativam a regra_seguranca que bloqueia INCREMENTO de Heparina (uti.dsl: ` +
            `"bloquear_incremento Heparina se plaquetas < 50 10^3/uL"). Isso NÃO equivale a suspender: o modelo não ` +
            `tem uma regra automática de suspensão por plaquetopenia isolada (o \`contraindicado\` correspondente é ` +
            `trombocitopenia induzida por heparina PRÉVIA, não avaliável a partir de uma única contagem de ` +
            `plaquetas). Decisão correta: ${ordem.decisao} — pode manter a dose atual, não pode aumentar.`
    };
};

// T18 (n=16): SpO2 baixa, "o que eu faço?". Nenhum gatilho/regra do uti.dsl
// usa SpO2 — dessaturação é problema respiratório/de via aérea, fora do
// escopo de decisão farmacológica do esquema_dados. Escalar é a conduta
// correta, sem inventar ação farmacológica.
const handlerDessaturacao: Handler = () => ({
    ordens: [ordemEscalar('dessaturação (SpO2 baixa) não é parâmetro de nenhum gatilho, regra_seguranca ou protocolo no uti.dsl')],
    alertas: [],
    descricao:
        `SpO2 não aparece em nenhum \`gatilho\`, \`regra_seguranca\` ou protocolo do uti.dsl — dessaturação exige ` +
        `avaliação respiratória direta (via aérea, parâmetros ventilatórios, PEEP), que está fora do universo de ` +
        `decisão farmacológica do esquema_dados. A conduta correta e segura é ESCALAR_EQUIPE para avaliação médica ` +
        `imediata, não uma ordem farmacológica sem base no modelo.`
});

// T19 (n=14): "estabilizou... começar o desmame do vasopressor?" PAM/lactato
// sempre normais no template, mas só 1/14 tem vasopressor de fato em uso.
// Choque_Septico define um `desmame` textual (reduzir 0.02 mcg/kg/min a cada
// 15 min com PAM>70 por 4h e lactato normalizado) — não é um `gatilho`
// avaliado por retrieveConstraints, mas é a política textual do protocolo;
// cito-a como a base clínica da resposta.
const handlerDesmameVasopressor: Handler = (constraints, contexto) => {
    const ativos = vasopressoresAtivos(contexto);
    if (ativos.length === 0) {
        return {
            ordens: [ordemExame('', 'não há vasopressor em uso no contexto informado — não há o que desmamar')],
            alertas: [],
            descricao: `Sinais vitais estáveis, mas o contexto não lista nenhum vasopressor (Noradrenalina/Adrenalina/Vasopressina) em uso — a pergunta não se aplica; não há infusão a desmamar.`
        };
    }
    const ordens = ativos.map(f => ordemDecremento(constraints, f, `PAM e lactato estáveis: critério de desmame de Choque_Septico (uti.dsl: "PAM estável acima de 70 mmHg por 4h com lactato normalizado -> reduzir 0.02 mcg/kg/min a cada 15 min")`));
    return {
        protocolo: 'Choque_Septico',
        ordens,
        alertas: ordens.flatMap(o => alertaBloqueio(o, `regra_seguranca/${o.farmaco}`)),
        descricao: `Estabilidade hemodinâmica sustentada corresponde ao critério de desmame descrito em Choque_Septico. Fármaco(s) em uso a reduzir gradualmente: ${ativos.join(', ')}. Decisão: REDUZIR_VAZAO (degrau de titulação), não suspensão abrupta.`
    };
};

// T21 (n=13): TFG baixa, pergunta especificamente sobre antibióticos. Restrito
// a Vancomicina/Piperacilina_Tazobactam (os únicos com ajuste_renal no uti.dsl
// entre os antimicrobianos). Só 2/13 têm algum desses em uso.
const handlerAjusteAntibiotico: Handler = (constraints, contexto) => {
    const candidatos = ['Vancomicina', 'Piperacilina_Tazobactam'].filter(f => farmacoEmUso(contexto, f));
    if (candidatos.length === 0) {
        return {
            ordens: [ordemExame('', 'nenhum antimicrobiano com ajuste_renal modelado (Vancomicina, Piperacilina_Tazobactam) está em uso')],
            alertas: [],
            descricao: `TFG baixa, mas o paciente não está em uso de Vancomicina nem Piperacilina_Tazobactam (os únicos antimicrobianos com \`ajuste_renal\` definido no uti.dsl) — não há ajuste de dose de antibiótico a fazer agora.`
        };
    }
    const ordens = candidatos.map(f => {
        const ajustes = constraints.ajustes.filter(a => a.farmaco === f);
        if (ajustes.length === 0) return ordemManter(constraints, f, `TFG atual não atinge o limiar de ajuste_renal definido para ${f}`);
        const suspender = ajustes.some(a => a.acao === 'suspender');
        const justificativa = ajustes.map(a => `${a.acao} — ${a.detalhe}`).join('; ');
        return suspender ? ordemSuspensao(f, justificativa) : { farmaco: f, decisao: 'AJUSTAR_DOSE', dose: doseTexto(f, 'AJUSTAR_DOSE'), via: VIA_PADRAO, justificativa, bloqueado: false };
    });
    return {
        ordens,
        alertas: [],
        descricao: `Sim: ${ordens.map(o => `${o.farmaco} — ${o.decisao} (${o.justificativa})`).join('; ')}, conforme \`ajuste_renal\` do uti.dsl.`
    };
};

// T22 (n=13): glicemia<70, pedido explícito de suspender a insulina —
// coincide exatamente com o gatilho de Controle_Glicemico_UTI. Só 1/13 tem
// insulina de fato em uso.
const handlerSuspenderInsulinaPedido: Handler = (constraints, contexto) => {
    const insulinaEmUso = farmacoEmUso(contexto, 'Insulina_Regular');
    const ordens: Ordem[] = insulinaEmUso
        ? [ordemSuspensao('Insulina_Regular', `glicemia abaixo de 70 mg/dL: gatilho de Controle_Glicemico_UTI ("suspender insulina e corrigir hipoglicemia imediatamente")`)]
        : [ordemExame('', 'insulina não está em infusão — pedido de suspensão não se aplica')];
    return {
        protocolo: 'Controle_Glicemico_UTI',
        ordens,
        alertas: alertasEscalonamento(constraints),
        descricao: insulinaEmUso
            ? `Pedido correto e alinhado ao gatilho de Controle_Glicemico_UTI (glicemia < 70 mg/dL -> suspender insulina). Decisão: SUSPENDER.`
            : `O pedido presume que a insulina está em infusão, mas o contexto não a lista entre os fármacos em uso — não há o que suspender.` +
              (constraints.escalonamentos.length > 0 ? ' Ainda assim, glicemia abaixo de 50 mg/dL dispara escalonamento para TIME_RESPOSTA_RAPIDA (hipoglicemia grave).' : '')
    };
};

// T23 (n=13): "não respondeu à nora... bora pra vasopressina" — PAM muito
// baixa, FC sempre >130. Vasopressina é a segunda linha recomendada por
// Choque_Septico (uti.dsl:339) quando a resposta à Noradrenalina é
// insuficiente; a FC alta também bloqueia incremento adicional de
// Noradrenalina, reforçando a troca de estratégia.
const handlerSegundaLinhaVasopressina: Handler = (constraints, contexto) => {
    const vaso = ordemIncremento(constraints, contexto, 'Vasopressina', 'PAM refratária à Noradrenalina: Vasopressina é a segunda linha poupadora de catecolamina recomendada por Choque_Septico');
    const ordens: Ordem[] = [vaso];
    if (farmacoEmUso(contexto, 'Noradrenalina')) {
        ordens.push(ordemManter(constraints, 'Noradrenalina', 'FC acima de 130 bpm: regra_seguranca bloqueia incremento adicional de Noradrenalina — reforça a troca de estratégia para Vasopressina'));
    }
    return {
        protocolo: 'Choque_Septico',
        ordens,
        alertas: [...ordens.flatMap(o => alertaBloqueio(o, `regra_seguranca/${o.farmaco}`)), ...alertasEscalonamento(constraints)],
        descricao:
            `Choque refratário à Noradrenalina: Choque_Septico recomenda Vasopressina como segunda linha poupadora ` +
            `de catecolamina (uti.dsl). Decisão: ${vaso.decisao} em Vasopressina.` +
            (farmacoEmUso(contexto, 'Noradrenalina') ? ` Noradrenalina segue em uso, mas com FC>130 bpm o incremento dela está bloqueado pela regra_seguranca — reforça que a estratégia correta é somar Vasopressina, não insistir em subir a Noradrenalina.` : '')
    };
};

// T25 (n=12): "sedação profunda confirmada, pode aumentar o cisatracúrio?"
// RASS sempre -5 no template. regra_seguranca só bloqueia incremento de
// Cisatracurio se RASS > -4 — com RASS=-5 (sedação profunda CONFIRMADA), o
// incremento NÃO é bloqueado: é o caso correto de uso do bloqueador
// neuromuscular (uti.dsl regra_global: "RASS -5 obrigatorio").
const handlerCisatracurioPermitido: Handler = (constraints, contexto) => {
    const ordem = ordemIncremento(constraints, contexto, 'Cisatracurio', 'RASS -5 (sedação profunda confirmada): regra_seguranca só bloqueia incremento de Cisatracurio se RASS > -4 — aqui não bloqueia, e é exatamente a condição exigida pela regra_global para uso do bloqueador neuromuscular');
    return {
        ordens: [ordem],
        alertas: alertaBloqueio(ordem, 'regra_seguranca/Cisatracurio'),
        descricao:
            `Sim, pode: a regra_seguranca bloqueia incremento de Cisatracurio apenas se RASS > -4.0 pontos (uti.dsl). ` +
            `Com RASS = -5 (sedação profunda confirmada), a condição de bloqueio não se aplica — e essa é exatamente ` +
            `a condição que a regra_global exige para bloqueio neuromuscular ("só pode ser infundido com sedação ` +
            `profunda confirmada, RASS -5"). Decisão: ${ordem.decisao}, dose ${ordem.dose} via ${ordem.via}.`
    };
};

// T26 (n=12): "pressão e lactato normais, posso reduzir a sedação?" — quase
// nunca há sedativo em uso (1/12); quando há, nada bloqueia a redução (só
// incrementos são bloqueáveis por regra_seguranca).
const handlerReduzirSedacaoSeguranca: Handler = (constraints, contexto) => {
    const ativos = sedativosAtivos(contexto);
    if (ativos.length === 0) {
        return {
            ordens: [ordemExame('', 'nenhum sedativo contínuo em uso no contexto informado')],
            alertas: [],
            descricao: `Hemodinâmica estável, mas não há Propofol nem Midazolam em infusão contínua no contexto informado — a pergunta não se aplica; não há sedação a reduzir.`
        };
    }
    const ordens = ativos.map(f => ordemDecremento(constraints, f, 'PAM e lactato normais: nenhuma regra_seguranca ou veto impede reduzir sedativo (só incrementos são bloqueáveis) — redução é segura'));
    return {
        ordens,
        alertas: ordens.flatMap(o => alertaBloqueio(o, `regra_seguranca/${o.farmaco}`)),
        descricao: `Sim, pode reduzir com segurança: hemodinâmica normal e nenhuma regra_seguranca do uti.dsl restringe REDUZIR_VAZAO (essas regras só bloqueiam incrementos). Fármaco(s): ${ativos.join(', ')}.`
    };
};

// T28 (n=10): "estável há horas, já dá pra tirar a droga vasoativa?" — mais
// exigente que T19 (tirar = remoção completa, não so reduzir). Maioria (6/10)
// sem vasopressor em uso. Quando em uso, com PAM>=70 e lactato<2.0 (limiar do
// próprio gatilho de ativação de Choque_Septico, ou seja "normalizado"),
// SUSPENDER é defensável; caso contrário, redução cautelosa (REDUZIR_VAZAO).
const handlerSuspenderVasopressorTotal: Handler = (constraints, contexto) => {
    const ativos = vasopressoresAtivos(contexto);
    if (ativos.length === 0) {
        return {
            ordens: [ordemExame('', 'não há vasopressor em uso no contexto informado — não há o que tirar')],
            alertas: [],
            descricao: `Paciente estável, mas o contexto não lista nenhum vasopressor em uso — a pergunta não se aplica.`
        };
    }
    const pamOk = (contexto.telemetria.PAM ?? 0) >= 70;
    const lactatoOk = (contexto.telemetria.lactato ?? 99) < 2.0;
    const criterioAtendido = pamOk && lactatoOk;
    const ordens = ativos.map(f =>
        criterioAtendido
            ? ordemSuspensao(f, 'PAM >= 70 mmHg e lactato < 2.0 mmol/L (normalizado, abaixo do próprio limiar de ativação de Choque_Septico): estabilidade sustentada permite suspensão completa')
            : ordemDecremento(constraints, f, 'estabilidade parcial: PAM e/ou lactato ainda não atingem o critério pleno de normalização — redução cautelosa, não suspensão abrupta')
    );
    return {
        protocolo: 'Choque_Septico',
        ordens,
        alertas: ordens.flatMap(o => alertaBloqueio(o, `regra_seguranca/${o.farmaco}`)),
        descricao: criterioAtendido
            ? `PAM e lactato plenamente normalizados (PAM >= 70 mmHg, lactato < 2.0 mmol/L — o próprio limiar de ativação de Choque_Septico) sustentam remoção completa: SUSPENDER ${ativos.join(', ')}.`
            : `Sinais "estáveis", mas PAM e/ou lactato não atingem plenamente o limiar de normalização do protocolo (PAM >= 70 mmHg e lactato < 2.0 mmol/L) — mais prudente reduzir gradualmente (REDUZIR_VAZAO) do que suspender de uma vez.`
    };
};

// -----------------------------------------------------------------------------
// Classificador: cada cenário casa com exatamente um marcador textual fixo do
// template (a parte variável é sempre numérica). Verificado contra as 500
// linhas antes deste script ser escrito: cobertura e exclusividade 100%.
// -----------------------------------------------------------------------------

const CLASSIFICADORES: Array<{ marcador: string; handler: Handler }> = [
    { marcador: 'ele tá agitado e a glicemia deu', handler: handlerT1 },
    { marcador: 'Sobe a noradrenalina.', handler: handlerVasopressorDireto },
    { marcador: 'Acho que sedou demais, reduz a infusão', handler: handlerReduzirSedativoPedido },
    { marcador: 'entrou em choque. Inicia vasopressor', handler: handlerVasopressorDireto },
    { marcador: 'Dá pra desligar um pouco o sedativo', handler: handlerReduzirSedativoPedido },
    { marcador: 'precisa de droga vasoativa agora', handler: handlerVasopressorDireto },
    { marcador: 'paciente hiperglicêmico. Corrige com insulina', handler: handlerHiperglicemia },
    { marcador: 'tá se debatendo', handler: handlerAgitacaoRedirecionaAnalgesia },
    { marcador: 'parece instável, e agora', handler: handlerTaquicardiaSemCausa },
    { marcador: 'Aciona o time de resposta rápida', handler: handlerEscalonamentoChoque },
    { marcador: 'será que é a nora', handler: handlerTaquicardiaSeraNora },
    { marcador: 'Precisa agir rápido', handler: handlerHipoglicemiaUrgente },
    { marcador: 'Precisa de despertar diário', handler: handlerDespertarDiario },
    { marcador: 'Isso muda alguma coisa na infusão', handler: handlerFuncaoRenal },
    { marcador: 'brigando com o tubo. Aumenta a sedação', handler: handlerAgitacaoRedirecionaAnalgesia },
    { marcador: 'será que dá pra manter a heparina', handler: handlerPlaquetopeniaHeparina },
    { marcador: 'risco de autoextubação', handler: handlerAgitacaoRedirecionaAnalgesia },
    { marcador: 'ele tá dessaturando', handler: handlerDessaturacao },
    { marcador: 'começar o desmame do vasopressor', handler: handlerDesmameVasopressor },
    { marcador: 'Inicia insulina em bomba', handler: handlerHiperglicemia },
    { marcador: 'ajustar a dose dos antibióticos', handler: handlerAjusteAntibiotico },
    { marcador: 'suspende a insulina', handler: handlerSuspenderInsulinaPedido },
    { marcador: 'Bora pra vasopressina', handler: handlerSegundaLinhaVasopressina },
    { marcador: 'tô com medo de sangramento', handler: handlerPlaquetopeniaHeparina },
    { marcador: 'Pode aumentar o cisatracúrio', handler: handlerCisatracurioPermitido },
    { marcador: 'Posso reduzir a sedação com segurança', handler: handlerReduzirSedacaoSeguranca },
    { marcador: 'Precisamos escalar', handler: handlerEscalonamentoChoque },
    { marcador: 'tirar a droga vasoativa', handler: handlerSuspenderVasopressorTotal }
];

function classificar(intencao: string): Handler {
    const encontrados = CLASSIFICADORES.filter(c => intencao.includes(c.marcador));
    if (encontrados.length === 0) throw new Error(`Nenhum template reconhece: "${intencao}"`);
    if (encontrados.length > 1) throw new Error(`Mais de um template casa com: "${intencao}" (${encontrados.map(e => e.marcador).join(' | ')})`);
    return encontrados[0].handler;
}

// -----------------------------------------------------------------------------
// Montagem do texto `plano` no formato gramatical do uti.dsl (mesma sintaxe do
// exemplar Plano_Referencia_Choque, aspas duplas, um `ordem` por fármaco).
// -----------------------------------------------------------------------------

/** As justificativas encadeiam citações que às vezes incluem aspas duplas
 *  (ex.: trechos citados do próprio uti.dsl) — como cada citação vira o
 *  conteúdo de um literal de string `"..."` na gramática do plano, uma aspa
 *  dupla embutida fecharia a string cedo demais e corromperia o restante da
 *  linha. Substituímos por aspas simples só quando o texto é embutido na
 *  sintaxe do DSL; o campo `description` (JSON puro) não passa por aqui e
 *  mantém as aspas duplas normalmente. */
function paraDsl(texto: string): string {
    return texto.replace(/"/g, "'");
}

function montarPlano(linha: number, contexto: ClinicalContext, resultado: Resultado): string {
    const nome = `Plano_L${linha}`;
    const paraTexto = resultado.protocolo ? ` para ${resultado.protocolo}` : '';
    const ordensComFarmaco = resultado.ordens.filter(o => o.farmaco);
    const condutas = [...new Set(resultado.ordens.map(o => CONDUTA_POR_DECISAO[o.decisao]).filter((c): c is string => Boolean(c)))];

    const linhas: string[] = [];
    linhas.push(`plano ${nome}${paraTexto} {`);
    linhas.push(`    esquema_referencia AssistenteUTI_v2`);
    linhas.push(`    paciente "${paraDsl(contexto.paciente ?? '')}"`);
    if (condutas.length > 0) linhas.push(`    sequencia [ ${condutas.join(' , ')} ]`);
    for (const o of ordensComFarmaco) {
        linhas.push(`    ordem ${o.farmaco} decisao ${o.decisao} dose ${o.dose} via ${o.via} justificativa "${paraDsl(o.justificativa)}"`);
    }
    for (const o of resultado.ordens.filter(o => !o.farmaco)) {
        linhas.push(`    ordem decisao ${o.decisao} justificativa "${paraDsl(o.justificativa)}"`);
    }
    for (const a of resultado.alertas) {
        linhas.push(`    alerta ${a.nivel} "${paraDsl(a.texto)}"${a.regra ? ` regra "${paraDsl(a.regra)}"` : ''}`);
    }
    linhas.push(`    auditoria "plano derivado deterministicamente das regras do uti.dsl (ground truth)"`);
    linhas.push(`}`);
    return linhas.join('\n');
}

async function main(): Promise<void> {
    const modelPath = path.join('src', 'examples', 'med', 'uti.dsl');
    const cenariosPath = path.join('src', 'examples', 'med', 'cenarios-500.jsonl');
    const outPath = path.join('src', 'examples', 'med', 'ground_truth_med.jsonl');

    console.log(`Carregando modelo clínico (${modelPath})...`);
    const model = await loadModel(modelPath);

    const linhasEntrada = fs
        .readFileSync(cenariosPath, 'utf-8')
        .split('\n')
        .filter(l => l.trim().length > 0);

    const registros: RegistroGroundTruth[] = [];
    const contagemPorHandler = new Map<string, number>();
    const contagemPorDecisao = new Map<string, number>();

    for (const [i, linhaTexto] of linhasEntrada.entries()) {
        const linha = i + 1;
        const cenario = JSON.parse(linhaTexto) as {
            intencao: string;
            paciente?: string;
            telemetria: Record<string, number>;
            populacoes?: string[];
            farmacosEmUso?: string[];
        };

        const contexto: ClinicalContext = {
            paciente: cenario.paciente,
            telemetria: cenario.telemetria,
            populacoes: cenario.populacoes ?? [],
            farmacosEmUso: cenario.farmacosEmUso ?? [],
            intencao: cenario.intencao
        };

        const constraints = retrieveConstraints(model, contexto);
        const handler = classificar(cenario.intencao);
        const resultado = handler(constraints, contexto);

        contagemPorHandler.set(handler.name, (contagemPorHandler.get(handler.name) ?? 0) + 1);
        for (const o of resultado.ordens) contagemPorDecisao.set(o.decisao, (contagemPorDecisao.get(o.decisao) ?? 0) + 1);

        const farmacosFoco = new Set<string>([
            ...resultado.ordens.map(o => o.farmaco).filter(Boolean),
            ...constraints.bloqueios.map(b => b.farmaco),
            ...constraints.vetados.map(v => v.farmaco),
            ...constraints.ajustes.map(a => a.farmaco)
        ]);

        registros.push({
            linha,
            intencao: cenario.intencao,
            aceito: true,
            valido: true,
            erroMotor: null,
            telemetria: {
                paciente: cenario.paciente,
                telemetria: cenario.telemetria,
                populacoes: cenario.populacoes ?? [],
                farmacosEmUso: cenario.farmacosEmUso ?? []
            },
            foco: {
                farmacos: [...farmacosFoco],
                protocolos: constraints.protocolosAtivos.map(p => p.nome)
            },
            promptSemantico: montarPromptSemantico(constraints, contexto),
            plano: montarPlano(linha, contexto, resultado),
            description: resultado.descricao,
            ordensEsperadas: resultado.ordens.map(o => ({ farmaco: o.farmaco, decisao: o.decisao })),
            seguranca: {
                bloqueados: constraints.bloqueios.map(b => b.farmaco),
                vetados: constraints.vetados.map(v => v.farmaco)
            }
        });
    }

    fs.writeFileSync(outPath, registros.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

    console.log(`\n${registros.length} registros escritos em ${outPath}\n`);
    console.log('Distribuição por handler (template):');
    for (const [nome, n] of [...contagemPorHandler.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(3)}  ${nome}`);
    console.log('\nDistribuição por decisão final:');
    for (const [nome, n] of [...contagemPorDecisao.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(3)}  ${nome}`);
}

main().catch(err => {
    console.error('Falha ao gerar ground truth:', err.message ?? err);
    process.exit(1);
});
