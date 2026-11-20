# shellcheck shell=bash
# Общие хелперы bootstrap MSB. Подключается из install.sh / verify.sh.

set -euo pipefail

BOOTSTRAP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$BOOTSTRAP_DIR/.." && pwd)"

CLIENT_USER="${CLIENT_USER:-client}"
CLIENT_HOME="${CLIENT_HOME:-/home/$CLIENT_USER}"
MSB_HOME="${MSB_HOME:-$CLIENT_HOME/.msb}"
WORKSPACE="${WORKSPACE:-$CLIENT_HOME/workspace}"
PROJECTS="${PROJECTS:-$CLIENT_HOME/projects}"
ADMIN_USER="${ADMIN_USER:-msb-admin}"

log()  { printf '[msb-bootstrap] %s\n' "$*"; }
warn() { printf '[msb-bootstrap] WARN: %s\n' "$*" >&2; }
die()  { printf '[msb-bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

need_root() {
  [[ "$(id -u)" -eq 0 ]] || die "нужен root (sudo -n)"
}

run() {
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    printf '[dry-run]'; printf ' %q' "$@"; printf '\n'
    return 0
  fi
  "$@"
}

ensure_group_user() {
  local user="$1" home="$2" shell="${3:-/bin/bash}"
  if ! getent group "$user" >/dev/null; then
    run groupadd --system "$user" || run groupadd "$user"
  fi
  if ! id -u "$user" >/dev/null 2>&1; then
    run useradd --create-home --home-dir "$home" --shell "$shell" --gid "$user" "$user"
  fi
}

rsync_copy() {
  local src="$1" dst="$2"
  shift 2
  run mkdir -p "$dst"
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    log "rsync $src → $dst ($*)"
    return 0
  fi
  rsync -a --delete "$@" "$src" "$dst"
}

validate_bot_id() {
  local id="$1"
  [[ "$id" =~ ^[a-zA-Z0-9_-]{1,32}$ ]] || die "некорректный bot-id: $id"
}

assert_no_product_secrets() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  if grep -E '^(PULT_|SOCPUB_|ZAPCITA_|INFOSEC_)[A-Z0-9_]*=' "$file" >/dev/null; then
    die "в $file найдены продуктовые ключи (PULT_/SOCPUB_/ZAPCITA_/INFOSEC_) — чистая установка их не принимает"
  fi
}
