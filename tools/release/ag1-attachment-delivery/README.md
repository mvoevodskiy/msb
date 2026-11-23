# AG1: исправление ответа с вложением

Этот путь предназначен только для `VM-753921`, `msb-bot@default.service` и
каталога `/home/client/.msb/bot`. Он устанавливает только три заранее проверенных
Git blob: `bot.mjs`, `send-media.mjs`, `media-markers.mjs`. Файлы `response.mjs`,
`agent/turn.mjs` и `ext/shim/run-turn.mjs` сверяются, но не заменяются. Базовый
инвентарь содержит 322 code-only файла и пять entry-файлов AG1; он исключает
OpenClaw, тесты и зависимости. Никакие данные пользователя в нём не сохранены.

**Условие очередности:** AG1 можно выпускать только после живой приёмки того же
исправления на JAR1. Оператор обязан подтвердить её отдельно: этот инструмент
не подключается к JAR1 и не выдаёт вымышленное подтверждение.

## Подготовка

Candidate commit должен содержать этот каталог, актуальные тесты и точный AG1
runtime из инвентаря с тремя целевыми изменениями. Тест response-delivery должен
соответствовать установленной AG1 версии response; тест outbound должен включать
фейковый `codex-exec`. Сборщик берёт файлы и инструменты непосредственно из одного
полного SHA коммита и отклоняет дополнительные runtime-отличия. Никаких patch
после экспорта или на сервере нет.

```sh
python3 -B -m unittest discover -s tools/release/ag1-attachment-delivery -p 'test_*.py' -v
AG1_COMMIT=<полный_40-символьный_SHA_candidate>
AG1_LOCAL_STAGE=/tmp/ag1-attachment-stage
python3 -B tools/release/ag1-attachment-delivery/build.py --commit "$AG1_COMMIT" --output "$AG1_LOCAL_STAGE"
tar -C "$AG1_LOCAL_STAGE" -czf /tmp/ag1-attachment-stage.tar.gz .
shasum -a 256 /tmp/ag1-attachment-stage.tar.gz
```

Сохранить выведенные SHA manifest и архива, передать архив по доверенному
каналу, отдельно сверить SHA на сервере. Stage должен быть новым и root-owned;
извлечение делать от root с `umask 022` и без восстановления владельца архива.
Не загружать никакие `.env`, auth, пользовательские файлы или node_modules.

```sh
AG1_STAGE=/var/tmp/ag1-attachment-stage
umask 022
mkdir -m 755 "$AG1_STAGE"
tar --no-same-owner -C "$AG1_STAGE" -xzf /root/ag1-attachment-stage.tar.gz
chown -hR root:root "$AG1_STAGE"
python3 -B "$AG1_STAGE/verify.py" --stage "$AG1_STAGE" --manifest-sha <SHA_manifest>
```

Verifier до и после тестов сверяет inventory, версию и хеш Node, зависимости и
PID сервиса. Тесты запускаются под `client`, с отдельными PID/mount/network
namespaces, только loopback, синтетическим HOME и скрытым `/home/client`.
Node-зависимости подключены только для чтения. Проверяются Codex exec, Claude и
доставка media, а также девять тестов оператора. Это **целевой набор**, не полный
suite и не живая приёмка. При успехе выводится SHA `verification.json`.

## Применение и восстановление

```sh
python3 -B "$AG1_STAGE/deploy.py" --stage "$AG1_STAGE" --manifest-sha <SHA_manifest> --report-sha <SHA_отчёта> --plan
python3 -B "$AG1_STAGE/deploy.py" --stage "$AG1_STAGE" --manifest-sha <SHA_manifest> --report-sha <SHA_отчёта> --apply --quiet-window-confirmed
```

До `--apply` проверить живую приёмку JAR1, видимое состояние AG1 и выбрать тихое
окно. Заморозка systemd, рекурсивная проверка cgroup и повторный поиск процессов
и открытых на запись файлов не доказывают пустоту очереди Telegram или отсутствие
будущего писателя. Если тихое состояние не подтверждено, выпуск не начинать.

До замены создаётся закрытая root-owned code-only копия; подготовленные inodes и
исходный код должны находиться на одном filesystem. Instance mask сохраняется
на время последовательного атомарного обмена файлов. Сбой автоматически запускает
проверенный rollback; если автоматическое восстановление прервано или встретило
независимое изменение, повторять его вручную только после проверки guard и тихого
окна, без принудительного старта:

```sh
python3 -B "$AG1_STAGE/deploy.py" --stage "$AG1_STAGE" --manifest-sha <SHA_manifest> --report-sha <SHA_отчёта> --rollback <путь_к_backup> --quiet-window-confirmed
```

Оператор сравнивает защищённые настройки, auth, сессии и известные файлы контекста
только в памяти; значения и хеши не выводятся и не записываются в отчёт. Только
`.heartbeat-ok` и `*.lock.sqlite` внутри `bots/default` исключены как временные
служебные файлы; WAL/journal остаются под проверкой. Пользовательские данные
не копируются и при rollback не заменяются. Совпадение защищённых файлов после
запуска требуется для успеха; любое неизвестное расхождение останавливает выпуск.
Сообщение `ready` подтверждает старт процесса, но не Telegram polling: после
выпуска необходима отдельная живая приёмка.
