# Cobertura dos 400 cenários de futebol (`cenarios-400-fut.jsonl`)

Gerado por [gerar-cenarios-400-fut.ts](../../scripts/gerar-cenarios-400-fut.ts). Para reproduzir: `npx tsx src/scripts/gerar-cenarios-400-fut.ts`.

Toda contagem abaixo é calculada pelo **mesmo código** para os 200 antigos, os 200 novos e os 400: camada determinística por `retrieveFutConstraints`, foco offline por `retrieverFocoFut` (nome escrito + arestas, sem índice vetorial) e `filtrarPorFocoFut`, objetivo e alegações por expressões sobre a fala. Nenhuma regra da DSL é reimplementada.

## 1. Arquivos

| arquivo | conteúdo |
|---|---|
| `cenarios-400-fut.jsonl` | os 200 antigos (copiados byte a byte de `src/examples/fut/cenarios-0a200-fut.jsonl`) + 200 novos, no mesmo formato (`intencao`, `partida`, `telemetria` com os 11 campos na mesma ordem, `contextos`, `infracoesEmUso`), sem campo novo |
| `cenarios-400-fut.meta.jsonl` | um registro por cenário novo: família, bloco, tipos, dimensão controlada, objetivo, estilo, alegações sem leitura, estruturas exercitadas, camada determinística esperada, foco offline e classe esperada |
| `cenarios-400-fut.contrastes.jsonl` | 141 pares da mesma família que diferem em **uma** dimensão, com o que muda na camada determinística e a leitura esperada |
| `cobertura-400-fut.md` | este relatório |

Os metadados ficam fora do JSONL de cenários de propósito. A ligação é por `partida`, que o lote preserva em `sorteio.partida` e a avaliação em `sujeito`.

## 2. Resumo

| item | valor |
|---|---|
| novos cenários | 200 |
| total após a união | 400 |
| intenções únicas (antigos / novos / total) | 200 / 200 / 400 |
| partidas únicas no total | 400 (novas: PT-2026-4201 a PT-2026-4400) |
| famílias | 102: 63 controladas (2 a 5 cenários, uma ou duas dimensões) e 39 cenários isolados |
| cenários em fronteira, pela leitura (no limiar ou a ±ε de um limiar contínuo) | 10 → 36 (total 46) |
| cenários de famílias de fronteira, pelo desenho (inclui âncoras longe do limiar e os pares 0/1 de cartões) | 54 |
| cenários com alegação sem leitura (fato só na fala; expressão sobre o texto) | 72 → 73 |
| cenários com veto por lance ou proibição por contexto sobre a infração-alvo (novos) | 37 (veto 24, proibição 11, os dois 2) |
| cenários com alguma proibição por contexto incidente | 8 → 19 |
| cenários de VAR (escalonamento, competição sem VAR ou VAR/revisão/monitor/vídeo na fala) | 26 → 57; escalonamento obrigatório 6 → 12 |
| cenários combinatórios (≥ 2 mecanismos estruturados sobre as infrações citadas) | 15 → 41 |
| contrastes controlados | 141: 51 de invariancia, 45 de procedimento, 45 de sensibilidade |

## 3. Antigos × novos × total

### 3.1 Diversidade da fala

| medida | antigos | novos | total |
|---|---|---|---|
| intenções únicas | 200 | 200 | 400 |
| aberturas distintas (2 primeiras palavras) | 78 | 131 | 190 |
| maior repetição de uma abertura | 20 | 11 | 24 |
| fala cita o fato decisivo (distância, linha, cartão anterior, duração) | 176 | 25 | 201 |
| só a leitura traz o fato decisivo | 24 | 175 | 199 |

Quando a fala diz "0,5 m à frente" ou "já advertido", não dá para saber se o sistema decidiu pela leitura ou pelo texto. Nos novos, as famílias de fronteira **não** dizem o valor, de propósito.

Maior similaridade de trigramas entre uma fala nova e uma antiga: 0.48 (limite de rejeição 0,60). Entre duas novas: 0.75 — os pares de uma família mudam o estilo, não as entidades.

Estilos das falas novas: alegacao_sem_leitura 50, pergunta_direta 38, duvida_operacional 30, relato_e_pergunta 21, compara_infracoes 19, procedimento 15, pede_revisao 6, conclusao_prematura 4, info_irrelevante 4, urgente 4, manter_decisao 3, ordem 3, relato_informal 3.

Objetivo declarado das falas novas: sancao_disciplinar 77, acionar_var 25, classificar_infracao 21, reinicio 19, anular_ou_confirmar_gol 17, marcar_infracao 17, procedimento 17, manter_ou_paralisar 7.

### 3.2 Infrações

Citação = nome inteiro escrito na fala (critério do foco lexical). "Em foco offline" inclui as arestas do grafo.

| infração citada | antigos | novos | total |
|---|---|---|---|
| Carga_Imprudente | 22 | 17 | 39 |
| Entrada_Violenta | 21 | 23 | 44 |
| Conduta_Violenta | 3 | 21 | 24 |
| Mao_Deliberada | 22 | 24 | 46 |
| Simulacao | 20 | 15 | 35 |
| Dissenso | 23 | 9 | 32 |
| Linguagem_Ofensiva | 2 | 14 | 16 |
| Perda_Tempo | 22 | 10 | 32 |
| Impedimento | 21 | 34 | 55 |
| Contato_Goleiro_Area | 20 | 22 | 42 |
| Cusparada | 20 | 15 | 35 |
| Reincidencia_Amarelo | 24 | 22 | 46 |

| infração em foco offline | antigos | novos | total |
|---|---|---|---|
| Carga_Imprudente | 45 | 25 | 70 |
| Entrada_Violenta | 45 | 31 | 76 |
| Conduta_Violenta | 22 | 36 | 58 |
| Mao_Deliberada | 48 | 48 | 96 |
| Simulacao | 20 | 15 | 35 |
| Dissenso | 23 | 9 | 32 |
| Linguagem_Ofensiva | 2 | 14 | 16 |
| Perda_Tempo | 22 | 10 | 32 |
| Impedimento | 21 | 34 | 55 |
| Contato_Goleiro_Area | 48 | 47 | 95 |
| Cusparada | 22 | 27 | 49 |
| Reincidencia_Amarelo | 25 | 22 | 47 |

