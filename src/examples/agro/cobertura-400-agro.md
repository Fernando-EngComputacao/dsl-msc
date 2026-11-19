# Cobertura dos 400 cenarios do dominio agro

Gerado por `src/scripts/gerar-cenarios-400-agro.ts`. NAO EDITAR A MAO.

Os 200 primeiros cenarios sao os de `cenarios-200-agro.jsonl`, copiados byte a byte.
Os 200 ultimos (TL-2026-4201 a TL-2026-4400) sao a suite nova, declarada em
73 familias controladas. Dentro de uma familia so muda a dimensao declarada;
o resto da leitura e identico, e isso e conferido por assercao antes da gravacao.

## Completude dos pedidos

Todo cenario — antigo e novo — passou, antes da gravacao, por:

1. **esquema e faixa fisica** de cada um dos 10 sensores, mais coerencia entre
   temperatura do ar e da folha e entre chuva prevista e umidade;
2. **area x sensor**: area declarada com o sensor fora do criterio reprova como
   CONTRADICAO; sensor dentro do criterio com cadastro vazio so passa em familia
   que declara `cadastroAusente` — o caso que a regra global do modelo preve;
3. **fala x leitura**: todo numero citado na fala (km/h, m do manancial, m da
   cultura sensivel, NDVI, temperatura/umidade foliar, infestacao, mm de chuva)
   tem de bater com o sensor, e toda vazao citada tem de ser dose declarada na
   bula do produto que a fala nomeia;
4. **ancoragem**: a fala nomeia ao menos um produto ou cultura do modelo pelo
   mesmo `casamentoLexical` que o foco usa — nao basta parecer do dominio;
5. **calda x fala**: quem diz que o produto esta na calda tem de te-lo em
   `produtosEmUso`, e quem diz que o tanque esta limpo sem te-lo vazio precisa
   declarar a alegacao (e, assim, entrar no bloco de evidencia insuficiente).

```json
{
  "arquivoAntigo": "src/examples/agro/cenarios-200-agro.jsonl",
  "serializacaoReproduzAntigos": "200/200",
  "totalRelido": 400,
  "novos": 200,
  "talhoesUnicos": 400,
  "chavesEOrdemIdenticas": true,
  "antigosIntactos": true,
  "maiorSimilaridadeComAntigo": {
    "valor": 0.5277777777777778,
    "novo": "TL-2026-4224",
    "antigo": "TL-2026-4157"
  },
  "maiorSimilaridadeEntreNovos": {
    "valor": 0.5773195876288659,
    "a": "TL-2026-4224",
    "b": "TL-2026-4255"
  },
  "duplicadosLogicosAntigos": 0,
  "duplicadosLogicosEntreFamilias": 0,
  "diferemDeUmAntigoSoPeloCanal": 5
}
```

## Desenho dos 200 novos


### Blocos

| | 200 antigos | 200 novos | 400 |
|---|---:|---:|---:|
| area | 0 | 18 | 18 |
| calda | 0 | 16 | 16 |
| escalonamento_procedimento | 0 | 26 | 26 |
| evidencia | 0 | 19 | 19 |
| fronteira | 0 | 71 | 71 |
| interacao | 0 | 17 | 17 |
| unitario | 0 | 8 | 8 |
| veto_proibicao | 0 | 25 | 25 |


## Tipos de caso (uma familia pode ter mais de um)

- `fronteira`: 82
- `procedimento`: 52
- `contextual`: 48
- `combinatorio`: 40
- `evidencia_insuficiente`: 27
- `negativo`: 24
- `estado_de_curso`: 23
- `unitario_semantico`: 11

## Estilo da fala

- `pergunta_direta`: 58
- `duvida_operacional`: 40
- `ordem`: 31
- `relato_e_pergunta`: 14
- `urgente`: 14
- `procedimento`: 11
- `alegacao_sem_leitura`: 9
- `conclusao_prematura`: 9
- `compara_produtos`: 7
- `manter_decisao`: 2
- `pede_substituicao`: 2
- `relato_informal`: 2
- `info_irrelevante`: 1

