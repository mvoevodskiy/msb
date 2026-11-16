/**
 * Saved reminders and prompts due during owner spend pause. Synthetic Telegram,
 * provider and profile only; [old/owner contract](reference/parity-owner-spend-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startScheduler } from '../src/autonomy/scheduler.mjs';
import { actionRoot, statePath } from '../src/paths.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { changeSavedAction, withActions } from '../src/autonomy/reminder-store.mjs';
import { setOwnerPause } from '../src/autonomy/owner-pause.mjs';
import { rescheduleTaskFromTurn } from '../src/autonomy/saved-task-reschedule.mjs';
import { fixture } from './helpers/menu-fixture.mjs';

const now = Date.parse('2026-11-11T12:00:00.000Z');
const owner = -100777;
function action(id, trigger, kind = 'reminder') {
  return { id, name: id, enabled: true, runner: 'auto', trigger,
    task: kind === 'prompt' ? { kind, prompt: 'prompt ' + id } : { kind, text: 'text ' + id },
    capability: 'read', authority: { profile: 'standard' }, output: { format: 'tg-message' } };
}
async function profile(t, actions, options = {}) {
  const f = await fixture(t, async () => assert.fail('owner turn must not run'),
    { overlay: false, runtimeProfile: 'jar1' });
  for (const key of ['MSB_SESSION_DIR', 'IIA_SESSION_DIR', 'AUTONOMY_DIR', 'AUTONOMY_DAILY_CAP_USD',
    'AUTONOMY_DAILY_CAP_RUNS', 'AUTONOMY_DAILY_CAP_TOKENS', 'AUTONOMY_RESERVE_FRACTION']) delete process.env[key];
  process.env.AUTONOMY_ENABLED = '1';
  await saveState({ ...(await loadState()).state, engine: 'cc', extAuthBypass: options.provider ?? 'codex', authMode: 'subscription', hasSubscriptionAuth: true,
    chatId: owner, userId: 42, timezone: 'UTC', dailySpendLimit: 0, costPaused: options.paused ?? true });
  const root = actionRoot(), file = path.join(root, 'actions.json');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(file, JSON.stringify(actions));
  let clock = now, scheduler;
  const calls = [];
  const runCodexPrompt = async ({ canLaunch }) => {
    if (options.runCodexPrompt) return options.runCodexPrompt({ canLaunch });
    if (!await canLaunch()) return;
    calls.push('codex');
    return { providerId: 'codex', text: 'synthetic prompt result', assistantTextObserved: true, isError: false,
      usage: { inputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 1 } };
  };
  const start = () => startScheduler({ api: f.bot.api, adminId: 42, timezone: 'UTC', now: () => clock,
    runCodexPrompt, runCursorPrompt: options.runCursorPrompt ?? (async () => assert.fail('unexpected Cursor launch')), scheduledTurns: f.bot[Symbol.for('msb.scheduledTurns')], log() {}, runTurn: async () => assert.fail('interval runner must not run') });
  scheduler = start();
  t.after(async () => scheduler.stop());
  return { ...f, file, calls, get scheduler() { return scheduler; },
    setTime(value) { clock = value; },
    async restart() { await scheduler.stop(); scheduler = start(); },
    another() { const second = start(); t.after(() => second.stop()); return second; },
    async actions() { return JSON.parse(await fs.readFile(file, 'utf8')); },
    async runs() { return (await fs.readFile(path.join(root, 'autonomy', 'runs.jsonl'), 'utf8')
      .catch(error => { if (error.code === 'ENOENT') return ''; throw error; }))
      .split('\n').filter(Boolean).map(JSON.parse); },
  };
}

test('due once, interval and cron reminders wait through pause and restart, then deliver once', async t => {
  const items = [action('once', { kind: 'once', at: new Date(now).toISOString() }),
    { ...action('interval', { kind: 'interval', intervalMinutes: 60 }), lastRunAt: new Date(now - 3_600_000).toISOString() },
    action('cron', { kind: 'cron', cron: '0 12 * * *' })];
  const f = await profile(t, items);
  await f.scheduler.tickNow();
  await f.scheduler.tickNow();
  assert.equal(f.messages.length, 3);
  assert.ok(f.messages.every(text => text.includes('приостановлено: дневной лимит расходов')));
  assert.deepEqual(await f.runs(), []);
  const paused = await f.actions();
  assert.ok(paused.every(row => row.enabled && row.costPausePending));
  assert.equal(paused[0].lastRunAt, undefined);
  assert.equal(paused[1].lastRunAt, items[1].lastRunAt);
  assert.equal(paused[2].lastRunAt, undefined);
  await f.restart();
  f.setTime(now + 2 * 60_000);
  await f.callback('settings:cost:resume');
  await f.scheduler.tickNow();
  assert.deepEqual(f.messages.slice(3), ['⏰ text once', '⏰ text interval', '⏰ text cron']);
  assert.equal((await f.runs()).filter(row => row.status === 'ok').length, 3);
  await f.scheduler.tickNow();
  assert.equal(f.messages.length, 6);
});

test('spend pause between claim and literal send restores the one-time action', async t => {
  const original = action('raced', { kind: 'once', at: new Date(now).toISOString() });
  const f = await profile(t, [original], { paused: false });
  const rename = fs.rename.bind(fs);
  let changed = false;
  t.mock.method(fs, 'rename', async (from, to, ...args) => {
    const result = await rename(from, to, ...args);
    if (to === f.file && !changed) {
      changed = true;
      await saveState({ ...(await loadState()).state, costPaused: true });
    }
    return result;
  });
  await f.scheduler.tickNow();
  assert.equal(changed, true);
  assert.deepEqual(f.messages, []);
  const [paused] = await f.actions();
  assert.equal(paused.enabled, true);
  assert.equal(paused.lastRunAt, undefined);
  assert.ok(paused.costPausePending);
  await f.callback('settings:cost:resume');
  await f.scheduler.tickNow();
  assert.deepEqual(f.messages, ['⏰ text raced']);
  await f.scheduler.tickNow();
  assert.equal(f.messages.length, 1);
});

test('spend pause during saved prompt preparation retains a cron occurrence outside its minute', async t => {
  const original = action('prompt', { kind: 'cron', cron: '0 12 * * *' }, 'prompt');
  const f = await profile(t, [original], { paused: false });
  const waiting = Promise.withResolvers(), release = Promise.withResolvers();
  const realpath = fs.realpath.bind(fs), workspace = path.join(actionRoot(), 'autonomy', 'cc-workspace');
  let held = false;
  t.mock.method(fs, 'realpath', async (file, ...args) => {
    if (file === workspace && !held) { held = true; waiting.resolve(); await release.promise; }
    return realpath(file, ...args);
  });
  const before = (await loadState()).state;
  const tick = f.scheduler.tickNow();
  try {
    await Promise.race([waiting.promise, tick.then(() => assert.fail('expected workspace preparation'))]);
    await saveState({ ...(await loadState()).state, costPaused: true });
  } finally { release.resolve(); }
  await tick;
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.messages, []);
  const [paused] = await f.actions();
  assert.ok(paused.costPausePending);
  assert.equal(paused.lastRunAt, undefined);
  f.setTime(now + 2 * 60_000);
  await f.callback('settings:cost:resume');
  await f.scheduler.tickNow();
  assert.deepEqual(f.calls, ['codex']);
  assert.ok(f.messages.some(value => value.includes('synthetic prompt result')));
  assert.equal((await loadState()).state.ccSessionId, before.ccSessionId);
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, 1);
});

test('a deferred occurrence respects disable, removal and a changed schedule', async t => {
  const items = [action('disabled', { kind: 'once', at: new Date(now).toISOString() }),
    action('deleted', { kind: 'once', at: new Date(now).toISOString() }),
    action('moved', { kind: 'cron', cron: '0 12 * * *' })];
  const f = await profile(t, items);
  await f.scheduler.tickNow();
  const notices = [...f.messages];
  assert.equal(notices.length, 3);
  await changeSavedAction('disabled', false);
  await changeSavedAction('deleted', true);
  await withActions(process.env, async (rows, save) => {
    const i = rows.findIndex(row => row.id === 'moved');
    rows[i] = { ...rows[i], trigger: { kind: 'cron', cron: '0 13 * * *' }, scheduleRevision: 'new-schedule' };
    await save();
  });
  f.setTime(now + 2 * 60_000);
  await f.callback('settings:cost:resume');
  await f.scheduler.tickNow();
  assert.deepEqual(f.messages, notices);
  assert.equal((await f.actions()).find(row => row.id === 'disabled').enabled, false);
  await changeSavedAction('disabled', false);
  await f.scheduler.tickNow();
  assert.deepEqual(f.messages.slice(notices.length), ['⏰ text disabled']);
});


test('/stop during the new state read prevents a claimed literal send', async t => {
  const original = action('stop-race', { kind: 'once', at: new Date(now).toISOString() });
  const f = await profile(t, [original], { paused: false });
  const readFile = fs.readFile.bind(fs), rename = fs.rename.bind(fs);
  const waiting = Promise.withResolvers(), release = Promise.withResolvers();
  let claimed = false, held = false;
  t.mock.method(fs, 'rename', async (from, to, ...args) => {
    const result = await rename(from, to, ...args);
    if (to === f.file) claimed = true;
    return result;
  });
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (claimed && file === statePath() && !held) { held = true; waiting.resolve(); await release.promise; }
    return readFile(file, ...args);
  });
  const tick = f.scheduler.tickNow();
  try {
    await Promise.race([waiting.promise, tick.then(() => assert.fail('expected state read after claim'))]);
    await f.message('/stop');
  } finally { release.resolve(); }
  await tick;
  assert.ok(f.messages.every(text => text !== '⏰ text stop-race'));
  const [after] = await f.actions();
  assert.equal(after.enabled, true);
  assert.equal(after.lastRunAt, undefined);
});

test('owner STOP after a paused prelaunch keeps the deferred cron occurrence', async t => {
  const original = action('stop-prompt', { kind: 'cron', cron: '0 12 * * *' }, 'prompt');
  const checking = Promise.withResolvers(), go = Promise.withResolvers(), rejected = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0;
  const f = await profile(t, [original], { paused: false, runCodexPrompt: async ({ canLaunch }) => {
    checking.resolve(); await go.promise;
    if (!await canLaunch()) { rejected.resolve(); await release.promise; return; }
    calls++;
    return { providerId: 'codex', text: 'ok', assistantTextObserved: true, isError: false };
  } });
  const tick = f.scheduler.tickNow();
  try {
    await Promise.race([checking.promise, tick.then(() => assert.fail('expected prelaunch'))]);
    await saveState({ ...(await loadState()).state, costPaused: true });
    go.resolve();
    await rejected.promise;
    await setOwnerPause(true, { now, check: async () => null, checkEngine: () => null });
  } finally { go.resolve(); release.resolve(); }
  await tick;
  const [pending] = await f.actions();
  assert.ok(pending.costPausePending);
  assert.equal(calls, 0);
  await setOwnerPause(false, { now: now + 1, check: async () => null, checkEngine: () => null });
  f.setTime(now + 2 * 60_000);
  await f.callback('settings:cost:resume');
  await f.scheduler.tickNow();
  assert.equal(calls, 1);
});

test('another budget refusal keeps the deferred reminder and warns once until it can run', async t => {
  const original = { ...action('budget', { kind: 'once', at: new Date(now).toISOString() }),
    budget: { maxUsdPerRun: 0 } };
  const f = await profile(t, [original]);
  await f.scheduler.tickNow();
  await f.callback('settings:cost:resume');
  await f.scheduler.tickNow();
  await f.scheduler.tickNow();
  assert.equal(f.messages.length, 2);
  assert.match(f.messages[1], /лимита действия на ход/);
  assert.ok((await f.actions())[0].costPausePending);
  await withActions(process.env, async (rows, save) => {
    rows[0] = { ...rows[0], budget: { maxUsdPerRun: 1 } };
    await save();
  });
  await f.scheduler.tickNow();
  assert.equal(f.messages.at(-1), '⏰ text budget');
  await f.scheduler.tickNow();
  assert.equal(f.messages.filter(value => value === '⏰ text budget').length, 1);
});

test('changing the task text keeps the deferred schedule and runs the current text', async t => {
  const original = action('edited', { kind: 'once', at: new Date(now).toISOString() });
  const f = await profile(t, [original]);
  await f.scheduler.tickNow();
  await withActions(process.env, async (rows, save) => {
    rows[0] = { ...rows[0], task: { ...rows[0].task, text: 'new text' }, taskTextRevision: 'new-text' };
    await save();
  });
  await f.callback('settings:cost:resume');
  await f.scheduler.tickNow();
  assert.equal(f.messages.at(-1), '⏰ new text');
  assert.ok(!f.messages.includes('⏰ text edited'));
});

test('a newer successful attempt fences an older stored pending occurrence', async t => {
  const original = action('newer', { kind: 'cron', cron: '0 12 * * *' });
  const f = await profile(t, [original]);
  await f.scheduler.tickNow();
  await withActions(process.env, async (rows, save) => {
    rows[0] = { ...rows[0], lastRunAt: new Date(now + 60_000).toISOString() };
    await save();
  });
  f.setTime(now + 2 * 60_000);
  await f.callback('settings:cost:resume');
  await f.scheduler.tickNow();
  assert.ok(!f.messages.includes('⏰ text newer'));
});


test('two schedulers coalesce the paused cron and claim its deferred occurrence once', async t => {
  const original = action('concurrent', { kind: 'cron', cron: '0 12 * * *' });
  const f = await profile(t, [original]);
  const second = f.another();
  await Promise.all([f.scheduler.tickNow(), second.tickNow()]);
  assert.equal(f.messages.filter(text => text.includes('приостановлено:')).length, 1);
  assert.ok((await f.actions())[0].costPausePending);
  f.setTime(now + 2 * 60_000);
  await f.callback('settings:cost:resume');
  await Promise.all([f.scheduler.tickNow(), second.tickNow()]);
  assert.equal(f.messages.filter(text => text === '⏰ text concurrent').length, 1);
  assert.equal((await f.runs()).filter(run => run.status === 'ok').length, 1);
});

test('unreadable final state does not consume a cron occurrence before delivery', async t => {
  const original = action('state-error', { kind: 'cron', cron: '0 12 * * *' });
  const f = await profile(t, [original], { paused: false });
  const readFile = fs.readFile.bind(fs), rename = fs.rename.bind(fs);
  let claimed = false, failed = false;
  t.mock.method(fs, 'rename', async (from, to, ...args) => {
    const result = await rename(from, to, ...args);
    if (to === f.file) claimed = true;
    return result;
  });
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (claimed && file === statePath() && !failed) {
      failed = true; throw Object.assign(new Error('synthetic state read failure'), { code: 'EIO' });
    }
    return readFile(file, ...args);
  });
  await f.scheduler.tickNow();
  assert.equal(failed, true);
  assert.ok((await f.actions())[0].costPausePending);
  assert.ok(!f.messages.includes('⏰ text state-error'));
  f.setTime(now + 2 * 60_000);
  await f.scheduler.tickNow();
  assert.equal(f.messages.filter(value => value === '⏰ text state-error').length, 1);
});


test('resume during preflight cannot bypass the shared daily run limit', async t => {
  const original = action('resume-race', { kind: 'once', at: new Date(now).toISOString() });
  const f = await profile(t, [original]);
  process.env.AUTONOMY_DAILY_CAP_RUNS = '1';
  const journal = path.join(path.dirname(f.file), 'autonomy', 'runs.jsonl');
  await fs.mkdir(path.dirname(journal), { recursive: true });
  await fs.writeFile(journal, JSON.stringify({ ts: new Date(now).toISOString(), actionId: 'previous',
    kind: 'prompt', status: 'ok', costUsd: 0, tokensIn: 0 }) + '\n');
  const readFile = fs.readFile.bind(fs);
  const waiting = Promise.withResolvers(), release = Promise.withResolvers();
  let reads = 0;
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (file === f.file && ++reads === 2) { waiting.resolve(); await release.promise; }
    return readFile(file, ...args);
  });
  const tick = f.scheduler.tickNow();
  try {
    await Promise.race([waiting.promise, tick.then(() => assert.fail('expected locked action reread'))]);
    await f.callback('settings:cost:resume');
  } finally { release.resolve(); }
  await tick;
  assert.ok(!f.messages.includes('⏰ text resume-race'));
  assert.ok((await f.actions())[0].costPausePending);
  await f.scheduler.tickNow();
  assert.ok(!f.messages.includes('⏰ text resume-race'));
  assert.ok(f.messages.some(text => text.includes('дневной запас')));
  assert.ok((await f.actions())[0].costPausePending);
});

test('simultaneous /stop and spend pause preserve a claimed cron before sending', async t => {
  const original = action('both', { kind: 'cron', cron: '0 12 * * *' });
  const f = await profile(t, [original], { paused: false });
  const readFile = fs.readFile.bind(fs), rename = fs.rename.bind(fs);
  const waiting = Promise.withResolvers(), release = Promise.withResolvers();
  let claimed = false, held = false;
  t.mock.method(fs, 'rename', async (from, to, ...args) => {
    const result = await rename(from, to, ...args);
    if (to === f.file) claimed = true;
    return result;
  });
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (claimed && file === statePath() && !held) { held = true; waiting.resolve(); await release.promise; }
    return readFile(file, ...args);
  });
  const tick = f.scheduler.tickNow();
  try {
    await Promise.race([waiting.promise, tick.then(() => assert.fail('expected state read after claim'))]);
    await saveState({ ...(await loadState()).state, costPaused: true });
    await f.message('/stop');
  } finally { release.resolve(); }
  await tick;
  assert.ok((await f.actions())[0].costPausePending);
  assert.ok(!f.messages.includes('⏰ text both'));
  f.setTime(now + 2 * 60_000);
  await f.callback('settings:cost:resume');
  await f.scheduler.tickNow();
  assert.equal(f.messages.filter(text => text === '⏰ text both').length, 1);
});

test('adapter cleanup error after a rejected paused prelaunch keeps the cron occurrence', async t => {
  const original = action('cleanup', { kind: 'cron', cron: '0 12 * * *' }, 'prompt');
  const checking = Promise.withResolvers(), go = Promise.withResolvers();
  let calls = 0;
  const f = await profile(t, [original], { paused: false, runCodexPrompt: async ({ canLaunch }) => {
    checking.resolve(); await go.promise;
    if (!await canLaunch()) throw Error('synthetic cleanup error');
    calls++;
    return { providerId: 'codex', text: 'ok', assistantTextObserved: true, isError: false };
  } });
  const tick = f.scheduler.tickNow();
  try {
    await Promise.race([checking.promise, tick.then(() => assert.fail('expected prelaunch'))]);
    await saveState({ ...(await loadState()).state, costPaused: true });
  } finally { go.resolve(); }
  await tick;
  assert.ok((await f.actions())[0].costPausePending);
  assert.equal(calls, 0);
  f.setTime(now + 2 * 60_000);
  await f.callback('settings:cost:resume');
  await f.scheduler.tickNow();
  assert.equal(calls, 1);
});

test('spend pause after claim defers an early model error until resume', async t => {
  const original = action('model-error', { kind: 'cron', cron: '0 12 * * *' }, 'prompt');
  original.task.model = 'opus';
  const f = await profile(t, [original], { paused: false, provider: 'cursor' });
  const rename = fs.rename.bind(fs);
  let changed = false;
  t.mock.method(fs, 'rename', async (from, to, ...args) => {
    const result = await rename(from, to, ...args);
    if (to === f.file && !changed) {
      changed = true;
      await saveState({ ...(await loadState()).state, costPaused: true });
    }
    return result;
  });
  await f.scheduler.tickNow();
  assert.equal(changed, true);
  assert.ok((await f.actions())[0].costPausePending);
  assert.deepEqual(f.messages, []);
  f.setTime(now + 2 * 60_000);
  await f.callback('settings:cost:resume');
  await f.scheduler.tickNow();
  assert.equal((await f.actions())[0].lastStatus, 'error');
  assert.ok(f.messages.some(text => text.includes('модель не совместима с Cursor')));
});

test('owner disabling a claimed deferred cron keeps its pending occurrence until re-enabled', async t => {
  const original = action('toggle-prompt', { kind: 'cron', cron: '0 12 * * *' }, 'prompt');
  const checking = Promise.withResolvers(), go = Promise.withResolvers();
  let calls = 0;
  const f = await profile(t, [original], { runCodexPrompt: async ({ canLaunch }) => {
    checking.resolve(); await go.promise;
    if (!await canLaunch()) return;
    calls++;
    return { providerId: 'codex', text: 'ok', assistantTextObserved: true, isError: false };
  } });
  await f.scheduler.tickNow();
  f.setTime(now + 2 * 60_000);
  await f.callback('settings:cost:resume');
  const tick = f.scheduler.tickNow();
  try {
    await Promise.race([checking.promise, tick.then(() => assert.fail('expected prelaunch'))]);
    await changeSavedAction('toggle-prompt', false);
  } finally { go.resolve(); }
  await tick;
  const [disabled] = await f.actions();
  assert.equal(disabled.enabled, false);
  assert.ok(disabled.costPausePending);
  assert.equal(calls, 0);
  await changeSavedAction('toggle-prompt', false);
  await f.scheduler.tickNow();
  assert.equal(calls, 1);
});

test('a workspace preparation failure while spend is paused keeps the unstarted cron occurrence', async t => {
  const original = action('workspace-error', { kind: 'cron', cron: '0 12 * * *' }, 'prompt');
  const f = await profile(t, [original], { paused: false });
  const waiting = Promise.withResolvers(), release = Promise.withResolvers();
  const realpath = fs.realpath.bind(fs), workspace = path.join(actionRoot(), 'autonomy', 'cc-workspace');
  let held = false;
  t.mock.method(fs, 'realpath', async (file, ...args) => {
    if (file === workspace && !held) {
      held = true; waiting.resolve(); await release.promise;
      throw Object.assign(new Error('synthetic workspace error'), { code: 'EIO' });
    }
    return realpath(file, ...args);
  });
  const tick = f.scheduler.tickNow();
  try {
    await Promise.race([waiting.promise, tick.then(() => assert.fail('expected workspace preparation'))]);
    await saveState({ ...(await loadState()).state, costPaused: true });
  } finally { release.resolve(); }
  await tick;
  assert.ok((await f.actions())[0].costPausePending);
  assert.deepEqual(f.calls, []);
  f.setTime(now + 2 * 60_000);
  await f.callback('settings:cost:resume');
  await f.scheduler.tickNow();
  assert.deepEqual(f.calls, ['codex']);
});

test('an unknown future pending format survives an ordinary due action', async t => {
  const foreign = { version: 2, opaque: { keep: 'fixture data' } };
  const original = { ...action('foreign', { kind: 'once', at: new Date(now).toISOString() }),
    costPausePending: foreign };
  const f = await profile(t, [original], { paused: false });
  await f.scheduler.tickNow();
  assert.equal(f.messages.filter(value => value === '⏰ text foreign').length, 1);
  assert.deepEqual((await f.actions())[0].costPausePending, foreign);
});


test('rescheduling preserves an unknown future pending format', async t => {
  const foreign = { version: 2, opaque: { keep: 'fixture data' } };
  const original = { ...action('foreign-move', { kind: 'once', at: new Date(now).toISOString() }),
    enabled: false, disabledReason: 'owner', costPausePending: foreign };
  const f = await profile(t, [original], { paused: false });
  const result = await rescheduleTaskFromTurn('foreign-move', '+1h', { rail: 'cc', timezone: 'UTC', now });
  assert.equal(result.action?.id, 'foreign-move');
  assert.deepEqual((await f.actions())[0].costPausePending, foreign);
});
