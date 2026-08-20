// =============================================================================
// Modelo institucional de terapia intensiva — escrito pelo especialista clinico
// (medico intensivista + farmaceutico clinico).
//
// ESQUEMA DE CONTROLE -> sincronizado no Neo4j (ground truth factual).
// ESQUEMA DE DADOS    -> exportado como BNF para a decodificacao restrita.
// =============================================================================

// -----------------------------------------------------------------------------
// VASOPRESSORES E INOTROPICOS
// -----------------------------------------------------------------------------

farmaco Noradrenalina {
    classe vasopressor
    rxnorm "7512"
    atc "C01CA03"
    alto_risco sim

    diluicao "16 mg em 250 mL SG 5% (64 mcg/mL)" concentracao 64 mcg
    vias [ ACESSO_CENTRAL, ACESSO_PERIFERICO, INTRAOSSEO ]

    dose inicial 0.05 mcg/kg/min
    dose maxima 2.0 mcg/kg/min

    titulacao 0.05 mcg/kg/min a_cada 5 min alvo "PAM >= 65 mmHg"

    bomba {
        limite_leve 1.0 mcg/kg/min
        limite_rigido 2.0 mcg/kg/min
        reservatorio "seringa 50 mL exclusiva, linha dedicada"
    }

    monitorar: "PAM invasiva e perfusao periferica" a_cada 5 min alvo "PAM 65-75 mmHg"
    monitorar: "sinais de extravasamento e isquemia de extremidades" a_cada 60 min

    interacao: Adrenalina gravidade alta ("efeito adrenergico aditivo com risco de arritmia") conduta "nao associar sem indicacao de choque refratario documentada"

    contraindicado: "hipovolemia nao corrigida" excecao "ponte hemodinamica ate reposicao volemica"
    lasa: "Adrenalina" mitigacao "etiqueta com letras maiusculas destacadas (tall man lettering)"
}

farmaco Adrenalina {
    classe vasopressor
    rxnorm "3992"
    atc "C01CA24"
    alto_risco sim

    diluicao "6 mg em 100 mL SG 5% (60 mcg/mL)" concentracao 60 mcg
    vias [ ACESSO_CENTRAL, INTRAOSSEO ]

    dose inicial 0.05 mcg/kg/min
    dose maxima 1.0 mcg/kg/min

    titulacao 0.05 mcg/kg/min a_cada 5 min alvo "PAM >= 65 mmHg"

    bomba {
        limite_leve 0.5 mcg/kg/min
        limite_rigido 1.0 mcg/kg/min
    }

    monitorar: "lactato serico (efeito beta-adrenergico eleva lactato)" a_cada 2 h
    contraindicado: "taquiarritmia ventricular sustentada"
    lasa: "Noradrenalina" mitigacao "armazenamento em prateleiras separadas"
}

farmaco Vasopressina {
    classe vasopressor
    rxnorm "11149"
    atc "H01BA01"
    alto_risco sim

    diluicao "20 U em 100 mL SF 0.9% (0.2 U/mL)"
    vias [ ACESSO_CENTRAL ]

    dose inicial 0.01 U/min
    dose maxima 0.04 U/min

    titulacao 0.01 U/min a_cada 30 min alvo "reducao da dose de noradrenalina"

    bomba {
        limite_leve 0.03 U/min
        limite_rigido 0.04 U/min
        reservatorio "dose fixa, nao titular acima do limite rigido"
    }

    monitorar: "perfusao de extremidades e debito urinario" a_cada 60 min
    contraindicado: "isquemia mesenterica ou digital em curso"
}

farmaco Dobutamina {
    classe inotropico
    rxnorm "3616"
    atc "C01CA07"
    alto_risco sim

    diluicao "250 mg em 250 mL SG 5% (1 mg/mL)" concentracao 1 mg
    vias [ ACESSO_CENTRAL, ACESSO_PERIFERICO ]

    dose inicial 2.5 mcg/kg/min
    dose maxima 20.0 mcg/kg/min

    titulacao 2.5 mcg/kg/min a_cada 15 min alvo "indice cardiaco > 2.2"

    bomba {
        limite_leve 15.0 mcg/kg/min
        limite_rigido 20.0 mcg/kg/min
    }

    monitorar: "FC e ectopia ventricular" a_cada 15 min alvo "FC < 110 bpm"
    contraindicado: "cardiomiopatia hipertrofica obstrutiva"
}

