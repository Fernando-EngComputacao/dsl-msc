grammar Dsl

// =============================================================================
// DSL clinica do SPC-CML — dominio: terapia intensiva / seguranca medicamentosa.
//
// A linguagem e particionada nos dois esquemas da arquitetura CML (Figura 5.1):
//
//   ESQUEMA DE CONTROLE  (farmaco, protocolo, populacao, regra_*)
//       Modela o que existe e o que e verdade no dominio. Alimenta o Grafo de
//       Conhecimento (Neo4j) e e a fonte factual (ground truth) da recuperacao.
//
//   ESQUEMA DE DADOS     (esquema_dados, conduta, plano)
//       Delimita exaustivamente o que o LLM tem permissao de responder. E a
//       porcao da gramatica exportada como BNF para o grammar prompting e para
//       a decodificacao restrita (mascaramento de logits).
//
// Referencias de dominio adotadas na modelagem: ISMP high-alert medications,
// DERS (Dose Error Reduction Software) de bombas inteligentes, Surviving Sepsis
// Campaign, escalas RASS/SOFA/qSOFA, codificacao RxNorm/ATC/SNOMED-CT/CID-10 e
// mapeamento de saida para recursos FHIR R4.
// =============================================================================

entry MedicalModel:
    (elements+=Element)*;

Element:
    DrugDef | ProtocolDef | PopulationDef | SafetyRule | DataSchemaDef | PlanCommand;

// =============================================================================
// 1) ESQUEMA DE CONTROLE — conhecimento farmacologico e clinico
// =============================================================================

DrugDef:
    'farmaco' name=ID '{'
        'classe' drugClass=DrugClass
        'rxnorm' rxnorm=STRING
        'atc' atc=STRING
        'alto_risco' highAlert=Bool
        (attributes+=DrugAttribute)*
    '}';

DrugAttribute:
      DilutionAttr | RouteAttr | DoseLimitAttr | TitrationAttr | PumpLimitAttr
    | RenalAdjustAttr | HepaticAdjustAttr | MonitorAttr | InteractionAttr
    | ContraindicationAttr | LasaAttr;

// Padronizacao de diluicao: erro classico de concentracao em bomba de infusao.
DilutionAttr:
    'diluicao' standard=STRING ('concentracao' concentration=Quantity)?;

RouteAttr:
    'vias' '[' routes+=Route (',' routes+=Route)* ']';

DoseLimitAttr:
    'dose' kind=DoseKind value=Quantity;

// Titulacao: incremento seguro por intervalo, com alvo terapeutico.
TitrationAttr:
    'titulacao' step=Quantity 'a_cada' interval=Quantity ('alvo' target=STRING)?;

// Limites DERS da bomba inteligente: soft limit (alerta) e hard limit (bloqueio).
PumpLimitAttr:
    'bomba' '{'
        'limite_leve' soft=Quantity
        'limite_rigido' hard=Quantity
        ('reservatorio' reservoir=STRING)?
    '}';

RenalAdjustAttr:
    'ajuste_renal:' parameter=ClinicalParameter operator=Operator threshold=Quantity
    '->' action=AdjustAction detail=STRING;

HepaticAdjustAttr:
    'ajuste_hepatico:' criterion=STRING '->' action=AdjustAction detail=STRING;

MonitorAttr:
    'monitorar:' target=STRING 'a_cada' interval=Quantity ('alvo' goal=STRING)?;

InteractionAttr:
    'interacao:' other=[DrugDef:ID] 'gravidade' severity=Severity
    '(' mechanism=STRING ')' ('conduta' conduct=STRING)?;

ContraindicationAttr:
    'contraindicado:' condition=STRING ('excecao' exception=STRING)?;

// LASA: look-alike / sound-alike — par de nomes confundiveis.
LasaAttr:
    'lasa:' confusable=STRING ('mitigacao' mitigation=STRING)?;

// -----------------------------------------------------------------------------

ProtocolDef:
    'protocolo' name=ID '{'
        'cid' icd=STRING
        (attributes+=ProtocolAttribute)*
    '}';

