// =============================================================================
// Modelo institucional de terapia intensiva — escrito pelo especialista clinico
// (medico intensivista + farmaceutico clinico) a partir da lista de
// medicamentos potencialmente perigosos do ISMP Brasil, dos limites DERS das
// bombas inteligentes, do bundle da Surviving Sepsis Campaign e das escalas
// RASS / BPS / CAM-ICU, primeiro dominio do SPC-CML.
//
// ESQUEMA DE CONTROLE -> sincronizado no Neo4j (ground truth factual).
// ESQUEMA DE DADOS    -> exportado como BNF para a decodificacao restrita.
//
// As condicoes que decidem seguranca sao ESTRUTURADAS (parametro, operador,
// limiar), lidas da telemetria corrente do leito. O que aparece como STRING e
// justificativa, procedimento ou orientacao para a equipe ler, nunca criterio
// de decisao. Um fato que so existe na fala do plantonista ("ja repus os 30
// mL/kg", "o acesso central ja esta passado", "a creatinina vinha melhorando",
// "o paciente esta confortavel", "a cultura ja foi colhida", "a familia
// autorizou") NAO e telemetria: sem o dado estruturado, a regra correspondente
// simplesmente nao incide, e o fato fica como evidencia insuficiente, nunca
// como evidencia negativa.
//
// CAMADAS, e o mecanismo que realiza cada uma:
//
//   EVIDENCIA       telemetria do leito (ClinicalParameter), populacoes em que o
//                   paciente se enquadra e farmacos ja em infusao.
//   APLICABILIDADE  o farmaco vale por padrao. Ele deixa de valer por EXCLUSAO:
//     / EXCLUSAO    um protocolo que o `veta` (farmaco sem indicacao naquele
//                   quadro, onde a prescricao nao existe como opcao) ou uma
//                   populacao que o `proibe` (farmaco que nao pode ser dado
//                   aquele paciente). Excluido, o farmaco so admite
//                   MANTER_BLOQUEADO, SUSPENDER, SUBSTITUIR, SOLICITAR_EXAME,
//                   ESCALAR_EQUIPE e BLOQUEAR_ORDEM — nenhuma decisao que
//                   aumente a exposicao.
//   FARMACO         `farmaco`: classe, RxNorm/ATC, alto risco, diluicao, vias,
//                   faixa de dose, degrau de titulacao e limites DERS da bomba.
//   COMBINACAO      `interacao` (so pesa quando o outro farmaco ja esta em
//                   infusao), `lasa` (risco de troca na dispensacao) e
//                   `contraindicado:` (condicao de bula, em prosa).
//   DECISAO         politica por farmaco sobre o `esquema_dados`. As `dose`
//                   declaram as quantidades EXPRIMIVEIS — inicial, ataque ou
//                   manutencao para INICIAR_INFUSAO; o degrau da `titulacao`
//                   para AUMENTAR_VAZAO, REDUZIR_VAZAO e AJUSTAR_DOSE — e o
//                   `ajusta` de uma populacao multiplica essas quantidades.
//                   Nenhum dos dois e avaliado contra a telemetria: eles
//                   declaram a CONSEQUENCIA, nao a condicao.
//   PROCEDIMENTO    `etapa`, `desmame`, `escalonar` (obriga ESCALAR_EQUIPE no
//                   artefato), `exige` das populacoes e as regras globais.
//
// `regra_seguranca: bloquear_incremento` e uma RESTRICAO DE POLITICA: tira
// INICIAR_INFUSAO, AUMENTAR_VAZAO e AJUSTAR_DOSE de um farmaco que continua
// citavel, reduzivel, suspendivel e substituivel. Ela nao e a decisao
// BLOQUEAR_ORDEM, que e a equipe RECUSAR a ordem pedida por falta de base ou de
// seguranca (ver `Bloquear_Ordem_Insegura`). Diferente do dominio de
// arbitragem, aqui o teto TEM leitura que o sustente — PAM, FC, RASS, glicemia e
// plaquetas sao medidos —, por isso os farmacos cujo risco de incremento a
// telemetria mede declaram pelo menos um.
//
// DICIONARIO DA LEITURA (como este modelo le cada parametro da telemetria):
//   PAM        pressao arterial media invasiva, em mmHg, no instante da leitura.
//              E o alvo hemodinamico (>= 65) e o limiar de hipotensao que
//              bloqueia o aprofundamento da sedacao.
//   FC         frequencia cardiaca, em bpm. Diz a FREQUENCIA, nao o RITMO:
//              taquicardia nao distingue taquiarritmia de taquicardia sinusal
//              por dor, febre ou hipovolemia.
//   lactato    lactato serico, em mmol/L. Mede hipoperfusao; nao diz a causa
//              nem fecha diagnostico de sepse.
//   RASS       Richmond Agitation-Sedation Scale, de -5 a +4. Diz a
//              PROFUNDIDADE da sedacao; nao diz dor (BPS) nem delirium
//              (CAM-ICU), que nao vem na leitura.
//   TFG        taxa de filtracao glomerular estimada, em mL/min. E a unica
//              condicao estruturada declarada dentro do proprio farmaco.
//   plaquetas  contagem, em 10^3/uL. Diz o NUMERO; a queda relativa superior a
//              50% que sugere trombocitopenia induzida por heparina exige duas
//              medidas, e a leitura e um instantaneo.
//   glicemia   glicemia capilar, em mg/dL.
//   SpO2       saturacao periferica, em %. Vem na leitura e NAO entra em regra:
//              dessaturacao nao distingue causa (via aerea, parenquima, debito)
//              e nenhuma decisao deste modelo se sustenta nela sozinha.
//
// `qSOFA` aparece como gatilho do Choque_Septico e NAO vem na telemetria: e o
// caso deliberado de LACUNA. A condicao nao e dada por falsa nem por verdadeira
// — vira "o cenario nao mediu 'qSOFA'" e o gatilho sai como nao aplicavel POR
// FALTA DE EVIDENCIA. E o unico ponto do modelo em que uma regra depende de um
// dado ausente, e e de proposito: e assim que se verifica que o sistema nao
// preenche o que nao mediu.
//
// Os demais parametros do vocabulario (PAS, PAD, FR, temperatura, creatinina,
// potassio, sodio, INR, hemoglobina, QTc, bilirrubina, PaO2_FiO2, SOFA,
// Glasgow, debito_urinario, peso, idade) nao vem na leitura e por isso nao
// entram em regra. Duas consequencias que valem anotar: as doses por kg
// pressupoem um peso de prontuario que a leitura nao traz — o artefato escreve o
// DEGRAU na unidade por kg, nunca uma dose absoluta acumulada —, e a leitura e
// um INSTANTANEO, sem tendencia nem duracao, de modo que os criterios de
// `desmame` ("por 4 h", "por 6 h") e os intervalos de `monitorar` sao
// procedimento para a equipe, nunca condicao avaliada contra o dado.
// =============================================================================

