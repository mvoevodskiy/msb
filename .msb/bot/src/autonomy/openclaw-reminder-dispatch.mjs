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
import { isNativeReminderEntry, readNativeReminderFinish, removeNativeReminder,
  setNativeReminderEnabled } from './openclaw-reminder-cron.mjs';
import { nativeReminderDelivery, sendNativeReminder, recordNativeReminder } from './openclaw-reminder-delivery.mjs';

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
  const mayDeliver = ownerChat && state.engine === 'oc' && policy.enabled && !policy.asleep &&
    !policy.stopped && !action.budget?.killSwitch;
  if (!entry.delivery && (!mayDeliver || action.enabled === false)) {
    const pause = policy.stopped ? 'stop' : 'inactive';
    if (entry.pausedBy !== pause && await setNativeReminderEnabled(gateway, entry, false)) {
      entry.enabled = false;
      entry.pausedBy = pause;
      await persist();
    }
    return;
  }
  if (signal.aborted) return;
  if (!entry.delivery && now >= Date.parse(action.trigger.at)) {
    const terminal = await readNativeReminderFinish(gateway, entry, signal);
    if (terminal) {
      entry.delivery = nativeReminderDelivery(action, terminal, ownerChat);
      await persist();
    }
  }
  if (!entry.delivery) {
    if (!entry.enabled && !signal.aborted && await setNativeReminderEnabled(gateway, entry, true)) {
      entry.enabled = true;
      delete entry.pausedBy;
      await persist();
    }
    return;
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
  if (entry.retired && entry.delivery.status === 'sent') {
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
