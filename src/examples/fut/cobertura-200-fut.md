# Cobertura dos 200 cenários de futebol pelo modelo `futebol.fut`

Gerado a partir de três fontes, nesta ordem de autoridade:

1. **Execução real** dos 200 cenários de `cenarios-200-fut.jsonl` pela sequência de `server.ts::processarFut` até a política efetiva: `retrieveFutConstraints` → foco (nome escrito + arestas; sem índice vetorial) → `filtrarPorFocoFut` → poda. A Ĝ de cada cenário foi construída pelo `grammar_from_kg.py` real.
2. **Classificação individual** de cada cenário, feita lendo a fala e a telemetria. A classe diz se os dados **estruturados** permitem decidir o que a fala pergunta.
3. **Esperado pelo modelo**: o que as regras declaradas no `.fut` preveem para a telemetria do cenário, calculado sem reusar o código do pipeline.

Não há *golden answer* formal para estes 200 cenários: o status de todos é **REQUER AVALIAÇÃO**. A coluna "camada determinística" diz se exclusão e escalonamento saíram como o modelo declara.

A fala nunca é evidência. "Dentro da própria área", "goleiro batido", "vantagem clara", "confirmado pelo VAR" são perguntas ou alegações do usuário. Sem o dado estruturado correspondente, a regra não incide e a lacuna é registrada.

## Resumo

| Classe | Cenários |
|---|---|
| COBERTO | 27 |
| COBERTO COM CONTEXTO | 11 |
| LACUNA DE DADOS | 143 |
| LACUNA DE MODELO | 14 |
| AMBÍGUO | 5 |
| **Total** | **200** |

Camada determinística conforme ao modelo: **200/200**. Ĝ sem problema: **200/200** (universo de 13 decisões fechado; decisões do alvo na Ĝ = política; infração excluída sem decisão de sanção; nenhum par fora da política determinística).

| Fenômeno (bloco) | COBERTO | C. CONTEXTO | LAC. DADOS | LAC. MODELO | AMBÍGUO |
|---|---|---|---|---|---|
| Carga_Imprudente (001–020) | 1 | 0 | 19 | 0 | 0 |
| Entrada_Violenta (021–040) | 0 | 1 | 18 | 1 | 0 |
| Mao_Deliberada (041–060) | 6 | 1 | 10 | 2 | 1 |
| Simulacao (061–080) | 1 | 1 | 14 | 2 | 2 |
| Dissenso (081–100) | 0 | 0 | 17 | 3 | 0 |
| Perda_Tempo (101–120) | 0 | 2 | 18 | 0 | 0 |
| Impedimento (121–140) | 11 | 1 | 7 | 0 | 1 |
| Contato_Goleiro_Area (141–160) | 1 | 0 | 17 | 1 | 1 |
| Cusparada (161–180) | 0 | 2 | 13 | 5 | 0 |
| Reincidencia_Amarelo (181–200) | 7 | 3 | 10 | 0 | 0 |

## Lacunas

| Código | Tipo | O que falta | Representação estruturada proposta | Cenários |
|---|---|---|---|---|
| ZONA | dados | zona do lance em relação ao infrator (dentro/fora da própria área) | zona_evento: AREA_PROPRIA / AREA_ADVERSARIA / MEIO_CAMPO / ULTIMO_TERCO (o enum FieldZone já existe) | 37 |
| FORCA | dados | intensidade do contato: imprudente, temerário, força excessiva | intensidade_contato: IMPRUDENTE / TEMERARIO / FORCA_EXCESSIVA | 33 |
| CONTATO | dados | houve contato, e se ele explica a queda | contato_registrado (0/1), contato_explica_queda (0/1) | 21 |
| BRACO | dados | posição e movimento do braço | braco_posicao: NATURAL / ACIMA_OMBRO / AMPLIANDO_CORPO; braco_em_direcao_a_bola (0/1) | 14 |
| DESVIO | dados | bola desviada, ou jogada deliberada do defensor | desvio_previo (0/1), jogada_deliberada_defensor (0/1) | 1 |
| VAR_RES | dados | resultado da revisão do VAR (tempo_revisao_var só diz a duração) | var_resultado: SEM_REVISAO / EM_ANDAMENTO / CONFIRMOU / REVERTEU | 16 |
| VISAO | dados | visão do lance pelo árbitro, pelo assistente ou pelo quarto árbitro | visao_lance: CLARA / PARCIAL / NENHUMA; confirmacao_assistente (0/1) | 8 |
| TOM | dados | conteúdo ofensivo, insultuoso ou abusivo da manifestação | conteudo_ofensivo (0/1) | 19 |
| ATRASO | dados | duração e deliberação do atraso; advertências verbais anteriores | atraso_reinicio_s, advertencias_verbais_atraso | 22 |
| INTERF | dados | interferência do atacante no lance | interferencia_lance (0/1) | 11 |
| BOLA_POS | dados | atacante à frente da bola e na metade adversária | atacante_a_frente_da_bola (0/1), na_metade_adversaria (0/1) | 8 |
| DOGSO | dados | controle da bola, direção do gol, defensores em condição de intervir | controle_bola (0/1), direcao_ao_gol (0/1), defensores_em_condicao | 18 |
| VANT | dados | vantagem em curso: controle, progressão, benefício | vantagem_em_curso (0/1) | 2 |
| SPA | dados | ataque promissor interrompido | ataque_promissor_interrompido (0/1) | 4 |
| AUTOR | dados | autor identificado e papel do infrator | autor_identificado (0/1), papel_infrator: JOGADOR / GOLEIRO / RESERVA / OFICIAL | 11 |
| ALVO | dados | a cusparada foi dirigida a uma pessoa | alvo_atingido (0/1) | 12 |
| BOLA_JOGO | dados | bola em jogo no momento (velocidade 0 não é bola fora de jogo) | bola_em_jogo (0/1) | 5 |
| LOCAL | dados | dentro ou fora do campo de jogo | dentro_do_campo (0/1) | 1 |
| EXPULSO | dados | o jogador já foi expulso | jogador_ja_expulso (0/1) | 1 |
| APITO | modelo | partida encerrada: minuto_partida > 90 + acrescimo | a DSL só compara parâmetro com constante; precisa de condição entre parâmetros ou de variável derivada | 2 |
| RETAKE | modelo | repetir a cobrança (Lei 14) | decisão ausente do enum fechado Decision | 3 |
| SEM_VAR | modelo | competição sem VAR deveria retirar ACIONAR_VAR | contexto só proíbe/ajusta infração; não restringe decisão | 7 |
| SANCAO | modelo | sanção declarada por infração | a política admite as 13 decisões para toda infração aplicável: sancao/zona_penal não restringem | 2 |
| REINICIO | modelo | reinícios declarados por infração | os meios da política são todos os reinícios do esquema | 1 |
| EXIGE | modelo | orientação de contexto (exige) | vai ao grafo, mas não chega ao Prompt Semântico | 15 |
| OFICIAL | modelo | sanção a reservas e oficiais | papel do infrator não modelado | 3 |
| MULTI | modelo | duas marcações da mesma infração no mesmo artefato | o contrato admite uma cláusula por item | 3 |
| ATACANTE | modelo | mão do atacante imediatamente antes do gol anula o gol mesmo acidental | regra de Lei 12 sem representação | 1 |

Nenhuma variável de dados acima pode entrar no modelo sem mudar a gramática: `MatchParameter` é um vocabulário fechado em `futebol.langium`.

## A. Matriz de cobertura

