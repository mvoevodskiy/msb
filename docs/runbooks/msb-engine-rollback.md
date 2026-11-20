# Rollback / снимки OS-обвязки

Штатный путь — только **msb-engine**. Закрытый Jarvis OS и бандл ядра сняты.

## Снимок на боксе

При `bootstrap/migrate-from-jarvis.sh` пишется
`/usr/local/lib/msb-engine/rollback/<stamp>/` (бинарь/units/sudoers Jarvis до purge).

Восстановление Jarvis с снимка — аварийный ручной сценарий (не поддерживается как продукт):

```bash
SNAP=/usr/local/lib/msb-engine/rollback/$(cat /usr/local/lib/msb-engine/rollback/LATEST)
# только если осознанно нужен старый helper
cp -a "$SNAP/bin/"* /usr/local/sbin/ 2>/dev/null || true
cp -a "$SNAP/units/"* /etc/systemd/system/ 2>/dev/null || true
systemctl daemon-reload
```

Откат Telegram-ядра на закрытый бандл больше не поддерживается: `index.closed.js` удалён.
