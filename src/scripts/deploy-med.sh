#!/bin/bash

# Encerra o script imediatamente se algum comando falhar
set -e

cd "$(dirname "$0")/../.."
source src/scripts/lib-motor.sh

echo "===================================================="
echo "🚀 Deploy do Esquema de Controle — DOMÍNIO CLÍNICO"
echo "   (SPC-CML / UTI — uti.dsl)"
echo "===================================================="

# 1. Gera os parsers e a AST do Langium (ambas as linguagens)
echo "[1/5] ⚙️  Gerando artefatos gramaticais do Langium..."
npm run langium:generate

# 2. Verifica/Gera a compilação do TypeScript
echo "[2/5] 🔨 Compilando o projeto TypeScript..."
npx tsc

# 3. Deriva a BNF do modelo clínico — a gramática nao e mantida a mao
echo "[3/5] 📐 Derivando a BNF do modelo clínico..."
npx --yes tsx src/cli/export-bnf.ts src/examples/med/uti.dsl \
    src/python_engine/grammar/advanced_icu.bnf > /dev/null
echo "   ✅ src/python_engine/grammar/advanced_icu.bnf"

# 4. Aciona o mapeamento do modelo para o Neo4j
echo "[4/5] 🕸️  Ancorando modelo no Neo4j..."
npx --yes tsx src/database/neo4j.ts src/examples/med/uti.dsl

# 5. Executa a inferência em lote gerenciando o motor Python
echo "[5/5] 🧠 Inspecionando prompts do usuário com Grammar Prompting..."
subir_motor medico

npx --yes tsx src/inference/batch-client.ts src/examples/med/cenarios.jsonl

echo "===================================================="
echo "✅ Deploy e Inferência Restrita Finalizados (clínico)!"
echo "===================================================="
