/**
 * Old per-bot runs.jsonl for direct reminders. [Dispatcher](./reminder-dispatch.mjs)
 * writes; [Telegram history](./history.mjs) and Pult read the same records.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { actionRoot } from './reminder-policy.mjs';

export function reminderRunPath(env = process.env) {
  return path.join(actionRoot(env), 'autonomy', 'runs.jsonl');
}

export async function appendReminderRun(action, ts, result) {
  const file = reminderRunPath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const row = {
    ts, actionId: action.id, kind: 'reminder', name: action.name,
    status: result.status, costUsd: 0, costVisible: true, format: 'tg-message',
    detail: result.error || 'напоминание доставлено',
  };
  await fs.appendFile(file, JSON.stringify(row) + '\n', { mode: 0o600 });
}

export function parseReminderRun(row) {
  if (row?.kind !== 'reminder' || !['ok', 'error'].includes(row.status)) return undefined;
  if (typeof row.ts !== 'string' || !Number.isFinite(Date.parse(row.ts)) || typeof row.actionId !== 'string') return null;
  return { at: row.ts, taskId: row.actionId, name: row.name, ok: row.status === 'ok',
    ...(row.status === 'error' ? { error: row.detail } : {}) };
}
