# CLI-провайдеры и обвязка

[← Вход ядра](../../../.msb/bot/src/main.mjs) ·
[Установка обвязки](../../README.md) ·
[Telegram ←](../../../.msb/bot/src/telegram/README.md) ·
[Исполнение агента ←](../../../.msb/bot/src/agent/README.md)

Обвязка добавляет Codex/Cursor/Qwen, выбор провайдера, native auth, модели и
локальный constructor API. Ядро может работать без неё. Вход — [`run.mjs`](../run.mjs),
который устанавливает PATH-shim и вызывает [`prepare`](integration/startup.mjs) до импорта ядра.
[`install.mjs`](install.mjs) сохраняет прежние публичные экспорты `prepare` и `installUpdateHook`.

## Выбор и авторизация

| Задача | Модуль → функция / маршрут | Проверка |
|---|---|---|
| Сжать текущую беседу Codex | [`compact-codex.mjs`](compact-codex.mjs): resume → compact → подтверждённый `contextCompaction` | [compact-codex](tests/compact-codex.test.mjs), [core routing](../../../.msb/bot/tests/compact-routing.test.mjs) |
| Прочитать доступные навыки Codex | [`codex-skills.mjs`](codex-skills.mjs): captured cwd/provider → native metadata → core catalog; [`codex-skills-rpc.mjs`](codex-skills-rpc.mjs) отвечает за stdio/close | [core ingress](../../../.msb/bot/tests/skills-native.test.mjs), [mapping](tests/codex-skills.test.mjs), [transport](tests/codex-skills-rpc.test.mjs) |
| Подготовить авторизацию Codex для хода и `/compact` | [`codex-auth-env.mjs`](codex-auth-env.mjs): `codexChildEnvironment`, native login → per-bot/shared env | [codex-auth-env](tests/codex-auth-env.test.mjs) |
| Найти доступные CLI-провайдеры | [`providers.mjs`](providers.mjs): `PROVIDERS`, `getProvider` | [menu](tests/menu.test.mjs), [store](tests/store.test.mjs) |
| Показать Codex в «Движках» | [`engine-menu.mjs`](engine-menu.mjs): `buildEngineProviderView`, `registerEngineProviderView`; core `enginesScreen` | [core engine-menu](../../../.msb/bot/tests/engine-menu.test.mjs), [core + overlay](tests/reference/engine-menu.test.mjs) |
| Переключить провайдера из кнопки | [`integration/callbacks.mjs`](integration/callbacks.mjs): `handleCallback`, `ext:conn:set:<id>` | [provider-switch](tests/reference/provider-switch.test.mjs), [engine-menu](tests/reference/engine-menu.test.mjs) |
| Проверить вход Codex / начать device login | [`auth-wire.mjs`](auth-wire.mjs): `codexLoginStatus`, `startCodexDeviceLogin`; [`integration/native-login.mjs`](integration/native-login.mjs): `connectCodexNative` | [auth-wire](tests/auth-wire.test.mjs), [engine-menu](tests/reference/engine-menu.test.mjs) |
| Убедиться, что CLI установлен | [`ensure-cli.mjs`](ensure-cli.mjs): `ensureProviderCli` | [ensure-cli](tests/ensure-cli.test.mjs) |
| Сохранить ключ Cursor/Qwen и настроить CLI | [`env.mjs`](env.mjs): `saveProviderSecret`; [`auth-wire.mjs`](auth-wire.mjs): `wireProviderAuth`; [`integration/text-input.mjs`](integration/text-input.mjs): `handleAuthMessage` | [env](tests/env.test.mjs), [auth-wire](tests/auth-wire.test.mjs) |

Порядок Codex selection: готовность CLI → native login status → подготовка
runtime → `setActive` → `syncExtAuthGate`. При отказе login-status активный профиль
сохраняется; кнопка входа использует `ext:auth:codex`. Открытие «Движков» только читает
store. Вход Codex хранится в native auth, секрет не запрашивается сообщением в Telegram.

Owner-check выполняется в [`installUpdateHook`](integration/update-hook.mjs) до действий overlay;
необработанное событие передаётся ядру. При разделении сохранять эту границу,
порядок callback-ветвей и штатный Claude token flow.

## Модель и сессия

