# Bootstrap ядра MSB

Ставит **оркестратор** на новый Linux-сервер (systemd, passwordless sudo).

По умолчанию ставится **только ядро** (штатный `index.js`). Обвязка провайдеров
(Cursor / Codex / Qwen) лежит в `overlay/` и подключается отдельно —
см. [../overlay/README.md](../overlay/README.md) и флаг `--with-ext`.

Продуктовые проекты владельца и их секреты **не** ставятся.

## Быстрый старт

На целевом сервере (Ubuntu/Debian, root):

```bash
# 1. Скопировать этот репо на сервер, например в /opt/msb-src
# 2. Заполнить секреты ядра
cp /opt/msb-src/bootstrap/env/msb.env.example /root/msb.env
cp /opt/msb-src/bootstrap/env/bot.env.example /root/bot-default.env
$EDITOR /root/msb.env /root/bot-default.env

# 3. Установка ядра
sudo /opt/msb-src/bootstrap/install.sh \
  --source /opt/msb-src \
  --env-file /root/msb.env \
  --bot-env-file /root/bot-default.env \
  --bots default

# 4. (опционально) обвязка CLI-провайдеров
sudo /opt/msb-src/overlay/install.sh --target /home/client

# 5. Проверка
sudo /opt/msb-src/bootstrap/verify.sh
```

Или одной командой: добавь `--with-ext` к `install.sh` (вызовет `overlay/install.sh`).

Сухой прогон:

```bash
sudo ./bootstrap/install.sh --dry-run
```

## Что ставится

См. [MANIFEST.txt](MANIFEST.txt). Кратко: `.msb` **без** `bot/ext/` + `workspace-seed/` +
systemd ядра + `msb-engine` + узкий sudoers + bind workspace→`bots/<id>/cwd` + `npm ci` + Claude Code CLI.
Закрытый Jarvis OS и бандл ядра не ставятся; на живом боксе — `migrate-from-jarvis.sh`.

Обновления не затирают пользовательские файлы — [UPDATE-POLICY.md](UPDATE-POLICY.md).

## Секреты

Обязательные для «отвечает в Telegram»: `BOT_TOKEN` (per-bot), `ADMIN_ID`, `CLAUDE_CODE_OAUTH_TOKEN`.  
Для sync/puller: `SYNC_URL`, `SYNC_KEY`.  
Тулзы: `PROXYAPI_KEY`, `DEEPGRAM_API_KEY`, …

Установка **откажется**, если в env-файлах есть продуктовые префиксы (`PULT_*`, `SOCPUB_*`, …).
Код Пульта (`.msb/pult/`) ставится всегда; службы и `PULT_*` — только после включения в `/settings`.

## Не входит

- Обвязка CLI (`overlay/`) — только по `--with-ext` / `overlay/install.sh`
- OpenClaw (`msb-oc-install`, `/home/openclaw`)
- VPS-backup на R2 (`msb-backup`)
- Любые `*-deploy` / `*-data` / `*-secrets` продуктов
