/**
 * Список и карточка бота.
 * Навигация: [Telegram](../README.md).
 */
import { InlineKeyboard } from 'grammy';
import { listBots } from '../../bots/manage.mjs';
import { escapeHtml } from '../edit.mjs';
import { BLANK } from './shared.mjs';

export async function botsScreen() {
  const bots = await listBots();
  const lines = [
    '<b>🤖 Мои боты</b>',
    '',
    'Несколько ботов на одном сервере: у каждого свой чат, свои настройки и характер.',
    '',
  ];
  for (const b of bots) {
    const mark = b.active === true ? '🟢' : b.active === false ? '🔴' : '⚪';
    lines.push(`${mark} <b>${escapeHtml(b.botId)}</b>${b.here ? ' — ты здесь' : ''}`);
  }
  lines.push(BLANK);
  const kb = new InlineKeyboard();
  for (const b of bots) {
    kb.text(b.botId, `settings:bots:bot:${b.botId}`).row();
  }
  kb.text('+ Добавить бота', 'settings:bots:add').row();
  kb.text('🔄 Обновить', 'settings:bots:refresh').row();
  kb.text('« Назад', 'settings:back');
  return { text: lines.join('\n'), keyboard: kb };
}

export async function botDetailScreen(botId) {
  const bots = await listBots();
  const b = bots.find((x) => x.botId === botId);
  const kb = new InlineKeyboard();
  if (!b) {
    return {
      text: `<b>🤖 ${escapeHtml(botId)}</b>\n\nБот не найден на диске.`,
      keyboard: new InlineKeyboard().text('« Назад', 'settings:bots'),
    };
  }
  if (b.botId === 'default' || b.here) {
    kb.text('« Назад', 'settings:bots');
    return {
      text: `<b>🤖 ${escapeHtml(b.botId)}</b>\n\n${
        b.here ? 'Это текущий бот.' : 'Основной бот — его удалить нельзя.'
      }\nСтатус: ${b.active ? 'active' : 'stopped/unknown'}`,
      keyboard: kb,
    };
  }
  kb.text('🗑 Удалить', `settings:bots:delete:${b.botId}`).row();
  kb.text('« Назад', 'settings:bots');
  return {
    text: `<b>🤖 ${escapeHtml(b.botId)}</b>\n\nСтатус: ${
      b.active ? 'active' : 'stopped/unknown'
    }\nМожно удалить, если больше не нужен.`,
    keyboard: kb,
  };
}
