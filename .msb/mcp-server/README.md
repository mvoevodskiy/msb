# MCP: данные ботов → внешние инструменты

[← Ядро](../bot/src/main.mjs) · [Профиль](../bot/shared/README.md) · [Проекты](../bot/src/projects/README.md)

stdio MCP-сервер отдаёт внешним клиентам (Cursor и др.) данные всех ботов
текущего runtime-профиля и позволяет читать/писать общий workspace и проекты.
Это отдельный bridge для IDE, не Telegram ADD_MCP и не подключение MCP внутрь CLI.

## Что доступно

| Инструмент | Назначение |
|---|---|
| `bots_overview` / `list_bots` | Все боты `…/bots/*` |
| `get_bot_state` | `state.json` без секретов |
| `list_sessions` | `sessionHistory` (описания/ID) |
| `read_diary` / `read_transcript_day` | Журналы бота (preview) |
| `list_projects` | Проекты + activeProject |
| `list_files` / `read_file` | Файлы workspace или проекта |
| `write_file` / `mkdir` / `create_project` | Действия в workspace/projects |

Не отдаётся: `.env`, ключи, значения секретов, native transcripts Claude/Codex.

## Запуск

```bash
node .msb/mcp-server/index.mjs
```

Переменные (как у бота):

- `HOME` / `MSB_RUNTIME_ROOT` / `MSB_RUNTIME_PROFILE` (`msb` \| `jar1`)
- `MSB_WORKSPACE_DIR` — корень workspace (иначе `cwd`)

## Cursor

В `~/.cursor/mcp.json` (или project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "msb-bots": {
      "command": "node",
      "args": ["/ABS/PATH/TO/msb/.msb/mcp-server/index.mjs"],
      "env": {
        "HOME": "/home/YOU",
        "MSB_RUNTIME_PROFILE": "msb",
        "MSB_WORKSPACE_DIR": "/ABS/PATH/TO/workspace"
      }
    }
  }
}
```

Для JAR1: `MSB_RUNTIME_PROFILE=jar1` (корни `.iia`).

## Проверки

```bash
node --test .msb/mcp-server/tests/*.test.mjs
```

Откат: удалить `.msb/mcp-server` и запись в `mcp.json`. Поведение Telegram-ботов не меняется.
