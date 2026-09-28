"""
Motor de decodificacao restrita do SPC-CML (FastAPI).

Recebe a fala do profissional e o subgrafo de restricoes recuperado do Neo4j,
monta o prompt de grammar prompting e gera o plano sob mascaramento de logits.

Executar:
    uvicorn main:app --host 127.0.0.1 --port 8000

A gramatica G NAO e mantida aqui: ela e gerada a partir da DSL Langium por
`npx tsx src/cli/export-bnf.ts`. Este servico apenas a consome.
"""
from __future__ import annotations

import os
import sys
import threading
from unittest.mock import MagicMock

# outlines 0.0.46 importa pacotes de dominio irrelevantes para este uso e que
# quebram em ambientes sem eles; o stub evita o custo sem afetar a decodificacao.
for _modulo in ("pyairports", "pyairports.airports", "pycountry"):
    sys.modules.setdefault(_modulo, MagicMock())

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

from fastapi import FastAPI, HTTPException  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from bnf import Rule, load_bnf, parse_bnf, build_parser, to_lark, to_gbnf  # noqa: E402
from grammar_from_kg import (  # noqa: E402
    INICIO_PI,
    INICIO_PLANNER,
    gramatica_do_pi,
    gramatica_do_planner,
    gramatica_do_subgrafo,
)
from prompt_builder import carregar_exemplos, montar_prompt  # noqa: E402

# O dominio e escolhido na subida do servico. A gramatica e os exemplares mudam;
# a maquinaria (poda, mascaramento, verificacao) e a mesma nos tres — e essa
# indiferenca ao dominio e o que sustenta a generalidade da arquitetura.
DOMINIO = os.environ.get("SPC_CML_DOMINIO", "medico")
_GRAMATICA_PADRAO = {
    "medico": "advanced_icu.bnf",
    "agro": "agro_drone.bnf",
    "fut": "futebol.bnf",
}.get(DOMINIO, "advanced_icu.bnf")
_EXEMPLOS_PADRAO = {
    "medico": "exemplos_icu.jsonl",
    "agro": "exemplos_agro.jsonl",
    "fut": "exemplos_fut.jsonl",
}.get(DOMINIO, "exemplos_icu.jsonl")

GRAMMAR_PATH = os.environ.get(
    "SPC_CML_GRAMMAR", os.path.join(BASE_DIR, "grammar", _GRAMATICA_PADRAO)
)
EXAMPLES_PATH = os.environ.get(
    "SPC_CML_EXAMPLES", os.path.join(BASE_DIR, "data", _EXEMPLOS_PADRAO)
)

# A regra inicial da BNF: `plano` na DSL clinica, `missao` na agricola,
# `arbitragem` na de futebol.
_INICIO_PADRAO = {"agro": "missao", "fut": "arbitragem"}.get(DOMINIO, "plano")
INICIO = os.environ.get("SPC_CML_INICIO", _INICIO_PADRAO)
MODEL_ID = os.environ.get("SPC_CML_MODEL", "Qwen/Qwen2.5-7B-Instruct")

