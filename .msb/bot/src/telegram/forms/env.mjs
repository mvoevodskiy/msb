/**
 * Имя и значение env; не выдаёт сохранение за проверку сервиса.
 * Вход: [form dispatcher](../forms.mjs); pending и lifecycle принадлежат createBot.
 * [Контракт](../../../tests/reference/parity-forms-contract.txt),
 * [handler tests](../../../tests/menu-handlers.test.mjs).
 */
import { escapeHtml } from '../edit.mjs';

export async function handleEnvValueInput({ kind, ctx, text, pending, chatId }) {
  const key = kind.slice(4);
  const { setEnvKey } = await import('../../env/store.mjs');
  try { await setEnvKey(key, text.trim()); }
  catch (err) { await ctx.reply(`Не сохранил: ${err.message}`); return; }
  pending.delete(chatId);
  await ctx.reply(`Сохранил <code>${escapeHtml(key)}</code> в .env бота. Это не проверка подключения сервиса. Для параметров запуска нужен перезапуск бота.`, { parse_mode: 'HTML' });
  return;
}

export async function handleEnvNameInput({ ctx, text, pending, chatId }) {
  const key = text.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    await ctx.reply('Имя ключа: только A-Z, цифры и _.');
    return;
  }
  pending.set(chatId, `env:${key}`);
  await ctx.reply(`Ок. Пришли значение для <code>${key}</code>.`, { parse_mode: 'HTML' });
  return;
}
