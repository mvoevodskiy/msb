# Исполнение агента

[← Вход ядра](../main.mjs) ·
[Telegram ←](../telegram/README.md) ·
[CLI-провайдеры →](../../../../overlay/bot/ext/README.md)

Модуль получает prompt и signal отмены, запускает CLI и возвращает результат.
Telegram UI, progress и отправка ответа остаются в соседнем модуле. Общий вход —
[`runAgentTurn`](turn.mjs); его вызывают пользовательский ход и автономка.

## Общий ход

| Задача | Файл → функция | Проверка |
|---|---|---|
| Допуск по auth, core engine, модель/effort/права | [`turn.mjs`](turn.mjs): `runAgentTurn`; [`state.mjs`](../state.mjs): `hasClaudeAuth`, `resolveModel`, `resolveEffort`, `resolvePermMode` | [paths-state](../../tests/paths-state.test.mjs), [turn-lifecycle](../../tests/turn-lifecycle.test.mjs) |
| Сформировать системный prompt из workspace | [`system-prompt.mjs`](system-prompt.mjs): `buildSystemPrompt` | [profile-ui](../../tests/profile-ui.test.mjs) проверяет runtime label; полнота содержимого workspace отдельно не проверяется |
| Передать stream-события в progress и вернуть итог | [`runAgentTurn`](turn.mjs) → [`runClaudeTurn`](claude.mjs) | [voice-progress](../../tests/reference/voice-progress.test.mjs), [turn-lifecycle](../../tests/turn-lifecycle.test.mjs) |
| Сохранить session ID после успешного хода, который не был отменён | [`runAgentTurn`](turn.mjs): guard по signal, session ID, `sessionEpoch`, `extAuthBypass`; [`updateState`](../state.mjs) | [turn-lifecycle](../../tests/turn-lifecycle.test.mjs), [state-concurrency](../../tests/state-concurrency.test.mjs) |
| Сжать текущую сессию по провайдеру | [`compactSession`](compact.mjs) → Claude stream boundary или [Codex app-server](../../../../overlay/bot/ext/compact-codex.mjs) | [compact-routing](../../tests/compact-routing.test.mjs), [compact-codex](../../../../overlay/bot/ext/tests/compact-codex.test.mjs) |

Первый ход без ID атомарно резервирует `pendingCcSessionStarts[provider]` через
[`session-starts`](../../shared/session-starts.mjs). Обычное переключение не отменяет
этот внутренний token: поздний успешный ID сохраняется только в пустой собственный
активный/припаркованный слот. Reset текущего провайдера удаляет token даже без ID;
новая попытка заменяет его. Ошибка/abort/cleanup не удаляют token новой попытки.
Для уже существующего ID прежняя проверка `sessionEpoch`/provider/session остаётся
неизменной. [Сквозная регрессия](../../tests/first-session.test.mjs),
[матрица резерваций](../../tests/session-starts.test.mjs).

`/compact` удерживает chat lock и [`trySessionOperation`](session-operation.mjs)
до завершения процесса; из-за этого фоновый scheduler откладывает готовую задачу
до следующего тика. Claude и Codex требуют подтверждения завершения; другие CLI
не получают чужую команду. `/undo` остаётся неподключённой: откат истории Codex
и checkpoint Claude не равны прежней отмене последней файловой операции бота.

## Представление агента и контекст

[`agentDisplay`](display.mjs) читает выбранного провайдера и model/effort.
[`readSessionContext` / `formatContextUsage`](context.mjs) берут native context
активной сессии; неизвестный процент не выдумывается. `runAgentTurn` передаёт
контекст в Telegram footer и защищает сохранение от позднего результата после reset.
Проверки: [codex-context](../../tests/codex-context.test.mjs),
[turn-context](../../tests/turn-context.test.mjs), [provider-state-concurrency](../../tests/provider-state-concurrency.test.mjs).

Формат результата — `{ ok, text, result }` либо ошибка допуска/отмены.
Доставка результата: [Telegram → Жизненный цикл хода](../telegram/README.md#жизненный-цикл-хода).

## CLI и выбор провайдера

[`runClaudeTurn`](claude.mjs) запускает `claude` и читает Claude stream-json.
Без overlay это штатный CLI. С overlay имя `claude` разрешается через PATH-shim:

[`overlay/run.mjs`](../../../../overlay/bot/run.mjs) устанавливает PATH →
[`shim/bin/claude`](../../../../overlay/bot/ext/shim/bin/claude) →
[`shim/run-turn.mjs`](../../../../overlay/bot/ext/shim/run-turn.mjs) читает active provider →
реальный Claude либо соответствующий adapter → совместимый stream-json для ядра.

| Что искать | Реализация | Проверка |
|---|---|---|
| Аргументы Claude CLI и разбор stream | [`claude.mjs`](claude.mjs): `runClaudeTurn`, `parseStreamLine`; вспомогательные тестовые функции в [`claude-testables.mjs`](claude-testables.mjs) | [claude-argv](../../tests/claude-argv.test.mjs) проверяет построение аргументов/разбор |
| Завершение дочернего процесса и его группы | [`runClaudeTurn`](claude.mjs) | [claude-abort](../../tests/claude-abort.test.mjs), [stop-polling](../../tests/reference/stop-polling.test.mjs) |
| Provider dispatch, native session и passthrough Claude | [`runAlternate`](../../../../overlay/bot/ext/shim/run-turn.mjs), adapter | [provider-switch](../../../../overlay/bot/ext/tests/reference/provider-switch.test.mjs); [карта обвязки](../../../../overlay/bot/ext/README.md#исполнение-cli) |

Codex не требует значения `state.engine = codex`: это выбор overlay внутри
штатного CLI-канала `cc`. Отдельный `oc` обрабатывается как другой core engine;
управление его сервисами описано в [OS-движках](../engines/README.md).

При разделении runner сохранять signal отмены, границы process group,
stream-контракт и guard записи сессии. Эталон поведения и пределы проверки —
[reference README](../../tests/reference/README.md), [контракт Claude CLI](../../vendor/CONTRACT-agent-cc.md).


Claude control/plan uses the old conversational instructions in [mode-prompt](mode-prompt.mjs)
from the same provider/mode snapshot as its CLI options. Both map to acceptEdits;
this is a model request to wait for the old final marker/Telegram approval, not a
native permission guarantee. Codex saved UI mode activates neither prompt and
changes no native rights. Shared [mode vocabulary](../../shared/permission-modes.mjs)
keeps the old visible choices/fallback; [production tests](../../tests/agent-modes.test.mjs)
check callback writes and actual child argv/prompt. Plan delivery/continuation is
verified in its own Telegram stage, not by argv tests alone.
