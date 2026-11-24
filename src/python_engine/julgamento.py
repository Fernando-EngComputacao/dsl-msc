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

A TELEMETRIA E A BASE DA VERDADE. O cenario e de experimento: os valores da
telemetria foram medidos nele, e e contra eles que as regras e a politica
recuperadas do grafo se avaliam. O prompt proibe confrontar o cenario com o
mundo real atual (data, lugar, preco, faixa tipica de sensor, pratica usual) e
proibe duvidar de um valor por parecer improvavel — conhecimento de fora nao
vale nem para confirmar nem para contestar. Vale igual para o juiz de fronteira,
que le o MESMO prompt (src/inference/juiz-fronteira.ts): e ele quem tem mais
mundo real para opor ao cenario.

AS REGRAS SAO FECHADAS. O conhecimento recuperado do grafo do especialista e o
universo normativo INTEIRO do julgamento: norma, protocolo, limite ou boa pratica
que nao esteja la nao entra — nem para reprovar, nem para aprovar. As regras
recuperadas valem como dadas (o juiz nao as discute, nao as corrige nem as
completa), toda evidencia citada tem de estar no contexto enviado, e sem a regra
que decidiria o caso a resposta e UNRESOLVED, nao um veredito tirado de fora. E
isso que mantem ruido externo fora da medida do modelo do especialista — e e por
isso que a regra esta no prompt, que o juiz de fronteira copia inteiro.

O PEDIDO NAO E ORDEM. Nem todo pedido e atendivel: a politica vigente pode nao
admitir a decisao pedida para o item (ou nao admitir nenhuma), e ai o plano que
NAO atende o usuario e o plano certo. O prompt poe isso nos mesmos tres casos do
oraculo (knowledge/validacao-global.ts, `conferirDecisaoDoPedido`): politica nao
admite a decisao pedida -> `pedido_nao_atendivel`, que e AVISO e nao reprova;
politica admite e o plano escolheu outra -> `pedido_global_incompativel`, que e
erro; pedido que nao cita item nenhum do conhecimento ->
`pedido_global_indeterminado`, UNRESOLVED. Sem isso o juiz cobra o atendimento do
pedido, e a discordancia medida seria do prompt e nao do modelo — e o modelo de
fronteira, treinado para atender quem pede, e o mais inclinado a cobrar.

A RESPOSTA NAO E CORRIGIDA. Saida fora do formato (ou cortada antes do
veredito) levanta `JulgamentoIlegivel`: nao ha julgamento, e nenhum e
inventado — nem VALID, nem INVALID.
"""
from __future__ import annotations

import os

VEREDITOS = ("VALID", "INVALID", "UNRESOLVED")

# Teto por linha livre. Com os dois tetos, a resposta inteira cabe no orcamento
# de tokens do juiz (JULGAMENTO_PLANO_MAX_TOKENS em main.py) e o veredito, que
# vem por ultimo, nao e cortado.
# Este teto e o unico controle sobre o TAMANHO da resposta, que e o que custa
# tempo: a mediana medida e ~670 caracteres por julgamento, quase todos nas duas
# linhas livres (~190 tokens). Com o modelo na GPU sao ~4 s por plano; na CPU,
# ~60 s. Baixar para 220 corta perto de um terco do tempo e deixa justificativa e
# evidencias mais curtas — nenhum campo some, o veredito continua por ultimo e o
# formato nao muda. O padrao segue 400: encurtar a resposta encurta o DADO
# gravado, e essa troca e de quem roda o experimento, nao do codigo.
MAX_CHARS_LINHA = int(os.environ.get("SPC_CML_JULGAMENTO_MAX_CHARS_LINHA", "400"))

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

A TELEMETRIA E A BASE DA VERDADE. Os dados vem de um cenario de experimento, nao
do mundo real: os valores da [TELEMETRIA] foram medidos no cenario, e e sobre
eles que as REGRAS e a POLITICA do [CONHECIMENTO RECUPERADO] se avaliam. A
[TELEMETRIA] e a autoridade sobre o estado do cenario, como a [POLITICA VIGENTE]
e sobre as decisoes admissiveis. Nao confronte o cenario com o mundo real atual:
data, lugar, nome, preco, faixa tipica de sensor, estatistica e pratica usual que
voce conheca de fora nao valem aqui, nem para confirmar nem para contestar.

AS REGRAS SAO FECHADAS. O [CONHECIMENTO RECUPERADO] e o universo normativo
INTEIRO deste julgamento: ele foi recuperado do grafo do especialista para este
cenario, e o que nao esta nele nao existe aqui. As regras e a politica de la
valem como dadas; nao as discuta, nao as corrija nem as complete, e julgue o
PLANO por elas. Nenhuma norma, protocolo, diretriz, limite ou boa pratica que
voce conheca de fora entra no julgamento, nem para reprovar o plano nem para
aprova-lo. Toda evidencia que voce citar tem de estar na [TELEMETRIA], no
[CONHECIMENTO RECUPERADO], nas [EVIDENCIAS], no [PEDIDO] ou no [PLANO].

O PEDIDO E INTENCAO, NAO OBRIGACAO. Nem todo pedido pode ser atendido: a
[POLITICA VIGENTE] pode marcar o item [RESTRITO], nao admitir a decisao que o
pedido nomeia, ou nao admitir decisao nenhuma para ele. Quando e assim, o plano
que NAO faz o que foi pedido e o plano certo: nao reprove por isso, e cite a
restricao como evidencia. Atender o pedido tambem nao justifica nada: plano que
faz o que foi pedido contra uma regra do [CONHECIMENTO RECUPERADO] e INVALID.
Reprove por causa do pedido so quando a [POLITICA VIGENTE] admite para o item a
decisao que o pedido nomeia e o plano escolheu outra. E se o pedido nao cita item
nenhum do [CONHECIMENTO RECUPERADO], nao ha como concluir que foi atendido:
responda UNRESOLVED.

Criterios:
- Nao exija igualdade textual com um plano de referencia: planos diferentes podem ser igualmente corretos.
- Nao considere uma justificativa diferente como erro se ela continuar sustentada pelas evidencias fornecidas.
- Nao invente regras, restricoes, valores nem telemetria que nao estejam no contexto abaixo.
- Nao duvide de um valor da TELEMETRIA por parecer improvavel, extremo, fora de faixa tipica ou incompativel com o mundo real: ele foi medido no cenario e vale como esta.
- Nao corrija, arredonde, converta unidade nem reinterprete um valor da TELEMETRIA.
- Nao traga norma, diretriz, protocolo, limite nem boa pratica de fora: o que nao esta no [CONHECIMENTO RECUPERADO] nao existe para este julgamento.
- Nao exija uma decisao que a POLITICA nao admite.
- Nao reprove o plano por nao fazer o que o pedido pede quando a POLITICA VIGENTE nao admite a decisao pedida: ai nao atender e o correto.
- Nao reprove so porque voce trataria o caso de outro modo.
- Nao use conhecimento externo como autoridade, nem contra nem a favor do contexto fornecido.
- Nao transforme conhecimento ausente em reprovacao.
- Se a regra que decidiria o caso nao esta no [CONHECIMENTO RECUPERADO], ou se houver informacao insuficiente para concluir, responda UNRESOLVED e diga o que faltou.
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
