// Codex usage from confirmed bot sessions and independently metered saved prompts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { botCodexIdentity, codexEdges, readSavedCodexUsage } from '../../src/collector/sources/codex-usage-data.ts';
import { combineCodexUsage, CodexUsageReader } from '../../src/collector/sources/codex-usage.ts';

const id = (n: number) => `0199a213-81c0-7800-8aa1-${String(n).padStart(12, '0')}`;
const encoded = (n: number) => `ext:codex:${id(n)}`;
const when = '2026-11-21T12:00:00.000Z';
const report = (rows: [number, number, number?][]) => ({ sessions: rows.map(([n, totalTokens, cacheReadTokens]) => ({
  sessionId: `2026/11/20/rollout-2026-11-20T12-00-00-${id(n)}`, totalTokens, cacheReadTokens,
})) });

test('per-bot sessions, child replay and saved prompt usage are combined once without Claude', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pult-codex-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, 'a'), b = join(root, 'b');
  await mkdir(join(a, 'autonomy'), { recursive: true });
  await mkdir(join(b, 'autonomy'), { recursive: true });
  await writeFile(join(a, 'state.json'), JSON.stringify({ extAuthBypass: 'codex', ccSessionId: encoded(1),
    codexUsageSessions: [encoded(1), encoded(3)] }));
  await writeFile(join(b, 'state.json'), JSON.stringify({ extAuthBypass: 'claude', codexUsageSessions: [encoded(2), encoded(3)] }));
  const saved = { kind: 'prompt', providerId: 'codex', usageSource: 'saved-prompt', usageRunId: id(20),
    ts: when, usageCompletedAt: when, usageTokensIn: 5, usageTokensOut: 2, usageCachedTokens: 3, status: 'skipped' };
  await writeFile(join(a, 'autonomy/runs.jsonl'), [saved, saved,
    { kind: 'prompt', providerId: 'claude', ts: when, tokensIn: 700, tokensOut: 200 },
    { kind: 'prompt', ts: when, tokensIn: 500, tokensOut: 100 },
    { kind: 'interval', providerId: 'codex', ts: when, tokensIn: 2000, tokensOut: 300 },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const bots = [{ id: 'a', directory: a }, { id: 'b', directory: b }];
  const identities = new Map(await Promise.all(bots.map(async bot => [bot.id,
    { ...botCodexIdentity(bot.directory), saved: await readSavedCodexUsage(bot.directory) }] as const)));
  const edges = { children: new Map([[id(1), new Set([id(4)])]]), partial: false };
  const reports = { all: report([[1, 100, 70], [2, 1000, 400], [3, 9000, 6000], [4, 10, 4]]),
    week: report([[1, 20, 12], [2, 100, 40], [3, 900, 600], [4, 3, 1]]),
    month: report([[1, 50, 30], [2, 500, 200], [3, 4000, 3000], [4, 5, 2]]), at: when };
  const result = combineCodexUsage(bots, identities, edges, reports, 'UTC', new Date(when));
  assert.deepEqual([result.get('a')?.week, result.get('a')?.month, result.get('a')?.all], [30, 62, 117]);
  assert.deepEqual([result.get('b')?.week, result.get('b')?.month, result.get('b')?.all], [100, 500, 1000]);
  assert.deepEqual(result.get('a')?.cacheRead, { week: 16, month: 35, all: 77 });
  assert.deepEqual(result.get('a')?.withoutCache, { week: 14, month: 27, all: 40 });
  assert.deepEqual(result.get('b')?.cacheRead, { week: 40, month: 200, all: 400 });
  assert.equal(result.get('a')?.incomplete, true);
  assert.equal(result.get('b')?.providerId, 'codex');
});

