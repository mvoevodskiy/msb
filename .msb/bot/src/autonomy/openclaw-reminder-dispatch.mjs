/**
 * [Scheduler](./scheduler.mjs) reconciles the bot's [native one-shots](./openclaw-reminder-cron.mjs)
 * under the same pause/action lock order as [local reminders](./reminder-dispatch.mjs).
 * Missing action intent is rolled back, a matched terminal run feeds [delivery](./openclaw-reminder-delivery.mjs).
 * Older unbound native entries are only read by the existing screens.
 */
import { openOwnedLocalGateway } from '../agent/openclaw-gateway.mjs';
import { loadState } from '../state.mjs';
import { withAutonomyPauseLock } from './owner-pause.mjs';
import { readReminderPolicy, reminderOwnerChat } from './reminder-policy.mjs';
import { withActions } from './reminder-store.mjs';
import { readNativeJobMap, writeNativeJobMap } from './native-job-map.mjs';
import { isNativeReminderEntry, removeNativeReminder } from './openclaw-reminder-cron.mjs';
import { applyNativeReminderArming, nativeReminderPauseCause } from './openclaw-reminder-arming.mjs';
import { readNativeReminderDelivery, sendNativeReminder, recordNativeReminder } from './openclaw-reminder-delivery.mjs';

async function reconcileJob(gateway, id, jobs, records, save, { api, adminId, now, signal, env }) {
  const entry = jobs[id];
  const index = records.findIndex(row => row?.id === id);
  const record = records[index];
  const action = record?.nativeReminderTag === entry.tag ? record : undefined;
  const persist = () => writeNativeJobMap(jobs, env);
  const cleanup = async () => {
    if (!await removeNativeReminder(gateway, entry)) return;
    delete jobs[id];
    await persist();
  };
  if (entry.rollback || !action) {
    if (entry.recheckAt > now) return;
    if (entry.rollback && action?.runner === 'oc') {
      records.splice(index, 1);
      await save();
    }
    return cleanup();
  }
  if (action.runner !== 'oc' || action.task?.kind !== 'reminder' || action.trigger?.kind !== 'once') return;
  const { state } = await loadState(env);
  const policy = await readReminderPolicy(state, env);
  const ownerChat = Number(entry.ownerId) === Number(adminId) && reminderOwnerChat(state, adminId);
  const canRun = ownerChat && state.engine === 'oc' && policy.enabled && !policy.asleep;
  const mayDeliver = canRun && !policy.stopped && !action.budget?.killSwitch;
  const pause = nativeReminderPauseCause(action, policy, canRun);
  if (!entry.delivery && pause && (entry.pausedBy !== pause || entry.enabled)) {
    if ((await applyNativeReminderArming(gateway, entry, pause)).ok) await persist();
  }
  if (signal.aborted) return;
  if (!entry.delivery) {
    const terminal = canRun ? await readNativeReminderDelivery(gateway, entry, action, ownerChat, now, signal) : undefined;
    if (terminal) {
      entry.delivery = terminal;
      delete entry.awaitingRunAtMs;
      await persist();
    } else {
      if (!pause && !entry.enabled && !entry.awaitingRunAtMs && terminal !== null && !signal.aborted) {
        const armed = await applyNativeReminderArming(gateway, entry);
        if (armed.ok || armed.runAtMs) await persist();
      }
      return;
    }
  }
  await recordNativeReminder(entry, action, async next => {
    records[index] = next;
    await save();
  }, env);
  if (!entry.retired && await removeNativeReminder(gateway, entry)) {
    entry.retired = true;
    entry.enabled = false;
    await persist();
  }
  if (!signal.aborted && mayDeliver) await sendNativeReminder(api, entry, persist, now);
  if (entry.retired && ['sent', 'stopped'].includes(entry.delivery.status)) {
    delete jobs[id];
    await persist();
  }
}

export function createOpenClawReminderDispatcher({ api, adminId, now, signal, log, env = process.env }) {
  return async function dispatchOpenClawReminders() {
    if (!api || !adminId || signal.aborted) return;
    const snapshot = await readNativeJobMap(env);
    if (!Object.values(snapshot).some(isNativeReminderEntry)) return;
    const gateway = await openOwnedLocalGateway(env, { signal });
    if (!gateway) return;
    for (const [id, entry] of Object.entries(snapshot)) {
      if (signal.aborted) break;
      if (!isNativeReminderEntry(entry) || entry.profile !== gateway.file) continue;
      await withAutonomyPauseLock(() => withActions(env, async (records, save) => {
        if (signal.aborted) return;
        const jobs = await readNativeJobMap(env);
        if (jobs[id]?.tag !== entry.tag) return;
        await reconcileJob(gateway, id, jobs, records, save, { api, adminId, now: now(), signal, env });
      }, { create: true, durable: true }), env).catch(error =>
        log('[msb/autonomy] OpenClaw reminder reconciliation failed: ' + (error.code || error.name)));
    }
  };
}
