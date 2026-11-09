/**
 * The original buttons for the historical once group in [LIST_TASKS](./task-inspection-markers.mjs).
 * [Owner confirmation](./owner-confirmation.mjs) arms the delivered question; [router](./router.mjs)
 * resolves it through the [profile store](../autonomy/spent-task-cleanup.mjs).
 * The [direct marker](./spent-task-markers.mjs) shares the result text.
 */
import { InlineKeyboard } from 'grammy';
import { resolveSpentTaskQuestion, saveSpentTaskQuestion, SpentCleanupRefusal } from '../autonomy/spent-task-cleanup.mjs';
import { deliverOwnerQuestion, emptyOwnerKeyboard } from './owner-confirmation.mjs';
import { escapeHtml } from './edit.mjs';
import { singleRequestSignal } from './presentation-api.mjs';
import { deliverView } from './view-delivery.mjs';

const confirm = 'ct-spent';
const keep = 'ct-keep';
const plural = new Intl.PluralRules('ru');

export function isSpentTaskConfirmation(data) {
  return data === confirm;
}

export function askToClearSpentTasks(ctx, file, candidates, { ownerId, threadId, signal }) {
  const count = candidates.length;
  const word = { one: 'просроченную', few: 'просроченные', many: 'просроченных' }[plural.select(count)];
  return deliverOwnerQuestion(ctx, {
    text: 'Убрать из списка ' + count + ' ' + word + '? Они уже не сработают.',
    keyboard: new InlineKeyboard().text('Убрать ✖', confirm).text('Оставить', keep),
    threadId, signal,
    save: binding => saveSpentTaskQuestion({ ...binding, ownerId: Number(ownerId), file, candidates }, signal),
    discard: binding => resolveSpentTaskQuestion({ ...binding, ownerId: Number(ownerId) }, false),
  });
}

export function describeSpentTaskCleanup(result) {
  const { removed, failed, changed } = result;
  const lines = [];
  if (removed.length) lines.push('Снёс ' + removed.length + ', они уже не могли сработать:\n' +
    removed.map(name => '✖ ' + name).join('\n'));
  if (failed.length) lines.push('⚠ Не удалось снять: ' + failed.join(', ') + '.');
  if (changed) lines.push('Список изменился. Покажи задачи ещё раз.');
  if (!lines.length) lines.push('Сносить нечего — всё, что есть, ещё сработает.');
  const toast = changed && !removed.length && !failed.length ? 'Подтверждение устарело' :
    failed.length || changed ? 'Убрал не всё' : 'Убрал';
  return { toast, text: lines.join('\n\n') };
}

async function closeQuestion(ctx, chatId, msgId, line) {
  const original = ctx.callbackQuery.message?.text || '';
  const text = escapeHtml([original, line].filter(Boolean).join('\n\n'));
  const threadId = ctx.callbackQuery.message?.message_thread_id;
  const topic = threadId && threadId !== 1 ? { message_thread_id: threadId } : {};
  const options = part => ({ parse_mode: 'HTML', reply_markup: part.keyboard });
  const request = () => singleRequestSignal(AbortSignal.timeout(15_000));
  // This is the receipt for a settled write on a known message. Navigation
  // or a second tap must not cancel removal of that message's buttons.
  await deliverView({ text, keyboard: emptyOwnerKeyboard }, {
    edit: part => ctx.api.editMessageText(chatId, msgId, part.text, options(part), request()),
    reply: part => ctx.reply(part.text, { ...options(part), ...topic }, request()),
  }).catch(() => ctx.api.editMessageReplyMarkup(chatId, msgId,
    { reply_markup: emptyOwnerKeyboard }, request()).catch(() => {}));
}

export async function handleSpentTaskConfirmation({ cfg, ctx, data, chatId, msgId, answer }) {
  const remove = data === confirm;
  let result;
  try {
    result = await resolveSpentTaskQuestion({ chatId, messageId: msgId, ownerId: Number(cfg.adminId) }, remove);
  } catch (error) {
    if (!remove) return false;
    await answer({ text: error instanceof SpentCleanupRefusal ? error.message : 'Не смог убрать, попробуй ещё раз',
      show_alert: true });
    return true;
  }
  if (!result && !remove) return false;
  if (result?.keepFailed) await answer({ text: 'Не смог закрыть вопрос, попробуй ещё раз', show_alert: true });
  else if (!result) await answer({ text: 'Подтверждение устарело' });
  else {
    const { toast, text } = result.kept ? { toast: 'Оставил', text: '✔ Оставил на месте' } : describeSpentTaskCleanup(result);
    await answer({ text: toast });
    await closeQuestion(ctx, chatId, msgId, text);
  }
  return true;
}
