"""
Motor de recuperacao deterministica (SPC-CML): G -> G_hat.

Recorta a gramatica completa G com base no subgrafo de restricoes devolvido pelo
Neo4j (GraphRAG). O que o grafo veta nao vira instrucao no prompt: some da
gramatica. Uma violacao clinica deixa de ser uma saida improvavel e passa a ser
uma cadeia que o decodificador nao consegue emitir.
"""
from __future__ import annotations

import re

from bnf import Rule

# Nome da regra na BNF -> chave correspondente no subgrafo recuperado.
#
# O motor e agnostico de dominio: sao estes tres papeis — o que se decide, sobre
# o que se decide, e por qual meio — que ele precisa conhecer. Cada DSL nomeia os
# papeis a sua maneira (farmaco/via na clinica, produto/modo no agro) e ambas
# convivem aqui, porque uma BNF so traz os nomes do seu proprio dominio.
MAPA_PODA = {
    # dominio clinico (dsl.langium)
    "decisao": "acoes_permitidas",
    "farmaco": "farmacos_liberados",
    "via": "vias_disponiveis",
    # dominio agricola (agrodrone.langium)
    "produto": "farmacos_liberados",
    "modo": "vias_disponiveis",
    # compatibilidade com a BNF manual anterior
    "tipo_acao": "acoes_permitidas",
    "tipo_farmaco": "farmacos_liberados",
    "tipo_via": "vias_disponiveis",
}

SIMBOLO_RE = re.compile(r'"[^"]*"|/(?:[^/\\]|\\.)*/|[A-Za-z_][A-Za-z_0-9]*[*+?]?')


def _base(simbolo: str) -> str:
    """Nome do simbolo sem a cardinalidade."""
    return simbolo[:-1] if simbolo and simbolo[-1] in "*+?" else simbolo


def _e_terminal(simbolo: str) -> bool:
    return simbolo.startswith('"') or simbolo.startswith("/")


def _opcional(simbolo: str) -> bool:
    """`x*` e `x?` derivam a cadeia vazia; `x+` nao."""
    return simbolo.endswith("*") or simbolo.endswith("?")


def gramatica_do_subgrafo(subgrafo: dict, rules: dict[str, Rule], inicio: str = "plano") -> str:
    """
    Devolve G_hat em BNF: subconjunto de G podado pelas restricoes do dominio.

    O algoritmo tem tres fases, na ordem em que precisam acontecer:
      1. poda dos vocabularios fechados pelas listas do subgrafo;
      2. remocao de simbolos que deixaram de gerar qualquer cadeia (uma regra cujo
         vocabulario ficou vazio contamina quem a referencia);
      3. varredura de alcance a partir do simbolo inicial.

    Sem a fase 2 a gramatica resultante referencia regras inexistentes e nem chega
    a compilar no parser.
    """
    # ------------------------------------------------------------- 1. poda
    podadas: dict[str, list[list[str]]] = {}
    regex: dict[str, str] = {}

    for nome, r in rules.items():
        if r.regex is not None:
            regex[nome] = r.regex
            podadas[nome] = []          # folha lexica: sempre geradora
            continue

        alts = [list(a) for a in r.alts]
        chave = MAPA_PODA.get(nome)
        permitidos = subgrafo.get(chave) if chave else None

        if permitidos:
            permitidos = set(permitidos)
            # Vocabulario fechado: cada alternativa e um unico literal. A
            # comparacao e exata — `in` sobre a string casaria prefixos.
            alts = [
                a
                for a in alts
                if not (len(a) == 1 and _e_terminal(a[0]))
                or a[0].strip('"') in permitidos
            ]

        podadas[nome] = alts

    # -------------------------------------------- 2. simbolos nao geradores
    geradores = set(regex)
    mudou = True
    while mudou:
        mudou = False
        for nome, alts in podadas.items():
            if nome in geradores:
                continue
            for alt in alts:
                if all(
                    _e_terminal(s) or _opcional(s) or _base(s) in geradores for s in alt
                ):
                    geradores.add(nome)
                    mudou = True
                    break

    limpas: dict[str, list[list[str]]] = {}
    for nome, alts in podadas.items():
        if nome not in geradores:
            continue
        novas = []
        for alt in alts:
            reduzida = []
            viavel = True
            for s in alt:
                if _e_terminal(s) or _base(s) in geradores:
                    reduzida.append(s)
                elif _opcional(s):
                    continue  # so poderia derivar vazio: some da alternativa
                else:
                    viavel = False
                    break
            if viavel:
                novas.append(reduzida)
        if novas or nome in regex:
            limpas[nome] = novas

    if inicio not in limpas:
        return ""

    # ------------------------------------------------- 3. varredura de alcance
    alcancaveis: set[str] = set()
    fila = [inicio]
    while fila:
        nome = fila.pop()
        if nome in alcancaveis or nome not in limpas:
            continue
        alcancaveis.add(nome)
        for alt in limpas[nome]:
            for s in alt:
                if not _e_terminal(s):
                    fila.append(_base(s))

    # ------------------------------------------------------- 4. serializacao
    linhas = []
    for nome in rules:                       # preserva a ordem da gramatica original
        if nome not in alcancaveis:
            continue
        if nome in regex:
            linhas.append(f"{nome} ::= /{regex[nome]}/")
        else:
            linhas.append(
                f"{nome} ::= " + " | ".join(" ".join(a) for a in limpas[nome])
            )
    return "\n".join(linhas)
