# Мониторинг

[← Вход ядра](../main.mjs) · [Telegram](../telegram/README.md#callback-маршруты)

Сбор источников и дайджест. Вход — `startMonitorScheduler` из `main`;
кнопки ведут через `handleMonitorRoute`. Данные — `<profile.root>/monitor`.

| Задача | Файл → функция |
|---|---|
| Разобрать ссылку и сохранить источник | [config.mjs](config.mjs): `classifySourceInput`, `addSourceFromInput`, `removeSource`, `updateMonitorConfig`; неоднозначный @ник → [форма выбора](../telegram/forms/monitor.mjs) |
| Безопасная длина идентификатора кнопки источника | [source-ref.mjs](source-ref.mjs): `sourceCallbackData`, `sourceToken` |
| Получить материалы | [poll.mjs](poll.mjs): `pollAllSources` |
| Убрать дубликаты и записать JSONL/meta | [store.mjs](store.mjs): `itemId`, `appendItems`, `loadMeta`, `updateMeta` |
| Собрать/отправить дайджест | [digest.mjs](digest.mjs): `buildDigestText`, `maybeSendDigest`, `updateDigestSettings` |
| Фоновый запуск | [scheduler.mjs](scheduler.mjs): `startMonitorScheduler` → [межпроцессный claim](scheduler-claim.mjs) одного бота |
| Экран и действие | [screens/monitor](../telegram/screens/monitor.mjs), [routes/monitor](../telegram/routes/monitor.mjs) |

Есть обработчики RSS/Atom, YouTube RSS, GitHub Atom, Telegram public и X API.
Фоновый тик — 5 минут; плановый сбор соблюдает интервалы по типу источника
и боту, а ручной сбор запускается сразу и не сдвигает плановую отметку.
[Контракт периодов](../../tests/reference/parity-monitor-interval-contract.txt),
[проверки](../../tests/monitor-interval-scheduler.test.mjs). Одновременные
плановые тики одного бота защищены отдельным [claim](scheduler-claim.mjs);
[границы и тесты](../../tests/reference/parity-monitor-scheduler-claim-contract.txt). Дайджест
учитывает сохранённую timezone профиля бота.
Изменения `meta.json` сериализованы по профилю и между процессами: сбор обновляет
только времена источников, отправка — свою отметку после успешной доставки.
Автоматическое обновление не заменяет нечитаемые или повреждённые метаданные
пустым состоянием; отсутствие файла по-прежнему создаёт начальное состояние.
[Контракт и границы](../../tests/reference/parity-monitor-meta-integrity-contract.txt),
[проверки](../../tests/monitor-meta-integrity.test.mjs).
Реальный backend — JSONL. Сохранение значения `sqlite` в UI не создаёт SQLite backend;
[старое хранилище и граница включения](../../tests/reference/parity-monitor-storage-evidence.txt),
[синтетический baseline](../../tests/reference/probe-monitor-storage-baseline.mjs) и
[проверка ключей](../../tests/reference/probe-monitor-storage-id-collision.mjs).

Проверки: [monitor-env](../../tests/monitor-env.test.mjs) — config/storage,
[menu-handlers](../../tests/menu-handlers.test.mjs) — меню, timezone и отправка;
[monitor-source-choice](../../tests/monitor-source-choice.test.mjs) — ввод @ника, выбор, отмена и устаревшие кнопки;
[старый контракт](../../tests/reference/parity-monitor-source-contract.txt) — доказательства и границы;
[monitor-reactivate](../../tests/monitor-reactivate.test.mjs) — повторное добавление отключённого X-источника;
[контракт повтора](../../tests/reference/parity-monitor-reactivate-contract.txt) — старый и текущий путь;
[monitor-github-reactivate](../../tests/monitor-github-reactivate.test.mjs) и
[контракт GitHub](../../tests/reference/parity-monitor-github-contract.txt) — регистр, повторное включение и уже существующие дубли;
[monitor-youtube-reactivate](../../tests/monitor-youtube-reactivate.test.mjs) и
[контракт YouTube](../../tests/reference/parity-monitor-youtube-contract.txt) — точные ID/handle, нерешённая проверка алиасов и условный формат `handle:`;
[monitor-twitter-legacy](../../tests/monitor-twitter-legacy.test.mjs) и
[контракт старых X-записей](../../tests/reference/parity-monitor-twitter-legacy-contract.txt) — handle/username, кнопки и сбор;
[регрессия снимка источника](../../tests/monitor-source-snapshot.test.mjs) и
[контракт](../../tests/reference/parity-monitor-source-snapshot-contract.txt) — отложенный сбор и изменённые записи.
Доступность внешних источников и полнота старого мониторинга ими не подтверждаются.
