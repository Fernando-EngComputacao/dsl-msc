#!/usr/bin/env python3
"""
Suite de avaliacao do dominio clinico: 400 cenarios de entrada para o SPC-CML.

Gemeo de src/scripts/gerar-cenarios-400-fut.ts e gerar-cenarios-400-agro.ts, em
Python porque o gerador roda sem Node e sem dependencias (so a stdlib) — o mesmo
python3 que o src/python_engine ja exige.

    200 antigos  src/examples/med/cenarios-200-med.jsonl, copiados byte a byte
                 (PT-2026-4001..4200)
    200 novos    declarados aqui em FAMILIAS CONTROLADAS (PT-2026-4201..4400)

Dentro de uma familia so muda a dimensao declarada — um parametro da telemetria,
as populacoes do cadastro, os farmacos em infusao ou a fala. O resto e identico,
e e isso que permite perguntar depois se o sistema muda a decisao exatamente
quando a regra do uti.dsl muda, e so entao.

COMPLETUDE DO PEDIDO. Nada aqui reimplementa a semantica da DSL; o que o script
garante e que todo cenario CABE no universo modelado. Antes de gravar, cada
linha das 400 passa por:

  1. esquema e faixa fisiologica dos 8 parametros da telemetria (todos
     presentes, nenhum extra: PAM, FC, lactato, RASS, TFG, plaquetas, glicemia,
     SpO2);
  2. ancoragem: a fala nomeia ao menos um farmaco, protocolo ou populacao que o
     uti.dsl declara — senao o pedido nao cabe no universo;
  3. coerencia numerica: todo numero citado na fala e um valor da telemetria
     daquela linha OU um numero que o proprio uti.dsl declara (dose, degrau,
     limite de bomba, limiar de regra, prazo de etapa, alvo de monitoracao).
     Numero inventado reprova;
  4. coerencia com o estado de curso: quem pede para INICIAR nao tem o farmaco
     em `farmacosEmUso`; quem pede para subir, reduzir, manter, suspender,
     desmamar ou ajustar tem;
  5. coerencia de via: via citada na fala pertence as `vias` daquele farmaco;
  6. coerencia com o cadastro: `Renal_Cronico` declarado exige TFG < 30 mL/min
     (o criterio da populacao); sem a populacao declarada, a fala nao afirma
     doenca renal cronica;
  7. nenhuma fala depende de `qSOFA` (a lacuna deliberada do modelo) nem decide
     por `SpO2` (medido, sem regra): os dois podem aparecer como contexto, nunca
     como unico fundamento;
  8. unicidade: nenhum `intencao` repetido, nenhum `paciente` repetido.

Uso:
    python3 src/scripts/gerar-cenarios-400-med.py

Gera:
    src/examples/med/cenarios-400-med.jsonl
"""

from __future__ import annotations

import json
import os
import re
import sys
import unicodedata

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DSL = os.path.join(RAIZ, 'src', 'examples', 'med', 'uti.dsl')
ANTIGOS = os.path.join(RAIZ, 'src', 'examples', 'med', 'cenarios-200-med.jsonl')
SAIDA = os.path.join(RAIZ, 'src', 'examples', 'med', 'cenarios-400-med.jsonl')

# =============================================================================
# 1) Fatos do modelo, lidos do uti.dsl (nada e redigitado a mao)
# =============================================================================

FONTE = re.sub(r'//[^\n]*', '', open(DSL, encoding='utf-8').read())

FARMACOS = re.findall(r'^farmaco\s+(\w+)\s*\{', FONTE, re.M)
PROTOCOLOS = re.findall(r'^protocolo\s+(\w+)\s*\{', FONTE, re.M)
POPULACOES = re.findall(r'^populacao\s+(\w+)\s*\{', FONTE, re.M)

# vias declaradas por farmaco
VIAS = {}
for m in re.finditer(r'^farmaco\s+(\w+)\s*\{(.*?)^\}', FONTE, re.M | re.S):
    vias = re.search(r'vias\s*\[([^\]]*)\]', m.group(2))
    VIAS[m.group(1)] = [v.strip() for v in vias.group(1).split(',')] if vias else []

# tetos de politica: farmaco -> (parametro, operador, limiar)
TETOS = {}
for d, p, op, v in re.findall(
        r'regra_seguranca:\s*bloquear_incremento\s+(\w+)\s+se\s+(\w+)\s*(>=|<=|==|!=|>|<)\s*(-?[\d.]+)', FONTE):
    TETOS[d] = (p, op, float(v))

# todo numero que o modelo declara (dose, degrau, limite, limiar, prazo, alvo,
# e tambem os numeros que aparecem nos textos de etapa/monitorar/regra_global)
NUMEROS_DO_MODELO = {abs(float(n)) for n in re.findall(r'-?\d+(?:\.\d+)?', FONTE)}

TELEMETRIA = ['PAM', 'FC', 'lactato', 'RASS', 'TFG', 'plaquetas', 'glicemia', 'SpO2']
FAIXAS = {'PAM': (30, 130), 'FC': (30, 190), 'lactato': (0.3, 20.0), 'RASS': (-5, 4),
          'TFG': (5, 140), 'plaquetas': (5, 600), 'glicemia': (30, 600), 'SpO2': (70, 100)}

BASE = {'PAM': 78, 'FC': 88, 'lactato': 1.4, 'RASS': -2, 'TFG': 82,
        'plaquetas': 210, 'glicemia': 132, 'SpO2': 96}


def norm(s: str) -> str:
    return ''.join(c for c in unicodedata.normalize('NFD', s.lower())
                   if unicodedata.category(c) != 'Mn')


# Como cada entidade do modelo pode ser nomeada na fala do plantonista.
APELIDOS = {
    'Noradrenalina': ['noradrenalina', 'noradre', 'nora'],
    'Adrenalina': ['adrenalina'],
    'Vasopressina': ['vasopressina'],
    'Dobutamina': ['dobutamina', 'dobuta'],
    'Propofol': ['propofol'],
    'Midazolam': ['midazolam', 'midazo'],
    'Fentanil': ['fentanil'],
    'Cisatracurio': ['cisatracurio'],
    'Vancomicina': ['vancomicina', 'vanco'],
    'Piperacilina_Tazobactam': ['piperacilina', 'pipe-tazo', 'piptazo', 'tazobactam'],
    'Heparina': ['heparina'],
    'Insulina_Regular': ['insulina'],
    'Choque_Septico': ['choque septico', 'sepse', 'bundle'],
    'Sedacao_Analgesia_VM': ['sedacao', 'analgesia', 'ventilacao mecanica', 'despertar diario'],
    'Controle_Glicemico_UTI': ['controle glicemico', 'glicemia'],
    'Gestante': ['gestante', 'gravida', 'gestacao'],
    'Renal_Cronico': ['renal cronico', 'renal cronica', 'dialise', 'terapia renal substitutiva'],
    'Idoso_Fragil': ['idoso', 'fragil', 'fragilidade'],
    'Obeso_Grave': ['obeso', 'obesidade', 'imc'],
}

# =============================================================================
# 2) As 200 familias controladas
#
# `prosa` usa marcadores {PAM}, {FC}, {lactato}, {RASS}, {TFG}, {plaquetas},
# {glicemia}: o numero da fala vem da telemetria da propria linha, nunca de uma
# constante solta — e por isso que nao existe cenario numericamente incoerente.
# `acao` e o que o pedido pede, e e o que amarra `farmacosEmUso`:
#   iniciar               alvo FORA de infusao
#   subir/reduzir/manter/suspender/ajustar/desmamar   alvo EM infusao
#   iniciar_em_curso      pede iniciar o que ja corre (caso de erro legitimo)
#   subir_fora_de_curso   pede subir o que nao corre (caso de erro legitimo)
#   duvida/exame/escalar  sem exigencia de estado
# =============================================================================

def E(familia, prosa, acao, alvo, over=None, emUso=(), pops=(), via=None, via_duvida=False):
    """`via` = via que a fala AFIRMA em uso (tem de estar nas `vias` do farmaco);
    `via_duvida` = a fala PERGUNTA por uma via (pode ser uma que o farmaco nao
    declara — e justamente o que o modelo responde)."""
    return {'familia': familia, 'prosa': prosa, 'acao': acao, 'alvo': alvo,
            'over': over or {}, 'emUso': list(emUso), 'pops': list(pops),
            'via': via, 'via_duvida': via_duvida}


NOVOS = []

# --- 1. teto do Propofol pela PAM: bloqueia incremento se PAM < 60 -----------
NOVOS += [
    E('SEG-PROPOFOL-PAM', 'RASS {RASS} e PAM {PAM} mmHg: posso subir o propofol um degrau para aprofundar a sedação?',
      'subir', 'Propofol', {'PAM': 68, 'RASS': -1}, ['Propofol']),
    E('SEG-PROPOFOL-PAM', 'Paciente com PAM {PAM} mmHg e RASS {RASS} em propofol. Aumenta a sedação.',
      'subir', 'Propofol', {'PAM': 61, 'RASS': -1}, ['Propofol']),
    E('SEG-PROPOFOL-PAM', 'PAM exatamente {PAM} mmHg com RASS {RASS}: o incremento de propofol ainda está liberado?',
      'subir', 'Propofol', {'PAM': 60, 'RASS': -1}, ['Propofol']),
    E('SEG-PROPOFOL-PAM', 'PAM caiu para {PAM} mmHg e o paciente está em RASS {RASS}. Sobe o propofol que ele está acordando.',
      'subir', 'Propofol', {'PAM': 59, 'RASS': 0}, ['Propofol']),
    E('SEG-PROPOFOL-PAM', 'Urgente: PAM {PAM} mmHg, lactato {lactato} mmol/L e RASS {RASS}. Preciso aprofundar o propofol agora.',
      'subir', 'Propofol', {'PAM': 52, 'lactato': 3.1, 'RASS': 0}, ['Propofol']),
]

