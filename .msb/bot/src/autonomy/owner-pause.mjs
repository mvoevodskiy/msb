/**
 * Per-bot STOP and the read-only fleet flag. The owner command serializes with
 * [reminder admission](./reminder-dispatch.mjs) and [timer confirmation](../telegram/pause-confirmation.mjs).
 * [Scheduler](./scheduler.mjs) registers active local interval turns here.
 * [Bulk removal](./task-removal.mjs) shares the locked STOP operation.
 * [Old pause ingress checks](../../tests/autonomy-pause.test.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '../../shared/file-lock.mjs';
import { actionRoot } from '../paths.mjs';
import { NO_STATE_WRITE, updateState } from '../state.mjs';
import { readOptionalJson, readRecordArray, syncPublishedRecord, writeRecordArray } from './record-file.mjs';
import { changeStoppedLegacyTimers } from './legacy-timers.mjs';

const activeTurns = new Map();

function stopPath(env) {
  return path.join(actionRoot(env), 'autonomy', 'STOP');
}

export function withAutonomyPauseLock(update, env = process.env) {
  return withFileLock(stopPath(env), update);
}

export async function readOwnerPauseGeneration(env = process.env) {
  try {
    const stat = await fs.lstat(stopPath(env), { bigint: true });
    return [stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs].join(':');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function timerQuestionPath(env) {
  return path.join(path.dirname(stopPath(env)), 'timer-pause-question.json');
}

export async function readAutonomyPause(env = process.env) {
  const [generation, remote] = await Promise.all([
    readOwnerPauseGeneration(env),
    readOptionalJson(path.join(actionRoot(env), 'remote-config.json')).catch(error => {
      throw new Error('Could not read the autonomy fleet flag', { cause: error });
    }),
  ]);
  const ownerStopped = Boolean(generation);
  const fleetStopped = remote?.autonomyGlobalStop === true;
  return { ownerStopped, fleetStopped, remote, stopped: ownerStopped || fleetStopped };
}

export function trackAutonomyTurn(env = process.env, { counted = true } = {}) {
  const file = stopPath(env);
  let turns = activeTurns.get(file);
  if (!turns) activeTurns.set(file, turns = new Map());
  const controller = new AbortController();
  turns.set(controller, counted);
  return {
    signal: controller.signal,
    release() {
      turns.delete(controller);
      if (!turns.size && activeTurns.get(file) === turns) activeTurns.delete(file);
    },
  };
}

function abortActiveTurns(file) {
  const turns = activeTurns.get(file);
  if (!turns) return 0;
  activeTurns.delete(file);
  let aborted = 0;
  for (const [controller, counted] of turns) {
    controller.abort();
    if (counted) aborted++;
  }
  return aborted;
}

async function unlinkIfPresent(file) {
  try { await fs.unlink(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function writeOwnerStop(file, now, reason = 'владелец сказал остановить') {
  try {
    await fs.writeFile(file, reason + '\n' + new Date(now).toISOString() + '\n', { flag: 'wx', mode: 0o600 });
  } catch (failure) {
    if (failure.code !== 'EEXIST') throw failure;
  }
}

async function ownerStopResult(file, env) {
  return { aborted: abortActiveTurns(file), generation: await readOwnerPauseGeneration(env) };
}

/** For callers already holding the pause lock and checking the active engine. */
export async function engageOwnerPauseLocked({ now, reason, env = process.env }) {
  const file = stopPath(env);
  await writeOwnerStop(file, now, reason);
  const result = await ownerStopResult(file, env);
  await syncPublishedRecord(file);
  return result;
}

export async function setOwnerPause(stop, { now, check, checkEngine, signal, env = process.env } = {}) {
  return withAutonomyPauseLock(async () => {
    signal?.throwIfAborted();
    let error = await check();
    if (error) return { error };
    const file = stopPath(env);
    // Read current engine after policy I/O and serialize only the stop marker
    // transition with ordinary in-process engine switches. No state.json write.
    await updateState(async state => {
      error = checkEngine(state);
      if (error) return NO_STATE_WRITE;
      signal?.throwIfAborted();
      if (stop) await writeOwnerStop(file, now);
      else await unlinkIfPresent(file);
      return NO_STATE_WRITE;
    }, env);
    if (error) return { error };
    if (stop) return ownerStopResult(file, env);

    await unlinkIfPresent(path.join(path.dirname(file), 'stop-notice.json')).catch(() => {});
    await unlinkIfPresent(timerQuestionPath(env)).catch(() => {});
    try {
      return { resumedTimers: await changeStoppedLegacyTimers(false, env) };
    } catch {
      return { timerResumeFailed: true };
    }
  }, env);
}

export async function saveTimerPauseQuestion(generation, message, env = process.env) {
  return withAutonomyPauseLock(async () => {
    if (!generation || await readOwnerPauseGeneration(env) !== generation) return false;
    await writeRecordArray(timerQuestionPath(env), [{ ...message, generation }], { create: true });
    return true;
  }, env);
}

export async function answerTimerPauseQuestion(message, stop, env = process.env) {
  if (!await readOwnerPauseGeneration(env)) return null;
  return withAutonomyPauseLock(async () => {
    const generation = await readOwnerPauseGeneration(env);
    const file = timerQuestionPath(env);
    const [question] = await readRecordArray(file);
    if (!generation || question?.generation !== generation ||
        question.chatId !== message.chatId || question.messageId !== message.messageId) return null;
    await unlinkIfPresent(file);
    if (!stop) return 0;
    try {
      return await changeStoppedLegacyTimers(true, env);
    } catch (error) {
      await writeRecordArray(file, [question], { create: true }).catch(() => {});
      throw error;
    }
  }, env);
}
