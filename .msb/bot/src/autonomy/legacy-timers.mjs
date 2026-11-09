/**
 * Legacy schedules.json belongs to the bot's session directory parent.
 * [Telegram management](../telegram/routes/autonomy.mjs), [profile paths](../paths.mjs),
 * [storage lock](../../shared/file-lock.mjs), [parity checks](../../tests/autonomy-timers.test.mjs).
 * [Dispatcher](./legacy-dispatch.mjs) reserves and stamps a due timer under the same lock.
 * [Interval tasks](./store.mjs) are separate.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { withFileLock } from '../../shared/file-lock.mjs';
import { sessionDir } from '../paths.mjs';

function timersPath(env) {
  return path.resolve(path.dirname(sessionDir(env)), 'schedules.json');
}

async function readRecords(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const records = JSON.parse(raw);
  if (!Array.isArray(records)) throw new Error('Expected a timer array');
  return records;
}

function displayable(records) {
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

export async function legacyTimerSnapshot(env = process.env) {
  try {
    const file = await physicalTimersPath(env);
    return { file, timers: file ? displayable(await readRecords(file)) : [] };
  } catch (error) {
    console.error('[msb/autonomy] Could not read saved timers:', error.code || error.name);
    return { file: null, timers: [] };
  }
}

export async function listLegacyTimers(env = process.env) {
  return (await legacyTimerSnapshot(env)).timers;
}

async function writeRecords(file, records) {
  const { mode } = await fs.stat(file);
  const directory = await fs.mkdtemp(path.join(path.dirname(file), '.schedules-'));
  try {
    const temporary = path.join(directory, 'schedules.json');
    await fs.writeFile(temporary, JSON.stringify(records, null, 2), { flag: 'wx', mode: 0o600 });
    await fs.chmod(temporary, mode & 0o777);
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(error => {
      console.error('[msb/autonomy] Could not clean timer temporary directory:', error.code || error.name);
    });
  }
}

export async function changeLegacyTimer(id, { remove = false, env = process.env } = {}) {
  const file = await physicalTimersPath(env);
  if (!file) return [];
  return withFileLock(file, async () => {
    const records = await readRecords(file);
    if (!records.some(row => row?.id === id)) return displayable(records);
    const updated = remove
      ? records.filter(row => row?.id !== id)
      : records.map(row => row?.id === id ? { ...row, enabled: !row.enabled } : row);
    await writeRecords(file, updated);
    return displayable(updated);
  });
}

export async function publishLegacyTimerRun(file, timer, { reserve, now, env }) {
  await withFileLock(file, async () => {
    if (await physicalTimersPath(env) !== file) return;
    const records = await readRecords(file);
    const index = records.findIndex(row => row?.id === timer.id);
    if (index < 0 || !isDeepStrictEqual(records[index], timer)) return;
    const finishReservation = reserve();
    if (!finishReservation) return;

    try {
      const next = { ...timer, lastRunAt: new Date(now()).toISOString() };
      if (timer.type === 'once') next.enabled = false;
      records[index] = next;
      await writeRecords(file, records);
    } catch (error) {
      finishReservation(false);
      throw error;
    }
    finishReservation(true);
  });
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
