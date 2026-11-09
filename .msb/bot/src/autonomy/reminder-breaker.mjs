/**
 * Old AD/NIA outcomes for the direct reminder path, whose send returns ok/error.
 * [Admission](./reminder-dispatch.mjs) reads the per-action backoff under the
 * action lock. [Action completion](./reminder-store.mjs) records one outcome
 * through the physical breaker file. [Notices](./reminder-breaker-notice.mjs)
 * render the returned transition. [Ingress](../../tests/reminder-limits.test.mjs)
 * and [file locking checks](../../tests/reminder-breaker-concurrency.test.mjs).
 */
import path from 'node:path';
import { withFileLock } from '../../shared/file-lock.mjs';
import { actionRoot } from '../paths.mjs';
import { physicalRecordPath, readOptionalJson, writeRecordJson } from './record-file.mjs';

const failThreshold = 3;
const baseBackoffSeconds = 300;
const maxBackoffSeconds = 3600;
const crashWindowMs = 60_000;
const breakerPath = env => path.join(actionRoot(env), 'autonomy', 'breakers.json');

async function readBreakers(file) {
  const rows = await readOptionalJson(file);
  if (rows === undefined) return {};
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) throw new Error('Expected a breaker map');
  return rows;
}

function savedBreaker(rows, id) {
  const value = Object.hasOwn(rows, id) ? rows[id] : undefined;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export async function readReminderBreakerRefusal(id, at, env = process.env) {
  const rows = await readBreakers(breakerPath(env)).catch(() => ({}));
  const breaker = savedBreaker(rows, id);
  if (breaker.open && Date.parse(at) < Date.parse(breaker.backoffUntil)) {
    return { status: 'skipped', detail: 'breaker открыт до ' + breaker.backoffUntil };
  }
}

function afterSuccess(previous, at) {
  const next = { ...previous, consecutiveFailures: 0, open: false, crashWindow: [], lastSuccessAt: at,
    backoffUntil: undefined, openedAt: undefined, notifiedOpenAt: undefined };
  const event = previous.open ? { kind: 'recover', downSince: previous.openedAt } : undefined;
  return { next, event };
}

function afterFailure(previous, at, reason, minBackoffSeconds) {
  const streak = previous.consecutiveFailures;
  const consecutiveFailures = (Number.isSafeInteger(streak) && streak >= 0 ? streak : 0) + 1;
  const started = Date.parse(at);
  const crashWindow = Array.isArray(previous.crashWindow)
    ? previous.crashWindow.filter(time => started - Date.parse(time) <= crashWindowMs) : [];
  const next = { ...previous, open: Boolean(previous.open), consecutiveFailures, crashWindow,
    lastFailureAt: at, lastReason: reason };
  if (!next.open && consecutiveFailures < failThreshold) return { next };

  const exponent = Math.max(0, consecutiveFailures - failThreshold);
  const delay = Math.max(minBackoffSeconds, Math.min(maxBackoffSeconds, baseBackoffSeconds * 2 ** exponent));
  next.backoffUntil = new Date(started + delay * 1000).toISOString();
  if (next.open) return { next };

  Object.assign(next, { open: true, openedAt: at, notifiedOpenAt: at });
  return { next, event: { kind: 'open', backoffUntil: next.backoffUntil, reason } };
}

export async function recordReminderBreaker(id, at, result, { env = process.env, lockedActionFile, minBackoffSeconds = 0 } = {}) {
  const logical = breakerPath(env);
  const file = await physicalRecordPath(logical);
  if (file === lockedActionFile) throw new Error('Breaker file aliases the action store');
  return withFileLock(file, async () => {
    if (await physicalRecordPath(logical) !== file) throw new Error('Breaker file changed');
    const rows = await readBreakers(file);
    const previous = savedBreaker(rows, id);
    const { next, event } = result.status === 'ok' ? afterSuccess(previous, at)
      : afterFailure(previous, at, result.error, minBackoffSeconds);
    await writeRecordJson(file, { ...rows, [id]: next }, { create: true });
    return event;
  });
}
