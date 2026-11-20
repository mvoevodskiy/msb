/**
 * Old RESCHEDULE_TASK in the [owner turn](./bot.mjs), after
 * [inspection](./task-inspection-markers.mjs) and before cancellation and pause.
 * [Schedule writer](../autonomy/saved-task-reschedule.mjs) and
 * [question](./task-reschedule-confirmation.mjs). [Checks](../../tests/task-reschedule.test.mjs).
 */
import { rescheduleTaskFromTurn } from '../autonomy/saved-task-reschedule.mjs';
import { legacyTimerMarker, outsideExamples, replaceAutonomyMarkers, reserveAutonomyMarkers, taskCancelMarker, taskMutationRanges, taskRescheduleMarker } from './autonomy-marker-text.mjs';
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
  const { payloads, quotes } = taskMutationRanges(text, [...text.matchAll(taskCancelMarker), ...text.matchAll(legacyTimerMarker)]);
  const blocks = outsideExamples(text, taskRescheduleMarker, [...payloads, ...quotes]);
  // Recognize original commands before neighboring results insert stored names.
  return reserveAutonomyMarkers(text, blocks, '[RESCHEDULE_TASK:');
}

export async function processTaskRescheduleMarkers(text, context, ctx, commands) {
  if (!commands) return text;
  const blocks = [...text.matchAll(taskRescheduleMarker)].filter(block => commands.has(block[0]));
  return replaceAutonomyMarkers(text, blocks, block => {
    context.signal?.throwIfAborted();
    return context.ownerId && context.ok ? reschedule(commands.get(block[0])[1], context, ctx) : { text: '(задача не обработана)' };
  }, { claim, correctBeforeEach: true, quoteGuard: /\x60/u });
}
