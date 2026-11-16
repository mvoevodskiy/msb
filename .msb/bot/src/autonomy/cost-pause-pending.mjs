/**
 * One durable due occurrence per saved action while owner spending is paused.
 * [Schedule](./reminder-schedule.mjs) reads it; [store](./reminder-store.mjs)
 * updates it under the existing action lock; [dispatcher](./reminder-dispatch.mjs)
 * rechecks all other limits on resume. [Checks](../../tests/saved-spend-pause.test.mjs).
 */
import { isDeepStrictEqual } from 'node:util';

export function hasCostPausePending(action) {
  const pending = action?.costPausePending;
  return pending?.version === 1 && typeof pending.at === 'string' && Number.isFinite(Date.parse(pending.at)) &&
    isDeepStrictEqual(pending.trigger, action.trigger) &&
    (pending.scheduleRevision ?? null) === (action.scheduleRevision ?? null) &&
    (pending.previousRunAt ?? null) === (action.lastRunAt ?? null);
}

export function markCostPausePending(action, at) {
  if (hasCostPausePending(action)) return action;
  // Unknown future or foreign formats are user data, not ours to overwrite.
  if (action.costPausePending && action.costPausePending.version !== 1) return;
  return { ...action, costPausePending: { version: 1, at, trigger: action.trigger,
    scheduleRevision: action.scheduleRevision ?? null, previousRunAt: action.lastRunAt ?? null } };
}
