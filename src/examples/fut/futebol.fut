// =============================================================================
// Modelo institucional de arbitragem de futebol — escrito a partir das Laws of
// the Game (IFAB) e do Protocolo VAR do IFAB, terceiro dominio do SPC-CML.
//
// ESQUEMA DE CONTROLE -> sincronizado no Neo4j (ground truth factual).
// ESQUEMA DE DADOS    -> exportado como BNF para a decodificacao restrita.
//
// As condicoes que decidem sao ESTRUTURADAS (parametro, operador, limiar), lidas
// da leitura corrente da partida. O que aparece como STRING e justificativa,
// procedimento ou orientacao para o arbitro ler, nunca criterio de decisao.
// Um fato que so existe na fala do usuario ("dentro da propria area", "goleiro
// ja batido", "vantagem clara", "confirmado pelo VAR") NAO e leitura da partida:
// sem o dado estruturado, a regra correspondente simplesmente nao incide, e o
// fato fica como evidencia insuficiente, nunca como evidencia negativa.
//
// CAMADAS, e o mecanismo que realiza cada uma:
//
//   EVIDENCIA       leitura da partida (MatchParameter), contextos da
//                   competicao e infracoes ja marcadas.
//   APLICABILIDADE  a infracao vale por padrao. Ela deixa de valer por EXCLUSAO:
//     / EXCLUSAO    um lance cujo gatilho e evidencia estruturada SUFICIENTE de
//                   que a infracao nao se configura, e que a `veta`; ou um
//                   contexto em que a infracao nao existe, e que a `proibe`.
//                   Excluida, a infracao so admite MANTER_JOGO, BLOQUEAR_DECISAO
//                   e ACIONAR_VAR — nenhuma sancao.
//   INFRACAO        `infracao`: classe, lei, sancao-base, reinicios declarados.
//   AGRAVANTES      `agravante` (combinacao com infracao ja marcada) e `isento`.
//   DECISAO         politica por infracao sobre o `esquema_dados`. `zona_penal`
//                   e `sancao` declaram a CONSEQUENCIA quando a infracao se
//                   caracteriza; elas nao sao avaliadas contra a leitura.
//   PROCEDIMENTO    `etapa`, `escalonar` (obriga ACIONAR_VAR no artefato),
//                   `exige` dos contextos e as regras globais.
//
// `regra_seguranca: bloquear_decisao` e uma RESTRICAO DE POLITICA (tira as
// decisoes de sancao grave de uma infracao que continua aplicavel). Ela nao e a
// decisao BLOQUEAR_DECISAO, que e o arbitro recusar uma decisao pedida sem base
// (ver `Bloquear_Decisao_Insegura`). Nenhuma condicao da leitura atual justifica
// um teto de sancao, por isso este modelo nao declara nenhuma.
//
// DICIONARIO DA LEITURA (como este modelo le cada parametro):
//   distancia_ultimo_defensor  distancia com sinal do atacante ao penultimo
//                              adversario no momento do passe; negativa =
//                              atacante adiantado, zero = na linha.
//   distancia_bola             distancia do contato a bola; na mao na bola, da
//                              bola ao braco quando ela e jogada.
//   tempo_revisao_var          minutos de revisao do VAR em andamento. Nao diz o
//                              RESULTADO da revisao.
//   cartoes_amarelos_jogador   advertencias do jogador registradas na sumula.
// Os demais (minuto_partida, acrescimo, velocidade_bola, distancia_gol,
// jogadores_entre_bola_e_gol, placar_diferenca, faltas_acumuladas_time) nao
// sustentam, sozinhos, nenhuma conclusao decisoria e nao entram em regra:
// distancia do gol nao e zona do campo, velocidade da bola nao e vantagem,
// faltas coletivas nao sao dissenso individual.
// =============================================================================

// -----------------------------------------------------------------------------
// 1) ESQUEMA DE CONTROLE — infracoes
// -----------------------------------------------------------------------------

infracao Carga_Imprudente {
    classe falta_pessoal
    lei_ifab "Lei 12.1 — Careless charging"
    var_revisavel nao

    sancao NENHUM
    reinicios [ TIRO_LIVRE_DIRETO, PENALTI ]

    zona_penal: AREA_PROPRIA -> PENALTI "carga imprudente cometida dentro da propria area penal"

    isento: "disputa normal de bola com contato minimo e sem risco ao adversario" excecao "contato com uso excessivo de forca"

    confusao_comum: "Entrada_Violenta" mitigacao "imprudente nao tem cartao, temeraria tem amarelo, forca excessiva e jogo brusco grave: avaliar a intensidade antes de escalar a sancao"
}

