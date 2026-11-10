# UI screens — Telegram (closed core)

Источник: `.msb/bot/vendor/deobfuscated.js`  
Цель: 1:1 тексты и клавиатуры для open-core порта.

Общее:

- Завершающий blank в многих экранах — символ `⠀` (U+2800), константа `K8 = "\n⠀"` (~3725).
- Inline-клавиатура: `JA` / `jA` / `P9` / `l1` (grammy InlineKeyboard).
- Динамические списки (модели pinned, env keys, сессии, задачи) — шаблон + empty-state; не перечислять весь runtime-каталог.

---

## hub (`Ph`)

**Lines:** 111780–111797  
**Entry:** `/start` (не setup), `menu:back`

### Message

```
Готов. Пиши задачу или выбери действие.
⠀
```

### Keyboard

| label | callback_data |
|-------|---------------|
| 🆕 Новая сессия | `menu:newtask` |
| 📁 Проекты | `menu:projects` |
| 💬 Сессии | `menu:sessions` |
| 🧩 Навыки | `menu:skills` |
| 🧠 Агент | `menu:agent` |
| 🔌 MCP | `menu:mcp` |
| ⚙️ Настройки | `menu:settings` |
| 🥷 Автономка | `menu:autonomy` |

Rows: 2+2+2+2.

---

## settings home (`Ky` + `Hy` / `iF`)

**Lines:** `Hy` 52197–52254 · `Ky` 52266–52293 · `iF` 52126–52186

### Message (`Hy`) — шаблон

```
<b>⚙️ Настройки</b>

🔌 Подключение: {Подписка Claude | API ключ (masked|env) | не настроен}
🕐 Часовой пояс: {City} ({HH:MM})
🥷 Автономка: {N задача(и/ч)}, {M таймер(а/ов)}
💾 Диск: {used}/{total} ({pct})   ← optional, df -h /
💰 Траты через API: сегодня ${X.XX}
⚠️ <b>Лимит исчерпан — расходы на паузе</b>   ← if costPaused
```

При `QQ(state)` (CC-only / hidden adapter) первая строка другая:

```
👾 Claude Code: {подписка Anthropic | API-ключ-строка | ждёт подписку Anthropic}
```

Empty-state без state (~52138):

```
<b>⚙️ Настройки</b>

Остальные настройки откроются после первого сообщения боту.
```

| label | callback_data |
|-------|---------------|
| ⚙️ Движки | `eng:home` | ← only if `_K` |
| « Назад | `menu:back` |

### Keyboard (`Ky`) — обычный режим

| label | callback_data |
|-------|---------------|
| 🔌 Подключения | `settings:auth` |
| ⚙️ Движки | `eng:home` | ← if engines available |
| Перейти на 🦞 | `eng:mig` | ← if migrate offered |
| 🔑 Переменные окружения | `settings:env` |
| 👾 Мои боты | `settings:bots` |
| 🕐 Часовой пояс | `settings:tz` |
| 🔕 Отключённые уведомления | `nm:list` |
| 💰 Лимит API: ${N}/день **or** 💰 Лимит API: без ограничений | `settings:limit` |
| 🖥️ Состояние сервера | `settings:server-status` |
| 🔧 Системные | `settings:extras` |
| « Назад | `menu:back` |

CC-only ветка (`QQ`): порядок `env` → `auth` → optional `eng:home` → `🤖 Мои боты` (`settings:bots`) → дальше как выше.

---

## settings extras (`mE`)

**Lines:** 54970–54984 · callback `settings:extras`

### Message

```
<b>🔧 Системные</b>

🌐 <b>SSH доступ к серверу</b> — ключи, файрвол, прямое подключение.
♻️ <b>Перезапустить бота</b> — нужен после обновления кода.
🎤 <b>Расшифровка голоса</b> — Deepgram (облако, $200 в подарок).
💾 <b>Хранилище мониторинга</b> — перенесено в меню Мониторинг → ⚙️ Настройки.
```

### Keyboard

| label | callback_data |
|-------|---------------|
| 🌐 SSH доступ к серверу | `settings:ssh` |
| ♻️ Перезапустить бота | `settings:restart` |
| 🎤 Расшифровка голоса: Deepgram | `settings:stt` |
| « Назад | `settings:back` |

---

## settings ssh (`F0A`)

**Lines:** 55025–55081 · help 53436–53445

### Message (ok)

