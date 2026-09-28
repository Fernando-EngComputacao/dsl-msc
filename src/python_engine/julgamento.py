"""
Juiz LLM de planos ja gerados (avaliacao em lote, POST /api/avaliar no web-chat).

Fica fora de main.py de proposito: formato, prompt e leitura da resposta sao
puros (sem modelo, sem GPU) e test_grammar.py os confere sem importar o
servico. main.py so decodifica sob JULGAMENTO_GBNF e chama `ler_julgamento`.

O JUIZ E INDEPENDENTE DO ORACULO. A validade objetiva do plano dentro do
SPC-CML e do oraculo deterministico (/verify + validarPlanoGlobal, no lado
TypeScript: src/inference/avaliar-grafo.ts). O juiz nao recebe o veredito do
oraculo, nao e forcado a concordar com ele, e a sua resposta nunca o
sobrescreve: a discordancia entre os dois e registrada, e e ela que se mede.

TRES VEREDITOS, como os validadores (knowledge/validacao.ts): VALID, INVALID e
UNRESOLVED. O formato antigo (CORRETO/INCORRETO) so tinha dois — o juiz sem
informacao para concluir era obrigado a escolher um lado, e o prompt nao o
impedia de inventar regra nem de exigir uma decisao que a politica nao admite.
Foi o que a auditoria viu no caso A1: plano aceito por /verify e por
validarPlanoGlobal, reprovado pelo juiz mesmo com o contexto completo.

A RESPOSTA NAO E CORRIGIDA. Saida fora do formato (ou cortada antes do
veredito) levanta `JulgamentoIlegivel`: nao ha julgamento, e nenhum e
inventado — nem VALID, nem INVALID.
"""
from __future__ import annotations

VEREDITOS = ("VALID", "INVALID", "UNRESOLVED")

# Teto por linha livre. Com os dois tetos, a resposta inteira cabe no orcamento
# de tokens do juiz (JULGAMENTO_PLANO_MAX_TOKENS em main.py) e o veredito, que
# vem por ultimo, nao e cortado.
MAX_CHARS_LINHA = 400

# Evidencias e justificativa ANTES do veredito: o modelo escreve o que viu no
# contexto e so entao conclui, em vez de justificar uma conclusao ja emitida.
JULGAMENTO_GBNF = rf"""
root ::= "evidencias: " linha "\njustificativa: " linha "\nveredito: " veredito
veredito ::= "VALID" | "INVALID" | "UNRESOLVED"
linha ::= [^\n]{{1,{MAX_CHARS_LINHA}}}
"""

JULGAMENTO_INSTRUCAO = """Voce e um avaliador independente de planos gerados por outro sistema.

Avalie se o PLANO e semanticamente compativel com:
1. o CENARIO;
2. o PEDIDO;
3. a POLITICA;
4. as REGRAS;
5. a TELEMETRIA;
6. as EVIDENCIAS fornecidas.

O CENARIO, as REGRAS e a POLITICA estao no bloco [CONHECIMENTO RECUPERADO]; a
lista [POLITICA VIGENTE] dele e a autoridade sobre as decisoes admissiveis.

Criterios:
- Nao exija igualdade textual com um plano de referencia: planos diferentes podem ser igualmente corretos.
- Nao considere uma justificativa diferente como erro se ela continuar sustentada pelas evidencias fornecidas.
- Nao invente regras, restricoes, valores nem telemetria que nao estejam no contexto abaixo.
- Nao exija uma decisao que a POLITICA nao admite.
- Nao reprove so porque voce trataria o caso de outro modo.
- Nao use conhecimento externo como autoridade contra o contexto fornecido.
- Nao transforme conhecimento ausente em reprovacao.
- Se houver informacao insuficiente para concluir, responda UNRESOLVED.
- Se houver uma violacao concreta e demonstravel a partir do contexto, responda INVALID e cite-a.
- Caso contrario, responda VALID.

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

Responda exatamente neste formato, sem mais nada:
evidencias: <fatos concretos do contexto acima que sustentam o veredito, separados por ;>
justificativa: <por que o plano e compativel, qual violacao concreta ele comete, ou o que falta para concluir>
veredito: <VALID, INVALID ou UNRESOLVED>

resposta:
"""


class JulgamentoIlegivel(ValueError):
    """A saida do juiz nao tem o formato de JULGAMENTO_GBNF: nao e um veredito."""


def montar_prompt_julgamento(
    plano: str, pedido: str, telemetria: str, conhecimento: str, evidencias: str
) -> str:
    vazio = "(nao informado)"
    return JULGAMENTO_INSTRUCAO.format(
        pedido=pedido.strip() or vazio,
        telemetria=telemetria.strip() or vazio,
        conhecimento=conhecimento.strip() or vazio,
        evidencias=evidencias.strip() or vazio,
        plano=plano.strip() or "(plano vazio)",
    )


def ler_julgamento(texto: str) -> dict:
    """
    Le a resposta do juiz. Devolve veredito, justificativa, evidencias (lista) e
    a resposta bruta. Levanta `JulgamentoIlegivel` se faltar qualquer campo ou o
    veredito nao for um dos tres — sem valor padrao.
    """
    campos: dict[str, str] = {}
    for linha in texto.strip().splitlines():
        chave, separador, valor = linha.partition(":")
        chave = chave.strip()
        if separador and chave in ("evidencias", "justificativa", "veredito") and chave not in campos:
            campos[chave] = valor.strip()

    faltando = [c for c in ("evidencias", "justificativa", "veredito") if not campos.get(c)]
    if faltando:
        raise JulgamentoIlegivel(f"resposta do juiz sem {', '.join(faltando)}: {texto!r}")
    if campos["veredito"] not in VEREDITOS:
        raise JulgamentoIlegivel(f"veredito do juiz fora de {VEREDITOS}: {campos['veredito']!r}")

    return {
        "veredito": campos["veredito"],
        "justificativa": campos["justificativa"],
        "evidencias": [e.strip() for e in campos["evidencias"].split(";") if e.strip()],
        "resposta_bruta": texto,
    }