# --- 2. teto da Noradrenalina pela FC: bloqueia incremento se FC > 130 -------
NOVOS += [
    E('SEG-NORA-FC', 'PAM {PAM} mmHg com FC {FC} bpm em noradrenalina: subo um degrau de 0.05 mcg/kg/min?',
      'subir', 'Noradrenalina', {'PAM': 58, 'FC': 120}, ['Noradrenalina']),
    E('SEG-NORA-FC', 'FC {FC} bpm e PAM {PAM} mmHg na noradrenalina. Titula mais um degrau.',
      'subir', 'Noradrenalina', {'PAM': 58, 'FC': 130}, ['Noradrenalina']),
    E('SEG-NORA-FC', 'FC {FC} bpm, PAM {PAM} mmHg: ainda posso aumentar a noradrenalina?',
      'subir', 'Noradrenalina', {'PAM': 58, 'FC': 131}, ['Noradrenalina']),
    E('SEG-NORA-FC', 'Paciente taquicárdico a {FC} bpm com PAM {PAM} mmHg e lactato {lactato} mmol/L. Aumenta a noradrenalina mesmo assim.',
      'subir', 'Noradrenalina', {'PAM': 56, 'FC': 138, 'lactato': 4.4}, ['Noradrenalina']),
    E('SEG-NORA-FC', 'FC {FC} bpm na noradrenalina com PAM {PAM} mmHg. Qual a conduta sobre a vazão?',
      'duvida', 'Noradrenalina', {'PAM': 62, 'FC': 150}, ['Noradrenalina']),
]

# --- 3. teto da Adrenalina pela FC ------------------------------------------
NOVOS += [
    E('SEG-ADRE-FC', 'Choque refratário com PAM {PAM} mmHg e FC {FC} bpm em adrenalina: subo a adrenalina?',
      'subir', 'Adrenalina', {'PAM': 57, 'FC': 128}, ['Adrenalina']),
    E('SEG-ADRE-FC', 'FC {FC} bpm com PAM {PAM} mmHg: o incremento da adrenalina está liberado?',
      'subir', 'Adrenalina', {'PAM': 57, 'FC': 131}, ['Adrenalina']),
    E('SEG-ADRE-FC', 'Adrenalina correndo, FC {FC} bpm e PAM {PAM} mmHg. Aumenta um degrau de 0.05 mcg/kg/min.',
      'subir', 'Adrenalina', {'PAM': 59, 'FC': 140}, ['Adrenalina']),
    E('SEG-ADRE-FC', 'FC {FC} bpm na adrenalina, PAM {PAM} mmHg e lactato {lactato} mmol/L. Mantenho ou reduzo?',
      'duvida', 'Adrenalina', {'PAM': 64, 'FC': 152, 'lactato': 5.2}, ['Adrenalina']),
]

# --- 4. teto da Dobutamina pela FC ------------------------------------------
NOVOS += [
    E('SEG-DOBU-FC', 'Dobutamina em curso com FC {FC} bpm e PAM {PAM} mmHg: posso titular para cima?',
      'subir', 'Dobutamina', {'FC': 126, 'PAM': 72}, ['Dobutamina']),
    E('SEG-DOBU-FC', 'FC {FC} bpm na dobutamina, acima do alvo de 110 bpm da monitoração. Subo mesmo assim?',
      'subir', 'Dobutamina', {'FC': 131, 'PAM': 72}, ['Dobutamina']),
    E('SEG-DOBU-FC', 'Dobutamina com FC {FC} bpm e PAM {PAM} mmHg. Aumenta 2.5 mcg/kg/min.',
      'subir', 'Dobutamina', {'FC': 135, 'PAM': 70}, ['Dobutamina']),
    E('SEG-DOBU-FC', 'FC {FC} bpm com dobutamina e PAM {PAM} mmHg: ectopia ventricular me preocupa, qual a conduta na vazão?',
      'duvida', 'Dobutamina', {'FC': 148, 'PAM': 68}, ['Dobutamina']),
]

# --- 5. teto do Midazolam pelo RASS: bloqueia incremento se RASS < -3 -------
NOVOS += [
    E('SEG-MIDA-RASS', 'Midazolam em curso com RASS {RASS} e PAM {PAM} mmHg: aprofundo mais um degrau?',
      'subir', 'Midazolam', {'RASS': -1}, ['Midazolam']),
    E('SEG-MIDA-RASS', 'RASS {RASS} no midazolam, PAM {PAM} mmHg. Sobe 0.02 mg/kg/h.',
      'subir', 'Midazolam', {'RASS': -2}, ['Midazolam']),
    E('SEG-MIDA-RASS', 'RASS exatamente {RASS} com midazolam correndo: o incremento ainda é permitido?',
      'subir', 'Midazolam', {'RASS': -3}, ['Midazolam']),
    E('SEG-MIDA-RASS', 'RASS {RASS} e o paciente ainda se mexe no respirador. Aumenta o midazolam.',
      'subir', 'Midazolam', {'RASS': -4}, ['Midazolam']),
    E('SEG-MIDA-RASS', 'RASS {RASS} em midazolam: posso subir mais para garantir que ele não desperte?',
      'subir', 'Midazolam', {'RASS': -5}, ['Midazolam']),
]

# --- 6. teto do Cisatracurio pelo RASS: bloqueia incremento se RASS > -4 ----
NOVOS += [
    E('SEG-CISA-RASS', 'Cisatracúrio em curso com RASS {RASS} confirmado: posso titular até TOF 1-2 de 4?',
      'subir', 'Cisatracurio', {'RASS': -5}, ['Cisatracurio', 'Propofol', 'Fentanil']),
    E('SEG-CISA-RASS', 'RASS {RASS} com cisatracúrio correndo. Subo 0.5 mcg/kg/min?',
      'subir', 'Cisatracurio', {'RASS': -4}, ['Cisatracurio', 'Propofol']),
    E('SEG-CISA-RASS', 'RASS {RASS} e assincronia no respirador: aumenta o cisatracúrio.',
      'subir', 'Cisatracurio', {'RASS': -3}, ['Cisatracurio', 'Propofol']),
    E('SEG-CISA-RASS', 'Cisatracúrio em curso e RASS {RASS}: está seguro aprofundar o bloqueio?',
      'subir', 'Cisatracurio', {'RASS': -2}, ['Cisatracurio', 'Propofol']),
    E('SEG-CISA-RASS', 'RASS {RASS}, paciente desperto, cisatracúrio prescrito. Sobe a vazão do bloqueador.',
      'subir', 'Cisatracurio', {'RASS': 0}, ['Cisatracurio']),
]

# --- 7. teto da Insulina pela glicemia: bloqueia incremento se glicemia < 140
NOVOS += [
    E('SEG-INSU-GLI', 'Glicemia {glicemia} mg/dL com insulina em bomba: titula mais 1 UI/h.',
      'subir', 'Insulina_Regular', {'glicemia': 210}, ['Insulina_Regular']),
    E('SEG-INSU-GLI', 'Glicemia {glicemia} mg/dL na insulina regular. Subo um degrau?',
      'subir', 'Insulina_Regular', {'glicemia': 141}, ['Insulina_Regular']),
    E('SEG-INSU-GLI', 'Glicemia exatamente {glicemia} mg/dL: o incremento da insulina continua liberado?',
      'subir', 'Insulina_Regular', {'glicemia': 140}, ['Insulina_Regular']),
    E('SEG-INSU-GLI', 'Glicemia {glicemia} mg/dL e a insulina já está correndo. Aumenta mais um pouco.',
      'subir', 'Insulina_Regular', {'glicemia': 139}, ['Insulina_Regular']),
    E('SEG-INSU-GLI', 'Glicemia {glicemia} mg/dL com insulina em infusão contínua: subo, mantenho ou reduzo?',
      'duvida', 'Insulina_Regular', {'glicemia': 118}, ['Insulina_Regular']),
]

# --- 8. teto da Heparina pelas plaquetas: bloqueia incremento se < 50 -------
NOVOS += [
    E('SEG-HEPA-PLAQ', 'Plaquetas {plaquetas} mil com heparina em bomba: subo 100 UI/h pelo TTPa?',
      'subir', 'Heparina', {'plaquetas': 90}, ['Heparina']),
    E('SEG-HEPA-PLAQ', 'Plaquetas {plaquetas} mil na heparina. Aumenta a vazão.',
      'subir', 'Heparina', {'plaquetas': 51}, ['Heparina']),
    E('SEG-HEPA-PLAQ', 'Plaquetas exatamente {plaquetas} mil: o incremento da heparina ainda passa?',
      'subir', 'Heparina', {'plaquetas': 50}, ['Heparina']),
    E('SEG-HEPA-PLAQ', 'Plaquetas {plaquetas} mil e TTPa abaixo do alvo. Sobe a heparina.',
      'subir', 'Heparina', {'plaquetas': 49}, ['Heparina']),
    E('SEG-HEPA-PLAQ', 'Plaquetas despencaram para {plaquetas} mil com heparina correndo. O que faço com a infusão?',
      'duvida', 'Heparina', {'plaquetas': 32}, ['Heparina']),
]

