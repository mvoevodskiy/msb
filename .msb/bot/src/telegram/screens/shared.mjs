/**
 * Общее оформление и экран для неподключённых разделов.
 * Навигация: [Telegram](../README.md).
 */
import { InlineKeyboard } from 'grammy';
import { savedSpendLimit } from '../../billing/owner-spend.mjs';
import { escapeHtml } from '../edit.mjs';
export const BLANK = '⠀';

/** Describe the saved value without inventing a default. */
export function describeSpendLimit(value) {
  const n = savedSpendLimit(value);
  if (n === undefined) return 'не задан';
  return n > 0 ? `$${n}/день` : 'без ограничений';
}

export function placeholder(title, back, message = 'Этот раздел пока не реализован в Telegram. Настройки не изменены.') {
  return {
    text: `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(message)}\n${BLANK}`,
    keyboard: new InlineKeyboard().text('« Назад', back),
  };
}
