/**
 * Read-only old xg/br/Ig projection. [Action records](./reminder-store.mjs),
 * [run tail](./reminder-runs.mjs) and [timers](./legacy-timers.mjs) stay separate.
 * [Telegram text](../telegram/screens/task-inspection.mjs), [checks](../../tests/saved-task-inspection.test.mjs).
 */
import { isLocalSavedAction, readNativeJobMap } from './reminder-store.mjs';
import { listLegacyTimers } from './legacy-timers.mjs';
import { readSavedActionRunTail } from './reminder-runs.mjs';
import { reminderFrequencyAllows } from './reminder-frequency.mjs';
import { readReminderFrequencyDecisions } from './frequency-decisions.mjs';
import { nextReminderCronAt, savedTaskSpent, validReminderTimezone } from './reminder-schedule.mjs';
import { savedPromptPlan } from './prompt-policy.mjs';
import { promptRegistrationReady } from './prompt-registration.mjs';

export function savedTaskIsNative(action, job) {
  return Boolean(job || action.runner === 'oc' || action.migratedToOc);
}

export function savedTaskTimezone(action, timezone, job) {
  const storedZone = action.trigger?.timezone;
  return savedTaskIsNative(action, job) && validReminderTimezone(storedZone) ? storedZone : timezone;
}

function nextExpected(trigger, after, timezone) {
  if (!Number.isFinite(after)) return;
  if (trigger?.kind === 'interval' && Number.isFinite(trigger.intervalMinutes) && trigger.intervalMinutes > 0) {
    return after + trigger.intervalMinutes * 60_000;
  }
  if (trigger?.kind === 'cron') return nextReminderCronAt(trigger.cron, after, timezone);
}

function silentSince(action, { runs, now, timezone, uptimeMs }) {
  if (!runs) return;
  const previous = Date.parse(action.lastRunAt ?? action.createdAt);
  const expected = action.trigger?.kind === 'once' ? Date.parse(action.trigger.at) : nextExpected(action.trigger, previous, timezone);
  if (!Number.isFinite(new Date(expected).getTime())) return;
  const after = nextExpected(action.trigger, expected, timezone);
  const grace = Math.max(3_600_000, Number.isFinite(after) ? 2 * (after - expected) : 0);
  if (uptimeMs < grace || now <= expected + grace || Date.parse(action.lastRunAt) > expected ||
      runs.some(row => row?.actionId === action.id && Date.parse(row.ts) > expected)) return;
  return expected;
}

export async function readSavedTaskList(records, state, policy, {
  now, timezone, codexAvailable, cursorAvailable, checkSavedCodex, checkSavedCursor,
}) {
  const [jobs, timers, decisions, runs] = await Promise.all([
    readNativeJobMap().catch(() => null),
    listLegacyTimers(),
    readReminderFrequencyDecisions(),
    readSavedActionRunTail(500).catch(() => null),
  ]);
  const enabled = records.filter(action => action.enabled);
  const spent = enabled.filter(savedTaskSpent);
  const ownerPaused = records.filter(action => !action.enabled && action.disabledReason === 'owner');
  const active = enabled.filter(action => !savedTaskSpent(action));
  const hasPrompt = active.some(action => action.task.kind === 'prompt');
  const codexReady = hasPrompt && state.extAuthBypass === 'codex'
    ? await promptRegistrationReady('codex', checkSavedCodex) : false;
  const cursorReady = hasPrompt && state.extAuthBypass === 'cursor'
    ? await promptRegistrationReady('cursor', checkSavedCodex, process.env, checkSavedCursor) : false;
  const uptimeMs = process.uptime() * 1000;
  const entries = active.map(action => {
    const job = jobs && Object.hasOwn(jobs, action.id) ? jobs[action.id] : undefined;
    const zone = savedTaskTimezone(action, timezone, job);
    const local = jobs && isLocalSavedAction(action, jobs);
    const plan = local && action.task.kind === 'prompt'
      ? savedPromptPlan(action, state, process.env, codexAvailable, cursorAvailable)
      : undefined;
    const available = Boolean(job || local && (action.task.kind === 'reminder' || plan && (
      (plan.provider === 'codex' && codexReady)
      || (plan.provider === 'cursor' && cursorReady)
      || (plan.provider !== 'codex' && plan.provider !== 'cursor')
    )));
    const frequencyHeld = local && !reminderFrequencyAllows(action, decisions);
    const held = frequencyHeld || action.disabledReason || action.budget?.killSwitch || job?.enabled === false || job?.pausedBy;
    return {
      action, timezone: zone, job, available, frequencyHeld,
      silentAt: available && !held && !policy.stopped ? silentSince(action, { runs, now, timezone: zone, uptimeMs }) : undefined,
    };
  });
  return {
    entries, spent, ownerPaused, timers, now, timezone, policy, jobs,
    nativeMayStillRun: !jobs || Object.values(jobs).some(job => job?.jobId && job.enabled !== false && !job.pausedBy),
  };
}
