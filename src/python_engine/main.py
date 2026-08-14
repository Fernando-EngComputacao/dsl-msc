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

GRAMMAR_PATH = os.path.join(BASE_DIR, "grammar", "advanced_icu.bnf")
EXAMPLES_PATH = os.path.join(BASE_DIR, "data", "exemplos_icu.jsonl")
MODEL_ID = os.environ.get("SPC_CML_MODEL", "Qwen/Qwen2.5-0.5B-Instruct")

app = FastAPI(title="SPC-CML — decodificacao restrita", version="2.0")

# 1. Gramatica completa G, derivada da DSL local.
RULES = load_bnf(GRAMMAR_PATH)
PARSER = build_parser(RULES, start="plano")

# 2. Exemplares few-shot com G[y] derivado automaticamente de cada saida.
EXEMPLOS = carregar_exemplos(EXAMPLES_PATH, RULES, PARSER)

# 3. O LLM local e caro de carregar: so materializa no primeiro uso, para que
#    /health, /grammar e /verify funcionem sem GPU.
_MODEL = None


def get_model():
    global _MODEL
    if _MODEL is None:
        import outlines

        _MODEL = outlines.models.transformers(MODEL_ID)
    return _MODEL


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
    texto = gramatica_do_subgrafo(subgrafo, RULES)
    regras = parse_bnf(texto)
    if "plano" not in regras:
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
        "modelo": MODEL_ID,
        "modelo_carregado": _MODEL is not None,
    }


@app.get("/grammar")
def grammar():
    """Expoe G nos formatos consumidos pelos dois caminhos de decodificacao."""
    return {"lark": to_lark(RULES), "gbnf": to_gbnf(RULES, start="plano")}


@app.post("/verify")
def verify(req: VerifyRequest):
    """
    Verificacao pura: um plano pertence a L(G) ou a L(G_hat)?
    Usada pelo cliente TypeScript para conferir saidas de LLMs de API, que nao
    admitem mascaramento de logits.
    """
    regras, _ = _gramatica_efetiva(req.subgrafo_regras)
    parser = build_parser(regras, start="plano")
    try:
        parser.parse(req.plano)
        return {"valido": True}
    except Exception as exc:
        return {"valido": False, "erro": str(exc)}


@app.post("/generate-constrained")
def generate_constrained(req: ICURequest):
    regras_hat, g_hat_texto = _gramatica_efetiva(req.subgrafo_regras)

    prompt = montar_prompt(
        exemplos=EXEMPLOS,
        x_teste=req.comando_humano,
        contexto_teste=req.contexto_neo4j,
        gramatica_completa=g_hat_texto,
    )

    import outlines

    generator = outlines.generate.cfg(get_model(), to_lark(regras_hat))
    resultado = generator(prompt)

    # Verificacao independente da geracao: mesmo com mascaramento de logits, a
    # saida e reparseada antes de sair do servico.
    parser_hat = build_parser(regras_hat, start="plano")
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
