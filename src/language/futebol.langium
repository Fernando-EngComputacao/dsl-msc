grammar Futebol

// =============================================================================
// DSL de arbitragem do SPC-CML — dominio: futebol (Laws of the Game, IFAB).
//
// Terceiro dominio da arquitetura, com a MESMA particao em dois esquemas das DSL
// clinica (src/language/dsl.langium) e agricola (src/language/agrodrone.langium).
//
//   ESQUEMA DE CONTROLE  (infracao, lance, contexto, regra_*)
//       Modela o que existe e o que e verdade no dominio da arbitragem. Alimenta
//       o Grafo de Conhecimento e e a fonte factual da recuperacao.
//
//   ESQUEMA DE DADOS     (esquema_dados, conduta, arbitragem)
//       Delimita exaustivamente o que o LLM pode responder. E a porcao exportada
//       como BNF para o grammar prompting e o mascaramento de logits.
//
// Correspondencia com os outros dois dominios:
//   farmaco/produto   -> infracao   (falta, cartao, mao na bola, impedimento...)
//   protocolo/cultura -> lance      (penalti na area, disputa de bola, VAR...)
//   populacao/area    -> contexto   (acrescimos, disputa de penaltis, sem VAR...)
//   telemetria de leito/sensores -> leitura de partida (minuto, cartoes, distancias)
//
// Referencias de dominio: IFAB Laws of the Game (em especial a Lei 12 — Fouls and
// Misconduct — e a Lei 11 — Offside), o Protocolo VAR do IFAB e o Codigo
// Disciplinar CBF/FIFA.
//
// Regras de forma identica as dos outros dois dominios (TriggerAttr, StepAttr,
// OutcomeAttr, EscalationAttr, AlertStmt, GlobalRule, Quantity, Bool, AlertLevel,
// Operator) sao deliberadamente redeclaradas aqui em vez de importadas: o Langium
// gera um unico ast.ts para o projeto e funde regras homonimas de forma igual
// numa interface so, sem custo. Regras com FORMA diferente (referenciam uma
// entidade que so existe neste dominio) levam o prefixo Fut para nao colidir com
// as equivalentes clinica/agricola — mesmo criterio que ja separa BlockRule de
// AgroBlockRule.
// =============================================================================

entry FutModel:
    (elements+=FutElement)*;

FutElement:
    InfractionDef | SituationDef | ContextDef | FutSafetyRule | FutSchemaDef | DecisionCommand;

// =============================================================================
// 1) ESQUEMA DE CONTROLE — conhecimento regulamentar
// =============================================================================

InfractionDef:
    'infracao' name=ID '{'
        'classe' foulClass=FoulClass
        'lei_ifab' lawRef=STRING
        'var_revisavel' varReviewable=Bool
        (attributes+=InfractionAttribute)*
    '}';

InfractionAttribute:
      SancaoAttr | ReinicioAttr | LimiarAttr | ZonaAttr | MonitorAttr
    | AgravanteAttr | IsencaoAttr | ConfusaoAttr;

// Sancao disciplinar base da infracao, e a que se aplica em caso de reincidencia
// (ex.: segunda advertencia na mesma partida).
SancaoAttr:
    'sancao' card=CardType ('reincidencia' recurrence=CardType)?;

// Reinicios de jogo admissiveis para a infracao (pode variar com o julgamento
// do arbitro em campo, por isso e uma lista, nao um valor unico).
ReinicioAttr:
    'reinicios' '[' restarts+=Restart (',' restarts+=Restart)* ']';

// Limiar estruturado sobre a leitura da partida — nunca prosa: e o grafo, e nao
// o LLM, quem decide se a condicao incide sobre o instante corrente.
LimiarAttr:
    'limiar:' parameter=MatchParameter operator=Operator threshold=Quantity
    '->' action=Decision detail=STRING;

// Zona de campo em que a infracao ocorreu muda a consequencia (ex.: falta na
// propria area penal vira penalti em vez de tiro livre).
ZonaAttr:
    'zona_penal:' zone=FieldZone '->' action=Decision detail=STRING;

MonitorAttr:
    'monitorar:' target=STRING 'a_cada' interval=Quantity ('alvo' goal=STRING)?;

