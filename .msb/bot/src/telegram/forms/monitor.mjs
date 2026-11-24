/**
 * Old ambiguous @handle input/choice; [dispatcher](../forms.mjs) accepts input,
 * [route](../routes/monitor.mjs) accepts selection, [store](../../monitor/config.mjs)
 * writes only after a type is known. [Checks](../../../tests/monitor-source-choice.test.mjs).
 * Input and choice are scoped to their originating message within the chat.
 * /start or the matching Cancel clears the form.
 */
import { InlineKeyboard } from 'grammy';
import { addSourceFromInput, classifySourceInput } from '../../monitor/config.mjs';

const CHOICE = 'mon-source-choice';
export function cancelMonitorSourceInput({ pending, chatId, msgId }) {
  const kind = pending.get(chatId);
  if (kind !== 'mon-source' && kind !== CHOICE) return;
  const draft = pending.payload(chatId);
  if (Number.isSafeInteger(msgId) && draft?.messageId === msgId) pending.delete(chatId);
}
const back = () => new InlineKeyboard().text('« Назад', 'mon:sources');
const again = () => new InlineKeyboard().text('➕ Ещё источник', 'mon:add-hint').text('« К источникам', 'mon:sources');

export async function handleMonitorSourceInput({ ctx, text, pending, chatId }) {
  const parsed = classifySourceInput(text);
  if (parsed?.type === 'ambiguous') {
    const draft = { value: parsed.name, messageId: null };
    pending.advance(chatId, CHOICE, draft);
    try {
      const message = await ctx.reply('Не понял, что это: у Telegram и Twitter ник выглядит одинаково.\n' + draft.value, {
        reply_markup: new InlineKeyboard().text('Telegram', 'mon:add:as:telegram')
          .text('Twitter', 'mon:add:as:twitter').row().text('Отмена', 'mon:add:cancel'),
      });
      if (pending.payload(chatId) === draft) draft.messageId = message?.message_id;
    } catch (error) {
      if (pending.payload(chatId) === draft) pending.delete(chatId);
      throw error;
    }
    return;
  }
  pending.delete(chatId);
  const result = await addSourceFromInput(text);
  if (!result.ok) return ctx.reply(result.error);
  if (['twitter', 'github', 'youtube'].includes(result.type) && result.reason === 're-enabled') {
    const title = { twitter: 'Twitter', github: 'GitHub', youtube: 'YouTube' }[result.type];
    return ctx.reply(`✅ ${title}: ${result.name} (re-enabled)`, { reply_markup: again() });
  }
  return ctx.reply(result.added
    ? `✔ Источник <b>${result.type}</b>: ${result.name}`
    : `Уже был: <b>${result.type}</b> ${result.name}`, { parse_mode: 'HTML' });
}

export async function handleMonitorSourceChoice({ data, pending, chatId, ctx, msgId, show }) {
  const draft = pending.payload(chatId);
  if (pending.get(chatId) !== CHOICE || !draft || !Number.isSafeInteger(msgId) || draft.messageId !== msgId) {
    return show({ text: 'Уже неактуально: пришли ссылку заново через «+ Добавить источник».', keyboard: back() });
  }
  const type = data.slice('mon:add:as:'.length);
  pending.delete(chatId);
  try {
    const result = await addSourceFromInput(draft.value, process.env, { type });
    if (!result.ok) return ctx.reply(result.error || 'Не получилось добавить источник.', { reply_markup: again() });
    const title = type === 'telegram' ? 'Telegram' : 'Twitter';
    const restored = result.reason === 're-enabled' ? ' (re-enabled)' : '';
    return ctx.reply(result.added ? `✅ ${title}: ${result.name}${restored}` : `⏭ ${title}: ${result.name} (уже добавлен)`, { reply_markup: again() });
  } catch (error) {
    return ctx.reply(`Не получилось добавить: ${String(error?.message || error).slice(0, 160)}`, { reply_markup: again() });
  }
}