# Backend de decodificacao restrita. Os dois mascaram logits sobre a MESMA
# gramatica podada — muda so o mecanismo, nao a garantia:
#   llamacpp  GBNF compilada uma vez, mascaramento em C++ (padrao)
#   outlines  CFG incremental em Python; reconstroi um FSM sobre todo o
#             vocabulario a cada terminal da saida, o que nesta gramatica nao
#             termina em tempo util. Mantido para a comparacao de desempenho.
BACKEND = os.environ.get("SPC_CML_BACKEND", "llamacpp")
# Q4_K_M do 7B fica em ~4.7 GB de pesos; com n_ctx=8192 o KV cache soma mais
# algumas centenas de MB, cabendo confortavelmente nos 6 GB de VRAM de uma RTX
# de notebook. Trocar para o 0.5B antigo (Qwen2.5-0.5B-Instruct-GGUF /
# qwen2.5-0.5b-instruct-q8_0.gguf) continua funcionando em qualquer maquina,
# inclusive sem GPU.
# O repo oficial da Qwen publica o Q4_K_M do 7B em duas partes
# (-00001-of-00002.gguf); o do bartowski e o mesmo quant num arquivo unico, o
# que hf_hub_download baixa direto sem precisar montar os shards.
GGUF_REPO = os.environ.get("SPC_CML_GGUF_REPO", "bartowski/Qwen2.5-7B-Instruct-GGUF")
GGUF_FILE = os.environ.get("SPC_CML_GGUF_FILE", "Qwen2.5-7B-Instruct-Q4_K_M.gguf")
# -1 = offload todas as camadas para a GPU. Sem build CUDA do llama-cpp-python
# (rodando so em CPU) o parametro e ignorado silenciosamente — nao quebra nada,
# so nao acelera. Ver README para a instalacao da wheel com suporte a CUDA.
N_GPU_LAYERS = int(os.environ.get("SPC_CML_N_GPU_LAYERS", "-1"))
# Modelo de embedding para a recuperacao por similaridade no Neo4j (indice
# vetorial). Multilingue, roda em CPU de proposito: a VRAM fica inteira para o
# modelo de geracao, e um encoder de ~570M e barato o bastante em CPU para os
# poucos nos (farmacos/protocolos ou produtos/culturas) embutidos por sincronizacao.
EMBED_GGUF_REPO = os.environ.get("SPC_CML_EMBED_GGUF_REPO", "ggml-org/bge-m3-Q8_0-GGUF")
EMBED_GGUF_FILE = os.environ.get("SPC_CML_EMBED_GGUF_FILE", "bge-m3-q8_0.gguf")
EMBED_N_CTX = int(os.environ.get("SPC_CML_EMBED_N_CTX", "2048"))
# O Prompt Semantico completo (protocolos, bloqueios, vetos, ajustes, interacoes,
# invariantes) mais os 3 exemplares com suas G[y] dao ~3800 tokens; com 1024 de
# saida, 4096 estourava e o llama.cpp aborta o PROCESSO (GGML_ASSERT em decode),
# derrubando os cenarios seguintes junto. Qwen2.5 suporta ate 32k — esse teto e
# sobre o orcamento de prompt+saida, nao sobre o tamanho do modelo, entao vale
# tanto para o 0.5B quanto para o 7B.
N_CTX = int(os.environ.get("SPC_CML_N_CTX", "8192"))
# Os exemplares few-shot tem ~800 caracteres; 512 tokens truncava o plano no meio.
MAX_TOKENS = int(os.environ.get("SPC_CML_MAX_TOKENS", "1024"))
# Teto de itens por lista (condutas, ordens, alertas). Um plano de UTI real tem
# poucas ordens; sem teto o modelo pequeno repete a mesma ordem ate estourar os
# tokens. Ver _quantificador em bnf.py.
MAX_ITENS = int(os.environ.get("SPC_CML_MAX_ITENS", "4"))
# A mascara garante que so saem itens admissiveis, mas nao impede repeti-los; a
# penalidade desencoraja a ordem identica oito vezes seguidas.
REPEAT_PENALTY = float(os.environ.get("SPC_CML_REPEAT_PENALTY", "1.15"))
TEMPERATURA = float(os.environ.get("SPC_CML_TEMPERATURA", "0.3"))
# Teto de caracteres dos campos de texto livre na gramatica do PI Agent. O `texto`
# da DSL vira `[^']{0,N}` na GBNF (ver `_regex_to_gbnf`), e o padrao de 160 cortava
# a justificativa do PI Agent no meio da palavra — observado no Qwen 7B real, em
# todos os PIs. So /generate-pi usa este teto; as demais rotas seguem com o padrao.
MAX_CHARS_PI = int(os.environ.get("SPC_CML_MAX_CHARS_PI", "400"))

app = FastAPI(title="SPC-CML — decodificacao restrita", version="2.0")

# 1. Gramatica completa G, derivada da DSL local.
RULES = load_bnf(GRAMMAR_PATH)
PARSER = build_parser(RULES, start=INICIO)

# 2. Exemplares few-shot com G[y] derivado automaticamente de cada saida.
EXEMPLOS = carregar_exemplos(EXAMPLES_PATH, RULES, PARSER)

# 3. O LLM local e caro de carregar: so materializa no primeiro uso, para que
#    /health, /grammar e /verify funcionem sem GPU.
_MODEL = None   # backend outlines (transformers)
_LLAMA = None   # backend llama.cpp (GGUF)
_EMBED = None   # modelo de embedding (CPU)