## Objetivo do pedido

- `aplicar`: 118
- `ajustar_vazao`: 20
- `acionar_agronomo`: 18
- `procedimento`: 14
- `bloquear_ou_suspender`: 8
- `classificar_restricao`: 8
- `aguardar_janela`: 7
- `substituir_produto`: 5
- `solicitar_varredura`: 2

## Status deterministico do produto-alvo

- `APLICAVEL`: 133
- `BLOQUEADO_POR_SENSOR`: 35
- `EXCLUIDO_VETO_DE_CULTURA`: 13
- `EXCLUIDO_PROIBICAO_DE_AREA`: 11
- `SEM_PRODUTO_ALVO`: 8

## Classe esperada

- `APLICAVEL`: 119
- `SEM_INCREMENTO_PARA_O_ALVO`: 35
- `SEM_APLICACAO_PARA_O_ALVO`: 24
- `APLICAVEL_COM_EVIDENCIA_INSUFICIENTE`: 14
- `SEM_PRODUTO_ALVO`: 8

## Contrastes controlados

224 pares que mudam exatamente uma dimensao.

- `sensibilidade`: a politica, a vazao ou o escalonamento do alvo muda — a decisao DEVE mudar.
- `procedimento`: muda cultura ativa, recomendacao ou exigencia, nao a politica — a justificativa deve refletir, a decisao pode ficar.
- `invariancia`: nenhuma regra muda — a decisao NAO deve mudar.

- `sensibilidade`: 94
- `invariancia`: 81
- `procedimento`: 49

### Dimensao variada em cada par

- `intencao`: 43
- `telemetria.vento`: 34
- `telemetria.NDVI`: 25
- `telemetria.temperatura_foliar`: 16
- `telemetria.umidade`: 16
- `areas`: 13
- `produtosEmUso`: 13
- `telemetria.distancia_manancial`: 13
- `telemetria.umidade_foliar`: 13
- `telemetria.infestacao`: 12
- `telemetria.distancia_cultura_sensivel`: 10
- `telemetria.temperatura`: 10
- `telemetria.chuva_prevista`: 6

## Cobertura comparada

| | 200 antigos | 200 novos | 400 |
|---|---:|---:|---:|
| cenarios | 200 | 200 | 400 |
| intencoes unicas | 200 | 177 | 377 |
| talhoes unicos | 200 | 200 | 400 |
| aberturas de fala distintas | 106 | 128 | 209 |
| maior repeticao de abertura | 14 | 6 | 15 |
| no limiar ou a epsilon dele | 197 | 195 | 392 |
| com bloqueio por sensor | 84 | 79 | 163 |
| com veto ou proibicao | 200 | 168 | 368 |
| com produto na calda | 81 | 18 | 99 |
| com mais de uma area | 0 | 3 | 3 |
| com fato so na fala | 50 | 55 | 105 |
| com exigencia de area | 31 | 32 | 63 |
| com janela de cultura | 200 | 200 | 400 |
| combinatorios (2+ mecanismos) | 123 | 95 | 218 |

### Canal da evidencia decisiva

| | 200 antigos | 200 novos | 400 |
|---|---:|---:|---:|
| fala_cita_fato_decisivo | 199 | 3 | 202 |
| so_a_leitura | 1 | 197 | 198 |


### Produtos citados na fala

| | 200 antigos | 200 novos | 400 |
|---|---:|---:|---:|
| Acefato | 25 | 29 | 54 |
| Atrazina | 27 | 35 | 62 |
| Azoxistrobina | 21 | 19 | 40 |
| Clorpirifos | 24 | 18 | 42 |
| Dois_Quatro_D | 6 | 22 | 28 |
| Glifosato | 28 | 38 | 66 |
| Imidacloprido | 25 | 18 | 43 |
| Mancozebe | 24 | 12 | 36 |
| Nicosulfuron | 22 | 27 | 49 |


