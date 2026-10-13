"""
Diagnostico da indeterminacao do juiz LLM (avaliacao em lote, POST /api/avaliar
no web-chat). So e chamado quando o juiz (julgamento.py) respondeu UNRESOLVED.

Fica fora de main.py pelo mesmo motivo de julgamento.py: prompt e gramatica sao
puros (sem modelo, sem GPU) e test_grammar.py os confere sem importar o servico.

O DIAGNOSTICO NAO E VEREDITO. Ele explica por que o juiz nao concluiu, o que
falta e sob que condicoes o plano poderia sustentar VALID ou INVALID — sem mudar
o veredito do juiz, que continua UNRESOLVED, e sem ver o oraculo.

AS REFERENCIAS SAO FECHADAS PELA GRAMATICA. O lado TypeScript
(src/inference/diagnostico-juiz.ts) monta, da mesma recuperacao que o juiz leu,
um catalogo de regras e campos; a GBNF de `gramatica_do_diagnostico` so deixa o
modelo escrever, nos lugares de referencia, um identificador desse catalogo — a
mesma garantia estrutural do resto da arquitetura, agora sobre a explicacao. O
texto livre (motivo, condicoes, descricoes) continua livre, e o lado TypeScript
confere de novo cada referencia antes de aceitar o diagnostico.

A RESPOSTA NAO E INTERPRETADA AQUI. O motor devolve a saida bruta; a leitura do
JSON e a conferencia sao do lado TypeScript, que tem o catalogo.
"""
from __future__ import annotations

import json

# Tetos que mantem a resposta inteira dentro do orcamento de tokens do diagnostico
# (DIAGNOSTICO_MAX_TOKENS em main.py): com eles o JSON fecha antes do corte.
MAX_CHARS_TEXTO = 200
MAX_ITENS = 3
MAX_LIMITACOES = 2

DIAGNOSTICO_INSTRUCAO = """Voce explica por que uma avaliacao de plano terminou INDETERMINADA (UNRESOLVED).

Um avaliador independente leu o contexto abaixo e respondeu UNRESOLVED. Sua tarefa
NAO e julgar o plano de novo nem mudar esse resultado: e explicar, so com o que o
contexto e o CATALOGO trazem, o que impediu a conclusao e o que precisaria ser
esclarecido.

Regras:
- Cite regras e campos SOMENTE pelos identificadores do [CATALOGO DE FUNDAMENTACAO].
- Nao invente campos, variaveis, regras, limites numericos, predicados nem valores de telemetria.
- Nao preencha telemetria ausente nem presuma o que nao foi observado.
- Formalizacao das regras do catalogo: "formal" = condicao estruturada sobre a telemetria;
  "parcial" = ligacao estruturada (item, par, contexto) sem medida que a decida;
  "texto" = so descricao em texto livre, que nao se avalia formalmente.
- Regra em "texto" nao vira regra deterministica: diga que ela nao esta formalizada.
- Tipos de informacao ausente:
    campo_sem_valor        campo do catalogo marcado SEM VALOR, lido pela regra citada;
    evidencia_insuficiente campo com valor ou regra que existe, mas nao basta para concluir;
    fato_nao_observado     fato que nenhum campo do catalogo registra, exigido pela regra citada;
    regra_nao_formalizada  a regra que decidiria so existe em texto (referencia = o id dela).
- Caminhos possiveis sao CONDICIONAIS, nao vereditos: VALID ou INVALID so quando uma regra do
  catalogo sustenta o caminho; UNRESOLVED quando, mesmo com o que falta, o conhecimento pode nao bastar.
  Nao presuma que o caso alcanca os dois resultados, nem que informacao nova garante a resolucao.
- Evidencia de pedido, plano ou julgamento: a referencia e um trecho copiado literalmente dele.
- Se o contexto nao permite fundamentar uma recomendacao, diga isso em limitacoes.

[PEDIDO]
{pedido}

[TELEMETRIA]
{telemetria}

[CONHECIMENTO RECUPERADO]
{conhecimento}

[EVIDENCIAS]
{evidencias}

[PLANO]
{plano}

[JULGAMENTO ORIGINAL: UNRESOLVED]
justificativa: {justificativa}
evidencias: {evidencias_juiz}

[CATALOGO DE FUNDAMENTACAO]
{catalogo}

Responda somente com um objeto JSON, nesta ordem de campos:
evidenciasDisponiveis  dados existentes que ajudam a avaliar o caso (fonte, referencia, descricao)
regrasAfetadas         regras do catalogo envolvidas na indeterminacao (regra, motivo)
informacoesAusentes    o que falta esclarecer (tipo, referencia, regra que o exige, descricao)
motivo                 por que o avaliador nao conseguiu concluir
caminhosPossiveis      sob que condicoes o plano sustentaria cada resultado (resultado, condicoes, regras)
incertezaRemanescente  o que continua sem solucao mesmo com o que falta
limitacoes             limitacoes do conhecimento ou da formalizacao

resposta:
"""


def montar_prompt_diagnostico(
    plano: str,
    pedido: str,
    telemetria: str,
    conhecimento: str,
    evidencias: str,
    justificativa_juiz: str,
    evidencias_juiz: list[str],
    catalogo: str,
) -> str:
    vazio = "(nao informado)"
    return DIAGNOSTICO_INSTRUCAO.format(
        pedido=pedido.strip() or vazio,
        telemetria=telemetria.strip() or vazio,
        conhecimento=conhecimento.strip() or vazio,
        evidencias=evidencias.strip() or vazio,
        plano=plano.strip() or "(plano vazio)",
        justificativa=justificativa_juiz.strip() or vazio,
        evidencias_juiz="; ".join(e.strip() for e in evidencias_juiz if e.strip()) or vazio,
        catalogo=catalogo.strip() or vazio,
    )