# FastAPI roda endpoints sync (def, nao async def) numa threadpool — duas
# requisicoes concorrentes (ex.: /embed e /generate-constrained ao mesmo tempo)
# chamam llama.cpp de threads diferentes. O binding nao e thread-safe para uso
# concorrente sobre o mesmo dispositivo CUDA: os dois modelos (LLM + embedder)
# compartilham o alocador de pool de memoria da GPU, e uma chamada a
# llama_decode() enquanto outra ainda esta em andamento corrompe a contabilidade
# do pool — e exatamente o `GGML_ASSERT(ptr == pool_addr + pool_used)` que
# derrubava o processo inteiro. O lock serializa toda chamada real ao llama.cpp
# (geracao, validacao, embedding); o resto do pipeline (grafo, poda, parsing)
# continua concorrente normalmente.
# RLock, nao Lock: get_embedder() carrega o LLM principal primeiro (ver
# comentario em get_embedder) e ambos tomam o lock — a mesma thread precisa
# poder re-entrar.
_LLAMA_LOCK = threading.RLock()


def get_model():
    global _MODEL
    if _MODEL is None:
        import outlines

        _MODEL = outlines.models.transformers(MODEL_ID)
    return _MODEL


def get_llama():
    global _LLAMA
    with _LLAMA_LOCK:
        if _LLAMA is None:
            from huggingface_hub import hf_hub_download
            from llama_cpp import Llama

            _LLAMA = Llama(
                model_path=hf_hub_download(GGUF_REPO, GGUF_FILE),
                n_ctx=N_CTX,
                n_gpu_layers=N_GPU_LAYERS,
                verbose=False,
            )
        return _LLAMA


def get_embedder():
    global _EMBED
    with _LLAMA_LOCK:
        if _EMBED is None:
            # O llama.cpp inicializa um contexto CUDA (com overhead de VRAM) mesmo
            # para n_gpu_layers=0 — o backend e compilado com suporte a GPU e sonda o
            # dispositivo ao carregar qualquer modelo, use-o ou nao. Carregar o
            # embedder primeiro reservaria esse overhead antes do modelo principal
            # pedir os ~4.7 GB dos pesos, e o cudaMalloc falha por pouco. Garantir
            # que o modelo principal carrega primeiro elimina a dependencia de
            # ordem: depois dele, o overhead do embedder cabe folgado no restante.
            if BACKEND == "llamacpp":
                get_llama()

            from huggingface_hub import hf_hub_download
            from llama_cpp import Llama

            _EMBED = Llama(
                model_path=hf_hub_download(EMBED_GGUF_REPO, EMBED_GGUF_FILE),
                embedding=True,
                n_ctx=EMBED_N_CTX,
                n_gpu_layers=0,
                verbose=False,
            )
        return _EMBED


def _modelo_carregado() -> bool:
    return (_MODEL if BACKEND == "outlines" else _LLAMA) is not None


def _gerar(prompt: str, regras_hat: dict, inicio: str | None = None, max_chars: int | None = None) -> str:
    """
    Geracao sob mascaramento de logits pela gramatica ja podada.

    `inicio` permite mascarar por um NAO-TERMINAL QUALQUER, e nao apenas pelo
    simbolo do artefato inteiro. E o que sustenta a decodificacao incremental:
    gerar uma `ordem` de cada vez, ou uma `conduta` de cada vez, com o texto ja
    aceito servindo de prefixo — cada fragmento nasce sob a gramatica que as
    validacoes anteriores deixaram de pe.

    `max_chars` muda o teto dos campos de texto livre na GBNF; ausente, vale o
    padrao de `to_gbnf` (o de sempre).
    """
    alvo = inicio or INICIO
    if BACKEND == "outlines":
        import outlines

        return outlines.generate.cfg(get_model(), to_lark(regras_hat, start=alvo))(prompt)

    from llama_cpp import LlamaGrammar

    # Guarda antes de decodificar: estourar n_ctx nao levanta excecao no llama.cpp,
    # aborta o processo — e um cenario grande demais derrubaria todo o lote.
    llm = get_llama()
    n_prompt = len(llm.tokenize(prompt.encode("utf-8")))
    if n_prompt + MAX_TOKENS > N_CTX:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Prompt de {n_prompt} tokens mais {MAX_TOKENS} de saida excede "
                f"n_ctx={N_CTX}. Aumente SPC_CML_N_CTX ou reduza SPC_CML_MAX_TOKENS."
            ),
        )

    teto = {} if max_chars is None else {"max_chars": max_chars}
    with _LLAMA_LOCK:
        saida = llm(
            prompt,
            grammar=LlamaGrammar.from_string(
                to_gbnf(regras_hat, start=alvo, max_itens=MAX_ITENS, **teto), verbose=False
            ),
            max_tokens=MAX_TOKENS,
            temperature=TEMPERATURA,
            repeat_penalty=REPEAT_PENALTY,
        )
    return saida["choices"][0]["text"].strip()