# --- 9. gatilho do Choque_Septico pelo lactato (> 2 mmol/L) -----------------
NOVOS += [
    E('GAT-SEPSE-LACT', 'Lactato {lactato} mmol/L com PAM {PAM} mmHg: já abro o bundle de 1 hora da sepse?',
      'duvida', 'Choque_Septico', {'lactato': 1.8}),
    E('GAT-SEPSE-LACT', 'Lactato exatamente {lactato} mmol/L e PAM {PAM} mmHg. O protocolo de choque séptico está ativado?',
      'duvida', 'Choque_Septico', {'lactato': 2.0}),
    E('GAT-SEPSE-LACT', 'Lactato {lactato} mmol/L, PAM {PAM} mmHg: inicio vancomicina na cobertura empírica do bundle?',
      'iniciar', 'Vancomicina', {'lactato': 2.1}),
    E('GAT-SEPSE-LACT', 'Suspeita de sepse com lactato {lactato} mmol/L e PAM {PAM} mmHg. Começa a vancomicina.',
      'iniciar', 'Vancomicina', {'lactato': 3.2}),
]

# --- 10. gatilho do Choque_Septico pela PAM (< 65 mmHg) ---------------------
NOVOS += [
    E('GAT-SEPSE-PAM', 'PAM {PAM} mmHg com lactato {lactato} mmol/L: preciso iniciar noradrenalina?',
      'iniciar', 'Noradrenalina', {'PAM': 66}),
    E('GAT-SEPSE-PAM', 'PAM exatamente {PAM} mmHg, lactato {lactato} mmol/L. Entro com noradrenalina ou ainda é volume?',
      'iniciar', 'Noradrenalina', {'PAM': 65}),
    E('GAT-SEPSE-PAM', 'PAM {PAM} mmHg e lactato {lactato} mmol/L: inicia noradrenalina na dose inicial de 0.05 mcg/kg/min.',
      'iniciar', 'Noradrenalina', {'PAM': 64}),
    E('GAT-SEPSE-PAM', 'PAM {PAM} mmHg com FC {FC} bpm e lactato {lactato} mmol/L. Começo noradrenalina ou vasopressina?',
      'iniciar', 'Noradrenalina', {'PAM': 58, 'FC': 104}),
]

# --- 11. gatilho de agitação do Sedacao_Analgesia_VM (RASS > 0) -------------
NOVOS += [
    E('GAT-SEDA-AGIT', 'RASS {RASS} em ventilação mecânica com propofol correndo: titulo o sedativo?',
      'subir', 'Propofol', {'RASS': 0, 'PAM': 84}, ['Propofol']),
    E('GAT-SEDA-AGIT', 'RASS {RASS}, paciente inquieto no respirador e propofol em curso. Sobe a sedação.',
      'subir', 'Propofol', {'RASS': 1, 'PAM': 84}, ['Propofol']),
    E('GAT-SEDA-AGIT', 'RASS {RASS} com propofol e fentanil correndo: trato dor primeiro ou subo o propofol?',
      'duvida', 'Propofol', {'RASS': 2, 'PAM': 86}, ['Propofol', 'Fentanil']),
    E('GAT-SEDA-AGIT', 'RASS {RASS} e risco de autoextubação, propofol em curso. O que faço agora?',
      'duvida', 'Propofol', {'RASS': 3, 'PAM': 88}, ['Propofol']),
]

# --- 12. gatilho de sedação excessiva do Sedacao_Analgesia_VM (RASS < -4) ---
NOVOS += [
    E('GAT-SEDA-PROF', 'RASS {RASS} com propofol em curso: reduzo a infusão ou mantenho até o despertar diário?',
      'duvida', 'Propofol', {'RASS': -3, 'PAM': 80}, ['Propofol']),
    E('GAT-SEDA-PROF', 'RASS exatamente {RASS} no propofol. Já é sedação excessiva pelo protocolo?',
      'duvida', 'Propofol', {'RASS': -4, 'PAM': 80}, ['Propofol']),
    E('GAT-SEDA-PROF', 'RASS {RASS} em propofol e fentanil: reduz a sedação e programa o despertar diário.',
      'reduzir', 'Propofol', {'RASS': -5, 'PAM': 80}, ['Propofol', 'Fentanil']),
]

# --- 13. gatilho de hiperglicemia do Controle_Glicemico_UTI (> 180 mg/dL) ---
NOVOS += [
    E('GAT-GLI-ALTA', 'Glicemia capilar {glicemia} mg/dL: já inicio insulina em bomba?',
      'iniciar', 'Insulina_Regular', {'glicemia': 178}),
    E('GAT-GLI-ALTA', 'Glicemia exatamente {glicemia} mg/dL. O protocolo de controle glicêmico manda iniciar infusão?',
      'iniciar', 'Insulina_Regular', {'glicemia': 180}),
    E('GAT-GLI-ALTA', 'Glicemia {glicemia} mg/dL em paciente crítico: inicia insulina regular contínua.',
      'iniciar', 'Insulina_Regular', {'glicemia': 181}),
    E('GAT-GLI-ALTA', 'Glicemia {glicemia} mg/dL, bem alta. Começa a insulina em 1 UI/h.',
      'iniciar', 'Insulina_Regular', {'glicemia': 245}),
]

# --- 14. gatilho de hipoglicemia do Controle_Glicemico_UTI (< 70 mg/dL) -----
NOVOS += [
    E('GAT-GLI-BAIXA', 'Glicemia {glicemia} mg/dL com insulina correndo: suspendo a bomba?',
      'suspender', 'Insulina_Regular', {'glicemia': 72}, ['Insulina_Regular']),
    E('GAT-GLI-BAIXA', 'Glicemia exatamente {glicemia} mg/dL na insulina. Já é hipoglicemia pelo protocolo?',
      'duvida', 'Insulina_Regular', {'glicemia': 70}, ['Insulina_Regular']),
    E('GAT-GLI-BAIXA', 'Glicemia {glicemia} mg/dL e a insulina ainda está em bomba. Suspende agora.',
      'suspender', 'Insulina_Regular', {'glicemia': 69}, ['Insulina_Regular']),
    E('GAT-GLI-BAIXA', 'Glicemia {glicemia} mg/dL com insulina em infusão: qual a conduta imediata?',
      'duvida', 'Insulina_Regular', {'glicemia': 58}, ['Insulina_Regular']),
]

# --- 15. escalonamento por lactato > 4 -> TIME_RESPOSTA_RAPIDA -------------
NOVOS += [
    E('ESC-TRR-LACT', 'Lactato {lactato} mmol/L com PAM {PAM} mmHg em noradrenalina: preciso acionar alguém?',
      'duvida', 'Noradrenalina', {'lactato': 3.9, 'PAM': 62}, ['Noradrenalina']),
    E('ESC-TRR-LACT', 'Lactato exatamente {lactato} mmol/L e PAM {PAM} mmHg na noradrenalina. Escalono?',
      'duvida', 'Noradrenalina', {'lactato': 4.0, 'PAM': 62}, ['Noradrenalina']),
    E('ESC-TRR-LACT', 'Lactato {lactato} mmol/L, PAM {PAM} mmHg, noradrenalina correndo: hipoperfusão persistente, chamo o time?',
      'duvida', 'Noradrenalina', {'lactato': 4.1, 'PAM': 62}, ['Noradrenalina']),
    E('ESC-TRR-LACT', 'Lactato {lactato} mmol/L com PAM {PAM} mmHg e FC {FC} bpm em noradrenalina. Quem eu aciono?',
      'duvida', 'Noradrenalina', {'lactato': 6.2, 'PAM': 60, 'FC': 118}, ['Noradrenalina']),
]

# --- 16. escalonamento por PAM < 55 -> INTENSIVISTA ------------------------
NOVOS += [
    E('ESC-INT-PAM', 'PAM {PAM} mmHg com noradrenalina e lactato {lactato} mmol/L: chamo o intensivista?',
      'duvida', 'Noradrenalina', {'PAM': 56, 'lactato': 3.4}, ['Noradrenalina']),
    E('ESC-INT-PAM', 'PAM exatamente {PAM} mmHg em noradrenalina. É choque refratário pelo protocolo?',
      'duvida', 'Noradrenalina', {'PAM': 55, 'lactato': 3.4}, ['Noradrenalina']),
    E('ESC-INT-PAM', 'PAM {PAM} mmHg mesmo com noradrenalina e lactato {lactato} mmol/L. Qual o próximo passo?',
      'duvida', 'Noradrenalina', {'PAM': 54, 'lactato': 3.8}, ['Noradrenalina']),
    E('ESC-INT-PAM', 'PAM {PAM} mmHg, lactato {lactato} mmol/L, noradrenalina em curso: associo vasopressina ou escalono?',
      'duvida', 'Vasopressina', {'PAM': 47, 'lactato': 5.0}, ['Noradrenalina']),
]