Infração-alvo declarada nos novos: Impedimento 34, Mao_Deliberada 24, Contato_Goleiro_Area 23, Reincidencia_Amarelo 22, Conduta_Violenta 21, Cusparada 15, Entrada_Violenta 13, Carga_Imprudente 12, Linguagem_Ofensiva 11, Simulacao 11, Dissenso 6, Perda_Tempo 6, (sem infracao: so procedimento) 2. Carga_Imprudente + Entrada_Violenta + Dissenso somam 31 de 200.

### 3.3 Lances

| lance com gatilho ativo | antigos | novos | total |
|---|---|---|---|
| Penalti_Na_Area | 0 | 0 | 0 |
| Impedimento_Ataque | 12 | 24 | 36 |
| Posicao_Legal_No_Passe | 188 | 176 | 364 |
| Conduta_Violenta_Jogo | 49 | 29 | 78 |
| Disputa_Bola_Dividida | 0 | 0 | 0 |
| Mao_Curta_Distancia | 89 | 9 | 98 |
| Jogador_Sem_Advertencia | 181 | 186 | 367 |
| Revisao_VAR_Prolongada | 6 | 12 | 18 |

| lance em foco offline | antigos | novos | total |
|---|---|---|---|
| Penalti_Na_Area | 48 | 48 | 96 |
| Impedimento_Ataque | 21 | 34 | 55 |
| Posicao_Legal_No_Passe | 0 | 1 | 1 |
| Conduta_Violenta_Jogo | 22 | 36 | 58 |
| Disputa_Bola_Dividida | 45 | 32 | 77 |
| Mao_Curta_Distancia | 1 | 1 | 2 |
| Jogador_Sem_Advertencia | 5 | 1 | 6 |
| Revisao_VAR_Prolongada | 0 | 0 | 0 |

### 3.4 Contextos e infrações em uso

| contexto | antigos | novos | total |
|---|---|---|---|
| Acrescimos | 18 | 12 | 30 |
| Disputa_Penaltis | 8 | 19 | 27 |
| Competicao_Sem_VAR | 11 | 20 | 31 |
| Categoria_Base | 16 | 15 | 31 |
| (dois contextos no mesmo cenário) | 1 | 5 | 6 |

| infração em uso | antigos | novos | total |
|---|---|---|---|
| Carga_Imprudente | 2 | 5 | 7 |
| Contato_Goleiro_Area | 0 | 1 | 1 |
| Dissenso | 0 | 3 | 3 |
| Entrada_Violenta | 3 | 5 | 8 |
| Perda_Tempo | 0 | 4 | 4 |
| Reincidencia_Amarelo | 6 | 0 | 6 |
| Simulacao | 0 | 3 | 3 |
| (cenários com alguma em uso) | 11 | 21 | 32 |

| agravante incidente | antigos | novos | total |
|---|---|---|---|
| Contato_Goleiro_Area + Entrada_Violenta | 3 | 6 | 9 |
| Entrada_Violenta + Carga_Imprudente | 5 | 10 | 15 |

### 3.5 Vetos, proibições e escalonamento

| veto por lance | antigos | novos | total |
|---|---|---|---|
| Impedimento <- Posicao_Legal_No_Passe | 188 | 176 | 364 |
| Mao_Deliberada <- Mao_Curta_Distancia | 89 | 9 | 98 |
| Reincidencia_Amarelo <- Jogador_Sem_Advertencia | 181 | 186 | 367 |

| proibição por contexto | antigos | novos | total |
|---|---|---|---|
| Contato_Goleiro_Area <- Disputa_Penaltis | 8 | 19 | 27 |
| Impedimento <- Disputa_Penaltis | 8 | 19 | 27 |
| Reincidencia_Amarelo <- Disputa_Penaltis | 8 | 19 | 27 |

| escalonamento para o VAR | 6 | 12 | 18 |
|---|---|---|---|

Os vetos de Posicao_Legal_No_Passe e Jogador_Sem_Advertencia aparecem em quase todo cenário porque `distancia_ultimo_defensor` e `cartoes_amarelos_jogador` estão sempre na leitura e um dos dois lados do limiar sempre incide. O que importa é a infração-alvo: nos novos, 161 cenários têm o alvo aplicável, 37 excluído e 2 não têm infração (só procedimento).

### 3.6 VAR

| medida | antigos | novos | total |
|---|---|---|---|
| revisão em curso (`tempo_revisao_var` > 0) | 154 | 28 | 182 |
| escalonamento (`> 5`) | 6 | 12 | 18 |
| Competicao_Sem_VAR | 11 | 20 | 31 |
| VAR, revisão, monitor ou vídeo na fala | 26 | 49 | 75 |
| resultado do VAR alegado na fala (VAR_RES) | 1 | 6 | 7 |

### 3.7 Parâmetros e fronteiras

Só quatro parâmetros entram em regra, em cinco limiares; os outros sete o próprio `futebol.fut` declara sem poder decisório.

| parâmetro | papel no modelo | valores distintos (antigos → novos) |
|---|---|---|
| minuto_partida | sem poder decisório (só o minuto admissível da marcação) | 72 → 79 |
| acrescimo | sem poder decisório (antes bloqueava Perda_Tempo; retirado) | 6 → 6 |
| cartoes_amarelos_jogador | **decisório**: `< 1` → Jogador_Sem_Advertencia veta Reincidencia_Amarelo | 2 → 2 |
| distancia_ultimo_defensor | **decisório**: `< 0` → Impedimento_Ataque; `>= 0` → Posicao_Legal_No_Passe veta Impedimento | 48 → 49 |
| velocidade_bola | sem poder decisório ("velocidade da bola não é vantagem") | 31 → 25 |
| distancia_gol | sem poder decisório ("distância do gol não é zona do campo") | 48 → 46 |
| jogadores_entre_bola_e_gol | sem poder decisório (antes decidia impedimento; retirado) | 6 → 6 |
| tempo_revisao_var | **decisório**: `> 5` → Revisao_VAR_Prolongada + escalonar VAR (duração, não resultado) | 7 → 15 |
| placar_diferenca | sem poder decisório | 8 → 5 |
| faltas_acumuladas_time | sem poder decisório ("faltas coletivas não são dissenso individual") | 9 → 7 |
| distancia_bola | **decisório**: `< 1` → Mao_Curta_Distancia veta Mao_Deliberada; `> 2` → Conduta_Violenta_Jogo recomenda Conduta_Violenta e Cusparada | 49 → 34 |