infracao Entrada_Violenta {
    classe jogo_violento
    lei_ifab "Lei 12.3 — Serious foul play"
    var_revisavel sim

    sancao CARTAO_VERMELHO
    reinicios [ TIRO_LIVRE_DIRETO, PENALTI ]

    zona_penal: AREA_PROPRIA -> PENALTI "jogo brusco grave cometido dentro da propria area penal"

    agravante: Carga_Imprudente gravidade alta ("mesmo padrao de contato, mas com uso excessivo de forca e risco elevado a integridade do adversario") conduta "revisar em camera lenta antes de confirmar a expulsao"

    isento: "disputa legitima pela bola com contato inevitavel e proporcional" excecao "uso claro de forca excessiva ou brutalidade"

    confusao_comum: "Conduta_Violenta" mitigacao "jogo brusco grave acontece disputando a bola; longe da disputa, a mesma forca e conduta violenta"
}

infracao Conduta_Violenta {
    classe jogo_violento
    lei_ifab "Lei 12.3 — Violent conduct"
    var_revisavel sim

    sancao CARTAO_VERMELHO
    reinicios [ TIRO_LIVRE_DIRETO, PENALTI ]

    zona_penal: AREA_PROPRIA -> PENALTI "conduta violenta contra adversario dentro da propria area penal, com a bola em jogo"

    isento: "contato acidental fora da disputa, sem forca excessiva nem brutalidade" excecao "agressao deliberada, mesmo com a bola fora de jogo"

    confusao_comum: "Entrada_Violenta" mitigacao "confirmar se o jogador disputava a bola: disputando, e jogo brusco grave"
}

infracao Mao_Deliberada {
    classe mao_na_bola
    lei_ifab "Lei 12.1 — Handling the ball"
    var_revisavel sim

    sancao NENHUM
    reinicios [ TIRO_LIVRE_DIRETO, PENALTI ]

    zona_penal: AREA_PROPRIA -> PENALTI "toque deliberado de mao dentro da propria area penal"

    monitorar: "posicao do braco em relacao ao corpo e se torna o corpo artificialmente maior" a_cada 1 partida alvo "criterio de intencionalidade do IFAB"

    isento: "bola jogada a curta distancia ou desviada no proprio corpo, com o braco em posicao natural" excecao "braco acima da linha do ombro ou tornando o corpo artificialmente maior"

    confusao_comum: "Carga_Imprudente" mitigacao "confirmar se o contato inicial foi na bola ou no braco antes de sancionar"
}

infracao Simulacao {
    classe simulacao
    lei_ifab "Lei 12.3 — Unsporting behaviour"
    var_revisavel sim

    sancao CARTAO_AMARELO
    reinicios [ TIRO_LIVRE_INDIRETO ]

    isento: "contato real que altera o equilibrio do jogador, mesmo com queda exagerada" excecao "ausencia total de contato comprovada pela revisao do VAR"

    confusao_comum: "Mao_Deliberada" mitigacao "nao confundir queda por handball defensivo com simulacao de contato"
}

infracao Dissenso {
    classe dissenso
    lei_ifab "Lei 12.3 — Dissent by word or action"
    var_revisavel nao

    sancao CARTAO_AMARELO
    reinicios [ TIRO_LIVRE_INDIRETO ]

    monitorar: "tom e conteudo da manifestacao dirigida a arbitragem" a_cada 1 partida

    confusao_comum: "Linguagem_Ofensiva" mitigacao "reclamar e dissenso (amarelo); insultar ou usar linguagem abusiva e outra infracao (vermelho)"
}

infracao Linguagem_Ofensiva {
    classe conduta_antidesportiva
    lei_ifab "Lei 12.3 — Offensive, insulting or abusive language or gestures"
    var_revisavel sim

    sancao CARTAO_VERMELHO
    reinicios [ TIRO_LIVRE_INDIRETO ]

    monitorar: "conteudo ofensivo, insultuoso ou abusivo da manifestacao" a_cada 1 partida

    confusao_comum: "Dissenso" mitigacao "reclamacao sem ofensa, ainda que ostensiva, e dissenso"
}

