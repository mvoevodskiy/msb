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

После изменения выполнить целевые регрессии и проверки связанных модулей.
Промежуточные проверки идут локально. При разрешённом выпуске собрать один
готовый пакет из чистого выбранного коммита вместе с его exporter:

```sh
python3 tools/release/build.py --commit HEAD --output /tmp/jar1-release
python3 tools/release/pack.py --stage /tmp/jar1-release --output /tmp/jar1-release.tar.gz
```

Полный обязательный прогон этого пакета выполняется на JAR1 в отдельном
каталоге до выкладки. Для выпуска требуются Linux report того же manifest,
точная версия Node и совпадающий fingerprint установленных зависимостей.
Локальный полный прогон нужен при отдельной проверяемой причине. Установку
пакетов и обновление CLI этот маршрут не запускает.

## Проверка и установка на JAR1

Передать архив и распаковать в новый stage. Runtime/ops/source оставить root-owned
и недоступными для записи пользователю бота. Создать две dependency-ссылки
`checks/source/.msb/bot/node_modules` и `checks/source/overlay/bot/node_modules`
на `/home/client/.iia/bot/node_modules`. Только `checks/results` и `checks/test-home`
создать writable для client. На JAR1 с одним доступным CPU полный core suite
может выйти за три минуты. Для него предел пять минут. Остальные suites
сохраняют трёхминутный предел. Проверку запускать под client:

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

`applied.json` указывает private backup в `/var/lib/msb-ops/releases/`.
Ранее записанные точки из `/var/lib/agentsmania-ops/releases/` доступны той же команде.

```sh
python3 STAGE/ops/deploy.py --rollback BACKUP
```

До изменений проверяется весь backup, modes и текущий inventory. Возвращается
только код; новые сообщения, auth и настройки владельца остаются. Ошибка во
время установки автоматически возвращает прежний код и проверяет его startup.
Не использовать старые `candidate.patch` сборщики как параллельный путь выпуска.
Исторические операторские отчёты остаются в `deployment/ops/`, но сборка от них не зависит.

## Локальные Linux-проверки в Docker

Docker подходит для отдельного Linux-сценария, нативного CLI и локальной
проверки артефакта, если выпуск ещё не планируется. Промежуточный коммит
можно проверить целевыми тестами без контейнера. [Dockerfile](Dockerfile) собирает только инструменты
и зависимости из `runtime/bot/package*.json`; файлы бота/авторизации в образ не
копируются. Проверка получает read-only export, отдельные writable results/HOME
и временный `/tmp`, без сети. `exec` у tmpfs нужен fake CLI/STT-скриптам тестов;
без него они закономерно падают с EACCES, это не допустимый RED продукта.
Запуск с --init собирает остановленные дочерние процессы. Без него Python
на PID 1 может оставить PID завершившегося guard в состоянии Z после
группового SIGINT. Тест отмены проверяет исчезновение PID, поэтому контейнер
должен использовать init, как целевой Linux использует systemd.

Проверено: Docker Desktop4.84 / Engine29.6.2, Linux arm64, pinned base Node22.23.2.
Первый snapshot74241e3:202core+78overlay+15reference+13release PASS (308tests),
плюс syntax/dependencies/profile/snapshot checks. JAR1 использует Node22.23.4:
этот контейнер — предварительная проверка, а не замена целевому Linux gate.
Перед production release по-прежнему проверить тот же commit на JAR1, его
Node/dependencies и installed artifact, затем Telegram. Результат Docker хранить
как `docker-verification.json`, не использовать вместо JAR1 `verification.json`.

Из чистого commit, с новым каталогом stage (исходники/lock берутся из Git):

```sh
MSB_CHECK_STAGE=/tmp/msb-local-linux
python3 tools/release/build.py --commit HEAD --output "$MSB_CHECK_STAGE"
docker build -t msb-local-checks:node22 -f tools/release/Dockerfile "$MSB_CHECK_STAGE/runtime/bot"
mkdir -p "$MSB_CHECK_STAGE/checks/results" "$MSB_CHECK_STAGE/checks/test-home"
ln -s /opt/msb-deps/node_modules "$MSB_CHECK_STAGE/checks/source/.msb/bot/node_modules"
ln -s /opt/msb-deps/node_modules "$MSB_CHECK_STAGE/checks/source/overlay/bot/node_modules"
docker run --rm --init --network none --read-only --user "$(id -u):$(id -g)" \
  --tmpfs /tmp:rw,exec,mode=1777 --env PYTHONDONTWRITEBYTECODE=1 \
  --mount "type=bind,src=$MSB_CHECK_STAGE,dst=/stage,readonly" \
  --mount "type=bind,src=$MSB_CHECK_STAGE/checks/results,dst=/stage/checks/results" \
  --mount "type=bind,src=$MSB_CHECK_STAGE/checks/test-home,dst=/stage/checks/test-home" \
  msb-local-checks:node22 python3 /stage/ops/verify.py \
  --stage /stage --dependencies /opt/msb-deps/node_modules
mv "$MSB_CHECK_STAGE/checks/results/verification.json" "$MSB_CHECK_STAGE/checks/results/docker-verification.json"
```

Не монтировать checkout целиком, host HOME, SSH или runtime бота. При новой
версии lock/Dockerfile образ пересобирается; Docker layer cache ускоряет повтор.
Для JAR1 готовить отдельный чистый export: Linux-report должен принадлежать
его финальному manifest и реальным установленным зависимостям.
