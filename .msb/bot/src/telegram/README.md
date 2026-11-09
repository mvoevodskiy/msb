# Telegram

[← Вход ядра](../main.mjs) ·
[Исполнение агента →](../agent/README.md) ·
[CLI-провайдеры →](../../../../overlay/bot/ext/README.md)

Модуль принимает события Telegram, показывает меню и ведёт пользовательский ход.
Текстовые формы выделены в [dispatcher](forms.mjs) и подмодули [auth](forms/auth.mjs),
[env](forms/env.mjs) (name→value→description/skip, transient draft/общий TTL), [Pult](forms/pult.mjs); они не запускают отдельный agent path.
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

Сохранённые [таймеры](../autonomy/legacy-dispatch.mjs) резервируют обычный
FIFO-элемент через createBot. Модель запускается после подтверждения записи.
Вход проходит мимо форм и сборщика пересылок. Для нескольких ожидающих
текстов сохранено объединение в рамках одного чата и темы.
[Проверки запуска и отмены](../../tests/legacy-timer-dispatch.test.mjs).

Разовое или регулярное напоминание из хода владельца проходит через
[обработчик итогового ответа](./reminder-markers.mjs) в
[хранилище действий](../autonomy/reminder-store.mjs). Список и карточка в
[меню «Задачи»](./screens/reminders.mjs), отправка в
[планировщике](../autonomy/reminder-dispatch.mjs). Общая [пауза](./pause-markers.mjs)
разбирается в итоговом ответе владельцу. [Подтверждение для старых таймеров](./pause-confirmation.mjs)
использует прежние кнопки и передаёт запись в модуль автономки.
[Карточка частоты](./frequency-confirmation.mjs) принимает выбор владельца
на исходном сообщении. [Ограничение частоты](../autonomy/reminder-frequency-brake.mjs)
применяет ответ на следующем допустимом тике.

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
| [models](routes/models.mjs) | `handleModelRoute`: family/Versions, один lock alert до ack, сохранение CLI choice без reset |
| [agent](routes/agent.mjs) | `handleAgentRoute`: auth, effort, права; `handleSetupRoute`: поздний `setup:*` fallback |
| [system](routes/system.mjs) | `handleSystemRoute`: системный экран, restart, SSH и updates |
| [bots](routes/bots.mjs) | `handleBotsRoute`: список, карточка, формы добавления/удаления бота |
| [settings](routes/settings.mjs) | `handleSettingsRoute`: `.env`, timezone, лимиты, сведения, STT и уведомления |
| [engines](routes/engines.mjs) | `handleEnginesRoute`: обычный экран и опциональный OS dispatcher |
| [autonomy](routes/autonomy.mjs) | `handleAutonomyRoute`: задачи, история, таймеры и сохранённые права |
| [monitor](routes/monitor.mjs) | `handleMonitorRoute`: источники, дайджест, сбор и настройки |
| [workspace](routes/workspace.mjs) | `handleWorkspaceRoute`: MCP callbacks → [MCP](../mcp/README.md) |

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
| [agent](screens/agent.mjs) | Агент, effort, права, Claude connection/setup; совместимый re-export моделей |
| [models](screens/models.mjs) | Прежние family/Versions, selected/locks и Back; pure renderer |
| [settings](screens/settings.mjs) | Настройки, `.env`, timezone, сведения о сервере, уведомления |
| [spend](screens/spend.mjs) | /cost, история по дням владельца и прежние значения дневного лимита |
| [system](screens/system.mjs) | Системные пункты, обновления, restart, SSH и STT |
| [engines](screens/engines.mjs) | `enginesScreen` — прежние controls и опциональный provider view |
| [sessions](screens/sessions.mjs) → [list](screens/session-list.mjs) | CLI ledger/pages; `statusScreen` — текущий агент и native-контекст |
| [autonomy](screens/autonomy.mjs) | Задачи, история и права автономки |
| [legacy-timers](screens/legacy-timers.mjs) | Список и карточка сохранённых таймеров |
| [monitor](screens/monitor.mjs) | Источники, дайджест, настройки и справка мониторинга |
| [bots](screens/bots.mjs) | `botsScreen`, `botDetailScreen` — список и карточка бота |
| [projects](screens/projects.mjs) | Прежний список/страницы, выбор и форма проекта |
| [skills](screens/skills.mjs) → [catalog](../skills/README.md), [OC list](screens/openclaw-skills.mjs) | CLI папки/карточки/содержимое, OC группы/Back; [read lifecycle](skills-read.mjs) |
| [workspace](screens/workspace.mjs) | MCP |
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
| Подставить результат установки перед планом и дневником | [`processInstallMarkers`](install-markers.mjs) | [skills](../../tests/skills-install.test.mjs), [MCP](../../tests/mcp-marker.test.mjs) |
| Ответ, HTML, chunks, footer, edit/send fallback | [`deliverTurnResponse`, `renderResponseHtml`, `formatTurnFooter`](response.mjs) | [response-delivery](../../tests/response-delivery.test.mjs) |
| Отмена presentation-запросов и retry_after | [`presentationSignal`, `presentationAwareRetry`](presentation-api.mjs) | [presentation-retry](../../tests/presentation-retry.test.mjs) |

