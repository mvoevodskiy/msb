/**
 * Прежние MCP views; навыки вынесены в [skills](./skills.mjs).
 * Навигация: [Telegram](../README.md).
 */
import { InlineKeyboard } from 'grammy';
import { BLANK } from './shared.mjs';

export function mcpScreen() {
  return {
    text: `🔌 <b>MCP серверы</b>

Внешние сервисы — транскрипты, скрейпинг, базы данных и другие инструменты.
${BLANK}`,
    keyboard: new InlineKeyboard()
      .text('📁 workspace', 'mcp:folder:workspace')
      .row()
      .text('« Назад', 'menu:back'),
  };
}

export function mcpWorkspaceScreen() {
  return {
    text: `<b>📁 workspace</b>

Доступны агенту во всех проектах.

<i>Список native MCP пока не читается этим экраном.</i>
${BLANK}`,
    keyboard: new InlineKeyboard()
      .text('➕ Добавить', 'mcp:add')
      .row()
      .text('« Назад', 'menu:mcp'),
  };
}

export function mcpAddScreen() {
  return {
    text: `<b>➕ MCP сервер</b>

Прежние пункты настройки. Их установка в open-core пока не подключена.
${BLANK}`,
    keyboard: new InlineKeyboard()
      .text('Supadata', 'mcp:setup:supadata')
      .text('Apify', 'mcp:setup:apify')
      .row()
      .text('« Назад', 'mcp:folder:workspace'),
  };
}
