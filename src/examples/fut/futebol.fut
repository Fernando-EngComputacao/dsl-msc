// =============================================================================
// Modelo institucional de arbitragem de futebol — escrito a partir das Laws of
// the Game (IFAB) e do Protocolo VAR do IFAB, terceiro dominio do SPC-CML.
//
// ESQUEMA DE CONTROLE -> sincronizado no Neo4j (ground truth factual).
// ESQUEMA DE DADOS    -> exportado como BNF para a decodificacao restrita.
//
// Escala deliberadamente proxima da do dominio agricola (lavoura.agro): 10
// infracoes contra 9 produtos, 4 lances contra 3-4 protocolos/culturas, 4
// contextos contra 3-4 populacoes/areas — o suficiente para exercer todos os
// mecanismos (bloqueio por leitura de partida, veto por lance, ajuste por
// contexto, agravante entre infracoes) sem duplicar o volume do modelo clinico.
//
// As condicoes que decidem uma sancao sao ESTRUTURADAS (parametro, operador,
// limiar), lidas da leitura corrente da partida (minuto, cartoes, distancias).
// O que aparece como STRING e justificativa para o arbitro ler, nunca criterio
// de decisao — decidir por prosa devolveria ao LLM a autoridade que a
// arquitetura tira dele.
// =============================================================================

// -----------------------------------------------------------------------------
// 1) ESQUEMA DE CONTROLE — infracoes
// -----------------------------------------------------------------------------

infracao Carga_Imprudente {
    classe falta_pessoal
    lei_ifab "Lei 12.1 — Careless charging"
    var_revisavel nao

    sancao NENHUM
    reinicios [ TIRO_LIVRE_DIRETO ]

    zona_penal: AREA_PROPRIA -> PENALTI "carga imprudente cometida dentro da propria area penal"

    isento: "disputa normal de bola com contato minimo e sem risco ao adversario" excecao "contato com uso excessivo de forca"

    confusao_comum: "Entrada_Violenta" mitigacao "avaliar intensidade do contato e risco real ao adversario antes de escalar a sancao"
}

infracao Entrada_Violenta {
    classe jogo_violento
    lei_ifab "Lei 12.3 — Serious foul play"
    var_revisavel sim

    sancao CARTAO_VERMELHO
    reinicios [ TIRO_LIVRE_DIRETO ]

    limiar: distancia_bola > 2.0 m -> CARTAO_VERMELHO "contato ocorre longe da disputa da bola, caracterizando jogo violento"

    agravante: Carga_Imprudente gravidade alta ("mesmo padrao de contato, mas com uso excessivo de forca e risco elevado a integridade do adversario") conduta "revisar em camera lenta antes de confirmar a expulsao"

    isento: "disputa legitima pela bola com contato inevitavel e proporcional" excecao "uso claro de forca excessiva ou brutalidade"
}

infracao Mao_Deliberada {
    classe mao_na_bola
    lei_ifab "Lei 12.1 — Handling the ball"
    var_revisavel sim

    sancao NENHUM
    reinicios [ TIRO_LIVRE_DIRETO, PENALTI ]

    zona_penal: AREA_PROPRIA -> PENALTI "toque deliberado de mao dentro da propria area penal"

    limiar: distancia_bola < 1.0 m -> BLOQUEAR_DECISAO "contato a curtissima distancia pode ser reacao natural e nao intencional"

    monitorar: "posicao do braco em relacao ao corpo e se torna o corpo artificialmente maior" a_cada 1 partida alvo "criterio de intencionalidade do IFAB"

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
    lei_ifab "Lei 12.3 — Dissent"
    var_revisavel nao

    sancao CARTAO_AMARELO
    reinicios [ TIRO_LIVRE_INDIRETO ]

    limiar: faltas_acumuladas_time >= 5.0 faltas -> CARTAO_VERMELHO "linguagem ofensiva ou insultuosa dirigida a arbitragem"

    monitorar: "tom e conteudo da manifestacao dirigida a arbitragem" a_cada 1 partida
}

infracao Perda_Tempo {
    classe perda_tempo
    lei_ifab "Lei 12.3 — Delaying the restart of play"
    var_revisavel nao

    sancao CARTAO_AMARELO
    reinicios [ TIRO_LIVRE_INDIRETO ]

    limiar: acrescimo > 0.0 min -> BLOQUEAR_DECISAO "tempo perdido ja compensado pelo acrescimo em andamento"

    isento: "atraso natural do jogo sem intencao de retardar o reinicio" excecao "reincidencia do mesmo jogador na mesma partida"
}

