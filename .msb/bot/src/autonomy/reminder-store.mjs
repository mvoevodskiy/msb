/**
 * Per-bot actions.json for saved literal and model actions. Keep tasks.json and legacy timer
 * files separate. [Marker](../telegram/reminder-markers.mjs), [sender](./reminder-dispatch.mjs),
 * [menu](../telegram/routes/autonomy.mjs), [individual state](./saved-action-control.mjs),
 * [read-only inventory](./saved-task-inspection.mjs),
 * [contract](../../tests/reference/parity-autonomy-contract.txt).
 */
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { withFileLock } from '../../shared/file-lock.mjs';
import { actionRoot } from '../paths.mjs';
import { physicalRecordPath, readOptionalJson, readRecordArray, writeRecordArray } from './record-file.mjs';
import { recordReminderBreaker } from './reminder-breaker.mjs';
import { reminderSpacing, spentReminder, validReminderTrigger } from './reminder-schedule.mjs';
import { planSavedActionControl, savedActionWithEnabled, selectSavedAction,
  unavailableSavedActionControl } from './saved-action-control.mjs';

function actionFile(env) {
  return physicalRecordPath(path.join(actionRoot(env), 'actions.json'));
}

export async function readNativeJobMap(env) {
  const jobs = await readOptionalJson(path.join(actionRoot(env), 'autonomy', 'cron-jobs.json'));
  if (jobs === undefined) return {};
  if (jobs === null || typeof jobs !== 'object' || Array.isArray(jobs)) throw new Error('Expected native job mapping');
  return jobs;
}