// Agravante: combinacao com outra infracao que eleva a gravidade do lance
// (ex.: contato de goleiro que nega gol claro soma-se a jogo violento).
AgravanteAttr:
    'agravante:' other=[InfractionDef:ID] 'gravidade' severity=Severity
    '(' mechanism=STRING ')' ('conduta' conduct=STRING)?;

// Isencao: condicao em que a infracao declarada NAO se configura.
IsencaoAttr:
    'isento:' condition=STRING ('excecao' exception=STRING)?;

// Confusao comum entre chamadas (analogo ao LASA farmaceutico): pares de
// infracoes que a arbitragem confunde com frequencia.
ConfusaoAttr:
    'confusao_comum:' confusable=STRING ('mitigacao' mitigation=STRING)?;

// -----------------------------------------------------------------------------

SituationDef:
    'lance' name=ID '{'
        'lei_ifab' lawRef=STRING
        (attributes+=LanceAttribute)*
    '}';

LanceAttribute:
    TriggerAttr | StepAttr | FutRecommendAttr | FutForbidAttr | EscalationAttr | OutcomeAttr;

// A condicao e ESTRUTURADA: e o grafo, e nao o LLM, quem decide se o gatilho
// incide sobre a leitura corrente da partida.
TriggerAttr:
    'gatilho:' parameter=MatchParameter operator=Operator value=Quantity
    '->' action=STRING;

StepAttr:
    'etapa' order=NUMBER description=STRING ('prazo' deadline=Quantity)?;

FutRecommendAttr:
    'recomenda' infraction=[InfractionDef:ID] ('indicacao' indication=STRING)?;

FutForbidAttr:
    'veta' infraction=[InfractionDef:ID] 'motivo' reason=STRING;

EscalationAttr:
    'escalonar:' parameter=MatchParameter operator=Operator value=Quantity
    '->' target=EscalationTarget detail=STRING;

OutcomeAttr:
    'desfecho:' description=STRING ('reavaliar_em' reassess=Quantity)?;

// -----------------------------------------------------------------------------

ContextDef:
    'contexto' name=ID '{'
        'criterio' criterion=STRING
        (restrictions+=ContextRestriction)*
    '}';

ContextRestriction:
    ContextForbid | ContextAdjust | ContextRequire;

ContextForbid:
    'proibe' infraction=[InfractionDef:ID] 'motivo' reason=STRING;

ContextAdjust:
    'ajusta' infraction=[InfractionDef:ID] 'fator' factor=NUMBER ('motivo' reason=STRING)?;

ContextRequire:
    'exige' requirement=STRING;

// -----------------------------------------------------------------------------
// Invariantes de seguranca: arestas transversais do Grafo de Conhecimento.
// -----------------------------------------------------------------------------

FutSafetyRule:
    FutBlockRule | GlobalRule;

// Espelha regra_seguranca dos outros dois dominios: bloqueia uma decisao sobre
// uma infracao quando a leitura da partida cruza o limiar. Condicao estruturada.
FutBlockRule:
    'regra_seguranca:' 'bloquear_decisao' infraction=[InfractionDef:ID]
    'se' parameter=MatchParameter operator=Operator threshold=Quantity
    '(' reason=STRING ')';

// Forma identica a dos outros dois dominios: compartilhar o tipo aqui e inofensivo.
GlobalRule:
    'regra_global:' description=STRING
    ('severidade' severity=Severity)? ('referencia' reference=STRING)?;

// =============================================================================
// 2) ESQUEMA DE DADOS — universo fechado de respostas permitidas ao LLM
//    Esta secao e a que vira BNF para a decodificacao restrita.
// =============================================================================

FutSchemaDef:
    'esquema_dados' name=ID '{'
        'decisoes' '[' decisions+=Decision (',' decisions+=Decision)* ']'
        'reinicios' '[' restarts+=Restart (',' restarts+=Restart)* ']'
        'alertas' '[' alerts+=AlertLevel (',' alerts+=AlertLevel)* ']'
        (conducts+=FutConductDef)*
    '}';

FutConductDef:
    'conduta' name=ID '{'
        'decisao' decision=Decision
        ('reinicio' restart=Restart)?
        ('requer_var' requiresVar=Bool)?
        ('justificativa_obrigatoria' requiresJustification=Bool)?
        ('protocolo_ifab' protocol=STRING)?
    '}';

