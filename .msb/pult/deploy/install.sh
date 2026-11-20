#!/usr/bin/env bash
# Установка Пульта на сервер ботов: каталоги, секреты, выкладочная копия, службы systemd, при --nginx — вход
# для nginx Михаила по локальной сети (он держит https://<домен> и проксирует на <адрес в сети>:<порт>).
#   deploy/install.sh [--nginx] [--domain pult.dev.mp.aaa0.ru] [--port 8791]
#                     [--lan-ip <адрес этого сервера в сети>] [--lan-port 8792] [--allow 192.168.33.0/24]
# Повторный запуск безопасен. Прежние системные файлы сохраняются в /home/client/pult-data/backups/.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
DATA=/home/client/pult-data
DOMAIN=pult.dev.mp.aaa0.ru
PORT=8791
NGINX=0
LAN_IP=$(ip -4 -o addr show scope global | awk '{print $4}' | grep -m1 '^192\.168\.33\.' | cut -d/ -f1 || true)
LAN_PORT=8792
ALLOW=192.168.33.0/24
while [ $# -gt 0 ]; do
  case "$1" in
    --nginx) NGINX=1; shift ;;
    --domain) DOMAIN=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --lan-ip) LAN_IP=$2; shift 2 ;;
    --lan-port) LAN_PORT=$2; shift 2 ;;
    --allow) ALLOW=$2; shift 2 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "Неизвестный параметр: $1" >&2; exit 2 ;;
  esac
done
sudo -n true 2>/dev/null || { echo "Нужен sudo без пароля (sudo -n)." >&2; exit 1; }
TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$DATA/backups/systemd" "$DATA/backups/nginx"

"$REPO/deploy/secrets.sh" --public-url "https://$DOMAIN" --port "$PORT"
"$REPO/deploy/deploy.sh" --skip-check >/dev/null || true   # первая копия кода; службы ещё могут быть не установлены

put() { # put <источник> <назначение> <копия-в>
  if sudo -n test -f "$2" && ! sudo -n cmp -s "$1" "$2"; then sudo -n cp -p "$2" "$3/$(basename "$2").$TS"; fi
  sudo -n install -m 644 "$1" "$2"
}
for u in pult-web.service pult-collector.service pult-notify-failure@.service; do
  put "$REPO/deploy/$u" "/etc/systemd/system/$u" "$DATA/backups/systemd"
done
sudo -n systemctl daemon-reload
echo "Службы установлены: pult-web, pult-collector (автозапуск включает deploy.sh, когда службе есть с чем стартовать)."

if [ "$NGINX" = 1 ]; then
  [ -n "$LAN_IP" ] || { echo "Не нашёл адрес этого сервера в локальной сети — укажи --lan-ip" >&2; exit 1; }
  sudo -n mkdir -p /var/www/pult
  sudo -n install -m 644 "$REPO/deploy/pult-down.html" /var/www/pult/pult-down.html
  put "$REPO/deploy/nginx-pult-proxy.conf" /etc/nginx/snippets/pult-proxy.conf "$DATA/backups/nginx"
  f=$(mktemp)
  sed "s|__DOMAIN__|$DOMAIN|g; s|__PORT__|$PORT|g; s|__LAN_IP__|$LAN_IP|g; s|__LAN_PORT__|$LAN_PORT|g; s|__ALLOW__|$ALLOW|g" "$REPO/deploy/nginx-pult.conf" > "$f"
  prev=""
  sudo -n test -f /etc/nginx/sites-available/pult.conf && { prev=$(mktemp); sudo -n cp /etc/nginx/sites-available/pult.conf "$prev"; }
  put "$f" /etc/nginx/sites-available/pult.conf "$DATA/backups/nginx"; rm -f "$f"
  sudo -n ln -sf /etc/nginx/sites-available/pult.conf /etc/nginx/sites-enabled/pult.conf
  # reload возвращает успех, даже если nginx отверг новые настройки, — проверяем, что порт открылся.
  if sudo -n nginx -t -q && sudo -n systemctl reload nginx && for _ in 1 2 3 4 5; do sleep 1; ss -ltn | grep -q " $LAN_IP:$LAN_PORT " && break; done && ss -ltn | grep -q " $LAN_IP:$LAN_PORT "; then
    echo "nginx: вход для nginx Михаила — http://$LAN_IP:$LAN_PORT (только из $ALLOW), домен $DOMAIN."
  else
    sudo -n tail -n 3 /var/log/nginx/error.log >&2
    echo "nginx -t не прошёл — возвращаю прежний pult.conf" >&2
    if [ -n "$prev" ]; then sudo -n install -m 644 "$prev" /etc/nginx/sites-available/pult.conf; else sudo -n rm -f /etc/nginx/sites-enabled/pult.conf; fi
    sudo -n nginx -t -q && sudo -n systemctl reload nginx
    exit 1
  fi
  [ -n "$prev" ] && rm -f "$prev"
fi
"$REPO/deploy/deploy.sh" --skip-check
