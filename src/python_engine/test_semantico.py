"""
Verificacao da separacao entre GERACAO SEMANTICA e REALIZACAO GRAMATICAL no motor.

Executar (a partir de src/python_engine):
    python test_semantico.py

O modelo real so carrega no primeiro uso (get_llama); aqui ele e dublado, entao
o teste roda sem GPU e sem baixar pesos. Comprova:
  1. /generate-semantic gera por chat e NAO passa gramatica ao llama.cpp;
  2. a resposta traz texto, modelo, backend, tokens e motivo de parada;
  3. prompt que nao cabe em n_ctx volta 413, antes de chamar o modelo;
  4. com SPC_CML_BACKEND=outlines a rota volta 501;
  5. /generate-constrained continua gerando SOB GBNF e verificando contra G_hat.
"""
from __future__ import annotations

import os
import sys
import warnings

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)
warnings.filterwarnings("ignore")

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

PLANO_VALIDO = (
    "plano Plano_Choque_01 para Choque_Septico { "
    "esquema_referencia AssistenteUTI_v2 "
    "paciente 'PT-2026-0031' "
    "sequencia [ Titular_Vasopressor ] "
    "ordem Noradrenalina decisao AUMENTAR_VAZAO dose 0.05 mcg/kg/min via ACESSO_CENTRAL "
    "justificativa 'PAM 52 mmHg abaixo do alvo' "
    "auditoria 'plano derivado sob restricao gramatical' "
    "}"
)


class LlamaDublado:
    """Registra o que o motor pediu ao llama.cpp e devolve respostas fixas."""

    def __init__(self, tokens_por_texto: int = 10):
        self.tokens_por_texto = tokens_por_texto
        self.chamadas_chat: list[dict] = []
        self.chamadas_completion: list[dict] = []

    def tokenize(self, _texto: bytes) -> list[int]:
        return [0] * self.tokens_por_texto

    def create_chat_completion(self, **kwargs):
        self.chamadas_chat.append(kwargs)
        return {
            "choices": [{"message": {"content": "  Noradrenalina | AUMENTAR_VAZAO | PAM 52  "}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 120, "completion_tokens": 14},
        }

    def __call__(self, prompt, **kwargs):
        self.chamadas_completion.append({"prompt": prompt, **kwargs})
        return {"choices": [{"text": PLANO_VALIDO}]}


def main_teste() -> int:
    falhas = 0

    def conferir(descricao: str, ok: bool) -> None:
        nonlocal falhas
        if not ok:
            falhas += 1
        print(f"      {'ok' if ok else 'FALHA'}: {descricao}")

    cliente = TestClient(main.app)
    original = main.get_llama

    # --------------------------------------------------------------- [1-2]
    llama = LlamaDublado()
    main.get_llama = lambda: llama
    try:
        r = cliente.post("/generate-semantic", json={"sistema": "Voce PROPOE.", "usuario": "sobe a nora", "max_tokens": 64})
        dados = r.json()
        chamada = llama.chamadas_chat[0] if llama.chamadas_chat else {}
        print("[1] Geracao semantica: chat, sem gramatica")
        conferir("responde 200", r.status_code == 200)
        conferir("usa o chat com papeis system e user", [m["role"] for m in chamada.get("messages", [])] == ["system", "user"])
        conferir("NAO passa gramatica ao llama.cpp", "grammar" not in chamada)
        conferir("nao usa o caminho de completion com GBNF", llama.chamadas_completion == [])
        conferir("respeita max_tokens do pedido", chamada.get("max_tokens") == 64)
        print("[2] Resultado")
        conferir("texto sem espacos nas pontas", dados.get("texto") == "Noradrenalina | AUMENTAR_VAZAO | PAM 52")
        conferir("modelo e backend informados", dados.get("modelo") == main._nome_modelo() and dados.get("backend") == "llamacpp")
        conferir("tokens de entrada e saida", dados.get("tokens_entrada") == 120 and dados.get("tokens_saida") == 14)
        conferir("motivo de parada", dados.get("motivo_parada") == "stop")

        # ----------------------------------------------------------- [3]
        grande = LlamaDublado(tokens_por_texto=main.N_CTX)
        main.get_llama = lambda: grande
        r = cliente.post("/generate-semantic", json={"sistema": "s", "usuario": "u"})
        print("[3] Prompt maior que n_ctx")
        conferir("volta 413", r.status_code == 413)
        conferir("nao chega a chamar o modelo", grande.chamadas_chat == [])

        # ----------------------------------------------------------- [4]
        backend = main.BACKEND
        main.BACKEND = "outlines"
        try:
            r = cliente.post("/generate-semantic", json={"sistema": "s", "usuario": "u"})
        finally:
            main.BACKEND = backend
        print("[4] Backend outlines")
        conferir("volta 501", r.status_code == 501)

        # ----------------------------------------------------------- [5]
        llama = LlamaDublado()
        main.get_llama = lambda: llama
        r = cliente.post("/generate-constrained", json={"comando_humano": "sobe a nora", "contexto_neo4j": "", "subgrafo_regras": {}})
        dados = r.json()
        chamada = llama.chamadas_completion[0] if llama.chamadas_completion else {}
        print("[5] Realizacao gramatical continua sob GBNF")
        conferir("responde 200", r.status_code == 200)
        conferir("passa a gramatica ao llama.cpp", chamada.get("grammar") is not None)
        conferir("nao usa o chat", llama.chamadas_chat == [])
        conferir("reparseia a saida contra G_hat", dados.get("valido") is True)
        conferir("informa o modelo", dados.get("modelo") == main._nome_modelo())
    finally:
        main.get_llama = original

    print("\nRESULTADO:", "OK" if falhas == 0 else f"{falhas} falha(s)")
    return 0 if falhas == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main_teste())
