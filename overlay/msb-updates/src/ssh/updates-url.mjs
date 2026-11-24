function shSingle(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function buildUpdatesUrlScript(baseUrl) {
  const url = shSingle(String(baseUrl || '').trim().replace(/\/$/, ''));
  return `#!/bin/bash
set -euo pipefail
URL=${url}
if [ -z "$URL" ]; then
  echo MSB_UPDATES_URL_EMPTY
  exit 1
fi
id client >/dev/null 2>&1 || { echo MSB_UPDATES_URL_NO_CLIENT; exit 1; }
install -d -m 700 -o client -g client /home/client/.msb
envf=/home/client/.msb/.env
touch "$envf"
python3 - "$URL" "$envf" <<'PY'
import sys
from pathlib import Path
url, path = sys.argv[1], Path(sys.argv[2])
lines = path.read_text().splitlines() if path.exists() else []
found = False
out = []
for line in lines:
    if line.startswith("MSB_UPDATES_URL="):
        out.append("MSB_UPDATES_URL=" + url)
        found = True
    else:
        out.append(line)
if not found:
    out.append("MSB_UPDATES_URL=" + url)
path.write_text("\\n".join(out) + "\\n")
PY
chown client:client "$envf"
chmod 600 "$envf"
echo MSB_UPDATES_URL_SET
`;
}
