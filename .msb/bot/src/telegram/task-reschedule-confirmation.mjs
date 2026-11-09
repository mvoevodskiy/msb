/**
 * Old before/after card for [RESCHEDULE_TASK](./task-reschedule-markers.mjs).
 * [Owner transport](./owner-confirmation.mjs) binds it before displaying buttons.
 * [Router](./router.mjs) resolves through the [question store](../autonomy/task-reschedule-questions.mjs).
 * [Checks](../../tests/task-reschedule.test.mjs).
 */
import { InlineKeyboard } from 'grammy';
import { nameReference } from '../../shared/callback-ref.mjs';
import { armTaskRescheduleQuestion, resolveTaskRescheduleQuestion } from '../autonomy/task-reschedule-questions.mjs';
import { closeOwnerQuestion, deliverOwnerQuestion } from './owner-confirmation.mjs';
import { describeSavedTaskSchedule } from './screens/task-inspection.mjs';

const prefix = 'rs:';
const keep = 'ct-keep';

export function isTaskRescheduleConfirmation(data) {
  return data.startsWith(prefix);
}

export function askToRescheduleTask(ctx, { action, next, timezone, snapshot }, { ownerId, rail, now, threadId, signal }) {
  const callback = prefix + nameReference(action.id, { marker: 'a~', actionPrefix: prefix });
  const owner = Number(ownerId);
  const before = describeSavedTaskSchedule(action, now, timezone);
  const after = describeSavedTaskSchedule(next, now, timezone);
  return deliverOwnerQuestion(ctx, {
    text: 'Перенести фоновую задачу «' + action.name + '»?\nБыло: ' + before + '\nСтанет: ' + after,
    keyboard: new InlineKeyboard().text('Перенести ⏱', callback).text('Оставить', keep),
    threadId, signal,
    arm: (binding, expose) => armTaskRescheduleQuestion(
      { ...binding, ...snapshot, ownerId: owner, callback, rail }, expose, { signal },
    ),
  });
}

export async function handleTaskRescheduleConfirmation({ cfg, ctx, data, chatId, msgId, answer, now }) {
  const keepClicked = data === keep;
  let result;
  try {
    result = await resolveTaskRescheduleQuestion({ chatId, messageId: msgId, ownerId: Number(cfg.adminId) }, data,
      { timezone: cfg.timezone });
  } catch {
    if (keepClicked) return false;
    await answer({ text: 'Не смог перенести, попробуй ещё раз', show_alert: true });
    return true;
  }
  if (!result && keepClicked) return false;
  if (result?.keepFailed) {
    await answer({ text: 'Не смог закрыть вопрос, попробуй ещё раз', show_alert: true });
  } else if (result?.error) {
    await answer({ text: result.error, show_alert: true });
  } else if (!result || result.stale) {
    await answer({ text: 'Подтверждение устарело' });
    if (result?.stale) await closeOwnerQuestion(ctx, chatId, msgId, 'Подтверждение устарело.');
  } else if (result.kept) {
    await answer({ text: 'Оставил' });
    await closeOwnerQuestion(ctx, chatId, msgId, '✔ Оставил на месте');
  } else {
    await answer({ text: 'Перенёс' });
    const when = describeSavedTaskSchedule(result.action, now(), result.timezone);
    await closeOwnerQuestion(ctx, chatId, msgId, '⏱ Перенёс «' + result.action.name + '» — теперь ' + when + '.');
  }
  return true;
}
