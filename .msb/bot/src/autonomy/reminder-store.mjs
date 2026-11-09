/**
 * Per-bot actions.json for saved literal and model actions. Keep tasks.json and legacy timer
 * files separate. [Marker](../telegram/reminder-markers.mjs), [sender](./reminder-dispatch.mjs),
 * [menu](../telegram/routes/autonomy.mjs), [individual state](./saved-action-control.mjs),
 * [inventory](./saved-task-inspection.mjs), [task removal](./task-removal.mjs), [reschedule](./saved-task-reschedule.mjs),
 * [contract](../../tests/reference/parity-autonomy-contract.txt).
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { withFileLock } from '../../shared/file-lock.mjs';
import { actionRoot } from '../paths.mjs';
import { physicalRecordPath, readOptionalJson, readRecordArray, writeRecordArray } from './record-file.mjs';
import { recordReminderBreaker } from './reminder-breaker.mjs';
import { reminderSpacing, savedTaskSpent, spentReminder, validReminderTrigger } from './reminder-schedule.mjs';
import { archiveSavedActions } from './task-removal-archive.mjs';
import { matchingSavedActions, planSavedActionControl, savedActionWithEnabled, selectSavedAction,
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

function localActionScope(action, jobs) {
  return !action.migratedToOc && [undefined, 'auto', 'cc'].includes(action.runner) && !Object.hasOwn(jobs, action.id);
}

export function isLocalSavedAction(action, jobs) {
  if (typeof action?.id !== 'string' || typeof action.name !== 'string' || !validReminderTrigger(action.trigger) ||
      action.pendingConfirm || !localActionScope(action, jobs)) return false;
  const task = action.task;
  if (task?.kind === 'reminder') return typeof task.text === 'string' && Boolean(task.text.trim()) && !task.followUp;
  return task?.kind === 'prompt' && typeof task.prompt === 'string' && Boolean(task.prompt.trim());
}

export async function withActions(env, update, { signal, create, expectedFile } = {}) {
  signal?.throwIfAborted();
  const file = await actionFile(env);
  if (expectedFile && file !== expectedFile) return null;
  return withFileLock(file, async () => {
    signal?.throwIfAborted();
    if (await actionFile(env) !== file) throw new Error('Action file changed');
    const records = await readRecordArray(file);
    return update(records, async beforePublish => {
      if (await actionFile(env) !== file) throw new Error('Action file changed');
      await writeRecordArray(file, records, { signal, create, beforePublish });
    }, file);
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

const taskFingerprint = action => createHash('sha256').update(JSON.stringify(action)).digest('hex');
export function taskDefinitionFingerprint(action) {
  // Scheduler outcomes or an owner's pause do not replace this task.
  const { enabled, disabledReason, lastRunAt, lastStatus, lastOutcome, lastError, ...definition } = action;
  return taskFingerprint(definition);
}
const spentTaskCandidate = action => ({ id: action.id, fingerprint: taskFingerprint(action) });
const namedTaskCandidate = action => ({ id: action.id, fingerprint: taskDefinitionFingerprint(action) });
const savedTaskRecord = action => typeof action?.id === 'string' && typeof action.name === 'string';
const enabledSpentTask = action => savedTaskRecord(action) && action.enabled && savedTaskSpent(action);

// On OC, an automatic old row without a mapping is not affirmative local ownership.
function ownedForRemoval(action, jobs, rail) {
  return localActionScope(action, jobs) && (rail !== 'oc' || action.runner === 'cc');
}

export function spentTaskCandidates(spent, jobs) {
  if (!jobs) return [];
  return spent.filter(action => localActionScope(action, jobs)).map(spentTaskCandidate);
}

function checkRemovalSnapshot(snapshot, named = false) {
  if (typeof snapshot?.file !== 'string' || !snapshot.file || !Array.isArray(snapshot.candidates) ||
      (named && snapshot.candidates.length !== 1)) throw new Error('Invalid task removal snapshot');
}

async function removeCandidates({ records, save, file, env, rail, candidates, eligible, fingerprint = taskFingerprint, jobs }) {
  const removed = [], failed = [];
  let changed = false, missing = false;
  if (candidates.length) {
    jobs ??= await readNativeJobMap(env);
    for (const candidate of candidates) {
      const index = records.findIndex(action => action?.id === candidate.id && fingerprint(action) === candidate.fingerprint);
      const action = records[index];
      if (!eligible(action)) {
        changed = true;
        missing ||= !records.some(row => row?.id === candidate.id);
        continue;
      }
      if (!ownedForRemoval(action, jobs, rail)) {
        failed.push(action.name);
        continue;
      }
      removed.push(action);
      records.splice(index, 1);
    }
  }
  if (removed.length) await save(async () => {
    if (await actionFile(env) !== file) throw new Error('Action file changed');
    const latestJobs = await readNativeJobMap(env);
    if (removed.some(action => !ownedForRemoval(action, latestJobs, rail))) {
      throw new Error('A local removal candidate gained a native binding');
    }
  });
  return { removed: removed.map(action => action.name), failed, changed, missing };
}

export function removeSpentTasks({ snapshot, rail, env = process.env, signal, commit = publish => publish() } = {}) {
  if (snapshot) checkRemovalSnapshot(snapshot);
  return withActions(env, (records, save, file) => commit(() => removeCandidates({
    records, save, file, env, rail, eligible: enabledSpentTask,
    candidates: snapshot ? snapshot.candidates : records.filter(enabledSpentTask).map(spentTaskCandidate),
  })), { expectedFile: snapshot?.file, signal });
}

export function cancelNamedSavedTasks(query, { rail, env = process.env, signal, commit = publish => publish() } = {}) {
  return withActions(env, (records, save, file) => commit(async () => {
    if (!query) return { error: 'Уточни, какую задачу отменить.' };
    const matches = matchingSavedActions(records, query);
    if (!matches.length) return { error: 'Не нашёл задачу «' + query + '».' };
    const [action] = matches;
    if (!matches.every(savedTaskSpent)) {
      if (matches.length > 1) return { choices: matches };
      const jobs = await readNativeJobMap(env);
      if (!ownedForRemoval(action, jobs, rail)) return { unavailable: action.name };
      return { action, snapshot: { file, candidates: [namedTaskCandidate(action)] } };
    }
    const result = await removeCandidates({ records, save, file, env, rail,
      candidates: matches.map(spentTaskCandidate), eligible: savedTaskSpent });
    return { ...result, action, group: matches.length > 1 };
  }), { signal });
}

export function removeConfirmedNamedTask(snapshot, { rail, env = process.env, commit = publish => publish() } = {}) {
  checkRemovalSnapshot(snapshot, true);
  return withActions(env, (records, save, file) => commit(() => removeCandidates({
    records, save, file, env, rail, candidates: snapshot.candidates,
    eligible: savedTaskRecord, fingerprint: taskDefinitionFingerprint,
  })), { expectedFile: snapshot.file });
}

export async function planAllSavedTasks(env = process.env) {
  const { file, records } = await readSavedActionRecords(env);
  if (!records.every(savedTaskRecord)) throw new Error('Invalid saved task records');
  return { names: records.map(action => action.name), snapshot: { file, candidates: records.map(namedTaskCandidate) } };
}

function withinApprovedGroup(records, candidates) {
  const key = ({ id, fingerprint }) => JSON.stringify([id, fingerprint]);
  const approved = new Map();
  for (const candidate of candidates) {
    const ref = key(candidate);
    approved.set(ref, (approved.get(ref) ?? 0) + 1);
  }
  return records.every(action => {
    if (!savedTaskRecord(action)) return false;
    const ref = key(namedTaskCandidate(action));
    const count = approved.get(ref);
    if (!count) return false;
    approved.set(ref, count - 1);
    return true;
  });
}

export function removeConfirmedAllTasks(snapshot, { rail, now, markApplying, engageStop, env = process.env,
  commit = publish => publish() } = {}) {
  checkRemovalSnapshot(snapshot);
  if (!snapshot.candidates.length) throw new Error('Empty bulk removal snapshot');
  return withActions(env, (records, save, file) => commit(async () => {
    if (!withinApprovedGroup(records, snapshot.candidates)) return { stale: true };
    await markApplying();
    try { await engageStop(); }
    catch { return { failure: 'pause' }; }
    let archive;
    if (records.length) {
      try { archive = await archiveSavedActions(file, records, now); }
      catch { return { failure: 'archive' }; }
    }
    try {
      const jobs = await readNativeJobMap(env);
      const result = await removeCandidates({ records, save, file, env, rail, jobs,
        candidates: records.map(namedTaskCandidate), eligible: savedTaskRecord, fingerprint: taskDefinitionFingerprint });
      const nativeMayStillRun = result.failed.length > 0 ||
        Object.values(jobs).some(job => job?.jobId && job.enabled !== false && !job.pausedBy);
      return { ...result, archive, nativeMayStillRun };
    } catch {
      // The atomic action rename has not completed on this path.
      return { failure: 'remove', archive };
    }
  }), { expectedFile: snapshot.file });
}