infracao Perda_Tempo {
    classe perda_tempo
    lei_ifab "Lei 12.3 — Delaying the restart of play"
    var_revisavel nao

    sancao CARTAO_AMARELO
    reinicios [ TIRO_LIVRE_INDIRETO ]

    // O tempo perdido e acrescido pelo quarto arbitro E o atraso deliberado pode
    // ser advertido: acrescimo nao compensa a conduta. Esta monitoracao em
    // minutos tambem e o que da a unidade `min` ao campo `minuto` da gramatica.
    monitorar: "tempo perdido em cada reinicio, para compor o acrescimo" a_cada 1 min

    isento: "atraso natural do jogo sem intencao de retardar o reinicio" excecao "reincidencia do mesmo jogador na mesma partida"
}

infracao Impedimento {
    classe impedimento
    lei_ifab "Lei 11 — Offside"
    var_revisavel sim

    sancao NENHUM
    reinicios [ TIRO_LIVRE_INDIRETO ]

    monitorar: "linha de impedimento no momento exato do ultimo toque do companheiro" a_cada 1 partida alvo "tolerancia de calibracao do sistema semiautomatico"

    isento: "jogador na propria metade de campo ou atras da bola no momento do passe" excecao "nenhuma — nessas posicoes nao ha posicao de impedimento"
}

infracao Contato_Goleiro_Area {
    classe dogso
    lei_ifab "Lei 12.3 — Denying an obvious goal-scoring opportunity"
    var_revisavel sim

    sancao CARTAO_VERMELHO
    reinicios [ TIRO_LIVRE_DIRETO, PENALTI ]

    zona_penal: AREA_PROPRIA -> PENALTI "infracao dentro da propria area impedindo gol claro; com tentativa de jogar a bola, a sancao cai para amarelo"

    agravante: Entrada_Violenta gravidade alta ("contato de goleiro com uso excessivo de forca soma-se a negacao da chance clara de gol") conduta "revisar pelo VAR, quando houver, antes de expulsar"

    isento: "defensores em condicao de intervir ou atacante sem controle da bola" excecao "atacante com controle, na direcao do gol e sem defensor capaz de intervir"
}

infracao Cusparada {
    classe conduta_antidesportiva
    lei_ifab "Lei 12.3 — Spitting at a person"
    var_revisavel sim

    sancao CARTAO_VERMELHO
    reinicios [ TIRO_LIVRE_DIRETO, PENALTI ]

    zona_penal: AREA_PROPRIA -> PENALTI "cusparada em adversario dentro da propria area penal, com a bola em jogo"

    isento: "cusparada que nao e dirigida a nenhuma pessoa" excecao "impossibilidade de identificar o autor mesmo apos revisao"
}

infracao Reincidencia_Amarelo {
    classe conduta_antidesportiva
    lei_ifab "Lei 12.3 — Second caution in the same match"
    var_revisavel nao

    sancao CARTAO_AMARELO reincidencia CARTAO_VERMELHO
    reinicios [ TIRO_LIVRE_INDIRETO ]

    monitorar: "acumulo de cartoes amarelos do jogador na partida" a_cada 1 partida alvo "expulsao automatica na segunda advertencia"
}

// -----------------------------------------------------------------------------
// 2) ESQUEMA DE CONTROLE — lances
//
// Um lance fica ativo quando QUALQUER gatilho dele incide sobre a leitura. Lance
// sem gatilho so entra quando o pedido o identifica (foco), e entao vale pelas
// suas restricoes estruturais, nao como evento da partida.
// -----------------------------------------------------------------------------

lance Penalti_Na_Area {
    lei_ifab "Lei 14 — The Penalty Kick"

    // Sem gatilho: a ZONA do contato (dentro ou fora da propria area) nao e
    // leitura da partida, e distancia do gol nao a substitui.

    etapa 1 "arbitro assistente sinaliza possivel infracao com a bandeira sem interromper o jogo se houver vantagem" prazo 10 s
    etapa 2 "VAR verifica o lance e, se for o caso, recomenda revisao ao arbitro principal" prazo 60 s
    etapa 3 "arbitro vai ao monitor de campo (OFR) e mantem ou reverte a marcacao original" prazo 5 min

    recomenda Mao_Deliberada indicacao "toque de mao deliberado dentro da propria area"
    recomenda Contato_Goleiro_Area indicacao "infracao do goleiro que impede chance clara de gol dentro da area"

    desfecho: "penalti marcado e cobranca executada, ou lance mantido como estava em campo" reavaliar_em 1 min
}