| Данные / действие | Реализация | Проверка |
|---|---|---|
| Active provider, native sessions, models, efforts | [`store.mjs`](store.mjs): `loadStore`, `setActive`, `setSession`, `setSelectedModel`, `setSelectedEffort`; [`store-lock.mjs`](store-lock.mjs) сериализует записи между процессами | [store](tests/store.test.mjs), [конкурентные записи](tests/store-concurrency.test.mjs), [provider-switch](tests/reference/provider-switch.test.mjs) |
| Каталог и отображаемая модель | [`models-catalog.mjs`](models-catalog.mjs): `listModelsForProvider`, `resolveDisplayedModel`; [`menu.mjs`](menu.mjs): `buildModelMenu`, `buildAgentMenu` | [menu](tests/menu.test.mjs), [codex-native](tests/codex-native.test.mjs) |
| Применить модель/effort в store и native config | [`apply-model.mjs`](apply-model.mjs): `applyProviderModel`, `applyProviderEffort` | [apply-model](tests/apply-model.test.mjs) |
| Сохранить UI-режим прав | [`integration/actions.mjs`](integration/actions.mjs): `writeBotPermissionMode`; совместимый реэкспорт из [`menu.mjs`](menu.mjs) | [menu-handlers](../../../.msb/bot/tests/menu-handlers.test.mjs) проверяет сохранение native Codex session |
| Согласовать provider с auth gate ядра | [`setup-bypass.mjs`](setup-bypass.mjs): `syncExtAuthGate`; [`state-update.mjs`](state-update.mjs): `updateBotState` | [setup-bypass](tests/setup-bypass.test.mjs), [engine-menu](tests/reference/engine-menu.test.mjs) |
| Сохранить отдельные беседы при смене CLI | [`provider-sessions.mjs`](provider-sessions.mjs): `switchProviderSession` в общей транзакции state | [provider-sessions](tests/provider-sessions.test.mjs), [turn-lifecycle](../../../.msb/bot/tests/turn-lifecycle.test.mjs) |

Основной provider store — `<root>/bots/<id>/ext-providers.json`;
`<root>` выбирает [shared profile](../../../.msb/bot/shared/README.md). Core-профиль
`state.json` и native Codex config имеют отдельные роли. Активная беседа остаётся
в `ccSessionId`; при выборе другого CLI её ID временно хранится в
`parkedCcSessions` того же state, а ID выбранного CLI возвращается в `ccSessionId`.
`ext-providers.json` хранит последние наблюдавшиеся native ID как метаданные и не
используется для автоматического возобновления после `/newtask` или `/clear`.
Записи store синхронизируются через SQLite lock-файл рядом с JSON (0600, без
секретов); блокировка освобождается ОС при завершении процесса. Чтение JSON
по-прежнему не меняет state. Смена провайдера увеличивает `sessionEpoch`, чтобы поздний ответ старого хода не
заменил текущую сессию. Повторный выбор того же provider не переключает беседу.

## Исполнение CLI

[`shim/run-turn.mjs`](shim/run-turn.mjs) — граница с ядром: читает Claude argv/stdin,
выбирает provider и возвращает совместимые stream-json события. Для хода нового
ядра provider фиксируется вместе с `ccSessionId` при чтении state и передаётся в
shim; поздняя смена меню не направляет начатый запрос другому CLI. Прямые legacy
вызовы без снимка продолжают читать активный provider из store.

| Подмодуль | Файл → функция | Проверка |
|---|---|---|
| Claude passthrough / alternate dispatch | [`shim/run-turn.mjs`](shim/run-turn.mjs): `runAlternate` и ветка Claude | [provider-switch](tests/reference/provider-switch.test.mjs) |
| Codex exec, resume, stream parsing | [`adapters/codex.mjs`](adapters/codex.mjs): `runCodexTurn`, `buildCodexExecArgs`, `parseCodexStdout` | [provider-switch](tests/reference/provider-switch.test.mjs); ограничения ниже |
| Сохранённый фоновый запрос Codex | [saved-codex](adapters/saved-codex.mjs) → [файловые инструменты](adapters/saved-workspace-tools.mjs) → [проверка путей](adapters/saved-workspace-files.mjs) | [планировщик](../../../.msb/bot/tests/saved-codex-prompt-action.test.mjs), [права на файлы](tests/saved-codex-workspace.test.mjs) |
| Native Codex config и HTTP transport | [`codex-native.mjs`](codex-native.mjs), [`codex-transport.mjs`](codex-transport.mjs): `ensureCodexStableTransport` | [codex-native](tests/codex-native.test.mjs), [codex-transport](tests/codex-transport.test.mjs) |
| Cursor / Qwen | [`adapters/cursor.mjs`](adapters/cursor.mjs), [`adapters/qwen.mjs`](adapters/qwen.mjs); общие [`run-cli`](adapters/run-cli.mjs), [`stream`](adapters/stream.mjs), [`parse-args`](adapters/parse-args.mjs) | [cursor-adapter](tests/cursor-adapter.test.mjs), [parse-args](tests/parse-args.test.mjs); отдельного Qwen adapter test нет |