test('unknown parent and conflicting saved attempts are excluded rather than counted twice', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pult-codex-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'autonomy'));
  await writeFile(join(root, 'state.json'), JSON.stringify({ codexUsageSessions: [encoded(1)] }));
  const saved = { kind: 'prompt', providerId: 'codex', usageSource: 'saved-prompt', usageRunId: id(20),
    ts: when, usageCompletedAt: when, usageTokensIn: 5, usageTokensOut: 2 };
  await writeFile(join(root, 'autonomy/runs.jsonl'), [saved, { ...saved, usageTokensIn: 9 }].map(row => JSON.stringify(row)).join('\n'));
  const bot = { id: 'a', directory: root }, identity = { ...botCodexIdentity(root), saved: await readSavedCodexUsage(root) };
  const reports = { all: report([[4, 50]]), week: report([[4, 20]]), month: report([[4, 30]]), at: when };
  const out = combineCodexUsage([bot], new Map([['a', identity]]),
    { children: new Map([[id(1), new Set([id(4)])]]), partial: false }, reports, 'UTC', new Date(when)).get('a')!;
  assert.deepEqual([out.week, out.month, out.all], [null, null, null]);
  assert.equal(out.incomplete, true);
});

test('duplicate records with different cache details preserve the total once and mark the split unknown', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pult-codex-cache-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'autonomy'));
  await writeFile(join(root, 'state.json'), JSON.stringify({ codexUsageSessions: [encoded(1)] }));
  const saved = { kind: 'prompt', providerId: 'codex', usageSource: 'saved-prompt', usageRunId: id(20),
    ts: when, usageCompletedAt: when, usageTokensIn: 5, usageTokensOut: 2 };
  await writeFile(join(root, 'autonomy/runs.jsonl'), [saved, { ...saved, usageCachedTokens: 2 }].map(row => JSON.stringify(row)).join('\n'));
  const bot = { id: 'a', directory: root }, identity = { ...botCodexIdentity(root), saved: await readSavedCodexUsage(root) };
  const reports = { all: report([[1, 100, 70]]), week: report([[1, 20, 10]]), month: report([[1, 50, 30]]), at: when };
  const out = combineCodexUsage([bot], new Map([['a', identity]]),
    { children: new Map(), partial: false }, reports, 'UTC', new Date(when)).get('a')!;
  assert.deepEqual([out.week, out.month, out.all], [27, 57, 107]);
  assert.deepEqual(out.cacheRead, { week: null, month: null, all: null });
  assert.equal(out.incomplete, true);
});

test('a background run crossing the week boundary is not assigned wholly to the week', () => {
  const bot = { id: 'a', directory: '/fixture' };
  const identity = { ids: new Set([id(1)]), selected: true, partial: false, saved: {
    rows: [{ id: id(20), startedAt: '2026-11-14T23:59:00Z', completedAt: '2026-11-15T00:01:00Z',
      input: 5, output: 2, cached: 3, incomplete: false }], unknown: [], partial: false, hasCodex: true,
  } };
  const reports = { all: report([[1, 100]]), week: report([[1, 20]]), month: report([[1, 50]]), at: when };
  const out = combineCodexUsage([bot], new Map([['a', identity]]),
    { children: new Map(), partial: false }, reports, 'UTC', new Date(when)).get('a')!;
  assert.deepEqual([out.week, out.month, out.all], [20, 57, 107]);
  assert.equal(out.incomplete, true);
});

test('a legacy saved run without cache retains the total but makes only its split unavailable', () => {
  const bot = { id: 'a', directory: '/fixture' };
  const identity = { ids: new Set([id(1)]), selected: true, partial: false, saved: {
    rows: [{ id: id(20), startedAt: when, completedAt: when, input: 5, output: 2, cached: null, incomplete: false }],
    unknown: [], partial: false, hasCodex: true,
  } };
  const reports = { all: report([[1, 100, 70]]), week: report([[1, 20, 10]]), month: report([[1, 50, 30]]), at: when };
  const out = combineCodexUsage([bot], new Map([['a', identity]]),
    { children: new Map(), partial: false }, reports, 'UTC', new Date(when)).get('a')!;
  assert.deepEqual([out.week, out.month, out.all], [27, 57, 107]);
  assert.deepEqual(out.cacheRead, { week: null, month: null, all: null });
  assert.deepEqual(out.withoutCache, { week: null, month: null, all: null });
});

