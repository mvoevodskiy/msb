/**
 * Old yg advisories after [registration](../telegram/reminder-markers.mjs).
 * Use the [existing action snapshot](./reminder-store.mjs), the separate
 * [legacy timer reader](./legacy-timers.mjs) and [calendar](./reminder-schedule.mjs).
 * The messages never change a saved row. [Checks](../../tests/recurring-reminder-registration.test.mjs).
 */
import { listLegacyTimers } from './legacy-timers.mjs';
import { estimateReminderRunsPerDay } from './reminder-schedule.mjs';

const normalized = value => typeof value === 'string'
  ? value.toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?"'()«»]/g, '').trim() : '';
const actionText = row => normalized(row.task?.prompt ?? row.task?.text);
const cronKey = cron => typeof cron === 'string' ? cron.trim().replace(/\s+/g, ' ') : '';
const plural = new Intl.PluralRules('ru');

function sameSchedule(candidate, trigger) {
  if (candidate?.kind !== trigger.kind) return false;
  return trigger.kind === 'once' ? candidate.at === trigger.at : cronKey(candidate.cron) === cronKey(trigger.cron);
}

function sameText(left, right, exact, contained) {
  if (left && left === right) return exact;
  if (left.length >= 40 && right.length >= 40 && (left.includes(right) || right.includes(left))) return contained;
}

function twinAdvice(action, existing) {
  const text = actionText(action);
  const name = normalized(action.name);
  for (const row of existing) {
    if (!sameSchedule(row.trigger, action.trigger)) continue;
    const reason = sameText(actionText(row), text, 'то же задание', 'задание внутри такого же') ??
      (name && normalized(row.name) === name ? 'то же название' : undefined);
    if (reason) return '🔁 В то же время уже стоит «' + row.name + '» — ' + reason +
      '. Если второй экземпляр не нужен, скажи «выключи задачу ' + row.name + '».';
  }
}

function legacyAdvice(action, timers) {
  const text = actionText(action);
  const name = normalized(action.name);
  for (const timer of timers) {
    if (timer.enabled === false) continue;
    const reason = name && normalized(timer.name) === name ? 'одинаковое название: «' + timer.name + '»' :
      sameText(normalized(timer.prompt), text, 'дословно одинаковое задание', 'одно задание целиком входит в другое');
    if (reason) return '⏳ Похоже, старый таймер «' + timer.name + '» делает то же самое (' + reason +
      '). Чтобы не было дубля, скажи «выключи таймер ' + timer.name + '».';
  }
}

function runCount(number, words) {
  if (!Number.isInteger(number)) return String(number).replace('.', ',') + ' ' + words.few;
  return number + ' ' + words[plural.select(number)];
}

function loadAdvice(actions, now, timezone) {
  const estimate = actions.reduce((total, row) => total + estimateReminderRunsPerDay(row.trigger, now, timezone), 0);
  const daily = Math.round(estimate * 10) / 10;
  if (!Number.isFinite(daily) || daily < 5) return;
  const display = daily >= 10 ? Math.round(daily) : daily;
  const approximate = daily === display ? '' : 'около ';
  const one = { one: 'раз', few: 'раза', many: 'раз' };
  const multiple = { one: 'запуск', few: 'запуска', many: 'запусков' };
  const prefix = actions.length === 1
    ? 'Эта задача сработает ' + approximate + runCount(display, one)
    : 'Всего задач ' + actions.length + ', вместе это ' + approximate + runCount(display, multiple);
  return '📊 ' + prefix + ' в сутки. Если это лишнее, скажи «покажи задачи».';
}

export async function reminderRegistrationAdvice(action, previous, now, timezone) {
  const active = previous.filter(row => row && row.enabled !== false);
  const timers = await listLegacyTimers();
  return [twinAdvice(action, active), legacyAdvice(action, timers), loadAdvice([...active, action], now, timezone)]
    .filter(Boolean).join('\n');
}