// -----------------------------------------------------------------------------
// 1) ESQUEMA DE CONTROLE — farmacos
//
// Cada farmaco declara a faixa de dose (inicial, ataque ou manutencao, e
// maxima) e o degrau da `titulacao`: sao esses os valores que a gramatica deixa
// o artefato escrever, e e por eles que AUMENTAR_VAZAO, REDUZIR_VAZAO e
// AJUSTAR_DOSE significam alguma coisa em vez de virar adjetivo. `bomba` traz os
// limites DERS (leve = alerta, rigido = bloqueio) e `monitorar` o que a beira do
// leito confere; nenhum dos dois e avaliado contra a telemetria.
//
// `ajuste_renal:` e a UNICA condicao estruturada dentro do farmaco, porque a TFG
// vem na leitura. `ajuste_hepatico:` e `contraindicado:` sao prosa de bula para
// a equipe ler — Child-Pugh, alergia a ovo, sangramento ativo e rigidez toracica
// previa nao vem na telemetria —, e quem de fato exclui o farmaco e a populacao
// que o `proibe` ou o protocolo que o `veta`. `interacao:` so pesa quando o
// outro farmaco ja esta em infusao, e `lasa:` e risco de troca na dispensacao,
// nunca criterio de decisao clinica.
// -----------------------------------------------------------------------------

