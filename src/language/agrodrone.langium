grammar AgroDrone

// Ponto de entrada unificado do modelo hibrido
entry AgroModel:
    (elements+=Element)*;

Element:
    CropDef | GlobalRule | DataSchemaDef | MissionCommand;

// =========================================================================
// 1) ESQUEMA DE CONTROLE (Regras de Dominio Agronomico)
//    Alimenta o Grafo de Conhecimento (Neo4j).
// =========================================================================

CropDef:
    'cultura' name=ID '{'
        (chemicals+=ChemicalDef)*
        (rules+=RuleDef)*
    '}';

ChemicalDef:
    type=('herbicida' | 'fungicida' | 'inseticida' | 'defensivo') name=ID
    '-' dosage=STRING '-' timing=STRING;

RuleDef:
    MixingRule | BanRule | WeatherRule | SweepRule | InformRule;

MixingRule:
    'regra:' 'nao_misturar' chem1=[ChemicalDef:ID] '+' chem2=STRING
    ('(' reason=STRING ')')?;

BanRule:
    'regra:' 'proibido' condition=STRING;

WeatherRule:
    'regra_clima:' conditions=STRING;

SweepRule:
    'regra_varredura:' sensor=STRING operator=Operator value=FLOAT '->'
    (actionRef=[ActionCommand:ID] | actionLabel=STRING);

InformRule:
    'informar:' items=STRING;

GlobalRule:
    'regra_global:' description=STRING;

// =========================================================================
// 2) ESQUEMA DE DADOS E ATUACAO (Estados Fisicos e Comandos Mecanicos)
//    Delimita exaustivamente o espaco de saida do LLM (decodificacao restrita).
// =========================================================================

DataSchemaDef:
    'esquema_dados' name=ID '{'
        'estados_permitidos' '[' allowedStates+=DroneState (',' allowedStates+=DroneState)* ']'
        'acoes_atuador' '[' actuatorActions+=ActuatorAction (',' actuatorActions+=ActuatorAction)* ']'
        (commands+=ActionCommand)*
    '}';

// Estados de movimentacao fisica do hardware
DroneState returns string:
    'AVANCAR' | 'PARAR' | 'RETORNAR_BASE' | 'MUDAR_TALHAO' | 'MUDAR_SENTIDO';

// Comandos do sistema de pulverizacao e bombas
ActuatorAction returns string:
    'BOMBA_LIGAR' | 'BOMBA_DESLIGAR' | 'BATER_VENENO' | 'AJUSTAR_VAZAO';

// Comando atomico que vincula um movimento a uma acao de atuador
ActionCommand:
    'acao' name=ID '{'
        'movimento' motion=DroneState
        'atuador' actuator=ActuatorAction
        ('parametro' param=STRING)?
    '}';

// =========================================================================
// 3) EXECUCAO DA MISSAO (Vinculo entre os Esquemas)
//    E a producao que o LLM deve preencher sob decodificacao restrita.
// =========================================================================

MissionCommand:
    'comando' 'executar' missionName=ID 'para' crops+=[CropDef:ID] (',' crops+=[CropDef:ID])* '{'
        'esquema_referencia' schema=[DataSchemaDef:ID]
        'sequencia_atuacao' '[' sequence+=[ActionCommand:ID] (',' sequence+=[ActionCommand:ID])* ']'
    '}';

// Operadores matematicos e regras lexicas
Operator returns string:
    '>=' | '<=' | '==' | '>' | '<';

terminal ID: /[_a-zA-Z][\w_]*/;
terminal STRING: /"[^"]*"|'[^']*'/;
terminal FLOAT returns number: /[0-9]+(\.[0-9]+)?/;

hidden terminal WS: /\s+/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
