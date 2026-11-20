/**
 * Old tmr-del and Keep buttons for a [conversational delete](./legacy-timer-markers.mjs).
 * [Owner transport](./owner-confirmation.mjs) binds the card before publishing.
 * [Store](../autonomy/legacy-timer-delete.mjs) consumes its permission.
 * [Callback checks](../../tests/legacy-timer-conversation.test.mjs).
 */
import { InlineKeyboard } from 'grammy';
import { nameReference } from '../../shared/callback-ref.mjs';
import { saveLegacyTimerDeletion, settleLegacyTimerDeletion } from '../autonomy/legacy-timer-delete.mjs';
import { closeOwnerQuestion, deliverOwnerQuestion } from './owner-confirmation.mjs';
import { describeLegacyTimerDeletion } from './screens/legacy-timers.mjs';

const prefix = 'tmr-del:';
const keep = 'ct-keep';

export function isLegacyTimerConfirmation(data) {
  return data.startsWith(prefix);
}

export function askToDeleteLegacyTimer(ctx, { timer, snapshot }, { ownerId, threadId, signal }) {
  const callback = prefix + nameReference(timer.id, { marker: 't~', actionPrefix: prefix });
  const owner = Number(ownerId);
  return deliverOwnerQuestion(ctx, {
    text: describeLegacyTimerDeletion(timer),
    keyboard: new InlineKeyboard().text('Удалить ✖', callback).text('Оставить', keep),
    threadId, signal,
    save: binding => saveLegacyTimerDeletion({ ...binding, ...snapshot, ownerId: owner, callback }, { signal }),
    discard: binding => settleLegacyTimerDeletion({ ...binding, ownerId: owner }),
  });
}

export async function handleLegacyTimerConfirmation({ cfg, ctx, data, chatId, msgId, answer }) {
  const keepClicked = data === keep;
  let result;
  try {
    result = await settleLegacyTimerDeletion({ chatId, messageId: msgId, ownerId: Number(cfg.adminId) }, data);
  } catch {
    if (keepClicked) return false;
    await answer({ text: 'Не смог удалить, попробуй ещё раз', show_alert: true });
    return true;
  }
  if (!result && keepClicked) return false;
  if (result?.keepFailed) await answer({ text: 'Не смог закрыть вопрос, попробуй ещё раз', show_alert: true });
  else if (!result || result.stale) {
    await answer({ text: 'Подтверждение устарело' });
    if (result?.stale) await closeOwnerQuestion(ctx, chatId, msgId, 'Подтверждение устарело.');
  } else if (result.missing) await answer({ text: 'Этого таймера уже нет' });
  else if (result.kept) {
    await answer({ text: 'Оставил' });
    await closeOwnerQuestion(ctx, chatId, msgId, '✔ Оставил на месте');
  } else {
    await answer({ text: 'Удалил' });
    await closeOwnerQuestion(ctx, chatId, msgId, 'Готово: таймер «' + result.timer.name + '» удалён.');
  }
  return true;
}
