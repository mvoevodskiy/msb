import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { autonomyDir, ensureDir } from '../paths.mjs';
import { runAgentTurn } from '../agent/turn.mjs';
import { listTasks, saveTaskResult } from './store.mjs';
import { trySessionOperation } from '../agent/session-operation.mjs';
import { readAutonomyPause, trackAutonomyTurn } from './owner-pause.mjs';
import { createReminderDispatcher } from './reminder-dispatch.mjs';
import { dispatchLegacyTimers } from './legacy-dispatch.mjs';

const START_DELAY_MS = 30_000;
const TICK_MS = 60_000;

/**
 * Упрощённый планировщик фоновых задач (аналог [msb/scheduler]).
 * Вход: [main](../main.mjs). [Сохранённые таймеры](./legacy-dispatch.mjs) идут
 * в [очередь Telegram](../telegram/inbox.mjs), [напоминания](./reminder-dispatch.mjs)
 * отправляются напрямую, интервальные задачи используют [runner](../agent/turn.mjs).
 * [Owner pause](./owner-pause.mjs) blocks admission and interrupts an active interval.
 * [Store](./store.mjs) условно сохраняет одну неизменённую задачу после каждого хода,
 * не весь старый список; active run не держит lock файла.
 * Проверки: [persistence](../../tests/autonomy-store-concurrency.test.mjs),
 * [compact guard](../../tests/autonomy-compact-guard.test.mjs). [Контракт](./README.md).
 */
export function startScheduler({ api, adminId, scheduledTurns, timezone, now = Date.now,
  log = console.error, runTurn = runAgentTurn } = {}) {
  let stopped = false;
  let busy = false;
  let legacyTick, reminderTick;
  const shutdown = new AbortController();
  const reminders = createReminderDispatcher({ api, adminId, timezone, now, log, signal: shutdown.signal });

  log('[msb/scheduler] Starting (delay 30s)...');
  const boot = setTimeout(tick, START_DELAY_MS);
  const timer = setInterval(tick, TICK_MS);
  boot.unref?.();
  timer.unref?.();

  async function tick() {
    if (stopped) return;
    const direct = dispatchReminders();
    if (busy) return direct;
    busy = true;
    const stopEpoch = scheduledTurns?.stopEpoch;
    const isInterrupted = () => stopped || scheduledTurns?.stopEpoch !== stopEpoch;
    try {
      if (scheduledTurns) {
        legacyTick = dispatchLegacyTimers({ scheduledTurns, timezone, now, isInterrupted })
          .catch(error => log('[msb/scheduler] legacy timer error: ' + error.message));
        try { await legacyTick; } finally { legacyTick = undefined; }
      }
      if (isInterrupted() || scheduledTurns?.pending) return;
      const tasks = await listTasks();
      const tickAt = now();
      for (const snapshot of tasks) {
        if (stopped) break;
        // Another task can run for minutes; do not execute a since-edited/deleted task.
        const current = (await listTasks()).find(task => task.id === snapshot.id);
        if (!current || !isDeepStrictEqual(current, snapshot)) continue;
        const before = { ...current }, task = { ...current };
        if (task.enabled === false) continue;
        if ((task.nextAt || 0) > tickAt) continue;
        if (!await runTask(task, api, adminId, log, runTurn, () => stopped)) continue;
        task.nextAt = tickAt + Math.max(1, task.everyHours || 24) * 3600 * 1000;
        await saveTaskResult(before, task);
      }
    } catch (err) {
      log(`[msb/scheduler] tick error: ${err.message}`);
    } finally {
      busy = false;
      await direct;
    }
  }

  function dispatchReminders() {
    // A slow Telegram send must not make the existing timer pass miss its minute.
    reminderTick ??= reminders(() => stopped).catch(error => {
      log('[msb/scheduler] reminder error: ' + (error.code || error.name));
    }).finally(() => { reminderTick = undefined; });
    return reminderTick;
  }

  return {
    stop() {
      stopped = true;
      shutdown.abort();
      clearTimeout(boot);
      clearInterval(timer);
      return Promise.all([legacyTick, reminderTick]);
    },
    tickNow: tick,
  };
}

async function runTask(task, api, adminId, log, runTurn, isStopped) {
  const release = trySessionOperation();
  if (!release) return false;
  try {
    return await executeTask(task, api, adminId, log, runTurn, isStopped);
  } finally {
    release();
  }
}

async function executeTask(task, api, adminId, log, runTurn, isStopped) {
  const turn = trackAutonomyTurn();
  const { signal } = turn;
  let result;
  try {
    if ((await readAutonomyPause()).stopped || signal.aborted || isStopped()) return false;
    log('[msb/scheduler] run ' + Date.now() + '-' + task.id.slice(0, 8) + ' task=' + task.title);
    result = await runTurn({
      prompt: [
        'Ты выполняешь фоновую задачу владельца в общей с чатом сессии.',
        'Сделай ровно то, что в задании. В конце — короткий итог.',
        '',
        'Задание:\n' + task.prompt,
      ].join('\n'),
      autonomy: true,
      signal,
    });
  } catch (error) {
    if (signal.aborted) return false;
    throw error;
  } finally {
    turn.release();
  }
  if (signal.aborted) return false;

  const dir = autonomyDir();
  ensureDir(dir);
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
    return true;
  }

  const empty = !result.text?.trim();
  if (empty && task.silenceOk) {
    task.failStreak = 0;
    return true;
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
  return true;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
