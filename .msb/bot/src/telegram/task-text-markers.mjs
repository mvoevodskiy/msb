/**
 * Owner response -> [task text syntax](./task-text-marker-syntax.mjs) ->
 * [locked body edit](../autonomy/saved-task-text-edit.mjs) -> old reply.
 * [Worker](./bot.mjs) reserves bodies before reading other markers and
 * restores examples only for delivery. [Checks](../../tests/task-text-edit.test.mjs).
 */
import { editSavedTaskText } from '../autonomy/saved-task-text-edit.mjs';
import { savedTaskSpent } from '../autonomy/reminder-schedule.mjs';
import { taskTextOperations } from '../autonomy/saved-task-text.mjs';
import { replaceAutonomyMarkers, reserveAutonomyMarkers } from './autonomy-marker-text.mjs';
import { shownTaskSelectors, taskTextBlocks } from './task-text-marker-syntax.mjs';
import { describeSavedTaskSchedule } from './screens/task-inspection.mjs';

const prefix = '[MSB_TASK_TEXT:';
const tokenPattern = /\[MSB_TASK_TEXT:[a-f0-9-]+-\d+\]/g;
const claim = /^\s*(?:[✅✔]\uFE0F?\s*)?(?:(?:я|уже)\s+){0,2}(?:готово|заменил[аи]?|дописал[аи]?|убрал[аи]?|изменил[аи]?|поправил[аи]?)(?=$|[\s.,!])/iu;
const plural = new Intl.PluralRules('ru');

export function prepareTaskTextMarkers(text) {
  const prepared = reserveAutonomyMarkers(text, taskTextBlocks(text), prefix);
  if (prepared.commands) prepared.shown = shownTaskSelectors(prepared.text);
  return prepared;
}

function removedLines(removed) {
  const quote = value => '«' + (value.length > 90 ? value.slice(0, 90).toWellFormed() + '…' : value) + '»';
  if (removed.length === 1) return '\nУбрал: ' + quote(removed[0]);
  const word = { one: 'строку', few: 'строки', many: 'строк' }[plural.select(removed.length)];
  return '\nУбрал ' + removed.length + ' ' + word + ':\n' + removed.map(value => '— ' + quote(value)).join('\n');
}

function editReceipt({ action, timezone, removed }, operation, now) {
  const copy = taskTextOperations[operation];
  const text = savedTaskSpent(action)
    ? copy.spent(action.name) + ' Учти: её срок уже прошёл, сама она не сработает — скажи «перенеси…», если нужен новый час.'
    : copy.done(action.name) + ' Расписание, история и поля целы — ' +
      describeSavedTaskSchedule(action, now, timezone) + '.' + (action.enabled ? '' : ' Задача остаётся на паузе.');
  return { text: text + (removed ? removedLines(removed) : '') };
}

async function applyEdit(command, context, shown) {
  context.signal?.throwIfAborted();
  if (!context.ownerId || !context.ok) return { text: '(задача не обработана)' };
  const { operation, form, query, body } = command;
  const copy = taskTextOperations[operation];
  if (!form) return { error: copy.malformed };
  try {
    const result = await editSavedTaskText(operation, query, body, context, shown);
    return result.error ? result : editReceipt(result, operation, context.now);
  } catch {
    context.signal?.throwIfAborted();
    return { error: copy.failure };
  }
}

export async function processTaskTextMarkers(text, context, { commands, shown }) {
  if (!commands) return text;
  const active = [...text.matchAll(tokenPattern)].filter(block => commands.has(block[0]) && !commands.get(block[0]).literal);
  const results = new Map();
  // Preserve the old type order and the full form before its compact fallback.
  for (const operation of Object.keys(taskTextOperations)) {
    const matches = active.filter(block => commands.get(block[0]).operation === operation);
    const full = matches.filter(block => commands.get(block[0]).form === 'full');
    const rest = matches.filter(block => commands.get(block[0]).form !== 'full');
    for (const block of [...full, ...rest]) {
      results.set(block, await applyEdit(commands.get(block[0]), context, shown));
    }
  }
  return replaceAutonomyMarkers(text, active, block => results.get(block), {
    claim, correctBeforeEach: true, quoteGuard: /\x60/u,
  });
}

export function restoreTaskTextLiterals(text, { commands }) {
  if (!commands) return text;
  return text.replace(tokenPattern, token => commands.get(token)?.literal ? commands.get(token)[0] : token);
}