infracao Impedimento {
    classe impedimento
    lei_ifab "Lei 11 — Offside"
    var_revisavel sim

    sancao NENHUM
    reinicios [ TIRO_LIVRE_INDIRETO ]

    limiar: jogadores_entre_bola_e_gol >= 2.0 jogadores -> BLOQUEAR_DECISAO "ha ao menos dois adversarios mais proximos da linha de fundo — posicao legal"

    monitorar: "linha de impedimento no momento exato do ultimo toque do companheiro" a_cada 1 partida alvo "tolerancia de calibracao do sistema semiautomatico"

    isento: "jogador na propria metade de campo no momento do passe" excecao "interferencia clara no lance a partir de posicao adiantada"
}

infracao Contato_Goleiro_Area {
    classe dogso
    lei_ifab "Lei 12.3 — Denying an obvious goal-scoring opportunity"
    var_revisavel sim

    sancao CARTAO_VERMELHO
    reinicios [ TIRO_LIVRE_DIRETO, PENALTI ]

    zona_penal: AREA_PROPRIA -> PENALTI "infracao do goleiro dentro da propria area impedindo gol claro"

    limiar: distancia_gol > 40.0 m -> BLOQUEAR_DECISAO "distancia do gol nao caracteriza oportunidade clara e obvia"

    agravante: Entrada_Violenta gravidade alta ("contato de goleiro com uso excessivo de forca soma-se a negacao da chance clara de gol") conduta "confirmar via VAR antes de expulsar"
}

infracao Cusparada {
    classe conduta_antidesportiva
    lei_ifab "Lei 12.3 — Spitting"
    var_revisavel sim

    sancao CARTAO_VERMELHO
    reinicios [ TIRO_LIVRE_DIRETO ]

    isento: "nenhuma — conduta sempre sancionavel quando confirmada" excecao "impossibilidade de identificar o autor mesmo apos revisao"
}

infracao Reincidencia_Amarelo {
    classe conduta_antidesportiva
    lei_ifab "Lei 12.3 — Second caution"
    var_revisavel nao

    sancao CARTAO_AMARELO reincidencia CARTAO_VERMELHO
    reinicios [ TIRO_LIVRE_INDIRETO ]

    limiar: cartoes_amarelos_jogador < 1.0 cartoes -> BLOQUEAR_DECISAO "nao ha advertencia previa registrada para configurar reincidencia"

    monitorar: "acumulo de cartoes amarelos do jogador na partida" a_cada 1 partida alvo "expulsao automatica na segunda advertencia"
}

// -----------------------------------------------------------------------------
// 2) ESQUEMA DE CONTROLE — lances
// -----------------------------------------------------------------------------

lance Penalti_Na_Area {
    lei_ifab "Lei 14 — The Penalty Kick"

    gatilho: distancia_gol <= 16.5 m -> "possivel infracao dentro da area penal: verificar zona exata do contato"
    gatilho: tempo_revisao_var > 5.0 min -> "revisao prolongada: arbitro deve ir ao monitor de campo"

    etapa 1 "arbitro assistente sinaliza possivel infracao com a bandeira sem interromper o jogo se houver vantagem" prazo 10 s
    etapa 2 "VAR verifica automaticamente o lance e recomenda revisao ao arbitro principal" prazo 60 s
    etapa 3 "arbitro vai ao monitor de campo (OFR) e confirma ou reverte a marcacao original" prazo 5 min

    recomenda Mao_Deliberada indicacao "toque de mao claro e intencional dentro da propria area"
    recomenda Contato_Goleiro_Area indicacao "contato do goleiro que impede chance clara de gol dentro da area"

    veta Impedimento motivo "posicao de impedimento anula o penalti antes mesmo da infracao na area"

    escalonar: tempo_revisao_var > 5.0 min -> VAR "revisao alem do prazo protocolar exige confirmacao formal do VAR"

    desfecho: "penalti marcado e cobranca executada, ou lance mantido como estava em campo" reavaliar_em 1 min
}

lance Impedimento_Ataque {
    lei_ifab "Lei 11 — Offside"

    gatilho: distancia_ultimo_defensor < 0.0 m -> "atacante a frente do penultimo defensor no momento do passe: checar linha semiautomatica"
    gatilho: jogadores_entre_bola_e_gol < 2.0 jogadores -> "menos de dois adversarios entre o atacante e a linha de fundo"

    etapa 1 "sistema de impedimento semiautomatico traca a linha no momento exato do ultimo toque" prazo 5 s
    etapa 2 "arbitro assistente confirma ou reve a sinalizacao inicial" prazo 15 s

    recomenda Impedimento indicacao "posicao adiantada confirmada com interferencia clara no lance"

    veta Contato_Goleiro_Area motivo "gol anulado por impedimento nao gera analise disciplinar sobre o goleiro"

    escalonar: distancia_ultimo_defensor < 0.0 m -> ARBITRO_ASSISTENTE "linha limitrofe exige confirmacao visual antes da sinalizacao"

    desfecho: "gol confirmado, gol anulado ou tiro livre indireto marcado" reavaliar_em 2 min
}