# Gramatica GBNF fixa (nao deriva da DSL) so para o formato da resposta desta
# checagem: forca exatamente duas linhas, "VALIDO"/"INVALIDO" seguido do motivo.
# O ponto e nao confiar em texto livre nem aqui — a mesma garantia estrutural do
# resto da arquitetura, so que sobre um julgamento em vez de um plano.
VALIDACAO_GBNF = r"""
root ::= status "\nmotivo: " motivo
status ::= "VALIDO" | "INVALIDO"
motivo ::= [^\n]+
"""
VALIDACAO_MAX_TOKENS = int(os.environ.get("SPC_CML_VALIDACAO_MAX_TOKENS", "200"))

VALIDACAO_INSTRUCAO = """Voce e um verificador de comandos para um sistema de decisao restrita.
Sua unica tarefa e julgar se o comando abaixo tem informacao suficiente e
coerente para ser processado, ou se esta contraditorio, ambiguo ou incompleto
demais.

Considere contraditorio quando o comando pede duas coisas que se cancelam.
Considere ambiguo quando falta o alvo ou a acao principal fica indefinida.
Considere incompleto quando falta uma informacao essencial para agir (o que,
onde, ou em qual produto/farmaco).

comando: {comando}

Responda exatamente neste formato, sem mais nada:
VALIDO
motivo: <por que esta claro e completo>

ou

INVALIDO
motivo: <o que esta contraditorio, ambiguo ou incompleto>

resposta:
"""


def _validar_comando(comando: str) -> tuple[bool, str]:
    """
    Julgamento sob a mesma decodificacao restrita do resto do motor — o modelo
    nao escreve texto livre nem aqui, so preenche VALIDO/INVALIDO + motivo.
    Usa sempre o llama.cpp, independente de SPC_CML_BACKEND: e uma gramatica
    pequena e fixa, nao a CFG da DSL onde o backend outlines nao termina a tempo.
    """
    from llama_cpp import LlamaGrammar

    llm = get_llama()
    prompt = VALIDACAO_INSTRUCAO.format(comando=comando)
    with _LLAMA_LOCK:
        saida = llm(
            prompt,
            grammar=LlamaGrammar.from_string(VALIDACAO_GBNF, verbose=False),
            max_tokens=VALIDACAO_MAX_TOKENS,
            temperature=0.1,
        )
    texto = saida["choices"][0]["text"].strip()
    linhas = texto.splitlines()
    status = linhas[0].strip() if linhas else "INVALIDO"
    motivo = linhas[1][len("motivo: "):].strip() if len(linhas) > 1 else "sem motivo reportado pelo modelo"
    return status == "VALIDO", motivo


# Gramatica GBNF fixa para o julgamento do PLANO ja gerado (avaliacao em lote, ver
# POST /api/avaliar no web-chat) — mesma logica de VALIDACAO_GBNF: forcar duas linhas
# em vez de deixar a LLM justificar em texto solto e sem estrutura. A violacao de
# seguranca (ordem de incremento num farmaco/produto bloqueado ou vetado) NAO entra
# aqui: e checada deterministicamente no lado TypeScript a partir do mesmo subgrafo
# recuperado (ver src/inference/avaliar-grafo.ts) — este julgamento cobre so a
# correcao semantica mais ampla (o plano atende a intencao e as recomendacoes do
# grafo?), que e mais dificil de reduzir a uma comparacao numerica.
JULGAMENTO_PLANO_GBNF = r"""
root ::= veredito "\nmotivo: " motivo
veredito ::= "CORRETO" | "INCORRETO"
motivo ::= [^\n]+
"""
JULGAMENTO_PLANO_MAX_TOKENS = int(os.environ.get("SPC_CML_JULGAMENTO_MAX_TOKENS", "200"))