```
<b>🔐 SSH доступ к серверу</b>

🖥 Сервер: <code>{vps_ip}</code>
🔑 Ключей: {n}
🌐 Разрешённых IP: {m}

<b>Открытые IP:</b>   ← if any
  • <code>{ip}</code>
…
Подключение: <code>ssh client@{vps_ip}</code>
```

### Keyboard (ok)

| label | callback_data |
|-------|---------------|
| 🔑 Добавить SSH ключ | `settings:ssh:add-key` |
| 📋 Показать ключи | `settings:ssh:list-keys` | ← if keys_count > 0 |
| 🌐 Открыть IP | `settings:ssh:add-ip` |
| 👁 Показать IP | `settings:ssh:list-ips` | ← if IPs |
| ❓ Инструкция | `settings:ssh:help` |
| « Назад | `settings:extras` |

Error-state: `🔄 Обновить` → `settings:ssh`, « Назад → `settings:back`.

### Help (`settings:ssh:help`)

```
<b>🔐 Как подключиться по SSH</b>

1. Создай ключ на компьютере: <code>ssh-keygen -t ed25519</code>
2. Добавь ключ: кнопка «🔑 Добавить SSH ключ» выше
3. Узнай свой IP: открой <b>ipv4.icanhazip.com</b> в браузере
4. Открой IP: кнопка «🌐 Открыть IP» выше
5. Подключись: <code>ssh client@IP_СЕРВЕРА</code>

Если SSH перестал работать — скорее всего сменился IP. Добавь новый.

Подробнее: спроси агента «покажи SERVER-ACCESS.md»
```

| label | callback_data |
|-------|---------------|
| « Назад | `settings:ssh` |

---

## settings tz

**Lines:** 52861–52907

### Message

```
🕐 <b>Часовой пояс</b>

Текущий: <b>{B4(tz)}, сейчас {HH:MM}</b>

Выбери из списка или нажми «Другой» чтобы ввести вручную.
```

### Keyboard

Две колонки зон (label = `{short} {time}`, selected = `[{short} {time}]`):

| zones (IDs → `settings:tz:set:{id}`) |
|-------------------------------------|
| Europe/Kaliningrad, Europe/Kyiv, Europe/Minsk, Europe/Moscow, Europe/Samara, Asia/Yekaterinburg, Asia/Tashkent, Asia/Almaty, Asia/Bishkek, Asia/Omsk, Asia/Novosibirsk, Asia/Krasnoyarsk, Asia/Irkutsk, Asia/Vladivostok, Europe/Berlin, Europe/London |

| label | callback_data |
|-------|---------------|
| ✏️ Другой | `settings:tz:custom` |
| « Назад | `settings:back` |

Custom prompt:

```
Напиши часовой пояс в формате <b>Region/City</b>.

Примеры: Europe/Berlin, Asia/Bangkok, America/Chicago
```

| label | callback_data |
|-------|---------------|
| ✖ Отмена | `settings:tz:custom:cancel` |

---

## settings limit

**Lines:** 52919–52940

### Message

```
<b>💰 Лимит расходов</b>

Дневной лимит расходов при работе через <b>Anthropic API ключ</b>. При достижении лимита агент остановится и попросит разрешения продолжить.

Подписки (<b>Claude</b>, <b>OpenAI</b>) и <b>OpenRouter</b> сюда не входят — их расходы считает провайдер.

Сейчас: ${spent} из {$N|∞}
```

### Keyboard (each own row)

| label | callback_data |
|-------|---------------|
| ∞ без лимита **or** `[∞ без лимита]` | `settings:limit:set:0` |
| $10/день | `settings:limit:set:10` |
| $25/день | `settings:limit:set:25` |
| $50/день | `settings:limit:set:50` |
| $100/день | `settings:limit:set:100` |
| $200/день | `settings:limit:set:200` |
| « Назад | `settings:back` |

Selected wraps in `[…]`.

---

## settings restart

**Lines:** 53451–53472 · do 121378–121393

### Message

```
<b>♻️ Перезапуск бота</b>

Бот завершит текущую задачу и перезапустится.
Systemd поднимет его обратно через ~5 секунд.

Нужен после изменений в коде бота.
```

Fallback без HTML: `Перезапустить бота?`

### Keyboard

| label | callback_data |
|-------|---------------|
| ✔ Перезапустить | `settings:restart:do` |
| « Назад | `settings:extras` |

После confirm: `Перезапускаюсь ♻️ ~10 секунд.` (+ optional support mention).

