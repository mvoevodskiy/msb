/**
 * Check saved legacy timer eligibility and reserve the ordinary Telegram turn.
 * [Scheduler](./scheduler.mjs), [records](./legacy-timers.mjs), [inbox](../telegram/inbox.mjs),
 * [old contract](../../tests/reference/parity-autonomy-contract.txt), [spend pause](../../tests/reference/parity-owner-spend-contract.txt),
 * [ingress test](../../tests/legacy-timer-dispatch.test.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { botId, msbRoot } from '../paths.mjs';
import { loadState, NO_STATE_WRITE, updateState } from '../state.mjs';
import { isCodexSelected } from '../engines/codex-active.mjs';
import { withFileLock } from '../../shared/file-lock.mjs';
import { claimLegacyTimerRuns, legacyTimerSnapshot, pendingLegacyTimerRun, publishLegacyTimerRun } from './legacy-timers.mjs';

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const markerPath = env => path.join(msbRoot(env), 'engine', 'sleep.' + botId(env));
const destinationKey = ({ chatId, userId }) => `${chatId}:${userId}`;

async function isSleeping(env) {
  try {
    await fs.lstat(markerPath(env));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/** The worker commits only an awake admission. False leaves all reservations prepared. */
export async function admitLegacyTimerRuns(runs, signal, { blocked = false, blockedByCodexSleep = false, env = process.env } = {}) {
  if (blocked && !blockedByCodexSleep) return false;
  if (!blocked && runs.every(run => !pendingLegacyTimerRun(run.timer))) {
    const state = await updateState(() => {
      signal?.throwIfAborted();
      return NO_STATE_WRITE;
    }, env);
    // Ordinary stamped timers need no further schedule-file validation when
    // Codex is not selected, just as on the original queue path.
    if (!isCodexSelected(state)) return new Set(runs);
  }
  return claimLegacyTimerRuns(runs, { env, signal, admit: async commit => {
    let admitted;
    // Timer commands already acquire schedules before state. With the same
    // order, provider selection and the writer cannot cross this admission.
    await updateState(async state => {
      signal?.throwIfAborted();
      const destination = destinationKey(state);
      // A provider switch after queue rejection does not invalidate the
      // observed Codex sleep decision. Only the matching timer can be saved.
      admitted = isCodexSelected(state) || blockedByCodexSleep
        ? await withFileLock(markerPath(env), async () => {
          signal?.throwIfAborted();
          return commit(destination, blockedByCodexSleep || await isSleeping(env));
        })
        : await commit(destination);
      return NO_STATE_WRITE;
    }, env);
    return admitted;
  } });
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
    const pending = pendingLegacyTimerRun(timer);
    const due = isDue(timer, instant, local);
    if ((!pending && !due) || (pending && state.costPaused)) continue;
    const text = '⏰ Таймер "' + timer.name + '":\n' + timer.prompt;
    await publishLegacyTimerRun(file, timer, {
      env, now, recoverable: isCodexSelected(state) || Boolean(state.costPaused), destination: destinationKey(state),
      deferOnly: Boolean(state.costPaused), coalesceAt: pending && due ? instant.getTime() : undefined,
      reserve: legacyRun => isInterrupted() ? null : scheduledTurns.reserve({ chatId, userId, text, legacyRun }),
    });
  }
}
