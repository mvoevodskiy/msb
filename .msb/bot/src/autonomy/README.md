# Автономка

[← Вход ядра](../main.mjs) · [Исполнение](../agent/README.md) ·
[Telegram](../telegram/README.md#callback-маршруты)

`store` сериализует read/modify/write через общий [file lock](../../shared/file-lock.mjs).
Scheduler перечитывает кандидата до запуска, а по завершении условно сохраняет
только поля результата неизменённой задачи. Новый/удалённый/отредактированный
вход не затирается старым снимком; lock не удерживается во время модели.
[persistence regression](../../tests/autonomy-store-concurrency.test.mjs) проверяет
также независимые процессы. [Контракт old→new](../../tests/reference/parity-autonomy-contract.txt). `saveAllTasks` — явная замена всего списка, не API
будущих toggle/delete; их read/modify/write должно оставаться в store transaction.
Lock сериализует запись JSON, не резервирует выполнение задачи между несколькими
scheduler-процессами. При изменении задачи во время хода CAS отбрасывает старый
результат; это сохраняет правку, но не даёт гарантии однократных внешних эффектов.

Базовые интервальные задачи используют общий `runAgentTurn` и состояние бота.
Данные — `<profile.root>/autonomy` либо явно заданный `AUTONOMY_DIR`.

| Задача | Файл → функция |
|---|---|
| Разобрать сообщение «каждые N часов …» | [store.mjs](store.mjs): `tryParseScheduleMessage` |
| Прочитать/сохранить задачи | [store.mjs](store.mjs): `listTasks`, `addTask`, `saveTaskResult` (полная замена — только явный `saveAllTasks`) |
| Выполнить наступившую задачу и сохранить `runs.jsonl` | [scheduler.mjs](scheduler.mjs): `startScheduler`, внутренний `runTask` |
| Не начинать фоновый ход одновременно с `/compact` | [session-operation.mjs](../agent/session-operation.mjs): `trySessionOperation` |
| Прочитать журнал и подготовить страницы истории | [history.mjs](history.mjs): `readRecentRuns`, `historyPages` |
| Список, карточки и настройки UI | [screens/autonomy](../telegram/screens/autonomy.mjs), [routes/autonomy](../telegram/routes/autonomy.mjs) |

`main` запускает scheduler; его `stop()` снимает таймеры. Отдельная отмена уже
начатого фонового `runAgentTurn` этим методом не реализована.
У сохранённых таймеров есть список, карточка, включение, выключение и удаление.
[Хранилище](./legacy-timers.mjs) читает schedules.json рядом с папкой сессий,
как в старом ядре. [Экран](../telegram/screens/legacy-timers.mjs) показывает
записи once, daily и weekly. [Проверки](../../tests/autonomy-timers.test.mjs)
идут через [Telegram callback](../telegram/routes/autonomy.mjs).
Исполнение сохранённых таймеров ещё предстоит подключить. В старом ядре
просьба о новом напоминании создавала разовую задачу в отдельном хранилище.

Часть действий карточек задач пока не подключена. Сохранённые autonomy rights
ещё не задают отдельные права исполнения.
История использует фактические поля текущего `runs.jsonl` независимо от CLI;
стоимость, модель и время выполнения в текущем формате не записываются.
`/autostatus [N]` ограничивает выборку до 1–50 строк, по умолчанию 10.

Проверки: [paths-state](../../tests/paths-state.test.mjs) включает парсер расписания,
[menu-handlers](../../tests/menu-handlers.test.mjs) — сохранённые настройки,
[autonomy-history](../../tests/autonomy-history.test.mjs) — история и её границы.
Полного integration-теста scheduler/доставки фоновой задачи в этом наборе нет.
Эталон: [CONTRACT-autonomy](../../vendor/CONTRACT-autonomy.md).
