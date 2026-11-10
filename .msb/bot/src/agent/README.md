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
| Сформировать prompt из базовых owner files и выбранного cwd | [`system-prompt.mjs`](system-prompt.mjs) → [проектный контекст](../projects/context.mjs) | [project-execution](../../tests/project-execution.test.mjs), [project-context](../../tests/project-context.test.mjs); полнота всех old owner files отдельно не доказана |
| Передать stream-события в progress и вернуть итог | [`runAgentTurn`](turn.mjs) → [`runClaudeTurn`](claude.mjs) | [voice-progress](../../tests/reference/voice-progress.test.mjs), [turn-lifecycle](../../tests/turn-lifecycle.test.mjs) |
| Сохранить ID/usage и описание сессии в одной транзакции | [`runAgentTurn`](turn.mjs) → [`applySessionResult`](session-result.mjs) → [`ledger`](../sessions/ledger.mjs), через [`updateState`](../state.mjs) | [session-ledger](../../tests/session-ledger.test.mjs), [turn-lifecycle](../../tests/turn-lifecycle.test.mjs), [state-concurrency](../../tests/state-concurrency.test.mjs) |
| Сжать текущую сессию по провайдеру | [`compactSession`](compact.mjs) → Claude stream boundary или [Codex app-server](../../../../overlay/bot/ext/compact-codex.mjs) | [compact-routing](../../tests/compact-routing.test.mjs), [compact-codex](../../../../overlay/bot/ext/tests/compact-codex.test.mjs) |

Первое знакомство Codex в пустом workspace идёт из /start и обычного входящего
сообщения через [отдельный сценарий](codex-bootstrap.mjs). Он использует тот же
CLI и выбранный native профиль, ведёт отдельную беседу по чату и теме и завершает
запись [файлов workspace](bootstrap-workspace.mjs). /clear сбрасывает знакомство
в исходной теме, /newtask сохраняет его. Готовые файлы или подтверждённая прежняя
обычная беседа исключают повторное знакомство при обновлении. Карточка сервисов
остаётся следующим этапом. [Проверки](../../tests/codex-bootstrap.test.mjs).

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

[Событие квоты Claude](claude-quota.mjs) обновляет старый rateLimitInfo в
профиле бота, даже если CLI вернул отказ и ещё нет ID сессии. Снимок пишется
из потока выбранного Claude. Смена движка, провайдера или режима авторизации
до сохранения не допускает позднюю запись. Снимок читают автономка и
существующий сборщик Пульта. [Проверка потока](../../tests/claude-quota-stream.test.mjs).

[Парсер Claude](claude.mjs) хранит total_cost_usd в результате как
meteredCostUsd. Это значение CLI, в том числе возможный итог сессии.
[Экран расходов](../telegram/screens/spend.mjs) читает только сохранённую
историю владельца. [Граница переноса](../../tests/reference/parity-owner-spend-contract.txt).

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

Отказ открыть сохранённую сессию Claude распознаёт [разбор CLI](claude.mjs).
[Ход](turn.mjs) повторяет исходный запрос с теми же аргументами без resume
после [проверки и замены активной записи](session-result.mjs). История прежнего
ID остаётся доступной, счётчик не растёт от отказа до работы модели.
[Локальные проверки](../../tests/claude-resume-recovery.test.mjs) и
[проверка нативного CLI](../../tests/fixtures/claude-resume-loopback.mjs).

[Контекст Claude](claude-context.mjs) берёт счётчики последнего входа и кэша
из потока CLI. Порог берётся из параметров того же запуска. [Ход](turn.mjs)
передаёт измерение в общий футер и запись текущей сессии.
[Проверки](../../tests/claude-context-footer.test.mjs).

При остановке [CLI runner](claude.mjs) сохраняет уже разобранный текст
и его замер до отправки сигнала. [Telegram](../telegram/bot.mjs) завершает
этим фрагментом ход, остановленный владельцем. [Проверки](../../tests/turn-lifecycle.test.mjs).

[Ошибки обычного хода](turn.mjs) передают частичный текст и его контекст
в общий футер. [Кадры ошибки API](claude.mjs) выводятся отдельно от текста,
который может запускать действия. [Проверки](../../tests/claude-partial-error.test.mjs).


Claude control/plan uses the old conversational instructions in [mode-prompt](mode-prompt.mjs)
from the same provider/mode snapshot as its CLI options. Both map to acceptEdits;
this is a model request to wait for the old final marker/Telegram approval, not a
native permission guarantee. Codex saved UI mode activates neither prompt and
changes no native rights. Shared [mode vocabulary](../../shared/permission-modes.mjs)
keeps the old visible choices/fallback; [production tests](../../tests/agent-modes.test.mjs)
check callback writes and actual child argv/prompt. Plan delivery/continuation is
verified in its own Telegram stage, not by argv tests alone.


[Claude effort policy](effort.mjs) validates the old five preferences and resolves
only the outgoing flag from the selected concrete CLI model. Haiku4.5 omits it;
non-Opus xhigh/max fall back to high; pinned Opus4.6 retains max, maps xhigh to high.
[state.resolveEffort](../state.mjs) is shared by turns and compact, while the
[screen](../telegram/screens/agent.mjs) keeps raw preference and states the fallback.
No saved preference/session/native config is migrated. Codex effort remains in
its adapter/store; model catalog/CLI-version locks are a separate pending audit.
[UI/argv/compact checks](../../tests/claude-effort.test.mjs).


## Каталог Claude и native CLI metadata

