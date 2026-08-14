grammar Dsl

entry MedicalModel:
    (elements += Element)*;

Element:
    DrugDef | SafetyRule;

// === ESQUEMA DE CONTROLE (Vai para o Neo4j) ===
DrugDef:
    'farmaco' name=ID '{'
        'tipo' type=STRING
        'dose_maxima' maxDose=FLOAT maxDoseUnit=STRING
        'incremento_seguro' safeStep=FLOAT safeStepUnit=STRING
    '}';

SafetyRule:
    'regra_seguranca:' 'bloquear_incremento' drug=[DrugDef:ID] 'se' condition=STRING '(' reason=STRING ')';

// === ESQUEMA DE DADOS (Não gera AST direta, mas dita o modelo do EBNF) ===
// Acoes: AUMENTAR_VAZAO | REDUZIR_VAZAO | MANTER_BLOQUEADO | INICIAR_INFUSAO
// Vias: ACESSO_CENTRAL | ACESSO_PERIFERICO

terminal ID: /[_a-zA-Z][\w_]*/;
terminal STRING: /"[^"]*"|'[^']*'/;
terminal FLOAT returns number: /[0-9]+(\.[0-9]+)?/;
hidden terminal WS: /\s+/;