# Пульт: история и квоты провайдеров

[← Вход ядра](../.msb/bot/src/main.mjs) · [Пульт](../.msb/pult/README.md)

Пользовательский интерфейс остаётся прежним. История — фактические новые
Telegram-ходы, квота — измерения именно выбранного провайдера.
`state.engine=cc` означает канал CLI, а не обязательно Claude.

| Задача | Маршрут | Проверка |
|---|---|---|
| Новая чат-история | `telegram/bot.mjs:executeTurn` → `telegram/history.mjs` → per-bot `traces`, `transcripts`, `chat-diary.jsonl` | `turn-history.test.mjs`, lifecycle/voice tests |
| Провайдер хода | `ext/shim/run-turn.mjs` → `provider_id` → `agent/claude.mjs` → `agent/turn.mjs` → history | provider marker/lifecycle tests |
| История и текущая работа в Пульте | `collector/sources/journal.ts` → `sources/bots.ts` → `collect.ts` | `collector/bots.test.ts`, `collect.test.ts` |
| Активный источник подписки | `sources/provider.ts`: OS engine + canonical `ext-providers.json` | `codex-quota.test.ts` provider matrix |
| Claude | `journal.ts`: только Claude читает прежнее `state.rateLimitInfo` | существующие Claude fixtures |
| Codex | `sources/codex-quota.ts`: `initialize` → `account/rateLimits/read`, закрыть процесс | fake stdio, quota/cache/error tests |
| Отображение квот | `shared/types.ts` → `ui/logic.js` → `view-overview.js`; предупреждения `collector/analyze.ts` | UI/collector tests |

Codex использует установленный CLI и его штатную авторизацию текущего OS-user.
Поиск CLI: `PULT_CODEX_BIN` при явной настройке, `<root>/ext-tools/bin/codex`,
затем PATH. Пульт не копирует ключи и не начинает модельный ход; лимиты кешируются
5 минут. Ошибка не обнуляет процент: старое измерение остаётся с прежней датой
и признаком устаревания. Без измерения — неизвестно. Процент квоты не является
процентом заполнения контекста или денежным балансом.

Снимок расширен необязательным `subscriptions[]`; старое `subscription` остаётся
Claude-only для совместимости. Если работают боты разных провайдеров, данные
не перезаписывают друг друга. У ботов одного OS-user Codex-квота общая для его
native аккаунта, а не отдельный лимит каждого бота. Cursor/Qwen/OpenClaw не
получают чужую квоту; их новые источники этим этапом не реализованы.

История хранит ограниченные пользовательские тексты и идентификатор хода,
провайдера, результат, время. Известные секреты редактируются; native JSONL,
системные промпты, скрытые рассуждения и tool inputs не копируются. Файлы0600,
каталоги0700 при создании. Записи не мешают доставке и остановке; повторная
доставка не создаёт второй trace. Неизвестное число инструментов не считается0.

Границы: пропущенную ранее историю не импортируем из приватных native-бесед.
Сборщик показывает новые записи после подключения. Старый Claude rateLimitInfo
reader сохранён; подключение нового Claude quota API здесь не делается.
Автономные runs имеют отдельный исторический разрыв схемы; Deepgram/ProxyAPI/
Apify balances — отдельные существующие источники и не включаются автоматически.

Официальный контракт Codex: [App Server / Rate limits](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).
