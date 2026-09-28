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
from grammar_from_kg import (  # noqa: E402
    INICIO_PI,
    INICIO_PLANNER,
    gramatica_do_pi,
    gramatica_do_planner,
    gramatica_do_subgrafo,
)

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

    # ---------------------------------------------------------------- [7]
    # Especializacao por item: a poda por vocabulario acima ainda deixa o
    # produto cartesiano de pe (qualquer farmaco com qualquer decisao liberada).
    # Com a politica POR ITEM, cada par (item, decisao) carrega os seus proprios
    # meios e o seu proprio valor — e o caso real que motivou esta fase deixa de
    # ser derivavel.
    subgrafo_especializado = {
        "papeis": {
            "artefato": "plano",
            "clausula": "ordem",
            "item": "farmaco",
            "decisao": "decisao",
            "meio": "via",
            "quantidade": "quantidade",
            "campoQuantidade": "dose",
            "campoSujeito": "paciente",
            "contexto": "protocolo",
        },
        "constantes": {"sujeito": "PT-2026-4001", "contextos": ["Choque_Septico"]},
        "politicas": [
            {
                # Noradrenalina JA em infusao: iniciar de novo nao cabe, e o
                # incremento e o degrau declarado (titulacao 0.05), nao um numero
                # qualquer.
                "item": "Noradrenalina",
                "decisoes": ["AUMENTAR_VAZAO", "MANTER_BLOQUEADO"],
                "meios": ["ACESSO_CENTRAL"],
                "valores": [{"valor": "0.05", "unidade": "mcg/kg/min"}],
                "valoresPorDecisao": {
                    "AUMENTAR_VAZAO": [{"valor": "0.05", "unidade": "mcg/kg/min"}],
                    "MANTER_BLOQUEADO": [{"valor": "0.0", "unidade": "mcg/kg/min"}],
                },
            },
            {
                # Vasopressina fora de curso: so iniciar, e no maximo o limite
                # rigido de 0.04 U/min declarado no uti.dsl.
                "item": "Vasopressina",
                "decisoes": ["INICIAR_INFUSAO"],
                "meios": ["ACESSO_CENTRAL"],
                "valores": [{"valor": "0.01", "unidade": "U/min"}],
                "valoresPorDecisao": {
                    "INICIAR_INFUSAO": [{"valor": "0.01", "unidade": "U/min"}]
                },
            },
        ],
    }

    g_esp = build_parser(
        parse_bnf(gramatica_do_subgrafo(subgrafo_especializado, rules, inicio="plano")),
        start="plano",
    )

    cabecalho = (
        "plano P para Choque_Septico { esquema_referencia AssistenteUTI_v2 "
        "paciente 'PT-2026-4001' sequencia [ Titular_Vasopressor ] "
    )
    rodape = "auditoria 'plano derivado sob restricao gramatical' }"
    def _plano(ordem):
        return cabecalho + ordem + " " + rodape

    ORDEM_OK = (
        "ordem Noradrenalina decisao AUMENTAR_VAZAO dose 0.05 mcg/kg/min "
        "via ACESSO_CENTRAL justificativa 'PAM 52 abaixo do alvo'"
    )
    casos_esp = [
        ("aceita o par (item, decisao, valor) que o modelo declara", _plano(ORDEM_OK), True),
        (
            "recusa iniciar farmaco que ja esta em infusao",
            _plano(ORDEM_OK.replace("AUMENTAR_VAZAO", "INICIAR_INFUSAO")),
            False,
        ),
        (
            "recusa dose fora do degrau declarado (0.4 no lugar de 0.05)",
            _plano(ORDEM_OK.replace("dose 0.05", "dose 0.4")),
            False,
        ),
        (
            "recusa valor acima do limite rigido da bomba (0.1 U/min)",
            _plano(
                "ordem Vasopressina decisao INICIAR_INFUSAO dose 0.1 U/min "
                "via ACESSO_CENTRAL justificativa 'segunda linha'"
            ),
            False,
        ),
        (
            "recusa decisao que nao cabe ao item (MANTER_BLOQUEADO em item livre)",
            _plano(
                "ordem Vasopressina decisao MANTER_BLOQUEADO dose 0.0 U/min "
                "via ACESSO_CENTRAL justificativa 'segunda linha'"
            ),
            False,
        ),
        (
            "recusa identificador de paciente copiado do exemplar few-shot",
            _plano(ORDEM_OK).replace("PT-2026-4001", "PT-2026-0031"),
            False,
        ),
        (
            "recusa protocolo fora do foco recuperado",
            _plano(ORDEM_OK).replace("Choque_Septico", "Controle_Glicemico_UTI"),
            False,
        ),
    ]
    print("[7] G_hat especializada por item (o produto cartesiano deixa de existir):")
    for descricao, programa, esperado in casos_esp:
        try:
            g_esp.parse(programa)
            obtido = True
        except Exception:
            obtido = False
        marca = "ok" if obtido == esperado else "FALHA"
        if obtido != esperado:
            falhas += 1
        print(f"      {marca}: {descricao}")

    # ---------------------------------------------------------------- [8]
    # Politica por item VAZIA nao e ausencia de poda. E o que chega ao motor
    # quando o foco nao deixa item nenhum: o RAG sem candidato e uma fala que nao
    # nomeia nada. Lista vazia quer dizer "nenhum item e exprimivel"; a G_hat nao
    # pode voltar a ser a G inteira, em que a Dobutamina vetada pelo
    # Choque_Septico ativo volta a poder ser iniciada.
    subgrafo_vazio = {
        "acoes_permitidas": [],
        "farmacos_liberados": [],
        "vias_disponiveis": [],
        "politicas": [],
        "papeis": subgrafo_especializado["papeis"],
        "constantes": {"sujeito": "PT-2026-0031", "contextos": []},
    }
    rules_vazio = parse_bnf(gramatica_do_subgrafo(subgrafo_vazio, rules, inicio="plano"))
    plano_vetado = (
        "plano P para Choque_Septico { esquema_referencia AssistenteUTI_v2 "
        "paciente 'PT-2026-0031' sequencia [ Iniciar_Vasopressor ] "
        "ordem Dobutamina decisao INICIAR_INFUSAO dose 5.0 mcg/kg/min "
        "via ACESSO_CENTRAL justificativa 'inotropico' "
        "auditoria 'plano derivado sob restricao gramatical' }"
    )
    def _aceita(regras, programa):
        try:
            build_parser(regras, start="plano").parse(programa)
            return True
        except Exception:
            return False

    aceitou_vetado = _aceita(rules_vazio, plano_vetado)
    casos_vazio = [
        # Sem isto a recusa abaixo poderia vir de um erro no proprio plano.
        ("o plano e sintaticamente valido em G", _aceita(rules, plano_vetado)),
        ("nenhuma clausula exprimivel", "ordem" not in rules_vazio),
        ("recusa ordem de farmaco vetado", not aceitou_vetado),
        ("G_hat nao e a G inteira", len(rules_vazio) < len(rules)),
    ]
    print("[8] Politica por item vazia (foco sem item nenhum):")
    for descricao, ok in casos_vazio:
        if not ok:
            falhas += 1
        print(f"      {'ok' if ok else 'FALHA'}: {descricao}")

    gbnf = to_gbnf(rules, start="plano")
    print(f"[9] GBNF exportada para mascaramento de logits: {len(gbnf.splitlines())} regras")

    # ------------------------------------------------------------ Planner
    # A gramatica do Planner e outra linguagem: pares (item, conduta), sem
    # decisao, meio, valor nem justificativa. O que ela garante por construcao
    # e vocabulario e estrutura; a semantica do par fica para o validador.
    regras_p = gramatica_do_planner(
        ["Noradrenalina", "Propofol", "Vasopressina"], ["Titular_Vasopressor", "Manter_Bloqueio"], 3
    )
    parser_p = build_parser(regras_p, start=INICIO_PLANNER)

    def _aceita_p(programa):
        try:
            parser_p.parse(programa)
            return True
        except Exception:
            return False

    valido_p = (
        "PLANO 1 | Noradrenalina | Titular_Vasopressor | [ ] "
        "2 | Propofol | Manter_Bloqueio | [ 1 ] FIM"
    )
    casos_planner = [
        ("aceita a sequencia de pares", _aceita_p(valido_p)),
        ("aceita o mesmo texto com quebras de linha", _aceita_p(valido_p.replace(" 2 |", "\n2 |").replace(" FIM", "\nFIM"))),
        ("aceita varias dependencias anteriores",
         _aceita_p("PLANO 1 | Noradrenalina | Titular_Vasopressor | [ ] 2 | Propofol | Manter_Bloqueio | [ 1 ] "
                   "3 | Vasopressina | Titular_Vasopressor | [ 1 , 2 ] FIM")),
        ("recusa item inexistente", not _aceita_p(valido_p.replace("Propofol", "Dopamina"))),
        ("recusa conduta inexistente", not _aceita_p(valido_p.replace("Manter_Bloqueio", "Turbinar_Droga"))),
        ("recusa dependencia futura", not _aceita_p(valido_p.replace("Titular_Vasopressor | [ ]", "Titular_Vasopressor | [ 2 ]"))),
        ("recusa dependencia de si mesmo", not _aceita_p(valido_p.replace("[ 1 ]", "[ 2 ]"))),
        ("recusa posicao fora de ordem", not _aceita_p(valido_p.replace(" 2 |", " 3 |"))),
        ("recusa plano vazio", not _aceita_p("PLANO FIM")),
        ("recusa mais posicoes que o teto",
         not _aceita_p("PLANO " + " ".join(f"{k} | Propofol | Manter_Bloqueio | [ ]" for k in range(1, 5)) + " FIM")),
        ("recusa campo de acao", not _aceita_p(valido_p.replace("[ 1 ] FIM", "[ 1 ] | AUMENTAR_VAZAO FIM"))),
        ("recusa justificativa", not _aceita_p(valido_p.replace("[ 1 ] FIM", "[ 1 ] 'porque a PAM caiu' FIM"))),
        ("recusa texto livre", not _aceita_p("Aqui esta o plano: 1. subir a noradrenalina")),
        ("nenhuma regra da clausula entra", not any(n in regras_p for n in ("ordem", "decisao", "via", "quantidade"))),
        ("sem candidatos, sem gramatica", gramatica_do_planner([], ["Manter_Bloqueio"], 3) == {}
         and gramatica_do_planner(["Propofol"], [], 3) == {}),
    ]
    # Restricao progressiva: o item cujo par foi reprovado fica amarrado as
    # condutas que realiza; os demais continuam livres.
    regras_r = gramatica_do_planner(
        ["Noradrenalina", "Propofol", "Vasopressina"], ["Titular_Vasopressor", "Manter_Bloqueio"], 3,
        {"Propofol": ["Manter_Bloqueio"]},
    )
    parser_r = build_parser(regras_r, start=INICIO_PLANNER)

    def _aceita_r(programa):
        try:
            parser_r.parse(programa)
            return True
        except Exception:
            return False

    casos_planner += [
        ("restricao: o par reprovado deixa de ser exprimivel",
         not _aceita_r("PLANO 1 | Propofol | Titular_Vasopressor | [ ] FIM")),
        ("restricao: o item segue com as condutas que realiza",
         _aceita_r("PLANO 1 | Propofol | Manter_Bloqueio | [ ] FIM")),
        ("restricao: item sem erro continua livre",
         _aceita_r("PLANO 1 | Noradrenalina | Titular_Vasopressor | [ ] 2 | Noradrenalina | Manter_Bloqueio | [ ] FIM")),
    ]
    parser_v = build_parser(
        gramatica_do_planner(["Propofol", "Vasopressina"], ["Manter_Bloqueio"], 2, {"Propofol": []}),
        start=INICIO_PLANNER,
    )

    def _aceita_v(programa):
        try:
            parser_v.parse(programa)
            return True
        except Exception:
            return False

    casos_planner.append((
        "restricao vazia tira o item da gramatica",
        _aceita_v("PLANO 1 | Vasopressina | Manter_Bloqueio | [ ] FIM")
        and not _aceita_v("PLANO 1 | Propofol | Manter_Bloqueio | [ ] FIM"),
    ))

    gbnf_p = to_gbnf(regras_p, start=INICIO_PLANNER)
    casos_planner.append(("GBNF do Planner exportavel", gbnf_p.startswith("root ::= plano-pi")))
    try:
        from llama_cpp import LlamaGrammar  # opcional: so confere se a GBNF compila no llama.cpp
    except ImportError:
        LlamaGrammar = None
    if LlamaGrammar is not None:
        try:
            LlamaGrammar.from_string(gbnf_p, verbose=False)
            LlamaGrammar.from_string(to_gbnf(regras_r, start=INICIO_PLANNER), verbose=False)
            compila = True
        except Exception:
            compila = False
        casos_planner.append(("GBNF do Planner (com e sem restricao) compila no parser do llama.cpp", compila))

    print("[10] Gramatica do Planner (pares item-conduta, sem acao):")
    for descricao, ok in casos_planner:
        if not ok:
            falhas += 1
        print(f"      {'ok' if ok else 'FALHA'}: {descricao}")

    # ------------------------------------------------------------ PI Agent
    # A gramatica do PI e a clausula especializada de UM item, com ordem e
    # conduta fixadas no cabecalho. O payload e o de um PI: uma politica, ja
    # restrita as decisoes da conduta (aqui, Titular_Vasopressor -> AUMENTAR_VAZAO).
    payload_pi = {
        "papeis": subgrafo_especializado["papeis"],
        "constantes": subgrafo_especializado["constantes"],
        "acoes_permitidas": ["AUMENTAR_VAZAO"],
        "farmacos_liberados": ["Noradrenalina"],
        "vias_disponiveis": ["ACESSO_CENTRAL"],
        "politicas": [{
            "item": "Noradrenalina",
            "decisoes": ["AUMENTAR_VAZAO"],
            "meios": ["ACESSO_CENTRAL"],
            "unidades": ["mcg/kg/min"],
            "valores": [],
            "valoresPorDecisao": {
                "AUMENTAR_VAZAO": [{"valor": "0.05", "unidade": "mcg/kg/min"}, {"valor": "0.1", "unidade": "mcg/kg/min"}]
            },
            "bloqueado": False,
            "motivos": [],
        }],
    }
    regras_pi = gramatica_do_pi(payload_pi, rules, 2, "Titular_Vasopressor")
    parser_pi = build_parser(regras_pi, start=INICIO_PI)

    def _aceita_pi(programa):
        try:
            parser_pi.parse(programa)
            return True
        except Exception:
            return False

    valido_pi = (
        "PI 2 | Titular_Vasopressor | ordem Noradrenalina decisao AUMENTAR_VAZAO dose 0.05 mcg/kg/min "
        "via ACESSO_CENTRAL justificativa 'PAM 52 abaixo de 65 no Choque_Septico' FIM"
    )
    casos_pi = [
        ("aceita a clausula do PI", _aceita_pi(valido_pi)),
        ("aceita outro valor admissivel da decisao", _aceita_pi(valido_pi.replace("dose 0.05", "dose 0.1"))),
        ("recusa outra ordem", not _aceita_pi(valido_pi.replace("PI 2 |", "PI 1 |"))),
        ("recusa outra conduta", not _aceita_pi(valido_pi.replace("| Titular_Vasopressor |", "| Manter_Bloqueio |"))),
        ("recusa outro item", not _aceita_pi(valido_pi.replace("ordem Noradrenalina", "ordem Vasopressina"))),
        ("recusa decisao fora da conduta", not _aceita_pi(valido_pi.replace("AUMENTAR_VAZAO", "MANTER_BLOQUEADO"))),
        ("recusa valor fora do reticulo da decisao", not _aceita_pi(valido_pi.replace("dose 0.05", "dose 0.4"))),
        ("recusa meio fora do item", not _aceita_pi(valido_pi.replace("via ACESSO_CENTRAL", "via ACESSO_PERIFERICO"))),
        ("recusa duas acoes", not _aceita_pi(valido_pi.replace(" FIM", " ordem Noradrenalina decisao AUMENTAR_VAZAO dose 0.1 mcg/kg/min via ACESSO_CENTRAL justificativa 'x' FIM"))),
        ("recusa segundo PI", not _aceita_pi(valido_pi + " " + valido_pi)),
        ("recusa texto livre", not _aceita_pi("Aqui esta a acao: subir a noradrenalina")),
        ("recusa sem FIM", not _aceita_pi(valido_pi[: -len(" FIM")])),
        ("nenhuma regra do artefato entra (sem prefixo, sem cabecalho de plano)",
         not any(n in regras_pi for n in ("plano", "sequencia", "conduta", "alerta"))),
        ("payload sem politica unica, sem gramatica",
         gramatica_do_pi({**payload_pi, "politicas": []}, rules, 1, "Titular_Vasopressor") == {}
         and gramatica_do_pi({**payload_pi, "politicas": subgrafo_especializado["politicas"]}, rules, 1, "Titular_Vasopressor") == {}),
    ]
    gbnf_pi = to_gbnf(regras_pi, start=INICIO_PI)
    casos_pi.append(("GBNF do PI exportavel", gbnf_pi.startswith("root ::= resultado-pi")))
    if LlamaGrammar is not None:
        try:
            LlamaGrammar.from_string(gbnf_pi, verbose=False)
            compila_pi = True
        except Exception:
            compila_pi = False
        casos_pi.append(("GBNF do PI compila no parser do llama.cpp", compila_pi))

    print("[11] Gramatica do PI Agent (uma clausula, ordem e conduta fixas):")
    for descricao, ok in casos_pi:
        if not ok:
            falhas += 1
        print(f"      {'ok' if ok else 'FALHA'}: {descricao}")

    print("\nRESULTADO:", "OK" if falhas == 0 else f"{falhas} falha(s)")
    return 0 if falhas == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