// -----------------------------------------------------------------------------
// SEDACAO E ANALGESIA
// -----------------------------------------------------------------------------

farmaco Propofol {
    classe sedativo
    rxnorm "8782"
    atc "N01AX10"
    alto_risco sim

    diluicao "emulsao lipidica 10 mg/mL, frasco integro por ate 12 h"
    vias [ ACESSO_CENTRAL, ACESSO_PERIFERICO ]

    dose inicial 0.5 mg/kg/h
    dose maxima 4.0 mg/kg/h

    titulacao 0.5 mg/kg/h a_cada 15 min alvo "RASS -2 a 0"

    bomba {
        limite_leve 3.0 mg/kg/h
        limite_rigido 4.0 mg/kg/h
        reservatorio "trocar equipo a cada 12 h — risco de contaminacao da emulsao"
    }

    ajuste_hepatico: "Child-Pugh C" -> reduzir_dose "reduzir 30% e reavaliar RASS a cada 2 h"

    monitorar: "triglicerideos e creatinofosfoquinase" a_cada 24 h alvo "sindrome de infusao do propofol"
    monitorar: "RASS e PAM" a_cada 15 min alvo "RASS -2 a 0 sem hipotensao"

    interacao: Midazolam gravidade moderada ("depressao respiratoria e hipotensao aditivas") conduta "evitar sobreposicao; se necessario, reduzir ambas as doses em 50%"

    contraindicado: "hipotensao refrataria com PAM < 60 mmHg"
    contraindicado: "alergia a ovo ou soja" excecao "formulacoes sem lipidios validadas pela farmacia"
}

farmaco Midazolam {
    classe sedativo
    rxnorm "6960"
    atc "N05CD08"
    alto_risco sim

    diluicao "50 mg em 100 mL SF 0.9% (0.5 mg/mL)" concentracao 0.5 mg
    vias [ ACESSO_CENTRAL, ACESSO_PERIFERICO ]

    dose inicial 0.02 mg/kg/h
    dose maxima 0.2 mg/kg/h

    titulacao 0.02 mg/kg/h a_cada 30 min alvo "RASS -2 a 0"

    ajuste_renal: TFG < 30 mL/min -> reduzir_dose "acumulo do metabolito alfa-hidroximidazolam"
    ajuste_hepatico: "Child-Pugh B ou C" -> aumentar_intervalo "meia-vida prolongada"

    monitorar: "delirium pelo CAM-ICU" a_cada 12 h
    contraindicado: "delirium hiperativo estabelecido"
}

farmaco Fentanil {
    classe analgesico_opioide
    rxnorm "4337"
    atc "N01AH01"
    alto_risco sim

    diluicao "1000 mcg em 100 mL SF 0.9% (10 mcg/mL)" concentracao 10 mcg
    vias [ ACESSO_CENTRAL, ACESSO_PERIFERICO, EPIDURAL ]

    dose inicial 0.5 mcg/kg/h
    dose maxima 3.0 mcg/kg/h

    titulacao 0.25 mcg/kg/h a_cada 30 min alvo "BPS <= 5"

    bomba {
        limite_leve 2.0 mcg/kg/h
        limite_rigido 3.0 mcg/kg/h
        reservatorio "controle especial — dupla checagem e registro de saldo"
    }

    ajuste_renal: TFG < 30 mL/min -> reduzir_dose "reduzir 25% por acumulo de metabolitos"

    monitorar: "escala de dor BPS e frequencia respiratoria" a_cada 60 min
    interacao: Midazolam gravidade alta ("sinergismo depressor respiratorio") conduta "reduzir ambas as doses e manter capnografia continua"

    contraindicado: "rigidez toracica previa induzida por opioide"
    lasa: "Fenitoina" mitigacao "conferencia por codigo de barras na beira do leito"
}

