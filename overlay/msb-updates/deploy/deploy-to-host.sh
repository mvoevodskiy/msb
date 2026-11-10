#!/usr/bin/env bash
set -euo pipefail
HOST="${1:?usage: deploy-to-host.sh <ssh-host>}"
REMOTE_ROOT="${REMOTE_ROOT:-$HOME/msb-updates}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ssh -o BatchMode=yes "$HOST" "mkdir -p '$REMOTE_ROOT'/{app,data,deploy}"

tar -C "$ROOT" --exclude=node_modules --exclude=data-runtime --exclude=.git -czf - . \
  | ssh -o BatchMode=yes "$HOST" "rm -rf '$REMOTE_ROOT/app' && mkdir -p '$REMOTE_ROOT/app' && tar -C '$REMOTE_ROOT/app' -xzf -"

if [[ -d /tmp/msb-updates-data ]]; then
  tar -C /tmp/msb-updates-data -czf - . \
    | ssh -o BatchMode=yes "$HOST" "mkdir -p '$REMOTE_ROOT/data' && tar -C '$REMOTE_ROOT/data' -xzf -"
fi

ssh -o BatchMode=yes "$HOST" bash -s <<EOF
set -euo pipefail
cd '$REMOTE_ROOT/app'
npm install --omit=dev
mkdir -p '$REMOTE_ROOT'
if [[ ! -f '$REMOTE_ROOT/env' ]]; then
  cp deploy/env.example '$REMOTE_ROOT/env'
  {
    echo "MSB_UPDATES_DATA=$REMOTE_ROOT/data"
    echo "PUBLIC_BASE_URL=http://127.0.0.1:8787"
    echo "HUB_EGRESS_IPS=127.0.0.1"
    echo "BOT_MODE=polling"
  } >> '$REMOTE_ROOT/env'
fi
# systemd user unit
mkdir -p ~/.config/systemd/user
cp deploy/msb-updates.service ~/.config/systemd/user/
# fix EnvironmentFile path already uses %h/msb-updates/env
systemctl --user daemon-reload
systemctl --user enable --now msb-updates.service
systemctl --user restart msb-updates.service
sleep 1
systemctl --user status msb-updates.service --no-pager -l | head -25
curl -fsS http://127.0.0.1:8787/healthz || true
echo
# try docker if available
if command -v docker >/dev/null 2>&1; then
  echo 'docker available — compose can be used later'
else
  echo 'docker: not installed (running via systemd --user)'
fi
EOF