JULGAMENTO_PLANO_INSTRUCAO = """Voce e um auditor que confere se um plano gerado por outro \
sistema respeita as regras recuperadas do grafo de conhecimento e atende ao pedido do \
profissional/operador.

Considere INCORRETO quando o plano contraria um protocolo ativado, ignora um ajuste de \
dose exigido, ignora uma recomendacao do protocolo sem justificativa, ou simplesmente nao \
atende ao que foi pedido. Considere CORRETO quando o plano e coerente com as regras \
abaixo e responde ao pedido, mesmo que nao siga exatamente as mesmas palavras.

Nao julgue violacoes de seguranca (farmaco/produto bloqueado ou vetado) — isso ja e \
conferido separadamente.

[REGRAS RECUPERADAS DO GRAFO]
{contexto_neo4j}

[PEDIDO ORIGINAL]
{intencao}

[PLANO GERADO]
{plano}

Responda exatamente neste formato, sem mais nada:
CORRETO
motivo: <por que o plano atende as regras e ao pedido>

ou

INCORRETO
motivo: <o que no plano contraria as regras ou deixa de atender ao pedido>

resposta:
"""


def _validar_plano(plano: str, contexto_neo4j: str, intencao: str) -> tuple[bool, str]:
    """Julgamento (sob a mesma decodificacao restrita) de um plano JA GERADO contra o
    subgrafo recuperado do Neo4j para o cenario dele — usado pela avaliacao em lote,
    nao pelo fluxo de geracao. Ver comentario de JULGAMENTO_PLANO_GBNF."""
    from llama_cpp import LlamaGrammar

    llm = get_llama()
    prompt = JULGAMENTO_PLANO_INSTRUCAO.format(contexto_neo4j=contexto_neo4j, intencao=intencao, plano=plano)
    with _LLAMA_LOCK:
        saida = llm(
            prompt,
            grammar=LlamaGrammar.from_string(JULGAMENTO_PLANO_GBNF, verbose=False),
            max_tokens=JULGAMENTO_PLANO_MAX_TOKENS,
            temperature=0.1,
        )
    texto = saida["choices"][0]["text"].strip()
    linhas = texto.splitlines()
    veredito = linhas[0].strip() if linhas else "INCORRETO"
    motivo = linhas[1][len("motivo: "):].strip() if len(linhas) > 1 else "sem motivo reportado pelo modelo"
    return veredito == "CORRETO", motivo


class ValidarRequest(BaseModel):
    comando_humano: str = Field(..., description="Texto digitado pelo usuario, a validar antes de entrar no fluxo")


class ValidarPlanoRequest(BaseModel):
    plano: str = Field(..., description="Texto do plano/missao/arbitragem gerado, a julgar contra o contexto do grafo")
    contexto_neo4j: str = Field("", description="Prompt Semantico: regras recuperadas do grafo para este cenario")
    intencao: str = Field("", description="Fala original do profissional/operador, para conferir se o plano a atende")


class EmbedRequest(BaseModel):
    texto: str = Field(..., description="Texto a converter em vetor para busca por similaridade no Neo4j")


class ICURequest(BaseModel):
    comando_humano: str = Field(..., description="Fala do profissional, em linguagem natural")
    contexto_neo4j: str = Field("", description="Prompt Semantico: regras recuperadas do grafo")
    subgrafo_regras: dict = Field(
        default_factory=dict,
        description=(
            "Poda vinda do GraphRAG. Ex.: {'acoes_permitidas': ['MANTER_BLOQUEADO'], "
            "'farmacos_liberados': ['Propofol'], 'vias_disponiveis': ['ACESSO_CENTRAL']}"
        ),
    )


class VerifyRequest(BaseModel):
    plano: str
    subgrafo_regras: dict = Field(default_factory=dict)


class FragmentoRequest(BaseModel):
    """
    Um passo da decodificacao incremental: gera UM elemento do artefato (uma
    ordem, uma conduta da sequencia, um alerta) sob a gramatica que as
    validacoes anteriores deixaram de pe, tendo o artefato parcial como prefixo.
    """

    simbolo: str = Field(..., description="Nao-terminal do fragmento: ordem | conduta | alerta | identificador | texto")
    prefixo: str = Field("", description="Artefato parcial ja aceito, usado como prefixo da geracao")
    comando_humano: str = Field("", description="Fala do profissional/operador")
    contexto_neo4j: str = Field("", description="Prompt Semantico do cenario")
    subgrafo_regras: dict = Field(default_factory=dict, description="Poda corrente — muda a cada elemento aceito")
    encerramento: str | None = Field(
        None,
        description=(
            "Literal de controle que o modelo pode emitir no lugar do fragmento para "
            "encerrar a lista. Nao pertence a DSL: existe so no passo de decodificacao"
        ),
    )


