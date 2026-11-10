/**
 * [Telegram marker](../telegram/reminder-markers.mjs) → durable intent →
 * disabled [native cron](./openclaw-reminder-cron.mjs) → [action and ID](./native-job-map.mjs)
 * → activation. [Reconciliation](./openclaw-reminder-dispatch.mjs) can finish
 * a published record or clean a tagged disabled job after interruption.
 * [Tests](../../tests/openclaw-once-reminder.test.mjs).
 */
import { randomUUID } from 'node:crypto';
import { openOwnedLocalGateway } from '../agent/openclaw-gateway.mjs';
import { withAutonomyPauseLock } from './owner-pause.mjs';
import { prepareSavedAction, withActions } from './reminder-store.mjs';
import { readNativeJobMap, writeNativeJobMap } from './native-job-map.mjs';
import { addDisabledNativeReminder, nativeReminderEntry, removeNativeReminder } from './openclaw-reminder-cron.mjs';
import { applyNativeReminderArming, nativeReminderPauseCause } from './openclaw-reminder-arming.mjs';

const failed = { error: 'Не удалось поставить задачу: движок OpenClaw не подтвердил расписание.' };

async function rollback(gateway, jobs, entry, records, action, save, env) {
  entry.rollback = true;
  await writeNativeJobMap(jobs, env).catch(() => {});
  const index = records.indexOf(action);
  let restored = index === -1;
  if (!restored) {
    records.splice(index, 1);
    restored = await save().then(() => true, () => false);
  }
  if (entry.recheckAt) return;
  const current = await openOwnedLocalGateway(env, { expectedFile: gateway.file });
  if (!current || !await removeNativeReminder(current, entry) || !restored) return;
  delete jobs[action.id];
  await writeNativeJobMap(jobs, env);
}

export async function registerOpenClawReminder(action, {
  env = process.env, signal, expectedProfile, validate, ownerId,
}) {
  const gateway = await openOwnedLocalGateway(env, { expectedFile: expectedProfile, signal });
  if (!gateway) return failed;
  return withAutonomyPauseLock(() => withActions(env, async (records, save) => {
    signal?.throwIfAborted();
    const jobs = await readNativeJobMap(env);
    const prepared = prepareSavedAction({ ...action, runner: 'oc' }, records, env, jobs);
    if (!prepared.action) return prepared;
    if (!await validate()) return failed;
    const entry = { ...nativeReminderEntry(gateway.file, randomUUID()), ownerId };
    const saved = { ...prepared.action, nativeReminderTag: entry.tag };
    jobs[saved.id] = entry;
    await writeNativeJobMap(jobs, env);
    try {
      signal?.throwIfAborted();
      // A CLI timeout can follow an accepted add. The tag makes that job recoverable.
      const { id, uncertain } = await addDisabledNativeReminder(gateway, saved, entry);
      if (!id) {
        if (uncertain) entry.recheckAt = Date.now() + 30_000;
        throw new Error('Unconfirmed OpenClaw job');
      }
      entry.jobId = id;
      await writeNativeJobMap(jobs, env);
      signal?.throwIfAborted();
      if (!await validate()) throw new Error('OpenClaw route changed');
      const previous = records.slice();
      records.push(saved);
      await save();

      const current = await openOwnedLocalGateway(env, { expectedFile: gateway.file, signal });
      const policy = current && await validate();
      signal?.throwIfAborted();
      if (!policy) throw new Error('OpenClaw route changed');
      if (policy.stopped) entry.pausedBy = nativeReminderPauseCause(saved, policy, true);
      else if (!(await applyNativeReminderArming(current, entry)).ok) throw new Error('Unconfirmed OpenClaw activation');
      signal?.throwIfAborted();
      const settled = await validate();
      if (!settled) throw new Error('OpenClaw route changed');
      if (settled.stopped && entry.enabled) {
        const pause = nativeReminderPauseCause(saved, settled, true);
        if (!(await applyNativeReminderArming(current, entry, pause)).ok) throw new Error('Unconfirmed OpenClaw pause');
      }
      await writeNativeJobMap(jobs, env);
      return { action: saved, previous, timezone: policy.timezone, provider: 'openclaw' };
    } catch {
      await rollback(gateway, jobs, entry, records, saved, save, env).catch(() => {});
      signal?.throwIfAborted();
      return failed;
    }
  }, { create: true, durable: true }), env);
}