| ID | Prompt resumido | Conceito | Regra responsável | Dados suficientes? | Decisão determinável? | Lacuna | Classe |
|---|---|---|---|---|---|---|---|
| 001 | Carga na própria área: vira pênalti? | Carga imprudente + zona | Carga_Imprudente (zona_penal AREA_PROPRIA) | Não | Não | ZONA, FORCA | LACUNA DE DADOS |
| 002 | Ombro na dividida a 38 m: falta ou jogo normal? | Contato legal × carga | Carga_Imprudente (isento) | Não | Não | FORCA | LACUNA DE DADOS |
| 003 | Carga fora da área a 0.6 m: tiro livre direto | Carga fora da área | Carga_Imprudente; conduta Marcar_Tiro_Livre_Direto | Não | Condicional (TLD se fora da área) | ZONA | LACUNA DE DADOS |
| 004 | Carga na área, VAR há 2 min: confirma pênalti | Carga + zona + VAR | Carga_Imprudente (zona_penal); regra global do VAR | Não | Não | ZONA, VAR_RES | LACUNA DE DADOS |
| 005 | Carga a 3.5 m da bola escala p/ violenta? (EV já marcada) | Escalada de gravidade | Entrada_Violenta (agravante); Conduta_Violenta_Jogo (db>2) | Parcial | Não | FORCA | LACUNA DE DADOS |
| 006 | Ombro no ombro, bola a 20 km/h: sigo o jogo? | Contato legal × vantagem | Disputa_Bola_Dividida (etapas de vantagem) | Não | Não | FORCA, VANT | LACUNA DE DADOS |
| 007 | Base sub-17, contato leve: cartão ou verbal? | Carga em categoria de base | Carga_Imprudente; Categoria_Base (exige) | Não | Não | FORCA; EXIGE | LACUNA DE DADOS |
| 008 | 5 faltas coletivas + carga a 28 m | Faltas coletivas não são critério | Carga_Imprudente | Não | Condicional | ZONA, FORCA | LACUNA DE DADOS |
| 009 | Carga do goleiro fora da área | Carga do goleiro | Carga_Imprudente | Não | Condicional | ZONA, FORCA | LACUNA DE DADOS |
| 010 | Contato tardio na área: pênalti? | Carga + zona | Carga_Imprudente (zona_penal) | Não | Não | ZONA | LACUNA DE DADOS |
| 011 | Acréscimos, carga a 26 m: marca agora | Carga nos acréscimos | Carga_Imprudente; Acrescimos | Não | Condicional | ZONA | LACUNA DE DADOS |
| 012 | Carga tática, perdendo por 2: amarelo? | Falta tática (ataque promissor) | Carga_Imprudente | Não | Não | SPA, FORCA | LACUNA DE DADOS |
| 013 | Carga na entrada da área: revisa no monitor | Carga + zona + VAR | Carga_Imprudente (zona_penal; var_revisavel nao) | Não | Não | ZONA, VAR_RES | LACUNA DE DADOS |
| 014 | Carga, VAR há 6 min: o que faço? | Revisão VAR prolongada | Revisao_VAR_Prolongada (gatilho + escalonar VAR) | Sim (procedimento) | Procedimento | ZONA, VAR_RES (marcação) | COBERTO |
| 015 | Sem VAR, sem visão clara | Carga sem visão do lance | Carga_Imprudente; Competicao_Sem_VAR; regra global da visão | Não | Não | VISAO; SEM_VAR | LACUNA DE DADOS |
| 016 | Disputa legítima, contato mínimo | Contato legal | Carga_Imprudente (isento) | Não | Não | FORCA | LACUNA DE DADOS |
| 017 | Goleiro batido, bola parada: pênalti e cartão? | Carga + DOGSO + zona | Carga_Imprudente (zona_penal) | Não | Não | ZONA, DOGSO, BOLA_JOGO | LACUNA DE DADOS |
| 018 | Já advertido + carga: 2º amarelo? (Reinc. marcada) | Reincidência × carga sem cartão | Reincidencia_Amarelo (ca=1: aplicável); Carga_Imprudente (sancao NENHUM) | Parcial | Condicional (se temerária) | FORCA | LACUNA DE DADOS |
| 019 | Vantagem clara: paralisa agora | Vantagem | Disputa_Bola_Dividida (etapas); regra global da vantagem; conduta Paralisar_Jogo | Não | Não | VANT | LACUNA DE DADOS |
| 020 | Carga a 13 m na área, 0x0: confirma | Carga + zona | Carga_Imprudente (zona_penal) | Não | Não | ZONA | LACUNA DE DADOS |
| 021 | Sola no joelho a 3.2 m da bola: expulsa | Jogo violento fora da disputa | Conduta_Violenta_Jogo (db>2) → Conduta_Violenta | Parcial | Não | FORCA | LACUNA DE DADOS |
| 022 | Violenta a 0.8 m numa dividida: vermelho? | Jogo brusco grave | Entrada_Violenta | Parcial | Não | FORCA | LACUNA DE DADOS |
| 023 | Carrinho por trás a 4.1 m: vermelho direto? | Jogo violento fora da disputa | Conduta_Violenta_Jogo (db>2) | Parcial | Não | FORCA | LACUNA DE DADOS |
| 024 | Base sub-15 a 2.6 m: vermelho ou educativo? | Jogo violento em categoria de base | Categoria_Base (exige: Leis integrais); Entrada_Violenta | Parcial | Condicional | FORCA; EXIGE | LACUNA DE DADOS |
| 025 | Pé alto a 1.0 m: ainda é violenta? | Jogo brusco grave | Entrada_Violenta | Não | Não | FORCA | LACUNA DE DADOS |
| 026 | 2.4 m na própria área: pênalti e expulsão? | Violenta + zona | Conduta_Violenta (zona_penal); Conduta_Violenta_Jogo | Não | Não | ZONA, FORCA, BOLA_JOGO | LACUNA DE DADOS |
| 027 | Acréscimos 94 min (+4): ainda cabe sanção? | Aplicabilidade nos acréscimos | Acrescimos; nenhuma exclusão | Sim (aplicabilidade) | Aplicabilidade | FORCA (qual sanção) | COBERTO COM CONTEXTO |
| 028 | Dois chegando forte a 0.5 m (Carga marcada) | Violenta × imprudente | Entrada_Violenta (agravante com Carga_Imprudente) | Não | Não | FORCA | LACUNA DE DADOS |
| 029 | Goleiro fora da área a 2.9 m: vermelho? | Jogo violento do goleiro | Conduta_Violenta_Jogo (db>2) | Parcial | Não | FORCA | LACUNA DE DADOS |
| 030 | 5.5 m com jogo parado: confirma no VAR | Conduta violenta com bola fora de jogo | Conduta_Violenta_Jogo (etapa: VAR revê vermelho) | Parcial | Não | VAR_RES, FORCA, BOLA_JOGO | LACUNA DE DADOS |
| 031 | Contato duro a 0.9 m, caído | Jogo brusco grave | Entrada_Violenta | Não | Não | FORCA | LACUNA DE DADOS |
| 032 | Sem VAR, assistente confirmou: expulsa | Jogo violento sem VAR | Conduta_Violenta_Jogo (db>2); Competicao_Sem_VAR | Não | Não | FORCA, VISAO; SEM_VAR | LACUNA DE DADOS |
| 033 | 2.2 m com 6 faltas: como registro? | Registro disciplinar | Conduta_Violenta_Jogo; regras globais de comunicação | Parcial | Não | FORCA | LACUNA DE DADOS |
| 034 | 1 amarelo + violenta a 3.4 m: direto ou 2º? (Reinc. marcada) | Vermelho direto × reincidência | Entrada_Violenta / Conduta_Violenta (sancao VERMELHO); Reincidencia_Amarelo (ca=1) | Parcial | Condicional (vermelho direto se caracterizada) | FORCA | LACUNA DE DADOS |
| 035 | 0.7 m em disputa legítima: vermelho proporcional? | Proporcionalidade | Entrada_Violenta (isento) | Não | Não | FORCA | LACUNA DE DADOS |
| 036 | Após o apito final (91 min), 6 m | Conduta violenta pós-jogo | Conduta_Violenta; Conduta_Violenta_Jogo | Parcial | Não | FORCA; APITO | LACUNA DE MODELO |
| 037 | 2.1 m, 3x0: revisa no monitor | Revisão de vermelho direto | Conduta_Violenta_Jogo (etapa VAR) | Parcial | Não | VAR_RES, FORCA | LACUNA DE DADOS |
| 038 | Exatamente 1.0 m, reclamou muito | Jogo brusco grave | Entrada_Violenta | Não | Não | FORCA | LACUNA DE DADOS |
| 039 | Base sub-20, 4.6 m, risco grave | Jogo violento em categoria de base | Categoria_Base (exige); Conduta_Violenta_Jogo | Parcial | Condicional | FORCA; EXIGE | LACUNA DE DADOS |
| 040 | 3.1 m na área, perdendo por 2: pênalti + vermelho? | Violenta + zona | Conduta_Violenta (zona_penal) | Não | Não | ZONA, FORCA, BOLA_JOGO | LACUNA DE DADOS |
| 041 | Na área, bola a 3.2 m do braço: pênalti | Mão + zona | Mao_Deliberada (zona_penal); sem exclusão (db≥1) | Não | Não | BRACO, ZONA | LACUNA DE DADOS |
| 042 | Queima-roupa a 0.4 m na área | Reação natural | Mao_Curta_Distancia → veta Mao_Deliberada | Sim | Sim: sem infração de mão | — | COBERTO |
| 043 | Fora da área, braço acima do ombro: TLD? | Braço acima do ombro | Mao_Deliberada | Não | Não | BRACO, ZONA | LACUNA DE DADOS |
| 044 | Braço colado, 1.6 m, na área | Braço em posição natural | Mao_Deliberada (isento) | Não | Não | BRACO, ZONA | LACUNA DE DADOS |
| 045 | Sem VAR, 2.8 m, na área: intencionalidade | Mão sem VAR | Mao_Deliberada; Competicao_Sem_VAR | Não | Não | BRACO, ZONA; SEM_VAR | LACUNA DE DADOS |
| 046 | Goleiro na linha na disputa: repito a cobrança? | Infração do goleiro na cobrança (Lei 14) | Disputa_Penaltis (exige Lei 14) | Parcial | Não | AUTOR; RETAKE | LACUNA DE MODELO |
| 047 | Desvio no companheiro a 0.7 m | Reação natural | Mao_Curta_Distancia | Sim | Sim: sem infração de mão | — | COBERTO |
| 048 | Meio-campo, braço aberto: amarelo também? | Corpo maior + ataque promissor | Mao_Deliberada | Não | Não | BRACO, SPA | LACUNA DE DADOS |
| 049 | Na área, VAR há 7 min: vou ao monitor? | Revisão VAR prolongada | Revisao_VAR_Prolongada | Sim (procedimento) | Procedimento | VAR_RES (resultado) | COBERTO |
| 050 | Mão do atacante antes de marcar: anula | Mão do atacante antes do gol | Mao_Deliberada (sem exclusão: db=1.9) | Não | Não | AUTOR; ATACANTE | LACUNA DE MODELO |
| 051 | 0.9 m em finalização curta: confirma pênalti | Reação natural (contradiz o pedido) | Mao_Curta_Distancia | Sim | Sim: sem infração de mão | — | COBERTO |
| 052 | Acréscimos 90+5, 2.3 m na área | Mão + zona | Mao_Deliberada (zona_penal); Acrescimos | Não | Não | BRACO, ZONA | LACUNA DE DADOS |
| 053 | Base sub-15: mesmo critério do profissional? | Critério em categoria de base | Categoria_Base (exige: Leis integrais) | Sim (critério) | Critério | BRACO, ZONA (decisão); EXIGE | COBERTO COM CONTEXTO |
| 054 | Escanteio, 3.6 m, na área | Mão + zona | Mao_Deliberada (zona_penal) | Não | Não | BRACO, ZONA | LACUNA DE DADOS |
| 055 | Mão a 0.5 m após desvio no próprio corpo | Reação natural | Mao_Curta_Distancia | Sim | Sim: sem infração de mão | — | COBERTO |
| 056 | Fora da área cortando contra-ataque: amarelo e TL? | Mão + ataque promissor | Mao_Deliberada | Não | Não | BRACO, SPA, ZONA | LACUNA DE DADOS |
| 057 | Mão na área, atacante impedido antes | Mão × impedimento anterior | Impedimento_Ataque (dud<0); Mao_Deliberada | Parcial | Não | INTERF, BOLA_POS, BRACO | AMBÍGUO |
| 058 | 1.2 m, braço em movimento para a bola | Movimento deliberado | Mao_Deliberada (sem exclusão: db≥1) | Não | Não | BRACO, ZONA | LACUNA DE DADOS |
| 059 | Sem VAR, assistente não viu, 4.0 m fora | Mão sem visão | Mao_Deliberada; Competicao_Sem_VAR | Não | Não | VISAO, BRACO; SEM_VAR | LACUNA DE DADOS |
| 060 | 0.3 m, chute forte, de costas | Reação natural | Mao_Curta_Distancia | Sim | Sim: sem infração de mão | — | COBERTO |
| 061 | Caiu sozinho sem contato: simulação | Simulação sem contato | Simulacao | Não | Não | CONTATO | LACUNA DE DADOS |
| 062 | Contato real, queda exagerada | Simulação × falta | Simulacao (isento) | Não | Não | CONTATO | LACUNA DE DADOS |
| 063 | VAR confirmando ausência de contato | Simulação "confirmada pelo VAR" | Simulacao; regra global do VAR | Não | Não | VAR_RES, CONTATO | LACUNA DE DADOS |
| 064 | Disputa real, caiu depois | Simulação × disputa | Simulacao | Não | Não | CONTATO | LACUNA DE DADOS |
| 065 | Acréscimos 93 min, vencendo: amarelo? | Simulação nos acréscimos | Simulacao; Acrescimos | Não | Não | CONTATO | LACUNA DE DADOS |
| 066 | Base sub-17: mesmo rigor do profissional | Critério em categoria de base | Categoria_Base (exige) | Sim (critério) | Critério | CONTATO (decisão); EXIGE | COBERTO COM CONTEXTO |
| 067 | 1 amarelo, simula na área: 2º amarelo? (Reinc. marcada) | Reincidência por simulação | Reincidencia_Amarelo (ca=1) | Parcial | Condicional | CONTATO | LACUNA DE DADOS |
| 068 | Sem VAR, visão parcial | Simulação sem visão | Simulacao; Competicao_Sem_VAR | Não | Não | VISAO, CONTATO; SEM_VAR | LACUNA DE DADOS |
| 069 | Encostão leve a 9 m: pênalti ou amarelo? | Falta do goleiro × simulação | Simulacao × Carga_Imprudente | Não | Não | CONTATO, ZONA | AMBÍGUO |
| 070 | Simulação a 35 m: cartão e reinício | Consequência da simulação | Simulacao (sancao AMARELO, reinicios TLI) | Parcial | Condicional (declarada, não imposta) | CONTATO; SANCAO, REINICIO | LACUNA DE MODELO |
| 071 | Handball × simulação a 11 m: como separo? | Duas infrações em disputa | Mao_Deliberada × Simulacao (confusao_comum) | Não | Não | CONTATO, BRACO | AMBÍGUO |
| 072 | 5 faltas, simulação: verbal basta? | Sanção da simulação | Simulacao (sancao AMARELO não imposta) | Parcial | Condicional | CONTATO; SANCAO | LACUNA DE MODELO |
| 073 | Disputa de pênaltis, cobrador cai | Simulação na disputa | Simulacao; Disputa_Penaltis | Não | Não | CONTATO | LACUNA DE DADOS |
| 074 | Perdendo por 2, cai na área: simulação | Simulação (placar não é critério) | Simulacao | Não | Não | CONTATO | LACUNA DE DADOS |
| 075 | Sem contato registrado pelas câmeras | Evidência de imagem | Simulacao; regra global do VAR | Não | Não | VAR_RES, CONTATO | LACUNA DE DADOS |
| 076 | Caiu a 8 m, VAR há 6 min | Revisão VAR prolongada | Revisao_VAR_Prolongada | Sim (procedimento) | Procedimento | VAR_RES | COBERTO |
| 077 | Contato mínimo a 0.3 m: cabe cartão? | Simulação × contato mínimo | Simulacao | Não | Não | CONTATO | LACUNA DE DADOS |
| 078 | Acréscimos 90+2, 21 m | Simulação nos acréscimos | Simulacao; Acrescimos | Não | Não | CONTATO | LACUNA DE DADOS |
| 079 | Assistente viu toque no pé de apoio | Simulação × contato relatado | Simulacao (isento) | Não | Não | CONTATO, VISAO | LACUNA DE DADOS |
| 080 | Base sub-20, 4x0, na área | Simulação em categoria de base | Simulacao; Categoria_Base | Não | Não | CONTATO; EXIGE | LACUNA DE DADOS |
| 081 | Capitão aos gritos, 6 faltas: vermelho? | Dissenso × linguagem ofensiva | Dissenso × Linguagem_Ofensiva (confusao_comum) | Não | Não | TOM | LACUNA DE DADOS |
| 082 | Dissenso contido: amarelo ou conversa? | Gradação do dissenso | Dissenso | Não | Não | TOM | LACUNA DE DADOS |
| 083 | Acréscimos: reduz a tolerância | Tolerância nos acréscimos | Dissenso; Acrescimos (fator removido: sem semântica) | Não | Não | TOM | LACUNA DE DADOS |
| 084 | Base sub-15 reclamando do impedimento | Dissenso em categoria de base | Dissenso; Categoria_Base | Não | Não | TOM; EXIGE | LACUNA DE DADOS |
| 085 | Linguagem ofensiva ao assistente | Linguagem ofensiva | Linguagem_Ofensiva (sancao VERMELHO) | Não | Condicional | TOM | LACUNA DE DADOS |
| 086 | Técnico reclamou e volante emendou | Dissenso de oficial + jogador | Dissenso | Não | Não | AUTOR; OFICIAL | LACUNA DE MODELO |
| 087 | Dissenso após vermelho já aplicado | Infração de jogador já expulso | Dissenso (veto antigo removido) | Não | Não | EXPULSO, AUTOR | LACUNA DE DADOS |
| 088 | Goleiro, 7 faltas: vermelho? | Dissenso × linguagem ofensiva | Dissenso | Não | Não | TOM | LACUNA DE DADOS |
| 089 | 1 amarelo + dissenso: 2º amarelo? (Reinc. marcada) | Reincidência por dissenso | Reincidencia_Amarelo (ca=1) | Parcial | Condicional | TOM | LACUNA DE DADOS |
| 090 | Disputa de pênaltis, reclama da ordem | Dissenso na disputa | Dissenso; Disputa_Penaltis | Não | Não | TOM | LACUNA DE DADOS |
| 091 | Sem VAR, gol anulado, 5 faltas | Dissenso | Dissenso | Não | Não | TOM | LACUNA DE DADOS |
| 092 | Reclamação insistente aos 45 min | Gradação do dissenso | Dissenso | Não | Não | TOM | LACUNA DE DADOS |
| 093 | Dissenso coletivo: sanciona todos | Vários infratores | Dissenso | Não | Não | AUTOR, TOM; MULTI | LACUNA DE MODELO |
| 094 | Base sub-17, linguagem agressiva | Linguagem ofensiva em categoria de base | Linguagem_Ofensiva; Categoria_Base | Não | Não | TOM; EXIGE | LACUNA DE DADOS |
| 095 | Após pênalti não marcado: amarelo? | Dissenso | Dissenso | Não | Não | TOM | LACUNA DE DADOS |
| 096 | Acréscimos 90+4 | Dissenso nos acréscimos | Dissenso; Acrescimos | Não | Não | TOM | LACUNA DE DADOS |
| 097 | Banco de reservas, perdendo por 3 | Dissenso de reservas | Dissenso | Não | Não | AUTOR; OFICIAL | LACUNA DE MODELO |
| 098 | Reclama da falta a 0.4 m: adverte | Dissenso | Dissenso | Não | Não | TOM | LACUNA DE DADOS |
| 099 | 8 faltas: expulsa por linguagem ofensiva | Linguagem ofensiva | Linguagem_Ofensiva | Não | Condicional | TOM | LACUNA DE DADOS |
| 100 | Dissenso leve, sem ofensa: verbal resolve? | Gradação do dissenso | Dissenso | Não | Não | TOM | LACUNA DE DADOS |
| 101 | Goleiro 20 s no tiro de meta: adverte | Retardar o reinício | Perda_Tempo | Não | Não | ATRASO | LACUNA DE DADOS |
| 102 | Acréscimos, goleiro rolando: cartão? | Perda de tempo nos acréscimos | Perda_Tempo; Acrescimos (exige: continua sancionável) | Parcial | Condicional | ATRASO | LACUNA DE DADOS |
| 103 | Substituição arrastada | Retardar o reinício | Perda_Tempo | Não | Não | ATRASO | LACUNA DE DADOS |
| 104 | Lateral aos 88 min: aplica amarelo | Retardar o reinício | Perda_Tempo | Não | Condicional | ATRASO | LACUNA DE DADOS |
| 105 | 90+2, acréscimo sinalizado: ainda cabe cartão? | Acréscimo não compensa a conduta | Acrescimos (exige) | Sim (aplicabilidade) | Aplicabilidade | ATRASO (qual sanção) | COBERTO COM CONTEXTO |
| 106 | Cobrador demorou de propósito | Retardar o reinício | Perda_Tempo | Não | Não | ATRASO | LACUNA DE DADOS |
| 107 | Goleiro atrasando na disputa de pênaltis | Perda de tempo na disputa | Perda_Tempo; Disputa_Penaltis (proibe removido) | Não | Não | ATRASO | LACUNA DE DADOS |
| 108 | Base sub-17, primeira vez | Perda de tempo em categoria de base | Perda_Tempo; Categoria_Base | Não | Não | ATRASO; EXIGE | LACUNA DE DADOS |
| 109 | Atraso natural por atendimento | Atraso sem intenção | Perda_Tempo (isento) | Não | Não | ATRASO | LACUNA DE DADOS |
| 110 | Segunda vez do mesmo jogador | Reincidência de atraso | Perda_Tempo (isento: exceção reincidência) | Não | Não | ATRASO | LACUNA DE DADOS |
| 111 | 90+6 perdendo por 2: faz sentido advertir? | Perda de tempo nos acréscimos | Perda_Tempo; Acrescimos | Não | Não | ATRASO | LACUNA DE DADOS |
| 112 | Sem VAR, goleiro demorando | Retardar o reinício | Perda_Tempo; Competicao_Sem_VAR | Não | Não | ATRASO | LACUNA DE DADOS |
| 113 | 1 amarelo + perda de tempo: 2º amarelo? (Reinc. marcada) | Reincidência por perda de tempo | Reincidencia_Amarelo (ca=1) | Parcial | Condicional | ATRASO | LACUNA DE DADOS |
| 114 | Escanteio, primeira vez: amarelo? | Gradação | Perda_Tempo | Não | Não | ATRASO | LACUNA DE DADOS |
| 115 | 5 faltas + perda de tempo | Faltas coletivas não são critério | Perda_Tempo | Não | Não | ATRASO | LACUNA DE DADOS |
| 116 | 45+2 com acréscimo em andamento: cabe cartão? | Acréscimo não compensa a conduta | Acrescimos (exige) | Sim (aplicabilidade) | Aplicabilidade | ATRASO | COBERTO COM CONTEXTO |
| 117 | Pedindo atendimento sem contato | Simular lesão para atrasar | Perda_Tempo | Não | Não | ATRASO, CONTATO | LACUNA DE DADOS |
| 118 | Base + acréscimos 90+2 | Perda de tempo | Perda_Tempo; Categoria_Base; Acrescimos | Não | Não | ATRASO; EXIGE | LACUNA DE DADOS |
| 119 | Goleiro a 4 m, 86 min: adverte | Retardar o reinício | Perda_Tempo | Não | Não | ATRASO | LACUNA DE DADOS |
| 120 | Reiterada após advertência verbal, 90+3 | Reincidência de atraso | Perda_Tempo; Acrescimos | Não | Não | ATRASO (advertências verbais) | LACUNA DE DADOS |
| 121 | 0.4 m à frente, ninguém até a linha: marca | Posição de impedimento | Impedimento_Ataque (dud<0) | Parcial (posição) | Não | INTERF, BOLA_POS | LACUNA DE DADOS |
| 122 | Dois adversários mais próximos: confirma a marcação | Posição legal (contradiz o pedido) | Posicao_Legal_No_Passe → veta Impedimento | Sim | Sim: sem impedimento | — | COBERTO |
| 123 | 0.2 m à frente pela linha semiautomática: anula | Posição de impedimento | Impedimento_Ataque | Parcial | Não | INTERF, BOLA_POS | LACUNA DE DADOS |
| 124 | 1.8 m atrás: procede? | Posição legal | Posicao_Legal_No_Passe | Sim | Sim: sem impedimento | — | COBERTO |
| 125 | Disputa de pênaltis: impedimento se aplica? | Impedimento inexistente no contexto | Disputa_Penaltis (proibe Impedimento) | Sim | Sim: não se aplica | (invasão do cobrador: Lei 14; RETAKE) | COBERTO COM CONTEXTO |
| 126 | 0.3 m à frente, um adversário: anula | Posição de impedimento | Impedimento_Ataque | Parcial | Não | INTERF, BOLA_POS | LACUNA DE DADOS |
| 127 | Sem VAR, praticamente na linha (+0.1 m) | Posição legal | Posicao_Legal_No_Passe | Sim | Sim: sem impedimento | — | COBERTO |
| 128 | Própria metade no passe, 55 m | Posição legal | Posicao_Legal_No_Passe (dud 2.5) | Sim | Sim: sem impedimento | (metade do campo: BOLA_POS) | COBERTO |
| 129 | 0.6 m à frente, gol marcado: confirmo ou anulo? | Posição de impedimento | Impedimento_Ataque | Parcial | Não | INTERF, BOLA_POS | LACUNA DE DADOS |
| 130 | Base, 0.9 m atrás: mantém a bandeira | Posição legal (contradiz o pedido) | Posicao_Legal_No_Passe | Sim | Sim: sem impedimento | — | COBERTO |
| 131 | VAR há 6 min traçando a linha, 0.1 m à frente | Revisão VAR prolongada | Revisao_VAR_Prolongada; Impedimento_Ataque | Parcial | Procedimento | INTERF, BOLA_POS, VAR_RES | COBERTO |
| 132 | Dois adversários mais próximos: revisa | Posição legal | Posicao_Legal_No_Passe | Sim | Sim: sem impedimento | — | COBERTO |
| 133 | 1.1 m à frente em contra-ataque: anula | Posição de impedimento | Impedimento_Ataque | Parcial | Não | INTERF, BOLA_POS | LACUNA DE DADOS |
| 134 | 0.8 m à frente, sem interferência: marca | Posição sem interferência | Impedimento_Ataque | Parcial | Não | INTERF | LACUNA DE DADOS |
| 135 | 0.2 m atrás aos 90+3: confirma o gol | Posição legal | Posicao_Legal_No_Passe | Sim | Sim: sem impedimento | — | COBERTO |
| 136 | 0.5 m à frente, desvio de zagueiro | Desvio × jogada deliberada | Impedimento_Ataque | Parcial | Não | INTERF, DESVIO | LACUNA DE DADOS |
| 137 | Impedimento e possível pênalti no mesmo lance | Precedência entre infrações | Impedimento_Ataque; Penalti_Na_Area (sem gatilho) | Parcial | Não | INTERF, ZONA | AMBÍGUO |
| 138 | 0.7 m atrás, sinalizado tarde: como reinicio? | Posição legal | Posicao_Legal_No_Passe | Sim | Sim: sem impedimento | (reinício segue a jogada) | COBERTO |
| 139 | Exatamente na linha: anula | Na linha é legal (contradiz o pedido) | Posicao_Legal_No_Passe (dud ≥ 0) | Sim | Sim: sem impedimento | — | COBERTO |
| 140 | 2.2 m atrás, quatro adversários: assistente errou? | Posição legal | Posicao_Legal_No_Passe | Sim | Sim: sem impedimento | — | COBERTO |
| 141 | Goleiro derruba na área, chance clara: pênalti e vermelho? | DOGSO + zona | Contato_Goleiro_Area (zona_penal) | Não | Não | ZONA, DOGSO | LACUNA DE DADOS |
| 142 | Fora da área a 45 m: chance clara? | DOGSO longe do gol | Contato_Goleiro_Area (bloqueio por distância removido) | Parcial | Não | DOGSO | LACUNA DE DADOS |
| 143 | Na área, dois defensores voltando | DOGSO × defensores | Contato_Goleiro_Area | Não | Não | DOGSO, ZONA | LACUNA DE DADOS |
| 144 | Fora da área a 52 m, saída de bola | DOGSO longe do gol | Contato_Goleiro_Area | Parcial | Não | DOGSO | LACUNA DE DADOS |
| 145 | Ia dominar sozinho: confirma expulsão pelo VAR | DOGSO + VAR | Contato_Goleiro_Area (zona_penal); regra global do VAR | Não | Não | ZONA, DOGSO, VAR_RES | LACUNA DE DADOS |
| 146 | Sem VAR, na área, sem visão | DOGSO sem VAR | Contato_Goleiro_Area; Competicao_Sem_VAR (proibe removido) | Não | Não | VISAO, ZONA, DOGSO; SEM_VAR | LACUNA DE DADOS |
| 147 | Força excessiva a 3.1 m na área (EV marcada): agrava? | Agravante | Contato_Goleiro_Area (agravante com Entrada_Violenta) | Parcial | Condicional | FORCA, ZONA | LACUNA DE DADOS |
| 148 | Fora da área a 41 m em progressão: DOGSO? | DOGSO | Contato_Goleiro_Area | Parcial | Não | DOGSO | LACUNA DE DADOS |
| 149 | Na área com atacante impedido antes | DOGSO × impedimento anterior | Impedimento_Ataque (dud<0); Contato_Goleiro_Area | Parcial | Não | INTERF, BOLA_POS | AMBÍGUO |
| 150 | Na área em bola dividida a 0.3 m | DOGSO com tentativa de jogar a bola | Contato_Goleiro_Area (zona_penal: amarelo com tentativa) | Não | Não | ZONA, DOGSO | LACUNA DE DADOS |
| 151 | Último homem, atacante sozinho, 38 m | DOGSO | Contato_Goleiro_Area | Parcial | Não | DOGSO | LACUNA DE DADOS |
| 152 | Disputa de pênaltis, goleiro avançando | DOGSO inexistente no contexto | Disputa_Penaltis (proibe Contato_Goleiro_Area; exige Lei 14) | Sim (exclusão) | Exclusão sim; repetição não | RETAKE | LACUNA DE MODELO |
| 153 | Base sub-17, na área: vermelho ou amarelo? | DOGSO em categoria de base | Contato_Goleiro_Area; Categoria_Base | Não | Não | ZONA, DOGSO; EXIGE | LACUNA DE DADOS |
| 154 | Fora da área a 47 m, junto à lateral | DOGSO improvável | Contato_Goleiro_Area | Parcial | Não | DOGSO | LACUNA DE DADOS |
| 155 | Acréscimos 90+4, na área: marca pênalti | DOGSO + zona | Contato_Goleiro_Area (zona_penal); Acrescimos | Não | Não | ZONA, DOGSO | LACUNA DE DADOS |
| 156 | Mão do goleiro fora da própria área a 22 m | Mão do goleiro fora da área | Contato_Goleiro_Area / Mao_Deliberada | Não | Não | ZONA, DOGSO, AUTOR | LACUNA DE DADOS |
| 157 | Na área, VAR há 7 min: vou ao monitor? | Revisão VAR prolongada | Revisao_VAR_Prolongada | Sim (procedimento) | Procedimento | ZONA, DOGSO, VAR_RES | COBERTO |
| 158 | Fora da área a 44 m, assistente sinalizou: expulsa | DOGSO | Contato_Goleiro_Area | Não | Não | DOGSO, VISAO | LACUNA DE DADOS |
| 159 | Na área, sem ângulo, dois zagueiros: pênalti e qual cartão? | DOGSO + zona | Contato_Goleiro_Area (zona_penal) | Não | Não | ZONA, DOGSO | LACUNA DE DADOS |
| 160 | Na área, perdendo por 2: chance clara? | DOGSO (placar não é critério) | Contato_Goleiro_Area | Não | Não | DOGSO, ZONA | LACUNA DE DADOS |
| 161 | Confirmada pela imagem: expulsa direto | Cusparada | Cusparada (sancao VERMELHO); Conduta_Violenta_Jogo | Não | Condicional | VAR_RES, ALVO | LACUNA DE DADOS |
| 162 | Durante confusão: revisa no VAR antes | Cusparada + revisão | Cusparada; Conduta_Violenta_Jogo (etapa VAR) | Não | Não | VAR_RES, ALVO | LACUNA DE DADOS |
| 163 | No chão, sem atingir ninguém: vermelho? | Cusparada não dirigida a pessoa | Cusparada (isento) | Não | Não | ALVO | LACUNA DE DADOS |
| 164 | Após o apito final (91 min) | Cusparada pós-jogo | Cusparada | Não | Não | APITO | LACUNA DE MODELO |
| 165 | Base sub-17: comunico a comissão antes? | Procedimento em categoria de base | Categoria_Base (exige: comunicar antes do vermelho) | Sim (procedimento) | Procedimento | EXIGE | COBERTO COM CONTEXTO |
| 166 | Sem imagem que identifique o autor | Autoria não identificada | Cusparada (isento: exceção autor) | Não | Não | AUTOR | LACUNA DE DADOS |
| 167 | Sem VAR, visão clara do quarto árbitro | Cusparada sem VAR | Cusparada; Competicao_Sem_VAR | Não | Condicional | VISAO, ALVO; SEM_VAR | LACUNA DE DADOS |
| 168 | Durante conduta violenta, dois jogadores (EV marcada) | Dois infratores | Cusparada; Conduta_Violenta | Não | Não | AUTOR; MULTI | LACUNA DE MODELO |
| 169 | No túnel, fora do campo | Cusparada fora do campo | Cusparada | Não | Não | LOCAL, ALVO | LACUNA DE DADOS |
| 170 | Em direção à arbitragem | Cusparada contra oficial | Cusparada | Não | Condicional | ALVO | LACUNA DE DADOS |
| 171 | Entre cobranças na disputa | Cusparada na disputa | Cusparada; Disputa_Penaltis | Não | Condicional | ALVO | LACUNA DE DADOS |
| 172 | 1 amarelo + cusparada: direto ou 2º? (Reinc. marcada) | Vermelho direto × reincidência | Cusparada (sancao VERMELHO); Reincidencia_Amarelo | Parcial | Condicional (vermelho direto) | ALVO | LACUNA DE DADOS |
| 173 | Confirmada aos 90+5: expulsa | Cusparada nos acréscimos | Cusparada; Acrescimos | Não | Condicional | VAR_RES, ALVO | LACUNA DE DADOS |
| 174 | Durante disputa a 0.9 m | Cusparada | Cusparada | Não | Condicional | ALVO | LACUNA DE DADOS |
| 175 | Reserva no banco | Infrator reserva | Cusparada | Não | Não | AUTOR; OFICIAL | LACUNA DE MODELO |
| 176 | Na própria área, jogada em andamento: reinício? | Cusparada + zona | Cusparada (zona_penal) | Não | Condicional (pênalti se na área, bola em jogo) | ZONA, ALVO, BOLA_JOGO | LACUNA DE DADOS |
| 177 | Base sub-15: o protocolo muda a conduta? | Critério em categoria de base | Categoria_Base (exige) | Sim (critério) | Critério | EXIGE | COBERTO COM CONTEXTO |
| 178 | Time já com dez: segunda expulsão | Cusparada | Cusparada | Não | Condicional | ALVO | LACUNA DE DADOS |
| 179 | Identificada só na revisão, 7 min depois | Revisão após o reinício | Revisao_VAR_Prolongada; Cusparada | Parcial | Procedimento | VAR_RES; revisão pós-reinício não modelada | LACUNA DE MODELO |
| 180 | Cusparada mútua: expulsa os dois | Dois infratores | Cusparada | Não | Não | AUTOR; MULTI | LACUNA DE MODELO |
| 181 | 1 amarelo + falta dura: aplica a reincidência | Reincidência | Reincidencia_Amarelo (ca=1) | Parcial | Condicional (se a falta é advertível) | FORCA | LACUNA DE DADOS |
| 182 | Sem advertência registrada, assistente pede: confirma | Reincidência sem advertência prévia | Jogador_Sem_Advertencia → veta Reincidencia_Amarelo | Sim | Sim: recusar (BLOQUEAR_DECISAO) | — | COBERTO |
| 183 | 1 amarelo + dissenso: expulsa | Reincidência por dissenso | Reincidencia_Amarelo (ca=1) | Parcial | Condicional | TOM | LACUNA DE DADOS |
| 184 | Banco pede, súmula sem advertência | Reincidência sem advertência prévia | Jogador_Sem_Advertencia | Sim | Sim: recusar | — | COBERTO |
| 185 | 1 amarelo + perda de tempo | Reincidência por perda de tempo | Reincidencia_Amarelo (ca=1) | Parcial | Condicional | ATRASO | LACUNA DE DADOS |
| 186 | Base sub-17, já advertido: comunico antes? | Procedimento em categoria de base | Categoria_Base (exige); Reincidencia_Amarelo | Sim (procedimento) | Procedimento | EXIGE | COBERTO COM CONTEXTO |
| 187 | Acréscimos 90+3, já advertido: expulsa | Reincidência nos acréscimos | Reincidencia_Amarelo (ca=1); Acrescimos | Parcial | Condicional | ato atual não descrito | LACUNA DE DADOS |
| 188 | Assistente diz que advertiu, registro zerado | Registro prevalece sobre o relato | Jogador_Sem_Advertencia | Sim | Sim: não há reincidência | — | COBERTO |
| 189 | Reincidência por simulação, 1 amarelo | Reincidência por simulação | Reincidencia_Amarelo (ca=1) | Parcial | Condicional | CONTATO | LACUNA DE DADOS |
| 190 | Sem VAR, advertência anterior confirmada: como registro? | Registro da dupla advertência | Reincidencia_Amarelo; regra global do registro sequencial | Sim | Procedimento | — | COBERTO |
| 191 | Sem cartão, entrou forte a 2.8 m: reincidência ou direto? | Reincidência excluída × vermelho direto | Jogador_Sem_Advertencia; Conduta_Violenta_Jogo | Parcial | Reincidência excluída; vermelho depende da força | FORCA | LACUNA DE DADOS |
| 192 | 1 amarelo + dissenso, 5 faltas | Reincidência por dissenso | Reincidencia_Amarelo (ca=1) | Parcial | Condicional | TOM | LACUNA DE DADOS |
| 193 | Disputa de pênaltis, advertido no tempo normal | Advertência não passa para a disputa | Disputa_Penaltis (proibe Reincidencia_Amarelo) | Sim | Sim: não há reincidência | — | COBERTO COM CONTEXTO |
| 194 | Pedida após carga de jogador não advertido | Reincidência sem advertência prévia | Jogador_Sem_Advertencia | Sim | Sim: recusar | — | COBERTO |
| 195 | 1 amarelo + mão fora da área | Reincidência × mão | Reincidencia_Amarelo (ca=1); Mao_Deliberada (sancao NENHUM) | Parcial | Condicional | BRACO, SPA | LACUNA DE DADOS |
| 196 | Já advertido, aos 88 min: expulsa | Reincidência | Reincidencia_Amarelo (ca=1) | Parcial | Condicional | ato atual não descrito | LACUNA DE DADOS |
| 197 | Capitão exige, sem advertência registrada | Reincidência sem advertência prévia | Jogador_Sem_Advertencia | Sim | Sim: recusar | — | COBERTO |
| 198 | Base sub-20, já advertido por dissenso | Reincidência em categoria de base | Reincidencia_Amarelo; Categoria_Base (exige) | Parcial | Procedimento | ato atual não descrito; EXIGE | COBERTO COM CONTEXTO |
| 199 | Perda de tempo 90+2, já advertido | Reincidência nos acréscimos | Reincidencia_Amarelo; Acrescimos | Parcial | Condicional | ATRASO | LACUNA DE DADOS |
| 200 | Zerado em cartões, adversário pede | Reincidência sem advertência prévia | Jogador_Sem_Advertencia | Sim | Sim: recusar | — | COBERTO |

