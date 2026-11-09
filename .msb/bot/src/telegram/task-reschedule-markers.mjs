/**
 * Old RESCHEDULE_TASK in the [owner turn](./bot.mjs), after
 * [inspection](./task-inspection-markers.mjs) and before cancellation and pause.
 * [Schedule writer](../autonomy/saved-task-reschedule.mjs) and
 * [question](./task-reschedule-confirmation.mjs). [Checks](../../tests/task-reschedule.test.mjs).
 */
import { randomUUID } from 'node:crypto';
import { rescheduleTaskFromTurn } from '../autonomy/saved-task-reschedule.mjs';
import { outsideExamples, replaceAutonomyMarkers, taskCancelMarker, taskMutationRanges, taskRescheduleMarker } from './autonomy-marker-text.mjs';
import { describeSavedTaskSchedule } from './screens/task-inspection.mjs';
import { askToRescheduleTask } from './task-reschedule-confirmation.mjs';

const claim = /^\s*(?:[✅✔]\uFE0F?\s*)?(?:(?:уже|я)\s+){0,2}(?:перен[её]с(?:л[аи])?|переставил[аи]?|готово)(?=$|[\s.,!])/iu;
const malformed = 'Не понял, что и на когда переносить — скажи ещё раз.';

async function reschedule(payload, context, ctx) {
  if (payload === undefined || /[\[\]]/.test(payload)) return { error: malformed };
  const pipe = payload.indexOf('|');
  if (pipe < 0) return { error: malformed };
  try {
    const result = await rescheduleTaskFromTurn(payload.slice(0, pipe), payload.slice(pipe + 1), context);
    if (result.error) return result;
    if (result.snapshot) {
      if (!await askToRescheduleTask(ctx, result, context)) return { error: 'Не удалось спросить подтверждение переноса.' };
      return { text: 'Спросил подтверждение ниже — перенесу по кнопке.', awaitingConfirmation: true };
    }
    const when = describeSavedTaskSchedule(result.action, context.now, result.timezone);
    return { text: 'Перенёс: «' + result.action.name + '» — теперь ' + when + '.' };
  } catch {
    context.signal?.throwIfAborted();
    return { error: 'Не удалось перенести задачу.' };
  }
}

export function prepareTaskRescheduleMarkers(text) {
  if (typeof text !== 'string' || !text.includes('[RESCHEDULE_TASK:')) return { text };
  const { payloads, quotes } = taskMutationRanges(text, [...text.matchAll(taskCancelMarker)]);
  const blocks = outsideExamples(text, taskRescheduleMarker, [...payloads, ...quotes]);
  if (!blocks.length) return { text };

  // Keep positions across earlier replacements without parsing quotes again
  // after they render stored names. Only original commands receive a token.
  const nonce = randomUUID();
  const commands = new Map();
  const parts = [];
  let offset = 0;
  for (const block of blocks) {
    const token = '[RESCHEDULE_TASK:' + nonce + '-' + commands.size + ']';
    commands.set(token, block[1]);
    parts.push(text.slice(offset, block.index), token);
    offset = block.index + block[0].length;
  }
  return { text: parts.join('') + text.slice(offset), commands };
}

export async function processTaskRescheduleMarkers(text, context, ctx, commands) {
  if (!commands) return text;
  const blocks = [...text.matchAll(taskRescheduleMarker)].filter(block => commands.has(block[0]));
  return replaceAutonomyMarkers(text, blocks, block => {
    context.signal?.throwIfAborted();
    return context.ownerId && context.ok ? reschedule(commands.get(block[0]), context, ctx) : { text: '(задача не обработана)' };
  }, { claim, correctBeforeEach: true, quoteGuard: /\x60/u });
}