# --- 17. escalonamento por RASS > 2 -> MEDICO_PLANTONISTA ------------------
NOVOS += [
    E('ESC-PLANT-RASS', 'RASS exatamente {RASS} com propofol em curso: escalono para o plantonista?',
      'duvida', 'Propofol', {'RASS': 2, 'PAM': 86}, ['Propofol']),
    E('ESC-PLANT-RASS', 'RASS {RASS} em propofol, agitação refratária. Chamo alguém ou só titulo?',
      'duvida', 'Propofol', {'RASS': 3, 'PAM': 88}, ['Propofol']),
    E('ESC-PLANT-RASS', 'RASS {RASS} e o paciente está combativo no respirador, propofol e fentanil correndo. Conduta?',
      'duvida', 'Propofol', {'RASS': 4, 'PAM': 92}, ['Propofol', 'Fentanil']),
]

# --- 18. escalonamento por glicemia < 50 -> TIME_RESPOSTA_RAPIDA ----------
NOVOS += [
    E('ESC-TRR-GLI', 'Glicemia {glicemia} mg/dL com insulina em bomba: suspendo e escalono?',
      'suspender', 'Insulina_Regular', {'glicemia': 51}, ['Insulina_Regular']),
    E('ESC-TRR-GLI', 'Glicemia exatamente {glicemia} mg/dL na insulina. Já é hipoglicemia grave?',
      'duvida', 'Insulina_Regular', {'glicemia': 50}, ['Insulina_Regular']),
    E('ESC-TRR-GLI', 'Glicemia {glicemia} mg/dL com insulina correndo: aciono o time de resposta rápida?',
      'duvida', 'Insulina_Regular', {'glicemia': 49}, ['Insulina_Regular']),
    E('ESC-TRR-GLI', 'Glicemia {glicemia} mg/dL e RASS {RASS} com insulina em infusão. O que faço?',
      'duvida', 'Insulina_Regular', {'glicemia': 38, 'RASS': -3}, ['Insulina_Regular']),
]

# --- 19-23. ajuste_renal pela TFG (a unica condicao estruturada do farmaco) --
NOVOS += [
    E('REN-VANCO', 'TFG {TFG} mL/min com vancomicina em curso: mantenho o intervalo?',
      'ajustar', 'Vancomicina', {'TFG': 55}, ['Vancomicina']),
    E('REN-VANCO', 'TFG exatamente {TFG} mL/min na vancomicina. Preciso estender o intervalo?',
      'ajustar', 'Vancomicina', {'TFG': 50}, ['Vancomicina']),
    E('REN-VANCO', 'TFG {TFG} mL/min com vancomicina: estendo para 24 h e doso o vale?',
      'ajustar', 'Vancomicina', {'TFG': 49}, ['Vancomicina']),
    E('REN-VANCO', 'TFG {TFG} mL/min e vancomicina correndo. Ajusta a dose pela função renal.',
      'ajustar', 'Vancomicina', {'TFG': 22}, ['Vancomicina']),

    E('REN-PIPTAZO', 'TFG {TFG} mL/min com piperacilina-tazobactam em infusão estendida: mexo na dose?',
      'ajustar', 'Piperacilina_Tazobactam', {'TFG': 25}, ['Piperacilina_Tazobactam']),
    E('REN-PIPTAZO', 'TFG exatamente {TFG} mL/min na piperacilina-tazobactam. O ajuste renal incide?',
      'ajustar', 'Piperacilina_Tazobactam', {'TFG': 20}, ['Piperacilina_Tazobactam']),
    E('REN-PIPTAZO', 'TFG {TFG} mL/min com piperacilina-tazobactam: reduzo para 4.5 g a cada 12 h?',
      'ajustar', 'Piperacilina_Tazobactam', {'TFG': 19}, ['Piperacilina_Tazobactam']),

    E('REN-MIDA', 'TFG {TFG} mL/min com midazolam em curso e RASS {RASS}: ajusto a dose?',
      'ajustar', 'Midazolam', {'TFG': 35, 'RASS': -2}, ['Midazolam']),
    E('REN-MIDA', 'TFG exatamente {TFG} mL/min no midazolam, RASS {RASS}. Incide ajuste renal?',
      'ajustar', 'Midazolam', {'TFG': 30, 'RASS': -2}, ['Midazolam']),
    E('REN-MIDA', 'TFG {TFG} mL/min com midazolam e RASS {RASS}: reduz a dose pelo acúmulo do metabólito.',
      'ajustar', 'Midazolam', {'TFG': 29, 'RASS': -1}, ['Midazolam']),

    E('REN-FENTA', 'TFG {TFG} mL/min com fentanil em curso: mantenho a vazão da analgesia?',
      'ajustar', 'Fentanil', {'TFG': 32}, ['Fentanil']),
    E('REN-FENTA', 'TFG {TFG} mL/min no fentanil. Reduzo 25% pelo acúmulo de metabólitos?',
      'ajustar', 'Fentanil', {'TFG': 29}, ['Fentanil']),
    E('REN-FENTA', 'TFG {TFG} mL/min com fentanil e RASS {RASS}: ajusta a dose do opioide.',
      'ajustar', 'Fentanil', {'TFG': 18, 'RASS': -3}, ['Fentanil']),

    E('REN-VANCO-SUSP', 'TFG exatamente {TFG} mL/min com vancomicina: ainda posso dar a dose de manutenção de 15.0 mg/kg?',
      'duvida', 'Vancomicina', {'TFG': 20}, ['Vancomicina']),
    E('REN-VANCO-SUSP', 'TFG {TFG} mL/min na vancomicina. Suspendo e prescrevo pelo nível sérico?',
      'suspender', 'Vancomicina', {'TFG': 19}, ['Vancomicina']),
    E('REN-VANCO-SUSP', 'TFG {TFG} mL/min com vancomicina em curso: subo a dose porque a infecção está grave.',
      'subir', 'Vancomicina', {'TFG': 12, 'lactato': 3.0}, ['Vancomicina']),
]

# --- 24-28. populacoes especiais (vem do cadastro, nao da telemetria) -------
NOVOS += [
    E('POP-GEST-MIDA', 'Gestante no segundo trimestre com RASS {RASS} e PAM {PAM} mmHg: posso usar midazolam para sedar?',
      'iniciar', 'Midazolam', {'RASS': 1, 'PAM': 84}, [], ['Gestante']),
    E('POP-GEST-MIDA', 'Gestante agitada em ventilação mecânica, RASS {RASS}. Inicia midazolam.',
      'iniciar', 'Midazolam', {'RASS': 2, 'PAM': 86}, [], ['Gestante']),
    E('POP-GEST-MIDA', 'Gestante com RASS {RASS} e propofol em curso: troco o propofol por midazolam?',
      'duvida', 'Midazolam', {'RASS': -1, 'PAM': 82}, ['Propofol'], ['Gestante']),
    E('POP-GEST-MIDA', 'Gestação confirmada, RASS {RASS} e PAM {PAM} mmHg com propofol correndo. Qual sedativo é permitido?',
      'duvida', 'Propofol', {'RASS': 0, 'PAM': 80}, ['Propofol'], ['Gestante']),

    E('POP-GEST-VASO', 'Gestante com PAM {PAM} mmHg e lactato {lactato} mmol/L: inicio noradrenalina?',
      'iniciar', 'Noradrenalina', {'PAM': 59, 'lactato': 3.1}, [], ['Gestante']),
    E('POP-GEST-VASO', 'Gestante em noradrenalina com PAM {PAM} mmHg: a vasopressina é opção segura aqui?',
      'duvida', 'Vasopressina', {'PAM': 57, 'lactato': 3.6}, ['Noradrenalina'], ['Gestante']),
    E('POP-GEST-VASO', 'Gestante com PAM {PAM} mmHg em noradrenalina. Que cuidado a mais o protocolo exige?',
      'duvida', 'Noradrenalina', {'PAM': 61, 'lactato': 2.4}, ['Noradrenalina'], ['Gestante']),

    E('POP-RENAL-AJUSTE', 'Renal crônico em diálise com TFG {TFG} mL/min e vancomicina em curso: qual o fator de ajuste?',
      'ajustar', 'Vancomicina', {'TFG': 18}, ['Vancomicina'], ['Renal_Cronico']),
    E('POP-RENAL-AJUSTE', 'Renal crônico com TFG {TFG} mL/min e midazolam correndo, RASS {RASS}. Reduzo a dose?',
      'ajustar', 'Midazolam', {'TFG': 24, 'RASS': -2}, ['Midazolam'], ['Renal_Cronico']),
    E('POP-RENAL-AJUSTE', 'Renal crônico com TFG {TFG} mL/min em fentanil: ajusta a analgesia pelo fator da população.',
      'ajustar', 'Fentanil', {'TFG': 27}, ['Fentanil'], ['Renal_Cronico']),
    E('POP-RENAL-AJUSTE', 'Terapia renal substitutiva, TFG {TFG} mL/min, vancomicina e piperacilina-tazobactam juntas. O que o cadastro exige antes de reajustar?',
      'duvida', 'Vancomicina', {'TFG': 15}, ['Vancomicina', 'Piperacilina_Tazobactam'], ['Renal_Cronico']),

    E('POP-IDOSO-AJUSTE', 'Idoso frágil com RASS {RASS} e PAM {PAM} mmHg em propofol: qual dose devo usar?',
      'ajustar', 'Propofol', {'RASS': 0, 'PAM': 74}, ['Propofol'], ['Idoso_Fragil']),
    E('POP-IDOSO-AJUSTE', 'Idoso frágil em midazolam com RASS {RASS}: reduzo pela metade?',
      'ajustar', 'Midazolam', {'RASS': -1}, ['Midazolam'], ['Idoso_Fragil']),
    E('POP-IDOSO-AJUSTE', 'Idoso frágil com PAM {PAM} mmHg e RASS {RASS}: inicio propofol para sedar?',
      'iniciar', 'Propofol', {'PAM': 72, 'RASS': 2}, [], ['Idoso_Fragil']),
    E('POP-IDOSO-AJUSTE', 'Idoso frágil com propofol e fentanil correndo, RASS {RASS}. Que rastreio o protocolo exige?',
      'duvida', 'Propofol', {'RASS': -2}, ['Propofol', 'Fentanil'], ['Idoso_Fragil']),

    E('POP-OBESO-EXIGE', 'Obeso grave com IMC acima de 40 e RASS {RASS}: qual peso uso para calcular o fentanil?',
      'duvida', 'Fentanil', {'RASS': 1}, ['Fentanil'], ['Obeso_Grave']),
    E('POP-OBESO-EXIGE', 'Obeso grave com lactato {lactato} mmol/L: inicio vancomicina? Preciso de alguma revisão antes?',
      'iniciar', 'Vancomicina', {'lactato': 2.8}, [], ['Obeso_Grave']),
    E('POP-OBESO-EXIGE', 'Obesidade grave e PAM {PAM} mmHg: começo noradrenalina com peso real ou ajustado?',
      'iniciar', 'Noradrenalina', {'PAM': 60}, [], ['Obeso_Grave']),
    E('POP-OBESO-EXIGE', 'Obeso grave em propofol com RASS {RASS} e PAM {PAM} mmHg. O cálculo da dose muda?',
      'ajustar', 'Propofol', {'RASS': -1, 'PAM': 76}, ['Propofol'], ['Obeso_Grave']),
]

