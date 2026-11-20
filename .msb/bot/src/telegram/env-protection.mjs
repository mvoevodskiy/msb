/**
 * Old env refusal view shared by custom/quick/stale-value input.
 * Callers clear their pending before delivery; no storage or auth side effects.
 * [Forms](./forms/env.mjs), [callbacks](./routes/settings.mjs),
 * [store boundary](../env/store.mjs), [tests](../../tests/env-protected.test.mjs).
 */
import { InlineKeyboard } from 'grammy';
import { PROTECTED_KEYS } from '../env/store.mjs';
import { escapeHtml } from './edit.mjs';

export function protectedEnvNotice(key) {
  if (!PROTECTED_KEYS.has(key)) return null;
  if (key === 'BOT_TOKEN') return {
    text: '⛔ <code>BOT_TOKEN</code> — токен Джарвиса. Изменение убьёт бота.\n\nДля нового бота добавь ключ с другим именем:',
    keyboard: new InlineKeyboard().text('➕ Добавить TELEGRAM_BOT_2', 'settings:env:quick:TELEGRAM_BOT_2'),
  };
  const text = ['ANTHROPIC_API_KEY', 'MSB_ANTHROPIC_API_KEY', 'IIA_ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(key)
    ? `⛔ <code>${escapeHtml(key)}</code> — системный ключ.\n\nДля смены ключа Claude: /settings → 🔌 Подключение.`
    : `⛔ <code>${escapeHtml(key)}</code> — системный ключ, управляется автоматически.`;
  return { text };
}
