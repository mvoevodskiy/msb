/**
 * Direct scheduled interval → real scheduler/agent admission → fake provider.
 * The unrelated dispatchers are mocked; all profiles and messages are synthetic.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const mod = relative => pathToFileURL(path.join(root, relative)).href;
const idle = () => async () => {};
mock.module(mod('.msb/bot/src/autonomy/openclaw-reminder-dispatch.mjs'), { namedExports: { createOpenClawReminderDispatcher: idle } });
mock.module(mod('.msb/bot/src/autonomy/reminder-dispatch.mjs'), { namedExports: { createReminderDispatcher: idle } });
mock.module(mod('.msb/bot/src/autonomy/legacy-dispatch.mjs'), { namedExports: { dispatchLegacyTimers: async () => {}, admitLegacyTimerRuns: async () => [] } });
let mcpGate;
mock.module(mod('.msb/bot/src/mcp/launch.mjs'), { namedExports: { prepareMcpLaunch: async () => {
  if (mcpGate) { const current = mcpGate; current.enter(); await current.held; }
  return null;
} } });
const spawned = [];
mock.module(mod('.msb/bot/src/agent/claude.mjs'), { namedExports: { runClaudeTurn: async opts => {
  spawned.push({ provider: opts.providerId, session: opts.sessionId, permissionMode: opts.permissionMode });
  return { sessionId: opts.sessionId || 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53',
    providerId: opts.providerId, text: 'fixture', isError: false, usage: { inputTokens: 0, outputTokens: 0 } };
} } });
const storeUrl = mod('.msb/bot/src/autonomy/store.mjs');
const realStore = await import(storeUrl);
let onAdmission;
mock.module(storeUrl, { namedExports: { ...realStore, admitCurrentTask: (...args) => {
  onAdmission?.();
  return realStore.admitCurrentTask(...args);
} } });
const { fixture } = await import(mod('.msb/bot/tests/helpers/menu-fixture.mjs'));
const { startScheduler } = await import(mod('.msb/bot/src/autonomy/scheduler.mjs'));
const { runAgentTurn } = await import(mod('.msb/bot/src/agent/turn.mjs'));
const { saveState, loadState, updateState } = await import(mod('.msb/bot/src/state.mjs'));
const { statePath } = await import(mod('.msb/bot/src/paths.mjs'));
const { withFileLock } = await import(mod('.msb/bot/shared/file-lock.mjs'));
const { addTask, listTasks } = await import(mod('.msb/bot/src/autonomy/store.mjs'));

function gate() {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  return { enter, entered, held, release };
}
async function setup(t, provider = 'codex', paused = true) {
  spawned.length = 0; mcpGate = undefined; onAdmission = undefined;
  const f = await fixture(t, undefined, { overlay: false });
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-subscription';
  const base = (await loadState()).state;
  const session = provider === 'codex' ? base.ccSessionId :
    provider === 'cursor' ? 'ext:cursor:fixture-session' : 'fixture-claude-session';
  const state = { ...base, engine: 'cc', costPaused: paused, authMode: 'subscription',
    hasSubscriptionAuth: true, ccSessionId: session, ccModel: 'sonnet', ccEffort: 'high',
    permissionMode: 'bypassPermissions' };
  if (provider === 'claude') delete state.extAuthBypass;
  else state.extAuthBypass = provider;
  await saveState(state);
  await addTask({ id: 'fixture', title: 'fixture', prompt: 'synthetic', everyHours: 1, nextAt: Date.now() - 1000 });
  const tasks = await listTasks(), notices = [];
  const options = { log() {}, adminId: 42, api: { sendMessage: async (...args) => { notices.push(args); } } };
  return { f, state, session, tasks, notices, options };
}
async function noRunLog() {
  await assert.rejects(fs.stat(path.join(process.env.MSB_RUNTIME_ROOT, 'autonomy', 'runs.jsonl')), { code: 'ENOENT' });
}

for (const provider of ['codex', 'claude', 'cursor']) {
  test('saved spend pause defers the ' + provider + ' interval and resume runs the same task', async t => {
    const f = await setup(t, provider);
    const before = await fs.readFile(statePath(), 'utf8');
    const scheduler = startScheduler(f.options);
    try {
      await scheduler.tickNow();
      assert.equal(spawned.length, 0);
      assert.deepEqual(await listTasks(), f.tasks);
      assert.equal(await fs.readFile(statePath(), 'utf8'), before);
      assert.equal(f.notices.length, 0);
      await noRunLog();
      await f.f.callback('settings:cost:resume');
      const resumed = (await loadState()).state;
      assert.equal(resumed.costPaused, false);
      assert.equal(resumed.ccSessionId, f.session);
      assert.equal(resumed.extAuthBypass || 'claude', provider);
      assert.equal(resumed.permissionMode, f.state.permissionMode);
      await scheduler.tickNow();
      assert.equal(spawned.length, 1);
      assert.equal(spawned[0].provider, provider);
      assert.equal(spawned[0].session, f.session);
      assert.equal(spawned[0].permissionMode, 'bypassPermissions');
      assert.ok((await listTasks())[0].nextAt > f.tasks[0].nextAt);
      assert.equal(f.notices.length, 1);
    } finally { await scheduler.stop(); }
  });
}

test('a paused first interval is deferred before reserving a new session', async t => {
  await setup(t, 'codex');
  await updateState(state => { delete state.ccSessionId; return state; });
  const before = await fs.readFile(statePath(), 'utf8');
  const result = await runAgentTurn({ prompt: 'synthetic', autonomy: true, intervalShouldDefer: () => false });
  assert.equal(result.intervalDeferred, true);
  assert.equal(spawned.length, 0);
  assert.equal(await fs.readFile(statePath(), 'utf8'), before);
});

test('a pause applied after scheduler admission is rechecked inside the real runner', async t => {
  const f = await setup(t, 'codex', false);
  const hold = gate();
  const scheduler = startScheduler({ ...f.options, runTurn: async options => {
    hold.enter(); await hold.held; return runAgentTurn(options);
  } });
  let running;
  try {
    running = scheduler.tickNow(); await hold.entered;
    await updateState(state => { state.costPaused = true; return state; });
    hold.release(); await running; running = undefined;
    assert.equal(spawned.length, 0);
    assert.deepEqual(await listTasks(), f.tasks);
    assert.equal(f.notices.length, 0);
    await noRunLog();
  } finally { hold.release(); if (running) await running; await scheduler.stop(); }
});

test('a pause applied during preparation is rechecked before the model launch', async t => {
  const f = await setup(t, 'codex', false);
  const hold = gate(); mcpGate = hold;
  const scheduler = startScheduler(f.options);
  let running;
  try {
    running = scheduler.tickNow(); await hold.entered;
    await updateState(state => { state.costPaused = true; return state; });
    hold.release(); await running; running = undefined;
    assert.equal(spawned.length, 0);
    assert.deepEqual(await listTasks(), f.tasks);
    assert.equal(f.notices.length, 0);
    assert.equal((await loadState()).state.ccSessionId, f.session);
    await noRunLog();
  } finally { hold.release(); mcpGate = undefined; if (running) await running; await scheduler.stop(); }
});

test('a pause during first-session preparation releases only its own reservation', async t => {
  const f = await setup(t, 'codex', false);
  await updateState(state => { delete state.ccSessionId; return state; });
  const hold = gate(); mcpGate = hold;
  const scheduler = startScheduler(f.options);
  let running;
  try {
    running = scheduler.tickNow(); await hold.entered;
    assert.ok((await loadState()).state.pendingCcSessionStarts?.codex);
    await updateState(state => { state.costPaused = true; return state; });
    hold.release(); await running; running = undefined;
    const state = (await loadState()).state;
    assert.equal(state.ccSessionId, undefined);
    assert.equal(state.pendingCcSessionStarts, undefined);
    assert.equal(state.costPaused, true);
    assert.equal(spawned.length, 0);
    assert.deepEqual(await listTasks(), f.tasks);
    assert.equal(f.notices.length, 0);
    await noRunLog();
  } finally { hold.release(); mcpGate = undefined; if (running) await running; await scheduler.stop(); }
});

test('a pause applied while waiting for the task lock defers the interval', async t => {
  const f = await setup(t, 'codex', false);
  const hold = gate(), admission = gate();
  const taskFile = path.join(process.env.MSB_RUNTIME_ROOT, 'autonomy', 'tasks.json');
  const locked = withFileLock(taskFile, async () => { hold.enter(); await hold.held; });
  await hold.entered;
  onAdmission = admission.enter;
  const scheduler = startScheduler(f.options);
  let running;
  try {
    running = scheduler.tickNow(); await admission.entered;
    await updateState(state => { state.costPaused = true; return state; });
    hold.release(); await locked; await running; running = undefined;
    assert.equal(spawned.length, 0);
    assert.deepEqual(await listTasks(), f.tasks);
    assert.equal(f.notices.length, 0);
    await noRunLog();
  } finally { onAdmission = undefined; hold.release(); await locked; if (running) await running; await scheduler.stop(); }
});

test('/stop during the asynchronous spend check prevents the interval', async t => {
  const f = await setup(t, 'codex', false);
  const hold = gate(), target = statePath(), readReal = fs.readFile.bind(fs);
  let gated = false;
  const read = t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (!gated && String(file) === target) { gated = true; hold.enter(); await hold.held; }
    return readReal(file, ...args);
  });
  const scheduledTurns = { stopEpoch: 0, pending: false };
  const scheduler = startScheduler({ ...f.options, scheduledTurns });
  let running;
  try {
    running = scheduler.tickNow(); await hold.entered;
    scheduledTurns.stopEpoch++;
    hold.release(); await running; running = undefined;
    read.mock.restore();
    assert.equal(spawned.length, 0);
    assert.deepEqual(await listTasks(), f.tasks);
    assert.equal(f.notices.length, 0);
    await noRunLog();
  } finally { hold.release(); read.mock.restore(); if (running) await running; await scheduler.stop(); }
});

test('the scheduler blocks an injected interval runner while the pause is saved', async t => {
  const f = await setup(t);
  let calls = 0;
  const scheduler = startScheduler({ ...f.options, runTurn: async () => { calls++; return { ok: true, text: 'fixture' }; } });
  try {
    await scheduler.tickNow();
    assert.equal(calls, 0);
    assert.deepEqual(await listTasks(), f.tasks);
    assert.equal(f.notices.length, 0);
    await noRunLog();
  } finally { await scheduler.stop(); }
});

test('a state read error cannot launch or advance an interval', async t => {
  const f = await setup(t);
  const target = statePath(), before = await fs.readFile(target, 'utf8');
  const readReal = fs.readFile.bind(fs);
  const read = t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (String(file) === target) throw Object.assign(new Error('fixture EIO'), { code: 'EIO' });
    return readReal(file, ...args);
  });
  let calls = 0;
  const scheduler = startScheduler({ ...f.options, runTurn: async () => { calls++; return { ok: true, text: 'fixture' }; } });
  try {
    await scheduler.tickNow();
    read.mock.restore();
    assert.equal(calls, 0);
    assert.deepEqual(await listTasks(), f.tasks);
    assert.equal(await fs.readFile(target, 'utf8'), before);
    assert.equal(f.notices.length, 0);
  } finally { read.mock.restore(); await scheduler.stop(); }
});
