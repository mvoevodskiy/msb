/**
 * Read the legacy per-profile frequency decision for [saved reminders](./reminder-schedule.mjs).
 * [Dispatcher](./reminder-dispatch.mjs) and [task views](../telegram/screens/reminders.mjs)
 * use the same admission. Owner decisions are read from their existing file.
 */
import path from 'node:path';
import { actionRoot } from '../paths.mjs';
import { readOptionalJson } from './record-file.mjs';
import { reminderSpacing, spentReminder } from './reminder-schedule.mjs';

const floorMinutes = 60;

export async function readReminderFrequencyDecisions(env = process.env) {
  const saved = await readOptionalJson(path.join(actionRoot(env), 'owner-decisions.json')).catch(() => null);
  return saved?.decisions && typeof saved.decisions === 'object' ? saved.decisions : {};
}

export function reminderFrequencyAllows(action, decisions = {}) {
  if (action.trigger.kind === 'once') return action.disabledReason !== 'frequency';
  const spacing = reminderSpacing(action.trigger);
  if (spacing === null || spacing >= floorMinutes) return true;
  const key = `autonomy-cron:${action.id}:frequency`;
  return Object.hasOwn(decisions, key) && decisions[key]?.value === 'keep_as_is';
}

export function reminderIsActive(action, decisions) {
  return action.enabled && !spentReminder(action) && !action.budget?.killSwitch && reminderFrequencyAllows(action, decisions);
}