// VASOPRESSORES E INOTROPICOS

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

// SEDACAO E ANALGESIA

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

// ANTIMICROBIANOS E DEMAIS CLASSES DE ALTO RISCO

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
    // Declarada nos dois lados: a interacao e uma aresta simetrica da
    // prescricao, e o prompt a mostra a partir de qualquer um dos dois farmacos.
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
// 2) ESQUEMA DE CONTROLE — protocolos clinicos institucionais
//
// Um protocolo fica ativo quando QUALQUER gatilho dele incide sobre a
// telemetria. Protocolo sem gatilho ativo so entra quando o pedido o identifica
// (foco), e entao vale pelas suas restricoes estruturais — o `veta`, as `etapa`
// —, nao como evento do leito: a Dobutamina continua sem indicacao em choque
// septico sem disfuncao miocardica documentada num dia de lactato alto.
//
// O gatilho diz o que a leitura sustenta e nada mais: lactato elevado e
// hipoperfusao, nao diagnostico de sepse; RASS fora do alvo e profundidade de
// sedacao, nao dor; glicemia alta e hiperglicemia, nao diabetes. Por isso o
// gatilho manda COLETAR, AVALIAR ou TITULAR, e a conduta so se fecha quando a
// leitura cruza o limiar da regra.
//
// `gatilho: qSOFA >= 2` esta aqui de proposito e a telemetria nao o traz: a
// condicao vira LACUNA e o gatilho sai como nao aplicavel por falta de
// evidencia — nunca como satisfeito, nunca como negado.
//
// Dos cinco destinos de `escalonar` do vocabulario, tres sao exercidos:
// TIME_RESPOSTA_RAPIDA (hipoperfusao grave, hipoglicemia grave),
// MEDICO_PLANTONISTA (agitacao refrataria) e INTENSIVISTA (choque refratario a
// vasopressor de primeira linha). FARMACIA_CLINICA e COMISSAO_INFECCAO nao sao
// alcancados por regra: o ajuste de antimicrobiano por funcao renal ja esta
// estruturado em `ajuste_renal` sobre a TFG e reforcado pelo `exige` de
// Renal_Cronico e Obeso_Grave, e cultura, antibiograma e perfil de resistencia —
// o que convocaria a comissao — nao entram na telemetria. Destino sem leitura
// que o sustente seria escalonamento decidido por prosa.
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
// 3) ESQUEMA DE CONTROLE — populacoes especiais (analogo das areas/contextos)
//
// `proibe` so quando o farmaco NAO PODE ser administrado aquele paciente. O que
// a populacao muda de procedimento, conferencia ou aviso vai em `exige`.
// Diferente do dominio de arbitragem, aqui `ajusta` TEM semantica operacional: o
// fator multiplica as doses exprimiveis do farmaco e o artefato tem um campo
// `dose` para receber o resultado — reduzir a 0.5 e uma ordem verificavel, nao um
// adjetivo.
//
// A populacao nao e telemetria: vem do cadastro do paciente. O criterio de
// Renal_Cronico cita a TFG, mas a pertinencia e cadastral — uma TFG baixa numa
// leitura isolada nao converte o paciente em renal cronico, e e `ajuste_renal`,
// nao a populacao, que incide sobre o valor medido. Populacao que o cadastro nao
// declara simplesmente nao incide, e isso nao e evidencia de que o paciente nao
// se enquadra nem autoriza declarar a restricao cumprida.
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
// 4) INVARIANTES DE SEGURANCA E REGRAS GLOBAIS (arestas globais do grafo)
//
// Cada `regra_seguranca` e um teto de politica ancorado numa leitura: enquanto o
// limiar estiver cruzado, o farmaco perde INICIAR_INFUSAO, AUMENTAR_VAZAO e
// AJUSTAR_DOSE, e continua citavel para reduzir, manter bloqueado, suspender,
// substituir, pedir exame ou escalar. Parametro ausente da telemetria nao
// dispara a regra — e tambem nao a dispensa: sem o dado, a condicao fica
// indeterminada, nunca segura.
//
// Oito tetos cobrem os farmacos cujo risco de incremento a leitura mede:
// Propofol (PAM), Noradrenalina, Adrenalina e Dobutamina (FC), Midazolam e
// Cisatracurio (RASS), Insulina_Regular (glicemia) e Heparina (plaquetas).
// Vasopressina, Fentanil, Vancomicina e Piperacilina_Tazobactam nao declaram
// teto, e por falta de leitura, nao por licenca: isquemia digital ou mesenterica,
// frequencia respiratoria e capnografia, e nivel serico de vale nao vem na
// telemetria. Para os dois antimicrobianos o limite que existe ja esta
// estruturado em `ajuste_renal` sobre a TFG; para os outros dois o que resta e o
// `limite_rigido` da bomba, que e consequencia declarada e nao condicao lida.
// -----------------------------------------------------------------------------

