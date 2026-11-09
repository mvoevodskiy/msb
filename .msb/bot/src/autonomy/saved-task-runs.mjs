/**
 * Old Gw/ma read projection for [TASK_RUNS](../telegram/task-inspection-markers.mjs).
 * Reads the [per-bot saved journal](./reminder-runs.mjs) and current
 * [action records](./reminder-store.mjs). [Telegram text](../telegram/screens/task-run-history.mjs)
 * and [checks](../../tests/task-run-history.test.mjs).
 */
import { matchingSavedActions } from './saved-action-control.mjs';
import { readSavedActionRecords } from './reminder-store.mjs';
import { readSavedActionRunTail } from './reminder-runs.mjs';

const dayMs = 86_400_000;
export const taskRunWindowDays = 7;
export const taskRunReadLimit = 1000;

const knownOutcomes = new Set(['ok', 'skipped', 'blocked', 'deferred', 'stopped', 'error']);
const quietPhrases = ['нечего сообщить', 'сообщать нечего'];
const number = value => Number.isFinite(value) ? value : 0;

function runOutcome(row) {
  if (row.truncated) return 'truncated';
  if (row.status === 'skipped' && typeof row.detail === 'string' &&
      quietPhrases.some(phrase => row.detail.includes(phrase))) return 'quiet';
  return knownOutcomes.has(row.status) ? row.status : 'unknown';
}

function runTotals(entries) {
  const counts = new Map();
  let paid = 0, paidRuns = 0, metered = 0, inputRuns = 0, tokensIn = 0;
  let inputIncomplete = false;
  for (const { row, outcome } of entries) {
    const category = outcome === 'blocked' || outcome === 'deferred' ? 'limited' :
      outcome === 'skipped' || outcome === 'unknown' ? 'other' : outcome;
    counts.set(category, (counts.get(category) ?? 0) + 1);
    if (row.costVisible === true) {
      paid += number(row.costUsd);
      paidRuns++;
    } else {
      metered += number(row.meteredUsd);
    }
    inputIncomplete ||= row.usageIncomplete === true;
    const input = number(row.tokensIn);
    if (input > 0) {
      inputRuns++;
      tokensIn += input;
    }
  }
  return { counts, paid, paidRuns, metered, inputRuns, tokensIn, inputIncomplete };
}

function taskGroups(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const { actionId } = entry.row;
    const group = groups.get(actionId);
    if (group) group.count++;
    else groups.set(actionId, { count: 1, latest: entry });
  }
  return [...groups.values()].sort((left, right) => right.count - left.count);
}

export async function readSavedTaskRunHistory(query, now, env = process.env) {
  const raw = await readSavedActionRunTail(taskRunReadLimit, env).catch(() => null);
  if (!raw) return { error: 'Журнал прогонов не прочитался, поэтому историю показать не могу.' };
  const { records } = await readSavedActionRecords(env).catch(() => ({ records: [] }));
  let actionId;
  if (query) {
    const ids = new Set(matchingSavedActions(records, query).map(action => action.id));
    const matches = records.filter(action => ids.has(action?.id));
    if (!matches.length) return { error: 'Задачи «' + query +
      '» не нашёл, поэтому историю по ней не покажу. Скажи точнее или попроси показать все задачи.' };
    if (matches.length > 1) return { error: 'Под «' + query + '» подходит несколько задач: ' +
      matches.map(action => action.name).join(', ') + '. Назови одну.' };
    actionId = matches[0].id;
  }
  const runs = raw.filter(row => typeof row?.actionId === 'string' && (!actionId || row.actionId === actionId))
    .map(row => ({ row, at: typeof row.ts === 'string' ? Date.parse(row.ts) : NaN, outcome: runOutcome(row) }))
    .sort((left, right) => (right.at || 0) - (left.at || 0));
  const recent = runs.filter(({ at }) => at >= now - taskRunWindowDays * dayMs);
  return {
    runs, actionId, records, recentCount: recent.length,
    dayCount: recent.filter(({ at }) => at >= now - dayMs).length,
    groups: actionId ? [] : taskGroups(recent),
    totals: runTotals(recent),
    truncated: raw.length >= taskRunReadLimit,
  };
}