| limiar e faixa | antigos | novos | total |
|---|---|---|---|
| Conduta_Violenta_Jogo (distancia_bola vs 2): abaixo_epsilon | 0 | 2 | 2 |
| Conduta_Violenta_Jogo (distancia_bola vs 2): abaixo_longe | 150 | 167 | 317 |
| Conduta_Violenta_Jogo (distancia_bola vs 2): acima_epsilon | 0 | 2 | 2 |
| Conduta_Violenta_Jogo (distancia_bola vs 2): acima_longe | 49 | 27 | 76 |
| Conduta_Violenta_Jogo (distancia_bola vs 2): no_limiar | 1 | 2 | 3 |
| Impedimento_Ataque/Posicao_Legal_No_Passe (distancia_ultimo_defensor vs 0): abaixo_epsilon | 0 | 7 | 7 |
| Impedimento_Ataque/Posicao_Legal_No_Passe (distancia_ultimo_defensor vs 0): abaixo_longe | 12 | 17 | 29 |
| Impedimento_Ataque/Posicao_Legal_No_Passe (distancia_ultimo_defensor vs 0): acima_epsilon | 0 | 5 | 5 |
| Impedimento_Ataque/Posicao_Legal_No_Passe (distancia_ultimo_defensor vs 0): acima_longe | 187 | 169 | 356 |
| Impedimento_Ataque/Posicao_Legal_No_Passe (distancia_ultimo_defensor vs 0): no_limiar | 1 | 2 | 3 |
| Jogador_Sem_Advertencia (cartoes_amarelos_jogador vs 1): abaixo_longe | 181 | 186 | 367 |
| Jogador_Sem_Advertencia (cartoes_amarelos_jogador vs 1): no_limiar | 19 | 14 | 33 |
| Mao_Curta_Distancia (distancia_bola vs 1): abaixo_epsilon | 0 | 2 | 2 |
| Mao_Curta_Distancia (distancia_bola vs 1): abaixo_longe | 89 | 7 | 96 |
| Mao_Curta_Distancia (distancia_bola vs 1): acima_epsilon | 0 | 2 | 2 |
| Mao_Curta_Distancia (distancia_bola vs 1): acima_longe | 103 | 187 | 290 |
| Mao_Curta_Distancia (distancia_bola vs 1): no_limiar | 8 | 2 | 10 |
| Revisao_VAR_Prolongada (tempo_revisao_var vs 5): abaixo_epsilon | 0 | 4 | 4 |
| Revisao_VAR_Prolongada (tempo_revisao_var vs 5): abaixo_longe | 194 | 182 | 376 |
| Revisao_VAR_Prolongada (tempo_revisao_var vs 5): acima_epsilon | 0 | 4 | 4 |
| Revisao_VAR_Prolongada (tempo_revisao_var vs 5): acima_longe | 6 | 8 | 14 |
| Revisao_VAR_Prolongada (tempo_revisao_var vs 5): no_limiar | 0 | 2 | 2 |

ε = 0,05 para distâncias, 0,1 min para a revisão. `cartoes_amarelos_jogador` é inteiro e só 0 ou 1 são coerentes (2 amarelos = jogador já expulso): a fronteira dele é o par 0/1, sem ±ε. Os operadores declarados são `<`, `>=` e `>`; `<=`, `==` e `!=` não aparecem em nenhuma regra do modelo.

### 3.8 Evidência insuficiente

| fato só na fala | antigos | novos | total |
|---|---|---|---|
| ALVO | 1 | 1 | 2 |
| APITO | 2 | 3 | 5 |
| AUTOR | 1 | 3 | 4 |
| BOLA_JOGO | 0 | 6 | 6 |
| BRACO | 5 | 4 | 9 |
| CONTATO | 3 | 7 | 10 |
| DISTANCIA | 2 | 3 | 5 |
| DOGSO | 7 | 12 | 19 |
| FORCA | 1 | 12 | 13 |
| ISENCAO | 1 | 0 | 1 |
| METADE | 1 | 1 | 2 |
| POSICAO | 0 | 3 | 3 |
| TENTATIVA | 0 | 2 | 2 |
| VANT | 1 | 1 | 2 |
| VAR_RES | 1 | 6 | 7 |
| VISAO | 7 | 10 | 17 |
| ZONA | 54 | 27 | 81 |
| (cenários com algum) | 72 | 73 | 145 |

Contagem por expressão sobre a fala, igual para os dois conjuntos. Nos novos, o desenho declara as alegações em `alegacoes_sem_leitura` (66 cenários), inclusive as que nenhuma expressão captura (posição legal, curta distância, metade do campo, cartão prévio).

Os antigos já tinham muitas lacunas de dados (143 de 200 em `cobertura-200-fut.md`), quase sempre uma pergunta que a leitura não decide. Os novos usam a evidência insuficiente de outro jeito: em pares em que **só a fala muda** e a camada determinística é a mesma, para medir se o sistema decide pela leitura ou pela alegação.

### 3.9 Procedimento e combinação

| medida | antigos | novos | total |
|---|---|---|---|
| lance com `etapa` ativo ou em foco | 139 | 147 | 286 |
| contexto com `exige` | 52 | 61 | 113 |
| pedido de procedimento na fala | 1 | 15 | 16 |
| combinatório (≥ 2 mecanismos sobre as infrações citadas) | 15 | 41 | 56 |

### 3.10 Estruturas do `futebol.fut` efetivamente exercitadas

Conta um cenário só quando a estrutura **incide** (gatilho dispara, veto ou proibição recai, escalonamento dispara, agravante entra, contexto está marcado), ou quando um lance sem gatilho entra pelo foco do pedido. Recomendação conta quando a infração recomendada está no foco. Citar o nome não conta.