ProtocolAttribute:
      SnomedAttr | TriggerAttr | StepAttr | RecommendAttr | ForbidAttr
    | EscalationAttr | WeaningAttr | OutcomeAttr;

SnomedAttr:
    'snomed' code=STRING;

TriggerAttr:
    'gatilho:' parameter=ClinicalParameter operator=Operator value=Quantity
    '->' action=STRING;

StepAttr:
    'etapa' order=NUMBER description=STRING ('prazo' deadline=Quantity)?;

RecommendAttr:
    'recomenda' drug=[DrugDef:ID] ('indicacao' indication=STRING)?;

ForbidAttr:
    'veta' drug=[DrugDef:ID] 'motivo' reason=STRING;

EscalationAttr:
    'escalonar:' parameter=ClinicalParameter operator=Operator value=Quantity
    '->' target=EscalationTarget detail=STRING;

WeaningAttr:
    'desmame:' criterion=STRING 'reduzir' step=Quantity 'a_cada' interval=Quantity;

OutcomeAttr:
    'desfecho:' description=STRING ('reavaliar_em' reassess=Quantity)?;

// -----------------------------------------------------------------------------

PopulationDef:
    'populacao' name=ID '{'
        'criterio' criterion=STRING
        (restrictions+=PopulationRestriction)*
    '}';

PopulationRestriction:
    PopForbid | PopAdjust | PopRequire;

PopForbid:
    'proibe' drug=[DrugDef:ID] 'motivo' reason=STRING;

PopAdjust:
    'ajusta' drug=[DrugDef:ID] 'fator' factor=NUMBER ('motivo' reason=STRING)?;

PopRequire:
    'exige' requirement=STRING;

// -----------------------------------------------------------------------------
// Invariantes de seguranca: arestas transversais do Grafo de Conhecimento.
// -----------------------------------------------------------------------------

SafetyRule:
    BlockRule | GlobalRule;

// A condicao e ESTRUTURADA, e nao texto livre: e o grafo, e nao o LLM, quem
// decide se o bloqueio incide sobre a telemetria corrente. Uma condicao em prosa
// ("PAM < 60") so poderia ser avaliada por inferencia neural — exatamente o que a
// arquitetura se propoe a evitar no ponto onde a seguranca e decidida.
BlockRule:
    'regra_seguranca:' 'bloquear_incremento' drug=[DrugDef:ID]
    'se' parameter=ClinicalParameter operator=Operator threshold=Quantity
    '(' reason=STRING ')';

GlobalRule:
    'regra_global:' description=STRING
    ('severidade' severity=Severity)? ('referencia' reference=STRING)?;

// =============================================================================
// 2) ESQUEMA DE DADOS — universo fechado de respostas permitidas ao LLM
//    Esta secao e a que vira BNF para o grammar prompting.
// =============================================================================

DataSchemaDef:
    'esquema_dados' name=ID '{'
        'decisoes' '[' decisions+=Decision (',' decisions+=Decision)* ']'
        'vias' '[' routes+=Route (',' routes+=Route)* ']'
        'alertas' '[' alerts+=AlertLevel (',' alerts+=AlertLevel)* ']'
        (conducts+=ConductDef)*
    '}';

ConductDef:
    'conduta' name=ID '{'
        'decisao' decision=Decision
        ('via' route=Route)?
        ('requer_dupla_checagem' doubleCheck=Bool)?
        ('justificativa_obrigatoria' requiresJustification=Bool)?
        ('recurso_fhir' fhir=STRING)?
    '}';

// -----------------------------------------------------------------------------
// A producao que a decodificacao restrita preenche. Tudo aqui e referencia
// cruzada ou vocabulario fechado: uma alucinacao e sintaticamente inexprimivel.
// -----------------------------------------------------------------------------

PlanCommand:
    'plano' name=ID 'para' protocol=[ProtocolDef:ID] '{'
        'esquema_referencia' schema=[DataSchemaDef:ID]
        'paciente' patient=STRING
        'sequencia' '[' sequence+=[ConductDef:ID] (',' sequence+=[ConductDef:ID])* ']'
        (orders+=OrderStmt)*
        (alerts+=AlertStmt)*
        'auditoria' audit=STRING
    '}';