### Culturas ativas por gatilho

| | 200 antigos | 200 novos | 400 |
|---|---:|---:|---:|
| Cana_de_Acucar | 80 | 42 | 122 |
| Milho | 189 | 133 | 322 |
| Soja | 133 | 107 | 240 |


### Areas no cadastro

| | 200 antigos | 200 novos | 400 |
|---|---:|---:|---:|
| Apiario_Proximo | 9 | 8 | 17 |
| Faixa_Manancial | 14 | 17 | 31 |
| Vizinhanca_Sensivel | 8 | 12 | 20 |


### Produtos na calda

| | 200 antigos | 200 novos | 400 |
|---|---:|---:|---:|
| Acefato | 14 | 3 | 17 |
| Atrazina | 8 | 6 | 14 |
| Azoxistrobina | 7 | 0 | 7 |
| Clorpirifos | 12 | 1 | 13 |
| Dois_Quatro_D | 10 | 5 | 15 |
| Glifosato | 15 | 3 | 18 |
| Imidacloprido | 11 | 1 | 12 |
| Mancozebe | 15 | 3 | 18 |
| Nicosulfuron | 6 | 2 | 8 |


### Bloqueios por sensor

| | 200 antigos | 200 novos | 400 |
|---|---:|---:|---:|
| Acefato <- chuva_prevista | 7 | 5 | 12 |
| Atrazina <- distancia_manancial | 20 | 27 | 47 |
| Azoxistrobina <- umidade | 4 | 1 | 5 |
| Clorpirifos <- temperatura | 8 | 6 | 14 |
| Dois_Quatro_D <- vento | 18 | 24 | 42 |
| Glifosato <- vento | 10 | 15 | 25 |
| Imidacloprido <- temperatura_foliar | 27 | 12 | 39 |
| Mancozebe <- umidade | 8 | 8 | 16 |
| Nicosulfuron <- vento | 10 | 15 | 25 |


### Vetos de cultura

| | 200 antigos | 200 novos | 400 |
|---|---:|---:|---:|
| Atrazina <- Soja | 133 | 107 | 240 |
| Dois_Quatro_D <- Milho | 189 | 133 | 322 |
| Nicosulfuron <- Cana_de_Acucar | 80 | 42 | 122 |


### Proibicoes de area

| | 200 antigos | 200 novos | 400 |
|---|---:|---:|---:|
| Atrazina <- Faixa_Manancial | 14 | 17 | 31 |
| Clorpirifos <- Apiario_Proximo | 9 | 8 | 17 |
| Dois_Quatro_D <- Vizinhanca_Sensivel | 8 | 12 | 20 |
| Glifosato <- Faixa_Manancial | 14 | 17 | 31 |
| Imidacloprido <- Apiario_Proximo | 9 | 8 | 17 |


### Ajustes de vazao

| | 200 antigos | 200 novos | 400 |
|---|---:|---:|---:|
| Acefato <- Apiario_Proximo | 9 | 8 | 17 |
| Atrazina <- Vizinhanca_Sensivel | 8 | 12 | 20 |
| Imidacloprido <- Faixa_Manancial | 14 | 17 | 31 |


### Escalonamentos

| | 200 antigos | 200 novos | 400 |
|---|---:|---:|---:|
| Cana_de_Acucar -> AGRONOMO_RESPONSAVEL | 5 | 6 | 11 |
| Cana_de_Acucar -> CENTRO_METEOROLOGICO | 1 | 1 | 2 |
| Milho -> OPERADOR_DRONE | 6 | 2 | 8 |
| Milho -> ORGAO_AMBIENTAL | 19 | 25 | 44 |
| Soja -> AGRONOMO_RESPONSAVEL | 4 | 2 | 6 |
| Soja -> CENTRO_METEOROLOGICO | 1 | 3 | 4 |


### Incompatibilidades de calda

