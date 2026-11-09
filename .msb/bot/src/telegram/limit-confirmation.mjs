/**
 * Old zero-limit question from [the final answer](./limit-markers.mjs).
 * [Limit control](../autonomy/limit-control.mjs) binds the message before its
 * buttons can be clicked. [Router](./router.mjs) leaves timer Keep on its own route.
 */
import { InlineKeyboard } from 'grammy';
import { LimitRouteRefusal, requireLocalLimitRoute, resolveLimitQuestion, saveLimitQuestion } from '../autonomy/limit-control.mjs';
import { limitDefinition } from '../autonomy/limit-protocol.mjs';
import { escapeHtml } from './edit.mjs';
import { singleRequestSignal } from './presentation-api.mjs';

const prefix = 'lim0:';
const keep = 'ct-keep';
const emptyKeyboard = { inline_keyboard: [] };

export function isLimitConfirmation(data) {
  return data.startsWith(prefix);
}

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(15_000);
  return singleRequestSignal(signal ? AbortSignal.any([signal, timeout]) : timeout);
}

export async function askToRemoveLimit(ctx, key, { rail, threadId, signal }) {
  const question = limitDefinition(key).question;
  signal?.throwIfAborted();
  const sent = await ctx.reply(question, threadId && threadId !== 1 ? { message_thread_id: threadId } : {}, requestSignal(signal));
  if (!sent?.message_id) return false;
  const binding = { chatId: ctx.chat.id, messageId: sent.message_id };
  const reply_markup = new InlineKeyboard().text('Снять предел', prefix + key).text('Оставить', keep);
  try {
    await requireLocalLimitRoute(rail);
    await saveLimitQuestion({ ...binding, key }, signal);
    signal?.throwIfAborted();
    await ctx.api.editMessageReplyMarkup(binding.chatId, binding.messageId, { reply_markup }, requestSignal(signal));
    signal?.throwIfAborted();
    return true;
  } catch (error) {
    await resolveLimitQuestion(binding).catch(() => {});
    await ctx.api.editMessageReplyMarkup(binding.chatId, binding.messageId, {
      reply_markup: emptyKeyboard,
    }, requestSignal()).catch(() => {});
    throw error;
  }
}

export async function handleLimitConfirmation({ data, chatId, msgId, answer, show }) {
  const key = data === keep ? undefined : data.slice(prefix.length);
  if (key !== undefined && !limitDefinition(key)) {
    await answer({ text: 'Не разобрал кнопку' });
    return true;
  }
  let question;
  try {
    question = await resolveLimitQuestion({ chatId, messageId: msgId }, key);
  } catch (error) {
    if (key === undefined) return false;
    const text = error instanceof LimitRouteRefusal ? error.message : 'Не смог снять предел, попробуй ещё раз';
    await answer({ text, show_alert: true });
    return true;
  }
  if (!question && key === undefined) return false;
  if (!question) await answer({ text: 'Подтверждение устарело' });
  else {
    const definition = limitDefinition(question.key);
    await answer({ text: key === undefined ? 'Оставил' : 'Снял' });
    await show({ text: escapeHtml(definition.question + '\n\n' + (key === undefined ? '✔ Оставил на месте' : definition.removed)),
      keyboard: emptyKeyboard });
  }
  return true;
}
