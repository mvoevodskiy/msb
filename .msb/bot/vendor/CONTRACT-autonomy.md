# CONTRACT: Autonomy / Scheduler / Background Tasks

Источник: `deobfuscated.js` (пути `~/.msb/…`, маркеры `SCHEDULE_TASK`, петли `iia/scheduler` / `autonomy/loop` / `autonomy/cron-bridge`).

Контракт описывает **как реализовано**, а не продуктовую документацию для владельца.

---

## 1. On-disk layout

Корень данных бота: `V4 = dirname(MSB_SESSION_DIR || ~/.msb/sessions)` → обычно `~/.msb`.  
Хелпер `UA(rel)` = `join(V4, rel)`.

### Каталог `~/.msb/autonomy/`

| Путь | Назначение |
|------|------------|
| `autonomy/config.json` | Флаги автономки: `enabled`, `reserveFraction`, `verify`, ground-truth, burn-line |
| `autonomy/runs.jsonl` | Журнал прогонов (append-only JSONL); также зеркала `bots/<id>/autonomy/runs.jsonl` |
| `autonomy/cron-jobs.json` | Карта actionId → native OC cron jobId / pause-метаданные |
| `autonomy/breakers.json` | Circuit-breaker по задачам (fail/backoff) |
| `autonomy/budget-state.json` | Сверка «наш spend vs OpenRouter credits» за день |
| `autonomy/budget-pause.json` | Пауза по дневному потолку расхода |
| `autonomy/drafts/<YYYY-MM-DD>/` | Артефакты черновиков |
| `autonomy/drafted-ids.json` | Уже использованные source item ids |
| `autonomy/evidence/` | Улики / evidence |
| `autonomy/outbox.json` | Очередь доставки (TG) |
| `autonomy/cc-workspace/` | Workspace фоновых CC-ходов (+ `cc-sessions.json` для `memory: continuous`) |
| `autonomy/oc-workspace/` | Workspace OC-пути |
| `autonomy/cron-cursor.json` | Курсор сверки cron |
| `autonomy/match-stats.json` / `match-alert.json` | Диагностика матчинга заданий |
| `autonomy/unregistered-state.json` / `unregistered-alert.json` | «Задача есть, job у движка нет» |
| `autonomy/watchdog-alert.json` | Delivery watchdog |
| `autonomy/powers-preserved.json` | Сохранённые права при миграциях |

### Рядом с корнем (не только `autonomy/`)

| Путь | Назначение |
|------|------------|
| `actions.json` (`UA`) | Канонический список фоновых задач (actions) |
| `~/.msb/actions.json` | Legacy / глобальный fallback |
| `schedules.json` (`UA`) | **Второй** (legacy) планировщик таймеров |
| `~/.msb/schedules.json` | Legacy global; при старте adopt → per-bot + `.migrated-*.bak` |
| `state.json` | Владелец, TZ, `autonomyRights`, `engine`, spend, briefing flags |
| `errors.jsonl` | В т.ч. `scheduler_stuck` |

Лейблы в промптах: `~/.msb/autonomy/drafts/<YYYY-MM-DD>/`.

---

## 2. Task types

Хранимое поле `task.kind` (и `aDA` / пресеты):

| kind | Смысл | Capability по умолчанию (`VG` / `WG`) | Runner-порт |
|------|--------|--------------------------------------|-------------|
| `reminder` | Текст дословно в срок; опционально `followUp` | `none` | `runReminder` (TG send; без агента) |
| `prompt` | «Сбор» в разговоре с владельцем: инструкция в `prompt` | `read`; `shell:true` → `scan` | `runPromptTurn` → agent |
| `collect` | Нативный опрос источников (`sources[]`) | `read` | `runCollect` (без LLM) |
| `digest` | Дайджест по мониторингу (`window`, `topN`, `topic`) | `write` | `runDigest` |
| `draft` | Черновики на одобрение (`styleRef`, `sources`, `count`) | `write` | `runDraftLoop` → agent |

Триггеры (`trigger.kind`): `once` (`at`), `cron`, `interval` (`intervalMinutes`), `when` (условие / inbox / service), `heartbeat` (в CC-петле не стреляет).

Нормализация при создании (`Q9` / `_r`):

- `runner` default `"auto"` → `cc` или `oc` по `state.engine`
- `output.silentIfEmpty` default `true` (legacy)
- `quiet: true` в маркере → `output.emptyIsValidOutcome: true`
- `maxMinutes` → `budget.maxRunSeconds` (clamp 30…3600 с; default allotment 600 с)
- `memory: "continuous"` только у `prompt`
- `when` только у `prompt`; `then` у when → принудительно `shell: true`
- Capability `act` → `requiresApproval`, задача создаётся `enabled: false` до одобрения

Пресеты в `actions` / меню: `daily-digest`, `morning-briefing`, `draft-loop`, `s1-draft-loop`, `low-balance-alert`, `collect`, плюс twitter-bootstrap набор.

