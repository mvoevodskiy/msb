/**
 * Old CANCEL_SPENT after [pause](./pause-markers.mjs) and before
 * [inspection](./task-inspection-markers.mjs) in a successful owner turn.
 * [Cleanup](../autonomy/spent-task-cleanup.mjs) shares the action writer with
 * [confirmation](./spent-task-confirmation.mjs). [Checks](../../tests/direct-spent-task-cleanup.test.mjs).
 */
import { cleanupSpentTasksFromTurn, SpentCleanupRefusal } from '../autonomy/spent-task-cleanup.mjs';
import { mcpMarkerRanges } from '../mcp/install-protocol.mjs';
import { SKILL_BLOCKS } from '../skills/install-protocol.mjs';
import { limitMarker, outsideExamples, outsideRanges, replaceAutonomyMarkers, scheduleMarker,
  taskControlMarker, taskInspectionMarker } from './autonomy-marker-text.mjs';
import { describeSpentTaskCleanup } from './spent-task-confirmation.mjs';

const command = /\[CANCEL_SPENT\]/g;
const doubleQuoted = /"(?:\\[\s\S]|[^"\\])*"/g;
const singleQuoted = /(?<![\p{L}\p{N}])'(?:\\[\s\S]|[^'\\]|'(?=[\p{L}\p{N}]))*'(?![\p{L}\p{N}])/gu;
const structuredOpen = /\[(?:SCHEDULE_TASK|INSTALL_SKILL)\]/g;
const claim = /(?:^|\s)(?:убрал[аи]?|сн[её]с(?:л[аи])?|удалил[аи]?|готово)(?=$|[\s.,!])/iu;

function hasEmptySuffix(text, block) {
  const suffix = text.slice(block.index + block[0].length).split('\n', 1)[0];
  return !suffix.replace(/<\/code>|\x60|»|"|'/g, '').trim();
}

export async function processSpentTaskMarkers(text, context) {
  if (typeof text !== 'string' || !text.includes('[CANCEL_SPENT]')) return text;
  const payloads = [
    ...text.matchAll(scheduleMarker), ...text.matchAll(limitMarker),
    ...text.matchAll(taskControlMarker), ...text.matchAll(taskInspectionMarker), ...text.matchAll(SKILL_BLOCKS),
    ...mcpMarkerRanges(text).map(({ start, end }) => ({ index: start, 0: text.slice(start, end) })),
  ];
  const quotes = [...text.matchAll(doubleQuoted), ...text.matchAll(singleQuoted)];
  const unclosed = outsideExamples(text, structuredOpen, [...payloads, ...quotes]).find(block => {
    const tail = text.slice(block.index + block[0].length);
    return /^[ \t]*\r?\n/.test(tail) || /^\s*[\[{]/.test(tail);
  });
  if (unclosed) payloads.push({ index: unclosed.index, 0: text.slice(unclosed.index) });
  const commands = new Set(outsideExamples(text, command, [...payloads, ...quotes])
    .filter(block => hasEmptySuffix(text, block)).map(block => block.index));
  // The old direct detector removes quoted or explanatory mentions. Leave
  // structured payloads intact for their own parser.
  return replaceAutonomyMarkers(text, outsideRanges(text, command, payloads), async block => {
    if (!commands.has(block.index)) return { text: '' };
    context.signal?.throwIfAborted();
    if (!context.ownerId || !context.ok) return { text: '(задача не обработана)' };
    try {
      const result = await cleanupSpentTasksFromTurn(context);
      return { text: describeSpentTaskCleanup(result).text };
    } catch (error) {
      context.signal?.throwIfAborted();
      return { error: error instanceof SpentCleanupRefusal ? error.message : 'Не удалось убрать просроченные.' };
    }
  }, { claim, correctBeforeEach: true });
}
