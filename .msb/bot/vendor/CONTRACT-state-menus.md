# CONTRACT: state.json + Telegram menus/callbacks

Источник: `.msb/bot/vendor/deobfuscated.js` (бандл MSB-бота).  
Путь state: `dirname(MSB_SESSION_DIR)/state.json` → обычно `~/.msb/state.json` (`eJ`).

API модуля state (экспорт ~55386):

| Символ | Роль |
|--------|------|
| `m` / `loadState` | async read + migrate |
| `e` / `saveState` | atomic write (`*.tmp` → rename, mode `0600`) |
| `Ry` / `peekStateSync` | sync read без миграций |
| `RB` / `mutateState` | file-lock mutate |
| `Q1` / `updateChatId` | upsert owner `chatId`/`userId`/`ownerUsername` |
| `tE` / `trackSession` | append/update `sessionHistory` (cap 100) |
| `SP` / `resetOcSession` | clear OC session, stack id в `ocPrevSessionIds` (cap 3) |
| `x0A` / `fenceAdapterSwitch` | при save: disk wins для `engine` / `oc*` / `adapterArchive` / `adapterGen` |

---

## 1. Schema `state.json`

Поля собраны по чтениям/записям `m()`/`e()` и прямым присваиваниям. Типы — по использованию.

### 1.1 Auth / engine

| Field | Type | Notes |
|-------|------|-------|
| `authMode` | `"subscription" \| "api-key" \| undefined` | Setup Mode = нет `authMode` (и нет env-ключей) |
| `hasSubscriptionAuth` | `boolean` | ставится при OAuth/setup-token |
| `hasApiKey` | `boolean` | после миграции `clientApiKey` → `.env` |
| `clientApiKey` | `string` | **legacy**; при load мигрируется в `ANTHROPIC_API_KEY`, удаляется |
| `clientApiKeyMasked` | `string` | UI |
| `engine` | `"cc" \| "oc" \| undefined` | `undefined` ≈ Claude Code |
| `adapterHidden` | `boolean` | скрытие adapter/OC в UI |
| `adapterGen` | `number` | поколение switch; fence на save |
| `adapterArchive` | `object` | архив при миграции CC↔OC |

### 1.2 Claude Code (cc*)

| Field | Type | Notes |
|-------|------|-------|
| `ccSessionId` | `string \| undefined` | текущая CC-сессия |
| `ccModel` | `string` | напр. `opus` / `sonnet` (+ версии) |
| `ccEffort` | `string` | default при create: `"xhigh"`; effort levels: off/low/medium/high/xhigh/max |
| `permissionMode` | `"auto" \| "smart" \| "control" \| "plan"` | default `"auto"`; смена сбрасывает `ccSessionId` |

### 1.3 OpenClaw (oc*)

| Field | Type | Notes |
|-------|------|-------|
| `ocSessionId` | `string \| undefined` | |
| `ocSessionName` | `string \| undefined` | |
| `ocPrevSessionIds` | `string[]` | cap `My=3` |
| `ocModel` | `string` | OpenRouter/provider model id |
| `ocEffort` | `string \| undefined` | `"off"` → `undefined` |
| `ocContextTokens` | `number \| undefined` | |
| `ocContextSessionId` | `string \| undefined` | |
| `ocLiveModels` | `array` | модели после login/key |
| `ocResumeBlocked` | `any` | блок resume |
| `ocPendingJournalRestore` | any | journal restore |
| `nativeOc` | `object` | native OC bot meta (`username`, …) |
| `ocUsername` | used via `nativeOc` / probes | UI «бот OpenClaw» |

Признак «на боксе есть OC-след» (`vB`): `engine==="oc"` **или** непустые `ocModel`/`ocSessionId`/`ocSessionName` **или** непустые `ocPrevSessionIds`/`ocLiveModels`.

### 1.4 Owner / session UX

