#!/bin/bash

# Sobe o ambiente local COMPLETO do SPC-CML — fora do Docker, tudo no host.
#
# Diferente de src/scripts/docker/init-docker.sh, que reconstroi os containers
# e deixa o motor pronto para os scripts de docker/, este script assume o
# caminho nativo do README (secao 6.5): as dependencias Python vivem num venv
# local e o motor roda direto no host.
#
# Sobe, nesta ordem:
#   Neo4j (apenas verifica)     bolt://localhost:7687
#   motor Python  medico        http://127.0.0.1:8000
#   motor Python  agro          http://127.0.0.1:8001
#   motor Python  fut           http://127.0.0.1:8002
#   API web (node:http)         http://localhost:4000
#   chat Vue (vite)             http://localhost:5173
#
# Sao TRES motores porque main.py fixa a gramatica na importacao do modulo
# (SPC_CML_DOMINIO): os tres dominios que o chat oferece lado a lado nao cabem
# num processo so. server.ts escolhe o endpoint por dominio via
# SPC_CML_ENDPOINT_AGRO / SPC_CML_ENDPOINT_FUT. Os pesos sao os mesmos arquivos
# GGUF nos tres processos, e o llama.cpp os mapeia com mmap — as paginas do
# modelo sao compartilhadas pelo cache do SO, entao o custo de RAM nao triplica.
#
# Ficam ativos ao final tambem para servir de base aos deploys em lote: depois
# deste script, "bash src/scripts/local/deploy-med.sh", "deploy-agro.sh" ou
# "deploy-fut.sh" encontram o motor do dominio certo ja no ar (subir_motor
# detecta e nao reinicia) e vao direto para a inferencia em lote.
#
# Uso (a partir de qualquer diretorio):
#   bash src/scripts/local/init.sh                sobe tudo e deixa os modelos quentes
#   bash src/scripts/local/init.sh --sem-sync      nao re-sincroniza os grafos (subida mais rapida)
#   bash src/scripts/local/init.sh --sem-chat      so a infraestrutura, sem o front Vue
#   bash src/scripts/local/init.sh --parar         derruba tudo que este script subiu

set -euo pipefail

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$raiz"

EXEC_DIR=".run"
PY="venv/Scripts/python.exe"
[ -x "$PY" ] || PY="venv/bin/python"

PORTA_MED=8000
PORTA_AGRO=8001
PORTA_FUT=8002
PORTA_API="${SPC_CML_WEB_PORT:-4000}"
PORTA_CHAT=5173

URL_MED="http://127.0.0.1:$PORTA_MED"
URL_AGRO="http://127.0.0.1:$PORTA_AGRO"
URL_FUT="http://127.0.0.1:$PORTA_FUT"

sincronizar=1
subir_chat=1
apenas_parar=0

for arg in "$@"; do
    case "$arg" in
        --sem-sync) sincronizar=0 ;;
        --sem-chat) subir_chat=0 ;;
        --parar) apenas_parar=1 ;;
        *)
            echo "argumento desconhecido: $arg"
            echo "uso: bash src/scripts/local/init.sh [--sem-sync] [--sem-chat] [--parar]"
            exit 1
            ;;
    esac
done

http_ok() { curl -sf --max-time 3 "$1" > /dev/null 2>&1; }

# Derruba a ARVORE de processos, nao so o pai: `npm run dev` cria o vite como
# filho, e matar apenas o npm deixaria a 5173 presa — a proxima subida falharia
# com um "port already in use" sem processo visivel para culpar.
matar_pid() {
    local pid="$1"
    if command -v taskkill > /dev/null 2>&1; then
        taskkill //PID "$pid" //T //F > /dev/null 2>&1 || true
    else
        kill "$pid" 2> /dev/null || true
    fi
}

