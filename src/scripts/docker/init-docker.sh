#!/bin/bash

# ============================================================
# Sobe o ambiente Docker COMPLETO do SPC-CML
#
# Equivalente ao:
#   src/scripts/local/init.sh
#
# Diferença:
#   No ambiente Docker, Neo4j e os processos da aplicação
#   ficam isolados nos containers.
#
# Infraestrutura:
#   Neo4j       -> neo4j_cml
#   Aplicação   -> dsl_cml_engine
#
# Motores:
#   medico      -> 8000
#   agro        -> 8001
#   fut         -> 8002
#
# API:
#   4000
#
# Chat:
#   5173
#
# IMPORTANTE:
#   O container dsl_cml_engine é mantido vivo pelo Dockerfile
#   com "tail -f /dev/null". Este script é responsável por
#   preparar e iniciar os processos dentro dele.
# ============================================================

set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$RAIZ"

CONTAINER="dsl_cml_engine"

PORTA_MED=8000
PORTA_AGRO=8001
PORTA_FUT=8002
PORTA_API="${SPC_CML_WEB_PORT:-4000}"
PORTA_CHAT=5173

echo "===================================================="
echo "🐳 Inicializando Ambiente Docker (SPC-CML)..."
echo "===================================================="

# ============================================================
# Funções
# ============================================================

docker_exec() {
    docker exec "$CONTAINER" bash -lc "$1"
}

container_http_ok() {
    docker_exec "curl -sf --max-time 3 '$1' > /dev/null 2>&1"
}

# ============================================================
# 1. Parar ambiente anterior
# ============================================================

echo "[1/7] 🛑 Parando containers antigos..."

docker compose down

echo "   ✅ Ambiente anterior encerrado"

# ============================================================
# 2. Subir infraestrutura
# ============================================================

echo
echo "[2/7] 🏗️ Construindo e subindo containers..."

docker compose up -d --build

echo
echo "Containers iniciados:"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# ============================================================
# 3. Aguardar Neo4j
# ============================================================

echo
echo "[3/7] 🗄️ Aguardando Neo4j..."

for i in $(seq 1 60); do

    if curl -sf --max-time 3 \
        "http://127.0.0.1:7474" > /dev/null 2>&1
    then
        echo "   ✅ Neo4j disponível"
        break
    fi

    if [ "$i" -eq 60 ]; then
        echo "   ❌ Neo4j não respondeu em 120 segundos."
        echo
        docker compose logs --tail 100 neo4j
        exit 1
    fi

    sleep 2
done

# ============================================================
# 4. Aguardar container da aplicação
# ============================================================

echo
echo "[4/7] 🐍 Preparando container $CONTAINER..."

for i in $(seq 1 30); do

    if docker inspect \
        -f '{{.State.Running}}' \
        "$CONTAINER" 2>/dev/null | grep -q true
    then
        echo "   ✅ $CONTAINER está em execução"
        break
    fi

    if [ "$i" -eq 30 ]; then
        echo "   ❌ $CONTAINER não iniciou."
        docker logs --tail 100 "$CONTAINER"
        exit 1
    fi

    sleep 2
done

# ============================================================
# 5. Preparação do projeto dentro do container
# ============================================================

echo
echo "[5/7] ⚙️ Preparando projeto dentro do container..."

docker_exec "
    cd /app

    echo '   → Node'
    node --version

    echo '   → Python'
    python3 --version

    echo '   → Uvicorn'
    command -v uvicorn

    echo '   → Dependências Python'
    python3 -c 'import fastapi, uvicorn, llama_cpp, transformers'

    echo '   → Dependências Node'
    test -d node_modules

    echo '   → Langium'
    if [ ! -d src/generated ]; then
        npm run langium:generate
    fi

    echo '   → TypeScript'
    npx tsc
"

echo "   ✅ Projeto preparado"

# ============================================================
# 6. Subir os três motores
# ============================================================

echo
echo "[6/7] 🧠 Subindo os motores Python..."

# ------------------------------------------------------------
# Função interna executada dentro do container
# ------------------------------------------------------------

subir_motor() {

    local dominio="$1"
    local porta="$2"

    echo
    echo "   → $dominio :$porta"

    docker_exec "
        cd /app

        if curl -sf --max-time 3 \
            http://127.0.0.1:$porta/health > /dev/null 2>&1
        then

            echo '      ✅ já está no ar'

        else

            echo '      → iniciando uvicorn'

            SPC_CML_DOMINIO=$dominio \
            nohup uvicorn main:app \
                --app-dir src/python_engine \
                --host 0.0.0.0 \
                --port $porta \
                > .motor-$dominio.log 2>&1 &

            echo \$! > .motor-$dominio.pid
        fi
    "

    echo "      ⏳ aguardando $dominio..."

    for i in $(seq 1 60); do

        if container_http_ok \
            "http://127.0.0.1:$porta/health"
        then
            echo "      ✅ $dominio pronto"
            return 0
        fi

        sleep 2
    done

    echo
    echo "      ❌ O motor $dominio não respondeu."
    echo
    docker_exec "cat /app/.motor-$dominio.log 2>/dev/null || true"

    exit 1
}

subir_motor "medico" "$PORTA_MED"
subir_motor "agro" "$PORTA_AGRO"
subir_motor "fut" "$PORTA_FUT"

# ============================================================
# Aquecimento dos modelos
# ============================================================

echo
echo "   🔥 Aquecendo modelos..."

aquecer() {

    local dominio="$1"
    local porta="$2"

    echo "      → $dominio"

    if docker_exec "
        curl -sf \
            --max-time 1200 \
            -X POST \
            'http://127.0.0.1:$porta/embed' \
            -H 'Content-Type: application/json' \
            -d '{\"texto\":\"aquecimento\"}'
    " > /dev/null
    then
        echo "         ✅ $dominio aquecido"
    else
        echo "         ⚠️ $dominio não aqueceu"
        echo "         A primeira requisição poderá carregar o modelo."
    fi
}

