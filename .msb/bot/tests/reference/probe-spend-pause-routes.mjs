/** Regression for the owner's selected spend-pause scope; see 16234e2 for RED.
 * Fake Telegram, model and reminder dispatcher; no real profile or network.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.execArgv.includes('--experimental-test-module-mocks')) {
  const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--no-warnings', fileURLToPath(import.meta.url)], {
    env: { PATH: '/usr/bin:/bin', TMPDIR: process.env.TMPDIR || '/tmp' }, stdio: 'inherit', timeout: 10000,
  });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

const { mock } = await import('node:test');
const mod = relative => new URL(`../../src/${relative}`, import.meta.url).href;
const idle = () => async () => {};
mock.module(mod('autonomy/openclaw-reminder-dispatch.mjs'), { namedExports: { createOpenClawReminderDispatcher: idle } });
mock.module(mod('autonomy/reminder-dispatch.mjs'), { namedExports: { createReminderDispatcher: idle } });
mock.module(mod('autonomy/legacy-dispatch.mjs'), { namedExports: { dispatchLegacyTimers: async () => {}, admitLegacyTimerRuns: async () => [] } });
mock.module(mod('agent/turn.mjs'), { namedExports: { runAgentTurn: async () => { throw Error('real turn prohibited'); }, supportsCodexAttachments: () => false } });
const { fixture } = await import('../helpers/menu-fixture.mjs');
const { startScheduler } = await import('../../src/autonomy/scheduler.mjs');
const { addTask, listTasks } = await import('../../src/autonomy/store.mjs');
const { currentReminderRefusal } = await import('../../src/autonomy/reminder-admission.mjs');
const { loadState, saveState } = await import('../../src/state.mjs');
const { SPEND_PAUSED } = await import('../../src/billing/owner-spend.mjs');
const cleanups = [], t = { after: fn => cleanups.push(fn) };
let scheduler, foregroundCalls = 0, intervalCalls = 0;
try {
  const f = await fixture(t, async () => { foregroundCalls++; return { ok: true, text: 'unexpected' }; }, { overlay: false });
  const initial = (await loadState()).state;
  const saved = { ...initial, costPaused: true, dailySpendLimit: 10, costHistory: {} };
  await saveState(saved);
  await f.message('synthetic foreground');
  const deadline = Date.now() + 3000;
  while (!f.messages.includes(SPEND_PAUSED) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(f.messages.includes(SPEND_PAUSED));
  assert.equal(foregroundCalls, 0);
  const refusal = currentReminderRefusal({ budget: {} }, saved, Date.now(), 0, undefined);
  assert.equal(refusal?.status, 'blocked');
  assert.match(refusal.detail, /costPaused/);
  await addTask({ id: 'fixture', prompt: 'synthetic interval', nextAt: Date.now() - 1000, everyHours: 1 });
  const before = await listTasks();
  scheduler = startScheduler({ log() {}, runTurn: async () => { intervalCalls++; return { ok: true, text: 'synthetic' }; } });
  await scheduler.tickNow();
  assert.equal(intervalCalls, 0);
  assert.deepEqual(await listTasks(), before);
  const after = (await loadState()).state;
  assert.equal(after.costPaused, true);
  assert.equal(after.extAuthBypass, 'codex');
  assert.equal(after.ccSessionId, saved.ccSessionId);
  assert.deepEqual(after, saved);
  console.log('VERIFIED: saved cost pause blocks foreground, reminder admission and a direct interval without advancing it.');
  console.log('Synthetic routes only; real provider billing and live delivery were not tested.');
} finally {
  if (scheduler) await scheduler.stop();
  for (const cleanup of cleanups.reverse()) await cleanup();
}