---

## settings server-status

**Lines:** callback 121342–121347 → `yh` 114198–114264  
Кнопка в settings ведёт на **статус системы** (не отдельный «только сервер» экран).

### Message (шаблон)

```
<b>📡 Статус системы</b>

📂 Проект: workspace   |   📁 Проект: <code>{name}</code>
🔌 {Подписка Claude | API ключ | Не настроен}
🧠 {model label}
🕐 {timezone | не задан}

🧩 Навыки: {total} ({sys} системных + {own} своих)
💰 Сегодня: ${spent} / {$limit|∞}
  {optional recent cost days}
🤖 {CLIENT_VERSION}

💾 Диск: {…}
🧮 RAM: {…}
⏱ Uptime: {…}
```

### Keyboard

| label | callback_data |
|-------|---------------|
| « Назад | `menu:back` |

---

## settings env (`Uy`)

**Lines:** 54103–54328

### Message header

```
<b>🔑 Переменные окружения</b>

[подключены]   ← if any quick-key connected
```

Далее динамические строки `<code>KEY</code>: …****` / группы Supabase/GitHub/…  
Footer buttons (always):

| label | callback_data |
|-------|---------------|
| ➕ {OpenRouter / Apify / …} | `settings:env:quick:{KEY}` или group screen |
| `{label} ☑️` | `settings:env:delete:{KEY}` / group |
| ✏️  ВПИСАТЬ СВОЮ | `settings:env:add` |
| « Назад | `settings:back` |

Quick-key labels (empty → add): OpenRouter (модели AI), Apify, Supadata, fal.ai, X/Twitter, GitHub, Supabase, Railway, Vercel, Deepgram, Voyage AI, Serper.

Add prompt: `Введите имя переменной (например SERPER_API_KEY):` · ✖ Отмена → `settings:env:cancel`.

---

## connections / auth

### Agent «Подключение» (`$0A` / `uE`) — lines 53974–54041

```
<b>🔌 Подключение</b>

Сейчас агент работает на 👾 Claude Code{, API ключ}.
   — или —
Сейчас агент работает через <b>{OpenAI|OpenRouter|other}</b> в старом режиме внутри этого бота. …

OpenAI и OpenRouter теперь подключаются во втором движке, 🦞 OpenClaw. Это отдельный бот на твоём сервере.
⠀
```

| label | callback_data |
|-------|---------------|
| {provider} ✓ включен | `settings:conn:noop` | ← active |
| 👾 Claude Code | `settings:conn:set:cc` | ← if not active |
| 🔑 Новый токен | `settings:auth:switch-sub` | ← if Claude active |
| Перейти на 🦞 / 🦞 Открыть | `eng:mig` / url | ← conditional |
| « Назад | `menu:agent` (или `settings:back` из auth) |

### Settings auth CC-only (`iq` / `C0A`) — lines 3678–3697, 54905–54922

```
<b>Подписка Anthropic 👾</b>

Claude Code работает, подписка подключена ✔

Если токен перестал работать, пришли новый: «🔑 Новый токен». Как его получить, написано в инструкции.
⠀
```

(или «ждёт подписку» / fault variants)

| label | callback_data / url |
|-------|---------------------|
| 🔑 Новый токен | `settings:auth:switch-sub` |
| 📖 Инструкция | url guide |
| ◂ Назад | `settings:back` |

### Token paste (`settings:auth:switch-sub`, non-CC-only) — 53518–53548

```
Вставь токен подписки Claude.

<b>Как получить:</b>
1. Открой терминал на компьютере
2. Запусти: <code>claude setup-token</code>
3. Авторизуйся в браузере
4. Скопируй токен <code>sk-ant-oat...</code> из терминала и вставь сюда

❌ Не вставляй код из браузера (страница «Authentication code») — это другое.
```

| label | callback_data |
|-------|---------------|
| « Назад | `settings:auth` |

### «Что выбрать» (`settings:auth:help`) — 53496–515

```
<b>Что выбрать 🧠 💸</b>

<b>[1] Подписка Claude Max</b>
…

<b>[2] Подписка ChatGPT</b>
…

<b>[3] Ключ OpenRouter</b>
…

Подключить можно все сразу ⚔️ и менять в процессе работы.
```

| label | callback_data |
|-------|---------------|
| « Назад | `settings:auth` |

---

## agent home (`mK` / `V0`)

**Lines:** 53858–53932

