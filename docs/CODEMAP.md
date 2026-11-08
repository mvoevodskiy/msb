# Карта кода

[← О проекте](../README.md)

Выбери задачу, затем раздел модуля. В нём указаны вход события, функция,
файл состояния и проверка поведения. Карта описывает canonical source; при переносе
функции обновляются её ссылка и маршрут, а не пользовательский сценарий.

## С чего начать

| Задача | Модуль → подмодуль | Конечная точка / проверка |
|---|---|---|
| История запросов и квоты в Пульте | [Пульт → История и провайдеры](pult-telemetry.md) | общий journal, Claude state, Codex account RPC; telemetry tests |
| Изменить кнопку или переход настроек | [Telegram → Настройки и кнопки](../.msb/bot/src/telegram/README.md#настройки-и-кнопки) | `settingsScreen`, `handleCallback`; UI и engine-menu tests |
| Пачка пересланных voice/текстов или сообщения во время хода | [Telegram → Очередь](../.msb/bot/src/telegram/README.md#очередь) | `createInbox` → `prepareBatch` / `executeTurn`; inbox lifecycle и timer tests |
| Разобраться с голосовым | [Telegram → Голос](../.msb/bot/src/telegram/README.md#голос) | `recognizeVoice` → `transcribeVoice`; voice/STT tests |
| Исправить stop, индикацию или итоговый ответ | [Telegram → Жизненный цикл хода](../.msb/bot/src/telegram/README.md#жизненный-цикл-хода) | `executeTurn`, progress, response; lifecycle/reference tests |
| Понять, как запускается модель | [Исполнение → CLI и выбор провайдера](../.msb/bot/src/agent/README.md#cli-и-выбор-провайдера) | `runAgentTurn` → runner → PATH-shim → adapter |
| Изменить вход, выбор Codex, модель или effort | [Обвязка → Выбор и авторизация](../overlay/bot/ext/README.md#выбор-и-авторизация) / [Модель и сессия](../overlay/bot/ext/README.md#модель-и-сессия) | существующие provider callbacks, canonical store, native config |
| Найти состояние или переменную окружения | [Состояние и конфигурация](#состояние-и-конфигурация) | `updateState`, `setEnvKey`, provider store; state/env tests |
| Изменить сбор источников или расписание | [Мониторинг](../.msb/bot/src/monitor/README.md) / [Автономка](../.msb/bot/src/autonomy/README.md) | `startMonitorScheduler`, `startScheduler`; см. соответствующие исходники |
| Разобраться с OS helper / OpenClaw | [OS-движки](../.msb/bot/src/engines/README.md) → [клиент IPC](../.msb/bot/src/engines/client.mjs) | [engines-client.test.mjs](../.msb/bot/tests/engines-client.test.mjs), [TDR](tdr/msb-engine-os-replace.md) |

## Вход процесса

Чистое ядро: [index.js](../.msb/bot/index.js) →
[`main`](../.msb/bot/src/main.mjs) →
[`createBot` / `runPolling`](../.msb/bot/src/telegram/bot.mjs).
`main` также собирает heartbeat, автономку, мониторинг и shutdown.

С обвязкой: [run.mjs](../overlay/bot/run.mjs) →
[`prepare` / `installUpdateHook`](../overlay/bot/ext/install.mjs) → тот же `index.js`.
Перед импортом ядра устанавливаются PATH-shim и обработчик расширения.
Поэтому callback сначала может обработать overlay, а затем core router.

## Выпуск

[Карта](#с-чего-начать) → [Release](../tools/release/README.md) →
[`build.py`](../tools/release/build.py) → [`verify.py`](../tools/release/verify.py)
→ [`deploy.py`](../tools/release/deploy.py).
Экспортёр берёт runtime, тестовый snapshot и release tools из одного commit;
verify проверяет их связь и зависимости. Оператор создаёт план, меняет только
код и поддерживает rollback. Успешный startup и живая Telegram-приёмка — разные проверки.

## Состояние и конфигурация

| Что хранится | Владелец в исходниках | Проверка |
|---|---|---|
| Core engine, auth gate, текущая CLI-сессия и `sessionEpoch` | [`state.mjs`](../.msb/bot/src/state.mjs): `loadState`, `updateState`; сохранённые при переключении беседы — [`provider-sessions.mjs`](../overlay/bot/ext/provider-sessions.mjs) | [paths-state](../.msb/bot/tests/paths-state.test.mjs), [provider-sessions](../overlay/bot/ext/tests/provider-sessions.test.mjs), [turn-lifecycle](../.msb/bot/tests/turn-lifecycle.test.mjs) |
| Переменные из меню `.env` | [`env/store.mjs`](../.msb/bot/src/env/store.mjs): `listEnvEntries`, `setEnvKey`, `deleteEnvKey` | [monitor-env](../.msb/bot/tests/monitor-env.test.mjs) |
| Выбранный CLI-провайдер, его модели, effort, native session IDs | [`ext/store.mjs`](../overlay/bot/ext/store.mjs): `loadStore`, `setActive`, `setSession` | [store](../overlay/bot/ext/tests/store.test.mjs), [provider-switch](../overlay/bot/ext/tests/reference/provider-switch.test.mjs) |
| STT с приоритетом process → per-bot → shared env | [`media/stt.mjs`](../.msb/bot/src/media/stt.mjs): `resolveSttConfig` | [stt](../.msb/bot/tests/stt.test.mjs) |

Codex — CLI-провайдер обвязки. Его выбор хранится в `ext-providers.json`;
штатный канал ядра остаётся `cc`. `state.engine = oc` и запросы `msb-engine`
относятся к OpenClaw/управлению сервисами ОС. Эти маршруты не взаимозаменяемы.

## Исходники, сборка и runtime

- Canonical-ветка — `codex/open-core-reference-tests`: `.msb/bot/src` и `overlay/bot/ext`.
  В установленном коде overlay размещается рядом с ядром, в `bot/ext`.
- [Общий профиль](../.msb/bot/shared/README.md) задаёт `msb`/`jar1`, root и env aliases.
  `jar1` сохраняет `.iia`; он не требует отдельной реализации или текстовых подмен исходников.
- `<root>/bots/<id>`, workspace и native auth — данные владельца; они не являются
  содержимым чистого runtime артефакта. Код и тесты привязаны к `source_commit`.
- [Release pipeline](../tools/release/README.md) — поддерживаемый путь обновления JAR1.
  Откат восстанавливает предыдущий код. Bootstrap/OS-миграция остаются отдельной операцией.

Операционный вход: [bootstrap](../bootstrap/README.md),
[установка overlay](../overlay/README.md), [политика обновлений](../bootstrap/UPDATE-POLICY.md).

## Эталон и проверки

Старый [vendor](../.msb/bot/vendor/README.md) задаёт прежние сценарии и визуальное
поведение; реализация развивается в новом ядре. Кнопки, тексты и порядок действий
при разделении модулей сохраняются. [Reference-набор](../.msb/bot/tests/reference/README.md)
объясняет покрытие и известные ограничения; наличие ссылки на тест не означает PASS.

Навигационный пример: **Настройки → Движки** → [Telegram](../.msb/bot/src/telegram/README.md#настройки-и-кнопки)
→ `eng:home` / provider view → [`handleCallback`](../overlay/bot/ext/integration/callbacks.mjs)
→ [engine-menu reference](../overlay/bot/ext/tests/reference/engine-menu.test.mjs).

Навигационный пример: **Голос → ответ Codex** → [Голос](../.msb/bot/src/telegram/README.md#голос)
→ STT → [общий ход](../.msb/bot/src/agent/README.md#общий-ход)
→ [CLI-провайдер](../overlay/bot/ext/README.md#исполнение-cli) → доставка ответа.

Навигационный пример: **/stop** → [Жизненный цикл хода](../.msb/bot/src/telegram/README.md#жизненный-цикл-хода)
→ `AbortController` / `turn.done` → [runner](../.msb/bot/src/agent/claude.mjs)
→ [stop-polling reference](../.msb/bot/tests/reference/stop-polling.test.mjs).
