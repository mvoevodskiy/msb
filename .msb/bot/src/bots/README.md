# Мои боты

[← Вход ядра](../main.mjs) · [Telegram](../telegram/README.md#callback-маршруты)

[manage.mjs](manage.mjs) — локальный адаптер к `sudo bot-ctl.sh`.
Работает с `<profile.root>/bots`; список, добавление и удаление имеют реальные
операционные эффекты и не являются только изменением клавиатуры.

| Задача | Маршрут |
|---|---|
| Список и статус | [botsScreen](../telegram/screens/bots.mjs) → `listBots` |
| Карточка / удаление | [handleBotsRoute](../telegram/routes/bots.mjs) → `botDetailScreen` / `removeBot` |
| Новый экземпляр | `settings:bots:add` → pending `bot-token` → [message:text](../telegram/bot.mjs) → `addBot` |

`addBot` передаёт временный env-файл штатному ctl; `removeBot` запрещает удалять
`default` и текущий бот. Overlay имеет отдельный совместимый constructor-маршрут:
[local-ssh](../../../../overlay/bot/ext/README.md#локальный-ssh-и-управление-ботами).

[menu-handlers](../../tests/menu-handlers.test.mjs) проверяет маршруты меню;
[overlay local-ssh tests](../../../../overlay/bot/ext/tests/local-ssh.test.mjs) — свой backend с подставленным executor.
Это не приёмка установки реального дополнительного бота через systemd.
