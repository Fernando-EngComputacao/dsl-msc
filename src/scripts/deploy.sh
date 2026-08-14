#!/bin/bash

# Encerra o script imediatamente se algum comando falhar
set -e

echo "===================================================="
echo "🚀 Iniciando Deploy do Esquema de Controle (SPC-CML)"
echo "===================================================="

# 1. Gera os parsers e a AST do Langium
echo "[1/4] ⚙️  Gerando artefatos gramaticais do Langium..."
npm run langium:generate

# 2. Verifica/Gera a compilação do TypeScript
echo "[2/4] 🔨 Compilando o projeto TypeScript..."
npx tsc

# 3. Aciona o mapeamento do modelo para o Neo4j
echo "[3/4] 🕸️  Ancorando modelo no Neo4j..."
npx tsx src/database/neo4j.ts src/examples/uti.dsl

# 4. Executa a inferência em lote gerenciando o motor Python
echo "[4/4] 🧠 Inspecionando prompts do usuário com Grammar Prompting..."

echo "   🔍 Verificando status da API Python na porta 8000..."

if curl -s http://127.0.0.1:8000/docs > /dev/null; then
    echo "   ✅ Motor Python já está rodando!"
else
    echo "   ⚠️  Motor inativo. Iniciando 'uvicorn' em segundo plano..."
    
    cd src/python_engine
    
    # Inicia a API no host 0.0.0.0 (padrão de redes Docker)
    uvicorn main:app --host 0.0.0.0 --port 8000 > uvicorn.log 2>&1 &
    
    cd ../..
    
    echo "   ⏳ Carregando LLM na memória (aguardando 15 segundos)..."
    sleep 15
    echo "   ✅ Motor Python pronto!"
fi

# Dispara o cliente de lote
npx tsx src/inference/batch-client.ts src/examples/prompt.txt

echo "===================================================="
echo "✅ Deploy e Inferência Restrita Finalizados!"
echo "===================================================="