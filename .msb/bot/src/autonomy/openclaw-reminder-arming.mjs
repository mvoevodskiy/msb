/**
 * Ownership and confirmed scheduling state for [native reminder controls](./openclaw-reminder-control.mjs)
 * and [reconciliation](./openclaw-reminder-dispatch.mjs). A pause reason never
 * overwrites the owner's requested state in [actions.json](./reminder-store.mjs).
 */
import { isNativeReminderEntry, setNativeReminderEnabled } from './openclaw-reminder-cron.mjs';

export function isOwnedNativeReminder(action, entry, file, ownerId) {
  return isNativeReminderEntry(entry) && !entry.rollback && typeof entry.jobId === 'string' &&
    entry.profile === file && Number(entry.ownerId) === Number(ownerId) &&
    action?.runner === 'oc' && action.nativeReminderTag === entry.tag &&
    action.task?.kind === 'reminder' && action.trigger?.kind === 'once';
}

export function nativeReminderPauseCause(action, policy, canRun) {
  if (action.enabled === false && action.disabledReason === 'owner') return 'owner';
  if (policy.ownerStopped) return 'stop';
  if (policy.fleetStopped) return 'fleet-stop';
  if (!canRun || action.enabled === false || action.budget?.killSwitch) return 'inactive';
}

export async function applyNativeReminderArming(gateway, entry, pause) {
  const result = await setNativeReminderEnabled(gateway, entry, !pause);
  if (!result.ok) return result;
  entry.enabled = !pause && !result.gone;
  if (pause) entry.pausedBy = pause;
  else delete entry.pausedBy;
  return result;
}