| estrutura | antigos | novos | total |
|---|---|---|---|
| agravante Contato_Goleiro_Area + Entrada_Violenta | 3 | 6 | 9 |
| agravante Entrada_Violenta + Carga_Imprudente | 5 | 10 | 15 |
| escalonar Revisao_VAR_Prolongada | 6 | 12 | 18 |
| etapa Conduta_Violenta_Jogo | 22 | 36 | 58 |
| etapa Disputa_Bola_Dividida | 45 | 32 | 77 |
| etapa Impedimento_Ataque | 21 | 34 | 55 |
| etapa Jogador_Sem_Advertencia | 11 | 9 | 20 |
| etapa Penalti_Na_Area | 48 | 48 | 96 |
| etapa Revisao_VAR_Prolongada | 6 | 12 | 18 |
| exige Acrescimos | 18 | 12 | 30 |
| exige Categoria_Base | 16 | 15 | 31 |
| exige Competicao_Sem_VAR | 11 | 20 | 31 |
| exige Disputa_Penaltis | 8 | 19 | 27 |
| foco Disputa_Bola_Dividida (sem gatilho) | 45 | 32 | 77 |
| foco Penalti_Na_Area (sem gatilho) | 48 | 48 | 96 |
| gatilho Conduta_Violenta_Jogo | 49 | 29 | 78 |
| gatilho Impedimento_Ataque | 12 | 24 | 36 |
| gatilho Jogador_Sem_Advertencia | 181 | 186 | 367 |
| gatilho Mao_Curta_Distancia | 89 | 9 | 98 |
| gatilho Posicao_Legal_No_Passe | 188 | 176 | 364 |
| gatilho Revisao_VAR_Prolongada | 6 | 12 | 18 |
| proibe Disputa_Penaltis -> Contato_Goleiro_Area | 8 | 19 | 27 |
| proibe Disputa_Penaltis -> Impedimento | 8 | 19 | 27 |
| proibe Disputa_Penaltis -> Reincidencia_Amarelo | 8 | 19 | 27 |
| recomenda Conduta_Violenta_Jogo -> Conduta_Violenta | 21 | 26 | 47 |
| recomenda Conduta_Violenta_Jogo -> Cusparada | 21 | 22 | 43 |
| recomenda Impedimento_Ataque -> Impedimento | 10 | 24 | 34 |
| veta Jogador_Sem_Advertencia -> Reincidencia_Amarelo | 181 | 186 | 367 |
| veta Mao_Curta_Distancia -> Mao_Deliberada | 89 | 9 | 98 |
| veta Posicao_Legal_No_Passe -> Impedimento | 188 | 176 | 364 |

## 4. Desenho dos 200 novos

Cada cenário existe por uma razão experimental. Dentro de uma família só muda a dimensão declarada; o script **reprova a geração** se dois membros diferirem em qualquer outro campo. Nas famílias em que a dimensão é a leitura, a fala muda de estilo mas mantém as mesmas entidades e o mesmo objetivo, **nunca diz o valor que varia**, e o foco lexical é conferido igual entre os membros. Assim, uma mudança de decisão só pode vir da leitura.

| bloco | cenários |
|---|---|
| fronteira | 40 |
| contexto | 38 |
| var_procedimento | 25 |
| veto_proibicao | 24 |
| negativo | 22 |
| unitario | 21 |
| evidencia | 18 |
| interacao | 12 |

| tipo (um cenário pode ter vários) | cenários |
|---|---|
| contextual | 72 |
| procedimento | 64 |
| fronteira | 54 |
| interacao | 48 |
| negativo | 44 |
| combinatorio | 40 |
| evidencia_insuficiente | 39 |
| unitario_semantico | 25 |

