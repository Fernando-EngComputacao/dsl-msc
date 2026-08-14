"""
Verificacao do motor de grammar prompting sobre a BNF gerada a partir da DSL local.

Executar (a partir de src/python_engine):
    python test_grammar.py

Comprova, sem depender de LLM nem de GPU:
  1. G (gerada por src/cli/export-bnf.ts) compila em um parser real;
  2. um plano valido e aceito e produz G[y] minimal;
  3. planos alucinados sao REJEITADOS pela gramatica — erro sintatico zero;
  4. a poda pelo subgrafo do Neo4j torna decisoes proibidas inexprimiveis.
"""
from __future__ import annotations

import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

from bnf import load_bnf, parse_bnf, build_parser, specialize, to_gbnf  # noqa: E402
from grammar_from_kg import gramatica_do_subgrafo  # noqa: E402

GRAMMAR_PATH = os.path.join(BASE_DIR, "grammar", "advanced_icu.bnf")

PLANO_VALIDO = (
    "plano Plano_Choque_01 para Choque_Septico { "
    "esquema_referencia AssistenteUTI_v2 "
    "paciente 'PT-2026-0031' "
    "sequencia [ Titular_Vasopressor, Manter_Bloqueio ] "
    "ordem Noradrenalina decisao AUMENTAR_VAZAO dose 0.05 mcg/kg/min via ACESSO_CENTRAL "
    "justificativa 'PAM 52 mmHg abaixo do alvo apos reposicao volemica' "
    "ordem Propofol decisao MANTER_BLOQUEADO dose 0.0 mg/kg/h via ACESSO_CENTRAL "
    "justificativa 'incremento vetado pela regra de seguranca com PAM menor que 60' "
    "alerta CRITICO 'hipoperfusao grave com lactato 4.8' regra 'Choque_Septico/escalonar' "
    "auditoria 'plano derivado sob restricao gramatical' "
    "}"
)

# Cada caso isola um modo de falha real de LLM em dominio clinico.
PLANOS_INVALIDOS = {
    "farmaco inexistente no modelo": PLANO_VALIDO.replace("Noradrenalina", "Dopamina"),
    "decisao fora do Esquema de Dados": PLANO_VALIDO.replace("AUMENTAR_VAZAO", "TURBINAR_VAZAO"),
    "unidade de dose invalida": PLANO_VALIDO.replace("mcg/kg/min", "gotas/min"),
    "via nao permitida": PLANO_VALIDO.replace("ACESSO_CENTRAL", "INTRATECAL"),
    "conduta inexistente": PLANO_VALIDO.replace("Titular_Vasopressor", "Turbinar_Droga"),
    "justificativa ausente (rastreabilidade)": PLANO_VALIDO.replace(
        "justificativa 'PAM 52 mmHg abaixo do alvo apos reposicao volemica' ", ""
    ),
    "campo de auditoria ausente": PLANO_VALIDO.replace(
        "auditoria 'plano derivado sob restricao gramatical' ", ""
    ),
}


def main() -> int:
    falhas = 0

    rules = load_bnf(GRAMMAR_PATH)
    print(f"[1] G carregada de advanced_icu.bnf: {len(rules)} regras")

    parser = build_parser(rules, start="plano")
    print("[2] Parser construido com sucesso (a BNF gerada e sintaticamente coerente)")

    try:
        parser.parse(PLANO_VALIDO)
        print("[3] Plano valido ACEITO por G")
    except Exception as exc:
        print(f"[3] FALHA: plano valido rejeitado -> {exc}")
        return 1

    gy = specialize(rules, parser, PLANO_VALIDO)
    # A minimalidade de G[y] aparece nas ALTERNATIVAS, nao no numero de regras:
    # as regras continuam la, mas cada vocabulario e reduzido ao que y usa.
    alts_g = sum(max(len(r.alts), 1) for r in rules.values())
    alts_gy = sum(linha.count("|") + 1 for linha in gy.splitlines() if "::=" in linha)
    print(
        f"[4] G[y] derivada: {alts_gy} alternativas de {alts_g} em G "
        f"({100 * (1 - alts_gy / alts_g):.0f}% do espaco de geracao eliminado)"
    )

    print("[5] Rejeicao de alucinacoes:")
    for descricao, programa in PLANOS_INVALIDOS.items():
        try:
            parser.parse(programa)
            print(f"      NAO BLOQUEADO: {descricao}")
            falhas += 1
        except Exception:
            print(f"      bloqueado: {descricao}")

    # Poda pelo subgrafo recuperado do Neo4j: com PAM < 60 o incremento de
    # sedativo esta vetado, entao AUMENTAR_VAZAO nem sequer existe na gramatica.
    subgrafo = {
        "acoes_permitidas": ["MANTER_BLOQUEADO", "SOLICITAR_EXAME", "ESCALAR_EQUIPE"],
        "farmacos_liberados": ["Propofol", "Noradrenalina"],
        "vias_disponiveis": ["ACESSO_CENTRAL"],
    }
    g_hat_texto = gramatica_do_subgrafo(subgrafo, rules)

    # Nao basta o termo sumir do texto: G_hat precisa continuar sendo uma
    # gramatica utilizavel, que aceita o seguro e recusa o vetado. Sem parsear,
    # este teste passaria ate se a poda tivesse destruido a gramatica inteira.
    rules_hat = parse_bnf(g_hat_texto)
    parser_hat = build_parser(rules_hat, start="plano")

    plano_seguro = PLANO_VALIDO.replace("AUMENTAR_VAZAO", "MANTER_BLOQUEADO")
    plano_seguro = plano_seguro.replace(
        "ordem Propofol decisao MANTER_BLOQUEADO dose 0.0 mg/kg/h via ACESSO_CENTRAL "
        "justificativa 'incremento vetado pela regra de seguranca com PAM menor que 60' ",
        "",
    )

    casos = [
        ("aceita plano dentro da poda", plano_seguro, True),
        ("recusa decisao vetada", PLANO_VALIDO, False),
        ("recusa farmaco fora da poda", plano_seguro.replace("Noradrenalina", "Vancomicina"), False),
    ]
    print("[6] G_hat podada pelo subgrafo (parser reconstruido):")
    for descricao, programa, esperado in casos:
        try:
            parser_hat.parse(programa)
            obtido = True
        except Exception:
            obtido = False
        marca = "ok" if obtido == esperado else "FALHA"
        if obtido != esperado:
            falhas += 1
        print(f"      {marca}: {descricao}")

    gbnf = to_gbnf(rules, start="plano")
    print(f"[7] GBNF exportada para mascaramento de logits: {len(gbnf.splitlines())} regras")

    print("\nRESULTADO:", "OK" if falhas == 0 else f"{falhas} falha(s)")
    return 0 if falhas == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
