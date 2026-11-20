# Возможности и сервисы

## Что работает из коробки

- 👾 **Claude Code** (этот бот) работает по подписке Claude (Pro или Max).
- 🦞 **OpenClaw** можно поставить рядом, он отвечает в отдельном боте. Он работает по подписке ChatGPT или по API-ключу OpenAI, Gemini, Grok, Anthropic или OpenRouter. Поставить его: /settings → ⚙️ Движки → ➕ OpenClaw. Если в /settings нет «⚙️ Движки», на этом сервере OpenClaw пока не ставится.
- Ключи OpenRouter, Gemini и других сервисов в «Переменных окружения» (разделы ниже) этот бот использует для отдельных задач через их API. Модель, на которой он отвечает, они не меняют.

Основные возможности доступны сразу:

- **Поиск в интернете**: встроенный поиск движка (лучше Google для технических запросов)
- **Чтение веб-страниц** — парсинг любых URL, документация, статьи, GitHub-репозитории
- **Работа с файлами** — чтение, создание, редактирование любых файлов
- **Код** — написание, рефакторинг, дебаг на любом языке
- **Git** — коммиты, ветки, диффы, история
- **Анализ изображений** — распознавание скриншотов, диаграмм, фото
- **Shell** — выполнение команд, установка пакетов, сборка проектов
- **npm/pip/cargo** — установка зависимостей, запуск проектов

Ничего настраивать не нужно — просто пиши задачу.

---

## Дополнительные сервисы

Каждый сервис расширяет возможности ассистента. Подключай по мере необходимости.

### 1. Голосовые сообщения — DEEPGRAM_API_KEY

Без этого ключа голосовые сообщения не распознаются.

- **Где взять:** https://console.deepgram.com → Sign Up → API Keys
- **Стоимость:** $200 бесплатных кредитов при регистрации. Потом ~$0.004/мин
- **Как добавить:** /settings → Переменные окружения → имя: DEEPGRAM_API_KEY, значение: ключ
- **Результат:** голосовые начнут распознаваться сразу

---

### 2. Векторная память — VOYAGE_API_KEY

Умный поиск по заметкам и базе знаний. Без ключа — работает текстовый поиск (хуже для семантических запросов).

- **Где взять:** https://dash.voyageai.com → Sign Up → API Keys
- **Стоимость:** $0.02 за 1M токенов (очень дёшево). Бесплатный tier есть
- **Как добавить:** /settings → Переменные окружения → имя: VOYAGE_API_KEY, значение: ключ
- **Результат:** поиск по памяти и заметкам станет семантическим (понимает смысл, а не только слова)

---

### 3. GitHub — репозитории

Доступ к репозиториям, управление issues/PRs, деплой через GitHub Actions.

Оба типа токенов сохраняются как `$GITHUB_TOKEN`. Достаточно одного:

**Fine-grained token (рекомендуем)** — доступ только к выбранным репо:
- Где взять: https://github.com/settings/tokens?type=beta → Generate new token
- Token name: «Jarvis Agent», Expiration: 90 дней
- **Repository access:** Only select repositories → выбрать нужные
- **Отдельно** нажми Repository permissions и проставь: Contents (Read+Write), Pull requests (Read+Write)
- Формат: `github_pat_...`

**Classic token** — доступ ко ВСЕМ репо:
- Где взять: https://github.com/settings/tokens/new
- Scopes: repo (первый чекбокс)
- Формат: `ghp_...`

- **Стоимость:** бесплатно
- **Как добавить:** /settings → GitHub → выбрать тип

---

### 4. Railway — деплой бэкенда

Деплой проектов в облако. Railway — простейший способ задеплоить бэкенд, бот, API или cron-задачу.

Оба типа токенов сохраняются как `$RAILWAY_TOKEN`. Достаточно одного:

