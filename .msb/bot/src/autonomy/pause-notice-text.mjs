/**
 * Current bot's STOP age and live task counts for its reminder and Settings examples.
 * The [pause writer](./owner-pause.mjs) stores the timestamp on the second line.
 * Older one-line markers use their file modification time.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { actionRoot } from '../paths.mjs';
import { listTasks } from './store.mjs';
import { listLegacyTimers } from './legacy-timers.mjs';
import { savedActionSnapshot } from './reminder-store.mjs';
import { savedTaskSpent } from './reminder-schedule.mjs';

export const PAUSE_OFF_BUTTON = { text: '▶️ Снять паузу', callback_data: 'pause-off' };

export async function readPauseNoticeSnapshot(env = process.env) {
  const stop = path.join(actionRoot(env), 'autonomy', 'STOP');
  let since;
  try {
    const stamp = (await fs.readFile(stop, 'utf8')).split('\n')[1];
    since = Date.parse(stamp);
    if (!Number.isFinite(since)) since = (await fs.stat(stop)).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const [{ actions }, intervals, timers] = await Promise.all([
    savedActionSnapshot(env), listTasks(env), listLegacyTimers(env),
  ]);
  return {
    since,
    tasks: actions.filter(action => action.enabled && !savedTaskSpent(action)).length
      + intervals.filter(task => task.enabled !== false).length,
    timers: timers.filter(timer => timer.enabled !== false).length,
  };
}

export function formatPauseNotice({ since, now, timezone, tasks, timers = 0 }) {
  const days = Math.max(1, Math.floor((now - since) / 86_400_000));
  const dayWord = { one: 'день', few: 'дня', many: 'дней' }[new Intl.PluralRules('ru').select(days)];
  const options = { month: 'long', day: 'numeric', timeZone: timezone || 'UTC' };
  let date;
  try { date = new Intl.DateTimeFormat('ru-RU', options).format(since); }
  catch { date = new Intl.DateTimeFormat('ru-RU', { ...options, timeZone: 'UTC' }).format(since); }
  let text = `Фон стоит с ${date} (${days} ${dayWord}): задач ${tasks}, они не ходят.`;
  text += ` Нажми «${PAUSE_OFF_BUTTON.text}» или напиши «сними паузу», чтобы вернуть их. Если они больше не нужны, напиши «отмени все задачи».`;
  if (timers) text += ` Старых таймеров ${timers}, они идут: общий стоп их не касается. Скажи «покажи таймеры», а потом «выключи таймер» и его имя, если нужно остановить и их.`;
  return text;
}