parar_tudo() {
    local encontrou=0 arquivo nome pid
    for arquivo in "$EXEC_DIR"/*.pid; do
        [ -e "$arquivo" ] || continue
        nome="$(basename "$arquivo" .pid)"
        pid="$(cat "$arquivo")"
        if kill -0 "$pid" 2> /dev/null; then
            echo "   🛑 $nome (PID $pid)"
            matar_pid "$pid"
            encontrou=1
        fi
        rm -f "$arquivo"
    done
    [ "$encontrou" -eq 1 ] || echo "   (nada que este script tenha subido estava no ar)"
}

if [ "$apenas_parar" -eq 1 ]; then
    echo "===================================================="
    echo "🛑 Derrubando o ambiente local do SPC-CML"
    echo "===================================================="
    parar_tudo
    echo "✅ Pronto. O Neo4j nao e tocado — ele nao e subido por este script."
    exit 0
fi

mkdir -p "$EXEC_DIR"

echo "===================================================="
echo "🚀 Ambiente local do SPC-CML (sem Docker)"
echo "===================================================="

# ---------------------------------------------------------------- 1. pre-requisitos
echo "[1/7] 🔎 Conferindo pre-requisitos..."

if [ ! -x "$PY" ]; then
    echo "   ❌ venv nao encontrado em ./venv"
    echo "      python -m venv venv && venv/Scripts/python.exe -m pip install -r src/requirements.txt"
    exit 1
fi

# llama_cpp e huggingface_hub sao os que faltam com mais frequencia: nao vem no
# `pip install fastapi uvicorn` da secao 5 do README, e sem eles o motor sobe mas
# /embed morre com ImportError — o sintoma vira "no ficara sem vetor", que aponta
# para o lugar errado.
faltando=""
for modulo in uvicorn fastapi lark llama_cpp huggingface_hub; do
    "$PY" -c "import $modulo" > /dev/null 2>&1 || faltando="$faltando $modulo"
done
if [ -n "$faltando" ]; then
    echo "   ❌ faltam modulos Python no venv:$faltando"
    echo "      $PY -m pip install -r src/requirements.txt"
    echo "      (no Windows, llama-cpp-python precisa da wheel pre-compilada:"
    echo "       $PY -m pip install llama-cpp-python --only-binary=:all: \\"
    echo "           --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu)"
    exit 1
fi
echo "   ✅ venv com as dependencias do motor"

[ -d node_modules ] || { echo "   📦 npm install (raiz)..."; npm install; }

# O front e um projeto npm separado (web-chat/package.json) com arvore propria.
if [ "$subir_chat" -eq 1 ] && [ ! -d web-chat/node_modules ]; then
    echo "   📦 npm install (web-chat)..."
    npm --prefix web-chat install
fi

# A BNF e derivada da DSL, e o motor a le na subida — se os artefatos do Langium
# nao existem, export-bnf falha e o motor sobe com a gramatica velha.
[ -d src/generated ] || { echo "   ⚙️  langium generate..."; npm run langium:generate; }
echo "   ✅ dependencias Node e artefatos do Langium"

# ---------------------------------------------------------------- 2. neo4j
echo "[2/7] 🗄️  Verificando o Neo4j..."
if http_ok "http://127.0.0.1:7474"; then
    echo "   ✅ no ar"
else
    echo "   ❌ nao responde em http://127.0.0.1:7474"
    echo
    echo "      Este script nao sobe o banco. Suba SO o servico neo4j:"
    echo "          docker compose up -d neo4j"
    echo
    echo "      (nao use 'docker compose up' sem argumento: o servico cml-app"
    echo "       reserva uma GPU NVIDIA e falha em maquina sem placa dedicada)"
    exit 1
fi

# ---------------------------------------------------------------- 3. gramaticas
echo "[3/7] 📐 Derivando as BNF a partir das DSL..."
npx --yes tsx src/cli/export-bnf.ts src/examples/med/uti.dsl \
    src/python_engine/grammar/advanced_icu.bnf > /dev/null
npx --yes tsx src/cli/export-bnf-agro.ts src/examples/agro/lavoura.agro \
    src/python_engine/grammar/agro_drone.bnf > /dev/null
npx --yes tsx src/cli/export-bnf-fut.ts src/examples/fut/futebol.fut \
    src/python_engine/grammar/futebol.bnf > /dev/null
echo "   ✅ advanced_icu.bnf, agro_drone.bnf e futebol.bnf"

# ---------------------------------------------------------------- 4. motores
subir_motor_local() {
    local dominio="$1" porta="$2" url="$3"
    local nome="motor-$dominio" atual i

    if http_ok "$url/health"; then
        atual="$(curl -sf --max-time 3 "$url/health" | sed -n 's/.*"dominio":"\([^"]*\)".*/\1/p')"
        if [ "$atual" = "$dominio" ]; then
            echo "   ✅ $dominio ja no ar em $url"
            return 0
        fi
        echo "   ❌ a porta $porta tem um motor no dominio '$atual', nao '$dominio'."
        echo "      bash src/scripts/local/init.sh --parar     (ou derrube o processo que ocupa a porta)"
        exit 1
    fi

    # --app-dir em vez de `cd`: main.py resolve gramatica e exemplares por
    # BASE_DIR absoluto, entao o processo nao precisa nascer dentro da pasta —
    # e assim os caminhos relativos do restante do script continuam validos.
    SPC_CML_DOMINIO="$dominio" "$PY" -m uvicorn main:app \
        --app-dir src/python_engine --host 127.0.0.1 --port "$porta" \
        > "$EXEC_DIR/$nome.log" 2>&1 &
    echo $! > "$EXEC_DIR/$nome.pid"
    local pid; pid="$(cat "$EXEC_DIR/$nome.pid")"

    for i in $(seq 1 60); do
        if http_ok "$url/health"; then
            echo "   ✅ $dominio pronto em $url"
            return 0
        fi
        if ! kill -0 "$pid" 2> /dev/null; then
            echo "   ❌ o uvicorn do dominio '$dominio' morreu na subida:"
            sed 's/^/       /' "$EXEC_DIR/$nome.log"
            exit 1
        fi
        sleep 2
    done

    echo "   ❌ o motor '$dominio' nao respondeu em 120 s:"
    sed 's/^/       /' "$EXEC_DIR/$nome.log"
    exit 1
}