lance Conduta_Violenta_Jogo {
    lei_ifab "Lei 12.3 — Serious foul play and violent conduct"

    gatilho: distancia_bola > 2.0 m -> "contato longe da disputa pela bola: possivel jogo violento"
    gatilho: minuto_partida > 90.0 min -> "conduta violenta apos o apito final ainda e passivel de sancao via sumula"

    etapa 1 "arbitro para o jogo imediatamente, independente da vantagem" prazo 5 s
    etapa 2 "VAR reve automaticamente todo cartao vermelho antes da retomada do jogo" prazo 90 s

    recomenda Entrada_Violenta indicacao "contato com uso excessivo de forca e risco ao adversario"
    recomenda Cusparada indicacao "conduta antidesportiva grave confirmada por imagem"

    veta Dissenso motivo "conduta violenta e sancionada isoladamente, sem acumular com dissenso pelo mesmo lance"

    escalonar: minuto_partida > 90.0 min -> COMISSAO_DISCIPLINAR "conduta identificada apos o termino exige processo disciplinar via sumula"

    desfecho: "expulsao confirmada e time reduzido a dez jogadores" reavaliar_em 1 min
}

lance Disputa_Bola_Dividida {
    lei_ifab "Lei 12.1 — Careless, reckless or using excessive force"

    gatilho: velocidade_bola > 0.0 km/h -> "bola em jogo no momento do contato: avaliar criterio de vantagem"
    gatilho: placar_diferenca <= -2.0 gols -> "time em desvantagem grande: atencao redobrada a faltas taticas"

    etapa 1 "arbitro avalia se o time prejudicado mantem controle e progressao da jogada" prazo 3 s
    etapa 2 "se a vantagem nao se concretizar em ate 3 segundos, o jogo retorna ao momento da infracao" prazo 3 s

    recomenda Carga_Imprudente indicacao "contato normal de jogo com uso de forca alem do razoavel"

    veta Simulacao motivo "disputa de bola real dividida nao caracteriza simulacao"

    escalonar: placar_diferenca <= -2.0 gols -> ARBITRO_PRINCIPAL "faltas taticas repetidas em contexto de placar adverso exigem atencao redobrada"

    desfecho: "vantagem aplicada ou jogo paralisado com marcacao de falta" reavaliar_em 1 min
}

// -----------------------------------------------------------------------------
// 3) ESQUEMA DE CONTROLE — contextos (analogo das populacoes/areas)
// -----------------------------------------------------------------------------

contexto Acrescimos {
    criterio "minutos finais de cada tempo, alem dos 45/90 regulamentares"
    proibe Perda_Tempo motivo "criterio de perda de tempo ja embutido no calculo do acrescimo pelo quarto arbitro"
    ajusta Dissenso fator 1.5 motivo "maior tensao no encerramento do jogo exige tolerancia reduzida a reclamacoes"
    exige "quarto arbitro exibe o tempo minimo de acrescimo antes do inicio do periodo"
}

contexto Disputa_Penaltis {
    criterio "definicao por cobrancas alternadas apos empate ao fim da prorrogacao"
    proibe Impedimento motivo "regra de impedimento nao se aplica durante a disputa de penaltis"
    proibe Perda_Tempo motivo "tempo de cobranca e regulado por cronometro proprio da disputa"
    ajusta Mao_Deliberada fator 1.0 motivo "handling do goleiro na linha segue os mesmos criterios do jogo normal"
    exige "arbitro confirma a ordem pre-definida de cobradores antes de cada rodada"
}

contexto Competicao_Sem_VAR {
    criterio "competicao ou fase da competicao sem disponibilidade de revisao por video"
    proibe Contato_Goleiro_Area motivo "confirmacao de DOGSO sem VAR depende exclusivamente da visao de campo do arbitro"
    ajusta Mao_Deliberada fator 0.75 motivo "sem revisao de imagem, criterio de intencionalidade exige maior cautela na marcacao"
    exige "arbitro assistente reforca a cobertura de angulos que o VAR normalmente supriria"
}