| família | bloco | alvo | dimensão controlada | n |
|---|---|---|---|---|
| FR-IMP-GOL | fronteira | Impedimento | distancia_ultimo_defensor (distancia_ultimo_defensor: -0.3 / -0.01 / 0 / 0.01 / 0.3) | 5 |
| FR-IMP-BANDEIRA | fronteira | Impedimento | distancia_ultimo_defensor (distancia_ultimo_defensor: -0.05 / 0 / 0.05) | 3 |
| FR-MAO-BRACO | fronteira | Mao_Deliberada | distancia_bola (distancia_bola: 0.5 / 0.99 / 1 / 1.01 / 1.6) | 5 |
| FR-MAO-MEIO | fronteira | Mao_Deliberada | distancia_bola (distancia_bola: 0.95 / 1 / 1.05) | 3 |
| FR-CV-DISTANCIA | fronteira | Conduta_Violenta | distancia_bola (distancia_bola: 1.5 / 1.99 / 2 / 2.01 / 3) | 5 |
| FR-CUSP-DISTANCIA | fronteira | Cusparada | distancia_bola (distancia_bola: 1.9 / 2 / 2.1) | 3 |
| FR-REINC-SIMULACAO | fronteira | Reincidencia_Amarelo | cartoes_amarelos_jogador (cartoes_amarelos_jogador: 0 / 1) | 2 |
| FR-REINC-PERDA | fronteira | Reincidencia_Amarelo | cartoes_amarelos_jogador (cartoes_amarelos_jogador: 0 / 1) | 2 |
| FR-REINC-DISSENSO | fronteira | Reincidencia_Amarelo | cartoes_amarelos_jogador (cartoes_amarelos_jogador: 0 / 1) | 2 |
| FR-REINC-EMUSO | fronteira | Reincidencia_Amarelo | cartoes_amarelos_jogador (cartoes_amarelos_jogador: 0 / 1) | 2 |
| FR-VAR-DOGSO | fronteira | Contato_Goleiro_Area | tempo_revisao_var (tempo_revisao_var: 4.5 / 4.99 / 5 / 5.01 / 6.5) | 5 |
| FR-VAR-IMP | fronteira | Impedimento | tempo_revisao_var (tempo_revisao_var: 4.9 / 5 / 5.1) | 3 |
| VP-DP-REINC | veto_proibicao | Reincidencia_Amarelo | cartoes_amarelos_jogador × contextos (cartoes_amarelos_jogador: 0 / 1 / 0 / 1) | 4 |
| VP-DP-IMP | veto_proibicao | Impedimento | distancia_ultimo_defensor × contextos (distancia_ultimo_defensor: -0.03 / 0.03 / -0.03 / 0.03) | 4 |
| VP-DP-DOGSO | veto_proibicao | Contato_Goleiro_Area | contextos × infracoesEmUso | 4 |
| VP-EXCL-MAO | veto_proibicao | Mao_Deliberada | — | 1 |
| VP-EXCL-IMP | veto_proibicao | Impedimento | — | 1 |
| VP-EXCL-REINC | veto_proibicao | Reincidencia_Amarelo | — | 1 |
| VP-EXCL-REINC-DP | veto_proibicao | Reincidencia_Amarelo | — | 1 |
| VP-EXCL-IMP-DP | veto_proibicao | Impedimento | — | 1 |
| VP-EXCL-DOGSO-DP | veto_proibicao | Contato_Goleiro_Area | — | 1 |
| VP-LEX-ADVERTENCIA | veto_proibicao | Reincidencia_Amarelo | intencao | 2 |
| VP-LEX-POSICAO | veto_proibicao | Impedimento | intencao | 2 |
| VP-LEX-CURTA | veto_proibicao | Mao_Deliberada | intencao | 2 |
| CT-BASE-CV | contexto | Conduta_Violenta | contextos | 2 |
| CT-BASE-EV-AGRAV | contexto | Entrada_Violenta | contextos × infracoesEmUso | 4 |
| CT-SEMVAR-MAO | contexto | Mao_Deliberada | contextos | 2 |
| CT-SEMVAR-IMP | contexto | Impedimento | contextos | 2 |
| CT-SEMVAR-CV | contexto | Conduta_Violenta | contextos | 2 |
| CT-SEMVAR-ALEGA | contexto | Contato_Goleiro_Area | contextos | 2 |
| CT-ACR-CV | contexto | Conduta_Violenta | contextos | 2 |
| CT-ACR-LINGUAGEM | contexto | Linguagem_Ofensiva | contextos | 2 |
| CT-ACR-VAR | contexto | Entrada_Violenta | contextos | 2 |
| CT-BASE-SEMVAR-CUSP | contexto | Cusparada | contextos | 4 |
| CT-DP-SEMVAR-SIM | contexto | Simulacao | contextos | 2 |
| CT-DP-LINGUAGEM | contexto | Linguagem_Ofensiva | — | 1 |
| CT-DP-CV | contexto | Conduta_Violenta | — | 1 |
| CT-DP-ORDEM | contexto | — | — | 1 |
| CT-DP-PARADINHA | contexto | — | — | 1 |
| CT-BASE-LINGUAGEM | contexto | Linguagem_Ofensiva | contextos | 2 |
| CT-ACR-IMP-LINHA | contexto | Impedimento | distancia_ultimo_defensor (distancia_ultimo_defensor: -0.02 / 0.02) | 2 |
| CT-BASE-CUSP-LINHA | contexto | Cusparada | distancia_bola (distancia_bola: 1.99 / 2.01) | 2 |
| CT-DP-BASE-REINC | contexto | Reincidencia_Amarelo | contextos | 2 |
| PR-VAR-ALEGA-SIM | var_procedimento | Simulacao | tempo_revisao_var (tempo_revisao_var: 0 / 1.5 / 3) | 3 |
| PR-VAR-REVERSAO | var_procedimento | Entrada_Violenta | tempo_revisao_var (tempo_revisao_var: 3 / 6) | 2 |
| PR-ETAPAS-PENALTI-MAO | var_procedimento | Mao_Deliberada | — | 1 |
| PR-ETAPAS-PENALTI-OFR | var_procedimento | Contato_Goleiro_Area | — | 1 |
| PR-ETAPAS-IMP | var_procedimento | Impedimento | distancia_ultimo_defensor (distancia_ultimo_defensor: -0.4 / 0.4) | 2 |
| PR-CVJ-VANTAGEM | var_procedimento | Conduta_Violenta | distancia_bola (distancia_bola: 1.6 / 2.4) | 2 |
| PR-DIVIDIDA-VANT | var_procedimento | Carga_Imprudente | velocidade_bola (velocidade_bola: 3 / 24) | 2 |
| PR-SUMULA-REINC | var_procedimento | Reincidencia_Amarelo | cartoes_amarelos_jogador (cartoes_amarelos_jogador: 0 / 1) | 2 |
| PR-COMUNICA-CUSP | var_procedimento | Cusparada | — | 1 |
| PR-SUMULA-EXPULSAO | var_procedimento | Reincidencia_Amarelo | — | 1 |
| PR-VAR-IDENTIDADE | var_procedimento | Cusparada | tempo_revisao_var (tempo_revisao_var: 4.5 / 6) | 2 |
| PR-ESC-VETO | var_procedimento | Mao_Deliberada | tempo_revisao_var × distancia_bola (tempo_revisao_var: 4.9 / 4.9 / 5.1 / 5.1; distancia_bola: 0.6 / 1.4 / 0.6 / 1.4) | 4 |
| PR-DP-VAR | var_procedimento | Contato_Goleiro_Area | tempo_revisao_var (tempo_revisao_var: 3 / 5.5) | 2 |
| EV-ZONA-CV | evidencia | Conduta_Violenta | intencao | 2 |
| EV-DOGSO | evidencia | Contato_Goleiro_Area | intencao | 2 |
| EV-VANTAGEM | evidencia | Carga_Imprudente | — | 1 |
| EV-BRACO-VETO | evidencia | Mao_Deliberada | intencao | 2 |
| EV-VISAO-LING | evidencia | Linguagem_Ofensiva | intencao | 2 |
| EV-VAR-IMP | evidencia | Impedimento | intencao | 2 |
| EV-CONTATO-SIM | evidencia | Simulacao | intencao | 2 |
| EV-AUTOR-CUSP | evidencia | Cusparada | intencao | 2 |
| EV-BOLA-FORA-CV | evidencia | Conduta_Violenta | — | 1 |
| EV-PREMATURA-VAR | evidencia | Carga_Imprudente | — | 1 |
| EV-PREMATURA-AGRAV | evidencia | Carga_Imprudente | — | 1 |
| NG-DG-AREA-CARGA | negativo | Carga_Imprudente | distancia_gol (distancia_gol: 11 / 16 / 17) | 3 |
| NG-DG-DOGSO | negativo | Contato_Goleiro_Area | distancia_gol (distancia_gol: 39 / 40 / 41) | 3 |
| NG-FALTAS-DISSENSO | negativo | Dissenso | faltas_acumuladas_time (faltas_acumuladas_time: 4 / 5 / 6) | 3 |
| NG-JEB-IMP | negativo | Impedimento | jogadores_entre_bola_e_gol (jogadores_entre_bola_e_gol: 1 / 2 / 3) | 3 |
| NG-ACR-PERDA | negativo | Perda_Tempo | acrescimo (acrescimo: 0 / 3) | 2 |
| NG-PLACAR-PERDA | negativo | Perda_Tempo | placar_diferenca (placar_diferenca: -2 / 2) | 2 |
| NG-MINUTO-SIM | negativo | Simulacao | minuto_partida (minuto_partida: 12 / 88) | 2 |
| NG-FAIXA-EV | negativo | Entrada_Violenta | distancia_bola (distancia_bola: 1.2 / 1.9) | 2 |
| NG-USO-EV | negativo | Entrada_Violenta | infracoesEmUso | 2 |
| IT-DB-MAO-CVJ | interacao | Mao_Deliberada | distancia_bola (distancia_bola: 1.6 / 2.6) | 2 |
| IT-DB-CV-MAOVETO | interacao | Conduta_Violenta | distancia_bola (distancia_bola: 0.7 / 1.5) | 2 |
| IT-AGRAV-CARGA | interacao | Carga_Imprudente | infracoesEmUso | 3 |
| IT-AGRAV-DOGSO | interacao | Contato_Goleiro_Area | infracoesEmUso | 3 |
| IT-MULTI | interacao | Impedimento | tempo_revisao_var (tempo_revisao_var: 4 / 6) | 2 |
| UN-LING-LADRAO | unitario | Linguagem_Ofensiva | — | 1 |
| UN-LING-IRONIA | unitario | Dissenso | — | 1 |
| UN-LING-GESTO | unitario | Linguagem_Ofensiva | — | 1 |
| UN-DISSENSO-SEMOFENSA | unitario | Dissenso | — | 1 |
| UN-CV-ATENDIMENTO | unitario | Conduta_Violenta | — | 1 |
| UN-EV-TESOURA-BASE | unitario | Entrada_Violenta | — | 1 |
| UN-CV-CABECADA | unitario | Conduta_Violenta | — | 1 |
| UN-CARGA-VERBAL | unitario | Carga_Imprudente | — | 1 |
| UN-MAO-SANCAO | unitario | Mao_Deliberada | — | 1 |
| UN-IMP-REINICIO | unitario | Impedimento | — | 1 |
| UN-SIM-REINICIO | unitario | Simulacao | — | 1 |
| UN-PERDA-REINICIO | unitario | Perda_Tempo | — | 1 |
| UN-PERDA-MONITORAR | unitario | Perda_Tempo | — | 1 |
| UN-CUSP-ISENTO | unitario | Cusparada | — | 1 |
| UN-LING-REINICIO | unitario | Linguagem_Ofensiva | — | 1 |
| UN-REINC-CARTOES | unitario | Reincidencia_Amarelo | — | 1 |
| UN-VARREV-LING | unitario | Linguagem_Ofensiva | — | 1 |
| UN-VARREV-DISSENSO | unitario | Dissenso | — | 1 |
| UN-IMP-METADE | unitario | Impedimento | — | 1 |
| UN-SIM-X-MAO | unitario | Simulacao | — | 1 |
| UN-MAO-X-CARGA | unitario | Mao_Deliberada | — | 1 |

