#!/bin/bash

# Subida e verificacao do motor Python, compartilhada pelos dois dominios.
#
# Fica em arquivo proprio porque deploy-med.sh e deploy-agro.sh precisam do MESMO
# comportamento: um health check que distingue "porta aberta" de "motor pronto",
# deteccao de uvicorn morto e aviso de carga preguicosa do modelo. Duplicar isso
# faria as correcoes divergirem no primeiro ajuste.
#
# Uso:  subir_motor <dominio>      # dominio: medico | agro | fut

API="${SPC_CML_ENDPOINT:-http://127.0.0.1:8000}"
PID_FILE="src/python_engine/uvicorn.pid"

# /health responde sem o modelo carregado; /docs so provava que a porta estava
# aberta — e sob Docker o proxy mantem a 8000 escutando mesmo com o uvicorn morto,
# o que fazia um motor ausente passar por motor pronto.
motor_no_ar() { curl -sf --max-time 3 "$API/health" > /dev/null 2>&1; }

dominio_no_ar() {
    curl -sf --max-time 3 "$API/health" 2> /dev/null | grep -q "\"dominio\":\"$1\""
}

subir_motor() {
    local dominio="$1"

    echo "   🔍 Verificando status da API Python na porta 8000..."

    if motor_no_ar; then
        if dominio_no_ar "$dominio"; then
            echo "   ✅ Motor Python já está rodando no domínio '$dominio'!"
            return 0
        fi
        # O motor carrega gramatica e exemplares na importacao do modulo: trocar de
        # dominio exige reiniciar o processo, nao apenas mudar a variavel.
        echo "   ⚠️  Motor no ar em OUTRO domínio. Encerrando para recarregar como '$dominio'..."

        # Por PID, e nao por pkill/fuser: a imagem nao traz procps nem psmisc, e um
        # `pkill || true` falharia calado — deixando no ar o motor do dominio errado
        # para gerar com a gramatica errada, que e pior do que nao gerar.
        if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2> /dev/null; then
            kill "$(cat "$PID_FILE")" 2> /dev/null || true
            rm -f "$PID_FILE"
            sleep 3
        fi

        if motor_no_ar && ! dominio_no_ar "$dominio"; then
            echo "   ❌ Não consegui encerrar o motor do outro domínio."
            echo "      (processo iniciado fora deste script, sem PID registrado)"
            echo
            echo "      Reinicie o container e rode de novo:"
            echo "          docker restart dsl_cml_engine"
            echo
            exit 1
        fi
    fi

    if ! command -v uvicorn > /dev/null 2>&1; then
        echo "   ❌ 'uvicorn' não existe neste ambiente."
        echo
        echo "   Ou ative o venv local (README secao 6.5), ou rode via Docker:"
        echo
        local script_dominio
        case "$dominio" in
            medico) script_dominio=med ;;
            *) script_dominio="$dominio" ;;
        esac
        echo "       bash src/scripts/docker/deploy-docker-$script_dominio.sh"
        echo
        exit 1
    fi

    echo "   ⚠️  Iniciando 'uvicorn' no domínio '$dominio' em segundo plano..."

    cd src/python_engine
    SPC_CML_DOMINIO="$dominio" \
        uvicorn main:app --host 0.0.0.0 --port 8000 > uvicorn.log 2>&1 &
    local pid=$!
    cd ../..
    echo "$pid" > "$PID_FILE"

    # Espera pelo estado real em vez de dormir um tempo fixo: importar o modulo
    # compila a gramatica e os exemplares few-shot, e isso nao cabe num sleep 15.
    echo "   ⏳ Aguardando o motor responder em $API/health ..."
    local i
    for i in $(seq 1 60); do
        if motor_no_ar; then
            echo "   ✅ Motor Python pronto no domínio '$dominio'!"
            break
        fi
        if ! kill -0 "$pid" 2> /dev/null; then
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

    # Os pesos so materializam no primeiro uso (get_llama em main.py). Sem este
    # aviso, o download acontece dentro da primeira inferencia e o lote parece
    # travado no cenario 1.
    if curl -sf --max-time 3 "$API/health" | grep -q '"modelo_carregado":false'; then
        echo "   ℹ️  LLM ainda não está em memória; a 1ª inferência vai carregá-lo"
        echo "      (baixa o GGUF do Hugging Face na primeira vez e pode demorar)."
    fi
}