---

## 3. Создание задач: маркеры чата vs меню

### Маркеры (чат / ответ агента)

Агент вставляет маркеры **отдельной строкой**; пост-процессор `WMA` / `KB` подменяет маркер результатом.

Основные:

- `[SCHEDULE_TASK]{json}[/SCHEDULE_TASK]` → `yg` → `_r` → `registerActionLive` (`y7`)
- `[RESCHEDULE_TASK: задача | время]`, `[CANCEL_TASK:…]`, `[PAUSE_TASK]` / `[RESUME_TASK]`
- `[SHOW_TASK]`, `[EDIT_TASK]…[/EDIT_TASK]`, `[APPEND_TASK]`, `[DROP_FROM_TASK]`
- `[LIST_TASKS]`, `[TASK_RUNS]`, `[STOP_ALL]` / `[RESUME_ALL]` / `[CANCEL_ALL]` / `[CANCEL_SPENT]`
- Inbox / event: `[EVENT_PUSH]`, `[INBOX]`, `[INBOX_PAUSE]`, `[INBOX_RESUME]`
- Legacy timers: `[LIST_TIMERS]`, `[TIMER_OFF|ON|DELETE]`
- `[SET_LIMIT daily_cap_usd|daily_cap_runs|daily_cap_tokens|reserve_fraction|max_actions N]`

Id новых задач: `conv-<kind>-<ISO-stamp>`.

Регистрация:

- engine CC → upsert в `actions.json`, сообщение «петля подхватит в течение минуты»
- engine OC → upsert + native `cron add`, запись в `cron-jobs.json`

Явный запрет: **не трогать `schedules.json`** из маркеров — иначе двойной выстрел (legacy scheduler + autonomy).

### Меню (`auto:*` callback)

Только владелец (`state.userId`).

- `auto:home` — экран автономки
- `auto:rights` / `auto:rights-toggle` — `state.autonomyRights`
- `auto:tasks` — список из `loadActions` (вкл. / owner-disabled)
- `auto:task:<id>` — карточка; toggle `enabled` / `disabledReason: "owner"`; delete
- `auto:history` — `readRecentRuns` + summarize
- `auto:what`, `auto:monitor` — справка / монитор

Меню **не** создаёт произвольные SCHEDULE_TASK; создание — через чат-маркеры или пресеты/bootstrap (`ozA`, monitor presets). Меню управляет уже существующими actions и правами.

### Legacy `schedules.json`

Типы: `once` / daily / `weekly` (`hour`, `minute`, `weekdays`, `prompt`).  
Тикает в `iia/scheduler` stage `user_schedules` через `triggerMessage(…, { isAutoTurn: true })` — это **не** autonomy action и **не** `Rz`.

---

## 4. Scheduler tick loops

Три независимые петли.

### A. `iia/scheduler` (бот)

- Старт: delay **30 с**, затем interval **60 с**
- Re-entrancy guard; stuck > **30 мин** → `errors.jsonl` + optional sync report
- Стадии: `load_state` → morning briefing → weekly → monitor poll → balance/deadman → digest → cleanup → pulse → **user_schedules**
- При старте: `adoptLegacyGlobalSchedules()`

### B. `autonomy/loop` (Claude Code / «первый движок»)

- Arm: `je` при wiring, если `config.enabled`; interval **60 с**
- Tick `nwA`:
  1. due `when`-условия (`nZ` / `sZ` / `oZ`) → `Rz`
  2. due по `lwA`: `once` / `interval` / `cron` (не `when`/`heartbeat`) → `Rz`
- Пропуск: kill-switch, breaker, `migratedToOc`, runner=oc, global stop
- Frequency brake + stop-notice для CC

### C. `autonomy/cron-bridge` (OpenClaw)

- Arm: `De`, interval **30 с** + gateway bus listeners
- Tick: reconcile `tasks.list` ↔ `cron-jobs.json`, outbox flush, delivery watchdog, match diagnostic, unregistered guard, **pre-turn brakes**, daily-cap, once-at cleanup, condition checks → `cron run`
- Запуск работы — native cron движка; Node догоняет результат и пишет `runs.jsonl`

### Диспетчер одного действия: `Rz`

Порядок ворот (`ELA`):

1. kill-switch / asleep (CC выключен под OC)
2. breaker open → skip
3. prefilter (`td`: для prompt/draft с sources — нет новых items → не будить агента)
4. budgetCap (`VM` — дневной $ по runs.jsonl бокса)
5. dayCap (`GM` — runs/tokens env caps)
6. subscription quota (`WM`, не для OC)
7. spend (`mD` — dailySpendLimit + reserveFraction + per-action maxUsd)
8. иначе `dispatch` → `Ai` (по kind на порты)

Итог всегда в `runs.jsonl` (`appendRun`); статусы: `ok` / `skipped` / `blocked` / `stopped` / `error` / `deferred`.

---

## 5. Rights / budget / silence (как в коде)