O racional de cada família está em `racional`, no meta.

### 4.1 Classe esperada

Derivada da camada determinística (não é gabarito de plano):

- `SEM_SANCAO_PARA_O_ALVO`: o alvo está vetado ou proibido. Só restam MANTER_JOGO, BLOQUEAR_DECISAO e ACIONAR_VAR para ele, e a exclusão não autoriza inventar outra sanção.
- `APLICAVEL`: o alvo vale por padrão. A decisão concreta segue a sanção e os reinícios declarados.
- `APLICAVEL_COM_EVIDENCIA_INSUFICIENTE`: o alvo vale, mas o pedido depende de um fato só da fala. A justificativa deve declarar evidência insuficiente e não apresentar o fato como leitura.
- `SEM_INFRACAO_ALVO`: pedido só de procedimento.

| classe | cenários |
|---|---|
| APLICAVEL | 102 |
| APLICAVEL_COM_EVIDENCIA_INSUFICIENTE | 59 |
| SEM_SANCAO_PARA_O_ALVO | 37 |
| SEM_INFRACAO_ALVO | 2 |

`acionar_var_obrigatorio` (escalonamento disparado): 12 cenários.

### 4.2 Contrastes

| tipo | pares | leitura |
|---|---|---|
| sensibilidade | 45 | a regra muda a política do alvo ou o escalonamento: a decisão **deve** mudar |
| procedimento | 45 | muda o lance ativo, a recomendação, o agravante ou o `exige`, não a política: a justificativa e o procedimento devem refletir a mudança |
| invariância | 51 | nenhuma regra muda (parâmetro sem poder decisório, fala sem leitura, contexto sem efeito): a decisão **não** deve mudar |

Por dimensão: telemetria.distancia_bola 33, contextos 25, telemetria.tempo_revisao_var 22, telemetria.distancia_ultimo_defensor 17, infracoesEmUso 11, intencao 10, telemetria.cartoes_amarelos_jogador 7, telemetria.distancia_gol 6, telemetria.faltas_acumuladas_time 3, telemetria.jogadores_entre_bola_e_gol 3, telemetria.acrescimo 1, telemetria.minuto_partida 1, telemetria.placar_diferenca 1, telemetria.velocidade_bola 1.

A análise posterior junta `contrastes.jsonl` aos resultados do lote por `partida` e mede duas taxas: com que frequência a decisão sobre o alvo muda nos pares de sensibilidade (deveria ser 1) e nos de invariância (deveria ser 0).

## 5. Achados da auditoria

**5.1 O foco aplica o veto de um lance cujo gatilho não disparou.** `filtrarPorFocoFut` traz as arestas de **todo** lance em foco que não esteja ativo (`arestasDoLance`), inclusive o `veta`, sem olhar se o lance tem gatilho. O `futebol.fut` declara outra coisa: "Um lance fica ativo quando QUALQUER gatilho dele incide sobre a leitura. Lance sem gatilho só entra quando o pedido o identifica (foco)". Na prática, uma fala que escreve os tokens distintivos de Posicao_Legal_No_Passe, Mao_Curta_Distancia ou Jogador_Sem_Advertencia veta Impedimento, Mao_Deliberada ou Reincidencia_Amarelo mesmo com a leitura do outro lado do limiar. Exemplo conferido: com 1 amarelo na súmula, "O jogador já tinha uma advertência..." deixa Reincidencia_Amarelo só com MANTER_JOGO/ACIONAR_VAR/BLOQUEAR_DECISAO. Pelo nome escrito (foco offline), isso já ocorre em 3 cenários antigos (PT-2026-4189, PT-2026-4190, PT-2026-4195). As famílias VP-LEX-* medem o efeito com pares em que só a fala muda.

Com o índice vetorial no ar, o efeito é maior e sistemático (§6, foco real). Nenhum lance `recomenda` Reincidencia_Amarelo, então nenhuma aresta alcança um lance. O índice escolhe o mais próximo, que é Jogador_Sem_Advertencia, e o veto dele cai sobre o pedido de segundo amarelo **mesmo com 1 amarelo na súmula**. Consequência: na arquitetura, a fronteira de `cartoes_amarelos_jogador` fica invisível, e todos os pares 0/1 (FR-REINC-*, PR-SUMULA-REINC, VP-LEX-ADVERTENCIA) devem sair sem mudança de decisão. É exatamente o tipo de falha que os pares de sensibilidade existem para detectar. Código de produção não foi alterado.

