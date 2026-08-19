# SPC-CML — Compilador Semântico de Prompts

Middleware neuro-simbólico que interpõe uma **DSL formal**, um **Grafo de Conhecimento** e **decodificação restrita por gramática** entre a fala de um profissional e a ordem que um sistema crítico executa.

**Domínio de instanciação:** terapia intensiva — segurança na prescrição e titulação de fármacos em bomba de infusão.

O problema que a arquitetura ataca é específico. Um LLM que traduz *"a pressão tá despencando, sobe a nora e aprofunda o propofol"* em uma ordem de bomba erra de duas maneiras distintas, que exigem remédios distintos:

| Tipo de erro | Exemplo | Mecanismo que o elimina |
|---|---|---|
| **Sintático** | emitir `dose 0.1 gotas/min`, ou prosa livre em vez da linguagem de ordens | Gramática BNF derivada da DSL + decodificação restrita |
| **Semântico** | aumentar Propofol com PAM 52 mmHg — sintaticamente perfeito, clinicamente perigoso | Grafo de Conhecimento avaliado sobre a telemetria, convertido em gramática |

A tese operacional do projeto é que o segundo pode ser reduzido ao primeiro: **se o grafo determina que aumentar Propofol é proibido agora, essa cadeia é removida da gramática e o decodificador não consegue emiti-la.** O erro semântico deixa de ser algo a detectar depois e passa a ser inexprimível.

---

## Índice