export function isLocalSavedAction(action, jobs) {
  if (typeof action?.id !== 'string' || typeof action.name !== 'string' || !validReminderTrigger(action.trigger) ||
      action.pendingConfirm || action.migratedToOc || ![undefined, 'auto', 'cc'].includes(action.runner) ||
      Object.hasOwn(jobs, action.id)) return false;
  const task = action.task;
  if (task?.kind === 'reminder') return typeof task.text === 'string' && Boolean(task.text.trim()) && !task.followUp;
  return task?.kind === 'prompt' && typeof task.prompt === 'string' && Boolean(task.prompt.trim());
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

export async function readSavedActionRecords(env = process.env) {
  const file = await actionFile(env);
  return { file, records: await readRecordArray(file) };
}

export async function savedActionSnapshot(env = process.env) {
  const { file, records } = await readSavedActionRecords(env);
  const jobs = await readNativeJobMap(env);
  return { file, actions: records.filter(action => isLocalSavedAction(action, jobs)) };
}

export async function addSavedAction(action, { env = process.env, signal, commit = publish => publish() } = {}) {
  return withActions(env, async (records, save) => {
    const value = env.AUTONOMY_MAX_ACTIONS;
    const number = value === undefined || value === '' ? 20 : Number(value);
    const max = Number.isFinite(number) && number >= 0 ? number : 20;
    if (max > 0 && records.filter(row => row?.enabled).length + 1 > max) {
      return { error: 'Не получилось: достигнут лимит активных автодействий (' + max +
        '). Отключи или удали лишние — или скажи мне: «подними предел задач», и места станет больше.' };
    }
    return commit(async () => {
      const base = 'conv-' + action.task.kind + '-' + action.createdAt.replace(/[:.]/g, '-');
      let id = base;
      for (let suffix = 2; records.some(row => row?.id === id); suffix++) id = base + '-' + suffix;
      const saved = { ...action, id };
      records.push(saved);
      await save();
      return { action: saved, previous: records.slice(0, -1) };
    });
  }, { signal, create: true });
}

// A stale row or newly native schedule cannot be claimed or revised by the local brake.
export async function withCurrentSavedAction(file, snapshot, update, env = process.env) {
  if (await actionFile(env) !== file) return null;
  return withActions(env, async (records, save) => {
    if (await actionFile(env) !== file) return null;
    const index = records.findIndex(action => action?.id === snapshot.id);
    const action = records[index];
    if (!isDeepStrictEqual(action, snapshot) || !isLocalSavedAction(action, await readNativeJobMap(env))) return null;
    return update(action, async next => {
      records[index] = next;
      await save();
      return next;
    });
  });
}

export function claimSavedAction(file, snapshot, at, { env = process.env, admit } = {}) {
  return withCurrentSavedAction(file, snapshot, (action, save) => admit(action, refusal => {
    const claimed = { ...action, lastRunAt: at };
    if (action.trigger.kind === 'once') {
      claimed.enabled = false;
      claimed.disabledReason = 'spent_once';
    }
    if (refusal) {
      claimed.lastStatus = 'skipped';
      claimed.lastOutcome = 'blocked';
      delete claimed.lastError;
    }
    return save(claimed);
  }), env);
}

function sameReminderClaim(current, claimed) {
  if (isDeepStrictEqual(current, claimed)) return true;
  if (!current || spentReminder(claimed)) return false;
  const ownerToggle = current.enabled === false && current.disabledReason === 'owner' ||
    current.enabled === true && current.disabledReason === undefined;
  const withoutToggle = ({ enabled, disabledReason, ...attempt }) => attempt;
  return ownerToggle && isDeepStrictEqual(withoutToggle(current), withoutToggle(claimed));
}

export async function finishSavedAction(file, before, claimed, result, env = process.env) {
  if (await actionFile(env) !== file) return;
  return withActions(env, async (records, save) => {
    if (await actionFile(env) !== file) return;
    const index = records.findIndex(action => action?.id === claimed.id);
    const current = records[index];
    if (!sameReminderClaim(current, claimed) || !isLocalSavedAction(current, await readNativeJobMap(env))) return;
    // Preserve the old unstamped stop until a scoped file commit can have published.
    // Keep that attempt consumed just as a partially delivered result cannot be replayed.
    if (result.status === 'stopped' || result.status === 'deferred') {
      if (result.status === 'stopped' && result.fileCommitStarted) {
        records[index] = { ...current, lastStatus: 'stopped', lastOutcome: 'stopped', lastError: undefined };
      } else {
        records[index] = isDeepStrictEqual(current, claimed) ? before : { ...current, lastRunAt: before.lastRunAt };
      }
      await save();
      return;
    }
    // A replacement may reuse the id. An owner's pause alone retains this claim.
    const minBackoffSeconds = Math.max(0, Math.round((reminderSpacing(claimed.trigger) ?? 0) * 120));
    const breakerResult = result.status === 'error' ? result : { status: 'ok' };
    const breaker = await recordReminderBreaker(claimed.id, claimed.lastRunAt, breakerResult, {
      env, lockedActionFile: file, minBackoffSeconds,
    }).then(event => ({ event }), breakerError => ({ breakerError }));
    const outcomes = { ok: 'ok', error: 'engine_error', skipped: 'empty' };
    records[index] = { ...current, lastStatus: result.status, lastOutcome: result.outcome ?? outcomes[result.status], lastError: result.error };
    const actionError = await save().then(() => undefined, error => error);
    return { ...breaker, actionError };
  });
}

export async function savedActionClaimIsCurrent(file, claimed, env = process.env) {
  if (await actionFile(env) !== file) return false;
  const rows = await readRecordArray(file);
  const current = rows.find(row => row?.id === claimed.id);
  return isDeepStrictEqual(current, claimed) && isLocalSavedAction(current, await readNativeJobMap(env));
}

export async function setNamedSavedActionEnabled(selector, enabled, { env = process.env, signal, commit = publish => publish() } = {}) {
  const query = selector.trim();
  if (!query) {
    return { error: enabled ? 'Уточни, какую задачу вернуть в работу.' : 'Уточни, какую задачу поставить на паузу.' };
  }
  return withActions(env, (records, save) => commit(async () => {
    const target = selectSavedAction(records, query);
    if (!target.action) return target;
    const { action } = target;
    if (!isLocalSavedAction(action, await readNativeJobMap(env))) return { error: unavailableSavedActionControl(action) };
    const change = planSavedActionControl(action, enabled);
    if (change.changed) {
      records[records.indexOf(action)] = change.action;
      await save();
    }
    return change;
  }), { signal });
}

export async function changeSavedAction(id, remove, env = process.env) {
  await withActions(env, async (records, save) => {
    const index = records.findIndex(action => action?.id === id);
    const action = records[index];
    if (!isLocalSavedAction(action, await readNativeJobMap(env)) || (!remove && spentReminder(action))) return;
    if (remove) records.splice(index, 1);
    else records[index] = savedActionWithEnabled(action, !action.enabled);
    await save();
  });
}
