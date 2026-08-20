#!/bin/bash

# Sobe o ambiente Docker do SPC-CML — Neo4j + o container do motor Python
# (dsl_cml_engine), reconstruido do zero.
#
# Diferente de src/scripts/local/init.sh, este script NAO inicia o uvicorn:
# o container sobe "vazio" (ver CMD no Dockerfile) e fica pronto para os
# scripts de docker/ ligarem o motor no dominio desejado. Isso evita escolher
# um dominio por conta propria aqui — quem decide medico ou agro e o script
# de deploy chamado em seguida.
#
# Uso (a partir da raiz do repo):
#   bash src/scripts/docker/init-docker.sh
#   (depois)
#   bash src/scripts/docker/deploy-docker-med.sh
#   bash src/scripts/docker/deploy-docker-agro.sh

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../../.."

echo "===================================================="
echo "🐳 Inicializando Ambiente Docker (SPC-CML)..."
echo "===================================================="

# 1. Para os containers existentes
echo "[1/3] 🛑 Parando containers antigos..."
docker compose down

# 2. Reconstrói e sobe os containers em background
echo "[2/3] 🏗️ Reconstruindo e subindo os containers..."
docker compose up -d --build

# 3. Espera o Neo4j aceitar conexoes antes de liberar o proximo passo — em vez
# de um sleep fixo, que tanto acorda cedo demais (imagem grande, disco lento)
# quanto desperdica tempo (maquina rapida).
echo "[3/3] ⏳ Aguardando o Neo4j responder em http://localhost:7474..."
for i in $(seq 1 30); do
    curl -sf --max-time 3 "http://127.0.0.1:7474" > /dev/null 2>&1 && break
    sleep 2
done
if ! curl -sf --max-time 3 "http://127.0.0.1:7474" > /dev/null 2>&1; then
    echo "   ❌ o Neo4j nao respondeu em 60 s. Confira: docker compose logs neo4j"
    exit 1
fi
echo "   ✅ Neo4j no ar"

echo "===================================================="
echo "✅ Containers no ar — dsl_cml_engine pronto para o deploy"
echo "===================================================="
echo "   Rode agora:"
echo "      bash src/scripts/docker/deploy-docker-med.sh    (clínico)"
echo "      bash src/scripts/docker/deploy-docker-agro.sh   (agrícola)"
echo "===================================================="
