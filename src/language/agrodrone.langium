grammar AgroDrone

// =============================================================================
// DSL agricola do SPC-CML — dominio: pulverizacao aerea por drone.
//
// Segundo dominio da arquitetura, com a MESMA particao em dois esquemas da DSL
// clinica (src/language/dsl.langium). O paralelo e proposital: se a arquitetura
// so funcionasse na UTI, ela seria um estudo de caso, nao um metodo.
//
//   ESQUEMA DE CONTROLE  (produto, cultura, area, regra_*)
//       Modela o que existe e o que e verdade no dominio agronomico. Alimenta o
//       Grafo de Conhecimento e e a fonte factual da recuperacao.
//
//   ESQUEMA DE DADOS     (esquema_dados, conduta, missao)
//       Delimita exaustivamente o que o LLM pode responder. E a porcao exportada
//       como BNF para o grammar prompting e o mascaramento de logits.
//
// Correspondencia com o dominio clinico:
//   farmaco   -> produto      (defensivo agricola)
//   protocolo -> cultura      (soja, milho, cana)
//   populacao -> area         (APP, proximidade de manancial, area sensivel)
//   telemetria de leito -> telemetria de sensores (vento, NDVI, umidade)
//
// Referencias de dominio: bulas MAPA/AGROFIT, NR-31, classificacao toxicologica
// ANVISA, boas praticas de aplicacao aerea (deriva, tamanho de gota, janela
// climatica) e indices de sensoriamento remoto (NDVI).
// =============================================================================

entry AgroModel:
    (elements+=AgroElement)*;

// Os nomes de regra levam o prefixo Agro sempre que a DSL clinica declara uma
// regra homonima com FORMA diferente (BlockRule cita farmaco, AgroBlockRule cita
// produto). O Langium gera um unico ast.ts para o projeto e funde homonimos numa
// interface de propriedades opcionais — o que tornaria `element.drug` possivelmente
// indefinido no dominio clinico e quebraria codigo que ja funciona. Regras de
// forma identica (TriggerAttr, Quantity, AlertStmt) seguem compartilhadas.
AgroElement:
    ProductDef | CultureDef | AreaDef | AgroSafetyRule | AgroSchemaDef | MissionCommand;

// =============================================================================
// 1) ESQUEMA DE CONTROLE — conhecimento agronomico
// =============================================================================

ProductDef:
    'produto' name=ID '{'
        'classe' productClass=ProductClass
        'registro_mapa' mapa=STRING
        'toxicologica' toxicity=ToxClass
        (attributes+=ProductAttribute)*
    '}';

ProductAttribute:
      DoseAttr | TargetAttr | CarencyAttr | DriftAttr | IncompatAttr | BanConditionAttr;

// Dose de bula: faixa registrada no MAPA para a cultura alvo.
DoseAttr:
    'dose' kind=DoseKind value=Quantity;

// Alvo biologico (praga, doenca, planta daninha) e modo de aplicacao.
TargetAttr:
    'alvo:' target=STRING ('estadio' stage=STRING)?;

// Carencia: intervalo minimo entre aplicacao e colheita.
CarencyAttr:
    'carencia' period=Quantity ('reentrada' reentry=Quantity)?;

// Potencial de deriva: define a janela climatica segura do produto.
DriftAttr:
    'deriva' risk=Severity ('gota_minima' droplet=Quantity)?;

// Incompatibilidade de calda: mistura em tanque que nao pode ocorrer.
IncompatAttr:
    'incompativel:' other=[ProductDef:ID] 'gravidade' severity=Severity
    '(' mechanism=STRING ')' ('conduta' conduct=STRING)?;

// Proibicao condicionada a um contexto textual (ex.: cultura sensivel proxima).
BanConditionAttr:
    'proibido:' condition=STRING ('excecao' exception=STRING)?;

// -----------------------------------------------------------------------------

CultureDef:
    'cultura' name=ID '{'
        'ciclo' cycle=STRING
        (attributes+=CultureAttribute)*
    '}';

CultureAttribute:
    TriggerAttr | AgroRecommendAttr | AgroForbidAttr | EscalationAttr | WindowAttr;

// A condicao e ESTRUTURADA: e o grafo, e nao o LLM, quem decide se o gatilho
// incide sobre a leitura corrente dos sensores.
TriggerAttr:
    'gatilho:' parameter=SensorParameter operator=Operator value=Quantity
    '->' action=STRING;

AgroRecommendAttr:
    'recomenda' product=[ProductDef:ID] ('indicacao' indication=STRING)?;

AgroForbidAttr:
    'veta' product=[ProductDef:ID] 'motivo' reason=STRING;

EscalationAttr:
    'escalonar:' parameter=SensorParameter operator=Operator value=Quantity
    '->' target=EscalationTarget detail=STRING;

// Janela operacional recomendada para a cultura.
WindowAttr:
    'janela:' description=STRING ('umidade_minima' minHumidity=Quantity)?;

// -----------------------------------------------------------------------------

AreaDef:
    'area' name=ID '{'
        'criterio' criterion=STRING
        (restrictions+=AreaRestriction)*
    '}';

AreaRestriction:
    AreaForbid | AreaAdjust | AreaRequire;

AreaForbid:
    'proibe' product=[ProductDef:ID] 'motivo' reason=STRING;

// Fator de ajuste de vazao (ex.: 0.5 em faixa de amortecimento).
AreaAdjust:
    'ajusta' product=[ProductDef:ID] 'fator' factor=NUMBER ('motivo' reason=STRING)?;

