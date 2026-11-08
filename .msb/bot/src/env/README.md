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
