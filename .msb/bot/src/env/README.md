# Переменные окружения

[← Вход ядра](../main.mjs) · [Настройки Telegram](../telegram/README.md#настройки-и-кнопки) ·
[Runtime profile](../../shared/README.md)

Модуль управляет per-bot `.env` по пути из профиля, а не native auth Codex.

| Задача | Функции в [store.mjs](store.mjs) |
|---|---|
| Найти файл и прочитать значения | `envFilePath`, `readEnvMap` |
| Показать записи без полного секрета | `listEnvEntries`, `maskValue` |
| Записать или удалить допустимый ключ | `setEnvKey`, `deleteEnvKey`, `PROTECTED_KEYS` |
| Быстрые кнопки | `QUICK_KEYS`; renderer — [settings](../telegram/screens/settings.mjs) |

Маршрут: `settings:env:*` → [handleSettingsRoute](../telegram/routes/settings.mjs)
→ общий `pending` → [message:text](../telegram/bot.mjs) → `setEnvKey`.
Обычные формы отклоняют системные ключи через общий
[отказ](../telegram/env-protection.mjs); pending закрывается до ответа.
`setEnvKey` повторяет запрет до IO. Прежний набор дополнен эквивалентными
bootstrap MSB/IIA names (profile/root/paths/owner), без запрета обычных service keys.
Только [штатная Claude auth-форма](../telegram/forms/auth.mjs) передаёт четвёртый
аргумент `{internal:true}`; Pult и provider secrets имеют прежние маршруты.
[Контракт и provenance](../../tests/reference/parity-env-protected-contract.txt),
[production regression](../../tests/env-protected.test.mjs).

Запись синхронизирует переданный env и его управляемые aliases через shared profile.
Потребитель, захвативший настройку при startup, сам от этого не перезапускается.

Проверки: [monitor-env](../../tests/monitor-env.test.mjs),
[menu-handlers](../../tests/menu-handlers.test.mjs), [runtime-profile](../../tests/runtime-profile.test.mjs).
Provider auth обвязки: [ext/env.mjs](../../../../overlay/bot/ext/env.mjs).
Shared fallback для речи: [media/STT](../media/README.md).

Set/delete и provider writer [ext/env](../../../../overlay/bot/ext/env.mjs)
используют одну [process queue](../../shared/env-writes.mjs), как old xK.
Target закреплён до ожидания; весь read/modify/rename/env update — внутри.
Ошибка освобождает очередь. Это не lock внешних редакторов/других процессов.
[Контракт](../../tests/reference/parity-env-write-contract.txt),
[barrier regression](../../tests/env-write-order.test.mjs).

Описания: [forms/env](../telegram/forms/env.mjs) держит value в private
[PendingInputs payload](../telegram/pending-input.mjs) до description/skip,
с исходным TTL. Cancel/replacement/shutdown удаляют draft; поздний bot prompt
убирается без оживления формы. Пользовательское сообщение со значением сохраняется.
[lines.mjs](lines.mjs) связывает ближайший #comment с ключом и меняет только
его строки; остальные raw lines/quoted values сохраняет. Store пишет value+
comment одной queued mutation. Skip/blank сохраняют старое описание.
[Custom capability metadata](prompt.mjs) → [system prompt](../agent/system-prompt.mjs)
передаёт имена/описания активных custom keys без values. Known service metadata
из [services.mjs](services.mjs) сохраняет19прежних key/label и12hint flags. Для
Deepgram используется существующий STT resolver с process/bot/shared/empty
приоритетами; остальные строки описывают только processenvpresence. Ошибка
чтения STT даёт безопасный unknown, не отказ текстового хода. Если сам perbot
файл optionalcustommetadata недоступен, knownrows сохраняются, customrows
заменяются постоянной нейтральной пометкой; UI/writer errors остаются прежними. Наличие значения
не обещает API/auth/backend работоспособность; универсального $NAME shell claim
нет. Внутренние PULT quicksettings исключены, ordinary service quickkeys
сохраняют custom путь. Globalcustom visibility и полный oldtool catalog отдельны.
[Контракт](../../tests/reference/parity-env-services-contract.txt),
[проверки](../../tests/env-services.test.mjs). [Контракт](../../tests/reference/parity-env-description-contract.txt),
[сквозной regression](../../tests/env-description.test.mjs).

[callback-key](callback-key.mjs) сохраняет literal short callbacks и сокращает
длинные доopaque ref длясуществующих delete/confirm. Тот жеcodec уscreen/routes;
resolve читает currentkeynames,безvalue/registry/migration. Unknown/ambiguousref
не меняет текущие экран/форму и не пишет.env. [Контракт](../../tests/reference/parity-env-callback-contract.txt),
[transport/restart/owner tests](../../tests/env-callbacks.test.mjs).

Имя в форме нормализуется как в old nF: trim/uppercase, удаление символов вне
A-Z/0-9/_, затем предел 2–40. Ошибка сохраняет шаг имени и начало TTL; protected
проверяется после нормализации. Writer допускает прежние `_A`/`1A`, запрещает
injection characters и не вводит UI-предел в API для существующих длинных keys.
[Контракт](../../tests/reference/parity-env-name-contract.txt),
[проверки формы/CLI](../../tests/env-name.test.mjs). Загрузка `1A` при рестарте
имеет отдельную границу EnvironmentFile; этот fix не добавляет dotenv loader.

Проверка raw value и нормализация общие для формы и writer:
[value.mjs](value.mjs) возвращает trimmed string до draft/IO; ошибки сохраняют
шаг ввода и исходный TTL. Прежние empty/control/4000/Telegram/vendor guards —
[контракт](../../tests/reference/parity-env-value-contract.txt),
[проверки](../../tests/env-value.test.mjs). Это проверка формы значения,
а не авторизация. Чтение существующих пустых overrides и отдельный delete
не меняются; optional Pult deletion/reload и stock auth используют свои маршруты.