### Message

```
<b>🧠 Агент</b>

Модель: <b>{label}</b>
Глубина: <b>{level}</b>          ← omit if model has no effort
Режим: <b>{без спроса|auto|с подтверждением|сначала план}</b>
Подключение: <b>{👾 Claude Code | provider}</b>   ← optional
⠀
```

### Keyboard (effort available)

| label | callback_data |
|-------|---------------|
| 🧠 Модель | `settings:model` |
| 💭 Глубина | `settings:effort` |
| 🔐 Режим | `settings:permmode` |
| 🔌 Подключение | `settings:conn` |
| « Назад | `menu:back` |

Rows: model|effort · mode|conn · back.  
Without effort: model|mode · conn · back.

---

## agent model (`D0A`)

**Lines:** 52460–52510 · families `Xy` 55153–55168

### Message

```
<b>🧠 Модель</b>

Сейчас: <b>{label}</b>{. Сама переходит на новейшую. | , фиксированная версия. | …}

<b>🔮 Fable</b>: самая мощная модель Anthropic.
<b>🧠 Opus</b>: основная. Код, сложные задачи, долгая самостоятельная работа.
<b>🚀 Sonnet</b>: быстрее и бережёт лимит. Повседневная работа.
<b>🪶 Haiku</b>: самая быстрая. Простые задачи и короткие ответы.

<i>Смена модели сохраняет беседу.</i>
```

### Keyboard (2-col + footer)

| label | callback_data |
|-------|---------------|
| 🔮 Fable[ ✓\| 🔒] | `settings:model:set:{key}` |
| 🧠 Opus… | … |
| 🚀 Sonnet… | … |
| 🪶 Haiku… | … |
| 📌 Версии[ ✓] | `settings:model:ver` |
| « Назад | `menu:agent` |

---

## agent effort (`K0A`)

**Lines:** 52558–52615

### Message

```
<b>💭 Глубина мыслей</b>

Насколько глубоко агент обдумывает ответ.

<b>low</b>: быстро, минимум раздумий
<b>medium</b>: обычная глубина
<b>high</b>: углублённо
<b>xhigh</b>: глубже, для кода и сложных задач (по умолчанию)
<b>max</b>: максимум

<b>Сейчас:</b> {level}{(по умолчанию)}
```

Unsupported model:

```
<b>💭 Глубина мыслей</b>

У этой модели глубина не настраивается.
```

### Keyboard (3-col)

| label | callback_data |
|-------|---------------|
| low[ ✓] | `settings:effort:set:low` |
| medium[ ✓] | `settings:effort:set:medium` |
| high[ ✓] | `settings:effort:set:high` |
| xhigh[ ✓] | `settings:effort:set:xhigh` |
| max[ ✓] | `settings:effort:set:max` |
| « Назад | `menu:agent` |

---

## agent permmode (`YTA`)

**Lines:** 54924–54968 · `settings:permmode`

### Message

```
<b>🧠 Режим работы</b>

Спрашивает ли агент разрешение перед изменениями.

<b>Без спроса</b> — делает всё сам, не спрашивая (по умолчанию)
<b>С подтверждением</b> — ✔/✖ перед каждым изменением файла
<b>Сначала план</b> — показывает план, ждёт ✔, потом делает всё

<b>Сейчас:</b> {label}

<i>Смена режима начнёт новую беседу.</i>
```

(`smart` / Auto описан в коде, но **не** в кнопках UI — фильтр `id !== "smart"`.)

### Keyboard

| label | callback_data |
|-------|---------------|
| Без спроса[ ✓] | `settings:permmode:set:auto` |
| С подтверждением[ ✓] | `settings:permmode:set:control` |
| Сначала план[ ✓] | `settings:permmode:set:plan` |
| « Назад | `menu:agent` |

---

## autonomy home (`r4Q` / `iGA`)

**Lines:** render 101817–101869 · kb 111725–111736

### Message — empty (no tasks/timers)

```
🥷 <b>Автономка</b>

Здесь живёт работа, которую я делаю сам, без твоей команды: по расписанию или по времени.

Сейчас у тебя такой работы нет. Чтобы завести, просто скажи мне словами, например:
<i>«каждое утро в 9 смотри, что нового у конкурентов, и пиши коротко»</i>
<i>«раз в час проверяй сервер и пиши, только если что-то сломалось»</i>

Я заведу задачу, покажу, что ей разрешено, и дальше она ходит сама. Отчёты и историю увидишь здесь.
⠀
```