Переход к модели: [общий ход агента](../agent/README.md#общий-ход).
Границы эталонных проверок: [reference README](../../tests/reference/README.md).


## Долгое чтение статуса и навигация

[Router](router.mjs) оставляет read-only status и Claude Agent/model/Versions/effort views в tracked tasks, чтобы polling
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


Claude model selection → [agent route](routes/agent.mjs) → [choice setters](actions.mjs)
changes only model fields, retaining the native ID and unfinished first-start token.
This matches old Ey/I2; a real mode change and /newtask/clear still reset the chosen
conversation. Provider slots/epoch fences remain in shared/overlay modules.
[Model ingress](../../tests/model-conversation.test.mjs) and
[first-start lifecycle](../../tests/first-session.test.mjs) cover the distinction;
old provenance and still-pending catalog locks are in
[agent settings contract](../../tests/reference/parity-agent-settings-contract.txt).


## Подтверждение плана и правки

Финальный ответ → [plan parser](plan.mjs) → [response](response.mjs) удаляет
thinking и отправляет отдельную прежнюю карточку; footer/keyboard только на
последнем chunk, включая plain fallback. Tool/text progress не создаёт approvals;
отменённый ход не доставляет final card, infrastructure error не парсится как план.
[Plan actions](plan-actions.mjs) получает callback через существующий router:
approve/always/skip → тот же inbox; reject → прежний ответ без модели; comment →
один следующий обычный текст после secret forms. Always — текст модели, не grant.
State комментария принадлежит createBot, без TTL, с привязкой к исходному чату.
Owner guard и topic входа сохраняются. Нового persistent approval ledger или
exactly-once/replay fence нет, как и в old callback protocol. Полная кнопочная
безопасность не следует из prompt-маркера; native права Codex не меняются.
[Callback/delivery tests](../../tests/plan-handoff.test.mjs),
[полный fake-CLI resume](../../tests/plan-turn.test.mjs),
[old provenance и границы](../../tests/reference/parity-agent-settings-contract.txt).


Claude family/Versions → [model route](routes/models.mjs) → [native version](../agent/claude-version.mjs)
и [catalog policy](../agent/models.mjs) → [model screens](screens/models.mjs).
Pinned callback получает один alert до обычного ack, если CLI unknown/too old;
setter использует тот же catalog и сохраняет ID/epoch/parked slots/effort.
Aliases остаются native aliases. Fable — прежний one-tap, без нового confirm.
Старые Claude aliases/pinned IDs перехватывает overlay guard до чужого native config.
[Contract](../../tests/reference/parity-model-catalog-contract.txt),
[production checks](../../tests/model-catalog.test.mjs).

Cold Claude metadata read uses the same tracked readonly callback scope as status:
Agent/model/Versions/effort return polling before the query ends; later navigation
suppresses obsolete rendering, shutdown drains the bounded query. This does not
cancel authorized model writes. A cold pinned-selection guard stays ordered and
can wait up to5s before its single lock alert/ack, matching the old bound.
[Readonly lifecycle](../../tests/model-read-lifecycle.test.mjs).


Проекты: [callback route](routes/projects.mjs), [команды](project-commands.mjs) и
[форма](forms/projects.mjs) используют общий [project contract](../projects/README.md).
Renderer сохраняет старые тексты, nine-per-page/three-per-row и Back/Close маршруты;
длинное существующее имя получает bounded callback, без persistent registry.
Меню проверяет имя строго, `/project new` сохраняет отдельное старое правило sanitize.
Pending payload связывает отмену с фактически отправленным prompt ID, включая
edit→send fallback; старая кнопка не закрывает новую форму. Ни form TTL, ни busy
запрет на выбор проекта не добавлены. [Сквозные проверки](../../tests/projects.test.mjs)
проверяют filesystem/state, а не только наличие кнопок.


Сессии: [route](routes/sessions.mjs) → [atomic selector](../sessions/selection.mjs),
список из [per-bot ledger](../sessions/README.md). Сохраняются прежние numeric
buttons/pages и empty/reset тексты. Команда и callbacks используют один renderer;
list/page/select не меняют pending owner. `disablePreview` передаётся через общий
edit/send/scope путь, сохраняющий old link_preview_options; нет обхода delivery lane.
[Production checks](../../tests/sessions.test.mjs) проверяют scope/epoch после directory
await и переходы project+ID, а не только наличие кнопок. OC history backend остаётся
отдельным отсутствующим переносом. Native resume/overlap и full release gate —
следующий обязательный этап до выкладки, не доказанный одним menu PASS.


Prepared HTML view доставляется через [view-delivery](view-delivery.mjs): обычный
экран не меняется, в том числе при encoded raw HTML длиннее4096, если текст после
entities помещается. Для действительно длинного вида используется существующий
pure [response splitter](response.mjs), без model-formatting/plan/skill markers
и footer. Короткие code-span имена не режутся, если помещаются целиком; длинные
значения сохраняются в частях. Старая клавиатура очищается на промежуточных частях,
исходная остаётся только на последней. Caller сохраняет ctx.reply и render lane;
после навигации/stop следующие части не отправляются. Model-turn default splitting
не меняется. [Transport checks](../../tests/view-delivery.test.mjs),
[production OC workflow](../../tests/skills-openclaw.test.mjs).