[Shared catalog](../../shared/claude-models.mjs) содержит закреплённые old V1 данные;
[models](models.mjs) вычисляет aliases, locks, подписи и defaults. Значение alias
передаётся CLI, а версии служат UI/effort policy. Pinned callback выбирает точный
CLI ID; retired opusplan разрешается в opus без неявной disk/session migration.
Legacy raw ID остаётся passthrough; early open-core fable сохраняет значение Fable5.
[Version reader](claude-version.mjs) спрашивает только native `--version` через
[общий resolver](../../shared/claude-binary.mjs), который также используют startup
и passthrough shim. Timeout 5s/SIGKILL, stdout 4KiB; shell/auth/CLI install отсутствуют.
Fingerprint/backoff/coalescing не позволяют старому ответу разблокировать новую
установку. Для Codex этот запрос на ходе не выполняется: его model/effort native.
Turn/compact/display используют одну версию и [effort policy](effort.mjs).
Explicit legacy off сохраняет native default без preferred-high override.
[Metadata/cache tests](../../tests/claude-version.test.mjs),
[UI/state/provider tests](../../tests/model-catalog.test.mjs),
[actual argv](../../tests/claude-effort.test.mjs). Реальные auth/model availability
и весь OpenClaw backend этим каталогом не доказываются.


## Проект и рабочий каталог

[Проектный контракт](../projects/README.md) разделяет стабильный base workspace и
cwd выбранного проекта. `runAgentTurn` захватывает base/state до подготовки prompt,
проверяет выбранную папку и явно передаёт её `runClaudeTurn`. Native dispatch уже
наследует этот cwd; `process.chdir()` и подмена глобальных env/auth путей не нужны.
SOUL/USER/MEMORY/CLAUDE/TELEGRAM-TOOLS остаются из base. Текущая задача, заметки за
локальный день и knowledge index дополняют их из captured cwd.

Явный выбор проекта сбрасывает conversation slots и все старые first-start tokens
одной транзакцией. Поэтому поздний результат старой папки не вернёт её native ID
после смены провайдера; завершение не удалит token нового хода. [Race-проверки](../../tests/project-races.test.mjs)
используют production runner/state и подменённый модельный процесс. Они не доказывают
особенности автоматического чтения CLAUDE/AGENTS настоящими native CLI.


## Журнал описаний сессий

[Session result](session-result.mjs) сохраняет прежние ownership fences, active/
parked first-placement и usage. В той же транзакции [ledger](../sessions/ledger.mjs)
индексирует ID, captured provider/project, первые/последние200символов и число
вернувшихся engine passes (limit100). Это не импорт или просмотр native transcripts.
История индексирует достоверный возвращённый ID независимо от допуска к active/
parked placement: first error/abort и late reset/project/select результат остаются
доступны для явного выбора, но не возвращают active ID/usage и не трогают новую
reservation. Runner возвращает факты spawned/sessionIdObserved: launched carried
known resume тоже считается; pre-spawn abort, ненаблюдённый новый ID, foreign и
sentinel не создают запись. Count/lastPrompt меняются в порядке завершения, first
metadata не переписывается. Это отдельное решение от active/usage fences. Tool-only и
фоновые ходы используют тот же путь, как old tE. Исходный Pult/Telegram journal
остаётся отдельным; его [redaction](../history/preview.mjs) теперь общая, без смены
логики. Контракт и ограничения: [sessions reference](../../tests/reference/parity-sessions-contract.txt).
[Список/выбор](../sessions/README.md) теперь использует этот ledger; запись metadata
и menu PASS сами по себе не доказывают фактический resume/native CLI. Реальные
пользовательские истории не мигрируются.


## Инструкция установки навыка и результат

В той же state snapshot, что session/provider/cwd, runner захватывает
[install-target](../skills/install-target.mjs) и добавляет [protocol instruction](../skills/install-protocol.mjs)
в append prompt. Возвращает descriptor `skillInstall`, без env/auth/секретов.
Поздний выбор другого провайдера не перенаправляет запись. Сами файлы здесь
не пишутся: [Telegram finalizer](../telegram/install-markers.mjs) обрабатывает
реальный законченный model text до plan/delivery/journal. Abort и infrastructure
exceptions не исполняют marker. OC partial-error не расширяется до success path;
родной OC model backend и отдельные background finish paths ещё не доказаны.
[Сквозной тест](../../tests/fixtures/skills-install-ingress.mjs) вызывает реальный
bot/runner/finalizer с подменой только внешнего child protocol, без auth/network.
[Production contracts](../../tests/skills-install.test.mjs).

В обычном Telegram-ходе runner также захватывает [цель ADD_MCP](../mcp/managed.mjs)
и добавляет [схему старого маркера](../mcp/install-protocol.mjs). Ответ передаёт
провайдера, идентичность бота и каталог хода. При частичной ошибке Claude
проверяется наличие текста ассистента в потоке. Служебный ответ об ошибке
Codex не получает права записи. [Вход и проверка](../../tests/mcp-marker.test.mjs).

## Обычный ход OpenClaw

[Общий runner](turn.mjs) направляет выбранный OpenClaw в [acpx](openclaw-turn.mjs)
до проверки Claude auth. Запрос с контекстом уходит в закрытом временном файле.
[ACP-поток](openclaw-protocol.mjs) передаёт текст, статусы инструментов и
измеренный контекст в прежнюю доставку. [Профиль](openclaw-profile.mjs) фиксирует
путь к Gateway в ключе очереди acpx. /stop адресуется текущему имени, а
[сброс](../sessions/openclaw.mjs) сохраняет прежний ID и меняет только OC-слот.
[Тесты хода](../../tests/openclaw-turn.test.mjs) и
[старый контракт](../../tests/reference/parity-openclaw-turn-contract.txt).
