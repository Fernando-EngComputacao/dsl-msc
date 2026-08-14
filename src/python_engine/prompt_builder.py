"""
Monta o prompt de grammar prompting: (x_i, G[y_i], y_i) para cada exemplo + x de teste.
No SPC-CML, o Prompt Semantico vindo do GraphRAG entra como bloco de contexto factual.
"""
import json

INSTRUCAO = """Voce e um sistema medico especializado na UTI.
Primeiro escreva as regras BNF minimas necessarias; depois escreva o plano que obedece
exatamente a essas regras. Nao escreva mais nada."""


def bloco_exemplo(x: str, gy: str, y: str, contexto: str | None = None) -> str:
    p = f"comando: {x}\n"
    if contexto:
        p += f"contexto (recuperado do grafo):\n{contexto}\n"
    p += f"regras BNF:\n{gy}\nplano baseado nas regras BNF:\n{y}\n"
    return p


def montar_prompt(exemplos, x_teste, contexto_teste=None, gramatica_completa=None):
    partes = [INSTRUCAO]
    if gramatica_completa:
        partes.append(f"[BEGIN RULES]\n{gramatica_completa}\n[END RULES]")
    for e in exemplos:
        partes.append(bloco_exemplo(e["x"], e["gy"], e["y"], e.get("contexto")))
    ultimo = f"comando: {x_teste}\n"
    if contexto_teste:
        ultimo += f"contexto (recuperado do grafo):\n{contexto_teste}\n"
    ultimo += "regras BNF:"
    partes.append(ultimo)
    return "\n\n".join(partes)


def carregar_exemplos(path, rules, parser):
    from bnf import specialize
    saida = []
    for linha in open(path, encoding="utf-8"):
        if not linha.strip():
            continue
        ex = json.loads(linha)
        ex["gy"] = specialize(rules, parser, ex["y"])   # G[y] derivado automaticamente
        saida.append(ex)
    return saida