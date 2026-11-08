# Open-core Telegram-агент

[Вход ядра](.msb/bot/src/main.mjs) ·
[Границы реализации](.msb/bot/OPEN-CORE.md) · [Сборка и выпуск](tools/release/README.md)

Ветка **`open-core`**: одна исходная база для ядра и CLI-обвязки. Закрытый бандл снят.
Профили `msb` и `jar1` используют один код; отдельная копия исходников под `.iia`
не поддерживается.

## Слои и входы

| Слой | Исходники | Вход / карта |
|---|---|---|
| Открытое ядро | `.msb/bot/src` | [index.js](.msb/bot/index.js) → [main](.msb/bot/src/main.mjs) → [Telegram](.msb/bot/src/telegram/README.md) |
| CLI-провайдеры | `overlay/bot/ext` | [run.mjs](overlay/bot/run.mjs) → [интеграция](overlay/bot/ext/README.md#интеграция-telegram) → то же ядро |
| Runtime-профиль | `.msb/bot/shared` | [Пути, env aliases и режим OS-движков](.msb/bot/shared/README.md) |
| Выпуск | `tools/release` | [Один commit: код, тесты и инструменты](tools/release/README.md) |
| Старый vendor | `.msb/bot/vendor` | [Эталон пользовательского поведения](.msb/bot/vendor/README.md) |
| Пульт | `.msb/pult` | Веб-панель (в коробке, выкл); sync: `./scripts/sync-pult.sh` |

Чистое ядро использует Claude CLI. Обвязка добавляет Codex/Cursor/Qwen через
PATH-shim и совместимый stream-json. Codex — выбор CLI-провайдера; OS helper
`msb-engine` управляет отдельными сервисами и имеет другой маршрут.

## Исходники и установленный код

`msb` по умолчанию использует `~/.msb`, `MSB_*` и native OS-engine routes.
`jar1` сохраняет `~/.iia`, совместимость `IIA_*`, прежние service/data paths и
legacy engine UI без OS-миграции. Правила выбора — в [shared profile](.msb/bot/shared/README.md).
Native auth, конфигурация владельца, сессии и workspace не входят в тиражируемый код.

[Release pipeline](tools/release/README.md) экспортирует код, проверки и инструменты
из одного commit. Поддерживаемый откат — восстановление предыдущего набора кода
из release backup с сохранением текущих данных владельца. Vendor bundle не входит
в runtime выпуска и не используется как путь отката.

## Установка и эксплуатация

- [Bootstrap](bootstrap/README.md) и [overlay installer](overlay/README.md) описывают
  установку; это отдельная область от обновления уже работающего JAR1.
- [Политика обновлений](bootstrap/UPDATE-POLICY.md): код обновляется отдельно от
  `.env`, workspace, auth и пользовательского состояния.
- [Reference-проверки](.msb/bot/tests/reference/README.md) связывают старый UX с
  настоящими обработчиками нового ядра и показывают границы тестирования.

```bash
sudo ./bootstrap/install.sh ... --with-ext
# или позже:
sudo ./overlay/install.sh --source "$PWD"
```

Drop-in `60-ext-entry.conf` переключает `ExecStart` на `run.mjs`. Удаление drop-in возвращает чистое ядро.

## Пульт (в коробке, выкл)

Код: `.msb/pult/` (канон — `msb-pult`, sync: `./scripts/sync-pult.sh`).
Юниты `pult-web` / `pult-collector` ставятся, но не стартуют.
Включение: `/settings` → Системные → Пульт (нужен `PULT_PASSWORD` в переменных окружения бота).

## Что не входит

- Продуктовые проекты и секреты владельца
- Боевой `workspace/`, дневники чатов, skeleton’ы живых ботов
- OpenClaw / R2-backup (отдельные опции платформы)
- Секреты Пульта в чистом bootstrap env (`PULT_*` — только после включения владельцем)

Полная эквивалентность старому ядру не заявлена: [неперенесённые сценарии](.msb/bot/OPEN-CORE.md#границы-реализации)
остаются явными. Каждый единый выпуск требует зафиксированного commit, проверки
артефакта и отдельной выкладки; локальный PASS не является живой Telegram-приёмкой.
