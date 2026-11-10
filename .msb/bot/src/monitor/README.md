# Мониторинг

[← Вход ядра](../main.mjs) · [Telegram](../telegram/README.md#callback-маршруты)

Сбор источников и дайджест. Вход — `startMonitorScheduler` из `main`;
кнопки ведут через `handleMonitorRoute`. Данные — `<profile.root>/monitor`.

| Задача | Файл → функция |
|---|---|
| Разобрать ссылку и сохранить источник | [config.mjs](config.mjs): `classifySourceInput`, `addSourceFromInput`, `removeSource`, `updateMonitorConfig` |
| Безопасная длина идентификатора кнопки источника | [source-ref.mjs](source-ref.mjs): `sourceCallbackData`, `sourceToken` |
| Получить материалы | [poll.mjs](poll.mjs): `pollAllSources` |
| Убрать дубликаты и записать JSONL/meta | [store.mjs](store.mjs): `itemId`, `appendItems`, `loadMeta`, `updateMeta` |
| Собрать/отправить дайджест | [digest.mjs](digest.mjs): `buildDigestText`, `maybeSendDigest`, `updateDigestSettings` |
| Фоновый запуск | [scheduler.mjs](scheduler.mjs): `startMonitorScheduler` |
| Экран и действие | [screens/monitor](../telegram/screens/monitor.mjs), [routes/monitor](../telegram/routes/monitor.mjs) |

Есть обработчики RSS/Atom, YouTube RSS, GitHub Atom, Telegram public и X API.
Фоновый тик — 5 минут; дайджест учитывает сохранённую timezone профиля бота.
Изменения `meta.json` сериализованы по профилю и между процессами: сбор обновляет
только времена источников, отправка — свою отметку после успешной доставки.
Реальный backend — JSONL. Сохранение значения `sqlite` в UI не создаёт SQLite backend.

Проверки: [monitor-env](../../tests/monitor-env.test.mjs) — config/storage,
[menu-handlers](../../tests/menu-handlers.test.mjs) — меню, timezone и отправка.
Доступность внешних источников и полнота старого мониторинга ими не подтверждаются.