echo "[4/7] 🐍 Subindo os motores Python..."
subir_motor_local medico "$PORTA_MED" "$URL_MED"
subir_motor_local agro "$PORTA_AGRO" "$URL_AGRO"
subir_motor_local fut "$PORTA_FUT" "$URL_FUT"

# ---------------------------------------------------------------- 5. aquecimento
# Uma unica chamada a /embed materializa os DOIS modelos: get_embedder carrega o
# LLM principal antes do embedder de proposito (ordem do cudaMalloc, ver
# main.py). E exatamente o que o chat precisa quente — sem isto, a primeira
# mensagem digitada pagaria a carga inteira e pareceria travada.
aquecer() {
    local url="$1" rotulo="$2"
    if curl -sf --max-time 1200 -X POST "$url/embed" \
        -H 'Content-Type: application/json' \
        -d '{"texto":"aquecimento"}' > /dev/null; then
        echo "   ✅ $rotulo (LLM + embedder em memoria)"
    else
        echo "   ⚠️  $rotulo NAO aqueceu — o chat ainda funciona, mas a 1a mensagem sera lenta"
    fi
}

echo "[5/7] 🧠 Aquecendo os modelos (1a carga: pode levar minutos)..."
aquecer "$URL_MED" "medico"
aquecer "$URL_AGRO" "agro"
aquecer "$URL_FUT" "fut"

# ---------------------------------------------------------------- 6. grafos
# Depois do aquecimento, e nao antes: a sincronizacao embute cada no chamando
# /embed, e com o motor frio cada chamada esperaria a carga do modelo.
if [ "$sincronizar" -eq 1 ]; then
    echo "[6/7] 🕸️  Sincronizando os grafos no Neo4j (com vetores)..."
    npx --yes tsx src/database/neo4j.ts src/examples/med/uti.dsl
    npx --yes tsx src/database/neo4j-agro.ts src/examples/agro/lavoura.agro
    npx --yes tsx src/database/neo4j-fut.ts src/examples/fut/futebol.fut
else
    echo "[6/7] ⏭️  Sincronizacao do grafo pulada (--sem-sync)"
fi

# ---------------------------------------------------------------- 7. web
echo "[7/7] 🌐 Subindo a API web e o chat..."

if http_ok "http://127.0.0.1:$PORTA_API/api/health"; then
    echo "   ✅ API ja no ar em http://localhost:$PORTA_API"
else
    SPC_CML_ENDPOINT="$URL_MED" \
    SPC_CML_ENDPOINT_AGRO="$URL_AGRO" \
    SPC_CML_ENDPOINT_FUT="$URL_FUT" \
    SPC_CML_WEB_PORT="$PORTA_API" \
        npx --yes tsx src/web/server.ts > "$EXEC_DIR/web-api.log" 2>&1 &
    echo $! > "$EXEC_DIR/web-api.pid"

    for i in $(seq 1 45); do
        http_ok "http://127.0.0.1:$PORTA_API/api/health" && break
        sleep 2
    done
    if http_ok "http://127.0.0.1:$PORTA_API/api/health"; then
        echo "   ✅ API em http://localhost:$PORTA_API"
    else
        echo "   ❌ a API nao respondeu:"
        sed 's/^/       /' "$EXEC_DIR/web-api.log"
        exit 1
    fi
fi

if [ "$subir_chat" -eq 1 ]; then
    if http_ok "http://127.0.0.1:$PORTA_CHAT"; then
        echo "   ✅ chat ja no ar em http://localhost:$PORTA_CHAT"
    else
        # --strictPort: sem isso o vite escorrega para a proxima porta livre e o
        # endereco impresso aqui apontaria para lugar nenhum.
        npm --prefix web-chat run dev -- --port "$PORTA_CHAT" --strictPort \
            > "$EXEC_DIR/web-chat.log" 2>&1 &
        echo $! > "$EXEC_DIR/web-chat.pid"

        for i in $(seq 1 45); do
            http_ok "http://127.0.0.1:$PORTA_CHAT" && break
            sleep 2
        done
        if http_ok "http://127.0.0.1:$PORTA_CHAT"; then
            echo "   ✅ chat em http://localhost:$PORTA_CHAT"
        else
            echo "   ❌ o vite nao respondeu:"
            sed 's/^/       /' "$EXEC_DIR/web-chat.log"
            exit 1
        fi
    fi
else
    echo "   ⏭️  chat Vue pulado (--sem-chat)"
fi

echo
echo "===================================================="
echo "✅ Tudo pronto para testar"
echo "===================================================="
echo "   Chat            http://localhost:$PORTA_CHAT"
echo "   API             http://localhost:$PORTA_API/api/health"
echo "   Motor medico    $URL_MED/health"
echo "   Motor agro      $URL_AGRO/health"
echo "   Motor fut       $URL_FUT/health"
echo "   Neo4j Browser   http://localhost:7474"
echo
echo "   Logs            $EXEC_DIR/*.log"
echo "   Deploy em lote   bash src/scripts/local/deploy-med.sh  |  deploy-agro.sh  |  deploy-fut.sh"
echo "   Derrubar tudo    bash src/scripts/local/init.sh --parar"
echo "===================================================="
