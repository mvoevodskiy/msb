# Контракт: agent-cc (Claude Code runner)

Источник: `.msb/bot/vendor/deobfuscated.js`  
Ключевые точки: `IJ` (spawn + stream), `xn` (argv), `bi` (parse), `LTA`/`s0A` (persistence + return).

---

## 1. CLI argv

Команда: `claude` (через `spawn`). Prompt **не** в argv — пишется в **stdin** после spawn (`v.stdin.end(z)`).

Сборка argv — `xn` (строки 20827–20892).

### Базовый префикс (порядок фиксирован)

```text
-p
--output-format stream-json
--verbose
--max-turns <N>
--permission-mode <mode>
```

Далее (условно):

| Флаг | Когда | Значение |
|------|--------|----------|
| `--tools` …tools | CLI поддерживает `--tools` **и** задан `ourToolsOverride` | каждый tool отдельным argv-элементом |
| `--allowedTools` | иначе | CSV tools (+ MCP `mcp__*` + опционально MCP из kn) |
| `--allowedTools` (второе) | режим `--tools` | WebSearch/WebFetch + MCP CSV + `ourBashAllow` |
| `--add-dir` | режим `--tools` | `homedir()`, `/tmp` |
| `--disallowedTools` | всегда | затем либо `[]` (tools-mode), либо `ourToolsDenied`; плюс `cD` (suicide/rights) или `zR` (bash deny list); плюс `Dn()` (Read/Write/Edit на `.msb/.env`, state, sessions, ssh, …) |
| `--settings` | rightsOn + background/autonomy + guardSettings | путь к guard settings |
| `--agents` | subagents enabled | `JSON.stringify(roster)` |
| `--append-system-prompt` / `--append-system-prompt-file` | system prompt | argv string или temp file |
| `--system-prompt-snapshot off` | CLI ≥ `wn` (`2.1.267`) и есть system prompt | |
| `--model` | model задана (без суффикса `[1m]`) | |
| `--fallback-model` | model проходит `h4()` | `sonnet` или `sonnet,haiku` (CLI ≥ `Ln` `2.1.166`) |
| `--effort` | `nU(model, effort, cli)` вернул значение | |
| `--max-budget-usd` | metered auth + CLI ≥ `gn` (`2.1.181`) | `"25"` (`Fz`) |
| `--resume` | sessionId truthy | **последний** флаг |

Фрагмент сборки:

```20840:20891:.msb/bot/vendor/deobfuscated.js
  let O = ["-p", "--output-format", "stream-json", "--verbose", "--max-turns", G ? Yz : I ? ai : oi, "--permission-mode", g, ...(w ? ["--tools", ...U] : ["--allowedTools", M]), ...(() => {
    // ...
  })(), ...(w ? ["--add-dir", N7.homedir(), "/tmp"] : []), "--disallowedTools", ...(w ? [] : Z ?? []), ...(z ? cD : zR), ...Dn(), ...(z ? ["--settings", W.guardSettings] : [])];
  // ... --agents / --append-system-prompt* / --model / --fallback-model / --effort / --max-budget-usd ...
  if (Q) {
    O.push("--resume", Q);
  }
  return O;
```

### `--max-turns`

| Условие | Константа | Значение |
|---------|-----------|----------|
| «широкий» ход (`Cz`: нет tools override/denied) | `Yz` | `"200"` |
| subagents path (`I`) | `ai` | `"50"` |
| иначе (narrow) | `oi` | `"25"` |

### `--permission-mode` (`ni`)

| UI `permissionMode` | CLI mode |
|---------------------|----------|
| `smart` | `auto` |
| `plan` / `control` / `auto` / default | `acceptEdits` |

Если режим ∈ `{auto, dontAsk, plan}` (`On`) и CLI **&lt;** `Pn` (`2.1.154`) → принудительно `acceptEdits`.

### Default `--allowedTools` CSV

- С subagents: `Bash,WebSearch,WebFetch,Agent,Task,Workflow,Monitor,Skill,Read,Write,Edit,Glob,Grep` (+ MCP)
- Без: `Bash,WebSearch,WebFetch,Read,Write,Edit,Glob,Grep` (+ MCP)

System prompt &gt; `yn` (120000 bytes) → temp file `--append-system-prompt-file`, иначе `--append-system-prompt`.

---

## 2. Env child process