class PlannerRequest(BaseModel):
    """
    Uma proposta do Planner multiagente: a sequencia de pares (item, conduta).

    O prompt chega pronto do cliente — e uma camada fina sobre o Prompt
    Semantico global, que so o cliente monta. O vocabulario vem da politica
    efetiva; a gramatica e derivada dele AQUI, como G_hat e derivada do
    subgrafo em /generate-constrained. Nada de dominio entra neste servico.
    """

    prompt: str = Field(..., description="Prompt do Planner (instrucao + Prompt Semantico + candidatos)")
    itens: list[str] = Field(..., description="Itens candidatos, da politica efetiva")
    condutas: list[str] = Field(..., description="Condutas que os itens candidatos podem realizar")
    max_pis: int = Field(..., ge=1, description="Maximo de posicoes no plano")
    condutas_por_item: dict[str, list[str]] = Field(
        default_factory=dict,
        description=(
            "Restricao progressiva: itens cujo par ja foi reprovado pela validacao, amarrados "
            "as condutas que realizam. Vazio na primeira tentativa."
        ),
    )


class PIAgentRequest(BaseModel):
    """
    UMA tentativa do PI Agent: a acao e a justificativa de UM PI.

    O prompt chega pronto do cliente (o contexto daquele PI, sem prefixo de
    artefato nem clausula anterior). A gramatica e derivada AQUI do payload do
    PI — a mesma especializacao por item de /generate-constrained, reduzida a
    uma clausula —, com ordem e conduta fixadas como literais.
    """

    prompt: str = Field(..., description="Prompt do PI Agent (contexto do PI + regras de saida + formato)")
    subgrafo_regras: dict = Field(..., description="Payload do PI: UMA politica, restrita as decisoes da conduta")
    ordem: int = Field(..., ge=1, description="Ordem do PI no plano")
    conduta: str = Field(..., description="Conduta que o Planner fixou para o PI")


def _gramatica_efetiva(subgrafo: dict):
    """
    Devolve (regras, bnf_texto) apos a poda pelo subgrafo.

    Quando ha subgrafo, a gramatica usada na decodificacao E a podada: e isso que
    torna uma decisao clinicamente vetada inexprimivel, em vez de apenas improvavel.
    Sem subgrafo, recai sobre G completa.
    """
    if not subgrafo:
        return RULES, None
    texto = gramatica_do_subgrafo(subgrafo, RULES, inicio=INICIO)
    regras = parse_bnf(texto)
    if INICIO not in regras:
        raise HTTPException(
            status_code=422,
            detail="A poda eliminou o simbolo inicial: o contexto nao admite plano algum.",
        )
    return regras, texto


@app.get("/health")
def health():
    return {
        "status": "ok",
        "regras_em_G": len(RULES),
        "exemplares_few_shot": len(EXEMPLOS),
        "dominio": DOMINIO,
        "inicio": INICIO,
        "backend": BACKEND,
        "modelo": MODEL_ID if BACKEND == "outlines" else f"{GGUF_REPO}/{GGUF_FILE}",
        "modelo_carregado": _modelo_carregado(),
        "embedder": f"{EMBED_GGUF_REPO}/{EMBED_GGUF_FILE}",
        "embedder_carregado": _EMBED is not None,
    }


@app.get("/grammar")
def grammar():
    """Expoe G nos formatos consumidos pelos dois caminhos de decodificacao."""
    return {"lark": to_lark(RULES, start=INICIO), "gbnf": to_gbnf(RULES, start=INICIO)}


@app.post("/verify")
def verify(req: VerifyRequest):
    """
    Verificacao pura: um plano pertence a L(G) ou a L(G_hat)?
    Usada pelo cliente TypeScript para conferir saidas de LLMs de API, que nao
    admitem mascaramento de logits.
    """
    regras, _ = _gramatica_efetiva(req.subgrafo_regras)
    parser = build_parser(regras, start=INICIO)
    try:
        parser.parse(req.plano)
        return {"valido": True}
    except Exception as exc:
        return {"valido": False, "erro": str(exc)}