farmaco Cisatracurio {
    classe bloqueador_neuromuscular
    rxnorm "319864"
    atc "M03AC11"
    alto_risco sim

    diluicao "150 mg em 100 mL SF 0.9% (1.5 mg/mL)" concentracao 1.5 mg
    vias [ ACESSO_CENTRAL ]

    dose inicial 1.0 mcg/kg/min
    dose maxima 3.0 mcg/kg/min

    titulacao 0.5 mcg/kg/min a_cada 30 min alvo "TOF 1-2 de 4"

    bomba {
        limite_leve 2.0 mcg/kg/min
        limite_rigido 3.0 mcg/kg/min
        reservatorio "NUNCA infundir sem sedacao profunda confirmada"
    }

    monitorar: "train-of-four e nivel de sedacao" a_cada 60 min alvo "RASS -5 obrigatorio"
    contraindicado: "sedacao insuficiente (RASS acima de -4)"
}

// -----------------------------------------------------------------------------
// ANTIMICROBIANOS E DEMAIS CLASSES DE ALTO RISCO
// -----------------------------------------------------------------------------

farmaco Vancomicina {
    classe antimicrobiano
    rxnorm "11124"
    atc "J01XA01"
    alto_risco nao

    diluicao "1 g em 250 mL SF 0.9%, infundir em no minimo 60 min"
    vias [ ACESSO_CENTRAL, ACESSO_PERIFERICO ]

    dose ataque 25.0 mg/kg
    dose manutencao 15.0 mg/kg
    dose maxima 2000.0 mg

    ajuste_renal: TFG < 50 mL/min -> aumentar_intervalo "estender intervalo para 24 h e dosar vale"
    ajuste_renal: TFG < 20 mL/min -> suspender "prescrever conforme nivel serico"

    monitorar: "vancocinemia de vale" a_cada 72 h alvo "15-20 mg/L (AUC/CIM 400-600)"
    monitorar: "creatinina serica" a_cada 24 h

    interacao: Piperacilina_Tazobactam gravidade alta ("nefrotoxicidade aditiva documentada") conduta "preferir cefepima ou monitorar creatinina diariamente"

    contraindicado: "historico de reacao anafilatica a glicopeptideos"
}

farmaco Piperacilina_Tazobactam {
    classe antimicrobiano
    rxnorm "33533"
    atc "J01CR05"
    alto_risco nao

    diluicao "4.5 g em 100 mL SF 0.9%, infusao estendida em 4 h"
    vias [ ACESSO_CENTRAL, ACESSO_PERIFERICO ]

    dose manutencao 4500.0 mg
    dose maxima 18000.0 mg

    ajuste_renal: TFG < 20 mL/min -> aumentar_intervalo "reduzir para 4.5 g a cada 12 h"

    monitorar: "funcao renal e hemograma" a_cada 24 h
    interacao: Vancomicina gravidade alta ("nefrotoxicidade aditiva documentada") conduta "monitorar creatinina diariamente"
}

farmaco Heparina {
    classe anticoagulante
    rxnorm "5224"
    atc "B01AB01"
    alto_risco sim

    diluicao "25000 UI em 250 mL SG 5% (100 UI/mL)" concentracao 100 UI
    vias [ ACESSO_CENTRAL, ACESSO_PERIFERICO, SC ]

    dose inicial 12.0 UI/kg
    dose maxima 2000.0 UI/h

    titulacao 100.0 UI/h a_cada 6 h alvo "TTPa 1.5-2.5 vezes o controle"

    bomba {
        limite_leve 1500.0 UI/h
        limite_rigido 2000.0 UI/h
        reservatorio "bolsa exclusiva, jamais em linha compartilhada"
    }

    monitorar: "TTPa e contagem de plaquetas" a_cada 6 h alvo "queda > 50% sugere trombocitopenia induzida por heparina"

    contraindicado: "sangramento ativo com instabilidade hemodinamica"
    contraindicado: "trombocitopenia induzida por heparina previa"
    lasa: "Insulina_Regular" mitigacao "erro historico de troca de frasco — separacao fisica obrigatoria"
}