| | 200 antigos | 200 novos | 400 |
|---|---:|---:|---:|
| Acefato + Nicosulfuron | 16 | 4 | 20 |
| Atrazina + Clorpirifos | 16 | 6 | 22 |
| Atrazina + Dois_Quatro_D | 16 | 8 | 24 |
| Clorpirifos + Atrazina | 16 | 6 | 22 |
| Dois_Quatro_D + Atrazina | 16 | 8 | 24 |
| Glifosato + Mancozebe | 27 | 5 | 32 |
| Mancozebe + Glifosato | 27 | 5 | 32 |
| Nicosulfuron + Acefato | 16 | 4 | 20 |


### Fatos so na fala

| | 200 antigos | 200 novos | 400 |
|---|---:|---:|---:|
| CADASTRO | 0 | 11 | 11 |
| CARENCIA | 12 | 5 | 17 |
| CHUVA | 13 | 4 | 17 |
| COLMEIA | 7 | 6 | 13 |
| DIRECAO_VENTO | 0 | 3 | 3 |
| FLORADA | 2 | 2 | 4 |
| HORA | 5 | 2 | 7 |
| JANELA | 2 | 4 | 6 |
| RECEITA | 0 | 1 | 1 |
| SOBRA_GALPAO | 4 | 4 | 8 |
| TANQUE_LIMPO | 0 | 2 | 2 |
| VENTO_BAIXOU | 0 | 2 | 2 |
| VIZINHO | 8 | 16 | 24 |


### Objetivos do pedido

| | 200 antigos | 200 novos | 400 |
|---|---:|---:|---:|
| aplicar | 93 | 89 | 182 |
| bloquear_ou_suspender | 4 | 11 | 15 |
| calda | 11 | 13 | 24 |
| classificar | 7 | 14 | 21 |
| escalonar | 10 | 20 | 30 |
| janela | 24 | 17 | 41 |
| procedimento | 30 | 33 | 63 |
| substituir | 1 | 5 | 6 |
| varredura | 2 | 12 | 14 |
| vazao | 14 | 27 | 41 |


## Faixa de cada limiar estruturado

Para cada regra do `lavoura.agro` com condicao estruturada, quantos cenarios caem
longe abaixo, a epsilon abaixo, no limiar, a epsilon acima e longe acima.


### Limiares

