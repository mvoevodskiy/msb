/**
 * Frequency policy for [saved schedules](./reminder-schedule.mjs).
 * [Brake](./reminder-frequency-brake.mjs) applies the decision before due
 * selection. [Dispatcher](./reminder-dispatch.mjs) and task views share the gate.
 * [Checks](../../tests/reminder-frequency.test.mjs).
 */
import { reminderSpacing, spentReminder } from './reminder-schedule.mjs';

export const reminderFrequencyFloor = 60;
export const reminderFrequencyChoices = [
  { value: 'hourly', label: 'Раз в час' },
  { value: 'keep_as_is', label: 'Оставить как есть' },
  { value: 'turn_off', label: 'Выключить задачу' },
];

export const reminderFrequencySubject = id => 'autonomy-cron:' + id + ':frequency';

export function fastReminderSpacing(action) {
  const minutes = reminderSpacing(action.trigger);
  if (minutes !== null && minutes < reminderFrequencyFloor) return minutes;
}

export function reminderFrequencyChoice(action, decisions) {
  const key = reminderFrequencySubject(action.id);
  if (Object.hasOwn(decisions, key)) return decisions[key]?.value;
}

export function reminderFrequencyAllows(action, decisions = {}) {
  return action.disabledReason !== 'frequency' &&
    (fastReminderSpacing(action) === undefined || reminderFrequencyChoice(action, decisions) === 'keep_as_is');
}

export function reminderIsActive(action, decisions) {
  return action.enabled && !spentReminder(action) && !action.budget?.killSwitch && reminderFrequencyAllows(action, decisions);
}