Spawn (`IJ`, ~19518–19535):

```javascript
env: {
  ...HB(),                                    // process.env минус scrub
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, // явно после scrub
  CI: "1",
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(h1(model).contextWindow),
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: E ? "1" : "90",  // E = compact-only path
  BASH_DEFAULT_TIMEOUT_MS: String(Vn),              // 900000
  BASH_MAX_TIMEOUT_MS: String(g ? Wn : Gn),         // bg: 3600000 / else 1500000
  ...(g ? { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(Bn) } : {}) // 600000
}
```

`HB()` удаляет из env:

- `JARVIS_CC_ONLY`, `BOT_TOKEN`, `ANTHROPIC_API_KEY`, `MSB_ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `SYNC_KEY`, `SYNC_URL`
- все `GIT_*` кроме `GITHUB_TOKEN`
- все `NPM_CONFIG_*`

Затем OAuth-токен **возвращается** явно.

Прочие spawn-опции: `cwd = workspace (_A())`, `stdio: ["pipe","pipe","pipe"]`, `detached: true`, `timeout`: background `si` 14400000 ms / иначе `ti` 1800000 ms.

---

## 3. stream-json: типы и поля

Парсер строк stdout: `bi` — `JSON.parse`, обязателен `type: string`.

### `system`

| subtype / helper | Поля | Поведение |
|------------------|------|-----------|
| `init` (`wi`) | `session_id`, `apiKeySource`, `model`, `tools[]`, `plugin_errors[]`, `mcp_servers[]` | обновляет sessionId; `Zn(apiKeySource)`; model → return.model; tools → `engineOfferedTools`; callbacks plugin/mcp |
| `api_retry` (`Pi`) | `error`, `error_status`, `attempt`, `max_retries`, `retry_delay_ms` | callback; на финальном `rate_limit` → RateLimitError path / `overloaded` → overload reject; SIGTERM process group |
| `compact_boundary` (`Oi`) | — | callback; UI-текст о сжатии (если не compact-only) |
| `task_started` / `task_progress` / `task_notification` (`_i`) | `task_id`, `subagent_type`, `description`, `usage`, `status`, `summary` | subagent events / helper token counts |
| иное | `subtype` | лог `system/<subtype> (ignored)` (+ AfterResultWaitTracker) |

### `assistant`

- `message.usage`: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`
- `message.stop_reason === "refusal"` → `onRefusal`
- `message.content[]`:
  - `text` → накопление ответа; guards: token repetition / tool-call-as-text → SIGTERM; parser_bug patterns
  - `thinking` → счётчик thought chunks
  - `tool_use` → `name`, `id`, `input`; `parent_tool_use_id` на событии; `onToolCall` / `pushToolStart`

### `tool`

- `pushToolEnd("")`, `onThinking()`; `lastActivity = "tool"`

### `result`

Поля: `result` (текст), `session_id`, `subtype`, `is_error`, `api_error_status`, `total_cost_usd`, `modelUsage`, `permission_denials[]` (`tool_name`/`name`), `terminal_reason`, `stop_reason`, `usage` (те же token fields).

Особая обработка:

- `subtype === error_max_budget_usd` → UI pause message, без auto-continue
- `is_error` + rate-limit text (`hi`) → fatal RateLimitError
- after-result wait / cut (background vs cut timers `fR`/`mR`)

### `rate_limit_event`

- `rate_limit_info.resetsAt` (number) → `onRateLimitEvent`

### `user` (через default branch)

- `tool_result` в `message.content`: ok/failed counts (`Ti`); first error types → `onToolError`

Неизвестные `type` → лог.

---

## 4. Persistence `ccSessionId`

Цепочка:

1. `LTA` вызывает `IJ(..., B.ccSessionId || null, ...)` → argv `--resume` если есть.
2. Stream: init/`result.session_id` → локальная `r`.
3. Успех: если `V.sessionId && V.sessionId !== B.ccSessionId` → `B.ccSessionId = V.sessionId` + `e(B)` (saveState).
4. Сброс `ccSessionId = undefined` + save:
   - `ContextOverflowError` (`t4`)
   - resume failure (`qTA`: «no conversation found» / «cannot resume» / session not found|incompatible) → retry `IJ` с `null`, затем сохранить новый id
5. Compact helper `oR` читает `A.ccSessionId`, возвращает usage с новым sessionId при необходимости.