| | 200 antigos | 200 novos | 400 |
|---|---:|---:|---:|
| escalonar AGRONOMO (infestacao) (infestacao vs 30): abaixo_epsilon | 1 | 1 | 2 |
| escalonar AGRONOMO (infestacao) (infestacao vs 30): abaixo_longe | 195 | 196 | 391 |
| escalonar AGRONOMO (infestacao) (infestacao vs 30): acima_epsilon | 1 | 1 | 2 |
| escalonar AGRONOMO (infestacao) (infestacao vs 30): acima_longe | 3 | 1 | 4 |
| escalonar AGRONOMO (infestacao) (infestacao vs 30): no_limiar | 0 | 1 | 1 |
| escalonar AGRONOMO (vizinhanca) (distancia_cultura_sensivel vs 300): abaixo_epsilon | 2 | 10 | 12 |
| escalonar AGRONOMO (vizinhanca) (distancia_cultura_sensivel vs 300): abaixo_longe | 7 | 11 | 18 |
| escalonar AGRONOMO (vizinhanca) (distancia_cultura_sensivel vs 300): acima_epsilon | 0 | 2 | 2 |
| escalonar AGRONOMO (vizinhanca) (distancia_cultura_sensivel vs 300): acima_longe | 190 | 176 | 366 |
| escalonar AGRONOMO (vizinhanca) (distancia_cultura_sensivel vs 300): no_limiar | 1 | 1 | 2 |
| escalonar CENTRO_METEOROLOGICO (vento vs 15): abaixo_epsilon | 2 | 1 | 3 |
| escalonar CENTRO_METEOROLOGICO (vento vs 15): abaixo_longe | 197 | 194 | 391 |
| escalonar CENTRO_METEOROLOGICO (vento vs 15): acima_epsilon | 1 | 1 | 2 |
| escalonar CENTRO_METEOROLOGICO (vento vs 15): acima_longe | 0 | 2 | 2 |
| escalonar CENTRO_METEOROLOGICO (vento vs 15): no_limiar | 0 | 2 | 2 |
| gatilho Cana (NDVI) (NDVI vs 0.35): abaixo_epsilon | 18 | 5 | 23 |
| gatilho Cana (NDVI) (NDVI vs 0.35): abaixo_longe | 43 | 29 | 72 |
| gatilho Cana (NDVI) (NDVI vs 0.35): acima_epsilon | 13 | 3 | 16 |
| gatilho Cana (NDVI) (NDVI vs 0.35): acima_longe | 118 | 162 | 280 |
| gatilho Cana (NDVI) (NDVI vs 0.35): no_limiar | 8 | 1 | 9 |
| gatilho Milho (NDVI) (NDVI vs 0.45): abaixo_epsilon | 16 | 8 | 24 |
| gatilho Milho (NDVI) (NDVI vs 0.45): abaixo_longe | 162 | 96 | 258 |
| gatilho Milho (NDVI) (NDVI vs 0.45): acima_epsilon | 2 | 1 | 3 |
| gatilho Milho (NDVI) (NDVI vs 0.45): acima_longe | 19 | 93 | 112 |
| gatilho Milho (NDVI) (NDVI vs 0.45): no_limiar | 1 | 2 | 3 |
| gatilho Milho (umidade foliar) (umidade_foliar vs 60): abaixo_epsilon | 2 | 1 | 3 |
| gatilho Milho (umidade foliar) (umidade_foliar vs 60): abaixo_longe | 59 | 48 | 107 |
| gatilho Milho (umidade foliar) (umidade_foliar vs 60): acima_epsilon | 1 | 1 | 2 |
| gatilho Milho (umidade foliar) (umidade_foliar vs 60): acima_longe | 138 | 149 | 287 |
| gatilho Milho (umidade foliar) (umidade_foliar vs 60): no_limiar | 0 | 1 | 1 |
| gatilho Soja (NDVI) (NDVI vs 0.4): abaixo_epsilon | 5 | 1 | 6 |
| gatilho Soja (NDVI) (NDVI vs 0.4): abaixo_longe | 101 | 78 | 179 |
| gatilho Soja (NDVI) (NDVI vs 0.4): acima_epsilon | 9 | 1 | 10 |
| gatilho Soja (NDVI) (NDVI vs 0.4): acima_longe | 76 | 118 | 194 |
| gatilho Soja (NDVI) (NDVI vs 0.4): no_limiar | 9 | 2 | 11 |
| gatilho Soja (infestacao) (infestacao vs 15): abaixo_epsilon | 12 | 3 | 15 |
| gatilho Soja (infestacao) (infestacao vs 15): abaixo_longe | 147 | 165 | 312 |
| gatilho Soja (infestacao) (infestacao vs 15): acima_epsilon | 2 | 1 | 3 |
| gatilho Soja (infestacao) (infestacao vs 15): acima_longe | 37 | 30 | 67 |
| gatilho Soja (infestacao) (infestacao vs 15): no_limiar | 2 | 1 | 3 |
| regra_seguranca Acefato (chuva_prevista vs 0): acima_longe | 7 | 5 | 12 |
| regra_seguranca Acefato (chuva_prevista vs 0): no_limiar | 193 | 195 | 388 |
| regra_seguranca Atrazina / escalonar ORGAO_AMBIENTAL (distancia_manancial vs 500): abaixo_epsilon | 2 | 2 | 4 |
| regra_seguranca Atrazina / escalonar ORGAO_AMBIENTAL (distancia_manancial vs 500): abaixo_longe | 18 | 25 | 43 |
| regra_seguranca Atrazina / escalonar ORGAO_AMBIENTAL (distancia_manancial vs 500): acima_epsilon | 1 | 2 | 3 |
| regra_seguranca Atrazina / escalonar ORGAO_AMBIENTAL (distancia_manancial vs 500): acima_longe | 179 | 169 | 348 |
| regra_seguranca Atrazina / escalonar ORGAO_AMBIENTAL (distancia_manancial vs 500): no_limiar | 0 | 2 | 2 |
| regra_seguranca Azoxistrobina (umidade vs 50): abaixo_epsilon | 1 | 1 | 2 |
| regra_seguranca Azoxistrobina (umidade vs 50): abaixo_longe | 3 | 0 | 3 |
| regra_seguranca Azoxistrobina (umidade vs 50): acima_epsilon | 1 | 1 | 2 |
| regra_seguranca Azoxistrobina (umidade vs 50): acima_longe | 195 | 197 | 392 |
| regra_seguranca Azoxistrobina (umidade vs 50): no_limiar | 0 | 1 | 1 |
| regra_seguranca Clorpirifos (temperatura vs 32): abaixo_epsilon | 0 | 1 | 1 |
| regra_seguranca Clorpirifos (temperatura vs 32): abaixo_longe | 191 | 192 | 383 |
| regra_seguranca Clorpirifos (temperatura vs 32): acima_epsilon | 0 | 1 | 1 |
| regra_seguranca Clorpirifos (temperatura vs 32): acima_longe | 8 | 5 | 13 |
| regra_seguranca Clorpirifos (temperatura vs 32): no_limiar | 1 | 1 | 2 |
| regra_seguranca Dois_Quatro_D (vento vs 8): abaixo_epsilon | 0 | 2 | 2 |
| regra_seguranca Dois_Quatro_D (vento vs 8): abaixo_longe | 163 | 173 | 336 |
| regra_seguranca Dois_Quatro_D (vento vs 8): acima_epsilon | 1 | 1 | 2 |
| regra_seguranca Dois_Quatro_D (vento vs 8): acima_longe | 17 | 23 | 40 |
| regra_seguranca Dois_Quatro_D (vento vs 8): no_limiar | 19 | 1 | 20 |
| regra_seguranca Glifosato (vento vs 10): abaixo_epsilon | 0 | 3 | 3 |
| regra_seguranca Glifosato (vento vs 10): abaixo_longe | 188 | 180 | 368 |
| regra_seguranca Glifosato (vento vs 10): acima_epsilon | 1 | 2 | 3 |
| regra_seguranca Glifosato (vento vs 10): acima_longe | 9 | 13 | 22 |
| regra_seguranca Glifosato (vento vs 10): no_limiar | 2 | 2 | 4 |
| regra_seguranca Imidacloprido / gatilho Cana (temperatura_foliar vs 38): abaixo_epsilon | 0 | 2 | 2 |
| regra_seguranca Imidacloprido / gatilho Cana (temperatura_foliar vs 38): abaixo_longe | 170 | 181 | 351 |
| regra_seguranca Imidacloprido / gatilho Cana (temperatura_foliar vs 38): acima_epsilon | 1 | 1 | 2 |
| regra_seguranca Imidacloprido / gatilho Cana (temperatura_foliar vs 38): acima_longe | 26 | 11 | 37 |
| regra_seguranca Imidacloprido / gatilho Cana (temperatura_foliar vs 38): no_limiar | 3 | 5 | 8 |
| regra_seguranca Mancozebe (umidade vs 55): abaixo_epsilon | 1 | 2 | 3 |
| regra_seguranca Mancozebe (umidade vs 55): abaixo_longe | 7 | 6 | 13 |
| regra_seguranca Mancozebe (umidade vs 55): acima_epsilon | 0 | 1 | 1 |
| regra_seguranca Mancozebe (umidade vs 55): acima_longe | 191 | 190 | 381 |
| regra_seguranca Mancozebe (umidade vs 55): no_limiar | 1 | 1 | 2 |
| regra_seguranca Nicosulfuron (vento vs 10): abaixo_epsilon | 0 | 3 | 3 |
| regra_seguranca Nicosulfuron (vento vs 10): abaixo_longe | 188 | 180 | 368 |
| regra_seguranca Nicosulfuron (vento vs 10): acima_epsilon | 1 | 2 | 3 |
| regra_seguranca Nicosulfuron (vento vs 10): acima_longe | 9 | 13 | 22 |
| regra_seguranca Nicosulfuron (vento vs 10): no_limiar | 2 | 2 | 4 |