Other variants: stopped / disarmed / with counts — same title + status lines + `•~•~•~•~•~•~•~•~•` divider for monitor/timers.

### Keyboard

| label | callback_data |
|-------|---------------|
| 📋 Задачи | `auto:tasks` |
| 📡 Мониторинг | `auto:monitor` |
| 🕓 История | `auto:history` |
| ⏳ Таймеры | `auto:timers` |
| ❔ Что это | `auto:what` |
| 🔓 Права | `auto:rights` | ← conditional `nGA()` |
| « Назад | `menu:back` |

---

## autonomy what (`s4Q`)

**Lines:** 101912–101914

```
🥷 <b>Что такое автономка</b>

Обычно я жду твоего сообщения и отвечаю. Автономка это когда я работаю сам, без твоей команды: в нужное время беру задачу, делаю её и присылаю результат.

<b>Как завести</b>
Скажи словами, что делать и когда. Например: <i>«каждое утро в 9 смотри, что нового у конкурентов»</i> или <i>«раз в час проверяй сервер и пиши, только если сломалось»</i>. Я заведу задачу и покажу, что ей разрешено.

<b>Что можно</b>
Посмотреть список задач и открыть любую, поставить на паузу или удалить, посмотреть историю: сколько раз задача ходила, что сделала, во что обошлась.

<b>Про права</b>
У каждой задачи свои границы, и они настоящие, а не на словах. Если задаче позволено только читать, инструментов записи у неё просто нет. Если ей чего-то не хватит, она не промолчит: пришлёт сообщение и подскажет, какой фразой права выдать.

<b>Чем это отличается от таймеров</b>
Таймер повторяет текст в назначенный срок, и всё. Задача умеет больше: у неё есть права, отчёт о работе и история прогонов. Таймеры продолжают работать, никуда переносить их не нужно. Захочешь такую же работу задачей, просто скажи мне, и я заведу.

<b>Если что-то идёт не так</b>
Скажи «останови фоновые задачи», и всё встанет до твоего слова. Одну задачу можно поставить на паузу кнопкой в её карточке.
⠀
```

| label | callback_data |
|-------|---------------|
| « Назад | `auto:home` |

---

## autonomy rights (`B2Q` / `l2Q`)

**Lines:** 101916–101918 · kb 111774–111775 · buttons 101937–101939

```
🔓 <b>Права фоновых задач</b>

Когда ты пишешь мне сам, у меня есть права администратора сервера: я ставлю программы, меняю настройки служб и перезапускаю их, когда это нужно для задачи.

Фоновые задачи по умолчанию работают без этих прав. Если включишь, их получат задачи, которым можно читать, сохранять файлы и запускать команды. Задачи только для чтения или сбора данных останутся в своих границах.

Защита не даст сделать то, что сломало бы сервер или бота.

Сейчас: выключено.   |   Сейчас: включено.
⠀
```

| label | callback_data |
|-------|---------------|
| 🔓 Включить **or** 🔒 Выключить | `auto:rights-toggle` |
| « Назад | `auto:home` |

Hub button label when shown: `🔓 Права` → `auto:rights`.

---

## autonomy tasks empty (`a4Q`)

**Lines:** 101871–101874

```
📋 <b>Задачи</b>

Пока ни одной. Скажи мне словами, что делать и когда, например:
<i>«каждый понедельник собирай, что вышло за неделю, и присылай списком»</i>

Я заведу задачу и сразу покажу, что ей разрешено делать.
⠀
```

| label | callback_data |
|-------|---------------|
| « Назад | `auto:home` |

---

## autonomy timers empty

**Lines:** 115203–115209

```
⏳ <b>Таймеры</b>

Ни одного. Это старая механика повторов: она просто присылает текст в назначенный срок.

Если нужна работа по расписанию, лучше завести задачу: скажи мне словами, что делать и когда.
⠀
```

| label | callback_data |
|-------|---------------|
| « Назад | `auto:home` |

---

## autonomy history empty (`ma` / `auto:history`)

**Lines:** screen wrap 115186–115189 · empty body 26408

```
🕓 <b>История фоновой работы</b>

Прогонов в журнале пока нет. Это не поломка: если задачи стоят, но их час ещё не наступал, записывать нечего.
⠀
```

| label | callback_data |
|-------|---------------|
| « Назад | `auto:home` |

---

