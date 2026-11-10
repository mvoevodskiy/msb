/**
 * Serialize owner task writes with the [action store](./reminder-store.mjs)
 * and engine state, without writing state.json. Used by
 * [reschedule](./saved-task-reschedule.mjs), [text edits](./saved-task-text-edit.mjs)
 * and [legacy timers](./legacy-timer-actions.mjs).
 * [State and scheduler checks](../../tests/task-text-edit.test.mjs).
 */
import { NO_STATE_WRITE, updateState } from '../state.mjs';
import { readReminderPolicy } from './reminder-policy.mjs';
import { withActions } from './reminder-store.mjs';

export async function withOwnerTaskState({ rail, timezone, signal, env = process.env }, update,
  { unavailable, staleOnRouteChange = false } = {}) {
  let result;
  // Store writers take their file lock before entering the state queue.
  await updateState(async state => {
    signal?.throwIfAborted();
    const policy = await readReminderPolicy(state, env);
    if (!policy.enabled) result = { error: 'Автономные задачи сейчас выключены.' };
    else if (!['cc', 'oc'].includes(rail) || rail !== (state.engine || 'cc')) {
      result = staleOnRouteChange ? { stale: true } : { error: unavailable };
    } else {
      const zone = state.timezone || timezone || 'Europe/Moscow';
      result = await update({ zone, rail, env });
    }
    return NO_STATE_WRITE;
  }, env);
  return result;
}

export function withOwnerTaskUpdate(context, update, { expectedFile, unavailable } = {}) {
  return withActions(context.env ?? process.env, (records, save, file) =>
    withOwnerTaskState(context, scope => update(records, save, { ...scope, file }),
      { unavailable, staleOnRouteChange: Boolean(expectedFile) }),
  { signal: context.signal, expectedFile });
}
