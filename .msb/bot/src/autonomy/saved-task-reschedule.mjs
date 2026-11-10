/**
 * Old hg/RJ update of one schedule in the shared [action store](./reminder-store.mjs).
 * [Owner turn](../telegram/task-reschedule-markers.mjs) plans or moves it.
 * [Question](./task-reschedule-questions.mjs) rechecks the shown definition before
 * publishing. [Telegram and scheduler checks](../../tests/task-reschedule.test.mjs).
 */
import { randomUUID } from 'node:crypto';
import { withOwnerTaskUpdate } from './owner-task-update.mjs';
import { isLocalSavedAction, readNativeJobMap, taskDefinitionFingerprint } from './reminder-store.mjs';
import { savedTaskSpent } from './reminder-schedule.mjs';
import { parseReminderTrigger } from './reminder-trigger-input.mjs';
import { selectSavedAction, unavailableSavedActionControl } from './saved-action-control.mjs';

const cronText = /^[\d*/,\-\s]+$/;

function rescheduleTrigger(text, now, timezone) {
  const value = text.trim();
  if (!value) return { error: 'Уточни, на когда перенести.' };
  const input = cronText.test(value) && value.split(/\s+/).length === 5
    ? { kind: 'recurring', cron: value } : { kind: 'once', at: value };
  const parsed = parseReminderTrigger(input, { now, timezone });
  return parsed.trigger ? parsed : { error: 'Перенести не смог: ' + parsed.error + '.' };
}

function rescheduledAction(action, trigger) {
  const next = { ...action, trigger, enabled: true };
  for (const key of ['lastRunAt', 'lastStatus', 'lastOutcome', 'nextFireAt', 'pendingReschedule']) delete next[key];
  if (['owner', 'spent_once'].includes(next.disabledReason)) delete next.disabledReason;
  return next;
}

function moveUnavailable(action) {
  if (action.migratedToOc) return unavailableSavedActionControl(action);
  return 'Перенос задачи «' + action.name + '» на этом движке пока недоступен.';
}

async function canMove(next, rail, env) {
  // An unmapped automatic action under OC can still belong to the Gateway.
  return (rail !== 'oc' || next.runner === 'cc') && isLocalSavedAction(next, await readNativeJobMap(env));
}

async function saveMovedAction(records, save, index, next, { rail, env, zone }) {
  // A move to the same cron still resets its run stamp. Fence old questions
  // and old run completions with a different definition after every move.
  const action = { ...next, scheduleRevision: randomUUID() };
  records[index] = action;
  await save(async () => {
    if (!await canMove(action, rail, env)) throw new Error('Action ownership changed before rescheduling');
  });
  return { action, timezone: zone };
}

export function rescheduleTaskFromTurn(selector, text, context) {
  const query = selector.trim();
  if (!query) return { error: 'Уточни, какую задачу перенести.' };
  return withOwnerTaskUpdate(context, async (records, save, scope) => {
    const selection = selectSavedAction(records, query);
    if (!selection.action) return selection;
    const { action } = selection;
    const parsed = rescheduleTrigger(text, context.now, scope.zone);
    if (!parsed.trigger) return parsed;
    const next = rescheduledAction(action, parsed.trigger);
    if (!await canMove(next, scope.rail, scope.env)) return { error: moveUnavailable(action) };
    if (!action.enabled || savedTaskSpent(action)) {
      return saveMovedAction(records, save, records.indexOf(action), next, scope);
    }
    return {
      action, next, timezone: scope.zone,
      snapshot: { file: scope.file, id: action.id, fingerprint: taskDefinitionFingerprint(action), trigger: parsed.trigger },
    };
  }, { unavailable: 'Перенос задач на этом движке пока не подключён.' });
}

export function applyTaskReschedule(question, { timezone, env }) {
  return withOwnerTaskUpdate({ rail: question.rail, timezone, env }, async (records, save, scope) => {
    const index = records.findIndex(action => action?.id === question.id);
    const action = records[index];
    if (!action || taskDefinitionFingerprint(action) !== question.fingerprint ||
        (question.trigger.kind === 'cron' && question.trigger.timezone !== scope.zone)) return { stale: true };
    const next = rescheduledAction(action, question.trigger);
    if (!await canMove(next, scope.rail, scope.env)) return { stale: true };
    return saveMovedAction(records, save, index, next, scope);
  }, { expectedFile: question.file });
}
