#!/usr/bin/env bash
# Умная вставка/замена системного блока в файле workspace без затирания остального.
#
#   merge-workspace-block.sh <file> <block-id> <block-body-file>
#
# Маркеры в <file>:
#   <!-- MSB-SYSTEM-BLOCK:id -->
#   ...
#   <!-- /MSB-SYSTEM-BLOCK:id -->
#
# Если блока нет — дописывается в конец файла. Если есть — содержимое между маркерами
# заменяется. Текст вне маркеров не меняется.
set -euo pipefail

FILE="${1:?file}"
BLOCK_ID="${2:?block-id}"
BODY_FILE="${3:?body-file}"

[[ -f "$BODY_FILE" ]] || { echo "нет body: $BODY_FILE" >&2; exit 1; }
[[ "$BLOCK_ID" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "плохой block-id" >&2; exit 1; }

START="<!-- MSB-SYSTEM-BLOCK:${BLOCK_ID} -->"
END="<!-- /MSB-SYSTEM-BLOCK:${BLOCK_ID} -->"
BODY="$(cat "$BODY_FILE")"
BLOCK="${START}
${BODY}
${END}"

if [[ ! -f "$FILE" ]]; then
  printf '%s\n' "$BLOCK" >"$FILE"
  echo "created $FILE with block $BLOCK_ID"
  exit 0
fi

python3 - "$FILE" "$START" "$END" "$BLOCK" <<'PY'
import sys
from pathlib import Path
path, start, end, block = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
text = Path(path).read_text(encoding="utf-8")
s, e = text.find(start), text.find(end)
if s == -1 or e == -1 or e < s:
    if not text.endswith("\n"):
        text += "\n"
    text = text + "\n" + block + "\n"
    Path(path).write_text(text, encoding="utf-8")
    print(f"appended block to {path}")
else:
    e2 = e + len(end)
    new = text[:s] + block + text[e2:]
    Path(path).write_text(new, encoding="utf-8")
    print(f"replaced block in {path}")
PY