lance Impedimento_Ataque {
    lei_ifab "Lei 11 — Offside"

    gatilho: distancia_ultimo_defensor < 0.0 m -> "atacante a frente do penultimo adversario no momento do passe: posicao de impedimento possivel; a infracao ainda depende da posicao da bola, da metade do campo e de interferencia no lance"

    etapa 1 "sistema de impedimento semiautomatico traca a linha no momento exato do ultimo toque" prazo 5 s
    etapa 2 "arbitro assistente confirma ou reve a sinalizacao inicial e avalia a interferencia no lance" prazo 15 s

    recomenda Impedimento indicacao "posicao adiantada com interferencia no lance"

    desfecho: "gol confirmado, gol anulado ou tiro livre indireto marcado" reavaliar_em 2 min
}

lance Posicao_Legal_No_Passe {
    lei_ifab "Lei 11.1 — Offside position"

    gatilho: distancia_ultimo_defensor >= 0.0 m -> "atacante na linha ou atras do penultimo adversario no momento do passe"

    veta Impedimento motivo "na linha ou atras do penultimo adversario nao ha posicao de impedimento"

    desfecho: "jogo segue; gol, se houver, e confirmado quanto ao impedimento" reavaliar_em 1 min
}

lance Conduta_Violenta_Jogo {
    lei_ifab "Lei 12.3 — Serious foul play and violent conduct"

    gatilho: distancia_bola > 2.0 m -> "contato a mais de 2 m da bola: fora da disputa; conduta violenta so com forca excessiva ou brutalidade"

    etapa 1 "arbitro para o jogo imediatamente, independente da vantagem" prazo 5 s
    etapa 2 "VAR reve todo incidente de cartao vermelho direto antes da retomada do jogo" prazo 90 s

    recomenda Conduta_Violenta indicacao "contato fora da disputa com forca excessiva ou brutalidade"
    recomenda Cusparada indicacao "conduta antidesportiva grave dirigida a uma pessoa"

    desfecho: "expulsao confirmada e time reduzido a dez jogadores" reavaliar_em 1 min
}

lance Disputa_Bola_Dividida {
    lei_ifab "Lei 12.1 — Careless, reckless or using excessive force"

    // Sem gatilho: velocidade da bola nao e vantagem, e placar adverso nao e
    // disputa. Vantagem depende de controle, progressao e beneficio efetivo,
    // que a leitura nao traz.

    etapa 1 "arbitro avalia se o time prejudicado mantem controle e progressao da jogada" prazo 3 s
    etapa 2 "se a vantagem nao se concretizar em ate 3 segundos, o jogo retorna ao momento da infracao" prazo 3 s

    recomenda Carga_Imprudente indicacao "contato normal de jogo com uso de forca alem do razoavel"
    recomenda Entrada_Violenta indicacao "disputa da bola com forca excessiva ou pondo em risco o adversario"

    desfecho: "vantagem aplicada ou jogo paralisado com marcacao de falta" reavaliar_em 1 min
}

lance Mao_Curta_Distancia {
    lei_ifab "Lei 12.1 — Handling the ball"

    gatilho: distancia_bola < 1.0 m -> "bola a menos de 1 m do braco quando jogada: evidencia de reacao natural"

    veta Mao_Deliberada motivo "bola a curta distancia: o toque e presumido reacao natural; so a posicao do braco — acima do ombro ou tornando o corpo maior — superaria essa evidencia"

    desfecho: "jogo segue, sem infracao de mao" reavaliar_em 1 min
}

lance Jogador_Sem_Advertencia {
    lei_ifab "Lei 12.3 — Second caution in the same match"

    gatilho: cartoes_amarelos_jogador < 1.0 cartoes -> "nenhuma advertencia do jogador registrada na sumula"

    veta Reincidencia_Amarelo motivo "sem advertencia previa registrada nao ha segunda advertencia; pedido do assistente, do banco ou do capitao nao e registro"

    etapa 1 "conferir a sumula antes de qualquer segunda advertencia" prazo 10 s

    desfecho: "infracao atual sancionada por si so, sem reincidencia" reavaliar_em 1 min
}

lance Revisao_VAR_Prolongada {
    lei_ifab "Protocolo VAR do IFAB"

    gatilho: tempo_revisao_var > 5.0 min -> "revisao em andamento alem do prazo protocolar: decisao final no monitor de campo"

    etapa 1 "arbitro vai ao monitor de campo (OFR)" prazo 1 min
    etapa 2 "VAR comunica o resultado da revisao; sem resultado registrado, nenhuma marcacao e apresentada como confirmada ou revertida pelo VAR" prazo 1 min

    escalonar: tempo_revisao_var > 5.0 min -> VAR "revisao alem do prazo protocolar exige conclusao formal do VAR"

    desfecho: "marcacao original mantida ou revertida conforme o resultado da revisao" reavaliar_em 1 min
}

