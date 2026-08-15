"""
Monta o prompt de grammar prompting: (x_i, G[y_i], y_i) para cada exemplo + x de teste.
No SPC-CML, o Prompt Semantico vindo do GraphRAG entra como bloco de contexto factual.
"""
import json

# No grammar prompting original (Wang et al., 2023) o LLM primeiro PREDIZ G[y] e
# so entao gera y. No SPC-CML essa etapa nao cabe ao modelo: G_hat vem da poda no
# Grafo de Conhecimento — e essa substituicao e a contribuicao da arquitetura.
# Pedir as regras aqui contradiz a mascara, que so admite um plano (root ::= plano):
# o modelo tentava escrever o separador "plano baseado nas regras BNF:" e a
# gramatica o espremia dentro do identificador. As regras sao dadas, nao pedidas.
INSTRUCAO = """Voce e um sistema medico especializado na UTI.
As regras BNF aplicaveis ja foram recuperadas do grafo e sao dadas a seguir.
Escreva apenas o plano que obedece exatamente a essas regras. Nao escreva mais nada."""


def bloco_exemplo(x: str, gy: str, y: str, contexto: str | None = None) -> str:
    p = f"comando: {x}\n"
    if contexto:
        p += f"contexto (recuperado do grafo):\n{contexto}\n"
    p += f"regras BNF:\n{gy}\nplano baseado nas regras BNF:\n{y}\n"
    return p


def montar_prompt(exemplos, x_teste, contexto_teste=None, gramatica_completa=None):
    partes = [INSTRUCAO]
    for e in exemplos:
        partes.append(bloco_exemplo(e["x"], e["gy"], e["y"], e.get("contexto")))

    # O bloco de teste espelha bloco_exemplo ate o cabecalho do plano, e para ali:
    # a continuacao natural passa a ser o proprio plano, que e o unico texto que a
    # mascara admite. G_hat entra no lugar onde os exemplares trazem G[y].
    ultimo = f"comando: {x_teste}\n"
    if contexto_teste:
        ultimo += f"contexto (recuperado do grafo):\n{contexto_teste}\n"
    if gramatica_completa:
        ultimo += f"regras BNF:\n{gramatica_completa}\n"
    ultimo += "plano baseado nas regras BNF:\n"
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