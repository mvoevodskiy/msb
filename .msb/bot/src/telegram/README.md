# Telegram

[← Вход ядра](../main.mjs) ·
[Исполнение агента →](../agent/README.md) ·
[CLI-провайдеры →](../../../../overlay/bot/ext/README.md)

Модуль принимает события Telegram, показывает меню и ведёт пользовательский ход.
Текстовые формы выделены в [dispatcher](forms.mjs) и подмодули [auth](forms/auth.mjs),
[env](forms/env.mjs), [Pult](forms/pult.mjs); они не запускают отдельный agent path.
Точка сборки — [`createBot`](bot.mjs): owner guard, команды, callback/text/voice
handlers, общие `pending`, `running` и [очередь](#очередь). [`main`](../main.mjs) управляет запуском
и shutdown процесса.

## Очередь

Пачка/сообщения во время хода → [`createInbox`](inbox.mjs) → один FIFO worker →
`executeTurn` в [`bot.mjs`](bot.mjs) → [общий provider runner](../agent/README.md).
Обычный текст, включая каждый элемент queued merge, использует общий
[`buildReplyContext`](reply-context.mjs); цитата добавляется только в prompt,
журнал хранит прежний input. Формы и команды по цитате не исполняются.
[Подготовка пересланной пачки](batch.mjs): `prepareBatch` последовательно вызывает
тот же [`recognizeVoice`](voice.mjs), оставляет порядок и позиции неудачных STT.
Таймеры сбора, лимиты, слияние соседнего ожидающего текста и drain принадлежат
`inbox.mjs`; providers/auth/session не хранятся в очереди. Движок выбирается
штатным runner при старте хода, а не отдельным batch-adapter.

Формы `pending` и команды обслуживаются до inbox. Обычный комментарий при открытом
collector присоединяется к пачке; `/stop` очищает collector/FIFO и отменяет active,
`/clear`/`/newtask` лишь сбрасывают беседу. Ответ словом «стоп» отменяет
активный ход, сохраняя очередь и collector; без активного хода потребляется
без запуска модели. Это прежний отдельный путь, а не полный синоним `/stop`. Shutdown отменяет и дожидается доставки;
после polling retry очередь снова принимает входы. Очередь оперативная, без диска.
Вложения по-прежнему обслуживает отдельный существующий handler.

[Эталон пачки](../../tests/reference/inbox-contract.md) ·
[Контракт ordinary reply / reply-stop](../../tests/reference/parity-inputs-contract.txt) ·
[Handler + STT lifecycle tests](../../tests/inbox-lifecycle.test.mjs) ·
[Timer/cap/FIFO tests](../../tests/inbox.test.mjs).

## Настройки и кнопки

Маршрут **Настройки → Движки → Codex**:

1. [`settingsScreen`](screens/settings.mjs) создаёт кнопку `eng:home`.
2. [`handleCallback`](router.mjs) передаёт общий контекст в
   [`handleEnginesRoute`](routes/engines.mjs). Экран [`enginesScreen`](screens/engines.mjs)
   получает опциональный provider view через `Symbol.for('msb.engineProviderView')`.
3. [`buildEngineProviderView`](../../../../overlay/bot/ext/engine-menu.mjs)
   читает canonical provider store; открытие экрана не выполняет login.
4. Кнопка Codex использует `ext:conn:set:codex`. Её обрабатывает
   [`handleCallback` overlay](../../../../overlay/bot/ext/integration/callbacks.mjs):
   [выбор и авторизация](../../../../overlay/bot/ext/README.md#выбор-и-авторизация).

| Задача | Файл → функция / участок | Проверка |
|---|---|---|
| Текст, клавиатура, callback кнопки | [Семейство экранов](#семейства-экранов) → нужный `*Screen`; [`screens.mjs`](screens.mjs) сохраняет прежние экспорты | [ui-screens](../../tests/ui-screens.test.mjs) |
| Действие callback и переход назад | [`handleCallback`](router.mjs) → [семейство маршрутов](#callback-маршруты) | Для «Движков»: [core engine-menu](../../tests/engine-menu.test.mjs), [core + overlay](../../../../overlay/bot/ext/tests/reference/engine-menu.test.mjs) |
| Команды `/settings`, `/stop`, `/newtask` | [`bot.mjs`](bot.mjs): регистрации `bot.command`; [`commands.mjs`](commands.mjs): каталог и help | [turn-lifecycle](../../tests/turn-lifecycle.test.mjs), [stop-polling](../../tests/reference/stop-polling.test.mjs) |
| Последующее текстовое значение формы | [`forms.mjs`](forms.mjs): dispatcher к auth/env/Pult inputs; `createBot` хранит pending и приоритет reply-stop/timezone; форму открывает нужный обработчик `routes/` | [menu-handlers](../../tests/menu-handlers.test.mjs) проверяет переходы и отмену форм |
| Значение `.env` | [`envScreen`](screens/settings.mjs) → [`handleSettingsRoute`](routes/settings.mjs) / pending → [`setEnvKey`](../env/store.mjs) | [monitor-env](../../tests/monitor-env.test.mjs) проверяет хранилище; [menu-handlers](../../tests/menu-handlers.test.mjs) — ввод |

Env удаление использует прежний двухшаговый путь: `settings:env:delete:*`
лишь открывает подтверждение; `settings:env:confirm-delete:*` вызывает store.
Возврат к списку и прежний `settings:env:cancel` сбрасывают ожидание ввода в core
и overlay. [PendingInputs](pending-input.mjs) хранит срок env/Claude формы от
открытия; переход к значению не продлевает 10 минут. После истечения следующий
текст потребляется с прежним сообщением, без записи/модели/перезапуска. У voice и
прочих нет нового общего срока. [Контракт форм](../../tests/reference/parity-forms-contract.txt).

Callback-строки — внешние идентификаторы кнопок. При разделении файлов сохранять
их, порядок обработки, обратные переходы и owner guard. Стандартные Claude/OC
callbacks и callbacks расширения имеют разных обработчиков.

## Callback-маршруты

[`handleCallback`](router.mjs) подтверждает callback, применяет прежнюю отмену форм,
один раз загружает общий `state` и передаёт обработчикам тот же `pending` и `show`.
Owner boundary остаётся перед core router: middleware бота и hook расширения.

| Подмодуль | Маршруты и функции |
|---|---|
| [navigation](routes/navigation.mjs) | `handleNavigationRoute`: главное меню, новые сессии/проекты, `whisper:skip`; `handleMiscRoute`: поздние `plan:*` |
| [agent](routes/agent.mjs) | `handleAgentRoute`: auth, модель, effort, права; `handleSetupRoute`: поздний `setup:*` fallback |
| [system](routes/system.mjs) | `handleSystemRoute`: системный экран, restart, SSH и updates |
| [bots](routes/bots.mjs) | `handleBotsRoute`: список, карточка, формы добавления/удаления бота |
| [settings](routes/settings.mjs) | `handleSettingsRoute`: `.env`, timezone, лимиты, сведения, STT и уведомления |
| [engines](routes/engines.mjs) | `handleEnginesRoute`: обычный экран и опциональный OS dispatcher |
| [autonomy](routes/autonomy.mjs) | `handleAutonomyRoute`: задачи, история, таймеры и сохранённые права |
| [monitor](routes/monitor.mjs) | `handleMonitorRoute`: источники, дайджест, сбор и настройки |
| [workspace](routes/workspace.mjs) | `handleWorkspaceRoute`: MCP callbacks |

Диспетчер сохраняет исходный порядок; поздние setup/misc обработчики вызываются
после workspace. Только [`UNHANDLED`](routes/shared.mjs) означает «не мой маршрут».
`undefined` завершает уже распознанный callback. Если все обработчики вернули
`UNHANDLED`, сохраняется прежняя запись `unhandled callback` в журнал.

## Семейства экранов

[`screens.mjs`](screens.mjs) — совместимый фасад. Реализации находятся в `screens/`;
при разделении сохранены сигнатуры, тексты, callback-строки и порядок кнопок.

| Подмодуль | Что искать |
|---|---|
| [hub](screens/hub.mjs) | `hubKeyboard`, `hubScreen` — главное меню |
| [agent](screens/agent.mjs) | Агент, модель, effort, права, Claude connection/setup |
| [settings](screens/settings.mjs) | Настройки, `.env`, timezone, лимит, сведения о сервере, уведомления |
| [system](screens/system.mjs) | Системные пункты, обновления, restart, SSH и STT |
| [engines](screens/engines.mjs) | `enginesScreen` — прежние controls и опциональный provider view |
| [sessions](screens/sessions.mjs) | `sessionsScreen`, `statusScreen` — текущий агент и native-контекст |
| [autonomy](screens/autonomy.mjs) | Задачи, история, таймеры и права автономки |
| [monitor](screens/monitor.mjs) | Источники, дайджест, настройки и справка мониторинга |
| [bots](screens/bots.mjs) | `botsScreen`, `botDetailScreen` — список и карточка бота |
| [workspace](screens/workspace.mjs) | Проекты, навыки, MCP |
| [shared](screens/shared.mjs) | Общий blank-символ и `placeholder` |

## Голос

[`message:voice`](bot.mjs) → `executeTurn(..., true)` →
[`recognizeVoice`](voice.mjs) → [`transcribeVoice`](../media/stt.mjs) →
[`runAgentTurn`](../agent/turn.mjs) → [`deliverTurnResponse`](response.mjs).

| Часть сценария | Функция и ответственность | Проверка |
|---|---|---|
| Получить файл из Telegram, скачать, учесть исходный reply | [`recognizeVoice`](voice.mjs), [`buildReplyContext`](reply-context.mjs) | [voice-lifecycle](../../tests/voice-lifecycle.test.mjs), [reply-context](../../tests/reply-context.test.mjs) |
| Выбрать STT backend, env, timeout; получить полный текст | [`resolveSttConfig`, `transcribeVoice`](../media/stt.mjs) | [stt](../../tests/stt.test.mjs) |
| Показать прежнюю цитату до 300 позиций и волну | [`voicePreview`](voice.mjs) | [voice-preview](../../tests/voice-preview.test.mjs) |
| Проверить связный старый сценарий voice → CLI → ответ | [`executeTurn`](bot.mjs) | [voice-progress reference](../../tests/reference/voice-progress.test.mjs) |

Голос проходит напрямую в общий ход, минуя pending текстовых форм. Preview
ограничивается для отображения; агент получает полный transcript с reply-контекстом.

## Жизненный цикл хода

`executeTurn` в [`bot.mjs`](bot.mjs) связывает подготовку, исполнение и доставку.
`running` удерживает ход до cleanup; `/stop` отменяет общий `AbortController`.
Polling получает управление до окончания исполнения, а shutdown ждёт `turn.done`.

| Подмодуль | Функции | Проверка |
|---|---|---|
| Допуск, отмена, завершение и следующий ход | [`createBot` / `executeTurn`](bot.mjs) | [turn-lifecycle](../../tests/turn-lifecycle.test.mjs), [stop-polling](../../tests/reference/stop-polling.test.mjs) |
| Typing и прежний цикл статусов | [`startTurnProgress`](progress.mjs) | [progress](../../tests/progress.test.mjs), [voice-progress](../../tests/reference/voice-progress.test.mjs) |
| Ответ, HTML, chunks, footer, edit/send fallback | [`deliverTurnResponse`, `renderResponseHtml`, `formatTurnFooter`](response.mjs) | [response-delivery](../../tests/response-delivery.test.mjs) |
| Отмена presentation-запросов и retry_after | [`presentationSignal`, `presentationAwareRetry`](presentation-api.mjs) | [presentation-retry](../../tests/presentation-retry.test.mjs) |

Переход к модели: [общий ход агента](../agent/README.md#общий-ход).
Границы эталонных проверок: [reference README](../../tests/reference/README.md).


## Долгое чтение статуса и навигация

[Router](router.mjs) оставляет read-only `eng:status` и `settings:pult:refresh` в tracked task, чтобы polling
принимал следующую команду. [Shared callback scope](../../shared/callback-renders.mjs)
один для core/overlay и сохраняется через async continuation. Новый callback или
/start, /settings, /stop отменяет прежний UI read/backoff; уже разрешённые записи
настроек/системные действия этим не отменяются. Scope последнего выбранного экрана
остаётся current после handler return, пока пользователь не выбрал другой.

Telegram мог уже принять edit: его нельзя прервать navigation signal и считать
доставку оконченной. Общая per-chat delivery lane дожидается отправленного edit
перед новым экраном. [API policy](presentation-api.mjs) сохраняет штатный autoRetry,
но разделяет signal retry/read и отдельную15с попытку транспорта. Проверка scope
перед повтором/приёмом следующего render исключает obsolete delivery/retry;
после transport timeout серверное применение остаётся внешней неопределённостью.
[Bot stop](bot.mjs) отменяет наблюдателей и drains tasks/lane перед возвратом.
Проверки: [production callbacks](../../tests/callback-refresh.test.mjs),
[detached overlay scope](../../tests/callback-scope.test.mjs). Новых кнопок нет.


Пульт: [status adapter](../pult/status.mjs) отличает unknown/partial от полного
helper snapshot. Обычный вход/Back читает cache без дополнительных IPC запросов;
существующая «Обновить» вызывает общий status round trip. Refused/timeout/partial
не отображаются как stale success. Callback root `settings:pult` совместим как
вход в раздел; после rendering кнопка Refresh имеет `settings:pult:refresh`.
Это одна прежняя кнопка, не новый экран/daemon. Выход из Pult input при deferred
Refresh выполняется однократно на admission, до любых await. После загрузки state
obsolete read ещё раз проверяет scope, чтобы не затронуть вновь открытую форму.
[Production проверки](../../tests/pult-status.test.mjs) используют synthetic jar1.