aquecer "medico" "$PORTA_MED"
aquecer "agro" "$PORTA_AGRO"
aquecer "fut" "$PORTA_FUT"

# ============================================================
# Sincronização dos três grafos
# ============================================================

echo
echo "   🕸️ Sincronizando Knowledge Graphs..."

docker_exec "
    cd /app

    echo '      → Médico'
    npx --yes tsx \
        src/database/neo4j.ts \
        src/examples/med/uti.dsl

    echo
    echo '      → Agro'
    npx --yes tsx \
        src/database/neo4j-agro.ts \
        src/examples/agro/lavoura.agro

    echo
    echo '      → Futebol'
    npx --yes tsx \
        src/database/neo4j-fut.ts \
        src/examples/fut/futebol.fut
"

echo "      ✅ Grafos sincronizados"

# ============================================================
# API Web
# ============================================================

echo
echo "   🌐 Subindo API Web :$PORTA_API..."

docker_exec "
    cd /app

    if curl -sf --max-time 3 \
        http://127.0.0.1:$PORTA_API/api/health \
        > /dev/null 2>&1
    then

        echo '      ✅ API já está no ar'

    else

        SPC_CML_ENDPOINT=http://127.0.0.1:$PORTA_MED \
        SPC_CML_ENDPOINT_AGRO=http://127.0.0.1:$PORTA_AGRO \
        SPC_CML_ENDPOINT_FUT=http://127.0.0.1:$PORTA_FUT \
        SPC_CML_WEB_PORT=$PORTA_API \
        nohup npx --yes tsx src/web/server.ts \
            > .web-api.log 2>&1 &

        echo \$! > .web-api.pid
    fi
"

echo "      ⏳ aguardando API..."

for i in $(seq 1 45); do

    if container_http_ok \
        "http://127.0.0.1:$PORTA_API/api/health"
    then
        echo "      ✅ API pronta"
        break
    fi

    if [ "$i" -eq 45 ]; then
        echo "      ❌ API não respondeu."
        docker_exec "cat /app/.web-api.log 2>/dev/null || true"
        exit 1
    fi

    sleep 2
done

# ============================================================
# Chat Vue
# ============================================================

echo
echo "   💬 Subindo Chat Vue :$PORTA_CHAT..."

docker_exec "
    cd /app

    if [ -d web-chat ]; then

        if [ ! -d web-chat/node_modules ]; then
            echo '      → instalando dependências do Vue'
            npm --prefix web-chat install
        fi

        if curl -sf --max-time 3 \
            http://127.0.0.1:$PORTA_CHAT \
            > /dev/null 2>&1
        then

            echo '      ✅ Chat já está no ar'

        else

            nohup npm --prefix web-chat run dev \
                -- \
                --host 0.0.0.0 \
                --port $PORTA_CHAT \
                --strictPort \
                > .web-chat.log 2>&1 &

            echo \$! > .web-chat.pid
        fi

    else
        echo '      ⚠️ web-chat não encontrado'
    fi
"

if docker_exec "[ -d /app/web-chat ]"; then

    echo "      ⏳ aguardando Chat..."

    for i in $(seq 1 45); do

        if container_http_ok \
            "http://127.0.0.1:$PORTA_CHAT"
        then
            echo "      ✅ Chat pronto"
            break
        fi

        if [ "$i" -eq 45 ]; then
            echo "      ⚠️ Chat não respondeu."
            docker_exec "cat /app/.web-chat.log 2>/dev/null || true"
            break
        fi

        sleep 2
    done
fi

# ============================================================
# Validação final
# ============================================================

echo
echo "===================================================="
echo "🔎 Validando ambiente Docker"
echo "===================================================="

echo
echo "Containers:"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo
echo "Motores:"

for item in \
    "medico:$PORTA_MED" \
    "agro:$PORTA_AGRO" \
    "fut:$PORTA_FUT"
do

    dominio="${item%%:*}"
    porta="${item##*:}"

    if container_http_ok \
        "http://127.0.0.1:$porta/health"
    then
        echo "   ✅ $dominio :$porta"
    else
        echo "   ❌ $dominio :$porta"
    fi
done

echo
echo "API:"

if container_http_ok \
    "http://127.0.0.1:$PORTA_API/api/health"
then
    echo "   ✅ API :$PORTA_API"
else
    echo "   ❌ API :$PORTA_API"
fi

echo
echo "Neo4j:"

if curl -sf --max-time 3 \
    http://127.0.0.1:7474 > /dev/null 2>&1
then
    echo "   ✅ Neo4j :7474"
else
    echo "   ❌ Neo4j :7474"
fi

echo
echo "===================================================="
echo "✅ Ambiente Docker SPC-CML pronto!"
echo "===================================================="
echo
echo "   Neo4j Browser : http://localhost:7474"
echo "   Neo4j Bolt    : bolt://localhost:7687"
echo
echo "   Médico        : http://localhost:$PORTA_MED/health"
echo "   Agro          : http://localhost:$PORTA_AGRO/health"
echo "   Futebol       : http://localhost:$PORTA_FUT/health"
echo
echo "   API           : http://localhost:$PORTA_API/api/health"
echo "   Chat          : http://localhost:$PORTA_CHAT"
echo
echo "   Deploy médico : bash src/scripts/docker/deploy-docker-med.sh"
echo "   Deploy agro   : bash src/scripts/docker/deploy-docker-agro.sh"
echo "   Deploy fut    : bash src/scripts/docker/deploy-docker-fut.sh"
echo
echo "===================================================="