---

## 5. Abort / max-turns / permission-mode

### Abort (`AbortSignal` arg `C`)

При `abort`:

1. `SIGINT` на child  
2. через `ei` (3000 ms): `SIGTERM` process group (`-pid`), fallback `v.kill("SIGTERM")`  
3. ещё через 5000 ms: `SIGKILL` group / child  

`abortedByUser: true` в return; текст без ceiling-message.

Bot shutdown (`Jz` via `pR`): ненулевой exit → `stoppedByShutdown`, не ceiling.

### Ceiling / timeout

- Spawn `timeout`: 4h (bg) / 30m  
- Exit code `Dq` (143) или `null`+`SIGTERM` (без user abort) → ceiling message  
- `exitCode === null` (не ceiling) → timeout incomplete warning  
- After-result cut (`mR` 15s): force SIGTERM, `afterResultCut: true`, exit нормализуется в success path

### max-turns / interrupted

`result.subtype` ∈ `{error_max_turns, error_during_execution}` → лог + `interrupted` через `Hn` (для auto-continue).  
Также `interrupted` если: ненулевой код / «успех» без текста при tool activity / lastActivity tool + toolCalls&gt;1 (кроме `error_max_budget_usd`).

### permission-mode

См. §1; UI mode хранится в state (`B.permissionMode`), в CLI мапится `ni`.

---

## 6. Return shape хода

### Сырой resolve `IJ` (успех)

```ts
{
  text: string;                 // trim; fallback "✓" на штатном успехе
  sessionId: string;            // из init/result или resume input
  elapsedMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;              // на happy path часто 0; meteredCostUsd отдельно
  toolCalls: number;
  toolsUsed: string[];          // уникальные имена по порядку
  model: string;                // "claude-code-subscription" | "...:modelId"
  interrupted: boolean;         // Hn / abort-path variants
  resultSubtype?: string;
  toolsFailed: number;
  exitCode: number | null;
  exitSignal: string | null;
  abortedByUser: boolean;
  // optional:
  resultCount?: number;         // если >1 result events
  stoppedByShutdown?: boolean;
  afterResultCut?: boolean;
  meteredCostUsd?: number;
  modelUsage?: object;
  primaryModel?: string;
  permissionDenials?: number;
  permissionDenialTools?: string[];
  engineOfferedTools?: string[];
  runUsage?: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
  helperTokens?: number;
  helperRuns?: number;
  terminalReason?: string;
}
```

Abort / ceiling / degenerate paths возвращают тот же каркас с `costUsd: 0`, часто без metered/permission extras.

### Ошибки (reject)

| Условие | Ошибка |
|---------|--------|
| ENOENT claude | RU message про CLI |
| fatal rate limit (`jJ`) | «Лимит подписки…» |
| HTTP via `api_error_status` | auth / billing / overloaded / rejected / rate_limit |
| overload pre-emptive | Anthropic overloaded |
| context overflow stderr | `t4` ContextOverflowError |
| stderr rate/auth patterns | RateLimit / auth |
| short answer phrases (`pi`) | auth / overflow / overload / server |
| exit ≠ 0, empty text | `Claude Code: <stderr/stdout>` |

### Engine wrapper `s0A`

```ts
{
  text, elapsedMs, costUsd, toolCalls, toolsUsed,
  cacheReadTokens, cacheCreationTokens,
  totalInputTokens, totalOutputTokens,
  model,
  hitIterationLimit: interrupted,  // rename
  sessionId,
  outcome: Rm({ elapsedMs, toolCalls, toolsFailed, permissionDenials,
                interrupted, terminalReason, resultSubtype,
                exitCode, exitSignal, abortedByUser })
}
```

---

## Точки входа (справка)

| Symbol | Role | Lines (approx) |
|--------|------|----------------|
| `IJ` | spawn + stream loop | 19475–20338 |
| `xn` | argv builder | 20827–20892 |
| `bi` | stream-json line parse | 20894–20905 |
| `ni` | permission-mode map | 20377–20397 |
| `HB` | env scrub | 41813–41828 |
| `LTA` | ccSessionId I/O | 55990–56054 |
| `s0A` | turn → engine shape | 56450–56476 |
| `wi`/`Pi`/`Oi`/`_i`/`yi` | event predicates | 18612–18690 |