farmaco Insulina_Regular {
    classe insulina
    rxnorm "253182"
    atc "A10AB01"
    alto_risco sim

    diluicao "100 UI em 100 mL SF 0.9% (1 UI/mL)" concentracao 1 UI
    vias [ ACESSO_CENTRAL, ACESSO_PERIFERICO, SC ]

    dose inicial 1.0 UI/h
    dose maxima 20.0 UI/h

    titulacao 1.0 UI/h a_cada 60 min alvo "glicemia 140-180 mg/dL"

    bomba {
        limite_leve 10.0 UI/h
        limite_rigido 20.0 UI/h
        reservatorio "seringa exclusiva rotulada em UI, nunca em mL"
    }

    monitorar: "glicemia capilar" a_cada 60 min alvo "140-180 mg/dL"
    monitorar: "potassio serico" a_cada 6 h alvo "evitar hipocalemia induzida"

    contraindicado: "glicemia abaixo de 100 mg/dL sem aporte de glicose"
    lasa: "Heparina" mitigacao "dupla checagem independente na montagem da bomba"
}

// -----------------------------------------------------------------------------
// PROTOCOLOS CLINICOS INSTITUCIONAIS
// -----------------------------------------------------------------------------

protocolo Choque_Septico {
    cid "A41.9"
    snomed "76571007"

    gatilho: lactato > 2.0 mmol/L -> "ativar bundle de 1 hora da Surviving Sepsis Campaign"
    gatilho: PAM < 65.0 mmHg -> "iniciar vasopressor apos reposicao volemica inicial"
    gatilho: qSOFA >= 2.0 pontos -> "acionar avaliacao imediata do intensivista"

    etapa 1 "coletar lactato, hemoculturas pareadas e iniciar cristaloide 30 mL/kg" prazo 1 h
    etapa 2 "administrar antimicrobiano de amplo espectro apos as culturas" prazo 1 h
    etapa 3 "reavaliar lactato e responsividade a volume" prazo 6 h

    recomenda Noradrenalina indicacao "vasopressor de primeira linha para PAM < 65 mmHg"
    recomenda Vasopressina indicacao "segunda linha poupadora de catecolamina"
    recomenda Vancomicina indicacao "cobertura empirica de Gram-positivo resistente"

    veta Dobutamina motivo "sem indicacao na ausencia de disfuncao miocardica documentada"

    escalonar: lactato > 4.0 mmol/L -> TIME_RESPOSTA_RAPIDA "hipoperfusao grave persistente"
    escalonar: PAM < 55.0 mmHg -> INTENSIVISTA "choque refratario a vasopressor de primeira linha"

    desmame: "PAM estavel acima de 70 mmHg por 4 h com lactato normalizado" reduzir 0.02 mcg/kg/min a_cada 15 min

    desfecho: "lactato em queda superior a 20% e diurese acima de 0.5 mL/kg/h" reavaliar_em 6 h
}

protocolo Sedacao_Analgesia_VM {
    cid "Z99.1"
    snomed "40617009"

    gatilho: RASS > 0.0 pontos -> "paciente agitado em ventilacao mecanica: avaliar dor antes de sedar"
    gatilho: RASS < -4.0 pontos -> "sedacao excessiva: reduzir infusao e despertar diario"

    etapa 1 "tratar dor primeiro (analgesia preemptiva com opioide)" prazo 30 min
    etapa 2 "titular sedativo apenas se RASS acima do alvo apos analgesia" prazo 60 min
    etapa 3 "interrupcao diaria da sedacao e teste de respiracao espontanea" prazo 24 h

    recomenda Fentanil indicacao "analgesia de primeira linha em ventilacao mecanica"
    recomenda Propofol indicacao "sedativo de escolha para desmame precoce"

    veta Midazolam motivo "associado a maior incidencia de delirium e tempo de ventilacao"

    escalonar: RASS > 2.0 pontos -> MEDICO_PLANTONISTA "agitacao refrataria com risco de autoextubacao"

    desmame: "RASS no alvo por 6 h sem assincronia" reduzir 0.5 mg/kg/h a_cada 60 min

    desfecho: "RASS -2 a 0 com paciente colaborativo e sem delirium" reavaliar_em 12 h
}