1. [Arquitetura](#1-arquitetura)
2. [Os dois esquemas da DSL](#2-os-dois-esquemas-da-dsl)
3. [Como as peças se conectam](#3-como-as-peças-se-conectam)
4. [Mapa de arquivos](#4-mapa-de-arquivos)
5. [Instalação](#5-instalação)
6. [Como rodar](#6-como-rodar)
7. [Como validar](#7-como-validar)
8. [Os dois caminhos de decodificação](#8-os-dois-caminhos-de-decodificação)
9. [Estendendo o modelo](#9-estendendo-o-modelo)
10. [Limitações conhecidas](#10-limitações-conhecidas)
11. [Referências](#11-referências)

---

## 1. Arquitetura

```
                         ┌──────────────────────────────┐
                         │   src/language/dsl.langium   │
                         │      (fonte única da          │
                         │       verdade formal)         │
                         └───────────┬──────────────────┘
                                     │
                  ┌──────────────────┴───────────────────┐
                  │                                      │
        ESQUEMA DE CONTROLE                    ESQUEMA DE DADOS
     (o que é verdade no domínio)          (o que o LLM pode responder)
                  │                                      │
                  v                                      v
        ┌──────────────────┐                  ┌──────────────────────┐
        │  Grafo (Neo4j)   │                  │  BNF gerada  (G)     │
        │  farmacos,       │                  │  advanced_icu.bnf    │
        │  protocolos,     │                  │  18 regras           │
        │  invariantes     │                  └──────────┬───────────┘
        └────────┬─────────┘                             │
                 │                                       │
   Telemetria ──>│  BUSCA NO GRAFO (GraphRAG)            │
   PAM 52        │  avaliação determinística             │
   FC 145        │  "PAM 52 < 60 → Propofol bloqueado"   │
   lactato 4.8   │                                       │
                 ├──────────────┬────────────────────────┤
                 v              v                        v
        ┌────────────────┐  ┌─────────────────────────────────┐
        │ Prompt         │  │  Ĝ  — gramática podada          │
        │ Semântico      │  │  (regra `ordem_<fármaco>`       │
        │ (bloco factual)│  │   por fármaco)                  │
        └───────┬────────┘  └────────────┬────────────────────┘
                │                        │
                └────────┬───────────────┘
                         v
        ┌────────────────────────────────────────┐
        │      GRAMMAR PROMPTING + DECODIFICAÇÃO │
        │      RESTRITA                          │
        │  few-shot (x, G[y], y) + Ĝ             │
        └────────────────┬───────────────────────┘
                         v
        ┌────────────────────────────────────────┐
        │  VERIFICAÇÃO — o plano ∈ L(Ĝ) e ∈ L(DSL)│
        └────────────────┬───────────────────────┘
                         v
                  Ordem executável
```

O fluxo tem uma propriedade que vale destacar: **a etapa que decide o que é seguro não é neural.** O LLM traduz linguagem; quem decide se o Propofol pode subir é uma comparação numérica (`52 < 60`) sobre um grafo escrito por especialistas.

---

## 2. Os dois esquemas da DSL

A DSL (`src/language/dsl.langium`) é particionada segundo a arquitetura CML.

### Esquema de Controle — o conhecimento do domínio

Alimenta o Grafo de Conhecimento. Escrito pelo intensivista e pelo farmacêutico clínico.

```langium
farmaco Propofol {
    classe sedativo
    rxnorm "8782"          atc "N01AX10"
    alto_risco sim

    diluicao "emulsao lipidica 10 mg/mL"
    vias [ ACESSO_CENTRAL, ACESSO_PERIFERICO ]

    dose inicial 0.5 mg/kg/h
    dose maxima 4.0 mg/kg/h
    titulacao 0.5 mg/kg/h a_cada 15 min alvo "RASS -2 a 0"

    bomba {                            // limites DERS da bomba inteligente
        limite_leve   3.0 mg/kg/h      // soft limit: alerta
        limite_rigido 4.0 mg/kg/h      // hard limit: bloqueio
    }

    interacao: Midazolam gravidade moderada ("depressao respiratoria aditiva")
    contraindicado: "hipotensao refrataria com PAM < 60 mmHg"
}

// Invariante com condição ESTRUTURADA — avaliável por máquina, não por LLM
regra_seguranca: bloquear_incremento Propofol se PAM < 60.0 mmHg
                 ("risco de hipotensao severa e colapso hemodinamico")
```

Cobre `farmaco`, `protocolo` (gatilhos, etapas, escalonamentos, desmame), `populacao` (gestante, renal crônico, idoso frágil, obeso grave), `regra_seguranca` e `regra_global`.

### Esquema de Dados — o universo fechado de respostas

Delimita exaustivamente o que o LLM pode emitir. **É esta seção que vira BNF.**

```langium
esquema_dados AssistenteUTI_v2 {
    decisoes [ INICIAR_INFUSAO, AUMENTAR_VAZAO, REDUZIR_VAZAO, MANTER_BLOQUEADO,
               SUSPENDER, SOLICITAR_EXAME, ESCALAR_EQUIPE, BLOQUEAR_ORDEM, ... ]
    vias     [ ACESSO_CENTRAL, ACESSO_PERIFERICO, INTRAOSSEO, SC ]
    alertas  [ INFORMATIVO, ATENCAO, CRITICO, BLOQUEANTE ]

    conduta Manter_Bloqueio {
        decisao MANTER_BLOQUEADO
        requer_dupla_checagem sim
        recurso_fhir "DetectedIssue"
    }
}

// A produção que a decodificação restrita preenche
plano Plano_Choque_01 para Choque_Septico {
    esquema_referencia AssistenteUTI_v2
    paciente 'PT-2026-0031'
    sequencia [ Manter_Bloqueio, Acionar_Equipe ]
    ordem Propofol decisao MANTER_BLOQUEADO dose 0.0 mg/kg/h via ACESSO_CENTRAL
          justificativa 'PAM 52 mmHg abaixo de 60'
    alerta CRITICO 'hipoperfusao grave' regra 'Choque_Septico/escalonar'
    auditoria 'plano derivado sob restricao gramatical'
}
```

Um detalhe de modelagem: as condutas são declaradas **dentro** de um `esquema_dados`, e um `plano` só pode citar condutas do esquema que ele próprio referencia. Isso é imposto por um `ScopeProvider` dedicado (`src/language/dsl-module.ts`), de modo que o universo é fechado também na resolução de nomes, não só na sintaxe.

---

## 3. Como as peças se conectam

### 3.1 DSL → BNF (fonte única de verdade)

Antes, a BNF era mantida à mão em paralelo à DSL. Duas fontes de verdade para a mesma linguagem significam que qualquer evolução do domínio pode dessincronizar o decodificador do modelo clínico — justamente onde a segurança é decidida.

Hoje `src/cli/export-bnf.ts` **deriva** a BNF de duas fontes locais já validadas:

| Fonte | O que fornece |
|---|---|
| `src/language/dsl.langium` | a **estrutura** da saída (regra `PlanCommand` e o que ela alcança) e os vocabulários fechados (`Decision`, `Route`, `AlertLevel`, `Unit`) |
| `src/examples/uti.dsl` | as **instâncias** permitidas (nomes de fármacos, condutas, protocolos) e a restrição declarada no `esquema_dados` |

Resultado (`src/python_engine/grammar/advanced_icu.bnf`, gerado):

```bnf
plano ::= "plano" identificador "para" protocolo "{" "esquema_referencia" esquema
          "paciente" texto "sequencia" "[" conduta plano_g1* "]"
          plano_g2* plano_g3* "auditoria" texto "}"
ordem ::= "ordem" farmaco "decisao" decisao "dose" quantidade "via" via "justificativa" texto
farmaco ::= "Noradrenalina" | "Adrenalina" | "Vasopressina" | "Dobutamina" | "Propofol"
          | "Midazolam" | "Fentanil" | "Cisatracurio" | "Vancomicina"
          | "Piperacilina_Tazobactam" | "Heparina" | "Insulina_Regular"
unidade ::= "mcg/kg/min" | "U/min" | "mg/kg/h" | "mcg/kg/h" | "mg/kg" | "mg" | "UI/kg" | "UI/h"
```

Os 12 fármacos vieram do `uti.dsl`. Citar `Dopamina` deixa de ser um erro semântico a detectar depois: não existe na gramática.

**Dois estreitamentos deliberados** — a gramática de saída é mais restrita que a DSL de autoria:

- `justificativa` e `regra` passam de opcionais a **obrigatórias**: toda ordem gerada automaticamente carrega rastreabilidade;
- `texto` aceita apenas aspas simples (o leitor BNF do motor Python trata `|` como separador de alternativas).

Todo plano gerado é um programa válido da DSL; a recíproca não vale.

### 3.2 Telemetria → subgrafo → Ĝ

`src/knowledge/graphrag.ts` avalia a telemetria contra o modelo e produz uma **política por fármaco**:

```
PAM=52  FC=145  lactato=4.8  RASS=2  TFG=28  plaquetas=45  glicemia=210
        │
        v
Protocolos ativados:  Choque_Septico (lactato 4.8 > 2), Sedacao_Analgesia_VM (RASS 2 > 0),
                      Controle_Glicemico_UTI (glicemia 210 > 180)
Bloqueios:            Propofol (PAM 52 < 60), Noradrenalina (FC 145 > 130),
                      Cisatracurio (RASS 2 > -4), Heparina (plaquetas 45 < 50)
Vetos:                Dobutamina (protocolo), Midazolam (protocolo)
Ajustes:              Vancomicina ×0.5, Fentanil ×0.75, Midazolam ×0.5 (TFG 28)
Escalonamentos:       TIME_RESPOSTA_RAPIDA, INTENSIVISTA
```

`src/grammar/constrain.ts` converte essa política em gramática, emitindo **uma produção por fármaco**:

```bnf
ordem ::= ordem_noradrenalina | ordem_propofol | ordem_vasopressina | ...

ordem_propofol   ::= "ordem" "Propofol" "decisao" decisao_propofol
                     "dose" quantidade_propofol "via" via_propofol "justificativa" texto
decisao_propofol ::= "REDUZIR_VAZAO" | "MANTER_VAZAO" | "MANTER_BLOQUEADO"
                   | "SUSPENDER" | "SUBSTITUIR" | "SOLICITAR_EXAME"
                   | "ESCALAR_EQUIPE" | "BLOQUEAR_ORDEM"
unidade_propofol ::= "mg/kg/h"
via_propofol     ::= "ACESSO_CENTRAL" | "ACESSO_PERIFERICO"
```

`AUMENTAR_VAZAO` desapareceu de `decisao_propofol`. Note também que `unidade_propofol` admite só `mg/kg/h` — trocar a unidade de um vasopressor pela de um sedativo, erro clássico de medicação, também se torna inexprimível.

Esta é a diferença material em relação a uma poda global de vocabulário: com uma lista única de decisões, `Propofol + AUMENTAR_VAZAO` continuaria gramatical porque *algum* fármaco admite aumentar.

### 3.3 Verificação e reparo

`src/grammar/earley.ts` implementa um reconhecedor de Earley **sem scanner** (sobre caracteres, não tokens) que fornece as três quantidades do Algoritmo 1 de Wang et al.:

- `y ∈ L(Ĝ)`?
- o **maior prefixo válido** `y_prefix`;
- **Σ[y_prefix]**, o conjunto de terminais que podem continuar o prefixo.

Diante da saída ingênua do LLM:

```
ordem Noradrenalina decisao AUMENTAR_VAZAO dose 0.1 mcg/kg/min ...
                            ^
              rejeitado exatamente aqui (offset 173 de 512)

Σ[y_prefix] = "REDUZIR_VAZAO" | "MANTER_VAZAO" | "MANTER_BLOQUEADO" | "SUSPENDER"
            | "SUBSTITUIR" | "SOLICITAR_EXAME" | "ESCALAR_EQUIPE" | "BLOQUEAR_ORDEM"
```

O **reparo determinístico** completa o programa escolhendo, a cada passo, o terminal que minimiza o número de terminais ainda necessários para fechar a derivação inteira — incluindo o fechamento de toda a pilha de produções pendentes. Sem isso, um critério guloso local nunca fecha uma lista: diante de `sequencia [ Manter_Bloqueio`, o símbolo `,` pertence a uma produção curta e parece mais barato que `]`, e o reparo repete conduta indefinidamente.

Por construção o reparo termina e o resultado é aceito por Ĝ. É a rede de segurança que sustenta a garantia mesmo quando o LLM nunca converge.

---

## 4. Mapa de arquivos

```
dsl-project/
├── src/
│   ├── language/
│   │   ├── dsl.langium              ← A DSL. Fonte única da verdade formal.
│   │   └── dsl-module.ts            ← Serviços Langium + ScopeProvider do Esquema de Dados
│   ├── generated/                   ← Gerado por `langium generate` (não editar)
│   │
│   ├── examples/
│   │   ├── uti.dsl                  ← Modelo clínico institucional (33 elementos)
│   │   ├── cenarios.jsonl           ← Cenários de leito com telemetria
│   │   └── prompt.txt               ← Falas soltas (formato legado)
│   │
│   ├── grammar/                     ── CAMADA GRAMATICAL ──
│   │   ├── extract-bnf.ts           ← Langium AST + modelo → BNF (G)
│   │   ├── vocabularies.ts          ← Extrai instâncias permitidas do modelo
│   │   ├── constrain.ts             ← G + política do grafo → Ĝ (por fármaco)
│   │   └── earley.ts                ← Reconhecedor, Σ[y_prefix] e reparo
│   │
│   ├── knowledge/
│   │   └── graphrag.ts              ← Telemetria → subgrafo de restrições
│   │
│   ├── database/
│   │   └── neo4j.ts                 ← Mapeador AST → Grafo de Conhecimento
│   │
│   ├── cli/
│   │   ├── validate.ts              ← Portão de qualidade da DSL
│   │   ├── export-bnf.ts            ← Gera advanced_icu.bnf
│   │   └── pipeline.ts              ← Demonstração ponta a ponta (Fig. 5.1)
│   │
│   ├── inference/
│   │   ├── llm-client.ts            ← Prompt Semântico + chamada ao motor
│   │   └── batch-client.ts          ← Bateria de cenários
│   │
│   ├── python_engine/               ── MOTOR DE DECODIFICAÇÃO (modelo local) ──
│   │   ├── bnf.py                   ← BNF → Lark / GBNF; G[y] especializada
│   │   ├── grammar_from_kg.py       ← Poda de G pelo subgrafo → Ĝ
│   │   ├── prompt_builder.py        ← Prompt few-shot (x, G[y], y)
│   │   ├── main.py                  ← API FastAPI
│   │   ├── test_grammar.py          ← Validação do motor
│   │   ├── grammar/advanced_icu.bnf ← GERADO — não editar à mão
│   │   └── data/exemplos_icu.jsonl  ← Exemplares few-shot
│   │
│   └── test/
│       ├── test.ts                  ← Inspeção do modelo carregado
│       └── earley.test.ts           ← Detecção + reparo
└── package.json
```

---

## 5. Instalação

**Pré-requisitos:** Node.js 18+, Python 3.10+. Neo4j e GPU são opcionais.

```bash
cd dsl-project
npm install
npm run langium:generate        # gera parser e AST a partir da DSL

# Motor de gramática em Python (leve — sem LLM)
python -m pip install lark fastapi pydantic uvicorn
```

Para o caminho de **modelo local com mascaramento de logits** (opcional, pesado):

```bash
python -m pip install -r src/requirements.txt   # outlines, transformers, torch
```

Para persistir o grafo (opcional):

```bash
docker run -d --name neo4j -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/'#UFG2026' neo4j:5
```

---

## 6. Como rodar

### 6.1 Demonstração completa — comece por aqui

```bash
npm run pipeline
```

Executa a Figura 5.1 inteira, **offline**, sem Neo4j nem GPU, e imprime as seis etapas: DSL carregada → telemetria → restrições recuperadas → G e Ĝ → verificação e reparo → garantias finais.

Saída final esperada:

```
Aceito por Ĝ (restrições do grafo): sim
Aceito pela DSL Langium (round-trip): sim

RESULTADO: erro sintático 0 — o plano final é válido em Ĝ e na DSL, e nenhuma
ordem viola as invariantes recuperadas do grafo.
```

### 6.2 Regenerar a BNF depois de editar a DSL

```bash
npm run validate                 # 1. o modelo está íntegro?
npm run bnf:export               # 2. regenera advanced_icu.bnf
```

**Sempre nessa ordem.** O `export-bnf` recusa gerar a partir de um modelo com erro de sintaxe — sem isso, um modelo quebrado silenciosamente produziria uma gramática incompleta.

### 6.3 Recuperação no grafo e Prompt Semântico

```bash
npm run infer                    # um cenário, com o Prompt Semântico completo
npm run batch                    # três cenários contrastantes
```

O `batch` é o mais instrutivo: a mesma frase *"aumenta a sedação"* produz gramáticas diferentes conforme a PAM. Com PAM 78 o Propofol é liberado; com PAM 52 é bloqueado. O sistema não bloqueia por precaução — bloqueia quando a invariante incide.

### 6.4 Persistir o grafo no Neo4j

```bash
npm run graph:sync               # idempotente (MERGE em tudo)
```

Consultas úteis no Neo4j Browser:

```cypher
// Invariantes que bloqueiam incremento
MATCH (r:RegraSeguranca)-[:BLOQUEIA_INCREMENTO]->(f:Farmaco)
RETURN f.nome, r.parametro, r.operador, r.limiar, r.razao;

// Interações de alta gravidade
MATCH (a:Farmaco)-[i:INTERAGE_COM]->(b:Farmaco)
WHERE i.gravidade IN ['alta','contraindicada']
RETURN a.nome, b.nome, i.mecanismo, i.conduta;

// Pares LASA
MATCH (a:Farmaco)-[l:LASA]->(b:Farmaco) RETURN a.nome, b.nome, l.mitigacao;
```

### 6.5 Motor de decodificação restrita (modelo local)

```bash
cd src/python_engine
uvicorn main:app --port 8000
```

| Endpoint | Função | Precisa de GPU? |
|---|---|---|
| `GET /health` | estado do motor | não |
| `GET /grammar` | G nos formatos Lark e GBNF | não |
| `POST /verify` | um plano ∈ L(G) ou L(Ĝ)? | não |
| `POST /generate-constrained` | geração sob mascaramento de logits | sim |

O LLM é carregado preguiçosamente: `/health`, `/grammar` e `/verify` funcionam sem GPU.

**Aceleração por GPU (opcional, recomendado com VRAM dedicada):** a wheel padrão de
`llama-cpp-python` no `requirements.txt` é CPU-only. Para descarregar as camadas do
modelo na placa de vídeo (`SPC_CML_N_GPU_LAYERS`, ver `main.py`), rode o motor fora do
Docker, num venv nativo, e instale a wheel pré-compilada com CUDA:

```powershell
# 1. Confira a versao do driver/CUDA
nvidia-smi

# 2. Ambiente virtual nativo (fora do container)
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r src\requirements.txt

# 3. Substitui a wheel CPU-only por uma com CUDA (troque cu124 pela sua versao:
#    cu121/cu122/cu124/cu125 — CUDA 12.1 a 12.5 cobre a maioria dos drivers recentes)
pip install llama-cpp-python --prefer-binary --force-reinstall --no-deps `
    --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu124

# 4. Suba so o Neo4j via Docker; o motor Python roda direto no Windows
docker compose up -d neo4j

# 5. Rode o motor nativamente (NEO4J_URI ja cai em bolt://localhost:7687 por padrao)
cd src\python_engine
uvicorn main:app --host 0.0.0.0 --port 8000
```

Confira em `GET /health` se `modelo_carregado` fica `true` após a primeira chamada a
`/generate-constrained` (o GGUF baixa do Hugging Face na primeira vez). Se o
`llama_cpp` não foi compilado com CUDA, `n_gpu_layers` é ignorado silenciosamente — o
motor continua funcionando, só que em CPU.

```bash
curl -X POST http://127.0.0.1:8000/verify -H 'Content-Type: application/json' -d '{
  "plano": "plano P para Choque_Septico { esquema_referencia AssistenteUTI_v2 paciente '\''PT-1'\'' sequencia [ Manter_Bloqueio ] ordem Propofol decisao AUMENTAR_VAZAO dose 1.0 mg/kg/h via ACESSO_CENTRAL justificativa '\''x'\'' alerta CRITICO '\''y'\'' regra '\''z'\'' auditoria '\''a'\'' }",
  "subgrafo_regras": {"acoes_permitidas":["MANTER_BLOQUEADO"],"farmacos_liberados":["Propofol"],"vias_disponiveis":["ACESSO_CENTRAL"]}
}'
# → {"valido": false, ...}
```

### 6.6 Entrada interativa

```bash
npm run start
```

Pergunta o domínio (agrícola ou clínico) e depois a fonte: rodar a bateria de
cenários prontos do arquivo (mesmo comportamento de `npm run batch` /
`npm run batch:agro`) ou digitar um comando novo no terminal.

Um comando digitado passa primeiro por `POST /validar-comando`: o próprio LLM
local julga — sob a mesma decodificação restrita do resto da arquitetura, nunca
texto livre — se o comando está contraditório, ambíguo ou incompleto demais. Se
estiver, pede para digitar de novo; se estiver claro, o comando segue o fluxo
normal (recuperação no grafo → Prompt Semântico → geração sob mascaramento de
logits), igual a um cenário do arquivo.

---

## 7. Como validar

```bash
npm test
```

Encadeia cinco verificações. Cada uma isola uma garantia distinta:

### 7.1 `npm run typecheck` — integridade estática

Compilação TypeScript sem erros. Como a AST é gerada pelo Langium a partir da DSL, uma mudança na gramática que quebre um consumidor aparece aqui, não em produção.

### 7.2 `npm run validate` — o modelo clínico é íntegro

```
Sintaxe: OK — 0 erros lexicos, sintaticos e de referencia.
Elementos no modelo: 33
```

Cobre léxico, sintaxe **e resolução de referências cruzadas** — é o que impede um `recomenda Dopamina` apontando para fármaco inexistente.

### 7.3 `npm run bnf:export` — a gramática deriva da DSL

```
18 regras | 12 farmacos | 8 condutas
```

Confirme que os números batem com o `uti.dsl`. Se você adicionar um fármaco e este contador não mudar, a derivação não está acontecendo.

### 7.4 `npm run test:earley` — erro sintático 0 (caminho de API)

Sete modos de falha reais de LLM, todos detectados e reparados:

```
farmaco inexistente | decisao inventada | unidade invalida | via nao permitida
texto em prosa livre | JSON em vez da DSL | truncado no meio
```

Mais a propriedade de fechamento: **24 prefixos** do plano válido, testados em passos de 17 caracteres, todos convergem para um programa aceito.

### 7.5 `npm run test:grammar` — o motor de gramática (Python)

```
[3] Plano valido ACEITO por G
[4] G[y] derivada: 22 alternativas de 61 em G (64% do espaco de geracao eliminado)
[5] 7 classes de alucinação bloqueadas
[6] G_hat podada: aceita o seguro, recusa a decisão vetada e o fármaco fora da poda
```

O passo **[6] reconstrói o parser a partir de Ĝ** e exige aceite/recusa reais. Isso não é zelo excessivo: numa versão anterior o teste apenas verificava se o termo sumia do texto da gramática, e passava mesmo com a poda quebrada — porque a gramática inteira havia sido destruída, e o termo sumira junto.

### 7.6 Validação manual do fechamento semântico

```bash
npm run pipeline
```

As duas linhas que importam:

```
Aceito por Ĝ (restrições do grafo): sim
Aceito pela DSL Langium (round-trip): sim
```

A segunda é o **round-trip**: o plano gerado sob a gramática derivada é reparseado pela DSL Langium original. É a checagem de que a BNF gerada não divergiu da linguagem de onde saiu.

---

## 8. Os dois caminhos de decodificação

A arquitetura é agnóstica de provedor, e isso obriga a dois mecanismos, porque a garantia sintática se obtém de maneiras diferentes:

| | **Modelo local** | **API (Claude, GPT, Gemini)** |
|---|---|---|
| Mecanismo | mascaramento de logits (Outlines) | gerar → verificar → reparar |
| Base | `python_engine/` | `src/grammar/earley.ts` |
| Garantia | token inválido nunca é emitido | saída inválida nunca escapa |
| Custo | GPU | chamadas extras de API |
| Referência | Wang et al., §3.2 | Wang et al., Algoritmo 1 |

Nenhum provedor de API expõe a máscara de logits, e a arquitetura é explícita em não depender de um fornecedor. Por isso o caminho de verificação existe: ele obtém a mesma garantia observável (nenhuma saída inválida sai do sistema) por um mecanismo diferente.

Sobre o **grammar prompting** propriamente dito (Wang et al., 2023): cada exemplar few-shot é a tripla `(x, G[y], y)` — a fala, a gramática especializada mínima que gera aquela saída, e a saída. `G[y]` é derivada automaticamente parseando `y` e coletando as produções usadas — nunca escrita à mão. Para o plano de referência, `G[y]` reduz `farmaco` de 12 alternativas para 2 e `decisao` de 11 para 2, eliminando 64% do espaço de geração.

---

## 9. Estendendo o modelo

### Adicionar um fármaco

Edite `src/examples/uti.dsl` e rode:

```bash
npm run validate && npm run bnf:export
```

O fármaco aparece automaticamente na BNF, no grafo e nas políticas por fármaco. Nada mais precisa ser tocado.

### Adicionar uma invariante de segurança

```langium
regra_seguranca: bloquear_incremento Fentanil se FR < 10.0 irpm
                 ("risco de depressao respiratoria")
```

A condição precisa ser **estruturada** (`parâmetro operador valor unidade`), não texto livre. Em prosa, só uma inferência neural poderia avaliá-la — exatamente onde a arquitetura não deve depender do LLM.

### Alterar a linguagem de saída

Edite a regra `PlanCommand` em `dsl.langium` e rode `npm run build && npm run bnf:export`. A BNF, o reconhecedor Earley e o mascaramento de logits acompanham. Se você mudar nomes de regras, confira os mapas de alias no topo de `src/grammar/extract-bnf.ts`.

---

## 10. Limitações conhecidas

Registradas por honestidade metodológica — várias são trabalho futuro legítimo.

1. **A poda enviada ao motor Python é mais fraca que a do TypeScript.** O payload `subgrafo_regras` carrega listas planas (`acoes_permitidas`, `farmacos_liberados`, `vias_disponiveis`), que são a *união* sobre todos os fármacos. Como algum fármaco admite `AUMENTAR_VAZAO`, a decisão sobrevive globalmente, e a proibição `Propofol + AUMENTAR_VAZAO` não é capturada nesse caminho. A poda estrita por fármaco existe apenas em `src/grammar/constrain.ts` (caminho TypeScript). Unificar os dois exige estender o contrato para políticas por fármaco.

2. **Sem embeddings nem busca vetorial.** A recuperação é por avaliação determinística de regras sobre a telemetria, não por similaridade semântica. Isso é uma escolha — é o que torna a decisão auditável — mas significa que a desambiguação léxica prevista na arquitetura (mapear *"nora"* → `Noradrenalina`) ainda não está implementada. Hoje a fala do profissional entra no Prompt Semântico como texto e a associação fica a cargo do LLM.

3. **O reparo determinístico produz planos degenerados.** É uma rede de segurança, não o caminho principal: fecha com `dose 0.0` e justificativas genéricas. O caminho correto é devolver Σ[y_prefix] ao LLM para que escolha uma continuação clinicamente sensata (Algoritmo 1, linhas 8–10). Esse laço com LLM no circuito não está implementado no lado TypeScript.

4. **`UnorderedGroup` é aproximado** por sequência ordenada na extração da BNF. A DSL atual não usa `&`, então não há impacto — mas a aproximação é conservadora e passaria a rejeitar entradas válidas se passasse a usar.

5. **Contraindicações e critérios hepáticos são texto livre**, portanto não avaliáveis por máquina. Só entram no Prompt Semântico como contexto. Estruturá-los seria a evolução natural do que já foi feito com `regra_seguranca`.

6. **Não verificado em execução:** o sync com Neo4j e a geração com Outlines/GPU estão escritos e tipados, mas foram exercitados apenas por compilação e pelos endpoints sem GPU (`/health`, `/verify`). Todo o restante do pipeline roda e foi verificado offline.

7. **Limites de dose não são checados numericamente.** A gramática garante que a *unidade* é a correta para o fármaco, mas não que `dose 9.9 mcg/kg/min` respeite o `limite_rigido` de 2.0. Um limite numérico não é expressável em gramática livre de contexto; exigiria uma validação pós-parse sobre a AST — que a DSL já tem informação para fazer.

---

## 11. Referências

- **Wang, B.; Wang, Z.; Wang, X.; Cao, Y.; Saurous, R. A.; Kim, Y.** *Grammar Prompting for Domain-Specific Language Generation with Large Language Models.* NeurIPS 2023. — gramática especializada `G[y]` (§3.1) e decodificação restrita baseada em Earley (§3.2, Algoritmo 1).
- **Aycock, J.; Horspool, R. N.** *Practical Earley Parsing.* The Computer Journal, 2002. — correção para regras anuláveis, indispensável porque a conversão EBNF→BNF introduz auxiliares vazios.
- **Clarisó, R.; Cabot, J.** *Model-Driven Prompt Engineering.* MODELS 2023. — fundamento da engenharia de prompts dirigida por modelos.
- **ISMP Brasil** — Medicamentos potencialmente perigosos (*high-alert medications*).
- **Surviving Sepsis Campaign** — bundle de 1 hora, base do protocolo `Choque_Septico`.
- **DERS** (*Dose Error Reduction Software*) — limites soft/hard de bombas de infusão inteligentes.
