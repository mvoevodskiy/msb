# JAR1: предупреждение об учёте Codex

Точечный выпуск двух файлов сборщика Пульта поверх установленного `a19689e`.
Код бота, настройки, журналы, авторизация, сессии и база Пульта в пакет не входят.
Manifest закрепляет source commit, Pult inventory, baseline каждого файла и
код транзакции. Проверенная зависимость ccusage 20.0.51 — тот же бинарник
`7ddd309d8f4d1c2c007647f43c300a8261acbe9e5cb355e70cc428f0f419f8d2`,
что выпущен через `jar1-codex-cache` из архива с закреплённым SHA-512.

1. Из чистого commit запустить `python3 tools/release/jar1-pult-warning/build.py
   --repo REPO --commit SHA --stage NEW_STAGE`. Передать содержимое stage на
   JAR1 в новый root-owned каталог `/var/tmp/NAME` без group/world write.
2. Распаковать `source.tar.gz` в `stage/source` с владельцем root, подключить
   `source/.msb/pult/node_modules` как ссылку на установленные Pult зависимости,
   создать `stage/test-home` владельца client и запустить
   `python3 stage/launcher.py --stage STAGE --manifest-sha HASH`. Launcher
   запускает проверку без сети в отдельном HOME и временном каталоге. Это полный
   тест Пульта, кроме одного теста OpenClaw по явному решению владельца.
3. После проверки запечатать `test-home` владельцем root без group/world write,
   вычислить SHA-256 `test-home/results/verification.json` и выполнить
   `pult-deploy.py --stage STAGE --backup /var/lib/msb-ops/releases/UNIQUE
   --manifest-sha HASH --report-sha HASH --plan`, затем `--apply`.
   Инвентарь, совпадение установленного Node и pinned ccusage проверяются до
   атомарной замены. Предыдущий код хранится в закрытом backup; при ошибке
   транзакция откатывает код и запускает collector. Перезапускается только
   `pult-collector`, веб-сессия и процессы бота сохраняются.
4. Проверить свежий снимок Пульта, интерфейс «Боты» и службы. Откатить при
   необходимости тем же `pult-deploy.py ... --rollback` и тем же backup.

Этот точечный выпуск не утверждает, что весь runtime бота соответствует source
commit: установленный код бота остаётся на предыдущем проверенном выпуске.
