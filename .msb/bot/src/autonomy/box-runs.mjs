/**
 * Numeric UTC-day totals for old box admission. Reads the last 500 parsed rows
 * per distinct [reminder journal](./reminder-runs.mjs), box and bot journal.
 * [Budget gate](./reminder-admission.mjs) consumes totals only.
 * [Scheduler regression](../../tests/reminder-limits.test.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { actionRoot, autonomyDir } from '../paths.mjs';
import { reminderRunPath } from './reminder-runs.mjs';

const RUN_TAIL = 500;

async function boxJournals(env) {
  const own = actionRoot(env);
  const parent = path.dirname(own);
  const box = path.basename(parent) === 'bots' ? path.dirname(parent) : own;
  const bots = path.join(box, 'bots');
  const entries = await fs.readdir(bots, { withFileTypes: true }).catch(() => []);
  const files = new Set([reminderRunPath(env), path.join(box, 'autonomy', 'runs.jsonl'),
    path.resolve(autonomyDir(env), 'runs.jsonl')]);
  for (const entry of entries) {
    if (entry.isDirectory()) files.add(path.join(bots, entry.name, 'autonomy', 'runs.jsonl'));
  }
  const physical = await Promise.all([...files].map(file => fs.realpath(file).catch(() => file)));
  return new Set(physical);
}

function countRun(row, day, totals) {
  if (typeof row?.ts === 'string') {
    if (row.ts.slice(0, 10) !== day) return;
    if (Number.isFinite(row.costUsd)) totals.costUsd += row.costUsd;
    if (row.status === 'skipped' || row.status === 'stopped') return;
    totals.runs++;
    if (Number.isFinite(row.tokensIn)) totals.tokensIn += row.tokensIn;
    return;
  }
  // The interval runner logs setup/unsupported-engine refusals before any
  // CLI launch. Other completed rows prove a turn, with no price or tokens.
  if (typeof row?.at === 'string' && row.at.slice(0, 10) === day &&
      typeof row.taskId === 'string' && typeof row.ok === 'boolean' &&
      (row.ok || (row.error !== 'setup' && row.error !== 'engine_oc'))) totals.runs++;
}

async function readJournal(file, day) {
  const totals = { costUsd: 0, runs: 0, tokensIn: 0 };
  // The old fleet reader tolerates missing or unreadable individual journals.
  const lines = (await fs.readFile(file, 'utf8').catch(() => '')).split('\n');
  let seen = 0;
  for (let index = lines.length - 1; index >= 0 && seen < RUN_TAIL; index--) {
    let row;
    try { row = JSON.parse(lines[index]); }
    catch { continue; }
    seen++;
    countRun(row, day, totals);
  }
  return totals;
}

export async function readBoxRunTotals(at, env = process.env) {
  const day = at.slice(0, 10);
  const totals = { costUsd: 0, runs: 0, tokensIn: 0, activeJournals: 0 };
  for (const file of await boxJournals(env)) {
    const entry = await readJournal(file, day);
    totals.costUsd += entry.costUsd;
    totals.runs += entry.runs;
    totals.tokensIn += entry.tokensIn;
    if (entry.runs > 0 || entry.costUsd > 0) totals.activeJournals++;
  }
  return totals;
}