AreaRequire:
    'exige' requirement=STRING;

// -----------------------------------------------------------------------------
// Invariantes de seguranca: arestas transversais do Grafo de Conhecimento.
// -----------------------------------------------------------------------------

AgroSafetyRule:
    AgroBlockRule | GlobalRule;

// Espelha regra_seguranca da DSL clinica: bloqueia a aplicacao de um produto
// quando a leitura de sensor cruza o limiar. Condicao estruturada, nao prosa.
AgroBlockRule:
    'regra_seguranca:' 'bloquear_aplicacao' product=[ProductDef:ID]
    'se' parameter=SensorParameter operator=Operator threshold=Quantity
    '(' reason=STRING ')';

// Forma identica a da DSL clinica: compartilhar o tipo aqui e inofensivo.
GlobalRule:
    'regra_global:' description=STRING
    ('severidade' severity=Severity)? ('referencia' reference=STRING)?;

// =============================================================================
// 2) ESQUEMA DE DADOS — universo fechado de respostas permitidas ao LLM
//    Esta secao e a que vira BNF para a decodificacao restrita.
// =============================================================================

AgroSchemaDef:
    'esquema_dados' name=ID '{'
        'decisoes' '[' decisions+=Decision (',' decisions+=Decision)* ']'
        'modos' '[' modes+=SprayMode (',' modes+=SprayMode)* ']'
        'alertas' '[' alerts+=AlertLevel (',' alerts+=AlertLevel)* ']'
        (conducts+=AgroConductDef)*
    '}';

AgroConductDef:
    'conduta' name=ID '{'
        'decisao' decision=Decision
        ('modo' mode=SprayMode)?
        ('requer_dupla_checagem' doubleCheck=Bool)?
        ('justificativa_obrigatoria' requiresJustification=Bool)?
    '}';

// -----------------------------------------------------------------------------
// A producao que a decodificacao restrita preenche. Analoga a PlanCommand.
// -----------------------------------------------------------------------------

MissionCommand:
    'missao' name=ID 'para' culture=[CultureDef:ID] '{'
        'esquema_referencia' schema=[AgroSchemaDef:ID]
        'talhao' plot=STRING
        'sequencia' '[' sequence+=[AgroConductDef:ID] (',' sequence+=[AgroConductDef:ID])* ']'
        (applications+=ApplicationStmt)*
        (alerts+=AlertStmt)*
        'auditoria' audit=STRING
    '}';

ApplicationStmt:
    'aplicacao' product=[ProductDef:ID] 'decisao' decision=Decision 'vazao' rate=Quantity
    'modo' mode=SprayMode ('justificativa' justification=STRING)?;

AlertStmt:
    'alerta' level=AlertLevel message=STRING ('regra' rule=STRING)?;

// =============================================================================
// 3) VOCABULARIOS FECHADOS E LEXICO
// =============================================================================

Quantity:
    value=NUMBER unit=Unit;

Bool returns string:
    'sim' | 'nao';

ProductClass returns string:
      'herbicida' | 'fungicida' | 'inseticida' | 'acaricida' | 'adjuvante'
    | 'fertilizante_foliar' | 'biologico';

ToxClass returns string:
    'I' | 'II' | 'III' | 'IV';

SprayMode returns string:
    'BARRA_TOTAL' | 'FAIXA_DIRIGIDA' | 'PONTO_LOCALIZADO' | 'BAIXO_VOLUME';

Decision returns string:
      'INICIAR_APLICACAO' | 'AUMENTAR_VAZAO' | 'REDUZIR_VAZAO' | 'MANTER_VAZAO'
    | 'MANTER_BLOQUEADO' | 'SUSPENDER' | 'SUBSTITUIR' | 'AGUARDAR_JANELA'
    | 'SOLICITAR_VARREDURA' | 'ACIONAR_AGRONOMO' | 'BLOQUEAR_APLICACAO';

AlertLevel returns string:
    'INFORMATIVO' | 'ATENCAO' | 'CRITICO' | 'BLOQUEANTE';

Severity returns string:
    'leve' | 'moderada' | 'alta' | 'proibida';

EscalationTarget returns string:
      'AGRONOMO_RESPONSAVEL' | 'OPERADOR_DRONE' | 'CENTRO_METEOROLOGICO'
    | 'ORGAO_AMBIENTAL';

DoseKind returns string:
    'minima' | 'maxima' | 'recomendada';

// Telemetria dos sensores: o analogo agricola da telemetria de leito.
SensorParameter returns string:
      'vento' | 'temperatura' | 'umidade' | 'NDVI' | 'umidade_foliar'
    | 'temperatura_foliar' | 'distancia_manancial' | 'distancia_cultura_sensivel'
    | 'chuva_prevista' | 'altura_voo' | 'infestacao' | 'hora';

Operator returns string:
    '>=' | '<=' | '==' | '!=' | '>' | '<';

Unit returns string:
      'L/ha' | 'kg/ha' | 'mL/ha' | 'g/ha' | 'L' | 'kg' | 'km/h' | 'C' | '%'
    | 'm' | 'km' | 'mm' | 'h' | 'min' | 'dias' | 'indice' | 'micra';

terminal ID: /[_a-zA-Z][\w_]*/;
terminal STRING: /"[^"]*"|'[^']*'/;
terminal NUMBER returns number: /-?[0-9]+(\.[0-9]+)?/;

hidden terminal WS: /\s+/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
