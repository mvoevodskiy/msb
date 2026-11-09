/**
 * Per-bot actions.json for ordinary once/reminder. Keep interval and legacy timer
 * files separate. [Marker](../telegram/reminder-markers.mjs), [sender](./reminder-dispatch.mjs),
 * [menu](../telegram/routes/autonomy.mjs), [contract](../../tests/reference/parity-autonomy-contract.txt).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { withFileLock } from '../../shared/file-lock.mjs';
import { actionRoot } from '../paths.mjs';
import { readOptionalJson, readRecordArray, writeRecordArray } from './record-file.mjs';

async function actionFile(env) {
  const logical = path.join(actionRoot(env), 'actions.json');
  try {
    return await fs.realpath(logical);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    try {
      await fs.lstat(logical);
    } catch (missing) {
      if (missing?.code === 'ENOENT') return logical;
      throw missing;
    }
    throw error;
  }
}

export async function readNativeJobMap(env) {
  const jobs = await readOptionalJson(path.join(actionRoot(env), 'autonomy', 'cron-jobs.json'));
  if (jobs === undefined) return {};
  if (jobs === null || typeof jobs !== 'object' || Array.isArray(jobs)) throw new Error('Expected native job mapping');
  return jobs;
}

function isLocalReminder(action, jobs) {
  return typeof action?.id === 'string' && typeof action.name === 'string' &&
    action.trigger?.kind === 'once' && typeof action.trigger.at === 'string' &&
    Number.isFinite(Date.parse(action.trigger.at)) && action.task?.kind === 'reminder' &&
    typeof action.task.text === 'string' && Boolean(action.task.text.trim()) &&
    !action.task.followUp && !action.pendingConfirm && !action.migratedToOc &&
    (action.runner === undefined || action.runner === 'auto' || action.runner === 'cc') &&
    !Object.hasOwn(jobs, action.id);
}

async function withActions(env, update, { signal, create } = {}) {
  signal?.throwIfAborted();
  const file = await actionFile(env);
  return withFileLock(file, async () => {
    signal?.throwIfAborted();
    if (await actionFile(env) !== file) throw new Error('Action file changed');
    const records = await readRecordArray(file);
    return update(records, async () => {
      if (await actionFile(env) !== file) throw new Error('Action file changed');
      await writeRecordArray(file, records, { signal, create });
    });
  });
}

export async function reminderSnapshot(env = process.env) {
  const file = await actionFile(env);
  const records = await readRecordArray(file);
  const jobs = await readNativeJobMap(env);
  return { file, actions: records.filter(action => isLocalReminder(action, jobs)) };
}

export async function addReminder(action, { env = process.env, signal, check } = {}) {
  return withActions(env, async (records, save) => {
    const value = env.AUTONOMY_MAX_ACTIONS;
    const number = value === undefined || value === '' ? 20 : Number(value);
    const max = Number.isFinite(number) && number >= 0 ? number : 20;
    if (max > 0 && records.filter(row => row?.enabled).length + 1 > max) {
      return { error: 'Не получилось: достигнут лимит активных автодействий (' + max +
        '). Отключи или удали лишние.' };
    }
    const error = await check?.();
    if (error) return { error };
    const base = 'conv-reminder-' + action.createdAt.replace(/[:.]/g, '-');
    let id = base;
    for (let suffix = 2; records.some(row => row?.id === id); suffix++) id = base + '-' + suffix;
    const saved = { ...action, id };
    records.push(saved);
    await save();
    return { action: saved };
  }, { signal, create: true });
}

export async function claimReminder(file, snapshot, at, { env = process.env, canRun } = {}) {
  if (await actionFile(env) !== file) return null;
  return withActions(env, async (records, save) => {
    if (await actionFile(env) !== file) return null;
    const index = records.findIndex(action => action?.id === snapshot.id);
    const action = records[index];
    if (!isDeepStrictEqual(action, snapshot) || !isLocalReminder(action, await readNativeJobMap(env))) return null;
    if (!action.enabled || action.lastRunAt || action.budget?.killSwitch ||
        action.disabledReason === 'frequency' || Date.parse(action.trigger.at) > Date.parse(at)) return null;
    if (!await canRun()) return null;
    const claimed = { ...action, enabled: false, disabledReason: 'spent_once', lastRunAt: at };
    records[index] = claimed;
    await save();
    return claimed;
  });
}

export async function finishReminder(file, claimed, result, env = process.env) {
  if (await actionFile(env) !== file) return;
  await withActions(env, async (records, save) => {
    if (await actionFile(env) !== file) return;
    const index = records.findIndex(action => action?.id === claimed.id);
    if (!isDeepStrictEqual(records[index], claimed)) return;
    records[index] = { ...claimed, lastStatus: result.status, lastError: result.error };
    await save();
  });
}

export async function changeReminder(id, remove, env = process.env) {
  await withActions(env, async (records, save) => {
    const index = records.findIndex(action => action?.id === id);
    const action = records[index];
    if (!isLocalReminder(action, await readNativeJobMap(env)) || (!remove && action.lastRunAt)) return;
    if (remove) records.splice(index, 1);
    else records[index] = { ...action, enabled: !action.enabled, disabledReason: action.enabled ? 'owner' : undefined };
    await save();
  });
}
