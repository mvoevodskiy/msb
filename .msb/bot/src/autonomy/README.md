# Автономка

[← Вход ядра](../main.mjs) · [Исполнение](../agent/README.md) ·
[Telegram](../telegram/README.md#callback-маршруты)

Базовые интервальные задачи используют общий `runAgentTurn` и состояние бота.
Данные — `<profile.root>/autonomy` либо явно заданный `AUTONOMY_DIR`.

| Задача | Файл → функция |
|---|---|
| Разобрать сообщение «каждые N часов …» | [store.mjs](store.mjs): `tryParseScheduleMessage` |
| Прочитать/сохранить задачи | [store.mjs](store.mjs): `listTasks`, `addTask`, `saveAllTasks` |
| Выполнить наступившую задачу и сохранить `runs.jsonl` | [scheduler.mjs](scheduler.mjs): `startScheduler`, внутренний `runTask` |
| Не начинать фоновый ход одновременно с `/compact` | [session-operation.mjs](../agent/session-operation.mjs): `trySessionOperation` |
| Прочитать журнал и подготовить страницы истории | [history.mjs](history.mjs): `readRecentRuns`, `historyPages` |
| Список, карточки и настройки UI | [screens/autonomy](../telegram/screens/autonomy.mjs), [routes/autonomy](../telegram/routes/autonomy.mjs) |

`main` запускает scheduler; его `stop()` снимает таймеры. Отдельная отмена уже
начатого фонового `runAgentTurn` этим методом не реализована.
Разовые таймеры и часть действий карточек остаются placeholders;
сохранённые autonomy rights не создают отдельной модели прав исполнения.
История использует фактические поля текущего `runs.jsonl` независимо от CLI;
стоимость, модель и время выполнения в текущем формате не записываются.
`/autostatus [N]` ограничивает выборку до 1–50 строк, по умолчанию 10.

Проверки: [paths-state](../../tests/paths-state.test.mjs) включает парсер расписания,
[menu-handlers](../../tests/menu-handlers.test.mjs) — сохранённые настройки,
[autonomy-history](../../tests/autonomy-history.test.mjs) — история и её границы.
Полного integration-теста scheduler/доставки фоновой задачи в этом наборе нет.
Эталон: [CONTRACT-autonomy](../../vendor/CONTRACT-autonomy.md).
