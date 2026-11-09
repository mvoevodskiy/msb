/**
 * Old lwA/P7 clock for saved literal reminders. [Store](./reminder-store.mjs)
 * validates records, [dispatcher](./reminder-dispatch.mjs) checks due, and
 * [frequency gate](./reminder-frequency.mjs) and [breaker](./reminder-breaker.mjs)
 * use the old spacing estimate. [Scheduler/callback checks](../../tests/recurring-reminder.test.mjs).
 */
const minuteMs = 60_000;

function parsePart(token) {
  const match = /^(\*|\d+(?:-\d+)?)(?:\/(.+))?$/.exec(token.trim());
  if (!match) return;
  const [, base, rawStep] = match;
  const step = rawStep === undefined ? 1 : Number(rawStep);
  if (!Number.isInteger(step) || step <= 0) return;
  if (base === '*') return { start: 0, end: Infinity, step };
  const [start, end] = base.split('-').map(Number);
  return { start, end: end ?? (rawStep === undefined ? start : Infinity), step };
}

function cronFields(value) {
  if (typeof value !== 'string') return;
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) return;
  const parts = fields.map(field => field.split(',').map(parsePart).filter(Boolean));
  if (parts.every(field => field.length)) return parts;
}

export function validReminderTrigger(trigger) {
  if (trigger?.kind === 'once') return typeof trigger.at === 'string' && Number.isFinite(Date.parse(trigger.at));
  if (trigger?.kind === 'interval') return Number.isFinite(trigger.intervalMinutes) && trigger.intervalMinutes > 0;
  return trigger?.kind === 'cron' && Boolean(cronFields(trigger.cron));
}

export function spentReminder(action) {
  return action.trigger.kind === 'once' && Boolean(action.lastRunAt);
}

function localMinute(instant, clock) {
  const parts = Object.fromEntries(clock.formatToParts(instant).map(part => [part.type, Number(part.value)]));
  const { minute, hour, day, month, year } = parts;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return [minute, hour, day, month, weekday];
}

export function reminderIsDue(action, now, timezone) {
  if (!action.enabled || action.budget?.killSwitch || spentReminder(action) || action.disabledReason === 'frequency') return false;
  const { trigger } = action;
  if (trigger.kind === 'once') return Date.parse(trigger.at) <= now;
  const last = action.lastRunAt ? Date.parse(action.lastRunAt) : 0;
  if (action.lastRunAt && (!Number.isFinite(last) || last > now)) return false;
  if (trigger.kind === 'interval') return now - last >= trigger.intervalMinutes * minuteMs;
  const fields = cronFields(trigger.cron);
  if (!fields) return false;
  let clock;
  try {
    clock = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return false;
  }
  const values = localMinute(now, clock);
  if (!fields.every((field, index) => field.some(({ start, end, step }) =>
    values[index] >= start && values[index] <= end && (values[index] - start) % step === 0))) return false;
  if (!action.lastRunAt) return true;
  const previous = localMinute(last, clock);
  return values.slice(0, 4).some((value, index) => value !== previous[index]);
}

function minimumFieldGap(field, cycle) {
  if (field === '*') return 1;
  const wildcardStep = /^\*\/(\d+)$/.exec(field);
  if (wildcardStep) return Number(wildcardStep[1]) || null;
  const values = field.split(',').map(value => /^\d+$/.test(value) ? Number(value) : NaN);
  if (values.some(value => !Number.isFinite(value))) return null;
  values.sort((a, b) => a - b);
  let gap = cycle - values.at(-1) + values[0];
  for (let i = 1; i < values.length; i++) gap = Math.min(gap, values[i] - values[i - 1]);
  return gap;
}

export function reminderSpacing(trigger) {
  if (trigger.kind === 'interval') return trigger.intervalMinutes;
  if (trigger.kind !== 'cron') return null;
  const [minutes, hours] = trigger.cron.trim().split(/\s+/);
  const minuteGap = minimumFieldGap(minutes, 60);
  if (minuteGap === null || minuteGap < 60) return minuteGap;
  const hourGap = minimumFieldGap(hours, 24);
  return hourGap === null ? null : hourGap * 60;
}
