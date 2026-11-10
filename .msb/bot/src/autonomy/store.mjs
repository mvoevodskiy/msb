/**
 * Единственный владелец tasks.json: read/modify/write под общим межпроцессным lock.
 * Входы: [Telegram](../telegram/bot.mjs) добавляет, [scheduler](./scheduler.mjs)
 * условно фиксирует результат одной задачи; runner не держит файловый lock.
 * [Paths](../paths.mjs), [lock](../../shared/file-lock.mjs),
 * [регрессии](../../tests/autonomy-store-concurrency.test.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { withFileLock } from '../../shared/file-lock.mjs';
import { autonomyDir, ensureDir } from '../paths.mjs';

function tasksPath(env = process.env) {
  return path.join(autonomyDir(env), 'tasks.json');
}

export async function listTasks(env = process.env) {
  try {
    const raw = await fs.readFile(tasksPath(env), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.tasks) ? data.tasks : [];
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

async function saveTasks(tasks, env = process.env) {
  const dir = autonomyDir(env);
  ensureDir(dir);
  const file = tasksPath(env);
  const tmp = `${file}.tmp.${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify({ tasks }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function addTask(partial, env = process.env) {
  const task = {
    id: partial.id || randomUUID(),
    title: partial.title || partial.prompt?.slice(0, 80) || 'задача',
    prompt: partial.prompt || '',
    everyHours: partial.everyHours ?? 24,
    enabled: partial.enabled !== false,
    silenceOk: Boolean(partial.silenceOk),
    nextAt: partial.nextAt || Date.now() + (partial.everyHours ?? 24) * 3600 * 1000,
    createdAt: new Date().toISOString(),
    failStreak: 0,
  };
  await withFileLock(path.resolve(tasksPath(env)), async () => {
    const tasks = await listTasks(env);
    tasks.push(task);
    await saveTasks(tasks, env);
  });
  return task;
}

export async function saveAllTasks(tasks, env = process.env) {
  // Explicit owner replacement only; a scheduler must never save its old snapshot.
  await withFileLock(path.resolve(tasksPath(env)), () => saveTasks(tasks, env));
}

/** Commit only execution fields, and only if the task has not changed since launch. */
export async function saveTaskResult(before, after, env = process.env) {
  return withFileLock(path.resolve(tasksPath(env)), async () => {
    const tasks = await listTasks(env);
    const index = tasks.findIndex(task => task.id === before.id);
    if (index < 0 || !isDeepStrictEqual(tasks[index], before)) return false;
    const next = { ...tasks[index] };
    for (const key of ['nextAt', 'failStreak', 'enabled', 'pausedUntil']) {
      if (Object.hasOwn(after, key)) next[key] = after[key];
    }
    tasks[index] = next;
    await saveTasks(tasks, env);
    return true;
  });
}

/**
 * Простой парсер «каждые N часов/дней …» → черновик задачи.
 */
export function tryParseScheduleMessage(text) {
  const t = text.trim();
  const m = t.match(/^каждые?\s+(\d+)\s*(час(?:а|ов)?|ч|дня|дней|день|сутк\w*)\s*[:\-]?\s*(.+)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const prompt = m[3].trim();
  if (!prompt || !Number.isFinite(n) || n < 1) return null;
  const everyHours = /час|^ч$/.test(unit) ? n : n * 24;
  if (everyHours < 1) return null;
  return { everyHours, prompt, title: prompt.slice(0, 80) };
}
