from fastapi import FastAPI
from pydantic import BaseModel
import os
import sys
from unittest.mock import MagicMock

# --- MOCK: Engana o Python para ignorar pacotes inúteis e quebrados ---
sys.modules['pyairports'] = MagicMock()
sys.modules['pyairports.airports'] = MagicMock()
sys.modules['pycountry'] = MagicMock() # Previne o mesmo erro com países

# --- CORREÇÃO DO CAMINHO ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)
sys.path.insert(0, os.path.join(BASE_DIR, 'src'))

# Imports da sua dissertação
from bnf import load_bnf, build_parser, to_lark
from grammar_from_kg import gramatica_do_subgrafo
from prompt_builder import carregar_exemplos, montar_prompt

# Agora o outlines vai carregar perfeitamente!
import outlines

# 1. Carrega a gramática completa G (Fonte única de verdade)
rules = load_bnf("grammar/advanced_icu.bnf")
parser = build_parser(rules, start="plano")

# 2. Carrega os exemplos few-shot, gerando G[y] automaticamente
exemplos = carregar_exemplos("data/exemplos_icu.jsonl", rules, parser)

# 3. Carrega o LLM local para a Decodificação Restrita
# Carrega um LLM leve, aberto e focado em instruções/estruturas
model = outlines.models.transformers("Qwen/Qwen2.5-0.5B-Instruct")

class ICURequest(BaseModel):
    comando_humano: str
    contexto_neo4j: str
    subgrafo_regras: dict  # Ex: {"acoes_permitidas": ["MANTER_BLOQUEADO"], "farmacos_liberados": ["Propofol"]}

@app.post("/generate-constrained")
async def generate_constrained(req: ICURequest):
    # A MÁGICA DA SUA TESE: 
    # Em vez do LLM prever a gramática (com chance de erro), recuperamos Ĝ do subgrafo!
    g_hat = gramatica_do_subgrafo(req.subgrafo_regras, rules)
    
    # Converte G_hat ancorada em fatos para formato Lark (usado pelo Outlines)
    from lark import Lark
    lark_grammar = to_lark(load_bnf("grammar/advanced_icu.bnf")) # ou g_hat se o outlines suportar dynamic
    
    # Monta o prompt com instruções, exemplos e o contexto do paciente
    prompt = montar_prompt(
        exemplos=exemplos,
        x_teste=req.comando_humano,
        contexto_teste=req.contexto_neo4j,
        gramatica_completa=g_hat # Passa G_hat para guiar o raciocinio do LLM
    )
    
    # Executa a decodificação restrita (mascaramento de logits)
    generator = outlines.generate.cfg(model, lark_grammar)
    resultado = generator(prompt)
    
    return {"resultado": resultado, "g_hat_utilizada": g_hat}