## monitor home (`ZC`)

**Lines:** 114763–114854

### Message — empty sources

```
📡 <b>Мониторинг</b>

Статус: нет подключённых источников

Добавь первый — напиши, за кем следить.
⠀
```

### Keyboard

| label | callback_data |
|-------|---------------|
| 🛰️ Источники | `mon:sources` |
| 📨 Дайджест | `mon:digest` |
| ⚙️ Настройки | `mon:settings` |
| ❔ Что это | `mon:help` |
| 📊 Обработка | `mon:scored` | ← feature flag |
| « Назад | `menu:back` or `auto:home` |

---

## monitor sources empty

**Lines:** 116200–116270

```
📂 <b>Источники</b>

Пока пусто. Добавь — напиши, за кем следить.
⠀
```

| label | callback_data |
|-------|---------------|
| + Добавить источник | `mon:add-hint` |
| « Назад | `mon:back` |

(With sources: also `⚡ Собрать всё сейчас` → `mon:poll:all`.)

---

## monitor digest (`BY`)

**Lines:** 116704–116733

```
📨 <b>Дайджест</b>

Каждый день в {H}:00 → сюда
   — или —
Сейчас выключен.
В отчёте: топ-{N} с источника | все значимые
⠀
```

| label | callback_data |
|-------|---------------|
| ⚡ Собрать всё сейчас | `mon:poll:all` | ← if enabled sources |
| 👁 Показать за сегодня | `digest:now` |
| 🕘 Время | `mon:digest:time` |
| 🔢 Сколько материалов | `mon:digest:count` |
| 📬 Куда присылать | `mon:digest:target` |
| Выключить дайджест / Включить дайджест | `mon:digest-toggle` |
| « Назад | `mon:back` |

---

## monitor help (`mon:help`)

**Lines:** 116426–116456

```
❔ <b>Мониторинг: что это</b>

Слежу за твоими источниками, оцениваю важность материалов и раз в день присылаю отчёт (HTML-файл).

🛰 <b>Источники</b>. За кем слежу. Добавить (просто напиши, за кем следить), выключить или удалить. У каждого источника своя частота сбора и свои критерии оценки.
📨 <b>Дайджест</b>. Когда и куда присылать отчёт, сколько материалов включать. Можно собрать прямо сейчас.
⚙️ <b>Настройки</b>:
  • Интервалы сбора: как часто опрашивать источники.
  • Уведомления: сообщать ли о проблемах со сбором.
  • Хранилище: сколько дней хранить собранное.
  • Модель оценки: на чём оцениваю важность (твой ключ OpenRouter).
  • Баланс и лимиты: расход и порог предупреждения.
  • Вид отчёта: попросить меня изменить оформление отчёта.

<b>Искать в собранном можно словами, кнопка для этого не нужна.</b>
Скажи мне, например: <i>«найди в собранном всё про Claude Code за неделю»</i> или <i>«что писали по нашей теме на GitHub за три дня»</i>. Я поищу и по словам, и по смыслу, а не только по точному совпадению.

Почти всё здесь настраивается так же, обычной просьбой.
⠀
```

| label | callback_data |
|-------|---------------|
| « Назад | `mon:back` |

---

## mcp home (`yGA`)

**Lines:** 111805–111852

```
🔌 <b>MCP серверы</b>

Внешние сервисы — транскрипты, скрейпинг, базы данных и другие инструменты.
⠀
```

| label | callback_data |
|-------|---------------|
| 📁 workspace ({n}) | `mcp:folder:workspace` |
| « Назад | `menu:back` |

---

## mcp workspace empty (`SGA`)

**Lines:** 111854–111906

```
<b>📁 workspace</b>

Доступны агенту во всех проектах.

<i>Нет серверов</i>
⠀
```

| label | callback_data |
|-------|---------------|
| ➕ Добавить | `mcp:add` |
| « Назад | `menu:mcp` |

---

## skills home (`YC`)

**Lines:** 112090–112156

```
🧩 <b>Навыки</b>

Инструкции и правила, которые расширяют возможности агента.
⠀
```

| label | callback_data |
|-------|---------------|
| 📁 workspace ({n}) | `skills:folder:workspace` |
| 📁 {project} ({n}) | `skills:folder:project` | ← if project skills |
| « Назад | `skills:back-menu` |

### skills folder empty — 121121–121157

```
<b>📁 workspace</b>

Доступны агенту всегда, в любом проекте.

<i>Нет навыков</i>
⠀
```

