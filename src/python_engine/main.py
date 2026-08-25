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

from bnf import load_bnf, parse_bnf, build_parser, to_lark, to_gbnf  # noqa: E402
from grammar_from_kg import gramatica_do_subgrafo  # noqa: E402
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


def _gerar(prompt: str, regras_hat: dict) -> str:
    """Geracao sob mascaramento de logits pela gramatica ja podada."""
    if BACKEND == "outlines":
        import outlines

        return outlines.generate.cfg(get_model(), to_lark(regras_hat, start=INICIO))(prompt)

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

    with _LLAMA_LOCK:
        saida = llm(
            prompt,
            grammar=LlamaGrammar.from_string(
                to_gbnf(regras_hat, start=INICIO, max_itens=MAX_ITENS), verbose=False
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


class ValidarRequest(BaseModel):
    comando_humano: str = Field(..., description="Texto digitado pelo usuario, a validar antes de entrar no fluxo")


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
    }