test('an impossible cache count does not invalidate the known total or invent a split', () => {
  const bot = { id: 'a', directory: '/fixture' };
  const identity = { ids: new Set([id(1)]), selected: true, partial: false,
    saved: { rows: [], unknown: [], partial: false, hasCodex: false } };
  const reports = { all: report([[1, 100, 101]]), week: report([[1, 20, 21]]), month: report([[1, 50, 51]]), at: when };
  const out = combineCodexUsage([bot], new Map([['a', identity]]),
    { children: new Map(), partial: false }, reports, 'UTC', new Date(when)).get('a')!;
  assert.deepEqual([out.week, out.month, out.all], [20, 50, 100]);
  assert.deepEqual(out.cacheRead, { week: null, month: null, all: null });
  assert.deepEqual(out.withoutCache, { week: null, month: null, all: null });
});

test('a saved run cannot report more cache reads than its input', () => {
  const bot = { id: 'a', directory: '/fixture' };
  const identity = { ids: new Set([id(1)]), selected: true, partial: false, saved: {
    rows: [{ id: id(20), startedAt: when, completedAt: when, input: 5, output: 7, cached: 8, incomplete: false }],
    unknown: [], partial: false, hasCodex: true,
  } };
  const reports = { all: report([[1, 100, 70]]), week: report([[1, 20, 10]]), month: report([[1, 50, 30]]), at: when };
  const out = combineCodexUsage([bot], new Map([['a', identity]]),
    { children: new Map(), partial: false }, reports, 'UTC', new Date(when)).get('a')!;
  assert.deepEqual([out.week, out.month, out.all], [32, 62, 112]);
  assert.deepEqual(out.cacheRead, { week: null, month: null, all: null });
  assert.deepEqual(out.withoutCache, { week: null, month: null, all: null });
});

test('a review subagent is attached by native session metadata without opening the state database', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pult-codex-edges-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'sessions');
  await mkdir(dir);
  const file = join(dir, 'fixture.jsonl');
  await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: id(4), parent_thread_id: id(1),
    source: { subagent: { other: 'guardian' } } } }) + '\n');
  const edges = codexEdges(root);
  assert.equal(edges.partial, false);
  assert.ok(edges.children.get(id(1))?.has(id(4)));
});

test('contradictory snapshots from a changing source are not shown as exact totals', () => {
  const bot = { id: 'a', directory: '/fixture' };
  const identity = { ids: new Set([id(1)]), selected: true, partial: false,
    saved: { rows: [], unknown: [], partial: false, hasCodex: false } };
  const reports = { all: report([[1, 50]]), week: report([[1, 70]]), month: report([[1, 60]]), at: when };
  const out = combineCodexUsage([bot], new Map([['a', identity]]),
    { children: new Map(), partial: false }, reports, 'UTC', new Date(when)).get('a')!;
  assert.deepEqual([out.week, out.month, out.all], [null, null, null]);
  assert.equal(out.incomplete, true);
});

test('unavailable ccusage never fabricates a zero and does not throw into the collector', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pult-codex-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bot = join(root, 'default');
  await mkdir(bot);
  await writeFile(join(bot, 'state.json'), JSON.stringify({ ccSessionId: encoded(1), extAuthBypass: 'codex' }));
  const source = new CodexUsageReader({ HOME: root, PULT_CCUSAGE_BIN: join(root, 'missing') }, root);
  const result = await source.collect([{ id: 'default', directory: bot }], 'UTC', new Date(when));
  assert.equal(result.failed, true);
  assert.deepEqual([result.usage.get('default')?.week, result.usage.get('default')?.month,
    result.usage.get('default')?.all], [null, null, null]);
});

test('a FIFO in place of the saved-run journal cannot block the collector', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pult-codex-fifo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'autonomy'));
  execFileSync('mkfifo', [join(root, 'autonomy/runs.jsonl')]);
  await assert.rejects(readSavedCodexUsage(root), /не является файлом/);
});
