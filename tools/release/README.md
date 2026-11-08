# Один commit → релиз JAR1

[Вход ядра](../../.msb/bot/src/main.mjs) · [Профиль среды](../../.msb/bot/shared/README.md)

Здесь нет патчей поведения и зависимости от прежней рабочей ветки. Сборщик
читает Git-объекты выбранного commit, сохраняет байты и executable modes.
Исходники `.msb/bot/src`, `shared` и `overlay/bot/ext` становятся соседними
`bot/src`, `bot/shared`, `bot/ext`. Профиль — отдельные данные
[profiles/jar1.json](./profiles/jar1.json), а не переписывание строк кода.

## Маршрут по задаче

| Задача | Файл |
|---|---|
| Состав релиза, Git SHA, source→runtime mapping | [build.py](./build.py) |
| Проверка хешей, modes, тестового snapshot и границ | [manifest.py](./manifest.py) |
| Проверки на установленной версии Node/dependencies | [verify.py](./verify.py) |
| Настоящий exported profile в пустом HOME | [profile-smoke.mjs](./profile-smoke.mjs) |
| Архив без node_modules, логов и тестовых данных | [pack.py](./pack.py) |
| JAR1: план, service startup, protected profile | [deploy.py](./deploy.py) |
| Атомарная замена кода и точный rollback | [transaction.py](./transaction.py) |
| Regression границ и отката | [tests/test_release.py](./tests/test_release.py) |

## Что считается релизом

`release.json` содержит полный source SHA/tree, профиль, hashes/modes всех
управляемых файлов, lock SHA и хеш snapshot тестов. Копия устанавливается в
`bot/release.json`; она исключена из собственного списка хешей, но сравнивается
с исходной metadata целиком. Инструменты проверки/выкладки также из того же commit.

В release входят входы, core, ext/shim, shared, package/lock, open-core marker и
guarded puller/sync. Node, Codex CLI и установленные зависимости проверяются
как внешние runtime-зависимости. Native auth, `.env`, `bots/*/state.json`,
сессии, workspace и node_modules не копируются и не сбрасываются.

`checks/source` — тот же код плюс тесты с закреплёнными legacy-контрактами.
Удалённый закрытый bundle не требуется тестам и в артефакт не включается.
Его содержимое и ссылки закреплены в manifest. Полный baseline выполняется
в отдельном HOME с профилем msb; отдельный smoke проверяет реальные байты
`runtime/` и их jar1 default, `.iia`, IIA aliases, iia_http и updater guards.
Это не запуск второго Telegram-бота.

## Локальная подготовка

Из чистого выбранного commit (включая сам exporter):

```sh
python3 tools/release/build.py --commit HEAD --output /tmp/jar1-release
python3 tools/release/verify.py --stage /tmp/jar1-release --dependencies /path/to/node_modules
python3 tools/release/pack.py --stage /tmp/jar1-release --output /tmp/jar1-release.tar.gz
```

Mac-прогон полезен, но не разрешает deploy: оператор требует успешный Linux
report для того же manifest, точную Node version и совпадающий fingerprint
установленных версий зависимостей. `npm install`/обновление CLI здесь не выполняются.

## Проверка и установка на JAR1

Передать архив и распаковать в новый stage. Runtime/ops/source оставить root-owned
и недоступными для записи пользователю бота. Создать две dependency-ссылки
`checks/source/.msb/bot/node_modules` и `checks/source/overlay/bot/node_modules`
на `/home/client/.iia/bot/node_modules`. Только `checks/results` и `checks/test-home`
создать writable для client. Проверку запускать под client:

```sh
python3 STAGE/ops/verify.py --stage STAGE --dependencies /home/client/.iia/bot/node_modules
```

После успешных проверок, под root:

```sh
python3 STAGE/ops/deploy.py --stage STAGE --plan
# Просмотреть install-plan.json: changes/removals и сохранённый baseline.
python3 STAGE/ops/deploy.py --stage STAGE --apply
```

Оператор привязан к JAR1 и одному `iia-bot@default.service`. Он повторно проверяет
код/dependencies, ждёт отсутствия CLI-процессов, сохраняет backup, останавливает
только бота, устанавливает код, проверяет startup и защищённые файлы.
`startup_ready` не является доказательством успешного polling: обязательна
отдельная живая Telegram-приёмка текста/voice/stop/menu. До неё релиз не принят.

## Откат

`applied.json` указывает private backup в `/var/lib/agentsmania-ops/releases/`.

```sh
python3 STAGE/ops/deploy.py --rollback BACKUP
```

До изменений проверяется весь backup, modes и текущий inventory. Возвращается
только код; новые сообщения, auth и настройки владельца остаются. Ошибка во
время установки автоматически возвращает прежний код и проверяет его startup.
Не использовать старые `candidate.patch` сборщики как параллельный путь выпуска.
Исторические операторские отчёты остаются в AgentsMania, но сборка от них не зависит.