## B. Execução

"Decisão" é o que a política efetiva admite para a infração do bloco. A escolha entre essas decisões é do LLM, que não foi executado aqui.

| ID | Resultado | Regra acionada | Decisão (política efetiva do alvo) | Ĝ | Esperado pelo modelo | Camada determinística | Status |
|---|---|---|---|---|---|---|---|
| 001 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 002 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 003 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 004 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 005 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 006 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 007 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 008 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 009 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 010 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 011 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 012 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 013 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 014 | alvo aplicável | escalonar VAR (tempo_revisao_var > 5) · lances ativos: Revisao_VAR_Prolongada | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis; ACIONAR_VAR obrigatório | conforme | REQUER AVALIAÇÃO |
| 015 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 016 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 017 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 018 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 019 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 020 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 021 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 022 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 023 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 024 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 025 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 026 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 027 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 028 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 029 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 030 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 031 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 032 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 033 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 034 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 035 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 036 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 037 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 038 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 039 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 040 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 041 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 042 | alvo EXCLUÍDO | veto: lance Mao_Curta_Distancia · lances ativos: Mao_Curta_Distancia | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Mao_Curta_Distancia (distancia_bola < 1) | conforme | REQUER AVALIAÇÃO |
| 043 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 044 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 045 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 046 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 047 | alvo EXCLUÍDO | veto: lance Mao_Curta_Distancia · lances ativos: Mao_Curta_Distancia | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Mao_Curta_Distancia (distancia_bola < 1) | conforme | REQUER AVALIAÇÃO |
| 048 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 049 | alvo aplicável | escalonar VAR (tempo_revisao_var > 5) · lances ativos: Conduta_Violenta_Jogo, Revisao_VAR_Prolongada | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis; ACIONAR_VAR obrigatório | conforme | REQUER AVALIAÇÃO |
| 050 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 051 | alvo EXCLUÍDO | veto: lance Mao_Curta_Distancia · lances ativos: Mao_Curta_Distancia | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Mao_Curta_Distancia (distancia_bola < 1) | conforme | REQUER AVALIAÇÃO |
| 052 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 053 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 054 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 055 | alvo EXCLUÍDO | veto: lance Mao_Curta_Distancia · lances ativos: Mao_Curta_Distancia | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Mao_Curta_Distancia (distancia_bola < 1) | conforme | REQUER AVALIAÇÃO |
| 056 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 057 | alvo aplicável | lances ativos: Impedimento_Ataque, Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 058 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 059 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 060 | alvo EXCLUÍDO | veto: lance Mao_Curta_Distancia · lances ativos: Mao_Curta_Distancia | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Mao_Curta_Distancia (distancia_bola < 1) | conforme | REQUER AVALIAÇÃO |
| 061 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 062 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 063 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 064 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 065 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 066 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 067 | alvo aplicável (fora do foco offline) | — | alvo fora do foco | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 068 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 069 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 070 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 071 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 072 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 073 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 074 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 075 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 076 | alvo aplicável | escalonar VAR (tempo_revisao_var > 5) · lances ativos: Revisao_VAR_Prolongada | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis; ACIONAR_VAR obrigatório | conforme | REQUER AVALIAÇÃO |
| 077 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 078 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 079 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 080 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 081 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 082 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 083 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 084 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 085 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 086 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 087 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 088 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 089 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 090 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 091 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 092 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 093 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 094 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 095 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 096 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 097 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 098 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 099 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 100 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 101 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 102 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 103 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 104 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 105 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 106 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 107 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 108 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 109 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 110 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 111 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 112 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 113 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 114 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 115 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 116 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 117 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 118 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 119 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 120 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 121 | alvo aplicável | lances ativos: Impedimento_Ataque | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 122 | alvo EXCLUÍDO | veto: lance Posicao_Legal_No_Passe · lances ativos: Posicao_Legal_No_Passe | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Posicao_Legal_No_Passe (dud >= 0) | conforme | REQUER AVALIAÇÃO |
| 123 | alvo aplicável | lances ativos: Impedimento_Ataque | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 124 | alvo EXCLUÍDO | veto: lance Posicao_Legal_No_Passe · lances ativos: Posicao_Legal_No_Passe | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Posicao_Legal_No_Passe (dud >= 0) | conforme | REQUER AVALIAÇÃO |
| 125 | alvo EXCLUÍDO | veto: contexto Disputa_Penaltis · lances ativos: Impedimento_Ataque | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Disputa_Penaltis proibe | conforme | REQUER AVALIAÇÃO |
| 126 | alvo aplicável | lances ativos: Impedimento_Ataque | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 127 | alvo EXCLUÍDO | veto: lance Posicao_Legal_No_Passe · lances ativos: Posicao_Legal_No_Passe | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Posicao_Legal_No_Passe (dud >= 0) | conforme | REQUER AVALIAÇÃO |
| 128 | alvo EXCLUÍDO | veto: lance Posicao_Legal_No_Passe · lances ativos: Posicao_Legal_No_Passe | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Posicao_Legal_No_Passe (dud >= 0) | conforme | REQUER AVALIAÇÃO |
| 129 | alvo aplicável | lances ativos: Impedimento_Ataque | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 130 | alvo EXCLUÍDO | veto: lance Posicao_Legal_No_Passe · lances ativos: Posicao_Legal_No_Passe | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Posicao_Legal_No_Passe (dud >= 0) | conforme | REQUER AVALIAÇÃO |
| 131 | alvo aplicável | escalonar VAR (tempo_revisao_var > 5) · lances ativos: Impedimento_Ataque, Revisao_VAR_Prolongada | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis; ACIONAR_VAR obrigatório | conforme | REQUER AVALIAÇÃO |
| 132 | alvo EXCLUÍDO | veto: lance Posicao_Legal_No_Passe · lances ativos: Posicao_Legal_No_Passe | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Posicao_Legal_No_Passe (dud >= 0) | conforme | REQUER AVALIAÇÃO |
| 133 | alvo aplicável | lances ativos: Impedimento_Ataque | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 134 | alvo aplicável | lances ativos: Impedimento_Ataque | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 135 | alvo EXCLUÍDO | veto: lance Posicao_Legal_No_Passe · lances ativos: Posicao_Legal_No_Passe | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Posicao_Legal_No_Passe (dud >= 0) | conforme | REQUER AVALIAÇÃO |
| 136 | alvo aplicável | lances ativos: Impedimento_Ataque | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 137 | alvo aplicável | lances ativos: Impedimento_Ataque | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 138 | alvo EXCLUÍDO | veto: lance Posicao_Legal_No_Passe · lances ativos: Posicao_Legal_No_Passe | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Posicao_Legal_No_Passe (dud >= 0) | conforme | REQUER AVALIAÇÃO |
| 139 | alvo EXCLUÍDO | veto: lance Posicao_Legal_No_Passe · lances ativos: Posicao_Legal_No_Passe | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Posicao_Legal_No_Passe (dud >= 0) | conforme | REQUER AVALIAÇÃO |
| 140 | alvo EXCLUÍDO | veto: lance Posicao_Legal_No_Passe · lances ativos: Posicao_Legal_No_Passe | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Posicao_Legal_No_Passe (dud >= 0) | conforme | REQUER AVALIAÇÃO |
| 141 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 142 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 143 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 144 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 145 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 146 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 147 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 148 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 149 | alvo aplicável | lances ativos: Impedimento_Ataque | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 150 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 151 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 152 | alvo EXCLUÍDO | veto: contexto Disputa_Penaltis | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Disputa_Penaltis proibe | conforme | REQUER AVALIAÇÃO |
| 153 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 154 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 155 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 156 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 157 | alvo aplicável | escalonar VAR (tempo_revisao_var > 5) · lances ativos: Revisao_VAR_Prolongada | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis; ACIONAR_VAR obrigatório | conforme | REQUER AVALIAÇÃO |
| 158 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 159 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 160 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 161 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 162 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 163 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 164 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 165 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 166 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 167 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 168 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 169 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 170 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 171 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 172 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 173 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 174 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 175 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 176 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 177 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 178 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 179 | alvo aplicável | escalonar VAR (tempo_revisao_var > 5) · lances ativos: Conduta_Violenta_Jogo, Revisao_VAR_Prolongada | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis; ACIONAR_VAR obrigatório | conforme | REQUER AVALIAÇÃO |
| 180 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 181 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 182 | alvo EXCLUÍDO | veto: lance Jogador_Sem_Advertencia · lances ativos: Jogador_Sem_Advertencia | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Jogador_Sem_Advertencia (ca < 1) | conforme | REQUER AVALIAÇÃO |
| 183 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 184 | alvo EXCLUÍDO | veto: lance Jogador_Sem_Advertencia · lances ativos: Jogador_Sem_Advertencia | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Jogador_Sem_Advertencia (ca < 1) | conforme | REQUER AVALIAÇÃO |
| 185 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 186 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 187 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 188 | alvo EXCLUÍDO | veto: lance Jogador_Sem_Advertencia · lances ativos: Jogador_Sem_Advertencia | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Jogador_Sem_Advertencia (ca < 1) | conforme | REQUER AVALIAÇÃO |
| 189 | alvo aplicável | — | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 190 | alvo aplicável | — | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 191 | alvo EXCLUÍDO | veto: lance Jogador_Sem_Advertencia · lances ativos: Conduta_Violenta_Jogo, Jogador_Sem_Advertencia | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Jogador_Sem_Advertencia (ca < 1) | conforme | REQUER AVALIAÇÃO |
| 192 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 193 | alvo EXCLUÍDO | veto: contexto Disputa_Penaltis | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Disputa_Penaltis proibe | conforme | REQUER AVALIAÇÃO |
| 194 | alvo EXCLUÍDO | veto: lance Jogador_Sem_Advertencia · lances ativos: Jogador_Sem_Advertencia | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Jogador_Sem_Advertencia (ca < 1) | conforme | REQUER AVALIAÇÃO |
| 195 | alvo aplicável | lances ativos: Conduta_Violenta_Jogo | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 196 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 197 | alvo EXCLUÍDO | veto: lance Jogador_Sem_Advertencia · lances ativos: Jogador_Sem_Advertencia | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Jogador_Sem_Advertencia (ca < 1) | conforme | REQUER AVALIAÇÃO |
| 198 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 199 | alvo aplicável | — | universo (13 decisões) | OK | aplicável; decisão entre as admissíveis | conforme | REQUER AVALIAÇÃO |
| 200 | alvo EXCLUÍDO | veto: lance Jogador_Sem_Advertencia · lances ativos: Jogador_Sem_Advertencia | sem sanção: ACIONAR_VAR, BLOQUEAR_DECISAO, MANTER_JOGO | OK | excluída — Jogador_Sem_Advertencia (ca < 1) | conforme | REQUER AVALIAÇÃO |
