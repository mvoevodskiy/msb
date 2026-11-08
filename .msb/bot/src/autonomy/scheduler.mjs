import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { autonomyDir, ensureDir } from '../paths.mjs';
import { runAgentTurn } from '../agent/turn.mjs';
import { listTasks, saveTaskResult } from './store.mjs';
import { trySessionOperation } from '../agent/session-operation.mjs';

const START_DELAY_MS = 30_000;
const TICK_MS = 60_000;

/**
 * Упрощённый планировщик фоновых задач (аналог [msb/scheduler]).
 * Вход: [main](../main.mjs); [общий ход](../agent/turn.mjs) получает только prompt.
 * [Store](./store.mjs) условно сохраняет одну неизменённую задачу после каждого хода,
 * не весь старый список; active run не держит lock файла.
 * Проверки: [persistence](../../tests/autonomy-store-concurrency.test.mjs),
 * [compact guard](../../tests/autonomy-compact-guard.test.mjs). [Контракт](./README.md).
 */
export function startScheduler({ api, adminId, log = console.error, runTurn = runAgentTurn } = {}) {
  let stopped = false;
  let busy = false;

  log('[msb/scheduler] Starting (delay 30s)...');
  const boot = setTimeout(tick, START_DELAY_MS);
  const timer = setInterval(tick, TICK_MS);
  boot.unref?.();
  timer.unref?.();

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      const tasks = await listTasks();
      const now = Date.now();
      for (const snapshot of tasks) {
        // Another task can run for minutes; do not execute a since-edited/deleted task.
        const current = (await listTasks()).find(task => task.id === snapshot.id);
        if (!current || !isDeepStrictEqual(current, snapshot)) continue;
        const before = { ...current }, task = { ...current };
        if (task.enabled === false) continue;
        if ((task.nextAt || 0) > now) continue;
        if (!await runTask(task, api, adminId, log, runTurn)) continue;
        task.nextAt = now + Math.max(1, task.everyHours || 24) * 3600 * 1000;
        await saveTaskResult(before, task);
      }
    } catch (err) {
      log(`[msb/scheduler] tick error: ${err.message}`);
    } finally {
      busy = false;
    }
  }

  return {
    stop() {
      stopped = true;
      clearTimeout(boot);
      clearInterval(timer);
    },
    tickNow: tick,
  };
}

async function runTask(task, api, adminId, log, runTurn) {
  const release = trySessionOperation();
  if (!release) return false;
  try {
    await executeTask(task, api, adminId, log, runTurn);
    return true;
  } finally {
    release();
  }
}

async function executeTask(task, api, adminId, log, runTurn) {
  const dir = autonomyDir();
  ensureDir(dir);
  const runId = `${Date.now()}-${task.id.slice(0, 8)}`;
  log(`[msb/scheduler] run ${runId} task=${task.title}`);

  const result = await runTurn({
    prompt: [
      'Ты выполняешь фоновую задачу владельца в общей с чатом сессии.',
      'Сделай ровно то, что в задании. В конце — короткий итог.',
      '',
      `Задание:\n${task.prompt}`,
    ].join('\n'),
    autonomy: true,
  });

  const line = JSON.stringify({
    at: new Date().toISOString(),
    taskId: task.id,
    ok: result.ok,
    error: result.error || null,
    preview: (result.text || '').slice(0, 200),
  });
  await fs.appendFile(path.join(dir, 'runs.jsonl'), `${line}\n`);

  if (!result.ok && result.error === 'setup') {
    task.failStreak = (task.failStreak || 0) + 1;
    return;
  }

  const empty = !result.text?.trim();
  if (empty && task.silenceOk) {
    task.failStreak = 0;
    return;
  }

  if (!result.ok) {
    task.failStreak = (task.failStreak || 0) + 1;
    if (task.failStreak >= 3) {
      task.enabled = false;
      task.pausedUntil = Date.now() + Math.max(2, task.everyHours || 24) * 2 * 3600 * 1000;
    }
  } else {
    task.failStreak = 0;
  }

  if (adminId && api && (result.text || !task.silenceOk)) {
    const header = `🥷 <b>${escapeHtml(task.title)}</b>`;
    const body = escapeHtml((result.text || 'пустой прогон').slice(0, 3500));
    try {
      await api.sendMessage(adminId, `${header}\n\n${body}`, { parse_mode: 'HTML' });
    } catch (err) {
      log(`[msb/scheduler] notify failed: ${err.message}`);
    }
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
