/**
 * Old per-bot runs.jsonl for local saved actions. [Dispatcher](./reminder-dispatch.mjs)
 * writes; [Telegram menu](./history.mjs), [conversation report](./saved-task-runs.mjs)
 * and Pult read the same records.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { actionRoot } from '../paths.mjs';

export function reminderRunPath(env = process.env) {
  return path.join(actionRoot(env), 'autonomy', 'runs.jsonl');
}

export async function appendSavedActionRun(action, ts, result,
  { costVisible = action.task.kind === 'reminder', format = 'tg-message', env = process.env } = {}) {
  const file = reminderRunPath(env);
  if (result.nativeJobId && (await readSavedActionRunTail(Infinity, env)).some(row => row?.nativeJobId === result.nativeJobId)) return;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const row = {
    ts, actionId: action.id, kind: action.task.kind, name: action.name,
    status: result.status, costUsd: 0, costVisible, format,
    detail: result.detail || result.error || 'напоминание доставлено',
    tokensIn: result.tokensIn, tokensOut: result.tokensOut, meteredUsd: result.meteredUsd,
    usageIncomplete: result.usageIncomplete || undefined, nativeJobId: result.nativeJobId,
  };
  await fs.appendFile(file, JSON.stringify(row) + '\n', { mode: 0o600 });
}

// [Inspection](./saved-task-inspection.mjs) and the legacy frequency brake use the same tail.
export async function readSavedActionRunTail(limit, env = process.env) {
  const raw = await fs.readFile(reminderRunPath(env), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const lines = raw.split('\n');
  const rows = [];
  for (let index = lines.length - 1; index >= 0 && rows.length < limit; index--) {
    try { rows.push(JSON.parse(lines[index])); }
    catch { /* An incomplete line does not consume a slot. */ }
  }
  return rows;
}

export async function latestSavedActionRun(actionId, limit, env = process.env) {
  const rows = await readSavedActionRunTail(limit, env).catch(() => []);
  return rows.find(row => row?.actionId === actionId);
}

export function parseSavedActionRun(row) {
  if (!['reminder', 'prompt'].includes(row?.kind)) return undefined;
  const completed = ['ok', 'error', 'blocked', 'skipped'].includes(row.status);
  if (!completed && !(row.kind === 'prompt' && ['stopped', 'deferred'].includes(row.status))) return undefined;
  if (typeof row.ts !== 'string' || !Number.isFinite(Date.parse(row.ts)) || typeof row.actionId !== 'string') return null;
  const skipped = row.status !== 'ok' && row.status !== 'error';
  return { at: row.ts, taskId: row.actionId, name: row.name, ok: row.status === 'ok',
    ...(row.status === 'error' ? { error: row.detail } : {}),
    ...(skipped ? { status: row.status, detail: row.detail } : {}) };
}
