/**
 * Serialize owner task writes with the [action store](./reminder-store.mjs)
 * and engine state, without writing state.json. Used by
 * [reschedule](./saved-task-reschedule.mjs) and [text edits](./saved-task-text-edit.mjs).
 * [State and scheduler checks](../../tests/task-text-edit.test.mjs).
 */
import { NO_STATE_WRITE, updateState } from '../state.mjs';
import { readReminderPolicy } from './reminder-policy.mjs';
import { withActions } from './reminder-store.mjs';

export function withOwnerTaskUpdate({ rail, timezone, signal, env = process.env }, update,
  { expectedFile, unavailable } = {}) {
  return withActions(env, async (records, save, file) => {
    let result;
    // Match scheduler admission's actions -> state order.
    await updateState(async state => {
      signal?.throwIfAborted();
      const policy = await readReminderPolicy(state, env);
      if (!policy.enabled) result = { error: 'Автономные задачи сейчас выключены.' };
      else if (!['cc', 'oc'].includes(rail) || rail !== (state.engine || 'cc')) {
        result = expectedFile ? { stale: true } : { error: unavailable };
      } else {
        const zone = state.timezone || timezone || 'Europe/Moscow';
        result = await update(records, save, { file, zone, rail, env });
      }
      return NO_STATE_WRITE;
    }, env);
    return result;
  }, { signal, expectedFile });
}
