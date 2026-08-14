// =========================================================================
// Modelo escrito pelo especialista do dominio (agronomo).
// Esquema de Controle -> povoa o Grafo de Conhecimento (Neo4j).
// Esquema de Dados    -> delimita as saidas permitidas ao LLM.
// =========================================================================

cultura Soja {
    herbicida Glifosato - "1.5-2.0 L/ha" - "pos-emergencia"
    fungicida Mancozebe - "1.5 kg/ha" - "preventivo ferrugem"
    inseticida Acefato - "0.6 kg/ha" - "lagartas"

    regra: nao_misturar Glifosato + "Mancozebe" ("precipitacao quimica")
    regra: nao_misturar Acefato + "Nicosulfuron" ("fitotoxicidade")
    regra_clima: "06h-09h ou 17h-19h (T < 30C, vento < 10 km/h)"
    regra_varredura: "Indice NDVI" < 0.4 -> "alerta pragas"
    informar: "Area afetada (ha), produto aplicado, hora, sensor NDVI"
}

cultura Milho {
    herbicida Atrazina - "1.5-3.0 L/ha" - "pre e pos-emergencia"
    fungicida Trifloxistrobina - "0.4 L/ha" - "cercosporiose"
    inseticida Clorpirifos - "0.5 L/ha" - "cigarrinha-do-milho"

    regra: nao_misturar Atrazina + "Clorpirifos"
    regra: proibido "Atrazina em area < 500m de manancial hidrico"
    regra_clima: "somente manha (06h-10h), umidade > 55%"
    regra_varredura: "Sensor umidade foliar" < 60.0 -> "risco cigarrinha"
    informar: "Talhao, estadio fenologico, nivel de infestacao, vento"
}

cultura Cana_de_Acucar {
    herbicida Dois_Quatro_D - "1.0-2.0 L/ha" - "pos-emergencia"
    fungicida Azoxistrobina - "0.2 L/ha" - "ferrugem laranja"
    inseticida Imidacloprido - "0.5 L/ha" - "broca-da-cana"

    regra: nao_misturar Dois_Quatro_D + "Atrazina"
    regra: proibido "perto de culturas sensiveis (uva, maca, oliveira)"
    regra_clima: "Vento < 10 km/h; T < 32C; umidade > 55%"
    regra_varredura: "Sensor temperatura foliar" > 38.0 -> "estresse hidrico"
    informar: "Coordenada GPS, produto, vazao (L/ha), condicao climatica"
}

regra_global: "Limpar tanque do drone entre culturas diferentes"
regra_global: "Nunca aplicar simultaneamente em talhoes adjacentes com ventos > 8 km/h"
regra_global: "Percurso talhao ao contorno subgraficos com sensor NDVI primeiro"

// ------------------------------------------------------------------
// Esquema de Dados: universo fechado de acoes que o LLM pode emitir.
// ------------------------------------------------------------------
esquema_dados DroneAgricola01 {
    estados_permitidos [ AVANCAR, PARAR, RETORNAR_BASE, MUDAR_TALHAO, MUDAR_SENTIDO ]
    acoes_atuador [ BOMBA_LIGAR, BOMBA_DESLIGAR, BATER_VENENO, AJUSTAR_VAZAO ]

    acao Pulverizar_Faixa {
        movimento AVANCAR
        atuador BOMBA_LIGAR
        parametro "vazao nominal do produto autorizado"
    }

    acao Encerrar_Aplicacao {
        movimento PARAR
        atuador BOMBA_DESLIGAR
    }

    acao Higienizar_Tanque {
        movimento MUDAR_TALHAO
        atuador AJUSTAR_VAZAO
        parametro "limpeza obrigatoria entre culturas distintas"
    }

    acao Abortar_Missao {
        movimento RETORNAR_BASE
        atuador BOMBA_DESLIGAR
        parametro "violacao de invariante do dominio"
    }
}

// ------------------------------------------------------------------
// Missao de referencia (exemplar few-shot do grammar prompting).
// ------------------------------------------------------------------
comando executar Missao_Referencia para Soja, Milho, Cana_de_Acucar {
    esquema_referencia DroneAgricola01
    sequencia_atuacao [ Pulverizar_Faixa, Encerrar_Aplicacao ]
}