**5.2 Foco offline dos novos.** Infração-alvo fora do foco offline (depende do índice vetorial para ser exprimível): 7. Política do alvo diferente da do modelo depois do foco offline: 3.
- PT-2026-4259 (VP-LEX-ADVERTENCIA): Reincidencia_Amarelo — modelo 13 decisoes, depois do foco 3 (lances em foco: Jogador_Sem_Advertencia)
- PT-2026-4261 (VP-LEX-POSICAO): Impedimento — modelo 13 decisoes, depois do foco 3 (lances em foco: Impedimento_Ataque, Posicao_Legal_No_Passe)
- PT-2026-4263 (VP-LEX-CURTA): Mao_Deliberada — modelo 13 decisoes, depois do foco 3 (lances em foco: Mao_Curta_Distancia, Penalti_Na_Area)

Alvo fora do foco offline:
- PT-2026-4258 (VP-EXCL-DOGSO-DP): Contato_Goleiro_Area
- PT-2026-4381 (UN-LING-IRONIA): Dissenso
- PT-2026-4382 (UN-LING-GESTO): Linguagem_Ofensiva
- PT-2026-4383 (UN-DISSENSO-SEMOFENSA): Dissenso
- PT-2026-4384 (UN-CV-ATENDIMENTO): Conduta_Violenta
- PT-2026-4385 (UN-EV-TESOURA-BASE): Entrada_Violenta
- PT-2026-4386 (UN-CV-CABECADA): Conduta_Violenta

**5.3 Testes apontam para o nome antigo.** `test:foco-politica`, `test:restricoes` e `test:recuperacao-conhecimento` leem `src/examples/fut/cenarios-200-fut.jsonl`. O arquivo está renomeado (staged) para `cenarios-0a200-fut.jsonl` e, enquanto isso, essas suítes falham ao abrir o arquivo. Este script lê qualquer um dos dois nomes. Os testes não foram alterados.

**5.4 Ground truth de fut.** O mecanismo oficial, `gerar-ground-truth-fut.ts`, é um gabarito fechado de 25 cenários escritos à mão, cada um com o seu resolvedor. Ele não aceita cenários externos e grava por cima de `cenarios-25-fut.jsonl` e `ground_truth_fut.jsonl`. Os textos de `description` dele citam regras que o `futebol.fut` atual não tem mais (limiar de 5 faltas em Dissenso, Perda_Tempo bloqueada nos acréscimos, Categoria_Base e Competicao_Sem_VAR proibindo infrações). A avaliação em uso (`/api/avaliar`, `avaliar-grafo.ts`) não usa gabarito: é a cascata sintaxe → semântica → oráculo → juiz, refeita a partir do `sorteio` de cada registro. Por isso não há gabarito novo. O `meta.jsonl` traz a camada determinística esperada, calculada por `retrieveFutConstraints`, e a classe esperada derivada dela, sem uma segunda semântica.

## 6. Validações

Validações externas (2026-10-06, Neo4j, motor fut com bge-m3 e API no ar):

| validação | resultado |
|---|---|
| `npm run typecheck` (inclui este script) | OK |
| `futebol.fut` carregado por `loadFutModel` com validação | OK, sem erro léxico, sintático ou de referência (`npm run validate` só cobre o `uti.dsl`) |
| parser de upload do lote (`web-chat/src/lote.ts::parseArquivoLote`) sobre `cenarios-400-fut.jsonl` | 400 cenários; contexto com `partida`, `telemetria` (11 campos), `contextos`, `infracoesEmUso` |
| `test:foco-politica`, `test:restricoes`, `test:recuperacao-conhecimento` como estão | falham com ENOENT ao abrir `cenarios-200-fut.jsonl` (arquivo renomeado; §5.3), antes de olhar qualquer cenário |
| as mesmas três, em cópias temporárias apontadas para `cenarios-400-fut.jsonl` (removidas depois) | todas passam. foco-politica caso 4 (fut): 9200 comparações, 0 ampliações. restricoes: fut sobre as 400 linhas (2000 comparações × 3 RAGs + regras adversariais), 732 itens restritos examinados nos três domínios, 0 achados. recuperacao-conhecimento: 5 configurações × 130 cenários fut, saída idêntica ao bloco antigo do servidor |
| foco real (`retrieverFocoFut` com Neo4j e `/embed`) + `filtrarPorFocoFut` nos 400 | veto aplicado por lance com gatilho que NÃO disparou em 16 antigos e 15 novos (29 deles Jogador_Sem_Advertencia → Reincidencia_Amarelo, semeado pelo índice; 1 Posicao_Legal_No_Passe e 1 Mao_Curta_Distancia, pelo nome escrito em VP-LEX-*). Política do alvo reduzida de 13 para 3 decisões em 11 novos: FR-REINC-SIMULACAO, FR-REINC-PERDA, FR-REINC-DISSENSO, FR-REINC-EMUSO (todos com 1 amarelo), VP-LEX-ADVERTENCIA (A **e** B: o índice semeia o lance mesmo sem o nome escrito), VP-LEX-POSICAO A, VP-LEX-CURTA A, PR-SUMULA-REINC (1 amarelo), PR-SUMULA-EXPULSAO, UN-REINC-CARTOES. Alvo fora do foco real: 3 (UN-LING-IRONIA e UN-DISSENSO-SEMOFENSA → Dissenso; UN-LING-GESTO → Linguagem_Ofensiva): falas naturais sem o nome da infração, que nem o índice alcança |
| amostra ponta a ponta pela API (`POST /api/comando` com o contexto do lote; 4 cenários, 2 contrastes de sensibilidade; 12 a 14 min por cenário) | 4/4 aceitos e `valido=true`, sem erro de motor. **FR-MAO-BRACO, 0,99 → 1,01 m**: Mao_Deliberada ACIONAR_VAR (vetada, decisão de retirada) → PENALTI. A decisão muda exatamente na fronteira. Mas o PENALTI veio sem zona na leitura e com o alerta "revisão do VAR confirmou toque deliberado" sem revisão registrada: as duas regras globais de evidência foram violadas, coisa para o oráculo e o juiz julgarem. **FR-REINC-SIMULACAO, 0 → 1 amarelo**: com 0, Reincidencia_Amarelo ACIONAR_VAR (vetada, correto). Com 1, nenhuma cláusula de Reincidencia_Amarelo ("1 cláusula descartada"). O Prompt Semântico listou Jogador_Sem_Advertencia "sem gatilho ativo — lance identificado no pedido" e Reincidencia_Amarelo como vetada "sem advertência prévia registrada", o que é falso para a leitura. Sensibilidade falhou, como o foco real previa (§5.1) |
| gabarito oficial (`gerar-ground-truth-fut.ts`) | não executado: gabarito fechado de 25 cenários, sem entrada externa, e grava por cima de `cenarios-25-fut.jsonl` e `ground_truth_fut.jsonl` (§5.4) |
| lote completo dos 200 novos | não executado nesta sessão: ~3,5 min por cenário com o motor livre (~12 h). Rodar pelo upload do web-chat com `cenarios-400-fut.jsonl` e avaliar em "Avaliar resultados" |

