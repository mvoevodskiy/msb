#!/usr/bin/env bash
# Полная зачистка jarvis-engine → только msb-engine (без закрытых кусков создателя на боксе).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

SOURCE="${1:-$REPO_ROOT}"
ROLLBACK_DIR="/usr/local/lib/msb-engine/rollback"

usage() {
  cat <<'EOF'
Usage: migrate-from-jarvis.sh [source-dir]

  Снимок → rollback/, ставит msb-engine, удаляет jarvis bin/lib/units/pulse/sudoers,
  чистит /run/jarvis-engine и enrollment-маркеры создателя.
EOF
}

[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && { usage; exit 0; }
need_root
[[ -d "$SOURCE/usr-local-lib/msb-engine" ]] || die "нет $SOURCE/usr-local-lib/msb-engine"
[[ -f "$SOURCE/usr-local-sbin/msb-engine" ]] || die "нет $SOURCE/usr-local-sbin/msb-engine"

log "purge jarvis-os → msb-engine (source=$SOURCE)"

run mkdir -p "$ROLLBACK_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAP="$ROLLBACK_DIR/$STAMP"
run mkdir -p "$SNAP/units" "$SNAP/bin" "$SNAP/etc"
if [[ -f /usr/local/sbin/jarvis-engine ]]; then
  run cp -a /usr/local/sbin/jarvis-engine "$SNAP/bin/" || true
fi
if [[ -d /usr/local/lib/jarvis-engine ]]; then
  run cp -a /usr/local/lib/jarvis-engine "$SNAP/lib-jarvis-engine" || true
fi
for u in jarvis-engine.path jarvis-engine.service \
         jarvis-engine-tick.timer jarvis-engine-tick.service \
         jarvis-engine-update.path jarvis-engine-update.service \
         jarvis-engine-nft.service msb-base-pulse.timer msb-base-pulse.service; do
  [[ -f "/etc/systemd/system/$u" ]] && run cp -a "/etc/systemd/system/$u" "$SNAP/units/" || true
done
[[ -f /etc/sudoers.d/jarvis-client ]] && run cp -a /etc/sudoers.d/jarvis-client "$SNAP/etc/" || true
echo "$STAMP" >"$ROLLBACK_DIR/LATEST"
log "snapshot → $SNAP"

# Stop
systemctl stop jarvis-engine.service jarvis-engine-tick.service jarvis-engine-update.service \
  jarvis-engine-nft.service msb-base-pulse.service 2>/dev/null || true
systemctl stop jarvis-engine.path jarvis-engine-tick.timer jarvis-engine-update.path \
  msb-base-pulse.timer 2>/dev/null || true

# Install msb-engine
run install -d -m 0755 /usr/local/sbin /usr/local/lib/msb-engine
run rsync -a --delete --exclude 'rollback/' \
  "$SOURCE/usr-local-lib/msb-engine/" /usr/local/lib/msb-engine/
run install -m 0755 "$SOURCE/usr-local-sbin/msb-engine" /usr/local/sbin/msb-engine
run cp -a /usr/local/sbin/msb-engine /usr/local/lib/msb-engine/msb-engine.good
run chmod 0755 /usr/local/lib/msb-engine/msb-engine.good

for u in msb-engine.path msb-engine.service msb-engine-tick.timer msb-engine-tick.service; do
  run install -m 0644 "$SOURCE/systemd/$u" "/etc/systemd/system/$u"
done
# права агента (не jarvis-*)
run mkdir -p /etc/systemd/system/msb-bot@.service.d
if [[ -f "$SOURCE/systemd/msb-bot@.service.d/90-msb-agent-rights.conf" ]]; then
  run install -m 0644 "$SOURCE/systemd/msb-bot@.service.d/90-msb-agent-rights.conf" \
    /etc/systemd/system/msb-bot@.service.d/90-msb-agent-rights.conf
  rm -f /etc/systemd/system/msb-bot@.service.d/90-jarvis-rights.conf
fi

run install -m 0440 "$SOURCE/etc/sudoers.d/msb-engine" /etc/sudoers.d/msb-engine
visudo -cf /etc/sudoers.d/msb-engine || die "visudo msb-engine"

run mkdir -p /home/client/.msb/engine
run chown client:client /home/client/.msb/engine
run chmod 700 /home/client/.msb/engine

# Disable + remove unit files (не оставляем disabled jarvis на диске)
for u in jarvis-engine.path jarvis-engine.service \
         jarvis-engine-tick.timer jarvis-engine-tick.service \
         jarvis-engine-update.path jarvis-engine-update.service \
         jarvis-engine-nft.service msb-base-pulse.timer msb-base-pulse.service; do
  systemctl disable --now "$u" 2>/dev/null || true
  systemctl mask "$u" 2>/dev/null || true
  rm -f "/etc/systemd/system/$u"
done

rm -f /etc/sudoers.d/jarvis-client
rm -f /usr/local/sbin/jarvis-engine
rm -rf /usr/local/lib/jarvis-engine
rm -rf /run/jarvis-engine
rm -f /etc/jarvis-runtime-enrolled
rm -rf /var/lib/jarvis-runtime
# enrollment/DRM маркеры — если были
rm -f /etc/jarvis-engine/full-rights-off 2>/dev/null || true

systemctl daemon-reload
/usr/bin/python3 -IS /usr/local/lib/msb-engine/cli.py setup
systemctl enable --now msb-engine.path
systemctl enable --now msb-engine-tick.timer

# bot-ctl / watchdog без preflight
run install -m 0755 "$SOURCE/usr-local-bin/bot-ctl.sh" /usr/local/bin/bot-ctl.sh
run install -m 0755 "$SOURCE/usr-local-bin/msb-bot-watchdog.sh" /usr/local/bin/msb-bot-watchdog.sh

log "готово."
systemctl is-enabled msb-engine.path
test ! -e /usr/local/sbin/jarvis-engine && echo "jarvis-engine binary: gone"
test ! -e /etc/systemd/system/jarvis-engine.path && echo "jarvis units: gone from /etc"
/usr/local/sbin/msb-engine status | head -20 || true
echo "Rollback snapshot (ручной): $SNAP — см. docs/runbooks/msb-engine-rollback.md"