# --- 29-30. vetos de protocolo (podam a politica do farmaco) ----------------
NOVOS += [
    E('VETO-SEPSE-DOBU', 'Lactato {lactato} mmol/L e PAM {PAM} mmHg: inicio dobutamina para melhorar o débito?',
      'iniciar', 'Dobutamina', {'lactato': 3.4, 'PAM': 62}),
    E('VETO-SEPSE-DOBU', 'Choque séptico com lactato {lactato} mmol/L. Começa dobutamina junto da noradrenalina.',
      'iniciar', 'Dobutamina', {'lactato': 4.6, 'PAM': 58}, ['Noradrenalina']),
    E('VETO-SEPSE-DOBU', 'PAM {PAM} mmHg com noradrenalina e lactato {lactato} mmol/L: a dobutamina está liberada no protocolo de sepse?',
      'duvida', 'Dobutamina', {'PAM': 60, 'lactato': 2.6}, ['Noradrenalina']),
    E('VETO-SEPSE-DOBU', 'Dobutamina já em curso e agora lactato {lactato} mmol/L com PAM {PAM} mmHg. Mantenho o inotrópico?',
      'duvida', 'Dobutamina', {'lactato': 3.1, 'PAM': 63}, ['Dobutamina']),

    E('VETO-SEDA-MIDA', 'RASS {RASS} em ventilação mecânica: inicio midazolam para sedar?',
      'iniciar', 'Midazolam', {'RASS': 2, 'PAM': 84}),
    E('VETO-SEDA-MIDA', 'RASS {RASS} e paciente agitado no respirador. Começa midazolam em bomba.',
      'iniciar', 'Midazolam', {'RASS': 1, 'PAM': 86}),
    E('VETO-SEDA-MIDA', 'RASS {RASS} com midazolam já correndo: o protocolo de sedação permite manter esse sedativo?',
      'duvida', 'Midazolam', {'RASS': -5, 'PAM': 80}, ['Midazolam']),
    E('VETO-SEDA-MIDA', 'RASS {RASS} e midazolam em curso: troco por propofol para desmame precoce?',
      'duvida', 'Propofol', {'RASS': 1, 'PAM': 82}, ['Midazolam']),
]

# --- 31-34. interacoes (so pesam com o outro farmaco em infusao) ------------
NOVOS += [
    E('INT-NORA-ADRE', 'Noradrenalina e adrenalina correndo juntas com PAM {PAM} mmHg e FC {FC} bpm. Isso é seguro?',
      'duvida', 'Adrenalina', {'PAM': 58, 'FC': 124}, ['Noradrenalina', 'Adrenalina']),
    E('INT-NORA-ADRE', 'PAM {PAM} mmHg em noradrenalina: associo adrenalina agora?',
      'iniciar', 'Adrenalina', {'PAM': 54, 'lactato': 4.8}, ['Noradrenalina']),
    E('INT-NORA-ADRE', 'Noradrenalina e adrenalina juntas, FC {FC} bpm e lactato {lactato} mmol/L. Qual delas eu reduzo?',
      'duvida', 'Adrenalina', {'FC': 136, 'lactato': 5.4, 'PAM': 64}, ['Noradrenalina', 'Adrenalina']),

    E('INT-PROP-MIDA', 'Propofol e midazolam correndo juntos com RASS {RASS} e PAM {PAM} mmHg. Isso está adequado?',
      'duvida', 'Midazolam', {'RASS': -3, 'PAM': 72}, ['Propofol', 'Midazolam']),
    E('INT-PROP-MIDA', 'Propofol em curso e RASS {RASS}: acrescento midazolam para aprofundar?',
      'iniciar', 'Midazolam', {'RASS': -1, 'PAM': 78}, ['Propofol']),
    E('INT-PROP-MIDA', 'Propofol e midazolam juntos, PAM {PAM} mmHg e RASS {RASS}: reduzo ambas as doses em 50%?',
      'duvida', 'Propofol', {'PAM': 64, 'RASS': -2}, ['Propofol', 'Midazolam']),

    E('INT-FENT-MIDA', 'Fentanil e midazolam juntos com RASS {RASS}: qual o risco dessa dupla?',
      'duvida', 'Fentanil', {'RASS': -3}, ['Fentanil', 'Midazolam']),
    E('INT-FENT-MIDA', 'Fentanil correndo e RASS {RASS}: adiciono midazolam?',
      'iniciar', 'Midazolam', {'RASS': -1}, ['Fentanil']),
    E('INT-FENT-MIDA', 'Fentanil e midazolam em infusão, RASS {RASS} e SpO2 {SpO2}%. Preciso mexer em alguma coisa?',
      'duvida', 'Midazolam', {'RASS': -4, 'SpO2': 92}, ['Fentanil', 'Midazolam']),

    E('INT-VANCO-PIP', 'Vancomicina e piperacilina-tazobactam juntas com TFG {TFG} mL/min. Mantenho as duas?',
      'duvida', 'Vancomicina', {'TFG': 58}, ['Vancomicina', 'Piperacilina_Tazobactam']),
    E('INT-VANCO-PIP', 'Vancomicina em curso com lactato {lactato} mmol/L: associo piperacilina-tazobactam?',
      'iniciar', 'Piperacilina_Tazobactam', {'lactato': 3.2}, ['Vancomicina']),
    E('INT-VANCO-PIP', 'Vancomicina e piperacilina-tazobactam juntas, TFG {TFG} mL/min: troco uma delas?',
      'duvida', 'Piperacilina_Tazobactam', {'TFG': 44}, ['Vancomicina', 'Piperacilina_Tazobactam']),
]

# --- 35-39. limites DERS da bomba (consequencia declarada, nao condicao) ----
NOVOS += [
    E('DERS-NORA', 'Noradrenalina já no limite, PAM {PAM} mmHg e lactato {lactato} mmol/L: passo de 2.0 mcg/kg/min?',
      'duvida', 'Noradrenalina', {'PAM': 54, 'lactato': 5.6}, ['Noradrenalina']),
    E('DERS-NORA', 'PAM {PAM} mmHg com noradrenalina: prescreve 2.0 mcg/kg/min, que é a dose máxima.',
      'subir', 'Noradrenalina', {'PAM': 52, 'lactato': 4.2}, ['Noradrenalina']),
    E('DERS-NORA', 'Noradrenalina acima do limite leve de 1.0 mcg/kg/min com PAM {PAM} mmHg. Continuo subindo?',
      'duvida', 'Noradrenalina', {'PAM': 58}, ['Noradrenalina']),

    E('DERS-PROP', 'Propofol com RASS {RASS} e PAM {PAM} mmHg: subo para 4.0 mg/kg/h?',
      'subir', 'Propofol', {'RASS': 0, 'PAM': 74}, ['Propofol']),
    E('DERS-PROP', 'RASS {RASS} e PAM {PAM} mmHg no propofol, já no limite leve de 3.0 mg/kg/h. Posso ultrapassar?',
      'duvida', 'Propofol', {'RASS': 1, 'PAM': 70}, ['Propofol']),

    E('DERS-VASO', 'Vasopressina em curso com PAM {PAM} mmHg: subo acima de 0.04 U/min?',
      'duvida', 'Vasopressina', {'PAM': 56}, ['Noradrenalina', 'Vasopressina']),
    E('DERS-VASO', 'PAM {PAM} mmHg com vasopressina e noradrenalina: titula a vasopressina além do limite rígido.',
      'subir', 'Vasopressina', {'PAM': 53, 'lactato': 4.4}, ['Noradrenalina', 'Vasopressina']),

    E('DERS-INSU', 'Glicemia {glicemia} mg/dL com insulina: prescreve 20.0 UI/h de uma vez.',
      'subir', 'Insulina_Regular', {'glicemia': 412}, ['Insulina_Regular']),
    E('DERS-INSU', 'Glicemia {glicemia} mg/dL e insulina no limite leve de 10.0 UI/h. Continuo titulando?',
      'duvida', 'Insulina_Regular', {'glicemia': 326}, ['Insulina_Regular']),

    E('DERS-HEPA', 'Plaquetas {plaquetas} mil e heparina perto de 2000.0 UI/h: ultrapasso o limite rígido?',
      'duvida', 'Heparina', {'plaquetas': 180}, ['Heparina']),
    E('DERS-HEPA', 'Heparina no limite leve de 1500.0 UI/h com plaquetas {plaquetas} mil. Subo mais 100.0 UI/h?',
      'subir', 'Heparina', {'plaquetas': 165}, ['Heparina']),
]

