/**
 * Legacy schedules.json belongs to the bot's session directory parent.
 * [Telegram management](../telegram/routes/autonomy.mjs), [profile paths](../paths.mjs),
 * [storage lock](../../shared/file-lock.mjs), [parity checks](../../tests/autonomy-timers.test.mjs).
 * Reads and updates only saved timers. [Interval tasks](./store.mjs) are separate.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
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

export async function listLegacyTimers(env = process.env) {
  try {
    return displayable(await readRecords(timersPath(env)));
  } catch (error) {
    console.error('[msb/autonomy] Could not read saved timers:', error.code || error.name);
    return [];
  }
}

export async function changeLegacyTimer(id, { remove = false, env = process.env } = {}) {
  let file;
  try {
    file = await fs.realpath(timersPath(env));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return withFileLock(file, async () => {
    const records = await readRecords(file);
    if (!records.some(row => row?.id === id)) return displayable(records);
    const updated = remove
      ? records.filter(row => row?.id !== id)
      : records.map(row => row?.id === id ? { ...row, enabled: !row.enabled } : row);
    const { mode } = await fs.stat(file);
    const directory = await fs.mkdtemp(path.join(path.dirname(file), '.schedules-'));
    try {
      const temporary = path.join(directory, 'schedules.json');
      await fs.writeFile(temporary, JSON.stringify(updated, null, 2), { flag: 'wx', mode: 0o600 });
      await fs.chmod(temporary, mode & 0o777);
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
    return displayable(updated);
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