## Valores distintos por sensor


### Sensores

| | 200 antigos | 200 novos | 400 |
|---|---:|---:|---:|
| NDVI | 38 | 24 | 44 |
| chuva_prevista | 8 | 6 | 9 |
| distancia_cultura_sensivel | 193 | 20 | 206 |
| distancia_manancial | 187 | 24 | 201 |
| infestacao | 32 | 25 | 33 |
| temperatura | 16 | 13 | 18 |
| temperatura_foliar | 24 | 16 | 27 |
| umidade | 37 | 25 | 41 |
| umidade_foliar | 44 | 20 | 46 |
| vento | 16 | 20 | 25 |


## Estruturas do modelo efetivamente exercidas

Nao basta citar o nome: a estrutura conta quando a camada deterministica a dispara.

- `janela Milho`: 345
- `gatilho Milho`: 322
- `veta Milho -> Dois_Quatro_D`: 322
- `gatilho Soja`: 240
- `veta Soja -> Atrazina`: 240
- `recomenda Milho -> Nicosulfuron`: 235
- `recomenda Milho -> Atrazina`: 231
- `janela Soja`: 175
- `janela Cana_de_Acucar`: 147
- `recomenda Soja -> Acefato`: 140
- `recomenda Soja -> Glifosato`: 140
- `recomenda Soja -> Mancozebe`: 140
- `recomenda Milho -> Clorpirifos`: 137
- `gatilho Cana_de_Acucar`: 122
- `veta Cana_de_Acucar -> Nicosulfuron`: 122
- `recomenda Cana_de_Acucar -> Dois_Quatro_D`: 112
- `recomenda Cana_de_Acucar -> Azoxistrobina`: 110
- `recomenda Cana_de_Acucar -> Imidacloprido`: 110
- `regra_seguranca Atrazina`: 47
- `escalonar Milho -> ORGAO_AMBIENTAL`: 44
- `regra_seguranca Dois_Quatro_D`: 42
- `regra_seguranca Imidacloprido`: 39
- `foco Cana_de_Acucar (sem gatilho ativo)`: 34
- `incompativel Glifosato + Mancozebe`: 32
- `incompativel Mancozebe + Glifosato`: 32
- `ajusta Faixa_Manancial -> Imidacloprido`: 31
- `exige Faixa_Manancial`: 31
- `proibe Faixa_Manancial -> Atrazina`: 31
- `proibe Faixa_Manancial -> Glifosato`: 31
- `regra_seguranca Glifosato`: 25
- `regra_seguranca Nicosulfuron`: 25
- `incompativel Atrazina + Dois_Quatro_D`: 24
- `incompativel Dois_Quatro_D + Atrazina`: 24
- `foco Milho (sem gatilho ativo)`: 23
- `incompativel Atrazina + Clorpirifos`: 22
- `incompativel Clorpirifos + Atrazina`: 22
- `ajusta Vizinhanca_Sensivel -> Atrazina`: 20
- `exige Vizinhanca_Sensivel`: 20
- `incompativel Acefato + Nicosulfuron`: 20
- `incompativel Nicosulfuron + Acefato`: 20
- `proibe Vizinhanca_Sensivel -> Dois_Quatro_D`: 20
- `foco Soja (sem gatilho ativo)`: 18
- `ajusta Apiario_Proximo -> Acefato`: 17
- `exige Apiario_Proximo`: 17
- `proibe Apiario_Proximo -> Clorpirifos`: 17
- `proibe Apiario_Proximo -> Imidacloprido`: 17
- `regra_seguranca Mancozebe`: 16
- `regra_seguranca Clorpirifos`: 14
- `regra_seguranca Acefato`: 12
- `escalonar Cana_de_Acucar -> AGRONOMO_RESPONSAVEL`: 11
- `escalonar Milho -> OPERADOR_DRONE`: 8
- `escalonar Soja -> AGRONOMO_RESPONSAVEL`: 6
- `regra_seguranca Azoxistrobina`: 5
- `escalonar Soja -> CENTRO_METEOROLOGICO`: 4
- `escalonar Cana_de_Acucar -> CENTRO_METEOROLOGICO`: 2