# --- 40-43. vias de administracao ------------------------------------------
NOVOS += [
    E('VIA-VASO-CENTRAL', 'Só tenho acesso periférico e PAM {PAM} mmHg: posso correr vasopressina por via periférica?',
      'iniciar', 'Vasopressina', {'PAM': 57, 'lactato': 3.8}, ['Noradrenalina'], via_duvida=True),
    E('VIA-VASO-CENTRAL', 'PAM {PAM} mmHg em noradrenalina por acesso central: inicio vasopressina na mesma via?',
      'iniciar', 'Vasopressina', {'PAM': 55, 'lactato': 4.1}, ['Noradrenalina'], via='ACESSO_CENTRAL'),

    E('VIA-CISA-CENTRAL', 'RASS {RASS} e preciso bloquear: posso iniciar cisatracúrio em acesso periférico?',
      'iniciar', 'Cisatracurio', {'RASS': -5}, ['Propofol', 'Fentanil'], via_duvida=True),
    E('VIA-CISA-CENTRAL', 'RASS {RASS} com propofol e fentanil em acesso central. Inicio o cisatracúrio por essa via?',
      'iniciar', 'Cisatracurio', {'RASS': -5}, ['Propofol', 'Fentanil'], via='ACESSO_CENTRAL'),

    E('VIA-ADRE-PERIF', 'PAM {PAM} mmHg e lactato {lactato} mmol/L: dá para iniciar adrenalina em acesso periférico?',
      'iniciar', 'Adrenalina', {'PAM': 52, 'lactato': 5.1}, ['Noradrenalina'], via_duvida=True),
    E('VIA-ADRE-PERIF', 'Sem acesso central ainda, PAM {PAM} mmHg: inicio adrenalina intraóssea?',
      'iniciar', 'Adrenalina', {'PAM': 50, 'lactato': 6.0}, ['Noradrenalina'], via='INTRAOSSEO'),

    E('VIA-PONTE-6H', 'PAM {PAM} mmHg e só acesso periférico disponível: inicio noradrenalina por lá como ponte?',
      'iniciar', 'Noradrenalina', {'PAM': 58, 'lactato': 2.9}, [], via='ACESSO_PERIFERICO'),
    E('VIA-PONTE-6H', 'Noradrenalina correndo em acesso periférico com PAM {PAM} mmHg. Por quanto tempo isso é admissível?',
      'duvida', 'Noradrenalina', {'PAM': 63}, ['Noradrenalina'], via='ACESSO_PERIFERICO'),
    E('VIA-PONTE-6H', 'Dobutamina em acesso periférico com FC {FC} bpm e PAM {PAM} mmHg: mantenho essa via?',
      'duvida', 'Dobutamina', {'FC': 108, 'PAM': 70}, ['Dobutamina'], via='ACESSO_PERIFERICO'),
]

# --- 44-46. estado de curso do farmaco -------------------------------------
NOVOS += [
    E('CURSO-JA-CORRE', 'A noradrenalina já está em infusão e a PAM está {PAM} mmHg. Prescrevo a dose inicial de 0.05 mcg/kg/min de novo?',
      'iniciar_em_curso', 'Noradrenalina', {'PAM': 60}, ['Noradrenalina']),
    E('CURSO-JA-CORRE', 'Propofol já correndo com RASS {RASS}: inicio propofol?',
      'iniciar_em_curso', 'Propofol', {'RASS': 0, 'PAM': 80}, ['Propofol']),
    E('CURSO-JA-CORRE', 'Insulina já em bomba e glicemia {glicemia} mg/dL. Inicia insulina regular.',
      'iniciar_em_curso', 'Insulina_Regular', {'glicemia': 268}, ['Insulina_Regular']),
    E('CURSO-JA-CORRE', 'Heparina já instalada, plaquetas {plaquetas} mil: inicio heparina na dose de 12.0 UI/kg?',
      'iniciar_em_curso', 'Heparina', {'plaquetas': 190}, ['Heparina']),

    E('CURSO-FORA-DE-CURSO', 'PAM {PAM} mmHg e lactato {lactato} mmol/L: aumenta a noradrenalina em um degrau.',
      'subir_fora_de_curso', 'Noradrenalina', {'PAM': 57, 'lactato': 3.3}, ['Vasopressina']),
    E('CURSO-FORA-DE-CURSO', 'RASS {RASS} no respirador: sobe o propofol.',
      'subir_fora_de_curso', 'Propofol', {'RASS': 2, 'PAM': 86}, ['Fentanil']),
    E('CURSO-FORA-DE-CURSO', 'Glicemia {glicemia} mg/dL: titula a insulina mais 1 UI/h.',
      'subir_fora_de_curso', 'Insulina_Regular', {'glicemia': 232}, []),
    E('CURSO-FORA-DE-CURSO', 'Plaquetas {plaquetas} mil: reduz a heparina pela metade.',
      'subir_fora_de_curso', 'Heparina', {'plaquetas': 78}, ['Fentanil']),

    E('CURSO-SUBSTITUIR', 'Midazolam em curso com RASS {RASS} e delirium: substituo por propofol?',
      'substituir', 'Midazolam', {'RASS': -2}, ['Midazolam']),
    E('CURSO-SUBSTITUIR', 'Vancomicina com TFG {TFG} mL/min: troco por outro antimicrobiano do protocolo?',
      'substituir', 'Vancomicina', {'TFG': 21}, ['Vancomicina']),
    E('CURSO-SUBSTITUIR', 'Adrenalina com FC {FC} bpm e PAM {PAM} mmHg: substituo por vasopressina para poupar catecolamina?',
      'substituir', 'Adrenalina', {'FC': 138, 'PAM': 60}, ['Noradrenalina', 'Adrenalina']),
    E('CURSO-SUBSTITUIR', 'Piperacilina-tazobactam com vancomicina e TFG {TFG} mL/min: substituo a piperacilina por cefepima?',
      'substituir', 'Piperacilina_Tazobactam', {'TFG': 38}, ['Vancomicina', 'Piperacilina_Tazobactam']),
]

# --- 47-48. desmame ---------------------------------------------------------
NOVOS += [
    E('DESM-SEPSE', 'PAM {PAM} mmHg estável e lactato {lactato} mmol/L normalizado em noradrenalina: começo o desmame?',
      'reduzir', 'Noradrenalina', {'PAM': 76, 'lactato': 1.3}, ['Noradrenalina']),
    E('DESM-SEPSE', 'PAM {PAM} mmHg com lactato {lactato} mmol/L: reduzo a noradrenalina em 0.02 mcg/kg/min?',
      'reduzir', 'Noradrenalina', {'PAM': 72, 'lactato': 1.1}, ['Noradrenalina']),
    E('DESM-SEPSE', 'PAM exatamente {PAM} mmHg e lactato {lactato} mmol/L na noradrenalina. O critério de desmame está cumprido?',
      'duvida', 'Noradrenalina', {'PAM': 70, 'lactato': 1.6}, ['Noradrenalina']),
    E('DESM-SEPSE', 'PAM {PAM} mmHg e lactato {lactato} mmol/L com noradrenalina e vasopressina: qual desmamo primeiro?',
      'duvida', 'Vasopressina', {'PAM': 78, 'lactato': 1.2}, ['Noradrenalina', 'Vasopressina']),

    E('DESM-SEDA', 'RASS {RASS} no alvo e sem assincronia: reduzo o propofol em 0.5 mg/kg/h?',
      'reduzir', 'Propofol', {'RASS': -1, 'PAM': 82}, ['Propofol']),
    E('DESM-SEDA', 'RASS {RASS} com propofol e fentanil: faço a interrupção diária da sedação?',
      'duvida', 'Propofol', {'RASS': -2, 'PAM': 84}, ['Propofol', 'Fentanil']),
    E('DESM-SEDA', 'RASS {RASS} e PAM {PAM} mmHg em propofol. Desmamo a sedação para o teste de respiração espontânea?',
      'reduzir', 'Propofol', {'RASS': 0, 'PAM': 86}, ['Propofol']),
    E('DESM-SEDA', 'RASS {RASS} com fentanil correndo: reduzo o opioide ou o sedativo primeiro?',
      'duvida', 'Fentanil', {'RASS': -1}, ['Propofol', 'Fentanil']),
]