OrderStmt:
    'ordem' drug=[DrugDef:ID] 'decisao' decision=Decision 'dose' dose=Quantity
    'via' route=Route ('justificativa' justification=STRING)?;

AlertStmt:
    'alerta' level=AlertLevel message=STRING ('regra' rule=STRING)?;

// =============================================================================
// 3) VOCABULARIOS FECHADOS E LEXICO
// =============================================================================

Quantity:
    value=NUMBER unit=Unit;

Bool returns string:
    'sim' | 'nao';

DrugClass returns string:
      'vasopressor' | 'inotropico' | 'sedativo' | 'analgesico_opioide'
    | 'bloqueador_neuromuscular' | 'antimicrobiano' | 'anticoagulante'
    | 'antiarritmico' | 'insulina' | 'eletrolito' | 'diuretico' | 'corticoide'
    | 'anticonvulsivante' | 'broncodilatador' | 'antidoto';

Route returns string:
      'ACESSO_CENTRAL' | 'ACESSO_PERIFERICO' | 'INTRAOSSEO' | 'IV' | 'IM'
    | 'VO' | 'SNE' | 'SC' | 'INALATORIA' | 'EPIDURAL';

Decision returns string:
      'INICIAR_INFUSAO' | 'AUMENTAR_VAZAO' | 'REDUZIR_VAZAO' | 'MANTER_VAZAO'
    | 'MANTER_BLOQUEADO' | 'SUSPENDER' | 'SUBSTITUIR' | 'AJUSTAR_DOSE'
    | 'SOLICITAR_EXAME' | 'ESCALAR_EQUIPE' | 'BLOQUEAR_ORDEM';

AlertLevel returns string:
    'INFORMATIVO' | 'ATENCAO' | 'CRITICO' | 'BLOQUEANTE';

Severity returns string:
    'leve' | 'moderada' | 'alta' | 'contraindicada';

AdjustAction returns string:
      'reduzir_dose' | 'aumentar_intervalo' | 'suspender' | 'substituir'
    | 'manter' | 'bloquear';

EscalationTarget returns string:
      'TIME_RESPOSTA_RAPIDA' | 'MEDICO_PLANTONISTA' | 'INTENSIVISTA'
    | 'FARMACIA_CLINICA' | 'COMISSAO_INFECCAO';

DoseKind returns string:
    'inicial' | 'maxima' | 'minima' | 'ataque' | 'manutencao';

ClinicalParameter returns string:
      'PAM' | 'PAS' | 'PAD' | 'FC' | 'FR' | 'SpO2' | 'temperatura' | 'lactato'
    | 'TFG' | 'creatinina' | 'potassio' | 'sodio' | 'INR' | 'plaquetas'
    | 'hemoglobina' | 'QTc' | 'glicemia' | 'bilirrubina' | 'PaO2_FiO2'
    | 'RASS' | 'qSOFA' | 'SOFA' | 'Glasgow' | 'debito_urinario' | 'peso' | 'idade';

Operator returns string:
    '>=' | '<=' | '==' | '!=' | '>' | '<';

Unit returns string:
      'mcg/kg/min' | 'mg/kg/h' | 'mcg/kg/h' | 'mg/kg' | 'mcg/kg' | 'UI/kg'
    | 'UI/h' | 'mL/h' | 'mg/h' | 'U/min' | 'mg/dL' | 'g/dL' | 'mmol/L'
    | 'mEq/L' | 'mg/L' | 'ng/mL' | 'mL/min' | '10^3/uL' | 'mcg' | 'mg' | 'g' | 'UI'
    | 'mEq' | 'mmol' | 'mL' | 'L' | 'mmHg' | 'bpm' | 'irpm' | 'ms' | 'C'
    | 'h' | 'min' | 'dias' | 'pontos' | '%';

terminal ID: /[_a-zA-Z][\w_]*/;
terminal STRING: /"[^"]*"|'[^']*'/;
// Aceita sinal negativo: escalas como RASS (-5 a +4) e excesso de bases sao
// negativas por definicao no paciente critico.
terminal NUMBER returns number: /-?[0-9]+(\.[0-9]+)?/;

hidden terminal WS: /\s+/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