// -----------------------------------------------------------------------------
// A producao que a decodificacao restrita preenche. Analoga a PlanCommand e a
// MissionCommand.
// -----------------------------------------------------------------------------

DecisionCommand:
    'arbitragem' name=ID 'para' situation=[SituationDef:ID] '{'
        'esquema_referencia' schema=[FutSchemaDef:ID]
        'partida' match=STRING
        'sequencia' '[' sequence+=[FutConductDef:ID] (',' sequence+=[FutConductDef:ID])* ']'
        (markings+=MarkingStmt)*
        (alerts+=AlertStmt)*
        'auditoria' audit=STRING
    '}';

MarkingStmt:
    'marcacao' infraction=[InfractionDef:ID] 'decisao' decision=Decision 'minuto' minute=Quantity
    'reinicio' restart=Restart ('justificativa' justification=STRING)?;

AlertStmt:
    'alerta' level=AlertLevel message=STRING ('regra' rule=STRING)?;

// =============================================================================
// 3) VOCABULARIOS FECHADOS E LEXICO
// =============================================================================

Quantity:
    value=NUMBER unit=Unit;

Bool returns string:
    'sim' | 'nao';

FoulClass returns string:
      'falta_pessoal' | 'jogo_violento' | 'mao_na_bola' | 'simulacao' | 'dissenso'
    | 'perda_tempo' | 'impedimento' | 'dogso' | 'conduta_antidesportiva'
    | 'falta_tecnica' | 'invasao_campo';

CardType returns string:
    'NENHUM' | 'ADVERTENCIA_VERBAL' | 'CARTAO_AMARELO' | 'CARTAO_VERMELHO';

Restart returns string:
      'BOLA_AO_CHAO' | 'TIRO_LIVRE_DIRETO' | 'TIRO_LIVRE_INDIRETO' | 'PENALTI'
    | 'ESCANTEIO' | 'TIRO_DE_META' | 'ARREMESSO_LATERAL' | 'SEM_PARALISACAO';

Decision returns string:
      'ADVERTENCIA_VERBAL' | 'CARTAO_AMARELO' | 'CARTAO_VERMELHO' | 'PENALTI'
    | 'TIRO_LIVRE_DIRETO' | 'TIRO_LIVRE_INDIRETO' | 'MANTER_JOGO' | 'PARALISAR_JOGO'
    | 'ACIONAR_VAR' | 'ANULAR_GOL' | 'CONFIRMAR_GOL' | 'EXPULSAR' | 'BLOQUEAR_DECISAO';

AlertLevel returns string:
    'INFORMATIVO' | 'ATENCAO' | 'CRITICO' | 'BLOQUEANTE';

Severity returns string:
    'leve' | 'moderada' | 'alta' | 'expulsao';

EscalationTarget returns string:
      'ARBITRO_ASSISTENTE' | 'VAR' | 'QUARTO_ARBITRO' | 'COMISSAO_DISCIPLINAR'
    | 'ARBITRO_PRINCIPAL';

FieldZone returns string:
    'AREA_PROPRIA' | 'AREA_ADVERSARIA' | 'MEIO_CAMPO' | 'ULTIMO_TERCO';

// Leitura da partida: o analogo futebolistico da telemetria de leito/sensores.
MatchParameter returns string:
      'minuto_partida' | 'acrescimo' | 'cartoes_amarelos_jogador' | 'distancia_ultimo_defensor'
    | 'velocidade_bola' | 'distancia_gol' | 'jogadores_entre_bola_e_gol' | 'tempo_revisao_var'
    | 'placar_diferenca' | 'faltas_acumuladas_time' | 'distancia_bola';

Operator returns string:
    '>=' | '<=' | '==' | '!=' | '>' | '<';

Unit returns string:
      'min' | 's' | 'm' | 'km/h' | 'cartoes' | 'gols' | 'faltas' | 'jogadores'
    | 'toques' | 'partida' | 'pontos' | '%';

terminal ID: /[_a-zA-Z][\w_]*/;
terminal STRING: /"[^"]*"|'[^']*'/;
terminal NUMBER returns number: /-?[0-9]+(\.[0-9]+)?/;

hidden terminal WS: /\s+/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
