#!/usr/bin/env bash
# Откат Пульта на коммит до последней выкладки (или на указанный): deploy/rollback.sh [<коммит>]
set -euo pipefail
DATA=/home/client/pult-data
TARGET=${1:-$(cat "$DATA/deploy-previous" 2>/dev/null || true)}
[ -n "$TARGET" ] || { echo "Не знаю, куда откатывать: нет $DATA/deploy-previous. Укажи коммит." >&2; exit 1; }
exec "$(dirname "$0")/deploy.sh" "$TARGET" --skip-check
