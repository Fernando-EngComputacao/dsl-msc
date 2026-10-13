"""
Endpoint /diagnosticar-indeterminacao com um modelo SIMULADO (sem GPU, sem rede).

Executar (a partir de src/python_engine):
    python test_diagnostico.py

Comprova:
  1. o pedido chega ao modelo com o prompt do diagnostico (contexto do juiz,
     resposta UNRESOLVED, catalogo) e sob a gramatica montada com os
     identificadores enviados — e so com eles;
  2. a saida volta bruta, sem interpretacao, com `cortada` quando o modelo
     parou no teto de tokens;
  3. prompt que estoura n_ctx e recusado com 413, sem chamar o modelo.
"""
from __future__ import annotations

import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


class ModeloSimulado:
    """O suficiente de `llama_cpp.Llama` para `_diagnosticar`: tokenize e a chamada."""

    def __init__(self, texto: str, finish_reason: str = "stop", tokens_por_prompt: int = 100):
        self.texto = texto
        self.finish_reason = finish_reason
        self.tokens_por_prompt = tokens_por_prompt
        self.chamadas: list[dict] = []

    def tokenize(self, _dados: bytes) -> list[int]:
        return [0] * self.tokens_por_prompt

    def __call__(self, prompt: str, **kwargs):
        self.chamadas.append({"prompt": prompt, **kwargs})
        return {"choices": [{"text": self.texto, "finish_reason": self.finish_reason}]}


PEDIDO = {
    "plano": "arbitragem A para Disputa_Bola_Dividida { }",
    "intencao": "Carga imprudente aos 92 minutos",
    "telemetria": "- minuto_partida = 92",
    "contexto_neo4j": "[CENARIO]\n- partida: PT-2026-4011",
    "evidencias": "- nenhuma condicao observada",
    "justificativa_juiz": "o gatilho nao esta ativo",
    "evidencias_juiz": ["minuto_partida = 92"],
    "catalogo": "[REGRAS — os unicos identificadores que podem ser citados]\n- isencao:Carga_Imprudente [texto]",
    "regras": ["isencao:Carga_Imprudente", "regra_global#5"],
    "regras_formais": [],
    "regras_nao_formais": ["isencao:Carga_Imprudente", "regra_global#5"],
    "campos_com_valor": ["minuto_partida"],
    "campos_sem_valor": [],
}


def main_teste() -> int:
    falhas = 0
    cliente = TestClient(main.app)
    original = main.get_llama

    def rodar(modelo: ModeloSimulado):
        main.get_llama = lambda: modelo
        try:
            return cliente.post("/diagnosticar-indeterminacao", json=PEDIDO)
        finally:
            main.get_llama = original

    bruto = '{"evidenciasDisponiveis":[],"regrasAfetadas":[]}'
    modelo = ModeloSimulado(bruto)
    r = rodar(modelo)
    chamada = modelo.chamadas[0] if modelo.chamadas else {}
    gramatica = getattr(chamada.get("grammar"), "_grammar", "")
    cortado = ModeloSimulado('{"evidenciasDisponiveis":[', finish_reason="length")
    r_cortado = rodar(cortado)
    grande = ModeloSimulado(bruto, tokens_por_prompt=main.N_CTX)
    r_grande = rodar(grande)

    casos = [
        ("200 com a saida bruta, sem interpretacao", r.status_code == 200 and r.json() == {"resposta_bruta": bruto, "cortada": False}),
        ("uma chamada ao modelo, com o teto de tokens do diagnostico", len(modelo.chamadas) == 1 and chamada.get("max_tokens") == main.DIAGNOSTICO_MAX_TOKENS),
        ("o prompt traz o contexto do juiz, a resposta UNRESOLVED e o catalogo",
         all(s in chamada.get("prompt", "") for s in (
             "Carga imprudente aos 92 minutos", "[JULGAMENTO ORIGINAL: UNRESOLVED]", "o gatilho nao esta ativo",
             "[CATALOGO DE FUNDAMENTACAO]", "isencao:Carga_Imprudente [texto]"))),
        ("a gramatica so cita os identificadores enviados",
         '\\"isencao:Carga_Imprudente\\"' in gramatica and '\\"regra_global#5\\"' in gramatica
         and '\\"minuto_partida\\"' in gramatica and "campo-sem-valor" not in gramatica and "regra-formal" not in gramatica),
        ("saida cortada no teto de tokens volta marcada (cortada=true), sem conserto", r_cortado.status_code == 200 and r_cortado.json() == {"resposta_bruta": '{"evidenciasDisponiveis":[', "cortada": True}),
        ("prompt que estoura n_ctx: 413, e o modelo nao e chamado", r_grande.status_code == 413 and "n_ctx" in r_grande.json()["detail"] and not grande.chamadas),
    ]

    print("[diagnostico] /diagnosticar-indeterminacao com modelo simulado:")
    for descricao, ok in casos:
        if not ok:
            falhas += 1
        print(f"      {'ok' if ok else 'FALHA'}: {descricao}")
    print("\nRESULTADO:", "OK" if falhas == 0 else f"{falhas} falha(s)")
    return 0 if falhas == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main_teste())
