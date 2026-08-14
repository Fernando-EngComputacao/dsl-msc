#!/bin/bash

# Encerra o script imediatamente se algum comando falhar
set -e

echo "===================================================="
echo "🐳 Inicializando Ambiente Docker (SPC-CML)..."
echo "===================================================="

# 1. Para os containers existentes
echo "[1/3] 🛑 Parando containers antigos..."
docker compose down

# 2. Reconstrói e sobe os containers em background
echo "[2/3] 🏗️ Reconstruindo e subindo os containers..."
docker compose up -d --build

# 3. Pequena pausa para garantir que o Neo4j esteja aceitando conexões na porta 7687
echo "⏳ Aguardando 10 segundos para estabilização do banco de dados..."
sleep 10

# 4. Executa o deploy dentro do container Linux recém-criado
echo "[3/3] 🚀 Executando o script de deploy..."
docker exec -it dsl_cml_engine ./src/scripts/deploy.sh

echo "===================================================="
echo "✅ Ambiente Docker inicializado e deploy concluído!"
echo "===================================================="