protocolo Controle_Glicemico_UTI {
    cid "E11.9"
    snomed "44054006"

    gatilho: glicemia > 180.0 mg/dL -> "iniciar insulina regular em infusao continua"
    gatilho: glicemia < 70.0 mg/dL -> "suspender insulina e corrigir hipoglicemia imediatamente"

    etapa 1 "confirmar glicemia em amostra laboratorial antes de iniciar infusao" prazo 30 min
    etapa 2 "estabelecer aporte calorico continuo antes da titulacao" prazo 2 h

    recomenda Insulina_Regular indicacao "hiperglicemia persistente no paciente critico"

    escalonar: glicemia < 50.0 mg/dL -> TIME_RESPOSTA_RAPIDA "hipoglicemia grave"

    desfecho: "glicemia 140-180 mg/dL em duas medidas consecutivas" reavaliar_em 4 h
}

// -----------------------------------------------------------------------------
// POPULACOES ESPECIAIS
// -----------------------------------------------------------------------------

populacao Gestante {
    criterio "gestacao confirmada em qualquer trimestre"
    proibe Midazolam motivo "risco teratogenico e depressao neonatal"
    exige "avaliacao conjunta com obstetricia antes de qualquer sedativo continuo"
    exige "monitorizacao fetal continua durante uso de vasopressor"
}

populacao Renal_Cronico {
    criterio "TFG abaixo de 30 mL/min ou terapia renal substitutiva"
    ajusta Vancomicina fator 0.5 motivo "clearance reduzido com risco de nefrotoxicidade"
    ajusta Midazolam fator 0.5 motivo "acumulo de metabolito ativo"
    ajusta Fentanil fator 0.75 motivo "acumulo de metabolitos em disfuncao renal"
    exige "dosagem serica antes de cada reajuste de antimicrobiano"
}

populacao Idoso_Fragil {
    criterio "idade acima de 75 anos com escala de fragilidade clinica >= 5"
    ajusta Propofol fator 0.5 motivo "maior sensibilidade hemodinamica e risco de hipotensao"
    ajusta Midazolam fator 0.5 motivo "risco elevado de delirium"
    exige "rastreio de delirium pelo CAM-ICU a cada 12 h"
}

populacao Obeso_Grave {
    criterio "indice de massa corporal acima de 40"
    exige "usar peso corporal ajustado para farmacos lipofilicos"
    exige "revisao da farmacia clinica antes da primeira dose de antimicrobiano"
}

// -----------------------------------------------------------------------------
// INVARIANTES DE SEGURANCA (arestas globais do grafo)
// -----------------------------------------------------------------------------

regra_seguranca: bloquear_incremento Propofol se PAM < 60.0 mmHg ("risco de hipotensao severa e colapso hemodinamico")
regra_seguranca: bloquear_incremento Noradrenalina se FC > 130.0 bpm ("risco de taquiarritmia e fibrilacao atrial")
regra_seguranca: bloquear_incremento Midazolam se RASS < -3.0 pontos ("sedacao ja excessiva: aprofundar agrava o delirium")
regra_seguranca: bloquear_incremento Insulina_Regular se glicemia < 140.0 mg/dL ("risco de hipoglicemia iatrogenica")
regra_seguranca: bloquear_incremento Cisatracurio se RASS > -4.0 pontos ("bloqueio neuromuscular com paciente consciente")
regra_seguranca: bloquear_incremento Heparina se plaquetas < 50.0 10^3/uL ("risco hemorragico proibitivo")

regra_global: "Todo medicamento de alto risco exige dupla checagem independente na montagem e na instalacao da bomba" severidade alta referencia "ISMP Brasil — medicamentos potencialmente perigosos"
regra_global: "Nenhum incremento de vasopressor pode ultrapassar o limite rigido (hard limit) do DERS da bomba" severidade contraindicada referencia "DERS — Dose Error Reduction Software"
regra_global: "Bloqueador neuromuscular so pode ser infundido com sedacao profunda confirmada (RASS -5)" severidade contraindicada
regra_global: "Fármacos LASA nunca podem ser armazenados em posicoes adjacentes no carro de emergencia" severidade alta
regra_global: "Toda ordem gerada automaticamente exige justificativa rastreavel e registro de auditoria" severidade alta referencia "LGPD e Resolucao CFM sobre prontuario eletronico"
regra_global: "Vasopressor em acesso periferico so e admissivel por ate 6 h como ponte para acesso central" severidade moderada

