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
npx --yes tsx src/database/neo4j.ts src/examples/uti.dsl

# 4. Executa a inferência em lote gerenciando o motor Python
echo "[4/4] 🧠 Inspecionando prompts do usuário com Grammar Prompting..."

API="${SPC_CML_ENDPOINT:-http://127.0.0.1:8000}"

# /health responde sem GPU e sem os pesos carregados; /docs so provava que a porta
# estava aberta — e sob Docker o proxy mantem a 8000 escutando mesmo com o uvicorn
# morto, o que fazia um motor ausente passar por motor pronto.
motor_no_ar() { curl -sf --max-time 3 "$API/health" > /dev/null 2>&1; }

echo "   🔍 Verificando status da API Python na porta 8000..."

if motor_no_ar; then
    echo "   ✅ Motor Python já está rodando!"
else
    if ! command -v uvicorn > /dev/null 2>&1; then
        echo "   ❌ 'uvicorn' não existe neste ambiente."
        echo
        echo "   As dependências Python (uvicorn/outlines/torch) vivem no container,"
        echo "   não no host Windows. Rode o deploy de dentro dele:"
        echo
        echo "       docker exec -it dsl_cml_engine bash src/scripts/deploy.sh"
        echo
        exit 1
    fi

    echo "   ⚠️  Motor inativo. Iniciando 'uvicorn' em segundo plano..."

    cd src/python_engine

    # Inicia a API no host 0.0.0.0 (padrão de redes Docker)
    uvicorn main:app --host 0.0.0.0 --port 8000 > uvicorn.log 2>&1 &
    UVICORN_PID=$!

    cd ../..

    # Espera pelo estado real em vez de dormir um tempo fixo: importar o modulo
    # compila a gramatica e os exemplares few-shot, e isso nao cabe num sleep 15.
    echo "   ⏳ Aguardando o motor responder em $API/health ..."
    for _ in $(seq 1 60); do
        if motor_no_ar; then
            echo "   ✅ Motor Python pronto!"
            break
        fi
        if ! kill -0 "$UVICORN_PID" 2> /dev/null; then
            echo "   ❌ O uvicorn morreu durante a subida. Log:"
            echo
            sed 's/^/       /' src/python_engine/uvicorn.log
            exit 1
        fi
        sleep 2
    done

    if ! motor_no_ar; then
        echo "   ❌ O motor não respondeu em 120 s. Log:"
        echo
        sed 's/^/       /' src/python_engine/uvicorn.log
        exit 1
    fi
fi

# Os pesos so materializam no primeiro uso (get_model em python_engine/main.py).
# Sem este aviso, o download de ~1 GB acontece dentro da primeira inferencia e o
# lote parece travado no cenario 1.
if curl -sf --max-time 3 "$API/health" | grep -q '"modelo_carregado":false'; then
    echo "   ℹ️  LLM ainda não está em memória; a 1ª inferência vai carregá-lo"
    echo "      (baixa ~1 GB do Hugging Face na primeira vez e pode demorar)."
fi

# Dispara o cliente de lote
npx --yes tsx src/inference/batch-client.ts src/examples/prompt.txt

echo "===================================================="
echo "✅ Deploy e Inferência Restrita Finalizados!"
echo "===================================================="