При ошибке Codex текущая сессия сохраняется; запрос с инструментами автоматически
не повторяется в новом thread. Это проверяют [codex-session](tests/codex-session.test.mjs)
и [provider-switch](tests/reference/provider-switch.test.mjs).
При отказе resume без подтверждённого ID и успешного результата подсказка
ведёт в /sessions или /newtask. При переполнении выводится нативная диагностика.
[Ручное сжатие](compact-codex.mjs) использует каталог выбранного проекта для
проверки MCP и возобновления треда. Успех подтверждается событием сжатия
и завершением одного и того же хода в исходной сессии.

При первом ходе Codex сообщает thread ID по событию thread.started до
завершения процесса. Обвязка передаёт его [парсеру ядра](../../../.msb/bot/src/agent/claude.mjs)
отдельным системным событием. Если ход остановлен, ID доступен в /sessions
для явного выбора. Существующий обработчик завершения хранит active ID
и счётчики отдельно от истории.

Обычная ошибка после готовых фрагментов передаёт их через системный результат
error_partial. [Ядро](../../../.msb/bot/src/agent/turn.mjs) сохраняет подтверждённый
ID в истории и передаёт футеру время и измерение текущего хода при его наличии.
[Доставка](../../../.msb/bot/src/telegram/bot.mjs) применяет прежние обработчики
к подлинному ответу модели. Диагностика CLI добавляется в готовое сообщение после
разбора команд. Журнал сохраняет статус error. [Проверка](tests/reference/provider-switch.test.mjs)
включает длинный вывод, обрыв сети и предупреждение о переполнении.
[Счётчик](../../../.msb/bot/src/agent/context.mjs) читает тот же нативный
профиль и cwd, с которыми запущен ход. /status разрешает относительный
CODEX_HOME из текущего проекта или базового workspace.

Codex — CLI-провайдер внутри канала `cc`, а не действие OS helper.
OpenClaw/service actions находятся в [core engines](../../../.msb/bot/src/engines/README.md).
Эталон, состав покрытия и результаты этапов описаны в
[reference README](../../../.msb/bot/tests/reference/README.md).

## Локальный SSH и управление ботами

[`local-ssh.mjs`](local-ssh.mjs): `installLocalSshFetchPatch` направляет подходящие
constructor-запросы в `handleLocalConstructorRequest`; здесь же находятся
проверка локального адреса, SSH keys/firewall и вызовы управления ботами.
Статус показывает [`showLocalAwareSshHome`](integration/ssh-screen.mjs), форму строит
[`menu.mjs`](menu.mjs), а ввод принимает [`handleLocalSshIpMessage`](integration/text-input.mjs).
Проверка — [local-ssh.test.mjs](tests/local-ssh.test.mjs).

## Интеграция Telegram

| Подмодуль | Ответственность |
|---|---|
| [startup](integration/startup.mjs) | `prepare`: одна подготовка PATH, локального SSH и auth gate перед установкой hook |
| [update-hook](integration/update-hook.mjs) | Startup owner/closed-core flags; owner guard до callback, отмены форм и текстового ввода; затем core passthrough |
| [callbacks](integration/callbacks.mjs) | Прежний порядок callback-ветвей; `true` поглощает событие, `false` передаёт его ядру |
| [native-login](integration/native-login.mjs) | `ensureAndReport`, `prepareCodexRuntime`, `connectCodexNative` — прежняя последовательность CLI/native auth |
| [text-input](integration/text-input.mjs) | Ввод локального IP и provider secret; используются общие pending-хранилища из `auth.mjs` / `local-ssh.mjs` |
| [ssh-screen](integration/ssh-screen.mjs) | SSH status presentation; backend не перенесён из `local-ssh.mjs` |
| [actions](integration/actions.mjs) | Запись сохранённого UI-режима |
| [shared](integration/shared.mjs) | `editOrReply`, read-only `readEngine`, CC-only guard и log marker |

При дальнейшем разделении сохранять единственность pending-хранилищ, owner boundary,
захват startup flags и порядок callback-ветвей. Исходники и установленный runtime различаются путями:
[Вход ядра](../../../tools/release/README.md).

## Источник и выпуск

Обвязка входит в тот же [commit и release](../../../tools/release/README.md), что ядро
и shared profile. Отдельный старый закрытый bundle не является runtime зависимостью
этого выпуска. Сервис [msb-updates](../../msb-updates/README.md) остаётся отдельным
компонентом; он не заменяет проверку/план текущего JAR1 release.
