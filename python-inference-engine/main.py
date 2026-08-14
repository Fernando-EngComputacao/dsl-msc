from fastapi import FastAPI
from pydantic import BaseModel
import outlines

app = FastAPI()

# Carregamento do modelo em memória (ocorre apenas uma vez ao subir a API)
# Use o modelo que preferir (Llama-3, Mistral, etc.)
model = outlines.models.transformers("meta-llama/Meta-Llama-3-8B-Instruct")

class InferenceRequest(BaseModel):
    prompt: str
    ebnf_grammar: str

@app.post("/generate-constrained")
async def generate_constrained(request: InferenceRequest):
    # 1. O Outlines compila a gramática BNF recebida do TypeScript
    generator = outlines.generate.cfg(model, request.ebnf_grammar)
    
    # 2. O LLM gera a resposta mascarando os logits para obedecer à gramática
    validated_output = generator(request.prompt)
    
    return {"status": "success", "output": validated_output}

# Para rodar: uvicorn main:app --port 8000