def _literal(valor: str) -> str:
    """O valor como string JSON (com as aspas), escrito como literal GBNF."""
    em_json = json.dumps(valor, ensure_ascii=False)
    return '"' + em_json.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _escolha(valores: list[str]) -> str | None:
    """Alternativa GBNF entre os valores (sem repetidos, na ordem); None se nao ha nenhum."""
    unicos = list(dict.fromkeys(v for v in valores if v))
    if not unicos:
        return None
    return "(" + " | ".join(_literal(v) for v in unicos) + ")"


def _lista(elemento: str | None, maximo: int) -> str:
    """Lista JSON de ate `maximo` elementos; sem elemento possivel, so a lista vazia."""
    if elemento is None:
        return '"[]"'
    return f'"[" ({elemento} ("," {elemento}){{0,{maximo - 1}}})? "]"'


def gramatica_do_diagnostico(
    regras: list[str],
    regras_formais: list[str],
    regras_nao_formais: list[str],
    campos_com_valor: list[str],
    campos_sem_valor: list[str],
) -> str:
    """
    GBNF do diagnostico: um objeto JSON compacto, com os campos na ordem do
    prompt, em que cada referencia so pode ser um identificador do catalogo.
    Sem identificador de um tipo, a alternativa que o usaria nao existe — o
    modelo nao tem como escrever uma referencia que o catalogo nao tem.
    """
    regra = _escolha(regras)
    formal = _escolha(regras_formais)
    nao_formal = _escolha(regras_nao_formais)
    com_valor = _escolha(campos_com_valor)
    sem_valor = _escolha(campos_sem_valor)

    regras_gbnf: list[str] = []

    def definir(nome: str, corpo: str | None) -> str | None:
        if corpo is None:
            return None
        regras_gbnf.append(f"{nome} ::= {corpo}")
        return nome

    r_regra = definir("regra", regra)
    r_formal = definir("regra-formal", formal)
    r_nao_formal = definir("regra-nao-formal", nao_formal)
    r_com_valor = definir("campo-com-valor", com_valor)
    r_sem_valor = definir("campo-sem-valor", sem_valor)

    evidencias = []
    if r_com_valor:
        evidencias.append(r'"{\"fonte\":\"telemetria\",\"referencia\":" ' + r_com_valor + r' ",\"descricao\":" texto "}"')
    if r_regra:
        evidencias.append(r'"{\"fonte\":\"regra\",\"referencia\":" ' + r_regra + r' ",\"descricao\":" texto "}"')
    evidencias.append(r'"{\"fonte\":" ("\"pedido\"" | "\"plano\"" | "\"julgamento\"") ",\"referencia\":" texto ",\"descricao\":" texto "}"')
    definir("evidencia", " | ".join(evidencias))

    r_afetada = definir("regra-afetada", None if not r_regra else r'"{\"regra\":" ' + r_regra + r' ",\"motivo\":" texto "}"')

    informacoes = []
    if r_sem_valor and r_formal:
        informacoes.append(r'"{\"tipo\":\"campo_sem_valor\",\"referencia\":" ' + r_sem_valor + r' ",\"regra\":" ' + r_formal + r' ",\"descricao\":" texto "}"')
    if r_regra:
        insuficiente = " | ".join(x for x in (r_com_valor, r_regra) if x)
        informacoes.append(r'"{\"tipo\":\"evidencia_insuficiente\",\"referencia\":" (' + insuficiente + r') ",\"regra\":" ' + r_regra + r' ",\"descricao\":" texto "}"')
        informacoes.append(r'"{\"tipo\":\"fato_nao_observado\",\"referencia\":" texto ",\"regra\":" ' + r_regra + r' ",\"descricao\":" texto "}"')
    if r_nao_formal:
        informacoes.append(r'"{\"tipo\":\"regra_nao_formalizada\",\"referencia\":" ' + r_nao_formal + r' ",\"regra\":" ' + r_nao_formal + r' ",\"descricao\":" texto "}"')
    r_informacao = definir("informacao", " | ".join(informacoes) if informacoes else None)

    definir(
        "caminho",
        r'"{\"resultado\":" ("\"VALID\"" | "\"INVALID\"" | "\"UNRESOLVED\"") ",\"condicoes\":" texto ",\"regras\":" '
        + _lista(r_regra, MAX_ITENS)
        + r' "}"',
    )

    raiz = (
        r'root ::= "{\"evidenciasDisponiveis\":" ' + _lista("evidencia", MAX_ITENS)
        + r' ",\"regrasAfetadas\":" ' + _lista(r_afetada, MAX_ITENS)
        + r' ",\"informacoesAusentes\":" ' + _lista(r_informacao, MAX_ITENS)
        + r' ",\"motivo\":" texto'
        + r' ",\"caminhosPossiveis\":" ' + _lista("caminho", MAX_ITENS)
        + r' ",\"incertezaRemanescente\":" texto'
        + r' ",\"limitacoes\":" ' + _lista("texto", MAX_LIMITACOES)
        + r' "}"'
    )
    # Texto livre sem aspas, barra invertida nem controle: JSON valido sem escape.
    texto = r'texto ::= "\"" [^"\\\x00-\x1F]{1,' + str(MAX_CHARS_TEXTO) + r'} "\""'
    return "\n".join([raiz, texto, *regras_gbnf]) + "\n"