| Field | Type | Notes |
|-------|------|-------|
| `chatId` | `number` | Telegram chat владельца |
| `userId` | `number` | Telegram user id |
| `ownerUsername` | `string \| null` | |
| `timezone` | `string` | default `MSB_TIMEZONE \|\| "Europe/Moscow"` |
| `activeProject` | `string \| undefined` | имя проекта |
| `sessionHistory` | `SessionEntry[]` | см. ниже; cap 100 |
| `pendingPrompt` | `{ text, messageId } \| undefined` | отложенный промпт после model switch |
| `verboseLevel` | `1 \| 2` | детализация статусов |
| `sttProvider` | `"deepgram" \| …` | STT |

`SessionEntry`: `{ id, startedAt, lastActivity, messageCount, firstPrompt, lastPrompt?, project?, engine?, name?, cwd? }`.

### 1.5 Cost / briefing / polls

| Field | Type | Notes |
|-------|------|-------|
| `dailySpendLimit` | `number` | default create `10`, fallback UI `50`; `0` = ∞ |
| `costHistory` | `Record<YYYY-MM-DD, number>` | |
| `costPaused` | `boolean` | |
| `lastCostAlert` | `string` | |
| `briefingHour` | `number` | default `MSB_BRIEFING_HOUR \|\| 8` |
| `briefingEnabled` | `boolean` | |
| `weeklyEnabled` | `boolean` | |
| `autoMessagesOptIn` | `boolean` | default `true` |
| `lastBriefingSent` | `string` | |
| `lastWeeklySent` | `string` | |
| `lastPollAt` | `Record<source, ISO>` | youtube/twitter/github/telegram/rss |
| `lastYtPoll` / `lastTwPoll` / `lastGhPoll` / `lastTgPoll` / `lastRssPoll` | ISO | **legacy** → мигрируют в `lastPollAt` |

### 1.6 Runtime / errors / drafts

| Field | Type | Notes |
|-------|------|-------|
| `rateLimitInfo` | object | resetsAt, utilization, overage, … |
| `rateLimitShownInSession` | `{ sessionId, … }` | anti-spam RL UI |
| `engineError` / `engineErrorReason` | string | |
| `engineOp` / `engineDraft` | object | wizard «Движки» |
| `muted` | boolean | (отдельные notify-записи; см. notify subsystem) |

### 1.7 Default object при первом `updateChatId` (нет файла)

```js
{
  chatId, userId,
  timezone: MSB_TIMEZONE || "Europe/Moscow",
  briefingHour: parseInt(MSB_BRIEFING_HOUR || "8", 10),
  briefingEnabled: false,
  weeklyEnabled: false,
  autoMessagesOptIn: true,
  lastBriefingSent: "",
  lastWeeklySent: "",
  dailySpendLimit: 10,
  costHistory: {},
  costPaused: false,
  lastCostAlert: "",
  ccEffort: "xhigh"
}
```

---

## 2. ADMIN_ID / auth gate

```js
k$ = Number(process.env.ADMIN_ID || "0");
```

Middleware (~109779):

- если `ADMIN_ID > 0` и `from.id !== ADMIN_ID` → **update отбрасывается** (тишина);
- иначе пропускается дальше.

Дополнительно:

- `lF(env)` → `{ adminId, myBotId }` для constructor/engines API;
- owner-only для `auto:*` callbacks: `state.userId === from.id`, иначе alert «Только владелец бота»;
- env-allowlist включает `ADMIN_ID`, `OWNER_USER_ID`, `CLIENT_ID` (не путать с Telegram gate).

`JARVIS_CC_ONLY=1` (`OA`): блокирует OC-пути; callback’и из `JY` (apr/setup:open/openrouter/engine:set:oc) отвечают текстом «только Claude Code».

---

## 3. Setup Mode

Определение `e1()` (~103510) — **true**, если одновременно:

1. нет `state.authMode`,
2. `state.engine !== "oc"`,
3. нет `MSB_ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY`,
4. нет `CLAUDE_CODE_OAUTH_TOKEN`.

При старте без API key в env: лог `[iia/bot] No API key in env — will use Setup Mode`.

### Поведение

