/**
 * Главное меню.
 * Навигация: [Telegram](../README.md).
 */
import { InlineKeyboard } from 'grammy';
import { BLANK } from './shared.mjs';

export function hubKeyboard() {
  return new InlineKeyboard()
    .text('🆕 Новая сессия', 'menu:newtask')
    .text('📁 Проекты', 'menu:projects')
    .row()
    .text('💬 Сессии', 'menu:sessions')
    .text('🧩 Навыки', 'menu:skills')
    .row()
    .text('🧠 Агент', 'menu:agent')
    .text('🔌 MCP', 'menu:mcp')
    .row()
    .text('⚙️ Настройки', 'menu:settings')
    .text('🥷 Автономка', 'menu:autonomy');
}

export function hubScreen() {
  return {
    text: `Готов. Пиши задачу или выбери действие.\n${BLANK}`,
    keyboard: hubKeyboard(),
  };
}