**Токен проекта** (рекомендуем) — доступ только к одному проекту:
- Где взять: railway.app → Проект → Settings → Tokens → Create Project Token
- Как добавить: /settings → Railway → Токен Railway
- Формат: UUID (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
- Заголовок: `Project-Access-Token: $RAILWAY_TOKEN`
- ⚠️ Токен УЖЕ привязан к проекту — НЕ передавай projectId для авторизации
- ⚠️ Railway CLI с ним НЕ работает — только API

**Токен аккаунта** — полный доступ ко всем проектам:
- Где взять: railway.app → Account Settings → Tokens → Create Token
- Как добавить: /settings → Railway → Токен Railway
- Заголовок: `Authorization: Bearer $RAILWAY_TOKEN`
- Работает с Railway CLI

**Project ID** (`$RAILWAY_PROJECT_ID`) — нужен как значение в полях input запросов (deployments, services):
- Где взять: railway.app → Проект → Settings → General → Project ID
- Как добавить: /settings → Railway → Project ID

- **Стоимость:** $5/мес (Hobby plan). Pay-as-you-go за ресурсы

**Что можно деплоить:**
- Telegram-боты (always-on)
- API/бэкенды (Node.js, Python, Go)
- Cron-задачи (по расписанию)
- Базы данных (PostgreSQL, Redis)

**Railway API (GraphQL):**
```bash
# С токеном проекта (UUID):
curl -s https://backboard.railway.app/graphql/v2 \
  -H "Project-Access-Token: $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ me { name email } }"}'

# С токеном аккаунта:
curl -s https://backboard.railway.app/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ me { name email } }"}'
```

---

### 5. Vercel — деплой фронтенда

Деплой сайтов, Next.js, serverless-функций.

Два ключа (добавляй через /settings → Vercel):

- **VERCEL_TOKEN** — токен доступа к API и CLI
  - Где взять: https://vercel.com/account/tokens → Create Token
  - Токен даёт доступ ко всем проектам аккаунта

- **VERCEL_PROJECT_ID** — ограничивает агента одним проектом
  - Где взять: vercel.com → Проект → Settings → General → Project ID
  - Формат: `prj_xxxxxxxxxxxxxxxx`
  - Если указан — агент деплоит ТОЛЬКО в этот проект

- **Стоимость:** бесплатный tier для хобби-проектов
- **Как добавить:** /settings → Vercel
- **Безопасность:** деплой = действие с подтверждением. Агент покажет план и спросит перед выполнением

---

### 6. Supabase — база данных

PostgreSQL + REST API + Auth + Storage.

Четыре ключа (добавляй через /settings → Supabase):

- **SUPABASE_URL** — адрес проекта (`https://xxx.supabase.co`). Где взять: ⚙️ Project Settings → Data API → Project URL
- **SUPABASE_ANON_KEY** — публичный ключ (с RLS). Где взять: ⚙️ Project Settings → API Keys → anon public
- **SUPABASE_SERVICE_KEY** — полный доступ, обходит RLS. Где взять: ⚙️ Project Settings → API Keys → service_role (Reveal)
- **SUPABASE_ACCESS_TOKEN** — для CLI (миграции, edge functions). Где взять: аватарка → Account Settings → Access Tokens

Стоимость: бесплатный tier (2 проекта). Pro $25/мес

**Примеры curl (работают и с новыми ключами sb_publishable/sb_secret):**

```bash
# Чтение (anon key — с RLS)
curl -s "$SUPABASE_URL/rest/v1/table_name" \
  -H "apikey: $SUPABASE_ANON_KEY"

# Чтение с фильтром
curl -s "$SUPABASE_URL/rest/v1/table_name?status=eq.active&order=created_at.desc&limit=10" \
  -H "apikey: $SUPABASE_ANON_KEY"

# Запись (service key — полный доступ)
curl -s "$SUPABASE_URL/rest/v1/table_name" \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "test", "value": 42}'

# Обновление
curl -s -X PATCH "$SUPABASE_URL/rest/v1/table_name?id=eq.123" \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status": "done"}'
```

Фильтры PostgREST: `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `like`, `ilike`, `in`, `is`. Пример: `?age=gte.18&name=ilike.*john*`

**Supabase CLI:**
- CLI уже установлен. Нужен `SUPABASE_ACCESS_TOKEN` (НЕ ключ проекта — токен аккаунта)
- Привязка: `supabase link --project-ref <ref>` (ref видно в URL: supabase.com/dashboard/project/**<ref>**)
- Примеры: `supabase db dump`, `supabase migration list`, `supabase inspect db table-sizes`

---

### 7. OpenRouter — OPENROUTER_API_KEY

Доступ к разным LLM-моделям (GPT-5.6, Gemini, Grok, Llama) через единый API. Полезно для задач где нужна другая модель.

- **Где взять:** https://openrouter.ai → Sign Up → Keys
- **Стоимость:** pay-per-token, зависит от модели
- **Как добавить:** /settings → Переменные окружения → имя: OPENROUTER_API_KEY, значение: ключ
- **Результат:** ассистент сможет использовать любые LLM для специализированных задач (OCR, batch-обработка, дешёвый скоринг)

---

### 8. Google AI Studio / Gemini — GOOGLE_API_KEY или GEMINI_API_KEY

Доступ к моделям Google (Gemini Pro, Flash).

- **Где взять:** https://aistudio.google.com → Get API key
- **Стоимость:** бесплатный tier (60 запросов/мин). Платно при высоких объёмах
- **Как добавить:** /settings → Переменные окружения → имя: GOOGLE_API_KEY, значение: ключ
- **Результат:** ассистент сможет вызывать Gemini API через shell (curl)

---

### Любой другой сервис с REST API

Ассистент может работать с **любым** сервисом, у которого есть REST API — не только из списка выше.

- **Как:** добавь API-ключ через /settings → Переменные окружения (например: `NOTION_API_KEY`, `STRIPE_SECRET_KEY`, `AIRTABLE_API_KEY`)
- Ассистент автоматически увидит новый ключ и сможет использовать его через shell (curl)
- Подстановка ключей в запросы происходит автоматически — достаточно назвать переменную по стандартному формату (`SERVICE_API_KEY` или `SERVICE_TOKEN`)

Если не знаешь как подключить конкретный сервис — спроси ассистента, он найдёт документацию и поможет настроить.

---

## Память и заметки

Работает через файловую систему, настройка не нужна:

- **MEMORY.md** — долгосрочная память (факты, предпочтения). Ассистент дополняет автоматически
- **memory/YYYY-MM-DD.md** — дневник (задачи, прогресс за день)
- **knowledge/** — база знаний (архитектура, решения, конфиги)

Чтобы ассистент что-то запомнил — просто скажи "запомни это" или "сохрани в память".

---

## Генерация медиа — fal.ai

Если добавлен ключ `FAL_KEY` (/settings → 🔑) — генерирую картинки, видео и аудио через fal.ai. Авторизация во всех запросах: заголовок `Authorization: Key $FAL_KEY`.

### Картинка (быстро, синхронно)
```bash
curl -s -X POST https://fal.run/fal-ai/flux/schnell \
  -H "Authorization: Key $FAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"кот-космонавт, киберпанк, кинематографично"}'
# → JSON; ссылка на картинку в .images[0].url
```
Модели картинок: `fal-ai/flux/schnell` (быстрая), `fal-ai/flux/dev`, `fal-ai/flux-pro` (качество), `fal-ai/nano-banana` (Gemini-стиль). Параметры: `image_size` (`square`/`landscape_4_3`/`portrait_16_9`…), `num_images`, `output_format` (`jpeg`/`png`).

Чтобы отдать картинку в чат — скачай по url и пришли маркером `[ФОТО: /путь/к/файлу.jpg]`.

### Видео и долгие задачи (очередь, асинхронно)
Видео считается минуты — идёт через очередь. Отправляешь задачу, потом опрашиваешь **возвращённые** `status_url`/`response_url` (не собирай их вручную):
```bash
# 1) поставить задачу — в ответе request_id, status_url, response_url
curl -s -X POST https://queue.fal.run/<model> \
  -H "Authorization: Key $FAL_KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"морской прибой на рассвете, 5 секунд"}'
# 2) опрашивай status_url пока "status":"COMPLETED"
# 3) GET response_url — там ссылка на готовое видео/аудио
```
Каталог моделей и точная схема тела каждой — на https://fal.ai/models (страница `.../api`). Если ключа нет — честно скажи, что для fal.ai нужно добавить `FAL_KEY` в /settings → 🔑.

---

## Проброс ключей в деплой

Ключи из /settings доступны в shell. Чтобы пробросить в деплой-сервис:

- **Vercel:** `vercel env add KEY_NAME production --token $VERCEL_TOKEN` → вставить значение
- **Railway:** `railway variables set KEY_NAME=значение`
- **.env файл:** записать вручную в файл проекта

---

## Статус

Спроси ассистента: "Какие сервисы настроены?" — он проверит переменные окружения и покажет.

Или скажи: "Давай настроим сервисы" — пройдётесь по списку вместе.
