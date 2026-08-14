from fastapi import FastAPI
from pydantic import BaseModel
import outlines

app = FastAPI()

# Carregue o modelo local desejado
model = outlines.models.transformers("meta-llama/Meta-Llama-3-8B-Instruct")

class InferenceRequest(BaseModel):
    prompt: str
    ebnf_grammar: str  # A gramática recebida dinamicamente do Node.js

@app.post("/generate-constrained")
async def generate_constrained(req: InferenceRequest):
    # O Outlines compila o EBNF sob demanda
    generator = outlines.generate.cfg(model, req.ebnf_grammar)
    
    # A inferência acontece mascarando os logits inválidos
    resultado_validado = generator(req.prompt)
    return {"resultado": resultado_validado}

# Execute com: uvicorn main:app --port 8000