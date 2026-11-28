# Выборочный релиз JAR1 от 28.11.2026

Вход — принятый манифест UX `jar1-ux-40e1d25/manifest.json` и Git-коммит
выборочной ветки. Сборщик применяет к инвентарю принятую UX-дельту и
установленный footer hotfix, сверяет базовые файлы бота, движка и bin с Git
и запечатывает ровно перечисленные изменения в существующих каталогах бота.

```sh
python3 tools/release/jar1-parity-2026-11-28/build.py \
  --repo "$PWD" --commit "$(git rev-parse HEAD)" \
  --prior-manifest /path/to/jar1-ux-40e1d25/manifest.json --stage /path/to/new-stage
```

Для изолированной проверки оператор помещает stage под `/var/tmp` на JAR1,
распаковывает `source.tar.gz` в `source` и добавляет ссылки
`source/.msb/bot/node_modules` и `source/overlay/bot/node_modules` на
`/home/client/.msb/bot/node_modules`. Весь stage должен принадлежать root и
запрещать запись группе и остальным пользователям. Запуск от root:

```sh
python3 -I -B "$stage/launcher.py" --stage "$stage" --manifest-sha "$manifest_sha"
```

Launcher пишет `proof.json` после успешной проверки. Применяются accepted
UX exclusions и проверка Codex CLI 0.166.0. Core обязан включать выбранные
регрессии. Архив, payload и инструменты проверяются до и после тестов.