| Канал | Поведение |
|--------|-----------|
| `/start` | → wizard `ny()` (welcome / waiting_subscription / …) |
| обычный текст → agent turn | drain видит `isSetupMode`; текст уходит в `ny()`, статус-сообщение удаляется; агент **не** вызывается |
| voice / photo / video / document | reply `"Сначала подключи AI: /start"` (+ voice бросает `b$("setup-mode")`) |
| OC уже на сервере, CC нет | UI `Ru()` / `Su()`: «AI ещё не подключён…» + кнопки Claude / OpenClaw |
| после setup-token | `authMode="subscription"`, `hasSubscriptionAuth=true` → Setup Mode выключается |

Wizard callback prefix: `setup:*` → `y1A()`.

---

## 4. Slash commands → feature areas

Зарегистрированы в `sBA` / `setMyCommands` (+ отдельные `R.command`):

| Area | Commands |
|------|----------|
| **Core / sessions** | `/start`, `/newtask`, `/stop`, `/clear`, `/compact`, `/undo`, `/sessions`, `/help` |
| **Projects / skills** | `/projects`, `/project`, `/skills`, `/modules`, `/catalog` |
| **Settings / engines** | `/settings`, `/engine`, `/claude`, `/openclaw`, `/status`, `/info`, `/cost` |
| **Autonomy** | `/autostatus`, `/autoactions`, `/autodraft` |
| **Monitor** | `/monitor`, `/digest`, `/sources` |
| **SSH / access** | `/connect`, `/recovery` |
| **Misc** | `/feedback`, `/nocheck`, `/cards`, `/debugux` |

При `OA()` или CC-only UI: команда `openclaw` убирается из `setMyCommands`.

---

## 5. Callback routing (top-level prefixes)

Главный router: `R.on("callback_query:data")` (~120880+) + dedicated `R.callbackQuery(/^auto:.+$/)`.

| Prefix | Area | Handler / notes |
|--------|------|-----------------|
| `menu:` | hub | `back`, `agent`, `settings`, `autonomy`, `mcp`, `skills`, `sessions`, `projects`, `newtask`, `newproject`, … |
| `settings:` | settings | → `I2()` (почти всё); env/restart частично inline |
| `eng:` | engines | → `vBA()` (install/switch/migrate OC↔CC) |
| `setup:` | onboarding | → `y1A()` |
| `auto:` | autonomy | tasks/timers/rights/history/monitor shortcut |
| `mon:` | monitor | sources/digest/settings/scored/… |
| `mcp:` | MCP | add/setup/delete/folder/mute |
| `skills:` | skills | folder/view/enable/disable/delete/content |
| `plan:` | permissions UX | approve/always/skip/reject/comment |
| `sessions:` | sessions | e.g. `sessions:restoreprev` |
| `connect:` | VS Code tunnel | `connect:disconnect` |
| `whisper:` | STT skip | `whisper:skip` |
| `ratelimit:` | RL UI | `ratelimit:overage` |
| `leak:` | key leak guard | add/dismiss |
| `apr:` | (CC-only block list) | treated as OC-path attempt under `JY` |
| `tmr-del:` / `ct:` / `rs:` | timers/cards/reminders | feature-local |

### 5.1 `menu:*`

| data | Feature |
|------|---------|
| `menu:back` | главное меню `Ph` |
| `menu:agent` | модель / effort / perm / conn |
| `menu:settings` | экран настроек |
| `menu:autonomy` | автономка home |
| `menu:mcp` | MCP list |
| `menu:skills` | skills home |
| `menu:sessions` / `menu:newtask` | сессии |
| `menu:projects` / `menu:newproject` | проекты |

### 5.2 `settings:*` (I2)

| Subtree | Feature |
|---------|---------|
| `settings:auth*`, `settings:conn*`, `settings:engine*` | подключение CC/OC/OpenRouter |
| `settings:model*`, `settings:effort*`, `settings:permmode*` | модель / глубина / права агента |
| `settings:bots*` | multi-bot |
| `settings:ssh*` | SSH keys + firewall IPs (constructor API) |
| `settings:env*` | env vars / quick keys (Deepgram, GitHub, …) |
| `settings:timers*` / `settings:timer*` | legacy timers UI |
| `settings:tz*` | timezone |
| `settings:limit*` / `settings:cost:resume` | daily spend |
| `settings:verbose*` / `settings:stt*` / `settings:extras` | UX extras |
| `settings:monitor-storage*` | sqlite/supabase |
| `settings:restart*` / `settings:server-status` | ops |
| `settings:back` / `settings:close` | navigation |

