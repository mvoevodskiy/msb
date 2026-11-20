/**
 * Old CANCEL_SPENT and CANCEL_ALL before [inspection](./task-inspection-markers.mjs) and
 * CANCEL_TASK after it, both before [individual pause](./task-control-markers.mjs).
 * [Task removal](../autonomy/task-removal.mjs) shares the writer with the
 * [confirmation](./task-removal-confirmation.mjs). [Ingress](../../tests/named-task-cancellation.test.mjs).
 */
import { cancelNamedTaskFromTurn, cleanupSpentTasksFromTurn, planAllTasksFromTurn, TaskRemovalRefusal } from '../autonomy/task-removal.mjs';
import { savedTaskTimezone } from '../autonomy/saved-task-inspection.mjs';
import { loadState } from '../state.mjs';
import { outsideExamples, outsideRanges, replaceAutonomyMarkers, taskCancelMarker, taskMutationRanges } from './autonomy-marker-text.mjs';
import { describeSavedTaskSchedule } from './screens/task-inspection.mjs';
import { askToCancelAllTasks, askToCancelSavedTask, describeSpentTaskCleanup } from './task-removal-confirmation.mjs';

const groupRemovalMarker = /\[(CANCEL_SPENT|CANCEL_ALL)\]/g;
const spentClaim = /(?:^|\s)(?:убрал[аи]?|сн[её]с(?:л[аи])?|удалил[аи]?|готово)(?=$|[\s.,!])/iu;
const namedClaim = /^\s*(?:[✅✔]\uFE0F?\s*)?(?:(?:уже|я)\s+){0,2}(?:отменил[аи]?|сн[её]с(?:л[аи])?|удалил[аи]?|убрал[аи]?|готово)(?=$|[\s.,!])/iu;

function hasEmptySuffix(text, block) {
  const suffix = text.slice(block.index + block[0].length).split('\n', 1)[0];
  return !suffix.replace(/<\/code>|\x60|»|"|'/g, '').trim();
}

async function applyGroupRemoval(type, context, ctx) {
  context.signal?.throwIfAborted();
  if (!context.ownerId || !context.ok) return { text: '(задача не обработана)' };
  const spent = type === 'CANCEL_SPENT';
  const noQuestion = 'Снос всех задач подтверждается кнопкой, а спросить сейчас не получилось. Могу снести по одной: скажи, какую убрать.';
  try {
    if (spent) {
      const result = await cleanupSpentTasksFromTurn(context);
      return { text: describeSpentTaskCleanup(result).text };
    }
    const result = await planAllTasksFromTurn(context);
    if (!result.names.length) return { text: 'Сносить нечего: фоновых задач нет.' };
    if (!await askToCancelAllTasks(ctx, result, context)) return { error: noQuestion };
    return { text: 'Спросил подтверждение ниже, снесу все по кнопке.', awaitingConfirmation: true };
  } catch (error) {
    context.signal?.throwIfAborted();
    if (error instanceof TaskRemovalRefusal) return { error: error.message };
    return { error: spent ? 'Не удалось убрать просроченные.' : noQuestion };
  }
}

export async function processGroupTaskRemovalMarkers(text, context, ctx) {
  if (typeof text !== 'string' || !/\[CANCEL_(?:SPENT|ALL)\]/.test(text)) return text;
  const { payloads, quotes } = taskMutationRanges(text, [...text.matchAll(taskCancelMarker)]);
  const commands = outsideExamples(text, groupRemovalMarker, [...payloads, ...quotes])
    .filter(block => hasEmptySuffix(text, block));
  const results = new Map();
  // Run cleanup before taking the snapshot. Parse both commands before
  // rendering stored task names, which may contain quote delimiters.
  for (const type of ['CANCEL_SPENT', 'CANCEL_ALL']) {
    for (const block of commands.filter(item => item[1] === type)) {
      results.set(block.index, await applyGroupRemoval(type, context, ctx));
    }
  }
  // Remove quoted or explanatory mentions while preserving other payloads.
  return replaceAutonomyMarkers(text, outsideRanges(text, groupRemovalMarker, payloads),
    block => results.get(block.index) ?? { text: '' }, { claim: spentClaim, correctBeforeEach: true });
}

function unavailable(name) {
  return { error: 'Не удалось отменить «' + name + '»: локальное удаление недоступно.' };
}

async function cancelTask(query, context, ctx) {
  const result = await cancelNamedTaskFromTurn(query, context);
  if (result.error) return { error: result.error };
  if (result.unavailable !== undefined) return unavailable(result.unavailable);
  if (result.choices || result.snapshot) {
    const { state } = await loadState();
    const zone = state.timezone || context.timezone;
    const schedule = action => describeSavedTaskSchedule(action, context.now, savedTaskTimezone(action, zone));
    if (result.choices) return { error: 'Нашёл несколько — скажи, какую именно:\n' +
      result.choices.map(action => '• ' + action.name + ' — ' + schedule(action)).join('\n') };
    if (!await askToCancelSavedTask(ctx, result, schedule(result.action), context)) {
      return { error: 'Не удалось спросить подтверждение.' };
    }
    return { text: 'Спросил подтверждение ниже — снесу по кнопке.', awaitingConfirmation: true };
  }
  if (result.group) return { text: describeSpentTaskCleanup(result).text };
  if (!result.removed.length) return unavailable(result.action.name);
  return { text: 'Отменил: «' + result.removed[0] + '».' };
}

export async function processTaskCancelMarkers(text, context, ctx) {
  if (typeof text !== 'string' || !text.includes('[CANCEL_TASK:')) return text;
  const { payloads, quotes } = taskMutationRanges(text);
  const blocks = outsideExamples(text, taskCancelMarker, [...payloads, ...quotes]);
  return replaceAutonomyMarkers(text, blocks, async block => {
    context.signal?.throwIfAborted();
    if (!context.ownerId || !context.ok) return { text: '(задача не обработана)' };
    try {
      if (block[1] !== undefined) return { error: 'Уточни, какую задачу отменить.' };
      return await cancelTask(block[2].trim(), context, ctx);
    } catch (error) {
      context.signal?.throwIfAborted();
      return { error: error instanceof TaskRemovalRefusal ? error.message : 'Не удалось отменить задачу.' };
    }
  }, { claim: namedClaim, correctBeforeEach: true, quoteGuard: /\x60/u });
}