Validações internas (este script, a cada execução):

- formato: 400 registros relidos, 200 novos, 400 partidas únicas, chaves e ordem idênticas aos antigos: sim, antigos intactos: sim, serializador reproduz os antigos byte a byte: 200/200;
- coerência da leitura: cartões em {0,1}; nenhuma distância, revisão ou contagem negativa; revisão 0 em Competicao_Sem_VAR; disputa de pênaltis com minuto ≥ 120, sem acréscimo e bola a 11 m; acréscimo > 0 só no fim de um tempo; Acrescimos dentro da janela de acréscimo; contextos e infrações existentes no modelo;
- controle: nenhum par de uma família varia fora da dimensão declarada; foco lexical idêntico entre membros das famílias que não variam a fala;
- novidade: duplicados lógicos contra os antigos: 0; entre famílias novas: 0. A assinatura lógica cobre infrações citadas, objetivo, canal da evidência, alegações, contextos, infrações em uso, estado determinístico que toca as infrações citadas e faixa de cada limiar relevante. Repetir a mesma assinatura só é permitido dentro de uma família de invariância.
- transparência do canal: 7 cenários novos têm a mesma assinatura de um antigo, exceto pelo canal (o antigo diz o valor na fala; o novo deixa só a leitura). São âncoras (valor longe do limiar, ou exatamente no limiar) ou células de um par/fatorial, mantidas porque a família precisa delas para o contraste. Sozinhas, repetiriam um caminho antigo — PT-2026-4201 (FR-IMP-GOL) ~ PT-2026-4133; PT-2026-4203 (FR-IMP-GOL) ~ PT-2026-4139; PT-2026-4209 (FR-MAO-BRACO) ~ PT-2026-4055; PT-2026-4228 (FR-REINC-PERDA) ~ PT-2026-4185; PT-2026-4230 (FR-REINC-DISSENSO) ~ PT-2026-4183; PT-2026-4237 (FR-VAR-DOGSO) ~ PT-2026-4157; PT-2026-4244 (VP-DP-REINC) ~ PT-2026-4193.

## 7. Estruturas analisadas e limites

- **Penalti_Na_Area** e **Disputa_Bola_Dividida**: analisados. Não têm gatilho: não são exercitáveis como condição estruturada, só pelo foco do pedido (o nome escrito ou o índice vetorial). Os novos os trazem pelo nome em PR-ETAPAS-PENALTI-* e PR-DIVIDIDA-VANT.
- **`zona_penal`** (todas as infrações que a declaram): analisada. Não exercitável como condição estruturada: a zona do contato não é leitura da partida, e `distancia_gol` não a substitui (declarado no modelo). Exercitada só como consequência pedida, sempre com evidência insuficiente (EV-ZONA-CV, NG-DG-AREA-CARGA, PR-COMUNICA-CUSP).
- **`isento` / exceção, `confusao_comum`, `monitorar`**: analisados. São texto, não condição. Exercitados por pedidos que dependem deles (UN-*, EV-CONTATO-SIM, EV-AUTOR-CUSP, UN-CUSP-ISENTO, UN-PERDA-*), sem telemetria inventada.
- **`var_revisavel`**: analisado. Vai ao grafo e aos documentos do índice vetorial, nunca à política. Não exercitável como condição; o par UN-VARREV-LING / UN-VARREV-DISSENSO mede se o atributo documental muda algo.
- **`desfecho` / `reavaliar_em`**: analisados. São texto do lance, sem efeito em política, contrato ou validação. Não exercitáveis como condição estruturada.
- **`etapa` / `prazo`**: texto. Exercitados por pedidos de procedimento com o lance ativo de um lado do limiar e inativo do outro (PR-ETAPAS-IMP, PR-SUMULA-REINC, PR-CVJ-VANTAGEM).
- **`exige`** dos contextos: texto que chega ao grafo. Exercitado por pares com e sem o contexto (CT-*). Não muda o universo de decisões.
- **Competicao_Sem_VAR × escalonamento**: o conflito (revisão > 5 min numa competição sem VAR) só é alcançável com leitura incoerente (revisão em curso sem VAR). Analisado; não gerado. O modelo também não consegue retirar ACIONAR_VAR por contexto (lacuna SEM_VAR de `cobertura-200-fut.md`).
- **"Repetir a cobrança" (Lei 14)**: não existe no enum de decisões (lacuna RETAKE). VP-EXCL-IMP-DP, CT-DP-PARADINHA e PR-DP-VAR pedem isso de propósito, para medir se o sistema inventa uma decisão.
- **Operadores**: só `<`, `>=` e `>` aparecem no modelo. Não há regra com `<=`, `==` ou `!=` para exercitar.
- **Parâmetros sem poder decisório**: entram como dimensão controlada só em famílias de invariância (NG-*), atravessando limiares que versões anteriores do modelo usavam (16,5 m, 40 m, 5 faltas, 2 jogadores, acréscimo > 0). Nenhum foi tratado como regra.
- **Evidência ausente pela leitura** (parâmetro fora da telemetria): o código trata parâmetro ausente como regra que não incide, mas o formato dos antigos sempre traz os 11 campos e foi mantido. A ausência foi exercitada pela fala (fato alegado sem leitura) e pelos contextos (contexto citado na fala e não marcado).
- **`tempo_revisao_var` e `distancia_gol`**: `tempo_revisao_var` é inteiro nos antigos e recebe decimais (4.99, 5.01) nas famílias de fronteira, porque o ±ε em minutos exige. `distancia_gol` continua inteiro.
- **Cartões**: inteiros 0/1. O ±ε não se aplica e 2 amarelos seria leitura incoerente.
