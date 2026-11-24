#!/usr/bin/env bash
set -euo pipefail
HOST="${1:?usage: deploy-to-host.sh <ssh-host>}"
REMOTE_ROOT="${REMOTE_ROOT:-$HOME/msb-updates}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

SSH=(ssh -o BatchMode=yes)
if [[ -n "${SSH_PROXY_JUMP:-}" ]]; then
  SSH+=(-J "$SSH_PROXY_JUMP")
fi

"${SSH[@]}" "$HOST" "mkdir -p '$REMOTE_ROOT'/{app,data,deploy}"

tar -C "$ROOT" --exclude=node_modules --exclude=data-runtime --exclude=.git -czf - . \
  | "${SSH[@]}" "$HOST" "rm -rf '$REMOTE_ROOT/app' && mkdir -p '$REMOTE_ROOT/app' && tar -C '$REMOTE_ROOT/app' -xzf -"

if [[ -d /tmp/msb-updates-data ]]; then
  tar -C /tmp/msb-updates-data -czf - . \
    | "${SSH[@]}" "$HOST" "mkdir -p '$REMOTE_ROOT/data' && tar -C '$REMOTE_ROOT/data' -xzf -"
fi

"${SSH[@]}" "$HOST" "PUBLIC_BASE_URL=$(printf %q "${PUBLIC_BASE_URL:-}") PORT=$(printf %q "${PORT:-}") bash -s" <<EOF
set -euo pipefail
cd '$REMOTE_ROOT/app'
npm install --omit=dev
mkdir -p '$REMOTE_ROOT'
if [[ ! -f '$REMOTE_ROOT/env' ]]; then
  cp deploy/env.example '$REMOTE_ROOT/env'
  {
    echo "MSB_UPDATES_DATA=$REMOTE_ROOT/data"
    echo "HUB_EGRESS_IPS=127.0.0.1"
    echo "BOT_MODE=polling"
  } >> '$REMOTE_ROOT/env'
fi
python3 - "$REMOTE_ROOT/env" "\${PUBLIC_BASE_URL}" "\${PORT}" <<'PY'
import sys
from pathlib import Path
path, base, port = Path(sys.argv[1]), sys.argv[2].strip().rstrip("/"), sys.argv[3].strip()
lines = path.read_text().splitlines() if path.exists() else []
updates = {}
if base:
    updates["PUBLIC_BASE_URL"] = base
if port:
    updates["PORT"] = port
found = set()
out = []
for line in lines:
    key = line.split("=", 1)[0]
    if key in updates:
        out.append(key + "=" + updates[key])
        found.add(key)
    else:
        out.append(line)
for key, value in updates.items():
    if key not in found:
        out.append(key + "=" + value)
path.write_text("\\n".join(out) + "\\n")
path.chmod(0o600)
PY
# systemd user unit
mkdir -p ~/.config/systemd/user
cp deploy/msb-updates.service ~/.config/systemd/user/
# fix EnvironmentFile path already uses %h/msb-updates/env
systemctl --user daemon-reload
systemctl --user enable --now msb-updates.service
systemctl --user restart msb-updates.service
sleep 1
systemctl --user status msb-updates.service --no-pager -l | head -25
listen_port=\$(awk -F= '\$1=="PORT"{print \$2}' "$REMOTE_ROOT/env" | tail -1)
curl -fsS "http://127.0.0.1:\${listen_port:-8787}/healthz" || true
echo
# try docker if available
if command -v docker >/dev/null 2>&1; then
  echo 'docker available — compose can be used later'
else
  echo 'docker: not installed (running via systemd --user)'
fi
EOF