### 5.3 `auto:*` (autonomy)

| data | Feature |
|------|---------|
| `auto:home` / `auto:what` | intro |
| `auto:tasks` / `auto:task:` / `auto:task-toggle:` / `auto:task-delete:` | задачигены |
| `auto:timers` / `auto:timer*` | таймеры автономки |
| `auto:history` | история прогонов |
| `auto:rights` / `auto:rights-toggle` | sudo-права фоновых задач |
| `auto:monitor` | jump → monitor UI |

### 5.4 `mon:*` (monitor)

`mon:sources`, `mon:digest` (+ time/count/target), `mon:settings`, `mon:help`, `mon:scored`, `mon:storage*`, `mon:model*`, `mon:notif`, `mon:search*`, `mon:feed`, `mon:collection`, `mon:balance*`, `mon:reportstyle*`, `mon:poll:all`, …

### 5.5 `eng:*` / `setup:*`

**eng:** home/add/check/go/model (`eng:m*`), OC on/off/upd, switch CC↔OC (`eng:sw*`), migrate (`eng:mig*`), mem/rm/undo/wake.  
**setup:** `subscription`, `oc`, `pick`, `openrouter`, `openai-sub*`, `openai-start/check/cancel`, `help`, `back`.

### 5.6 `mcp:*`

`mcp:add`, `mcp:setup:supadata|apify`, `mcp:server:`, `mcp:delete:`, `mcp:folder:workspace`, `mcp:mute:`.

---

## 6. Hub keyboard (reference)

Главное меню (~111781):

```
🆕 Новая сессия → menu:newtask
📁 Проекты     → menu:projects
💬 Сессии      → menu:sessions
🧩 Навыки      → menu:skills
🧠 Агент       → menu:agent
🔌 MCP         → menu:mcp
⚙️ Настройки   → menu:settings
🥷 Автономка   → menu:autonomy
```

Автономка home:

```
📋 Задачи → auto:tasks | 📡 Мониторинг → auto:monitor
🕓 История → auto:history | ⏳ Таймеры → auto:timers
❔ Что это → auto:what | 🔓/🔒 Права → auto:rights
```

---

## 7. Line-range map (бандл)

| Lines (approx) | Topic |
|----------------|-------|
| 70–116 | `OA` / `JY` / `vB` / `QQ` (CC-only + OC presence) |
| 3480–3487 | Setup «AI ещё не подключён» (`Ru`) |
| ~10000–10200 | drift/manifest (не polling) |
| 51815–51979 | `hE` / `sBA` slash command list |
| 52500–53850 | `I2` settings callback handlers |
| 55386–55644 | **state module** path/load/save/defaults/sessionHistory |
| 55904–56050 | engine auth + ccSessionId write path |
| 103510–103760 | Setup Mode `e1` + `setup:*` |
| 109600–109900 | bot bootstrap, ADMIN_ID gate, sleep/CC-only middleware |
| 110280–110570 | turn drain + Setup Mode divert to `ny` |
| 111700–114400 | menu builders + slash commands (incl. autonomy cmds) |
| 114760–116000+ | monitor `ZC` + `auto:*` callback router |
| 120880–121900 | top-level callback_query router (eng/setup/plan/mcp/skills/settings/menu) |

---

## 8. Invariants (для порта / совместимости)

1. Path state всегда рядом с sessions: `join(dirname(MSB_SESSION_DIR), "state.json")`.
2. Save атомарный; concurrent engine-switch: поля `engine`/`oc*`/`adapterGen` с диска побеждают.
3. Setup Mode — отсутствие auth, не отдельный флаг в JSON.
4. Telegram ACL: только `ADMIN_ID` (если задан); autonomy UI дополнительно сверяет `state.userId`.
5. CC vs OC session id: `engine==="oc" ? ocSessionId : ccSessionId` (и модели аналогично).
6. `permissionMode` / model change часто **сбрасывают** `ccSessionId`.
7. Секреты не хранить в state: `clientApiKey` мигрирует в `.env`.
`)
