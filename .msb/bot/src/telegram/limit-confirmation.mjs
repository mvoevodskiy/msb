/**
 * Old zero-limit question from [the final answer](./limit-markers.mjs).
 * [Limit control](../autonomy/limit-control.mjs) binds the message before its
 * buttons can be clicked. [Router](./router.mjs) leaves timer Keep on its own route.
 */
import { InlineKeyboard } from 'grammy';
import { LimitRouteRefusal, requireLocalLimitRoute, resolveLimitQuestion, saveLimitQuestion } from '../autonomy/limit-control.mjs';
import { limitDefinition } from '../autonomy/limit-protocol.mjs';
import { escapeHtml } from './edit.mjs';
import { deliverOwnerQuestion, emptyOwnerKeyboard } from './owner-confirmation.mjs';

const prefix = 'lim0:';
const keep = 'ct-keep';

export function isLimitConfirmation(data) {
  return data.startsWith(prefix);
}

export function askToRemoveLimit(ctx, key, { rail, threadId, signal }) {
  return deliverOwnerQuestion(ctx, {
    text: limitDefinition(key).question,
    keyboard: new InlineKeyboard().text('Снять предел', prefix + key).text('Оставить', keep),
    threadId, signal,
    async save(binding) {
      await requireLocalLimitRoute(rail);
      await saveLimitQuestion({ ...binding, key }, signal);
    },
    discard: resolveLimitQuestion,
  });
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
      keyboard: emptyOwnerKeyboard });
  }
  return true;
}
