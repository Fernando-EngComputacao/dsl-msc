grammar AdvancedICU

// O LLM precisará preencher um plano de infusão completo
entry InfusionPlan:
    'plano_infusao' '{'
        (actions += DrugAction)+
        'justificativa_clinica' justification=STRING
    '}';

DrugAction:
    'farmaco' drug=DrugType 'acao' action=ActionType 'dose_alvo' targetDose=FLOAT unit=UnitType;

enum DrugType:
    NORADRENALINA = 'Noradrenalina' |
    VASOPRESSINA = 'Vasopressina' |
    PROPOFOL = 'Propofol' |
    FENTANIL = 'Fentanil';

enum ActionType:
    AUMENTAR = 'AUMENTAR' |
    REDUZIR = 'REDUZIR' |
    MANTER = 'MANTER_BLOQUEADO' |
    INICIAR = 'INICIAR_INFUSAO';

enum UnitType:
    MCG_KG_MIN = 'mcg/kg/min' |
    U_MIN = 'U/min' |
    MG_KG_H = 'mg/kg/h';

terminal FLOAT returns number: /[0-9]+(\.[0-9]{1,2})?/;
terminal STRING: /"[^"]*"/;