// -----------------------------------------------------------------------------
// 3) ESQUEMA DE CONTROLE — contextos (analogo das populacoes/areas)
//
// `proibe` so quando a infracao NAO EXISTE no contexto. O que o contexto muda de
// procedimento, revisao ou rigor vai em `exige`. Nao ha `ajusta`: neste dominio o
// fator nao tem semantica operacional — nao existe escala de gravidade para ele
// multiplicar —, e um numero no prompt so fingiria uma.
// -----------------------------------------------------------------------------

contexto Acrescimos {
    criterio "minutos finais de cada tempo, alem dos 45/90 regulamentares"
    exige "quarto arbitro exibe o tempo minimo de acrescimo antes do inicio do periodo"
    exige "perda de tempo nos acrescimos continua sancionavel: o tempo perdido e acrescido e o atraso deliberado pode ser advertido"
}

contexto Disputa_Penaltis {
    criterio "definicao por cobrancas alternadas apos empate ao fim da prorrogacao"
    proibe Impedimento motivo "nao ha jogo corrido na disputa de penaltis: a regra de impedimento nao se aplica"
    proibe Contato_Goleiro_Area motivo "nao ha jogo corrido na disputa de penaltis: nao existe oportunidade de gol a negar"
    proibe Reincidencia_Amarelo motivo "advertencias do tempo de jogo nao passam para a disputa de penaltis (Lei 10)"
    exige "arbitro confirma a ordem pre-definida de cobradores antes de cada rodada"
    exige "infracao do goleiro ou do cobrador na cobranca segue a Lei 14 (cobranca repetida ou anulada), nao a de jogo corrido"
}

contexto Competicao_Sem_VAR {
    criterio "competicao ou fase da competicao sem disponibilidade de revisao por video"
    exige "nao ha revisao por video: nenhuma decisao pode depender do VAR nem ser apresentada como confirmada por ele"
    exige "arbitro assistente reforca a cobertura de angulos que o VAR normalmente supriria"
}

contexto Categoria_Base {
    criterio "competicoes de categorias de formacao (sub-15, sub-17, sub-20)"
    exige "as Leis do Jogo valem integralmente: jogo brusco grave continua sendo expulsao"
    exige "comissao tecnica e comunicada verbalmente antes de qualquer cartao vermelho"
}

// -----------------------------------------------------------------------------
// 4) REGRAS GLOBAIS
// -----------------------------------------------------------------------------

regra_global: "Nenhuma decisao disciplinar pode ser tomada sem que o arbitro tenha visao clara do lance ou confirmacao do arbitro assistente" severidade alta referencia "IFAB Law 5"
regra_global: "A regra da vantagem prevalece quando o time prejudicado mantem controle e progressao da jogada" severidade moderada referencia "IFAB Law 5 — Advantage"
regra_global: "Toda revisao do VAR deve ser concluida em ate 5 minutos, exceto verificacao de identidade de jogador" severidade alta referencia "Protocolo VAR IFAB"
regra_global: "Nenhuma marcacao pode ser apresentada como confirmada ou revertida pelo VAR sem o resultado da revisao registrado" severidade alta referencia "Protocolo VAR IFAB"
regra_global: "Fato que so aparece no pedido — zona do contato, goleiro batido, vantagem, posicao do braco, visao do lance — nao e leitura da partida: sem o dado, a justificativa declara evidencia insuficiente" severidade alta
regra_global: "Cartao vermelho por dupla advertencia exige registro sequencial das duas amarelas na sumula" severidade alta
regra_global: "Penalti e expulsao automatica exigem comunicacao formal a comissao disciplinar em ate 24 horas" severidade alta referencia "Codigo Disciplinar CBF/FIFA"
regra_global: "Decisao revertida pelo VAR deve ser sinalizada publicamente pelo arbitro via monitor de revisao" severidade moderada referencia "Protocolo VAR IFAB"

// =============================================================================
// ESQUEMA DE DADOS — universo fechado de respostas do assistente de arbitragem
//
// Toda decisao tem conduta: na decodificacao incremental, a clausula so realiza
// decisoes que alguma conduta da `sequencia` realiza.
// =============================================================================

