/**
 * Legacy timer question after a conversational [STOP_ALL](./pause-markers.mjs).
 * [Router](./router.mjs) accepts the original owner callbacks and delegates
 * writes to [owner pause](../autonomy/owner-pause.mjs) under the bot's lock.
 */
import { InlineKeyboard } from 'grammy';
import { answerTimerPauseQuestion, saveTimerPauseQuestion } from '../autonomy/owner-pause.mjs';
import { escapeHtml } from './edit.mjs';
import { singleRequestSignal } from './presentation-api.mjs';

export function isPauseConfirmation(data) {
  return data === 'tmr-stop' || data === 'ct-keep';
}

export async function askToPauseLegacyTimers(ctx, count, generation, { threadId, signal }) {
  const reply_markup = new InlineKeyboard()
    .text('⏹ Остановить и таймеры тоже', 'tmr-stop')
    .text('Оставить', 'ct-keep');
  const timeout = AbortSignal.timeout(15_000);
  const request = singleRequestSignal(signal ? AbortSignal.any([signal, timeout]) : timeout);
  const sent = await ctx.reply('Таймеры с прошлой настройки продолжают работать (' + count + '). Остановить их тоже?', {
    reply_markup, ...(threadId && threadId !== 1 ? { message_thread_id: threadId } : {}),
  }, request).catch(() => null);
  if (!sent?.message_id) return;
  const saved = await saveTimerPauseQuestion(generation, {
    chatId: ctx.chat.id, messageId: sent.message_id,
  }).catch(() => false);
  if (!saved) await ctx.api.editMessageReplyMarkup(ctx.chat.id, sent.message_id, {
    reply_markup: { inline_keyboard: [] },
  }, singleRequestSignal(AbortSignal.timeout(15_000))).catch(() => {});
}

export async function handlePauseConfirmation({ data, show, answer, ctx }) {
  const original = ctx.callbackQuery.message?.text || '';
  const finish = (toast, line) => {
    return answer({ text: toast }).then(() =>
      show({ text: [escapeHtml(original), line].filter(Boolean).join('\n\n'), keyboard: { inline_keyboard: [] } }));
  };
  const stop = data === 'tmr-stop';
  let count;
  try {
    count = await answerTimerPauseQuestion({
      chatId: ctx.chat.id, messageId: ctx.callbackQuery.message?.message_id,
    }, stop);
  } catch {
    return answer({ text: 'Не смог остановить, попробуй ещё раз', show_alert: true });
  }
  if (count === null) return finish('Подтверждение устарело', 'Этот вопрос уже закрыт.');
  if (!stop) return finish('Оставил', '✔ Оставил на месте');
  if (!count) return finish('Гасить нечего', 'Останавливать нечего: живых таймеров не осталось.');
  return finish('Остановил', 'Готово: таймеры тоже остановлены (' + count +
    '). Верну их вместе со всеми словом «верни всё в работу».');
}