contexto Categoria_Base {
    criterio "competicoes de categorias de formacao (sub-15, sub-17, sub-20)"
    proibe Entrada_Violenta motivo "protocolo de categoria de base prioriza cartao amarelo educativo antes da expulsao, salvo risco grave"
    ajusta Dissenso fator 0.5 motivo "abordagem pedagogica reduz o rigor disciplinar em categorias de formacao"
    exige "comissao tecnica e comunicada verbalmente antes de qualquer cartao vermelho"
}

// -----------------------------------------------------------------------------
// 4) INVARIANTES DE SEGURANCA (arestas globais do grafo)
// -----------------------------------------------------------------------------

regra_seguranca: bloquear_decisao Contato_Goleiro_Area se distancia_gol > 40.0 m ("distancia da meta nao caracteriza oportunidade clara e obvia de gol")
regra_seguranca: bloquear_decisao Reincidencia_Amarelo se cartoes_amarelos_jogador < 1.0 cartoes ("nao ha advertencia previa registrada para configurar reincidencia")
regra_seguranca: bloquear_decisao Impedimento se jogadores_entre_bola_e_gol >= 2.0 jogadores ("ha ao menos dois adversarios mais proximos da linha de fundo — posicao legal")
regra_seguranca: bloquear_decisao Mao_Deliberada se distancia_bola < 1.0 m ("contato a curtissima distancia caracteriza reacao natural, nao infracao deliberada")
regra_seguranca: bloquear_decisao Perda_Tempo se acrescimo > 0.0 min ("tempo perdido ja compensado pelo acrescimo em andamento")
regra_seguranca: bloquear_decisao Entrada_Violenta se distancia_bola <= 1.0 m ("contato ocorre dentro do raio normal de disputa pela bola")

regra_global: "Nenhuma decisao disciplinar pode ser tomada sem que o arbitro tenha visao clara do lance ou confirmacao do arbitro assistente" severidade alta referencia "IFAB Law 5"
regra_global: "A regra da vantagem prevalece quando o time prejudicado mantem controle e progressao da jogada" severidade moderada referencia "IFAB Law 5 — Advantage"
regra_global: "Toda revisao do VAR deve ser concluida em ate 5 minutos, exceto verificacao de identidade de jogador" severidade alta referencia "Protocolo VAR IFAB"
regra_global: "Cartao vermelho por dupla advertencia exige registro sequencial das duas amarelas na sumula" severidade alta
regra_global: "Penalti e expulsao automatica exigem comunicacao formal a comissao disciplinar em ate 24 horas" severidade alta referencia "Codigo Disciplinar CBF/FIFA"
regra_global: "Decisao revertida pelo VAR deve ser sinalizada publicamente pelo arbitro via monitor de revisao" severidade moderada referencia "Protocolo VAR IFAB"

// =============================================================================
// ESQUEMA DE DADOS — universo fechado de respostas do assistente de arbitragem
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

    conduta Marcar_Penalti {
        decisao PENALTI
        reinicio PENALTI
        requer_var sim
        justificativa_obrigatoria sim
        protocolo_ifab "Lei 14"
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

    conduta Bloquear_Decisao_Insegura {
        decisao BLOQUEAR_DECISAO
        requer_var sim
        justificativa_obrigatoria sim
    }
}

// -----------------------------------------------------------------------------
// Decisao de referencia — exemplar few-shot do grammar prompting.
// -----------------------------------------------------------------------------

arbitragem Arbitragem_Referencia_Penalti para Penalti_Na_Area {
    esquema_referencia AssistenteArbitragem_v1
    partida "BRA-2026-0142"
    sequencia [ Acionar_Revisao_VAR, Marcar_Penalti, Aplicar_Cartao_Amarelo ]

    marcacao Mao_Deliberada decisao PENALTI minuto 78.0 min reinicio PENALTI justificativa "revisao do VAR confirma contato deliberado do braco dentro da area"
    marcacao Simulacao decisao BLOQUEAR_DECISAO minuto 78.0 min reinicio SEM_PARALISACAO justificativa "toque na bola ja classificado como infracao real, simulacao descartada pela mesma revisao"

    alerta CRITICO "penalti confirmado apos revisao de 3 minutos no monitor de campo" regra "Penalti_Na_Area/escalonar"
    alerta BLOQUEANTE "chamada de simulacao negada pela mesma jogada ja sancionada como penalti" regra "regra_seguranca/Simulacao"

    auditoria "decisao derivada do lance Penalti_Na_Area sob restricao gramatical e ancoragem no grafo"
}
