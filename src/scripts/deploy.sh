#!/bin/bash

# O deploy foi dividido por domínio. Este script permanece apenas para não quebrar
# quem tinha o caminho antigo memorizado, e encaminha para o domínio clínico —
# que era o que ele fazia.

cd "$(dirname "$0")/../.."

echo "===================================================="
echo "ℹ️  O deploy agora é separado por domínio e por ambiente:"
echo
echo "      src/scripts/local/deploy-med.sh           clínico  (host/venv)"
echo "      src/scripts/local/deploy-agro.sh          agrícola (host/venv)"
echo "      src/scripts/docker/deploy-docker-med.sh    clínico  (container)"
echo "      src/scripts/docker/deploy-docker-agro.sh   agrícola (container)"
echo
echo "   Encaminhando para o clínico local..."
echo "===================================================="
echo

exec bash src/scripts/local/deploy-med.sh "$@"
