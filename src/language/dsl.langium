grammar AgroDrone

// Ponto de entrada da nossa linguagem agrícola
entry AgroModel:
    (elements+=Element)*;

Element:
    CropDef | GlobalRule | MissionCommand;

// Definição do subgrafo de uma cultura (ex: Soja, Milho)
CropDef:
    'cultura' name=ID '{'
        (chemicals+=ChemicalDef)*
        (rules+=RuleDef)*
    '}';

// Definição de produtos (Herbicida, Fungicida, Inseticida)
ChemicalDef:
    type=('herbicida' | 'fungicida' | 'inseticida') name=ID '-' dosage=STRING '-' timing=STRING;

// Agrupamento de regras
RuleDef:
    MixingRule | BanRule | WeatherRule | SweepRule | InformRule;

// Regras de restrição de mistura (ex: Não misturar Glifosato + Mancozebe)
MixingRule:
    'regra:' 'nao_misturar' chem1=[ChemicalDef:ID] '+' chem2=STRING '(' reason=STRING ')';

// Regras de proibição (ex: Proibido perto de manancial)
BanRule:
    'regra:' 'proibido' condition=STRING;

// Restrições de Clima e Horário
WeatherRule:
    'regra_clima:' conditions=STRING;

// Regras baseadas em sensores de varredura (NDVI, Temperatura Foliar)
SweepRule:
    'regra_varredura:' sensor=STRING operator=Operator value=FLOAT '->' action=STRING;

// O que o drone deve informar ao log/agrônomo
InformRule:
    'informar:' items=STRING;

// Regras Globais do sistema (ex: Limpar tanque)
GlobalRule:
    'regra_global:' description=STRING;

// Comando de execução para o drone
MissionCommand:
    'comando' 'aplicar' crops+=[CropDef:ID] (',' crops+=[CropDef:ID])* 'usando' drone=ID;

// Operadores matemáticos
Operator returns string:
    '>' | '<' | '>=' | '<=' | '==';

// Terminais e Regex
terminal ID: /[_a-zA-Z][\w_]*/;
terminal STRING: /"[^"]*"|'[^']*'/;
terminal FLOAT returns number: /[0-9]+(\.[0-9]+)?/;
hidden terminal WS: /\s+/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;