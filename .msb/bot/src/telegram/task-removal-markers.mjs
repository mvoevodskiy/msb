/**
 * Old CANCEL_SPENT before [inspection](./task-inspection-markers.mjs) and
 * CANCEL_TASK after it, both before [individual pause](./task-control-markers.mjs).
 * [Task removal](../autonomy/task-removal.mjs) shares the writer with the
 * [confirmation](./task-removal-confirmation.mjs). [Ingress](../../tests/named-task-cancellation.test.mjs).
 */
import { cancelNamedTaskFromTurn, cleanupSpentTasksFromTurn, TaskRemovalRefusal } from '../autonomy/task-removal.mjs';
import { savedTaskTimezone } from '../autonomy/saved-task-inspection.mjs';
import { loadState } from '../state.mjs';
import { mcpMarkerRanges } from '../mcp/install-protocol.mjs';
import { SKILL_BLOCKS } from '../skills/install-protocol.mjs';
import { autonomyExample, limitMarker, outsideExamples, outsideRanges, replaceAutonomyMarkers, scheduleMarker,
  taskCancelMarker, taskControlMarker, taskInspectionMarker } from './autonomy-marker-text.mjs';
import { describeSavedTaskSchedule } from './screens/task-inspection.mjs';
import { askToCancelSavedTask, describeSpentTaskCleanup } from './task-removal-confirmation.mjs';

const spentMarker = /\[CANCEL_SPENT\]/g;
const doubleQuoted = /"(?:\\[\s\S]|[^"\\])*"/g;
const singleQuoted = /(?<![\p{L}\p{N}])'(?:\\[\s\S]|[^'\\]|'(?=[\p{L}\p{N}]))*'(?![\p{L}\p{N}])/gu;
const structuredOpen = /\[(?:SCHEDULE_TASK|INSTALL_SKILL)\]/g;
const spentClaim = /(?:^|\s)(?:убрал[аи]?|сн[её]с(?:л[аи])?|удалил[аи]?|готово)(?=$|[\s.,!])/iu;
const namedClaim = /^\s*(?:[✅✔]\uFE0F?\s*)?(?:(?:уже|я)\s+){0,2}(?:отменил[аи]?|сн[её]с(?:л[аи])?|удалил[аи]?|убрал[аи]?|готово)(?=$|[\s.,!])/iu;

function removalRanges(text, adjacent = []) {
  const payloads = [
    ...adjacent, ...text.matchAll(scheduleMarker), ...text.matchAll(limitMarker),
    ...text.matchAll(taskControlMarker), ...text.matchAll(taskInspectionMarker), ...text.matchAll(SKILL_BLOCKS),
    ...mcpMarkerRanges(text).map(({ start, end }) => ({ index: start, 0: text.slice(start, end) })),
  ];
  // Delimiters inside verbatim text or examples cannot open a quote in the reply.
  const quoteInput = text.replace(autonomyExample, block => block.replace(/["'\\]/g, ' '));
  const quotes = [...quoteInput.matchAll(doubleQuoted), ...quoteInput.matchAll(singleQuoted)];
  const unclosed = outsideExamples(text, structuredOpen, [...payloads, ...quotes]).find(block => {
    const tail = text.slice(block.index + block[0].length);
    return /^[ \t]*\r?\n/.test(tail) || /^\s*[\[{]/.test(tail);
  });
  if (unclosed) payloads.push({ index: unclosed.index, 0: text.slice(unclosed.index) });
  return { payloads, quotes };
}

function hasEmptySuffix(text, block) {
  const suffix = text.slice(block.index + block[0].length).split('\n', 1)[0];
  return !suffix.replace(/<\/code>|\x60|»|"|'/g, '').trim();
}

export async function processSpentTaskMarkers(text, context) {
  if (typeof text !== 'string' || !text.includes('[CANCEL_SPENT]')) return text;
  const { payloads, quotes } = removalRanges(text, [...text.matchAll(taskCancelMarker)]);
  const commands = new Set(outsideExamples(text, spentMarker, [...payloads, ...quotes])
    .filter(block => hasEmptySuffix(text, block)).map(block => block.index));
  // The old direct detector removes quoted or explanatory mentions. Leave
  // structured payloads intact for their own parser.
  return replaceAutonomyMarkers(text, outsideRanges(text, spentMarker, payloads), async block => {
    if (!commands.has(block.index)) return { text: '' };
    context.signal?.throwIfAborted();
    if (!context.ownerId || !context.ok) return { text: '(задача не обработана)' };
    try {
      const result = await cleanupSpentTasksFromTurn(context);
      return { text: describeSpentTaskCleanup(result).text };
    } catch (error) {
      context.signal?.throwIfAborted();
      return { error: error instanceof TaskRemovalRefusal ? error.message : 'Не удалось убрать просроченные.' };
    }
  }, { claim: spentClaim, correctBeforeEach: true });
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
  const { payloads, quotes } = removalRanges(text);
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
