/**
 * Owner [general](../telegram/pause-markers.mjs) and [personal](../telegram/task-control-markers.mjs)
 * pause for scoped one-shots. The [action selector](./saved-action-control.mjs)
 * stores the desired state, the [job map](./native-job-map.mjs) stores verified
 * arming. [Reconciliation](./openclaw-reminder-dispatch.mjs) uses the same lock
 * order and retries a native refusal. [Checks](../../tests/openclaw-once-reminder.test.mjs).
 */
import { openOwnedLocalGateway } from '../agent/openclaw-gateway.mjs';
import { ownedOpenClawProfile } from '../agent/openclaw-profile.mjs';
import { loadState } from '../state.mjs';
import { withAutonomyPauseLock } from './owner-pause.mjs';
import { readReminderPolicy, reminderOwnerChat } from './reminder-policy.mjs';
import { readNativeJobMap, writeNativeJobMap } from './native-job-map.mjs';
import { withActions } from './reminder-store.mjs';
import { planSavedActionControl, selectSavedAction, unavailableSavedActionControl } from './saved-action-control.mjs';
import { spentReminder } from './reminder-schedule.mjs';
import { applyNativeReminderArming, isOwnedNativeReminder, nativeReminderPauseCause } from './openclaw-reminder-arming.mjs';

const unavailable = { error: 'Управление задачами на этом движке пока не подключено.' };

export async function openClawControlProfile(context, env = process.env) {
  if (context.rail !== 'oc' || context.openClawProfile === null) return;
  const profile = await ownedOpenClawProfile(env);
  if (profile && (!context.openClawProfile || context.openClawProfile === profile.file)) return profile.file;
}

async function currentControl(context, profile, env) {
  const { state } = await loadState(env);
  if (state.engine !== 'oc' || !reminderOwnerChat(state, context.ownerId) ||
      await openClawControlProfile(context, env) !== profile) return;
  const policy = await readReminderPolicy(state, env);
  if (policy.enabled && !policy.asleep) return { state, policy };
}

async function updateArming(gateway, jobs, action, context, profile, env) {
  const route = await currentControl(context, profile, env);
  if (!route || context.signal?.aborted) return { ok: false };
  const entry = jobs[action.id];
  const enabled = entry.enabled, previousPause = entry.pausedBy;
  const pause = nativeReminderPauseCause(action, route.policy, true);
  let result = await applyNativeReminderArming(gateway, entry, pause);
  if (result.ok && !pause) {
    const settled = await currentControl(context, profile, env);
    const held = settled ? nativeReminderPauseCause(action, settled.policy, true) : 'inactive';
    if (held) result = await applyNativeReminderArming(gateway, entry, held);
  }
  if (enabled !== entry.enabled || previousPause !== entry.pausedBy) await writeNativeJobMap(jobs, env);
  return result;
}

export async function setOwnedNativeReminderEnabled(selector, enabled, context, env = process.env) {
  const query = selector.trim();
  if (!query) return { error: enabled ? 'Уточни, какую задачу вернуть в работу.' : 'Уточни, какую задачу поставить на паузу.' };
  const profile = await openClawControlProfile(context, env);
  if (!profile) return unavailable;
  return withAutonomyPauseLock(() => withActions(env, async (records, save) => {
    context.signal?.throwIfAborted();
    const route = await currentControl(context, profile, env);
    if (!route) return unavailable;
    const target = selectSavedAction(records, query);
    if (!target.action) return target;
    const action = target.action;
    const jobs = await readNativeJobMap(env);
    const entry = jobs[action.id];
    if (!isOwnedNativeReminder(action, entry, profile, context.ownerId) || entry.delivery) {
      return { error: unavailableSavedActionControl(action) };
    }
    const change = planSavedActionControl(action, enabled);
    if (change.error) return change;
    if (change.changed) {
      records[records.indexOf(action)] = change.action;
      await save();
    }
    const gateway = await openOwnedLocalGateway(env, { expectedFile: profile, signal: context.signal });
    const native = await updateArming(gateway, jobs, change.action, context, profile, env);
    return { ...change, state: route.state, nativeUnconfirmed: !native.ok, nativeHeld: enabled && !entry.enabled };
  }, { durable: true }), env);
}

export async function syncOwnedNativeReminderPause(stop, context, env = process.env) {
  const result = { fenced: 0, unconfirmed: 0, tasks: [] };
  const profile = await openClawControlProfile(context, env);
  if (!profile) return { ...result, unavailable: true };
  return withAutonomyPauseLock(() => withActions(env, async records => {
    const route = await currentControl(context, profile, env);
    if (!route || context.signal?.aborted) return { ...result, unavailable: true };
    if (stop ? !route.policy.ownerStopped : route.policy.stopped) return result;
    const jobs = await readNativeJobMap(env);
    const pending = records.filter(action => {
      const entry = jobs[action?.id];
      return isOwnedNativeReminder(action, entry, profile, context.ownerId) && !entry.delivery && !spentReminder(action);
    });
    const changes = pending.filter(action => {
      const entry = jobs[action.id];
      if (!stop) return entry.pausedBy === 'stop' && !nativeReminderPauseCause(action, route.policy, true);
      return entry.enabled || entry.pausedBy !== nativeReminderPauseCause(action, route.policy, true);
    });
    if (changes.length) {
      const gateway = await openOwnedLocalGateway(env, { expectedFile: profile, signal: context.signal });
      for (const action of changes) {
        const current = await currentControl(context, profile, env);
        if (!current || context.signal?.aborted || (stop ? !current.policy.ownerStopped : current.policy.stopped)) break;
        const native = await updateArming(gateway, jobs, action, context, profile, env);
        if (!native.ok) result.unconfirmed++;
        if (stop && native.ok && native.changed && jobs[action.id].enabled === false) result.fenced++;
      }
    }
    result.tasks = pending.filter(action => action.enabled && (stop ||
      jobs[action.id].enabled && !jobs[action.id].pausedBy)).map(action => ({ name: action.name, trigger: action.trigger }));
    return result;
  }), env);
}