@app.post("/validar-comando")
def validar_comando(req: ValidarRequest):
    """
    Filtro previo ao fluxo principal: o comando digitado e compreensivel o
    bastante pra virar um plano, ou esta contraditorio/ambiguo/incompleto?
    Chamado pela CLI interativa antes de acionar a recuperacao no grafo e a
    geracao — nao substitui a verificacao estrutural de /generate-constrained,
    so evita gastar uma geracao inteira num comando que ja nasceu inviavel.
    """
    compreensivel, motivo = _validar_comando(req.comando_humano)
    return {"compreensivel": compreensivel, "motivo": motivo}


@app.post("/validar-plano")
def validar_plano(req: ValidarPlanoRequest):
    """
    Avaliacao em lote (ver POST /api/avaliar no web-chat): julga se um plano JA
    GERADO e coerente com o subgrafo recuperado do Neo4j para o cenario dele e com o
    pedido original — substitui a comparacao contra um ground truth fixo por um
    julgamento sobre o estado atual do grafo. Ver JULGAMENTO_PLANO_INSTRUCAO.
    """
    correto, motivo = _validar_plano(req.plano, req.contexto_neo4j, req.intencao)
    return {"correto": correto, "motivo": motivo}


@app.post("/embed")
def embed(req: EmbedRequest):
    """
    Vetor de similaridade para a recuperacao por embedding no Neo4j: usado tanto
    na sincronizacao (embute cada Farmaco/Protocolo ou Produto/Cultura) quanto na
    consulta (embute a intencao digitada para achar os nos mais proximos no
    indice vetorial). Mesmo modelo dos dois lados — vetores comparaveis.
    """
    with _LLAMA_LOCK:
        vetor = get_embedder().create_embedding(req.texto)["data"][0]["embedding"]
    return {"vetor": vetor, "dimensoes": len(vetor)}


@app.post("/generate-constrained")
def generate_constrained(req: ICURequest):
    regras_hat, g_hat_texto = _gramatica_efetiva(req.subgrafo_regras)

    prompt = montar_prompt(
        exemplos=EXEMPLOS,
        x_teste=req.comando_humano,
        contexto_teste=req.contexto_neo4j,
        gramatica_completa=g_hat_texto,
    )

    resultado = _gerar(prompt, regras_hat)

    # Verificacao independente da geracao: mesmo com mascaramento de logits, a
    # saida e reparseada antes de sair do servico.
    parser_hat = build_parser(regras_hat, start=INICIO)
    try:
        parser_hat.parse(resultado)
        valido = True
        erro = None
    except Exception as exc:
        valido = False
        erro = str(exc)

    return {
        "resultado": resultado,
        "valido": valido,
        "erro": erro,
        "g_hat_utilizada": g_hat_texto,
        "regras_em_g_hat": len(regras_hat),
        # Diz ao cliente se a especializacao por item chegou a rodar. Sem esta
        # marca, um motor desatualizado (processo antigo ainda no ar) poda so
        # pelos tres vocabularios e devolve um plano com aparencia normal — foi
        # exatamente assim que uma correcao ja aplicada pareceu nao ter efeito.
        "especializada": bool(
            req.subgrafo_regras.get("politicas") and req.subgrafo_regras.get("papeis")
        ),
    }


@app.post("/generate-fragment")
def generate_fragment(req: FragmentoRequest):
    """
    Decodificacao incremental: gera UM elemento do artefato.

    O cliente valida cada elemento contra o grafo antes de aceita-lo; se o
    elemento violar alguma regra, o cliente repoda o subgrafo (o par que falhou
    sai) e pede este mesmo passo de novo. Como a poda entra na gramatica, a
    tentativa seguinte nao consegue repetir o erro.

    O servico continua sem conhecer o dominio: recebe o nao-terminal a gerar e a
    poda corrente, e devolve texto.
    """
    regras_hat, g_hat_texto = _gramatica_efetiva(req.subgrafo_regras)

    if req.simbolo not in regras_hat:
        raise HTTPException(
            status_code=422,
            detail=(
                f"O simbolo '{req.simbolo}' nao existe na gramatica podada: "
                "o contexto nao admite nenhum elemento desse tipo."
            ),
        )

    regras = dict(regras_hat)
    inicio = req.simbolo
    if req.encerramento:
        # Alternativa de controle: o modelo pode dizer "acabou" em vez de emitir
        # mais um elemento. O literal nao pertence a DSL e nao entra no artefato.
        nome = "fragmento_incremental"
        regras[nome] = Rule(nome, [[req.simbolo], ['"' + req.encerramento + '"']])
        inicio = nome

    prompt = montar_prompt(
        exemplos=EXEMPLOS,
        x_teste=req.comando_humano,
        contexto_teste=req.contexto_neo4j,
        gramatica_completa=g_hat_texto,
    ) + req.prefixo

    texto = _gerar(prompt, regras, inicio=inicio).strip()
    encerrou = bool(req.encerramento) and texto == req.encerramento

    return {
        "fragmento": "" if encerrou else texto,
        "encerrou": encerrou,
        "regras_em_g_hat": len(regras_hat),
        "especializada": bool(
            req.subgrafo_regras.get("politicas") and req.subgrafo_regras.get("papeis")
        ),
    }


