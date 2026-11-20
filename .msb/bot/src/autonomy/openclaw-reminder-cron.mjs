/**
 * Native one-shot OpenClaw commands for [registration](./openclaw-reminder-registration.mjs)
 * and [reconciliation](./openclaw-reminder-dispatch.mjs). A private tag joins an
 * ambiguous add to its durable intent. [Gateway](../agent/openclaw-gateway.mjs)
 * verifies the physical local profile. [Contract](../../tests/reference/parity-autonomy-contract.txt).
 */
import { openClawCommandJson } from '../agent/openclaw-gateway.mjs';

const tagPrefix = 'msb-once-reminder:';
const isRunTime = value => Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime());
// A later cron list can see completion that the preceding cron.runs read missed.
const observedRunAt = job => [job?.state?.runningAtMs, job?.state?.lastRunAtMs].find(isRunTime);

export function nativeReminderEntry(profile, nonce) {
  return { kind: 'once-reminder', profile, tag: tagPrefix + nonce, enabled: false };
}

export function isNativeReminderEntry(entry) {
  return entry?.kind === 'once-reminder' && typeof entry.profile === 'string' &&
    typeof entry.tag === 'string' && entry.tag.startsWith(tagPrefix);
}

const ownsJob = (job, entry) => typeof job?.id === 'string' && job.id &&
  job.description === entry.tag && (!entry.jobId || job.id === entry.jobId);

// null means ownership or listing could not be verified; undefined means absent.
async function findNativeJob(gateway, entry, signal) {
  const result = await gateway.run(['cron', 'list', '--all', '--json'], signal);
  if (!Array.isArray(result?.jobs)) return null;
  const matches = result.jobs.filter(job => job?.description === entry.tag || entry.jobId && job?.id === entry.jobId);
  if (matches.length > 1 || matches.length === 1 && !ownsJob(matches[0], entry)) return null;
  return matches[0];
}

export async function addDisabledNativeReminder(gateway, action, entry) {
  const prompt = action.task.text + '\n\nВсегда заканчивай ответ хотя бы одной строкой итога. Пустой ответ запрещён.';
  const outcome = await gateway.command(['cron', 'add', '--name', action.name, '--description', entry.tag,
    '--at', action.trigger.at, '--delete-after-run', '--session', 'isolated', '--light-context',
    '--tools', 'read', '--timeout-seconds', '600', '--message', prompt, '--no-deliver', '--disabled', '--json']);
  const job = openClawCommandJson(outcome);
  const observed = ownsJob(job, entry) ? job : await findNativeJob(gateway, entry);
  if (observed?.enabled === false) return { id: observed.id };
  return { uncertain: !outcome || outcome.code === 0 || observed === null };
}

export async function setNativeReminderEnabled(gateway, entry, enabled) {
  if (!gateway) return { ok: false };
  const job = await findNativeJob(gateway, entry);
  if (job === undefined) return { ok: !enabled, gone: true };
  if (!job) return { ok: false };
  const started = observedRunAt(job);
  if (job.enabled === enabled) return { ok: true, changed: false, runAtMs: enabled ? undefined : started };
  if (enabled && started) return { ok: false, runAtMs: started };
  const result = await gateway.run(['cron', enabled ? 'enable' : 'disable', job.id, '--json']);
  if (ownsJob(result, entry) && result.enabled === enabled) {
    return { ok: true, changed: true, runAtMs: enabled ? undefined : observedRunAt(result) ?? started };
  }
  const current = await findNativeJob(gateway, entry);
  if (current === undefined) return { ok: !enabled, gone: true, runAtMs: enabled ? undefined : started };
  const ok = current?.enabled === enabled;
  return { ok, changed: ok, runAtMs: ok && !enabled ? observedRunAt(current) ?? started : undefined };
}

export async function removeNativeReminder(gateway, entry) {
  const job = await findNativeJob(gateway, entry);
  if (job === undefined) return true;
  if (!job) return false;
  const result = await gateway.run(['cron', 'rm', job.id, '--json']);
  return result?.removed === true || await findNativeJob(gateway, entry) === undefined;
}

export async function readNativeReminderFinish(gateway, entry, signal) {
  if (!gateway || !entry.jobId) return null;
  const result = await gateway.run(['cron', 'runs', '--id', entry.jobId, '--limit', '10', '--json'], signal);
  if (!Array.isArray(result?.entries)) return null;
  const finished = result.entries.filter(row => row?.jobId === entry.jobId && row.action === 'finished' &&
    isRunTime(row.runAtMs) && (!entry.awaitingRunAtMs || row.runAtMs === entry.awaitingRunAtMs));
  return finished.sort((left, right) => left.runAtMs - right.runAtMs)[0];
}