esquema_dados AssistenteArbitragem_v1 {
    decisoes [
        ADVERTENCIA_VERBAL, CARTAO_AMARELO, CARTAO_VERMELHO, PENALTI,
        TIRO_LIVRE_DIRETO, TIRO_LIVRE_INDIRETO, MANTER_JOGO, PARALISAR_JOGO,
        ACIONAR_VAR, ANULAR_GOL, CONFIRMAR_GOL, EXPULSAR, BLOQUEAR_DECISAO
    ]
    reinicios [ BOLA_AO_CHAO, TIRO_LIVRE_DIRETO, TIRO_LIVRE_INDIRETO, PENALTI, ESCANTEIO, TIRO_DE_META, ARREMESSO_LATERAL, SEM_PARALISACAO ]
    alertas [ INFORMATIVO, ATENCAO, CRITICO, BLOQUEANTE ]

    conduta Emitir_Advertencia_Verbal {
        decisao ADVERTENCIA_VERBAL
        justificativa_obrigatoria nao
    }

    conduta Aplicar_Cartao_Amarelo {
        decisao CARTAO_AMARELO
        reinicio TIRO_LIVRE_INDIRETO
        requer_var nao
        justificativa_obrigatoria sim
        protocolo_ifab "Lei 12"
    }

    conduta Aplicar_Cartao_Vermelho {
        decisao CARTAO_VERMELHO
        requer_var sim
        justificativa_obrigatoria sim
        protocolo_ifab "Lei 12"
    }

    conduta Expulsar_Jogador {
        decisao EXPULSAR
        justificativa_obrigatoria sim
        protocolo_ifab "Lei 12"
    }

    conduta Marcar_Penalti {
        decisao PENALTI
        reinicio PENALTI
        requer_var sim
        justificativa_obrigatoria sim
        protocolo_ifab "Lei 14"
    }

    conduta Marcar_Tiro_Livre_Direto {
        decisao TIRO_LIVRE_DIRETO
        reinicio TIRO_LIVRE_DIRETO
        justificativa_obrigatoria sim
        protocolo_ifab "Lei 13"
    }

    conduta Marcar_Tiro_Livre_Indireto {
        decisao TIRO_LIVRE_INDIRETO
        reinicio TIRO_LIVRE_INDIRETO
        justificativa_obrigatoria sim
        protocolo_ifab "Lei 13"
    }

    conduta Paralisar_Jogo {
        decisao PARALISAR_JOGO
        justificativa_obrigatoria sim
    }

    conduta Manter_Jogo {
        decisao MANTER_JOGO
        justificativa_obrigatoria sim
    }

    conduta Acionar_Revisao_VAR {
        decisao ACIONAR_VAR
        requer_var sim
        justificativa_obrigatoria sim
    }

    conduta Anular_Gol {
        decisao ANULAR_GOL
        requer_var sim
        justificativa_obrigatoria sim
    }

    conduta Confirmar_Gol {
        decisao CONFIRMAR_GOL
        justificativa_obrigatoria sim
    }

    // O arbitro RECUSA a decisao que lhe pediram, por falta de base ou de
    // seguranca — ex.: segundo amarelo sem advertencia previa registrada. Nao e
    // o jeito de dizer que uma infracao foi descartada (isso e MANTER_JOGO) nem o
    // mecanismo `regra_seguranca: bloquear_decisao`, que restringe a politica.
    conduta Bloquear_Decisao_Insegura {
        decisao BLOQUEAR_DECISAO
        requer_var nao
        justificativa_obrigatoria sim
    }
}

// -----------------------------------------------------------------------------
// Decisao de referencia. Nao afirma revisao do VAR que a leitura nao registra, e
// nao usa BLOQUEAR_DECISAO para descartar infracao.
// -----------------------------------------------------------------------------

arbitragem Arbitragem_Referencia_Penalti para Penalti_Na_Area {
    esquema_referencia AssistenteArbitragem_v1
    partida "BRA-2026-0142"
    sequencia [ Marcar_Penalti ]

    marcacao Mao_Deliberada decisao PENALTI minuto 78.0 min reinicio PENALTI justificativa "braco acima da linha do ombro, dentro da propria area segundo o arbitro; a zona do contato nao consta da leitura da partida"

    alerta ATENCAO "zona do contato e posicao do braco vem do relato do arbitro, nao da leitura da partida" regra "Penalti_Na_Area"

    auditoria "decisao derivada do lance Penalti_Na_Area sob restricao gramatical e ancoragem no grafo"
}
