/**
 * Legacy schedules.json belongs to the bot's session directory parent.
 * [Telegram management](../telegram/routes/autonomy.mjs), [profile paths](../paths.mjs),
 * [storage lock](../../shared/file-lock.mjs), [parity checks](../../tests/autonomy-timers.test.mjs).
 * [Conversation](./legacy-timer-actions.mjs) and [dispatcher](./legacy-dispatch.mjs) share the writer.
 * [Interval tasks](./store.mjs) are separate.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { withFileLock } from '../../shared/file-lock.mjs';
import { actionRoot } from '../paths.mjs';
import { readRecordArray, writeRecordArray } from './record-file.mjs';

function timersPath(env) {
  return path.join(actionRoot(env), 'schedules.json');
}

export function savedLegacyTimers(records) {
  return records.filter(row => typeof row?.id === 'string' && typeof row.name === 'string');
}

async function physicalTimersPath(env) {
  try {
    return await fs.realpath(timersPath(env));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function readLegacyTimerRecords(env = process.env) {
  const file = await physicalTimersPath(env);
  return { file, timers: file ? savedLegacyTimers(await readRecordArray(file)) : [] };
}

export async function legacyTimerSnapshot(env = process.env) {
  try {
    return await readLegacyTimerRecords(env);
  } catch (error) {
    console.error('[msb/autonomy] Could not read saved timers:', error.code || error.name);
    return { file: null, timers: [] };
  }
}

export async function listLegacyTimers(env = process.env) {
  return (await legacyTimerSnapshot(env)).timers;
}

export async function withLegacyTimerUpdate(env, update, { expectedFile, signal } = {}) {
  signal?.throwIfAborted();
  const file = await physicalTimersPath(env);
  if (!file || (expectedFile && file !== expectedFile)) return null;
  return withFileLock(file, async () => {
    signal?.throwIfAborted();
    if (await physicalTimersPath(env) !== file) return null;
    const records = await readRecordArray(file);
    const save = (next = records) => writeRecordArray(file, next, {
      signal,
      beforePublish: async () => {
        if (await physicalTimersPath(env) !== file) throw new Error('Timer file changed');
      },
    });
    return update(records, save);
  });
}

export async function changeLegacyTimer(id, { remove = false, env = process.env } = {}) {
  return (await withLegacyTimerUpdate(env, async (records, save) => {
    if (!records.some(row => row?.id === id)) return savedLegacyTimers(records);
    const updated = remove
      ? records.filter(row => row?.id !== id)
      : records.map(row => {
        if (row?.id !== id) return row;
        const timer = { ...row, enabled: !row.enabled };
        if (timer.disabledBy === 'stop') delete timer.disabledBy;
        return timer;
      });
    await save(updated);
    return savedLegacyTimers(updated);
  })) ?? [];
}

/** Owner confirmation/resume affects only legacy rows carrying the stop provenance. */
export async function changeStoppedLegacyTimers(stop, env = process.env) {
  return (await withLegacyTimerUpdate(env, async (records, save) => {
    let changed = 0;
    for (const timer of savedLegacyTimers(records)) {
      if (stop && timer.enabled) {
        timer.enabled = false;
        timer.disabledBy = 'stop';
      } else if (!stop && timer.enabled === false && timer.disabledBy === 'stop') {
        timer.enabled = true;
        delete timer.disabledBy;
      } else continue;
      changed++;
    }
    if (changed) await save();
    return changed;
  })) ?? 0;
}

export async function publishLegacyTimerRun(file, timer, { reserve, now, env }) {
  await withLegacyTimerUpdate(env, async (records, save) => {
    const index = records.findIndex(row => row?.id === timer.id);
    if (index < 0 || !isDeepStrictEqual(records[index], timer)) return;
    const finishReservation = reserve();
    if (!finishReservation) return;

    try {
      const next = { ...timer, lastRunAt: new Date(now()).toISOString() };
      if (timer.type === 'once') next.enabled = false;
      records[index] = next;
      await save();
    } catch (error) {
      finishReservation(false);
      throw error;
    }
    finishReservation(true);
  }, { expectedFile: file });
}

const weekdays = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

export function formatLegacyTimer(timer) {
  if (timer.type === 'once') {
    const at = new Date(timer.at || '');
    const day = at.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    const time = at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return timer.name + ' — ' + day + ' ' + time + ' (одноразовый)';
  }
  const time = String(timer.hour).padStart(2, '0') + ':' + String(timer.minute ?? 0).padStart(2, '0');
  if (timer.type === 'weekly') {
    const days = Array.isArray(timer.weekdays) ? timer.weekdays.map(day => weekdays[day]).join(', ') : '';
    return timer.name + ' — ' + days + ' ' + time;
  }
  return timer.name + ' — каждый день ' + time;
}
