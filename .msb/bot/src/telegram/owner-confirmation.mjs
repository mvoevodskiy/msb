/**
 * Deliver a question, persist its message binding, then expose its buttons.
 * Used by [limits](./limit-confirmation.mjs) and [spent tasks](./task-removal-confirmation.mjs).
 * Retire the binding and clear the keyboard when publication fails.
 */
import { singleRequestSignal } from './presentation-api.mjs';

export const emptyOwnerKeyboard = { inline_keyboard: [] };

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(15_000);
  return singleRequestSignal(signal ? AbortSignal.any([signal, timeout]) : timeout);
}

export async function deliverOwnerQuestion(ctx, { text, keyboard, threadId, signal, save, discard }) {
  signal?.throwIfAborted();
  const sent = await ctx.reply(text, threadId && threadId !== 1 ? { message_thread_id: threadId } : {}, requestSignal(signal));
  if (!sent?.message_id) return false;
  const binding = { chatId: ctx.chat.id, messageId: sent.message_id };
  try {
    await save(binding);
    signal?.throwIfAborted();
    await ctx.api.editMessageReplyMarkup(binding.chatId, binding.messageId, { reply_markup: keyboard }, requestSignal(signal));
    signal?.throwIfAborted();
    return true;
  } catch (error) {
    await discard(binding).catch(() => {});
    await ctx.api.editMessageReplyMarkup(binding.chatId, binding.messageId, {
      reply_markup: emptyOwnerKeyboard,
    }, requestSignal()).catch(() => {});
    throw error;
  }
}
