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

# Tenta acessar a documentação automática do FastAPI (/docs) silenciosamente
if curl -s http://127.0.0.1:8000/docs > /dev/null; then
    echo "   ✅ Motor Python já está rodando!"
else
    echo "   ⚠️  Motor inativo. Iniciando 'uvicorn' em segundo plano..."
    
    # Caminho corrigido para src/python_engine
    cd src/python_engine

    # Garante que todas as dependências declaradas no requirements.txt estejam instaladas.
    # O pip é idempotente: pacotes já instalados e compatíveis não são reinstalados.
    if [ -f requirements.txt ]; then
        echo "   📦 Verificando dependências do Python..."
        python3 -m pip install -r requirements.txt
        echo "   ✅ Dependências do Python verificadas!"
    else
        echo "   ⚠️  requirements.txt não encontrado em src/python_engine."
        exit 1
    fi

    # Inicia a API no background e redireciona os logs de inicialização
    python3 -m uvicorn main:app --port 8000 > /dev/null 2>&1 &

    # Volta para a raiz do projeto (dsl-project)
    cd ../..

    # Aguarda a API ficar realmente disponível
    echo "   ⏳ Aguardando o motor Python ficar disponível..."
    for i in {1..30}; do
        if curl -s http://127.0.0.1:8000/docs > /dev/null; then
            echo "   ✅ Motor Python pronto!"
            break
        fi

        if [ "$i" -eq 30 ]; then
            echo "   ❌ Motor Python não ficou disponível após 30 segundos."
            exit 1
        fi

        sleep 1
    done
fi

# Dispara o cliente de lote
npx tsx src/inference/batch-client.ts src/examples/prompt.txt

echo "===================================================="
echo "✅ Deploy e Inferência Restrita Finalizados!"
echo "===================================================="