@app.post("/generate-planner")
def generate_planner(req: PlannerRequest):
    """
    UMA chamada do Planner: gera a sequencia de pares (item, conduta) sob a
    gramatica do Planner (ver `gramatica_do_planner`).

    Usa o mesmo `_gerar` das outras rotas — mesmo modelo, mesmo `_LLAMA_LOCK`,
    mesma guarda de n_ctx, mesmos TEMPERATURA, REPEAT_PENALTY, MAX_TOKENS e
    MAX_ITENS. Sem nova tentativa: o cliente decide o que fazer com a saida.

    A saida volta CRUA. O reparse abaixo e informativo (`valida_na_gramatica`);
    a leitura que vale e a do cliente, que nao corrige nada.
    """
    regras = gramatica_do_planner(req.itens, req.condutas, req.max_pis, req.condutas_por_item)
    if not regras:
        raise HTTPException(
            status_code=422,
            detail="Sem item ou conduta candidata: o Planner nao tem o que propor.",
        )

    tokens_prompt = (
        len(get_llama().tokenize(req.prompt.encode("utf-8"))) if BACKEND == "llamacpp" else None
    )
    saida = _gerar(req.prompt, regras, inicio=INICIO_PLANNER)

    try:
        build_parser(regras, start=INICIO_PLANNER).parse(saida)
        valida, erro = True, None
    except Exception as exc:
        valida, erro = False, str(exc)

    return {
        "saida": saida,
        "valida_na_gramatica": valida,
        "erro": erro,
        "tokens_prompt": tokens_prompt,
        "regras_na_gramatica": len(regras),
        "gbnf": to_gbnf(regras, start=INICIO_PLANNER, max_itens=MAX_ITENS),
    }


@app.post("/generate-pi")
def generate_pi(req: PIAgentRequest):
    """
    UMA tentativa do PI Agent: gera a clausula de UM PI sob a gramatica do PI
    (ver `gramatica_do_pi`).

    Mesmo `_gerar` das outras rotas — mesmo modelo, mesmo `_LLAMA_LOCK`, mesma
    guarda de n_ctx. Sem nova tentativa e sem exemplares few-shot: o cliente
    valida e decide se tenta de novo. A saida volta CRUA; o reparse e
    informativo (`valida_na_gramatica`).
    """
    regras = gramatica_do_pi(req.subgrafo_regras, RULES, req.ordem, req.conduta)
    if not regras:
        raise HTTPException(
            status_code=422,
            detail="O payload do PI nao admite clausula alguma: UMA politica, com alguma decisao, e os papeis.",
        )

    tokens_prompt = (
        len(get_llama().tokenize(req.prompt.encode("utf-8"))) if BACKEND == "llamacpp" else None
    )
    saida = _gerar(req.prompt, regras, inicio=INICIO_PI, max_chars=MAX_CHARS_PI)

    try:
        build_parser(regras, start=INICIO_PI).parse(saida)
        valida, erro = True, None
    except Exception as exc:
        valida, erro = False, str(exc)

    return {
        "saida": saida,
        "valida_na_gramatica": valida,
        "erro": erro,
        "tokens_prompt": tokens_prompt,
        "regras_na_gramatica": len(regras),
        "gbnf": to_gbnf(regras, start=INICIO_PI, max_itens=MAX_ITENS, max_chars=MAX_CHARS_PI),
    }