| label | callback_data |
|-------|---------------|
| ➕ Добавить | `skills:add:workspace` |
| « Назад | `skills:back` |

---

## sessions

### Empty — 112071, 121486–121494

```
Нет сохранённых сессий. Напиши что-нибудь, чтобы начать первую.
```

| label | callback_data |
|-------|---------------|
| « Назад | `menu:back` | ← from menu callback |

### List header (`Oh`) — 112014+

```
📋 <b>Сессии</b> ({n}){ — стр. k}:

{dynamic entries…}
```

Footer: « Назад → `menu:back`; optional `⟲ Вернуть предыдущую` → `sessions:restoreprev`.

---

## newtask

### Slash `/newtask` — 111992

```
🆕 Новая сессия. Предыдущий контекст сброшен.
```

### Menu `menu:newtask` — 121464–121465

```
🆕 Новая сессия. Предыдущая сохранена — найдёшь в /sessions.

Пиши.
```

(no keyboard)

---

## projects empty

**Lines:** 112261–112275, 121544–121569

```
📁 Проектов пока нет.
```

| label | callback_data |
|-------|---------------|
| ➕ Новый проект | `menu:newproject` |
| « Назад | `menu:back` | ← from hub menu path |

### newproject prompt — 121605–121608

```
Введи название проекта.

Латиницей, маленькими буквами, без пробелов. Можно цифры, дефис и подчёркивание.
Например: <code>youtube-asset</code>
```

| label | callback_data |
|-------|---------------|
| ✖ Отмена | `menu:cancel_newproject` |

---

## setup mode

### Gate copy (media / text blocked) — 119899+

```
Сначала подключи AI: /start
```

### Welcome non-QQ (`T1A` / `x1A`) — 103815–103836

```
Сервер готов — осталось подключить AI.

<b>📱 Подписка OpenAI (с телефона)</b>
Свой ChatGPT Plus, подключение с телефона. По умолчанию на {model}.

<b>🔀 Свой ключ OpenRouter</b>
Один ключ = десятки моделей. По умолчанию свежая GPT-5.6 Sol.

<b>📋 Anthropic (Claude)</b>
Подписка Claude (нужен ноутбук для первой настройки). По умолчанию на Opus 4.8.

<i>Другие провайдеры будут позже.</i>
```

| label | callback_data |
|-------|---------------|
| 📱 OpenAI (телефон) | `setup:openai-sub` |
| 🔀 OpenRouter-ключ | `setup:openrouter` |
| 📋 Anthropic | `setup:help` |
| Что выбрать? — подробнее | `setup:help` |

### Install welcome QQ (`Mu`) — 3440–3456

```
<b>Джарвис установлен ⚔️</b>

Сервер и бот готовы. Осталось подключить AI.

<b>КАК НАЧАТЬ</b>
[1] Нажми «👾 Claude Code» и подключи свою подписку Claude Max ($100 или $200). Понадобится компьютер, один раз
[2] Готово: пиши сюда, агент ответит

<b>ДОПОЛНИТЕЛЬНО</b>
[x] 🦞 OpenClaw: второй движок в отдельном боте, для подписки ChatGPT или ключей других компаний…
⠀
```

| label | callback_data |
|-------|---------------|
| 👾 Claude Code | `setup:subscription` |
| 🦞 OpenClaw | `setup:oc` |
| ❓ Что выбрать | `setup:pick` |

### AI not connected (`Ru`) — 3480–3486

```
AI ещё не подключён, агенту нечем ответить. Чтобы он ответил здесь, подключи Claude Code кнопкой ниже.
⠀
```

| label | callback_data |
|-------|---------------|
| 👾 Claude Code | `setup:subscription` |
| 🦞 OpenClaw | `setup:oc` |

### Claude setup-token wizard (`gu` / `wu`) — 3749–3759

```
<b>Подписка Claude 👾</b>

Нужен компьютер, один раз, 2-3 минуты.

[1] Открой терминал: на Mac «Терминал», на Windows PowerShell
[2] Вставь команду и нажми Enter: <code>claude setup-token</code>
[3] Откроется браузер: войди в аккаунт Claude и подтверди доступ
[4] Вернись в терминал: там появится жёлтая строка с токеном, начинается с <code>sk-ant-oat</code>. Скопируй её целиком
[5] Пришли токен сюда одним сообщением, я его удалю из чата

Если терминал пишет, что команда не найдена, Claude Code на компьютере ещё не установлен: как поставить, в инструкции по кнопке.
⠀
```

