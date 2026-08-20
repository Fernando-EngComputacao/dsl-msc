#!/bin/bash

# Encerra o script imediatamente se algum comando falhar
set -e

cd "$(dirname "$0")/../.."
source src/scripts/lib-motor.sh

echo "===================================================="
echo "🚁 Deploy do Esquema de Controle — DOMÍNIO AGRÍCOLA"
echo "   (SPC-CML / pulverização por drone — lavoura.agro)"
echo "===================================================="

# 1. Gera os parsers e a AST do Langium (ambas as linguagens)
echo "[1/5] ⚙️  Gerando artefatos gramaticais do Langium..."
npm run langium:generate

# 2. Verifica/Gera a compilação do TypeScript
echo "[2/5] 🔨 Compilando o projeto TypeScript..."
npx tsc

# 3. Deriva a BNF do modelo agrícola — mesma máquina de extração do domínio clínico
echo "[3/5] 📐 Derivando a BNF do modelo agrícola..."
npx --yes tsx src/cli/export-bnf-agro.ts src/examples/agro/lavoura.agro \
    src/python_engine/grammar/agro_drone.bnf > /dev/null
echo "   ✅ src/python_engine/grammar/agro_drone.bnf"

# 4. Aciona o mapeamento do modelo para o Neo4j
echo "[4/5] 🕸️  Ancorando modelo no Neo4j..."
npx --yes tsx src/database/neo4j-agro.ts src/examples/agro/lavoura.agro

# 5. Executa a inferência em lote gerenciando o motor Python
echo "[5/5] 🧠 Inspecionando prompts do operador com Grammar Prompting..."
subir_motor agro

npx --yes tsx src/inference/agro-client.ts src/examples/agro/cenarios-agro.jsonl

echo "===================================================="
echo "✅ Deploy e Inferência Restrita Finalizados (agrícola)!"
echo "===================================================="
