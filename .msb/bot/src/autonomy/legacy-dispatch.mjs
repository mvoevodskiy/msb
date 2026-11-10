/**
 * Check saved legacy timer eligibility and reserve the ordinary Telegram turn.
 * [Scheduler](./scheduler.mjs), [records](./legacy-timers.mjs), [inbox](../telegram/inbox.mjs),
 * [old contract](../../tests/reference/parity-autonomy-contract.txt), [ingress test](../../tests/legacy-timer-dispatch.test.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { botId, msbRoot } from '../paths.mjs';
import { loadState } from '../state.mjs';
import { legacyTimerSnapshot, publishLegacyTimerRun } from './legacy-timers.mjs';

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

async function isSleeping(env) {
  try {
    await fs.lstat(path.join(msbRoot(env), 'engine', 'sleep.' + botId(env)));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function ownerClock(timeZone) {
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return date => {
    const parts = Object.fromEntries(format.formatToParts(date).map(({ type, value }) => [type, value]));
    return {
      day: parts.year + '-' + parts.month + '-' + parts.day,
      weekday: weekdays.indexOf(parts.weekday) + 1,
      hour: Number(parts.hour), minute: Number(parts.minute),
    };
  };
}

function isDue(timer, instant, local) {
  if (!timer.enabled) return false;
  if (timer.type === 'once') return Boolean(timer.at && !timer.lastRunAt && new Date(timer.at) <= instant);

  const clock = local(instant);
  if (clock.hour !== timer.hour || clock.minute !== (timer.minute ?? 0)) return false;
  if (timer.type === 'weekly' && !timer.weekdays?.includes(clock.weekday)) return false;
  const last = new Date(timer.lastRunAt || '');
  return !Number.isFinite(last.getTime()) || local(last).day !== clock.day;
}

export async function dispatchLegacyTimers({ scheduledTurns, timezone, now, isInterrupted, env = process.env }) {
  const { file, timers } = await legacyTimerSnapshot(env);
  if (isInterrupted() || !timers.length || await isSleeping(env)) return;
  const { state } = await loadState(env);
  const { chatId, userId } = state;
  if (!chatId || !userId) return;

  const instant = new Date(now());
  let formatClock;
  const local = date => (formatClock ??= ownerClock(state.timezone || timezone))(date);
  for (const timer of timers) {
    if (isInterrupted()) return;
    if (!isDue(timer, instant, local)) continue;
    const text = '⏰ Таймер "' + timer.name + '":\n' + timer.prompt;
    await publishLegacyTimerRun(file, timer, {
      env, now,
      reserve: () => isInterrupted() ? null : scheduledTurns.reserve({ chatId, userId, text }),
    });
  }
}
