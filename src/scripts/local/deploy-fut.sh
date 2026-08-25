#!/bin/bash

# Encerra o script imediatamente se algum comando falhar
set -e

cd "$(dirname "$0")/../../.."
source src/scripts/lib-motor.sh

echo "===================================================="
echo "🥅 Deploy do Esquema de Controle — DOMÍNIO DE ARBITRAGEM"
echo "   (SPC-CML / futebol — futebol.fut)"
echo "===================================================="

# 1. Gera os parsers e a AST do Langium (as três linguagens)
echo "[1/5] ⚙️  Gerando artefatos gramaticais do Langium..."
npm run langium:generate

# 2. Verifica/Gera a compilação do TypeScript
echo "[2/5] 🔨 Compilando o projeto TypeScript..."
npx tsc

# 3. Deriva a BNF do modelo de arbitragem — mesma máquina de extração dos outros dois domínios
echo "[3/5] 📐 Derivando a BNF do modelo de arbitragem..."
npx --yes tsx src/cli/export-bnf-fut.ts src/examples/fut/futebol.fut \
    src/python_engine/grammar/futebol.bnf > /dev/null
echo "   ✅ src/python_engine/grammar/futebol.bnf"

# 4. Aciona o mapeamento do modelo para o Neo4j
echo "[4/5] 🕸️  Ancorando modelo no Neo4j..."
npx --yes tsx src/database/neo4j-fut.ts src/examples/fut/futebol.fut

# 5. Executa a inferência em lote gerenciando o motor Python
echo "[5/5] 🧠 Inspecionando prompts do árbitro com Grammar Prompting..."
subir_motor fut

npx --yes tsx src/inference/fut-client.ts src/examples/fut/cenarios-fut.jsonl

echo "===================================================="
echo "✅ Deploy e Inferência Restrita Finalizados (arbitragem)!"
echo "===================================================="