regra_seguranca: bloquear_incremento Propofol se PAM < 60.0 mmHg ("risco de hipotensao severa e colapso hemodinamico")
regra_seguranca: bloquear_incremento Noradrenalina se FC > 130.0 bpm ("risco de taquiarritmia e fibrilacao atrial")
regra_seguranca: bloquear_incremento Adrenalina se FC > 130.0 bpm ("efeito cronotropico aditivo sobre taquicardia ja instalada")
regra_seguranca: bloquear_incremento Dobutamina se FC > 130.0 bpm ("inotropico cronotropico positivo com taquicardia acima do alvo de 110 bpm")
regra_seguranca: bloquear_incremento Midazolam se RASS < -3.0 pontos ("sedacao ja excessiva: aprofundar agrava o delirium")
regra_seguranca: bloquear_incremento Insulina_Regular se glicemia < 140.0 mg/dL ("risco de hipoglicemia iatrogenica")
regra_seguranca: bloquear_incremento Cisatracurio se RASS > -4.0 pontos ("bloqueio neuromuscular com paciente consciente")
regra_seguranca: bloquear_incremento Heparina se plaquetas < 50.0 10^3/uL ("risco hemorragico proibitivo")

regra_global: "Todo medicamento de alto risco exige dupla checagem independente na montagem e na instalacao da bomba" severidade alta referencia "ISMP Brasil — medicamentos potencialmente perigosos"
regra_global: "Nenhum incremento de vasopressor pode ultrapassar o limite rigido (hard limit) do DERS da bomba" severidade contraindicada referencia "DERS — Dose Error Reduction Software"
regra_global: "Bloqueador neuromuscular so pode ser infundido com sedacao profunda confirmada (RASS -5)" severidade contraindicada
regra_global: "Fármacos LASA nunca podem ser armazenados em posicoes adjacentes no carro de emergencia" severidade alta
regra_global: "Fato que so aparece no pedido — volume ja reposto, acesso central passado, cultura colhida, paciente confortavel, autorizacao da familia — nao e telemetria: sem o dado, a justificativa declara evidencia insuficiente" severidade alta
regra_global: "Parametro exigido por uma regra e nao medido no cenario produz lacuna: a regra sai como nao aplicavel por falta de evidencia, nunca como satisfeita" severidade alta
regra_global: "Populacao especial ausente do cadastro do paciente nao e evidencia de que ele nao se enquadra: a restricao nao incide, e tampouco pode ser declarada cumprida" severidade alta
regra_global: "Toda ordem gerada automaticamente exige justificativa rastreavel e registro de auditoria" severidade alta referencia "LGPD e Resolucao CFM sobre prontuario eletronico"
regra_global: "Vasopressor em acesso periferico so e admissivel por ate 6 h como ponte para acesso central" severidade moderada

