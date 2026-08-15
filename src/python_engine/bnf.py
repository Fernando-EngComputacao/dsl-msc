"""
Nucleo do grammar prompting: uma unica gramatica G em BNF que gera
  (1) um parser Lark  -> usado para derivar G[y] e para decodificacao restrita via API
  (2) um arquivo GBNF -> usado para mascaramento de logits em modelo local
  (3) G[y], a gramatica especializada minima de um programa y (Wang et al., 2023, sec. 3.1)
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from lark import Lark, Tree, Token


# --------------------------------------------------------------------------
# 1. Leitura da BNF canonica
# --------------------------------------------------------------------------

@dataclass
class Rule:
    name: str
    alts: list[list[str]] = field(default_factory=list)  # cada alt = lista de simbolos
    regex: str | None = None                             # terminal-padrao (folha)


# Um simbolo e um literal ("plano"), um regex (/[0-9]+/) ou um nao-terminal,
# este ultimo podendo carregar cardinalidade `*`, `+` ou `?`. A cardinalidade e
# necessaria porque a BNF passou a ser gerada a partir da DSL Langium
# (src/cli/export-bnf.ts), onde listas de ordens e alertas sao repeticoes.
SYMBOL_RE = re.compile(r'"[^"]*"|/(?:[^/\\]|\\.)*/|[A-Za-z_][A-Za-z_0-9]*[*+?]?')


def load_bnf(path: str) -> dict[str, Rule]:
    with open(path, encoding="utf-8") as fh:
        return parse_bnf(fh.read())


def parse_bnf(texto: str) -> dict[str, Rule]:
    """Mesma leitura, a partir de texto — usada com a G_hat gerada em memoria."""
    rules: dict[str, Rule] = {}
    for line in texto.splitlines():
        line = line.split("#")[0].strip()
        if not line or "::=" not in line:
            continue
        head, body = line.split("::=", 1)
        head = head.strip()
        rule = Rule(head)
        if body.strip().startswith("/") and "|" not in body:
            rule.regex = body.strip()[1:-1]
        else:
            for alt in body.split("|"):
                rule.alts.append(SYMBOL_RE.findall(alt.strip()))
        rules[head] = rule
    return rules


# --------------------------------------------------------------------------
# 2. BNF -> Lark (parser real, usado para derivar G[y] e validar saidas)
# --------------------------------------------------------------------------

def to_lark(rules: dict[str, Rule], start: str = "plano") -> str:
    out = []
    # Lark entra pela regra chamada `start` quando o simbolo inicial nao e
    # informado na construcao — e o CFGGuide do outlines constroi o parser so com
    # o texto da gramatica. Sem este alias a decodificacao restrita morre com
    # "Using an undefined rule: start", embora build_parser() funcione por passar
    # start= explicitamente. E o mesmo papel do `root ::=` em to_gbnf().
    if start != "start" and start in rules:
        out.append(f"start: {start}")
    for name, r in rules.items():
        if r.regex is not None:
            out.append(f"{name.upper()}: /{r.regex}/")
            out.append(f"{name}: {name.upper()}")
            continue
        parts = []
        for i, alt in enumerate(r.alts):
            body = " ".join(alt)
            # alias por alternativa: permite saber QUAL alternativa foi derivada
            parts.append(f"{body} -> alt_{name}_{i}" if len(r.alts) > 1 else body)
        out.append(f"{name}: " + "\n    | ".join(parts))
    out.append("%import common.WS")
    out.append("%ignore WS")
    return "\n".join(out)


def build_parser(rules: dict[str, Rule], start: str = "plano") -> Lark:
    return Lark(to_lark(rules, start), start=start, parser="lalr")


# --------------------------------------------------------------------------
# 3. G[y]: gramatica especializada minima (uniao das regras usadas na derivacao)
# --------------------------------------------------------------------------

def _walk(node, used: dict[str, set[int]]):
    if isinstance(node, Token):
        return
    data = node.data
    m = re.fullmatch(r"alt_(.+)_(\d+)", str(data))
    if m:
        used.setdefault(m.group(1), set()).add(int(m.group(2)))
    else:
        used.setdefault(str(data), set()).add(0)
    for c in node.children:
        _walk(c, used)


def specialize(rules: dict[str, Rule], parser: Lark, program: str) -> str:
    """Retorna G[y] em BNF: so as regras/alternativas usadas para derivar `program`."""
    tree = parser.parse(program)
    used: dict[str, set[int]] = {}
    _walk(tree, used)

    lines = []
    for name, r in rules.items():          # preserva a ordem da gramatica completa
        if name not in used:
            continue
        if r.regex is not None:
            lines.append(f"{name} ::= /{r.regex}/")
            continue
        alts = [" ".join(r.alts[i]) for i in sorted(used[name]) if i < len(r.alts)]
        lines.append(f"{name} ::= " + " | ".join(alts))
    return "\n".join(lines)


def parses(rules_or_parser, program: str) -> bool:
    try:
        rules_or_parser.parse(program)
        return True
    except Exception:
        return False


# --------------------------------------------------------------------------
# 4. BNF -> GBNF (llama.cpp / vLLM+XGrammar: mascaramento real de logits)
# --------------------------------------------------------------------------

def to_gbnf(rules: dict[str, Rule], start: str = "plano") -> str:
    out = [f"root ::= {start}"]
    for name, r in rules.items():
        if r.regex is not None:
            out.append(f'{name} ::= {_regex_to_gbnf(r.regex)}')
            continue
        alts = []
        for alt in r.alts:
            syms = []
            for s in alt:
                if s.startswith('"') or s.startswith("/"):
                    syms.append(s)
                    continue
                base, card = (s[:-1], s[-1]) if s[-1] in "*+?" else (s, "")
                syms.append(f"({base} ws){card}" if card else base)
            alts.append(" ws ".join(syms))
        out.append(f"{name} ::= " + " | ".join(alts))
    out.append('ws ::= " "*')
    return "\n".join(out)


def _regex_to_gbnf(rx: str) -> str:
    # traducao suficiente para classes simples usadas no DSL
    rx = rx.replace("[0-9]", "[0-9]").replace("[A-Z]", "[A-Z]")
    return rx