### Rights / posture

Capability → authority profile:

- `none`/`read` → narrow / standard  
- `scan` (shell) → inspect  
- `write`/`act` → trusted  

Posture для CC (`j8` / `B9` / `zJ`):

| posture | Tools |
|---------|--------|
| `green-only` | read-класс (`lD`) |
| `green-yellow` | + Write/Edit/NotebookEdit |
| `green-exec` | + Bash/Monitor/Skill (bash allowlist) |
| `all` | + Agent/Task |

`state.autonomyRights === true` (меню): включает background rights path в `Jn` / `xn` — Bash+allow + guard settings, иначе фоновый Bash не поднимается (`cR` требует Bash в override и bashAllow).

UNIVERSAL_NEVER: «не публиковать ничего автоматически».

### Budget / limits

Из `autonomy/config.json` + env:

| Ключ / env | Роль |
|------------|------|
| `reserveFraction` / `AUTONOMY_RESERVE_FRACTION` | Доля окна подписки, оставленная диалогу (default 0.3) |
| `AUTONOMY_DAILY_CAP_USD` | Дневной $ автономки (`VM`) |
| `AUTONOMY_DAILY_CAP_RUNS` / `_TOKENS` | Дневные ходы/токены (`GM`); оба 0 → ворота отключены |
| `AUTONOMY_MAX_ACTIONS` | Потолок числа активных задач |
| `state.dailySpendLimit` / `costPaused` | Spend gate `mD` |
| `budget.maxUsdPerRun` / `maxUsdPerDay` | На action |
| `budget.maxRunSeconds` / `maxMinutes` | Таймаут хода (30…3600) |
| `budget.killSwitch` | Пер-задачный стоп |
| Global STOP_ALL | Fence jobs (OC) / skip loop (CC) |

Оценка до запуска (`ig`): collect 0, digest 0.05, prompt 0.1, draft 0.2 USD.

Ground-truth каждые `groundTruthEveryNRuns` против OpenRouter credits → `budget-state.json`.

### Silence

Два механизма:

1. **Legacy** `output.silentIfEmpty` (default true) — пустую доставку не слать.
2. **Quiet / emptyIsValidOutcome** (`quiet: true` в SCHEDULE_TASK):
   - В промпт добавляется инструкция ответить **ровно** `[NOTHING_TO_REPORT]`
   - Парсер `_D`: маркер тишины → не доставлять текст владельцу; прогон = штатный skip/ok без накопления fail
   - Если freshness paths «мертвы» — тишина отменяется, владельцу сообщают
   - Не для отчётов/черновиков, где пустота = ошибка работы

Breaker: серия fail → backoff (`breakers.json`); quiet-успех не должен крутить fail-счётчик как ошибку.

---

## 6. Background turn → agent-cc

Цепочка на CC:

```
autonomy/loop (nwA)
  → Rz(action)
    → Ai → runPromptTurn / runDraftLoop / runAgentTurn
      → ports from makeAutonomyPortsCc / JO(runCc=IJ)
        → JO строит prompt+posture+timeout+helpers
          → IJ (iia/agent-cc): spawn `claude -p --output-format stream-json …`
```

`JO` (`autonomy/wiring-cc`):

1. `mkdir` `autonomy/cc-workspace`
2. Tools: `zJ(posture)` / deny `KR` / bashAllow `GR` + task `bashAllow`
3. Опционально `--resume` из `cc-sessions.json` по `memoryKey=action.id`
4. Вызов `IJ` = agent-cc с isolated session, model/provider задачи
5. Таймаут: AbortSignal + текст «не уложилась в N мин»
6. Возврат: text, tokens, meteredUsd, permissionDenials, truncated/failed

`IJ` / `xn`:

- stdin = user prompt; system prompt file/argv
- `--allowedTools` / `--disallowedTools`; при autonomyRights+Bash — guard `--settings`
- `--max-budget-usd` на metered auth
- cwd = bot workspace; env CI=1, OAUTH, timeouts Bash
- Лог: `rights=on|off(autonomy)`

Reminder **не** идёт в agent-cc: прямой `sendMessage`.  
Collect/digest — свои порты без CC, если подключены.

OC-путь зеркален по смыслу (`runAgentTurn` → agent-oc / native cron), но spawn другой; `cron-jobs.json` только для OC.

---

## Инварианты

1. Один канонический список живых задач: `actions.json`. `schedules.json` — legacy, не плодить из autonomy-маркеров.
2. CC: Node-петля 60 с сама вызывает `Rz`. OC: native cron + bridge 30 с.
3. Маркер в ответе агента = команда бота; цитата маркера в чужом тексте должна быть нейтрализована (`CD` / инструкции).
4. Идущий ход не отменяется STOP_ALL — только будущие срабатывания / fence.
5. Деньги и квота считаются до `dispatch`; пустой quiet-прогон дешевле полного отчёта и не будит зря при prefilter «нет новых источников».