// =============================================================================
// ESQUEMA DE DADOS — universo fechado de respostas do assistente clinico
//
// Toda decisao tem conduta: na decodificacao incremental, a clausula so realiza
// decisoes que alguma conduta da `sequencia` realiza — uma decisao sem conduta
// seria vocabulario morto. A `via`, ao contrario, e escolhida por clausula no
// artefato: as quatro continuam exprimiveis mesmo que uma conduta nao fixe
// nenhuma, limitadas pelas `vias` que o proprio farmaco declara.
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

    conduta Manter_Infusao {
        decisao MANTER_VAZAO
        justificativa_obrigatoria sim
        recurso_fhir "MedicationAdministration"
    }

    // Reajuste de dose sem mudanca de vazao-alvo — o caso do `ajuste_renal` e do
    // `ajusta` de uma populacao. E decisao de INCREMENTO: um teto de politica a
    // retira junto com INICIAR_INFUSAO e AUMENTAR_VAZAO.
    conduta Ajustar_Dose {
        decisao AJUSTAR_DOSE
        requer_dupla_checagem sim
        justificativa_obrigatoria sim
        recurso_fhir "MedicationRequest"
    }

    conduta Substituir_Farmaco {
        decisao SUBSTITUIR
        via ACESSO_CENTRAL
        requer_dupla_checagem sim
        justificativa_obrigatoria sim
        recurso_fhir "MedicationRequest"
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

    // A equipe RECUSA a ordem que lhe pediram, por falta de base ou de seguranca
    // — ex.: incremento de bloqueador neuromuscular sem sedacao profunda
    // registrada. Nao e o jeito de dizer que um farmaco foi descartado (isso e
    // SUSPENDER ou MANTER_BLOQUEADO) nem o mecanismo `regra_seguranca:
    // bloquear_incremento`, que restringe a politica de um farmaco que segue
    // prescritivel noutra condicao.
    conduta Bloquear_Ordem_Insegura {
        decisao BLOQUEAR_ORDEM
        requer_dupla_checagem sim
        justificativa_obrigatoria sim
        recurso_fhir "DetectedIssue"
    }
}

// -----------------------------------------------------------------------------
// Plano de referencia — exemplar few-shot do grammar prompting. Reporta o DEGRAU
// da titulacao no incremento e 0.0 no que esta bloqueado, nao afirma condicao
// que a telemetria nao registra, e nao usa BLOQUEAR_ORDEM para dizer que um
// farmaco foi descartado.
// -----------------------------------------------------------------------------

plano Plano_Referencia_Choque para Choque_Septico {
    esquema_referencia AssistenteUTI_v2
    paciente "PT-2026-0031"
    sequencia [ Titular_Vasopressor, Manter_Bloqueio, Solicitar_Exame_Controle ]

    ordem Noradrenalina decisao AUMENTAR_VAZAO dose 0.05 mcg/kg/min via ACESSO_CENTRAL justificativa "PAM 52 mmHg medida, abaixo do alvo de 65 mmHg: um degrau de titulacao; a reposicao volemica relatada pela equipe nao consta da telemetria"
    ordem Propofol decisao MANTER_BLOQUEADO dose 0.0 mg/kg/h via ACESSO_CENTRAL justificativa "incremento vetado pela regra de seguranca com PAM < 60 mmHg"
    ordem Vancomicina decisao SOLICITAR_EXAME dose 0.0 mg via ACESSO_CENTRAL justificativa "coletar vancocinemia de vale antes do proximo ajuste"

    alerta CRITICO "PAM 52 mmHg com lactato 4.8 mmol/L caracteriza hipoperfusao grave" regra "Choque_Septico/escalonar"
    alerta BLOQUEANTE "aprofundamento de sedacao negado por hipotensao" regra "regra_seguranca/Propofol"
    alerta ATENCAO "reposicao volemica previa e conforto do paciente vem do relato da equipe, nao da telemetria" regra "Choque_Septico"

    auditoria "plano derivado do protocolo Choque_Septico sob restricao gramatical e ancoragem no grafo"
}
