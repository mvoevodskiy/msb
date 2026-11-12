# Обвязка open-core

[← Проект](../README.md) · [Вход ядра](../.msb/bot/src/main.mjs) ·
[Провайдеры и integration](bot/ext/README.md) · [Release](../tools/release/README.md)

Опциональный слой добавляет Codex/Cursor/Qwen, local SSH constructor routes и
интеграцию меню. Чистое ядро может стартовать через `.msb/bot/index.js` без overlay.
Общий исходный профиль доступен через symlink `bot/shared`; отдельной копии resolver нет.

| Путь | Назначение |
|---|---|
| [bot/run.mjs](bot/run.mjs) | Profile preload → PATH-shim → integration prepare → установленный core index |
| [bot/ext](bot/ext/README.md) | Меню, auth, adapters, shim, integration |
| [bot/ext/local-ext](bot/ext/local-ext/README.md) | Локальные пакеты `<root>/local/ext/` вне релиза |
| [install.sh](install.sh) | Наложение overlay на установку; не JAR1 release transaction |
| [systemd drop-in](bot/systemd/60-ext-entry.conf) | Переключение entrypoint службы на `run.mjs` |
| [msb-updates](msb-updates/README.md) | Отдельный сервис публикации/установки |

JAR1 обновляется через [same-commit release pipeline](../tools/release/README.md),
который включает ядро, overlay и общий профиль. Для него не запускается bootstrap
и не меняется namespace данных. Откат — предыдущий release code backup.

Установочные аргументы отдельного overlay installer смотри в [install.sh](install.sh).
Удаление drop-in возвращает чистый open-core, но само по себе не является откатом
полного выпуска и не гарантирует работу выбранного CLI-провайдера.

Проверки из корня репозитория:

```sh
node --test overlay/bot/ext/tests/*.test.mjs
node --test overlay/bot/ext/tests/reference/*.test.mjs
```
