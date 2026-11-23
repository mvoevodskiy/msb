# JAR1: ответы одним вложением

Выборочный code-only выпуск только для `VM-422100`, `msb-bot@default.service` и `/home/client/.msb/bot`. Три файла берутся из выбранного Git commit прямыми blob-байтами; никакие патчи после экспорта не накладываются. Исправление фиксируется только при совпадении его hash с проверенным `65f7ca1`. Исходники, тесты и операторы экспортируются из того же commit. Предыдущий manifest `a19689e`, SHA-256 `f06c76e80a6d6013a1834d73dd2c2a64356db3809339bce940b6fcf7cef89eed`, закрепляет 347 путей и шесть обновлений поверх них, а также шесть support-файлов. Сборщик проверяет каждый Git blob против фактического baseline. Оператор дополнительно сверяет эти файлы с live inventory перед публикацией и после неё. Секреты, пользовательские данные и node_modules в payload не входят.

## Сборка

Выбрать commit, содержащий это средство, реальные файлы baseline и три обновлённых файла. Текущая рабочая ветка не обязательно соответствует установленному composite; сборщик отклонит несоответствие. Сборка вызывается инструментом из этого же commit:

```sh
python3 -B tools/release/jar1-attachment-delivery/build.py \
  --repo "$REPO" --commit "$CANDIDATE_SHA" --stage "$LOCAL_STAGE" \
  --prior-manifest /private/tmp/jar1-codex-cache-a19689e-manifest.json
```

Сохранить выведенный `manifest_sha256`. Изолированно перенести только полученный stage на JAR1 и сверить его hash. Каталог на сервере — новый непосредственный потомок `/var/tmp`, root-owned; до проверки распаковать `$STAGE/source.tar.gz` в `$STAGE/source`, оставив файлы и каталоги root-owned и доступными для чтения `client`. Создать две ссылки на установленные зависимости как root:

```sh
ln -s /home/client/.msb/bot/node_modules "$STAGE/source/.msb/bot/node_modules"
ln -s /home/client/.msb/bot/node_modules "$STAGE/source/overlay/bot/node_modules"
```

Сохранить режимы исполняемых файлов source из архива. Каталоги должны быть доступны для прохода `client` и недоступны ему для записи; не делать stage writable пользователю бота. Другие ссылки/дополнительные файлы в stage блокируют выпуск.

## Проверка и выпуск

```sh
python3 -I -B "$STAGE/launcher.py" --stage "$STAGE" --manifest-sha "$MANIFEST_SHA"
```

Launcher выполняет четыре focused группы `media`, `response`, `plan`, `history` и проверки оператора из того же snapshot. Linux network/mount/PID namespaces содержат только loopback, `/tmp` и `HOME` синтетические; реальный `/home/client` скрыт, а зависимости и CLI доступны только в read-only bind mounts. Тесты OpenClaw не запускаются. Проверяются Node 22, содержимое установленных зависимостей и identity нативного CLI. При успехе root создаёт `$STAGE/proof.json` и выводит только его hash. Это **не** полный suite и не живая приёмка.

Перед планом и публикацией проверить правильный сервер, отсутствие активного хода **и очереди в самом Telegram**. Проверка cgroup не обнаруживает очередь в памяти и не заменяет это наблюдение. Перезапуск может затронуть задания, поступившие после наблюдения; убедиться в тишине непосредственно перед apply.

```sh
python3 -I -B "$STAGE/deploy.py" --stage "$STAGE" --backup "$BACKUP" \
  --manifest-sha "$MANIFEST_SHA" --report-sha "$PROOF_SHA"
python3 -I -B "$STAGE/deploy.py" --stage "$STAGE" --backup "$BACKUP" \
  --manifest-sha "$MANIFEST_SHA" --report-sha "$PROOF_SHA" --apply --queue-confirmed
```

`$BACKUP` — новая прямая запись в `/var/lib/msb-ops/releases`. Применяются прежние проверенные atomic exchange, guard старта и автоматический откат при ошибке. Закрытая копия и проверка профиля ограничены `state.json`, `ext-providers.json`, обоими `.env`, авторизацией и конфигом Codex, его индексом `state_5.sqlite` и ровно одним активным rollout. Каталог `bots/default/projects`, другие сессии и базы Atoll не обходятся и не копируются. Остальные пользовательские файлы этим выпуском не заменяются; их независимую активность он не контролирует. Оператор требует неизменность SHA всего baseline, support и трёх зависимостей, `client:client 0664` для целевых модулей и обычных зависимостей, `client:client 0775` для исполняемого shim, тот же Node/dependencies/CLI и успешный root-owned proof. Проверка startup/polling ещё не является приёмкой: в Telegram проверить реальное вложение без ложной ошибки, footer, обычный ответ и `/stop`, сохранив существующую сессию.

Откат, после нового наблюдения тишины и при наличии исходных stage/proof/backup:

```sh
python3 -I -B "$STAGE/deploy.py" --stage "$STAGE" --backup "$BACKUP" \
  --manifest-sha "$MANIFEST_SHA" --report-sha "$PROOF_SHA" --rollback --queue-confirmed
```

Если какой-либо guard, тест или проверка inventory не проходит, не ослаблять его и не применять ad-hoc patch: остановиться и отдельно разобрать расхождение. Не использовать этот оператор на AG1.