**Todos os gatilhos de cultura do modelo sao exercidos pelos 400.**

## Limites conhecidos

- O foco offline nao usa o indice vetorial do Neo4j: ele e lexical mais arestas do
  grafo. Em producao o indice pode trazer mais produtos ao Prompt Semantico, nunca
  menos restricao — a avaliacao de bloqueio e deterministica em `retrieveAgroConstraints`.
- Alvo fora do foco offline: 0.
- Politica do alvo que o foco estreita em relacao ao modelo: 10
  - TL-2026-4273 (VT-SOJA-ATRAZINA): Atrazina — modelo 7 decisoes, depois do foco 3 (culturas em foco: Milho, Soja)
  - TL-2026-4274 (VT-SOJA-ATRAZINA): Atrazina — modelo 7 decisoes, depois do foco 3 (culturas em foco: Milho, Soja)
  - TL-2026-4276 (VT-MILHO-24D): Dois_Quatro_D — modelo 7 decisoes, depois do foco 3 (culturas em foco: Cana_de_Acucar, Milho)
  - TL-2026-4277 (VT-MILHO-24D): Dois_Quatro_D — modelo 7 decisoes, depois do foco 3 (culturas em foco: Cana_de_Acucar, Milho)
  - TL-2026-4279 (VT-CANA-NICO): Nicosulfuron — modelo 7 decisoes, depois do foco 3 (culturas em foco: Cana_de_Acucar, Milho)
  - TL-2026-4280 (VT-CANA-NICO): Nicosulfuron — modelo 7 decisoes, depois do foco 3 (culturas em foco: Cana_de_Acucar, Milho)
  - TL-2026-4324 (CA-ATRA-24D): Dois_Quatro_D — modelo 7 decisoes, depois do foco 3 (culturas em foco: Cana_de_Acucar, Milho)
  - TL-2026-4325 (CA-ATRA-24D): Dois_Quatro_D — modelo 10 decisoes, depois do foco 4 (culturas em foco: Cana_de_Acucar, Milho)
  - TL-2026-4326 (CA-ATRA-24D): Dois_Quatro_D — modelo 10 decisoes, depois do foco 4 (culturas em foco: Cana_de_Acucar, Milho)
  - TL-2026-4392 (IN-CALDA-E-AREA): Dois_Quatro_D — modelo 10 decisoes, depois do foco 4 (culturas em foco: Cana_de_Acucar, Milho).
- Cenarios novos que diferem de algum antigo so pelo canal da evidencia: 5 (TL-2026-4214 (FR-TEMP-CLORPI) ~ TL-2026-4120; TL-2026-4227 (FR-UMID-AZOXI) ~ TL-2026-4173; TL-2026-4283 (PR-MANANCIAL-GLIFO) ~ TL-2026-4004; TL-2026-4297 (AJ-FAIXA-IMIDA) ~ TL-2026-4199; TL-2026-4393 (UN-AZOXI-LIBERADA) ~ TL-2026-4157).
- `Apiario_Proximo` nao tem sensor correspondente: e a unica area que so existe no
  cadastro do talhao, e por isso nenhuma familia pode cruzar fronteira nela.
- `altura_voo` e `hora` estao no vocabulario da gramatica e nao vem na leitura: sao
  parametros da missao. Nenhum cenario os afirma como se fossem sensor.
