#!/bin/bash

# O deploy foi dividido por domínio. Este script permanece apenas para não quebrar
# quem tinha o caminho antigo memorizado, e encaminha para o domínio clínico —
# que era o que ele fazia.

cd "$(dirname "$0")/../.."

echo "===================================================="
echo "ℹ️  O deploy agora é separado por domínio:"
echo
echo "      src/scripts/deploy-med.sh    clínico  (uti.dsl)"
echo "      src/scripts/deploy-agro.sh   agrícola (lavoura.agro)"
echo
echo "   Encaminhando para o clínico..."
echo "===================================================="
echo

exec bash src/scripts/deploy-med.sh "$@"
