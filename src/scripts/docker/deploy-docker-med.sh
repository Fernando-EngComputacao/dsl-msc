#!/bin/bash

# Roda o deploy do dominio clinico DENTRO do container ja preparado por
# init-docker.sh. Reaproveita src/scripts/local/deploy-med.sh em vez de
# duplicar o pipeline: dentro do container o uvicorn esta instalado
# globalmente via pip (ver Dockerfile) e cai no mesmo `command -v uvicorn`
# que o script local usa no host com o venv ativado — o mesmo script funciona
# nos dois lugares sem alteracao.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../../.."

docker exec -it dsl_cml_engine bash src/scripts/local/deploy-med.sh "$@"
