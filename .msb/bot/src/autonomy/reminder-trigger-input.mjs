/**
 * Shared input validation for [registration](./reminder-protocol.mjs) and
 * [rescheduling](./saved-task-reschedule.mjs). Returns a normalized trigger or
 * the reason it cannot run. [Clock](./reminder-schedule.mjs) and
 * [ingress checks](../../tests/task-reschedule.test.mjs).
 */
import { readRecurringReminderCron, validReminderTimezone } from './reminder-schedule.mjs';
import { fastReminderSpacing, reminderFrequencyFloor } from './reminder-frequency.mjs';

const relativeTime = /^\+\s*(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)\b/i;
const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseOnceTrigger(trigger, now) {
  const source = typeof trigger?.at === 'string' ? trigger.at.trim() : '';
  if (!source) return { error: 'для разовой задачи нужно время (например «+10m» или ISO)' };
  const relative = relativeTime.exec(source);
  const millis = relative ? now + Number(relative[1]) * unitMs[relative[2][0].toLowerCase()] : Date.parse(source);
  const time = new Date(millis);
  if (!Number.isFinite(time.getTime())) {
    return { error: 'не понял время «' + source + '» — дай относительное (+10m) или дату' };
  }
  return { trigger: { kind: 'once', at: time.toISOString() } };
}

function parseRecurringTrigger(trigger, timezone) {
  const cron = typeof trigger.cron === 'string' ? trigger.cron.trim() : '';
  const calendar = readRecurringReminderCron(cron);
  if (!calendar) {
    return { error: 'для регулярной задачи нужен корректный cron (5 полей)' };
  }
  const ownerZone = timezone || 'Europe/Moscow';
  const stored = { kind: 'cron', cron, timezone: trigger.timezone ?? ownerZone };
  const minutes = fastReminderSpacing({ trigger: stored }) ?? calendar.minuteGap;
  if (minutes < reminderFrequencyFloor) {
    return { error: 'слишком часто: каждые ' + minutes +
      ' мин. Каждый запуск стоит денег, поэтому регулярные задачи ставим не чаще раза в час. ' +
      'Скажи владельцу и предложи час или конкретное время дня' };
  }
  const invalidZone = [ownerZone, stored.timezone].find(zone => !validReminderTimezone(zone));
  if (invalidZone !== undefined) {
    const label = typeof invalidZone === 'string' ? ' «' + invalidZone + '»' : '';
    return { error: 'не понял часовой пояс' + label + ' — укажи часовой пояс IANA' };
  }
  return { trigger: stored };
}

export function parseReminderTrigger(trigger, { now, timezone }) {
  return trigger?.kind === 'recurring' ? parseRecurringTrigger(trigger, timezone) : parseOnceTrigger(trigger, now);
}
