#!/usr/bin/env bash
# Синхронизация канона msb-pult → вендор-копия .msb/pult
#   ./scripts/sync-pult.sh [/путь/к/msb-pult]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC=${1:-"${MSB_PULT_SRC:-$ROOT/../msb-pult}"}
DST="$ROOT/.msb/pult"
[[ -d "$SRC/src" && -f "$SRC/package.json" ]] || {
  echo "Нет исходников Пульта в $SRC (клон: git@gitflic.ru:mvoevodskiy/msb-pult.git)" >&2
  exit 1
}
mkdir -p "$DST"
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'tests/tmp' \
  --exclude 'concept' \
  "$SRC/" "$DST/"
cat > "$DST/SOURCE.md" <<EOF
# Источник

Канон: \`git@gitflic.ru:mvoevodskiy/msb-pult.git\`
Синхронизировано: $(date -u +%Y-%m-%dT%H:%M:%SZ) из \`$SRC\`

\`\`\`bash
./scripts/sync-pult.sh
\`\`\`
EOF
echo "OK → $DST"