# --- 49-51. as tres decisoes que ganharam conduta (MANTER_VAZAO, ------------
#            AJUSTAR_DOSE, SUBSTITUIR) ---------------------------------------
NOVOS += [
    E('COND-MANTER-VAZAO', 'PAM {PAM} mmHg no alvo e lactato {lactato} mmol/L com noradrenalina: mantenho a vazão como está?',
      'manter', 'Noradrenalina', {'PAM': 68, 'lactato': 1.9}, ['Noradrenalina']),
    E('COND-MANTER-VAZAO', 'RASS {RASS} dentro do alvo com propofol e PAM {PAM} mmHg. Mantenho a sedação onde está?',
      'manter', 'Propofol', {'RASS': -1, 'PAM': 78}, ['Propofol']),
    E('COND-MANTER-VAZAO', 'Glicemia {glicemia} mg/dL na faixa alvo com insulina em bomba: mantenho a vazão?',
      'manter', 'Insulina_Regular', {'glicemia': 162}, ['Insulina_Regular']),
    E('COND-MANTER-VAZAO', 'FC {FC} bpm na dobutamina com PAM {PAM} mmHg: mantenho a vazão atual do inotrópico?',
      'manter', 'Dobutamina', {'FC': 104, 'PAM': 74}, ['Dobutamina']),

    E('COND-AJUSTAR-DOSE', 'Vancomicina em curso com TFG {TFG} mL/min: ajusto a dose de manutenção sem mudar a vazão?',
      'ajustar', 'Vancomicina', {'TFG': 42}, ['Vancomicina']),
    E('COND-AJUSTAR-DOSE', 'Idoso frágil em propofol com RASS {RASS}: aplico o fator da população na dose?',
      'ajustar', 'Propofol', {'RASS': -1, 'PAM': 76}, ['Propofol'], ['Idoso_Fragil']),
    E('COND-AJUSTAR-DOSE', 'Renal crônico com TFG {TFG} mL/min em midazolam e fentanil: ajusto as duas doses?',
      'ajustar', 'Fentanil', {'TFG': 19, 'RASS': -2}, ['Midazolam', 'Fentanil'], ['Renal_Cronico']),
    E('COND-AJUSTAR-DOSE', 'Obeso grave em fentanil com RASS {RASS}: recalculo a dose pelo peso ajustado?',
      'ajustar', 'Fentanil', {'RASS': 0}, ['Fentanil'], ['Obeso_Grave']),

    E('COND-SUBSTITUIR', 'Gestante com midazolam em curso e RASS {RASS}: substituo o sedativo?',
      'substituir', 'Midazolam', {'RASS': -2, 'PAM': 80}, ['Midazolam'], ['Gestante']),
    E('COND-SUBSTITUIR', 'Midazolam correndo com RASS {RASS} e delirium hiperativo estabelecido na avaliação: substituo?',
      'substituir', 'Midazolam', {'RASS': 1, 'PAM': 84}, ['Midazolam']),
    E('COND-SUBSTITUIR', 'Propofol em curso com PAM {PAM} mmHg e RASS {RASS}: substituo por outro sedativo do protocolo?',
      'substituir', 'Propofol', {'PAM': 58, 'RASS': -2}, ['Propofol']),
]

# --- 52. SOLICITAR_EXAME: as monitoracoes que o proprio modelo declara ------
NOVOS += [
    E('EXAME-VANCO', 'Vancomicina em curso há três dias com TFG {TFG} mL/min: colho a vancocinemia de vale antes de reajustar?',
      'exame', 'Vancomicina', {'TFG': 46}, ['Vancomicina']),
    E('EXAME-VANCO', 'TFG {TFG} mL/min com vancomicina: qual exame peço para decidir a próxima dose?',
      'exame', 'Vancomicina', {'TFG': 33}, ['Vancomicina']),

    E('EXAME-HEPA', 'Plaquetas {plaquetas} mil com heparina em bomba: peço TTPa e nova contagem?',
      'exame', 'Heparina', {'plaquetas': 112}, ['Heparina']),
    E('EXAME-HEPA', 'Plaquetas caíram de forma importante para {plaquetas} mil na heparina. Que controle eu solicito?',
      'exame', 'Heparina', {'plaquetas': 68}, ['Heparina']),

    E('EXAME-PROP', 'Propofol há mais de 24 h com RASS {RASS} e PAM {PAM} mmHg: quais exames de controle peço?',
      'exame', 'Propofol', {'RASS': -2, 'PAM': 76}, ['Propofol']),
    E('EXAME-PROP', 'Propofol em dose alta com RASS {RASS}: solicito triglicerídeos e creatinofosfoquinase?',
      'exame', 'Propofol', {'RASS': -3, 'PAM': 72}, ['Propofol']),

    E('EXAME-TOF', 'Cisatracúrio em curso com RASS {RASS}: que monitoração o protocolo exige a cada 60 min?',
      'exame', 'Cisatracurio', {'RASS': -5}, ['Cisatracurio', 'Propofol', 'Fentanil']),
    E('EXAME-TOF', 'RASS {RASS} com cisatracúrio correndo: peço train-of-four antes de titular?',
      'exame', 'Cisatracurio', {'RASS': -5}, ['Cisatracurio', 'Propofol']),

    E('EXAME-CAMICU', 'Midazolam em curso com RASS {RASS}: faço rastreio de delirium?',
      'exame', 'Midazolam', {'RASS': -2}, ['Midazolam']),
    E('EXAME-CAMICU', 'Idoso frágil em midazolam e fentanil com RASS {RASS}: qual rastreio é obrigatório a cada 12 h?',
      'exame', 'Midazolam', {'RASS': -1}, ['Midazolam', 'Fentanil'], ['Idoso_Fragil']),
]

# --- 53. regras globais ----------------------------------------------------
NOVOS += [
    E('GLOB-DUPLA-CHECAGEM', 'Vou instalar noradrenalina agora com PAM {PAM} mmHg: que conferência o protocolo exige antes?',
      'iniciar', 'Noradrenalina', {'PAM': 59, 'lactato': 2.7}),
    E('GLOB-DUPLA-CHECAGEM', 'Cisatracúrio prescrito com RASS {RASS}: posso instalar a bomba sozinho?',
      'iniciar', 'Cisatracurio', {'RASS': -5}, ['Propofol', 'Fentanil']),

    E('GLOB-LASA', 'Noradrenalina e adrenalina na mesma gaveta do carro de emergência, PAM {PAM} mmHg. Isso é admissível?',
      'duvida', 'Noradrenalina', {'PAM': 62}, ['Noradrenalina']),
    E('GLOB-LASA', 'Heparina e insulina guardadas lado a lado, plaquetas {plaquetas} mil e glicemia {glicemia} mg/dL. Que risco o modelo aponta?',
      'duvida', 'Heparina', {'plaquetas': 142, 'glicemia': 196}, ['Heparina', 'Insulina_Regular']),

    E('GLOB-AUDITORIA', 'PAM {PAM} mmHg com noradrenalina: se o sistema gerar a ordem, o que precisa acompanhar a prescrição?',
      'duvida', 'Noradrenalina', {'PAM': 61}, ['Noradrenalina']),
]

# --- 54. contraindicacoes em prosa (fato de prontuario, nao de telemetria) --
NOVOS += [
    E('CONTRA-PROSA', 'Paciente com alergia a ovo e soja descrita no prontuário, RASS {RASS} e PAM {PAM} mmHg: o propofol está liberado?',
      'iniciar', 'Propofol', {'RASS': 1, 'PAM': 84}),
    E('CONTRA-PROSA', 'Trombocitopenia induzida por heparina em internação anterior, plaquetas hoje {plaquetas} mil: inicio heparina?',
      'iniciar', 'Heparina', {'plaquetas': 168}),
    E('CONTRA-PROSA', 'Cardiomiopatia hipertrófica obstrutiva no ecocardiograma, PAM {PAM} mmHg e FC {FC} bpm: inicio dobutamina?',
      'iniciar', 'Dobutamina', {'PAM': 66, 'FC': 92}),
]

# =============================================================================
# 3) Construcao das linhas
# =============================================================================

EM_CURSO = {'subir', 'reduzir', 'manter', 'suspender', 'ajustar', 'substituir',
            'iniciar_em_curso'}
FORA_DE_CURSO = {'iniciar', 'subir_fora_de_curso'}

ROTAS_NA_FALA = [
    (r'periferic', 'ACESSO_PERIFERICO'),
    (r'intraosse', 'INTRAOSSEO'),
    (r'subcutane', 'SC'),
    (r'\bcentral\b', 'ACESSO_CENTRAL'),
]
VIAS_DO_ESQUEMA = [v.strip() for v in re.search(
    r'^\s*vias\s*\[([^\]]*)\]', FONTE[FONTE.index('esquema_dados'):], re.M).group(1).split(',')]


def fmt(tele: dict) -> dict:
    """Numero da fala com a cara com que a equipe o diz: lactato com uma casa,
    o resto inteiro quando e inteiro."""
    out = {}
    for k, v in tele.items():
        if k == 'lactato':
            out[k] = f'{v:.1f}'
        elif float(v) == int(v):
            out[k] = str(int(v))
        else:
            out[k] = str(v)
    return out


