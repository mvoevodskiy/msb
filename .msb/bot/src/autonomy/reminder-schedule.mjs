/**
 * Old lwA/P7 clock for saved literal reminders. [Store](./reminder-store.mjs)
 * validates saved records and [dispatcher](./reminder-dispatch.mjs) checks due.
 * [Registration](./reminder-protocol.mjs) uses the same calendar for input,
 * preview and [advisories](./reminder-registration-advice.mjs). [Frequency gate](./reminder-frequency.mjs)
 * and [breaker](./reminder-breaker.mjs) use the old spacing estimate.
 * [Scheduler checks](../../tests/recurring-reminder.test.mjs).
 */
const minuteMs = 60_000;
const dayMs = 24 * 60 * minuteMs;
const fieldBounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const longestMonthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function parsePart(token, bounds) {
  const match = /^(\*|\d+(?:-\d+)?)(?:\/(.+))?$/.exec(token.trim());
  if (!match) return;
  const [, base, rawStep] = match;
  const step = rawStep === undefined ? 1 : Number(rawStep);
  if (!Number.isInteger(step) || step <= 0) return;
  if (base === '*') return { start: 0, end: Infinity, step };
  const [start, end] = base.split('-').map(Number);
  if (bounds) {
    const [minimum, maximum] = bounds;
    if (!(start >= minimum && start <= maximum) || (end !== undefined && !(end >= start && end <= maximum))) return;
  }
  return { start, end: end ?? (rawStep === undefined ? start : Infinity), step };
}

function cronFields(value, strict = false) {
  if (typeof value !== 'string') return;
  const fields = value.trim().split(/\s+/);
  if (fields.length !== fieldBounds.length) return;
  const parts = fields.map((field, index) => {
    const tokens = field.split(',').map(token => parsePart(token, strict ? fieldBounds[index] : undefined));
    return strict && tokens.some(token => !token) ? [] : tokens.filter(Boolean);
  });
  if (parts.every(field => field.length)) return parts;
}

function matchesField(field, value) {
  return field.some(({ start, end, step }) => value >= start && value <= end && (value - start) % step === 0);
}

function matchesFields(fields, values) {
  return fields.every((field, index) => matchesField(field, values[index]));
}

function countFieldSlots(field, [minimum, maximum]) {
  let count = 0;
  for (let value = minimum; value <= maximum; value++) if (matchesField(field, value)) count++;
  return count;
}

export function readRecurringReminderCron(value) {
  const fields = cronFields(value, true);
  if (!fields?.every((field, index) => countFieldSlots(field, fieldBounds[index]) > 0)) return;
  const [minutes, , days, months] = fields;
  if (!longestMonthDays.some((maximum, month) => matchesField(months, month + 1) &&
      countFieldSlots(days, [1, maximum]) > 0)) return;

  // Any pair of matching minutes in the same hour proves a too-fast cadence,
  // including ranges that the legacy spacing estimate cannot read.
  let minuteGap = 60;
  let previous;
  for (let minute = 0; minute < 60; minute++) {
    if (!matchesField(minutes, minute)) continue;
    if (previous !== undefined) minuteGap = Math.min(minuteGap, minute - previous);
    previous = minute;
  }
  return { minuteGap };
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

function cronClock(timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
}

export function validReminderTimezone(timezone) {
  return typeof timezone === 'string' && Boolean(timezone && cronClock(timezone));
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
  const clock = cronClock(timezone);
  if (!clock) return false;
  const values = localMinute(now, clock);
  if (!matchesFields(fields, values)) return false;
  if (!action.lastRunAt) return true;
  const previous = localMinute(last, clock);
  return values.slice(0, 4).some((value, index) => value !== previous[index]);
}

// Old D9 starts at the following minute and searches at most 45 days.
export function nextReminderCronAt(cron, now, timezone) {
  const fields = cronFields(cron);
  const clock = cronClock(timezone);
  if (!fields || !clock) return;
  const first = (Math.floor(now / minuteMs) + 1) * minuteMs;
  const end = first + 45 * dayMs;
  for (let at = first; at <= end; at += minuteMs) {
    if (matchesFields(fields, localMinute(at, clock))) return at;
  }
}

// Old Gr estimates calendar frequency using the next 28 owner-local dates.
export function estimateReminderRunsPerDay(trigger, now, timezone) {
  if (trigger?.kind === 'interval' || trigger?.kind === 'heartbeat') {
    const minutes = trigger.kind === 'interval' ? trigger.intervalMinutes : trigger.everyTicks ?? 1;
    return Number.isFinite(minutes) && minutes > 0 ? 1440 / minutes : 0;
  }
  if (trigger?.kind !== 'cron') return 0;
  const fields = cronFields(trigger.cron);
  const clock = cronClock(timezone);
  if (!fields || !clock) return 0;
  const timeSlots = countFieldSlots(fields[0], fieldBounds[0]) * countFieldSlots(fields[1], fieldBounds[1]);
  const calendar = fields.slice(2);
  const days = 28;
  let matchingDays = 0;
  for (let day = 0; day < days; day++) {
    if (matchesFields(calendar, localMinute(now + day * dayMs, clock).slice(2))) matchingDays++;
  }
  return timeSlots * matchingDays / days;
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
