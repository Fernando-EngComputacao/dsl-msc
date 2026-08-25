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
# papeis a sua maneira (farmaco/via na clinica, produto/modo no agro,
# infracao/reinicio na arbitragem) e todas convivem aqui, porque uma BNF so traz
# os nomes do seu proprio dominio.
MAPA_PODA = {
    # dominio clinico (dsl.langium)
    "decisao": "acoes_permitidas",
    "farmaco": "farmacos_liberados",
    "via": "vias_disponiveis",
    # dominio agricola (agrodrone.langium)
    "produto": "farmacos_liberados",
    "modo": "vias_disponiveis",
    # dominio de arbitragem (futebol.langium)
    "infracao": "farmacos_liberados",
    "reinicio": "vias_disponiveis",
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


# ---------------------------------------------------------------------------
# Especializacao por item: a fase que converte erro semantico em erro sintatico.
#
# A poda por vocabulario (fases 1-3 adiante) restringe TRES listas independentes
# sobre uma regra que e um produto cartesiano:
#
#     ordem ::= "ordem" farmaco "decisao" decisao "dose" quantidade "via" via ...
#
# Com isso basta UM item admitir "INICIAR_INFUSAO" para que a cadeia
# "ordem <qualquer farmaco> decisao INICIAR_INFUSAO" continue derivavel. A
# politica por item que o GraphRAG ja calcula era achatada nessa uniao e perdida
# exatamente no ponto em que decidia algo.
#
# Esta fase reescreve a regra da clausula em uma producao POR ITEM, cada uma com
# as decisoes, os meios e os valores daquele item — e fixa como literal o que e
# DADO do cenario (o sujeito, os contextos) em vez de slot a preencher. Nada
# aqui e especifico de dominio: os papeis (clausula, item, decisao, meio,
# quantidade, sujeito, contexto) vem do proprio payload, como o MAPA_PODA acima
# ja fazia com os tres vocabularios.
# ---------------------------------------------------------------------------


def _sufixo(nome: str) -> str:
    """Sufixo de nao-terminal a partir do nome do item.

    Minusculas porque no Lark identificador maiusculo e TERMINAL, nao regra; o
    to_gbnf troca `_` por `-` depois, por conta propria.
    """
    return re.sub(r"[^a-z0-9_]", "_", nome.lower())


def _literal(valor: str) -> str:
    return '"' + valor + '"'


def especializar_por_item(
    rules: dict[str, Rule],
    politicas: list,
    papeis: dict,
    constantes: dict,
    inicio: str,
) -> dict[str, Rule]:
    clausula = papeis.get("clausula")
    item_sym = papeis.get("item")
    decisao_sym = papeis.get("decisao")
    meio_sym = papeis.get("meio")
    quantidade_sym = papeis.get("quantidade")

    if not clausula or clausula not in rules or not rules[clausula].alts:
        return rules  # gramatica sem a clausula esperada: nada a especializar

    novas = {
        nome: Rule(nome, [list(a) for a in r.alts], r.regex) for nome, r in rules.items()
    }
    molde = novas[clausula].alts[0]
    alternativas = []

    for politica in politicas:
        decisoes = politica.get("decisoes") or []
        if not decisoes:
            continue                      # item sem decisao alguma some da gramatica
        item = politica["item"]
        sfx = _sufixo(item)
        meios = politica.get("meios") or []
        valores = politica.get("valores") or []

        por_decisao = politica.get("valoresPorDecisao") or {}
        nome_clausula = clausula + "_" + sfx

        def _molde(decisao_simbolo, valores_da_vez, rotulo):
            """Uma alternativa da clausula, com o valor ja amarrado ao que a
            decisao admite. `decisao_simbolo` e um literal (quando a alternativa
            e por decisao) ou o nao-terminal do item."""
            alt = []
            for simbolo in molde:
                if simbolo == item_sym:
                    alt.append(_literal(item))
                elif simbolo == decisao_sym:
                    alt.append(decisao_simbolo)
                elif simbolo == meio_sym and meios:
                    alt.append(meio_sym + "_" + sfx)
                elif simbolo == quantidade_sym and valores_da_vez:
                    if len(valores_da_vez) == 1:
                        # Valor unico: entra inline, sem regra intermediaria.
                        alt.append(_literal(valores_da_vez[0]["valor"]))
                        alt.append(_literal(valores_da_vez[0]["unidade"]))
                    else:
                        nome_qtd = quantidade_sym + "_" + rotulo
                        novas[nome_qtd] = Rule(
                            nome_qtd,
                            [
                                [_literal(v["valor"]), _literal(v["unidade"])]
                                for v in valores_da_vez
                            ],
                        )
                        alt.append(nome_qtd)
                else:
                    alt.append(simbolo)
            return alt

        if por_decisao:
            # Precisao maxima: uma alternativa por decisao, com o valor que
            # AQUELA decisao admite (o degrau para titular, a dose inicial para
            # iniciar, zero para o que nao movimenta a bomba). E o que impede
            # "AUMENTAR_VAZAO dose 0.4" quando o modelo declara degrau de 0.05.
            alts_do_item = [
                _molde(_literal(d), por_decisao.get(d) or valores, sfx + "_" + _sufixo(d))
                for d in decisoes
            ]
        else:
            alts_do_item = [_molde(decisao_sym + "_" + sfx, valores, sfx)]
            novas[decisao_sym + "_" + sfx] = Rule(
                decisao_sym + "_" + sfx, [[_literal(d)] for d in decisoes]
            )

        novas[nome_clausula] = Rule(nome_clausula, alts_do_item)
        if meios:
            novas[meio_sym + "_" + sfx] = Rule(
                meio_sym + "_" + sfx, [[_literal(m)] for m in meios]
            )
        alternativas.append([nome_clausula])

    if not alternativas:
        # Nenhum item sobreviveu: a clausula fica sem alternativa e a fase 2
        # elimina quem depende dela — o contexto nao admite artefato algum.
        novas[clausula] = Rule(clausula, [])
        return novas

    novas[clausula] = Rule(clausula, alternativas)

    # O sujeito e DADO do cenario, nao decisao: vira literal no cabecalho. Sem
    # isso o campo e um `texto` livre e o modelo copia o identificador do
    # exemplar few-shot — foi assim que um plano saiu com o paciente errado.
    campo_sujeito = papeis.get("campoSujeito")
    sujeito = (constantes or {}).get("sujeito")
    if campo_sujeito and sujeito and inicio in novas:
        marcador = _literal(campo_sujeito)
        for alt in novas[inicio].alts:
            for i, simbolo in enumerate(alt):
                if simbolo == marcador and i + 1 < len(alt):
                    alt[i + 1] = _literal("'" + str(sujeito) + "'")

    # O contexto do artefato (protocolo/cultura/lance) fica restrito ao que o
    # foco recuperou: citar um protocolo que o grafo nao trouxe deixa de ser
    # exprimivel.
    contexto_sym = papeis.get("contexto")
    contextos = set((constantes or {}).get("contextos") or [])
    if contexto_sym and contexto_sym in novas and contextos:
        restantes = [
            a
            for a in novas[contexto_sym].alts
            if len(a) == 1 and a[0].strip('"') in contextos
        ]
        if restantes:
            novas[contexto_sym] = Rule(contexto_sym, restantes)

    return novas


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
    # --------------------------------------------- 0. especializacao por item
    politicas = subgrafo.get("politicas")
    papeis = subgrafo.get("papeis")
    if politicas and papeis:
        rules = especializar_por_item(
            rules, politicas, papeis, subgrafo.get("constantes", {}), inicio
        )

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
