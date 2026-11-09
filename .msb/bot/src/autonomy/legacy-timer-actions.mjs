/**
 * Old Xz/W$A owner commands over the shared [schedules writer](./legacy-timers.mjs).
 * [Telegram](../telegram/legacy-timer-markers.mjs) formats the result.
 * [Deletion question](./legacy-timer-delete.mjs) applies an exact snapshot.
 * [Owner ingress and due tests](../../tests/legacy-timer-conversation.test.mjs).
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readLegacyTimerRecords, savedLegacyTimers, withLegacyTimerUpdate } from './legacy-timers.mjs';
import { withOwnerTaskState } from './owner-task-update.mjs';

const statePolicy = { unavailable: 'Управление таймерами на этом движке пока не подключено.' };

function selectTimer(timers, selector) {
  const query = selector.trim();
  if (!query) return { error: 'Уточни, какой таймер.' };
  const exact = timers.find(timer => timer.id === query);
  const matches = exact ? [exact] : timers.filter(timer => timer.name.toLowerCase().includes(query.toLowerCase()));
  if (!matches.length) return { error: 'Не нашёл таймер «' + query + '».' };
  if (matches.length > 1) return { matches };
  return { timer: matches[0] };
}

function definition(timer) {
  const { enabled, disabledBy, lastRunAt, ...stable } = timer;
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function listTimersFromTurn(context) {
  return withOwnerTaskState(context, ({ env }) => readLegacyTimerRecords(env), statePolicy);
}

export async function setTimerFromTurn(selector, enabled, context) {
  const env = context.env ?? process.env;
  const result = await withLegacyTimerUpdate(env, (records, save) => withOwnerTaskState(context, async () => {
    const selected = selectTimer(savedLegacyTimers(records), selector);
    if (!selected.timer) return selected;
    const { timer } = selected;
    const wasEnabled = Boolean(timer.enabled);
    if (enabled && wasEnabled) return { timer, wasEnabled };
    const next = { ...timer, enabled };
    if (enabled) delete next.disabledBy;
    else next.disabledBy = 'owner';
    if (!isDeepStrictEqual(next, timer)) {
      records[records.indexOf(timer)] = next;
      await save();
    }
    return { timer: next, wasEnabled };
  }, statePolicy), { signal: context.signal });
  return result ?? withOwnerTaskState(context, () => selectTimer([], selector), statePolicy);
}

export function planTimerDeletion(selector, context) {
  return withOwnerTaskState(context, async ({ env }) => {
    const { file, timers } = await readLegacyTimerRecords(env);
    const selected = selectTimer(timers, selector);
    if (!selected.timer) return selected;
    const { timer } = selected;
    return { timer, snapshot: { file, id: timer.id, definition: definition(timer) } };
  }, statePolicy);
}

export async function removeApprovedLegacyTimer(snapshot, { begin, published }, env) {
  return (await withLegacyTimerUpdate(env, async (records, save) => {
    const matchingIds = savedLegacyTimers(records).filter(timer => timer.id === snapshot.id);
    if (!matchingIds.length) return { missing: true };
    const matches = matchingIds.filter(timer => definition(timer) === snapshot.definition);
    if (matches.length !== 1) return { stale: true };
    const timer = matches[0];
    await begin();
    records.splice(records.indexOf(timer), 1);
    await save();
    const result = { timer };
    published(result);
    return result;
  }, { expectedFile: snapshot.file })) ?? { stale: true };
}