// =============================================================================
// ESQUEMA DE DADOS — universo fechado de respostas do assistente clinico
// =============================================================================

esquema_dados AssistenteUTI_v2 {
    decisoes [ INICIAR_INFUSAO, AUMENTAR_VAZAO, REDUZIR_VAZAO, MANTER_VAZAO, MANTER_BLOQUEADO, SUSPENDER, SUBSTITUIR, AJUSTAR_DOSE, SOLICITAR_EXAME, ESCALAR_EQUIPE, BLOQUEAR_ORDEM ]
    vias [ ACESSO_CENTRAL, ACESSO_PERIFERICO, INTRAOSSEO, SC ]
    alertas [ INFORMATIVO, ATENCAO, CRITICO, BLOQUEANTE ]

    conduta Iniciar_Vasopressor {
        decisao INICIAR_INFUSAO
        via ACESSO_CENTRAL
        requer_dupla_checagem sim
        justificativa_obrigatoria sim
        recurso_fhir "MedicationRequest"
    }

    conduta Titular_Vasopressor {
        decisao AUMENTAR_VAZAO
        via ACESSO_CENTRAL
        requer_dupla_checagem sim
        justificativa_obrigatoria sim
        recurso_fhir "MedicationAdministration"
    }

    conduta Reduzir_Infusao {
        decisao REDUZIR_VAZAO
        via ACESSO_CENTRAL
        justificativa_obrigatoria sim
        recurso_fhir "MedicationAdministration"
    }

    conduta Manter_Bloqueio {
        decisao MANTER_BLOQUEADO
        requer_dupla_checagem sim
        justificativa_obrigatoria sim
        recurso_fhir "DetectedIssue"
    }

    conduta Suspender_Farmaco {
        decisao SUSPENDER
        requer_dupla_checagem sim
        justificativa_obrigatoria sim
        recurso_fhir "MedicationRequest"
    }

    conduta Solicitar_Exame_Controle {
        decisao SOLICITAR_EXAME
        justificativa_obrigatoria sim
        recurso_fhir "ServiceRequest"
    }

    conduta Acionar_Equipe {
        decisao ESCALAR_EQUIPE
        requer_dupla_checagem nao
        justificativa_obrigatoria sim
        recurso_fhir "Communication"
    }

    conduta Bloquear_Ordem_Insegura {
        decisao BLOQUEAR_ORDEM
        requer_dupla_checagem sim
        justificativa_obrigatoria sim
        recurso_fhir "DetectedIssue"
    }
}

// -----------------------------------------------------------------------------
// Plano de referencia — exemplar few-shot do grammar prompting.
// -----------------------------------------------------------------------------

plano Plano_Referencia_Choque para Choque_Septico {
    esquema_referencia AssistenteUTI_v2
    paciente "PT-2026-0031"
    sequencia [ Titular_Vasopressor, Manter_Bloqueio, Solicitar_Exame_Controle ]

    ordem Noradrenalina decisao AUMENTAR_VAZAO dose 0.05 mcg/kg/min via ACESSO_CENTRAL justificativa "PAM 52 mmHg abaixo do alvo apos reposicao volemica"
    ordem Propofol decisao MANTER_BLOQUEADO dose 0.0 mg/kg/h via ACESSO_CENTRAL justificativa "incremento vetado pela regra de seguranca com PAM < 60 mmHg"
    ordem Vancomicina decisao SOLICITAR_EXAME dose 0.0 mg via ACESSO_CENTRAL justificativa "coletar vancocinemia de vale antes do proximo ajuste"

    alerta CRITICO "PAM 52 mmHg com lactato 4.8 mmol/L caracteriza hipoperfusao grave" regra "Choque_Septico/escalonar"
    alerta BLOQUEANTE "aprofundamento de sedacao negado por hipotensao" regra "regra_seguranca/Propofol"

    auditoria "plano derivado do protocolo Choque_Septico sob restricao gramatical e ancoragem no grafo"
}
