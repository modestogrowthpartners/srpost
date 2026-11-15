#!/usr/bin/env bash
# Empacota cada funcao em um arquivo so (index.js) para publicar. O codigo-fonte continua em api/lib;
# o pacote so remove comentarios (mantem uma instrucao por linha, para leitura e transcricao seguras).
# Dependencias npm: ficam como importacao externa.
# Uso: ESBUILD=/caminho/esbuild ./build.sh [saida]   (padrao: ./dist)
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-dist}"; ESB="${ESBUILD:-esbuild}"
for fn in api agents chat render; do
  "$ESB" "$fn/index.ts" --bundle --format=esm --platform=neutral --target=es2022 --external:'npm:*' \
    --minify-syntax --legal-comments=none --log-level=warning --outfile="$OUT/$fn/index.js"
  printf '%-7s %8d bytes\n' "$fn" "$(wc -c < "$OUT/$fn/index.js")"
done