def construir(entrada: dict, indice: int) -> dict:
    tele = dict(BASE)
    tele.update(entrada['over'])
    tele = {k: tele[k] for k in TELEMETRIA}

    emUso = list(entrada['emUso'])
    alvo = entrada['alvo']
    if alvo in FARMACOS:
        if entrada['acao'] in EM_CURSO and alvo not in emUso:
            raise SystemExit(f"[{entrada['familia']}] acao {entrada['acao']} exige {alvo} em farmacosEmUso")
        if entrada['acao'] in FORA_DE_CURSO and alvo in emUso:
            raise SystemExit(f"[{entrada['familia']}] acao {entrada['acao']} exige {alvo} FORA de farmacosEmUso")

    return {
        'intencao': entrada['prosa'].format(**fmt(tele)),
        'paciente': f'PT-2026-{4201 + indice}',
        'telemetria': tele,
        'populacoes': list(entrada['pops']),
        'farmacosEmUso': emUso,
    }


# =============================================================================
# 4) Validacao de completude (o portao: nada incoerente e gravado)
# =============================================================================

# numero rotulado por parametro da telemetria: a fala tem de repetir a leitura
ROTULOS = {
    'PAM': r'pam\s*(?:de\s*|em\s*|exatamente\s*)*(-?\d+(?:[.,]\d+)?)',
    'FC': r'(?:fc|frequencia cardiaca)\s*(?:de\s*|em\s*|a\s*)*(-?\d+(?:[.,]\d+)?)',
    'lactato': r'lactato\s*(?:de\s*|em\s*|exatamente\s*)*(-?\d+(?:[.,]\d+)?)',
    'RASS': r'rass\s*(?:de\s*|em\s*|exatamente\s*)*([+-]?\d+(?:[.,]\d+)?)',
    'TFG': r'tfg\s*(?:de\s*|em\s*|exatamente\s*)*(-?\d+(?:[.,]\d+)?)',
    'glicemia': r'glicemia\s*(?:capilar\s*)?(?:de\s*|deu\s*|em\s*|exatamente\s*)*(-?\d+(?:[.,]\d+)?)',
    'plaquetas': r'plaquetas\s*(?:de\s*|em\s*|hoje\s*|exatamente\s*)*(-?\d+(?:[.,]\d+)?)',
    'SpO2': r'spo2\s*(?:de\s*|em\s*)*(-?\d+(?:[.,]\d+)?)',
}
# numero com unidade da leitura: mesma exigencia, venha o rotulo antes ou depois
UNIDADES = {'mmhg': 'PAM', 'bpm': 'FC', 'mmol/l': 'lactato', 'mg/dl': 'glicemia',
            'ml/min': 'TFG'}


def validar(linha: dict, entrada: dict | None, erros: list):
    def erro(msg):
        erros.append(f"{linha['paciente']}: {msg}")

    fala = norm(linha['intencao'])
    tele = linha['telemetria']

    # 1. esquema e faixa fisiologica
    if list(linha) != ['intencao', 'paciente', 'telemetria', 'populacoes', 'farmacosEmUso']:
        erro(f'chaves fora do formato: {list(linha)}')
    if list(tele) != TELEMETRIA:
        erro(f'telemetria fora do esquema: {list(tele)}')
    for k, v in tele.items():
        lo, hi = FAIXAS[k]
        if not isinstance(v, (int, float)) or not (lo <= v <= hi):
            erro(f'{k}={v} fora da faixa fisiologica [{lo}, {hi}]')
    if tele['RASS'] != int(tele['RASS']):
        erro('RASS nao e inteiro')
    for f in linha['farmacosEmUso']:
        if f not in FARMACOS:
            erro(f'farmacosEmUso cita {f}, que o modelo nao declara')
    for p in linha['populacoes']:
        if p not in POPULACOES:
            erro(f'populacoes cita {p}, que o modelo nao declara')

    # 2. ancoragem: a fala nomeia algo que o modelo declara
    if not any(a in fala for nome in APELIDOS for a in APELIDOS[nome]):
        erro('a fala nao nomeia nenhum farmaco, protocolo ou populacao do modelo')

    # 3a. numero rotulado = leitura daquela linha
    for k, pat in ROTULOS.items():
        for m in re.finditer(pat, fala):
            v = float(m.group(1).replace(',', '.').lstrip('+'))
            if abs(v - tele[k]) > 0.051:
                erro(f'fala diz {k} {v}, telemetria tem {tele[k]}')
    # 3b. numero com unidade da leitura = leitura daquela linha
    for m in re.finditer(r'(-?\d+(?:[.,]\d+)?)\s*(mmhg|bpm|mmol/l|mg/dl|ml/min)\b', fala):
        v, k = float(m.group(1).replace(',', '.')), UNIDADES[m.group(2)]
        if abs(v - tele[k]) > 0.051 and abs(v) not in NUMEROS_DO_MODELO:
            erro(f'fala diz {v} {m.group(2)}, telemetria tem {k}={tele[k]} e o modelo nao declara esse numero')
    # 3c. nos 200 novos, TODO numero da fala e leitura ou numero do modelo
    if entrada is not None:
        for m in re.finditer(r'-?\d+(?:\.\d+)?', linha['intencao']):
            v = abs(float(m.group(0)))
            if v in NUMEROS_DO_MODELO:
                continue
            if any(abs(v - abs(x)) < 1e-9 for x in tele.values()):
                continue
            erro(f'numero {m.group(0)} nao e leitura desta linha nem numero declarado no uti.dsl')

    # 4. estado de curso
    if entrada is not None and entrada['alvo'] in FARMACOS:
        alvo, acao = entrada['alvo'], entrada['acao']
        if acao in EM_CURSO and alvo not in linha['farmacosEmUso']:
            erro(f'{acao} de {alvo} sem o farmaco em infusao')
        if acao in FORA_DE_CURSO and alvo in linha['farmacosEmUso']:
            erro(f'{acao} de {alvo} com o farmaco ja em infusao')

    # 5. via citada
    citadas = {rota for pat, rota in ROTAS_NA_FALA if re.search(pat, fala)}
    if citadas and entrada is not None:
        alvo = entrada['alvo']
        for rota in citadas:
            if alvo in VIAS and rota in VIAS[alvo]:
                continue
            if entrada['via_duvida'] and rota in VIAS_DO_ESQUEMA:
                continue
            erro(f'via {rota} citada na fala nao esta nas vias de {alvo} ({VIAS.get(alvo)})')

    # 6. cadastro x leitura
    if 'Renal_Cronico' in linha['populacoes'] and tele['TFG'] >= 30:
        erro(f"populacao Renal_Cronico com TFG {tele['TFG']} mL/min, fora do criterio (< 30)")
    if re.search(r'renal cronic|dialise|terapia renal substitutiva', fala) \
            and 'Renal_Cronico' not in linha['populacoes']:
        erro('a fala afirma doenca renal cronica sem a populacao declarada no cadastro')
    imc = re.search(r'imc\s*(?:de\s*|acima de\s*)?(\d+)', fala)
    if imc:
        if 'Obeso_Grave' not in linha['populacoes']:
            erro('a fala cita IMC sem a populacao Obeso_Grave declarada')
        elif int(imc.group(1)) < 40:
            erro(f'IMC {imc.group(1)} citado abaixo do criterio da populacao (acima de 40)')

    # 7. a lacuna e o parametro sem regra nao decidem nada
    if 'qsofa' in fala:
        erro('a fala depende de qSOFA, que a telemetria nao mede (lacuna deliberada)')
    if re.search(r'spo2|satura', fala) and not any(
            a in fala for nome in APELIDOS for a in APELIDOS[nome] if nome in FARMACOS):
        erro('a fala gira em torno de SpO2 sem nomear farmaco: SpO2 nao sustenta decisao no modelo')


# =============================================================================
# 5) Main
# =============================================================================

def main() -> int:
    antigos = [json.loads(l) for l in open(ANTIGOS, encoding='utf-8')]
    if len(antigos) != 200:
        return print(f'esperava 200 cenarios antigos, achei {len(antigos)}') or 1
    if len(NOVOS) != 200:
        return print(f'esperava 200 familias novas, declarei {len(NOVOS)}') or 1

    novos = [construir(e, i) for i, e in enumerate(NOVOS)]
    erros: list[str] = []

    for linha in antigos:
        validar(linha, None, erros)
    for linha, entrada in zip(novos, NOVOS):
        validar(linha, entrada, erros)

    todas = antigos + novos
    falas = [l['intencao'] for l in todas]
    ids = [l['paciente'] for l in todas]
    for valor, rotulo in ((falas, 'intencao'), (ids, 'paciente')):
        vistos = set()
        for v in valor:
            if v in vistos:
                erros.append(f'{rotulo} repetido: {v!r}')
            vistos.add(v)

    if erros:
        print(f'{len(erros)} cenario(s) reprovado(s) na completude:')
        for e in erros[:60]:
            print('  x', e)
        return 1

    with open(SAIDA, 'w', encoding='utf-8') as fh:
        for linha in todas:
            fh.write(json.dumps(linha, ensure_ascii=False) + '\n')

    fams = {}
    for e in NOVOS:
        fams[e['familia']] = fams.get(e['familia'], 0) + 1
    print(f'{len(todas)} cenarios gravados em {os.path.relpath(SAIDA, RAIZ)}')
    print(f'  200 antigos (PT-2026-4001..4200) + 200 novos (PT-2026-4201..4400)')
    print(f'  {len(fams)} familias controladas, todas as 400 linhas aprovadas na completude')
    return 0


if __name__ == '__main__':
    sys.exit(main())
