/**
 * Deliver a question, persist its message binding, then expose its buttons.
 * Used by [limits](./limit-confirmation.mjs), [task removal](./task-removal-confirmation.mjs)
 * and [rescheduling](./task-reschedule-confirmation.mjs).
 * Retire the binding and clear the keyboard when publication fails.
 */
import { escapeHtml } from './edit.mjs';
import { singleRequestSignal } from './presentation-api.mjs';
import { deliverView } from './view-delivery.mjs';

export const emptyOwnerKeyboard = { inline_keyboard: [] };

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(15_000);
  return singleRequestSignal(signal ? AbortSignal.any([signal, timeout]) : timeout);
}

export async function deliverOwnerQuestion(ctx, { text, keyboard, threadId, signal, save, discard, arm }) {
  signal?.throwIfAborted();
  const sent = await ctx.reply(text, threadId && threadId !== 1 ? { message_thread_id: threadId } : {}, requestSignal(signal));
  if (!sent?.message_id) return false;
  const binding = { chatId: ctx.chat.id, messageId: sent.message_id };
  const expose = async () => {
    signal?.throwIfAborted();
    await ctx.api.editMessageReplyMarkup(binding.chatId, binding.messageId, { reply_markup: keyboard }, requestSignal(signal));
    signal?.throwIfAborted();
  };
  try {
    if (arm) await arm(binding, expose);
    else {
      await save(binding);
      await expose();
    }
    return true;
  } catch (error) {
    await discard?.(binding).catch(() => {});
    await ctx.api.editMessageReplyMarkup(binding.chatId, binding.messageId, {
      reply_markup: emptyOwnerKeyboard,
    }, requestSignal()).catch(() => {});
    throw error;
  }
}

export async function closeOwnerQuestion(ctx, chatId, msgId, line) {
  const original = ctx.callbackQuery.message?.text || '';
  const text = escapeHtml([original, line].filter(Boolean).join('\n\n'));
  const threadId = ctx.callbackQuery.message?.message_thread_id;
  const topic = threadId && threadId !== 1 ? { message_thread_id: threadId } : {};
  const options = part => ({ parse_mode: 'HTML', reply_markup: part.keyboard });
  // This is the receipt for a settled write on a known message. Navigation
  // or a second tap must not cancel removal of that message's buttons.
  await deliverView({ text, keyboard: emptyOwnerKeyboard }, {
    edit: part => ctx.api.editMessageText(chatId, msgId, part.text, options(part), requestSignal()),
    reply: part => ctx.reply(part.text, { ...options(part), ...topic }, requestSignal()),
  }).catch(() => ctx.api.editMessageReplyMarkup(chatId, msgId,
    { reply_markup: emptyOwnerKeyboard }, requestSignal()).catch(() => {}));
}