| label | callback_data / url |
|-------|---------------------|
| 📖 Инструкция | guide url |
| ◂ Назад | `setup:back` |

### `setup:subscription` (alt short) — 103652–103671

```
<b>Подписка Claude</b>

Если Claude Code уже установлен — запусти в терминале:
<code>claude setup-token</code>
…
Вставь токен сюда:
```

| label | callback_data |
|-------|---------------|
| « Назад | `setup:back` |

### `setup:help` — 103742–103757

```
<b>Anthropic (Claude)</b>

<b>📋 Подписка Claude Max</b>
• Фиксированная цена $100-200/мес
• При активном использовании эквивалентно ~$3000 по API
• Нужен ноутбук для первой настройки

Настроить можно в любой момент в /settings.
```

| label | callback_data |
|-------|---------------|
| 📋 Подписка | `setup:subscription` |
| « Назад | `setup:back` |

### Transient setup replies

| step | text |
|------|------|
| waiting_openai_device | `Жду подтверждения в ChatGPT — не закрывай чат. Чтобы прервать, нажми «Отменить».` |
| waiting_oc_install | `⏳ Ещё готовлю агента, подожди немного…` |
| validating | `Проверяю токен, подожди 20-30 секунд...` |

### Shared button labels (`dA`) — 3737–3748

| key | label |
|-----|-------|
| claude | 👾 Claude Code |
| connect | 👾 Подключить |
| openclaw | 🦞 OpenClaw |
| pick | ❓ Что выбрать |
| guide | 📖 Инструкция |
| add | ➕ Добавить |
| back | ◂ Назад |
| newToken | 🔑 Новый токен |
| engines | ⚙️ Движки |
| open | 🦞 Открыть |

---

## help command (`A0A` / `tBA`)

**Lines:** 51821–51875 · `/help` → 111924–111928

Engine `cc` (default) — `tBA`:

```
<b>Как работать</b>

Пиши задачу текстом — агент сам пишет код, коммитит в git, работает автономно.
Голосовые, фото, файлы, видео — тоже ок.

<b>Управление сессией:</b>
/newtask — новая сессия (сбросить контекст)
/stop — остановить задачу
/clear — полный сброс контекста и истории
/undo — отменить последнюю правку файла

<b>Навигация:</b>
/projects — переключение между проектами
/sessions — список сессий

<b>Подключение и доступ:</b>
/connect — VS Code через туннель
/recovery — аварийный доступ к серверу
/settings — подключения, ключи, SSH, лимиты

<b>Фоновая работа:</b>
/autostatus — история фоновых прогонов
/autoactions — что зарегистрировано и когда сработает

<b>Мониторинг:</b>
/monitor — статус мониторинга
/digest — дайджест контента
/sources — каналы и аккаунты

<b>Информация:</b>
/status — текущий проект и рабочая директория
/cost — расход API за сегодня
/skills — навыки агента
/feedback — отправить отзыв
```

OC variant (`eBA`, 51876–51914): same, plus block **Возможности движка (OpenClaw):** `/context`, `/tools`, `/commands`.

No inline keyboard.

---

## Line map (quick)

| Screen | Symbol / area | Approx lines |
|--------|---------------|--------------|
| hub | `Ph` | 111780 |
| settings home | `Hy`/`Ky`/`iF` | 52126–52293 |
| extras | `mE` | 54970 |
| ssh | `F0A` | 55025 |
| tz / limit / restart | `I2` branches | 52861–53472 |
| server-status | `yh` via callback | 114198, 121342 |
| env | `Uy` | 54103 |
| auth/conn | `iq`/`$0A`/`C0A` | 3678, 53974, 54905 |
| agent | `mK`/`D0A`/`K0A`/`YTA` | 53858, 52460, 52558, 54924 |
| autonomy | `$U` renders + `iGA` | 101817–101939, 111719+ |
| monitor | `ZC`/`BY`/`mon:*` | 114763–116456 |
| mcp | `yGA`/`SGA` | 111805–111906 |
| skills | `YC` + folder | 112090, 121121 |
| sessions/projects/newtask | cmds + `menu:` | 111976+, 121432+ |
| setup | `ny`/`Mu`/`gu`/`T1A` | 3440–3760, 103526+ |
| help | `tBA`/`A0A` | 51821–51875 |
