grammar DroneSolarInspection

// Ponto de entrada da nossa linguagem
entry MissionControl:
    (definitions+=Definition | rules+=Rule)*;

// --- 1. DEFINIÇÕES GERAIS ---
Definition:
    DroneDef | FarmDef | ScanCommand;

// Define um drone e seu limite de energia
DroneDef:
    'drone' name=ID 'energy_limit' battery=INT '%';

// Cadastra as fazendas
FarmDef:
    'farm' name=ID;

// O Input do usuário para iniciar a varredura
ScanCommand:
    'command' 'scan' farms+=[FarmDef:ID] (',' farms+=[FarmDef:ID])* 'using' drone=[DroneDef:ID];

// --- 2. REGRAS DE SENSORES E DECISÕES ---
Rule:
    'on_sensor_input' event=Event 'do' action=Action;

// Tipos de eventos que o sensor ótico pode captar
Event:
    DirtEvent | WeatherEvent | SmokeEvent;

DirtEvent:
    'dirt_level' operator=Operator level=INT '%';

WeatherEvent:
    'weather' condition=('storm' | 'clouds');

SmokeEvent:
    'smoke_detected' type=('fire' | 'fog');

// Operadores matemáticos para as regras
Operator returns string:
    '>' | '<' | '>=' | '<=' | '==';

// Ações que o drone pode tomar
Action:
    SimpleAction | MessageAction;

SimpleAction:
    command=('clean_panels' | 'return_to_base' | 'ignore_and_continue');

// Ação complexa para envio de mensagem 5G
MessageAction:
    'send_5G_alert' 'to_current_farm' 'urgency_high' (includePhoto?='with_photo')?;


// --- 3. REGRAS DE TERMINAIS (Lexer) ---
hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w_]*/;
terminal INT returns number: /[0-9]+/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;