#!/bin/bash

# Derruba o ambiente local do SPC-CML que src/scripts/local/init.sh subiu.
#
# Le os PIDs gravados em .run/*.pid e mata a ARVORE de cada um, nao so o pai:
# `npm run dev` cria o vite como filho e `npx tsx` cria o node do server.ts —
# matar apenas o pai deixaria as portas 5173/4000 presas, e a proxima subida
# falharia com "port already in use" sem processo visivel para culpar.
#
# Depois confere as portas do ambiente. Por padrao so AVISA se alguma ainda
# estiver ocupada (pode ser outro programa seu); com --forcar, mata quem escuta.
#
# O Neo4j nao e tocado — init.sh nao o sobe. Para pará-lo:
#   docker compose stop neo4j
#
# Uso (a partir de qualquer diretorio):
#   bash src/scripts/local/down.sh             derruba o que init.sh subiu
#   bash src/scripts/local/down.sh --forcar    idem, e libera as portas a forca

set -euo pipefail

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$raiz"

EXEC_DIR=".run"

PORTA_MED=8000
PORTA_AGRO=8001
PORTA_FUT=8002
PORTA_API="${SPC_CML_WEB_PORT:-4000}"
PORTA_CHAT=5173

forcar=0

for arg in "$@"; do
    case "$arg" in
        --forcar) forcar=1 ;;
        *)
            echo "argumento desconhecido: $arg"
            echo "uso: bash src/scripts/local/down.sh [--forcar]"
            exit 1
            ;;
    esac
done

# Coleta pai + descendentes (filhos primeiro), para que nenhum neto seja
# re-parentado ao init antes de ser morto.
arvore() {
    local pid="$1" filho
    for filho in $(pgrep -P "$pid" 2> /dev/null || true); do
        arvore "$filho"
    done
    echo "$pid"
}

matar_arvore() {
    local pid="$1" pids p i

    if command -v taskkill > /dev/null 2>&1; then
        taskkill //PID "$pid" //T //F > /dev/null 2>&1 || true
        return 0
    fi

    pids="$(arvore "$pid")"
    # shellcheck disable=SC2086
    kill $pids 2> /dev/null || true

    # Ate 10 s para o uvicorn/vite encerrarem limpo; depois, SIGKILL.
    for i in $(seq 1 20); do
        local vivos=0
        for p in $pids; do
            kill -0 "$p" 2> /dev/null && vivos=1
        done
        [ "$vivos" -eq 0 ] && return 0
        sleep 0.5
    done
    # shellcheck disable=SC2086
    kill -9 $pids 2> /dev/null || true
}

echo "===================================================="
echo "🛑 Derrubando o ambiente local do SPC-CML"
echo "===================================================="

# ---------------------------------------------------------------- 1. pids
echo "[1/2] 📄 Processos registrados em $EXEC_DIR/..."
encontrou=0
for arquivo in "$EXEC_DIR"/*.pid; do
    [ -e "$arquivo" ] || continue
    nome="$(basename "$arquivo" .pid)"
    pid="$(cat "$arquivo")"
    if [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null; then
        echo "   🛑 $nome (PID $pid)"
        matar_arvore "$pid"
        encontrou=1
    fi
    rm -f "$arquivo"
done
[ "$encontrou" -eq 1 ] || echo "   (nada que init.sh tenha subido estava no ar)"

# ---------------------------------------------------------------- 2. portas
echo "[2/2] 🔌 Conferindo as portas..."

pids_na_porta() {
    if command -v lsof > /dev/null 2>&1; then
        lsof -t -iTCP:"$1" -sTCP:LISTEN 2> /dev/null || true
    elif command -v fuser > /dev/null 2>&1; then
        fuser "$1/tcp" 2> /dev/null | tr -s ' ' '\n' | sed '/^$/d' || true
    fi
}

ocupadas=0
for par in "motor-medico:$PORTA_MED" "motor-agro:$PORTA_AGRO" "motor-fut:$PORTA_FUT" \
           "web-api:$PORTA_API" "web-chat:$PORTA_CHAT"; do
    nome="${par%%:*}"
    porta="${par##*:}"
    pids="$(pids_na_porta "$porta")"
    [ -n "$pids" ] || continue

    if [ "$forcar" -eq 1 ]; then
        for pid in $pids; do
            echo "   🛑 porta $porta ($nome) — PID $pid ($(ps -o comm= -p "$pid" 2> /dev/null || echo '?'))"
            matar_arvore "$pid"
        done
    else
        echo "   ⚠️  porta $porta ($nome) ainda ocupada por PID $(echo $pids | tr '\n' ' ')"
        ocupadas=1
    fi
done

if [ "$ocupadas" -eq 1 ]; then
    echo
    echo "   Esses processos nao foram subidos por init.sh (ou o .pid se perdeu)."
    echo "   Para liberar as portas mesmo assim:"
    echo "       bash src/scripts/local/down.sh --forcar"
else
    echo "   ✅ portas $PORTA_MED, $PORTA_AGRO, $PORTA_FUT, $PORTA_API e $PORTA_CHAT livres"
fi

echo
echo "✅ Pronto. O Neo4j nao e tocado — para parar: docker compose stop neo4j"
