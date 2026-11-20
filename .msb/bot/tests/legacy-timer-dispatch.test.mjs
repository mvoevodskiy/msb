/**
 * Saved timer scheduler → Telegram inbox through real handlers and fake APIs.
 * Old blob 73aa9e7e850bad7ac1ea8a8091d086ecbfd47a11:
 * due checks 18259–18283, dispatch 108800–108834, gU 111460–111475,
 * queue 110140–110167, boot 122276–122280. [Contract](reference/parity-autonomy-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startScheduler } from '../src/autonomy/scheduler.mjs';
import { changeLegacyTimer, claimLegacyTimerRuns } from '../src/autonomy/legacy-timers.mjs';
import { addTask, listTasks } from '../src/autonomy/store.mjs';
import { botRoot, msbRoot, statePath } from '../src/paths.mjs';
import { loadState, saveState, updateState } from '../src/state.mjs';
import { createBot } from '../src/telegram/bot.mjs';
import { fixture } from './helpers/menu-fixture.mjs';
import { withFileLock } from '../shared/file-lock.mjs';

const tick = Date.parse('2026-10-25T03:30:00.000Z');
const stamp = new Date(tick).toISOString();
const timer = {
  id: 'one',
  name: 'Почта',
  prompt: 'Проверить почту',
  enabled: true,
  type: 'once',
  at: '2026-10-25T03:20:00.000Z',
};
const timerPrompt = '⏰ Таймер "Почта":\nПроверить почту';
const normalResult = { ok: true, text: 'Напоминание готово', result: { context: { contextTokens: 5, contextWindow: 10 } } };
const groupChat = -10000234;

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(check, label) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(label);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function dispatchFixture(t, { timers = [timer], owner = 42, chatId = groupChat, run } = {}) {
  const calls = [], recipients = [];
  let time = tick;
  const runTimer = async args => {
    calls.push(args);
    return run ? run(args) : normalResult;
  };
  const f = await fixture(t, runTimer, { overlay: false, runtimeProfile: 'jar1', now: () => time });
  for (const key of ['MSB_SESSION_DIR', 'IIA_SESSION_DIR', 'AUTONOMY_DIR']) delete process.env[key];
  process.env.TZ = 'UTC';
  const { state } = await loadState();
  await saveState({ ...state, chatId, userId: owner, timezone: 'Asia/Kolkata' });
  const file = path.join(botRoot(), 'schedules.json');
  await fs.writeFile(file, JSON.stringify(timers));
  const send = f.bot.api.sendMessage;
  f.bot.api.sendMessage = async (chat, ...args) => { recipients.push(chat); return send(chat, ...args); };
  const intervalRuns = [];
  const start = bot => startScheduler({ api: bot.api, adminId: 42, timezone: 'UTC', log() {},
    scheduledTurns: bot[Symbol.for('msb.scheduledTurns')], now: () => time,
    runTurn: async args => { intervalRuns.push(args); return { ok: true, text: 'interval answer' }; },
  });
  const scheduler = start(f.bot);
  t.after(() => scheduler.stop());
  return { ...f, scheduler, file, calls, recipients, intervalRuns, setTime(value) { time = value; },
    records: async () => JSON.parse(await fs.readFile(file, 'utf8')),
    async restart() {
      await scheduler.stop();
      await f.bot.stop();
      const bot = createBot({ botToken: 'fake', botId: 'default', adminId: 42, workspace: f.workspace, timezone: 'UTC' },
        { bot: new f.bot.constructor(), runTurn: runTimer, now: () => time });
      await bot.start();
      const fresh = start(bot);
      return { scheduler: fresh, async close() { await fresh.stop(); await bot.stop(); } };
    },
  };
}

test('legacy once: emits the old prompt to the saved owner chat and consumes it exactly once', async t => {
  const f = await dispatchFixture(t);
  await f.scheduler.tickNow();

  await until(() => f.messages.some(text => text.includes('Напоминание готово')), 'timer must deliver through the Telegram turn');
  assert.deepEqual(await f.records(), [{ ...timer, enabled: false, lastRunAt: stamp }]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].prompt, timerPrompt);
  assert.equal(f.calls[0].isAutoTurn, true);
  assert.notEqual(f.calls[0].autonomy, true);
  assert.ok(f.typingSignals.length > 0);
  assert.deepEqual(f.recipients, [groupChat, groupChat], 'The status and new final response target the saved chat.');
  assert.deepEqual(await listTasks(), []);
  assert.ok(f.messages.some(text => /Напоминание готово.*⏱.*50%/s.test(text)));

  await f.callback('auto:timer-toggle:one');
  assert.equal((await f.records())[0].lastRunAt, stamp);
  f.setTime(tick + 60_000);
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, 1, 're-enabling a consumed once must not rerun it');
});

test('legacy due entry is stamped while queued and /stop cancels it without repeating', async t => {
  const f = await dispatchFixture(t, { chatId: 42, run: async ({ signal }) => {
    await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    return { ok: false, error: 'aborted' };
  } });
  await f.message('Ручная задача');
  await until(() => f.calls.length === 1, 'manual turn did not start');
  await f.scheduler.tickNow();
  assert.equal((await f.records())[0].lastRunAt, stamp);
  assert.equal(f.calls.length, 1, 'timer must wait behind the manual turn');
  assert.ok(f.messages.includes('⏳ в очереди'));
  await f.message('/stop');
  assert.equal(f.calls[0].signal.aborted, true);
  f.setTime(tick + 60_000);
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, 1);
});

test('legacy recurring: daily and Sunday weekly use the owner clock and stay enabled', async t => {
  const daily = { ...timer, id: 'daily', name: 'Каждый день', type: 'daily', hour: 9 };
  const weekly = { ...timer, id: 'weekly', name: 'Каждое воскресенье', type: 'weekly', hour: 9, weekdays: [7] };
  const wrongDay = { ...weekly, id: 'wrong-day', weekdays: [1] };
  const f = await dispatchFixture(t, { timers: [daily, weekly, wrongDay] });
  f.setTime(tick - 60_000);
  await f.scheduler.tickNow();
  assert.deepEqual(await f.records(), [daily, weekly, wrongDay]);

  f.setTime(tick);
  await f.scheduler.tickNow();
  await until(() => f.calls.map(call => call.prompt).join('\n').includes('Каждое воскресенье'), 'weekly timer did not dispatch');
  assert.deepEqual(await f.records(), [{ ...daily, lastRunAt: stamp }, { ...weekly, lastRunAt: stamp }, wrongDay]);
  const prompt = f.calls.map(call => call.prompt).join('\n');
  assert.match(prompt, /⏰ Таймер "Каждый день":/);
  assert.match(prompt, /⏰ Таймер "Каждое воскресенье":/);

  await f.scheduler.tickNow();
  assert.deepEqual(await f.records(), [{ ...daily, lastRunAt: stamp }, { ...weekly, lastRunAt: stamp }, wrongDay]);
  f.setTime(tick + 86_400_000 + 60_000);
  await f.scheduler.tickNow();
  assert.deepEqual(await f.records(), [{ ...daily, lastRunAt: stamp }, { ...weekly, lastRunAt: stamp }, wrongDay]);
});

test('legacy timer dispatch honors the old per-bot sleep marker', async t => {
  const f = await dispatchFixture(t);
  const directory = path.join(msbRoot(), 'engine');
  await fs.mkdir(directory);
  const marker = path.join(directory, 'sleep.default');
  await fs.writeFile(marker, '');
  await f.scheduler.tickNow();
  assert.deepEqual(await f.records(), [timer]);
  assert.equal(f.calls.length, 0);

  await fs.unlink(marker);
  await f.scheduler.tickNow();
  await until(() => f.calls.length === 1, 'the awake timer did not run');
  assert.deepEqual(await f.records(), [{ ...timer, enabled: false, lastRunAt: stamp }]);
});

for (const restart of [false, true]) {
  test(`sleep defers the reserved once, daily and weekly timers${restart ? ' across restart' : ''}`, async t => {
    const daily = { ...timer, id: 'daily', name: 'Каждый день', type: 'daily', hour: 9 };
    const weekly = { ...timer, id: 'weekly', name: 'Каждое воскресенье', type: 'weekly', hour: 9, weekdays: [7] };
    const first = gate();
    t.after(first.resolve);
    const f = await dispatchFixture(t, { timers: [timer, daily, weekly], chatId: 42, run: async ({ prompt }) => {
      if (prompt === 'Занять очередь') await first.promise;
      return normalResult;
    } });
    const turns = f.bot[Symbol.for('msb.scheduledTurns')];
    await f.message('Занять очередь');
    await until(() => f.calls.length === 1, 'manual turn did not start');
    await f.scheduler.tickNow();
    await f.scheduler.tickNow();
    await f.message('Не повторять старое сообщение');
    const marker = path.join(msbRoot(), 'engine', 'sleep.default');
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, 'sleep');
    first.resolve();
    await until(() => !turns.pending, 'sleep did not settle the queue');
    assert.equal(f.calls.length, 1);

    const fresh = restart ? await f.restart() : null;
    const scheduler = fresh?.scheduler ?? f.scheduler;
    try {
      f.setTime(tick + 10 * 60_000);
      await scheduler.tickNow();
      assert.equal(f.calls.length, 1);
      await fs.unlink(marker);
      await scheduler.tickNow();
      await until(() => f.calls.slice(1).map(call => call.prompt).join('\n').includes(weekly.name), 'reserved timer was lost during sleep');
      const prompts = f.calls.slice(1).map(call => call.prompt).join('\n');
      for (const row of [timer, daily, weekly]) assert.equal(prompts.split(row.name).length, 2);
      assert.ok(!prompts.includes('Не повторять старое сообщение'));
      assert.ok(f.calls.slice(1).every(call => call.isAutoTurn));
      const count = f.calls.length;
      await scheduler.tickNow();
      assert.equal(f.calls.length, count);
    } finally { await fresh?.close(); }
  });
}

test('sleep after the first worker check defers the timer, then /stop consumes it without replay', async t => {
  const f = await dispatchFixture(t, { chatId: 42 });
  const controller = f.bot[Symbol.for('msb.engineSleep')];
  const queued = controller.queued;
  const marker = path.join(msbRoot(), 'engine', 'sleep.default');
  await fs.mkdir(path.dirname(marker), { recursive: true });
  let paused = false;
  controller.queued = async entry => {
    const result = await queued(entry);
    if (!paused) { paused = true; await fs.writeFile(marker, 'sleep'); }
    return result;
  };
  await f.scheduler.tickNow();
  await until(() => !f.bot[Symbol.for('msb.scheduledTurns')].pending, 'timer worker did not defer');
  assert.equal(paused, true);
  assert.equal(f.calls.length, 0);
  assert.ok((await f.records())[0].legacyPendingRun);
  await f.message('/stop');
  assert.deepEqual(await f.records(), [{ ...timer, enabled: false, lastRunAt: stamp }]);
  await fs.unlink(marker);
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, 0);
});

test('the timer waits for a provider transition and honors sleep on the newly selected Codex', async t => {
  const busy = gate(), selected = gate(), release = gate();
  t.after(busy.resolve);
  t.after(release.resolve);
  const f = await dispatchFixture(t, { chatId: 42, run: async ({ prompt }) => {
    if (prompt === 'Занять очередь') await busy.promise;
    return normalResult;
  } });
  await f.message('Занять очередь');
  await until(() => f.calls.length === 1, 'manual turn did not start');
  await f.scheduler.tickNow();

  const { extAuthBypass, ...state } = (await loadState()).state;
  await saveState({ ...state, authMode: 'subscription', hasSubscriptionAuth: true });
  const marker = path.join(msbRoot(), 'engine', 'sleep.default');
  await fs.mkdir(path.dirname(marker), { recursive: true });
  const controller = f.bot[Symbol.for('msb.engineSleep')];
  const queued = controller.queued;
  controller.queued = async entry => {
    const asleep = await queued(entry);
    if (entry.legacyParts) await fs.writeFile(marker, 'sleep');
    return asleep;
  };
  const selecting = updateState(async current => {
    selected.resolve();
    await release.promise;
    return { ...current, extAuthBypass };
  });
  await selected.promise;
  const stateQueue = globalThis[Symbol.for('msb.stateUpdates')];
  const turns = f.bot[Symbol.for('msb.scheduledTurns')];
  busy.resolve();
  try {
    await until(() => stateQueue.get(statePath()) !== selecting || f.calls.length > 1, 'timer did not reach admission');
    assert.notEqual(stateQueue.get(statePath()), selecting, 'timer ran before the current selection committed');
    assert.equal(f.calls.length, 1);
  } finally {
    release.resolve();
    await selecting;
  }
  await until(() => !turns.pending, 'sleep did not defer the prepared timer');
  assert.equal(f.calls.length, 1);
  assert.ok((await f.records())[0].legacyPendingRun);
});

test('a failed /stop write reports it and holds the prepared timer until a successful retry', async t => {
  const busy = gate();
  t.after(busy.resolve);
  const f = await dispatchFixture(t, { chatId: 42, run: async ({ prompt }) => {
    if (prompt === 'Занять очередь') await busy.promise;
    return normalResult;
  } });
  await f.message('Занять очередь');
  await until(() => f.calls.length === 1, 'manual turn did not start');
  await f.scheduler.tickNow();
  const file = await fs.realpath(f.file);
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === file) throw Object.assign(new Error('fixture storage failure'), { code: 'EIO' });
    return rename(from, to);
  };
  try { await f.message('/stop'); }
  finally { fs.rename = rename; }
  assert.ok(f.messages.some(text => text.includes('Не удалось сохранить остановку таймеров')));
  assert.ok((await f.records())[0].legacyPendingRun);
  busy.resolve();
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, 1);
  assert.equal(f.bot[Symbol.for('msb.scheduledTurns')].pending, false);
  await f.message('/stop');
  assert.deepEqual(await f.records(), [{ ...timer, enabled: false, lastRunAt: stamp }]);
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, 1);
});

test('a started timer is never replayed by a fresh bot over the same profile', async t => {
  const f = await dispatchFixture(t);
  await f.scheduler.tickNow();
  await until(() => f.calls.length === 1, 'the first runner was not reached');
  assert.deepEqual(await f.records(), [{ ...timer, enabled: false, lastRunAt: stamp }]);
  const fresh = await f.restart();
  try {
    await fresh.scheduler.tickNow();
    assert.equal(f.calls.length, 1);
  } finally { await fresh.close(); }
});

test('two workers cannot claim one durable timer occurrence', async t => {
  const busy = gate();
  t.after(busy.resolve);
  const f = await dispatchFixture(t, { chatId: 42, run: async ({ prompt }) => {
    if (prompt === 'Занять очередь') await busy.promise;
    return normalResult;
  } });
  await f.message('Занять очередь');
  await until(() => f.calls.length === 1, 'manual turn did not start');
  await f.scheduler.tickNow();
  const [prepared] = await f.records();
  const run = { file: await fs.realpath(f.file), timer: prepared };
  const claimed = await Promise.all([claimLegacyTimerRuns([run]), claimLegacyTimerRuns([run])]);
  assert.deepEqual(claimed.map(result => result.size).sort(), [0, 1]);
  busy.resolve();
  await until(() => !f.bot[Symbol.for('msb.scheduledTurns')].pending, 'already claimed timer did not settle');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await f.records(), [{ ...timer, enabled: false, lastRunAt: stamp }]);
});

test('an ordinary Claude reservation keeps its previous attempt semantics', async t => {
  const busy = gate();
  t.after(busy.resolve);
  const f = await dispatchFixture(t, { chatId: 42, run: async ({ prompt, signal }) => {
    if (prompt === 'Занять очередь') await Promise.race([busy.promise, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
    return normalResult;
  } });
  const { extAuthBypass, ...state } = (await loadState()).state;
  await saveState({ ...state, authMode: 'subscription', hasSubscriptionAuth: true });
  await f.message('Занять очередь');
  await until(() => f.calls.length === 1, 'manual turn did not start');
  await f.scheduler.tickNow();
  assert.deepEqual(await f.records(), [{ ...timer, enabled: false, lastRunAt: stamp }]);
  await f.message('/stop');
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, 1);
});

test('a due Codex interval stays due while asleep and runs once after wake', async t => {
  const f = await dispatchFixture(t, { timers: [] });
  const due = tick - 1000;
  await addTask({ id: 'sleep-interval', title: 'interval', prompt: 'interval', nextAt: due });
  const directory = path.join(msbRoot(), 'engine');
  await fs.mkdir(directory, { recursive: true });
  const marker = path.join(directory, 'sleep.default');
  await fs.writeFile(marker, 'fixture');
  await f.scheduler.tickNow();
  assert.equal(f.intervalRuns.length, 0, 'A sleeping Codex must not launch an interval turn.');
  assert.equal((await listTasks())[0].nextAt, due, 'A deferred interval must remain due.');
  await fs.unlink(marker);
  await f.scheduler.tickNow();
  assert.equal(f.intervalRuns.length, 1);
  assert.ok((await listTasks())[0].nextAt > tick);
  await f.scheduler.tickNow();
  assert.equal(f.intervalRuns.length, 1);
});

test('a Codex-only interval guard does not suspend the selected Claude provider', async t => {
  const f = await dispatchFixture(t, { timers: [] });
  const { state } = await loadState();
  const { extAuthBypass, ...claude } = state;
  await saveState(claude);
  await addTask({ id: 'claude-interval', title: 'interval', prompt: 'interval', nextAt: tick - 1000 });
  const directory = path.join(msbRoot(), 'engine');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'sleep.default'), 'fixture');
  await f.scheduler.tickNow();
  assert.equal(f.intervalRuns.length, 1);
});

test('a timer queued under Claude survives a switch to sleeping Codex', async t => {
  const first = gate();
  t.after(first.resolve);
  const f = await dispatchFixture(t, { chatId: 42, run: async ({ prompt }) => {
    if (prompt === 'Занять очередь') await first.promise;
    return normalResult;
  } });
  const original = (await loadState()).state;
  const { extAuthBypass, ...state } = original;
  const claude = { ...state, authMode: 'subscription', hasSubscriptionAuth: true };
  await saveState(claude);
  await f.message('Занять очередь');
  await until(() => f.calls.length === 1, 'manual turn did not start');
  await f.scheduler.tickNow();
  assert.equal((await f.records())[0].lastRunAt, stamp);
  await saveState({ ...claude, extAuthBypass: 'codex' });
  const marker = path.join(msbRoot(), 'engine', 'sleep.default');
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, 'sleep');
  first.resolve();
  await until(() => !f.bot[Symbol.for('msb.scheduledTurns')].pending, 'sleep did not settle');
  await fs.unlink(marker);
  await f.scheduler.tickNow();
  await until(() => f.calls.some(call => call.prompt === timerPrompt), 'timer was lost after the provider change');
});

for (const unreadable of [false, true]) {
  test(`a timer blocked by Codex sleep survives returning to Claude before deferral${unreadable ? ' with a failed marker read' : ''}`, async t => {
    const first = gate();
    t.after(first.resolve);
    const f = await dispatchFixture(t, { chatId: 42, run: async ({ prompt }) => {
      if (prompt === 'Занять очередь') await first.promise;
      return normalResult;
    } });
    const { extAuthBypass, ...state } = (await loadState()).state;
    const claude = { ...state, authMode: 'subscription', hasSubscriptionAuth: true };
    await saveState(claude);
    await f.message('Занять очередь');
    await until(() => f.calls.length === 1, 'manual turn did not start');
    await f.scheduler.tickNow();
    assert.deepEqual(await f.records(), [{ ...timer, enabled: false, lastRunAt: stamp }]);

    await saveState({ ...claude, extAuthBypass });
    const marker = path.join(msbRoot(), 'engine', 'sleep.default');
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, 'sleep');
    const controller = f.bot[Symbol.for('msb.engineSleep')];
    const queued = controller.queued;
    let returned = false;
    controller.queued = async (entry, ...options) => {
      const blocked = await queued(entry, ...options);
      if (blocked && !returned) {
        returned = true;
        await saveState(claude);
        await fs.unlink(marker);
      }
      return blocked;
    };
    const lstat = fs.lstat;
    if (unreadable) fs.lstat = async (file, ...options) => {
      if (String(file) === marker) throw Object.assign(new Error('fixture unreadable marker'), { code: 'EACCES' });
      return lstat(file, ...options);
    };
    try {
      first.resolve();
      await until(() => !f.bot[Symbol.for('msb.scheduledTurns')].pending, 'blocked timer did not settle');
    } finally { fs.lstat = lstat; }
    assert.equal(returned, true);
    assert.equal(f.calls.length, 1, 'the dropped turn must not resume directly');
    assert.ok((await f.records())[0].legacyPendingRun, 'the Codex decision must defer the stamped timer even after Claude wakes');

    await f.scheduler.tickNow();
    await until(() => f.calls.some(call => call.prompt === timerPrompt), 'the preserved timer did not run');
    await f.scheduler.tickNow();
    assert.equal(f.calls.filter(call => call.prompt === timerPrompt).length, 1);
  });
}

for (const stop of [false, true]) {
  test(`late Codex sleep preserves only the Claude timer parts${stop ? ' until /stop' : ' across restart'}`, async t => {
    const first = gate();
    t.after(first.resolve);
    const daily = { ...timer, id: 'daily', name: 'Каждый день', type: 'daily', hour: 9 };
    const f = await dispatchFixture(t, { timers: [timer, daily], chatId: 42, run: async ({ prompt }) => {
      if (prompt === 'Занять очередь') await first.promise;
      return normalResult;
    } });
    const { extAuthBypass, ...state } = (await loadState()).state;
    const claude = { ...state, authMode: 'subscription', hasSubscriptionAuth: true };
    await saveState(claude);
    await f.message('Занять очередь');
    await until(() => f.calls.length === 1, 'manual turn did not start');
    await f.scheduler.tickNow();
    const stamped = [{ ...timer, enabled: false, lastRunAt: stamp }, { ...daily, lastRunAt: stamp }];
    assert.deepEqual(await f.records(), stamped, 'Claude reserves with the original stored fields');
    await f.message('Не повторять ручной текст');
    await saveState({ ...claude, extAuthBypass });

    const marker = path.join(msbRoot(), 'engine', 'sleep.default');
    await fs.mkdir(path.dirname(marker), { recursive: true });
    const controller = f.bot[Symbol.for('msb.engineSleep')];
    const queued = controller.queued;
    let paused = false;
    controller.queued = async entry => {
      const blocked = await queued(entry);
      if (!paused && entry.legacyParts) {
        assert.equal(blocked, false, 'the mark must arrive after the first check');
        paused = true;
        await fs.writeFile(marker, 'sleep');
      }
      return blocked;
    };
    first.resolve();
    await until(() => !f.bot[Symbol.for('msb.scheduledTurns')].pending, 'sleep did not settle the queue');
    assert.equal(paused, true);
    assert.equal(f.calls.length, 1);
    const prepared = await f.records();
    assert.ok(prepared.every(row => row.legacyPendingRun?.id));
    assert.ok(prepared.every(row => row.lastRunAt === stamp));
    if (stop) {
      await f.message('/stop');
      assert.deepEqual(await f.records(), stamped);
    }

    const fresh = await f.restart();
    try {
      f.setTime(tick + 10 * 60_000);
      await fs.unlink(marker);
      await fresh.scheduler.tickNow();
      if (stop) assert.equal(f.calls.length, 1);
      else {
        await until(() => f.calls.slice(1).some(call => call.prompt.includes(daily.name)), 'the deferred daily timer did not run');
        const prompts = f.calls.slice(1).map(call => call.prompt).join('\n');
        assert.ok(prompts.includes(timerPrompt));
        assert.ok(!prompts.includes('Не повторять ручной текст'));
        assert.ok(f.calls.slice(1).every(call => call.isAutoTurn));
        assert.deepEqual(await f.records(), stamped);
        const calls = f.calls.length;
        await fresh.scheduler.tickNow();
        assert.equal(f.calls.length, calls);
      }
    } finally { await fresh.close(); }
  });
}

test('legacy timers do not overlap the existing interval runner in the same profile', async t => {
  const f = await dispatchFixture(t, { run: async ({ signal }) => {
    await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    return { ok: false, error: 'aborted' };
  } });
  await addTask({ id: 'interval', title: 'interval', prompt: 'interval', nextAt: tick - 1000 });
  await f.scheduler.tickNow();
  assert.equal((await f.records())[0].lastRunAt, stamp);
  await until(() => f.calls.length === 1, 'timer turn did not start');
  assert.equal(f.intervalRuns.length, 0);
  assert.equal((await listTasks())[0].nextAt, tick - 1000);
  await f.bot.stop();
  await f.scheduler.tickNow();
  assert.equal(f.intervalRuns.length, 1);
});

test('legacy dispatch requires both a saved destination and the configured owner', async t => {
  const f = await dispatchFixture(t, { owner: 999 });
  await f.scheduler.tickNow();
  assert.deepEqual(await f.records(), [timer]);
  assert.equal(f.calls.length, 0);
  const { state } = await loadState();
  await saveState({ ...state, userId: 42, chatId: undefined });
  await f.scheduler.tickNow();
  assert.deepEqual(await f.records(), [timer]);
  assert.deepEqual(f.recipients, []);
});

test('legacy once keeps future, disabled, missing-date and already-run records untouched', async t => {
  const timers = [
    { ...timer, id: 'future', at: '2026-10-25T03:31:00.000Z' },
    { ...timer, id: 'disabled', enabled: false },
    { ...timer, id: 'missing', at: undefined },
    { ...timer, id: 'done', lastRunAt: '2026-10-25T03:20:00.000Z' },
  ];
  const f = await dispatchFixture(t, { timers });
  const before = await f.records();
  await f.scheduler.tickNow();
  assert.deepEqual(await f.records(), before);
  assert.deepEqual(f.recipients, []);
});

test('legacy auto-only turn consumes the once if Telegram cannot send its initial status', async t => {
  const f = await dispatchFixture(t);
  const attempts = [];
  f.bot.api.sendMessage = async (chat, text) => {
    attempts.push({ chat, text });
    throw new Error('fixture Telegram unavailable');
  };
  await f.scheduler.tickNow();
  await until(() => !f.bot[Symbol.for('msb.scheduledTurns')].pending, 'failed timer status did not settle');
  assert.deepEqual(await f.records(), [{ ...timer, enabled: false, lastRunAt: stamp }]);
  assert.deepEqual(attempts, [{ chat: groupChat, text: 'Думаю ⏳' }]);
  assert.equal(f.calls.length, 0);
});

test('failed timer file publication drops the reservation before the model, and permits the next tick', async t => {
  const f = await dispatchFixture(t);
  const file = await fs.realpath(f.file);
  const rename = fs.rename;
  let attempts = 0;
  fs.rename = async (from, to) => {
    if (to === file) {
      attempts++;
      throw Object.assign(new Error('fixture storage failure'), { code: 'EIO' });
    }
    return rename(from, to);
  };
  try {
    await f.scheduler.tickNow();
  } finally {
    fs.rename = rename;
  }
  assert.equal(attempts, 1);
  assert.deepEqual(await f.records(), [timer]);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.recipients, []);
  assert.equal(f.bot[Symbol.for('msb.scheduledTurns')].pending, false);

  await f.scheduler.tickNow();
  await until(() => f.calls.length === 1, 'retry did not run after a successful commit');
  assert.deepEqual(await f.records(), [{ ...timer, enabled: false, lastRunAt: stamp }]);
});

test('timer dispatch rechecks the record after a concurrent delete and preserves the other row', async t => {
  const future = { ...timer, id: 'future', at: '2026-10-25T03:31:00.000Z' };
  const f = await dispatchFixture(t, { timers: [timer, future] });
  const file = await fs.realpath(f.file);
  const locked = gate(), release = gate();
  const change = withFileLock(file, async () => {
    locked.resolve();
    await release.promise;
    await fs.writeFile(file, JSON.stringify([future]));
  });
  await locked.promise;
  const read = fs.readFile;
  let scanned = false;
  fs.readFile = async (target, ...options) => {
    const value = await read(target, ...options);
    if (target === file) scanned = true;
    return value;
  };
  let dispatch;
  try {
    dispatch = f.scheduler.tickNow();
    await until(() => scanned, 'scheduler did not read the initial timer snapshot');
  } finally {
    fs.readFile = read;
    release.resolve();
    await Promise.all([change, dispatch]);
  }
  assert.deepEqual(await f.records(), [future]);
  assert.deepEqual(f.recipients, []);
});

test('timer text merges with already queued owner text and uses ordinary model policy', async t => {
  const first = gate();
  const f = await dispatchFixture(t, { chatId: 42, run: async ({ prompt, signal }) => {
    if (prompt === 'Открыть очередь') {
      await Promise.race([first.promise, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
    }
    return normalResult;
  } });
  await f.message('Открыть очередь');
  await until(() => f.calls.length === 1, 'manual turn did not start');
  await f.scheduler.tickNow();
  await f.message('Следующий текст владельца');
  first.resolve();
  await until(() => f.calls.length === 2, 'queued messages did not run');

  assert.ok(f.calls[1].prompt.includes(timerPrompt));
  assert.match(f.calls[1].prompt, /Следующий текст владельца/);
  assert.notEqual(f.calls[1].isAutoTurn, true);
  assert.equal((await f.records())[0].lastRunAt, stamp);
});

for (const mixed of [false, true]) {
  test('a failed queued timer status leaves the ' + (mixed ? 'owner text' : 'next timer') + ' in the FIFO', async t => {
    const tail = { ...timer, id: 'tail', name: 'Следующий таймер', prompt: 'Отдельная работа' };
    const ownerText = 'Отдельный текст владельца';
    const busy = gate();
    t.after(busy.resolve);
    const f = await dispatchFixture(t, { timers: mixed ? [timer] : [timer, tail], chatId: 42,
      run: async ({ prompt }) => {
        if (prompt === 'Занять очередь') await busy.promise;
        return normalResult;
      },
    });
    await f.message('Занять очередь');
    await until(() => f.calls.length === 1, 'manual turn did not start');
    const send = f.bot.api.sendMessage;
    let queueStatuses = 0;
    f.bot.api.sendMessage = async (chat, text, options, signal) => {
      if ((text === '⏳ в очереди' && ++queueStatuses === 1) || (text === 'Думаю ⏳' && signal)) {
        throw Error('synthetic status failure for the first timer');
      }
      return send(chat, text, options, signal);
    };
    await f.scheduler.tickNow();
    if (mixed) await f.message(ownerText);
    await until(() => queueStatuses === 2, 'both queue statuses must be attempted');
    busy.resolve();
    await until(() => !f.bot[Symbol.for('msb.scheduledTurns')].pending, 'queued timer did not settle');
    await f.scheduler.tickNow();

    assert.ok((await f.records()).every(row => !row.enabled && row.lastRunAt === stamp && !row.legacyPendingRun));
    await until(() => f.calls.length >= 2, 'the healthy tail did not reach the runner');
    assert.deepEqual(f.calls.map(call => call.prompt), [
      'Занять очередь', mixed ? ownerText : '⏰ Таймер "Следующий таймер":\nОтдельная работа',
    ]);
  });
}

test('an uneditable queue status does not discard both admitted timers', async t => {
  const tail = { ...timer, id: 'tail', name: 'Следующий таймер', prompt: 'Отдельная работа' };
  const busy = gate();
  t.after(busy.resolve);
  const f = await dispatchFixture(t, { timers: [timer, tail], chatId: 42, run: async ({ prompt }) => {
    if (prompt === 'Занять очередь') await busy.promise;
    return normalResult;
  } });
  await f.message('Занять очередь');
  await until(() => f.calls.length === 1, 'manual turn did not start');
  const send = f.bot.api.sendMessage, edit = f.bot.api.editMessageText;
  let headStatus, failedEdits = 0;
  f.bot.api.sendMessage = async (chat, text, ...options) => {
    const message = await send(chat, text, ...options);
    if (text === '⏳ в очереди') headStatus ??= message.message_id;
    return message;
  };
  f.bot.api.editMessageText = async (chat, id, text, ...options) => {
    if (id === headStatus && text === 'Думаю ⏳') {
      failedEdits++;
      throw Error('synthetic queue promotion failure');
    }
    return edit(chat, id, text, ...options);
  };
  await f.scheduler.tickNow();
  await until(() => headStatus, 'head must have an existing queue status');
  busy.resolve();
  await until(() => !f.bot[Symbol.for('msb.scheduledTurns')].pending, 'queued timers did not settle');
  await f.scheduler.tickNow();

  assert.equal(failedEdits, 1);
  assert.ok((await f.records()).every(row => !row.enabled && row.lastRunAt === stamp && !row.legacyPendingRun));
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].prompt, /Проверить почту[\s\S]*Отдельная работа/);
});

test('an unpresented timer at the FIFO head cannot consume later owner text', async t => {
  const f = await dispatchFixture(t, { chatId: 42 });
  const publishing = gate(), release = gate();
  const rename = fs.rename, send = f.bot.api.sendMessage;
  const ownerText = 'Текст после занятого таймером места';
  let failedSends = 0;
  fs.rename = async (from, to) => {
    if (to === f.file) {
      publishing.resolve();
      await release.promise;
    }
    return rename(from, to);
  };
  f.bot.api.sendMessage = async (chat, text, options, signal) => {
    if (text === 'Думаю ⏳' && signal) {
      failedSends++;
      throw Error('synthetic failure before the timer has a status');
    }
    return send(chat, text, options, signal);
  };
  const tickRun = f.scheduler.tickNow();
  try {
    await Promise.race([publishing.promise, tickRun.then(() => assert.fail('timer did not reserve its place'))]);
    await f.message(ownerText);
    await until(() => f.messages.includes('⏳ в очереди'), 'owner text did not queue behind the timer');
  } finally {
    fs.rename = rename;
    release.resolve();
    await tickRun;
  }

  await until(() => !f.bot[Symbol.for('msb.scheduledTurns')].pending, 'timer did not settle');
  assert.equal(failedSends, 1);
  assert.deepEqual(await f.records(), [{ ...timer, enabled: false, lastRunAt: stamp }]);
  await until(() => f.calls.length > 0, 'the owner text did not reach the runner');
  assert.deepEqual(f.calls.map(call => call.prompt), [ownerText]);
});

test('a changed reservation is dropped without losing the user text or other timers', async t => {
  const second = { ...timer, id: 'two', name: 'Другой таймер' };
  const first = gate();
  t.after(first.resolve);
  const f = await dispatchFixture(t, { timers: [timer, second], chatId: 42, run: async ({ prompt }) => {
    if (prompt === 'Занять очередь') await first.promise;
    return normalResult;
  } });
  await f.message('Занять очередь');
  await until(() => f.calls.length === 1, 'manual turn did not start');
  await f.scheduler.tickNow();
  await f.message('Ручное продолжение');
  await f.callback('auto:timer-toggle:one');
  first.resolve();
  await until(() => f.calls.length === 2, 'remaining merged work did not run');
  const [firstRow, secondRow] = await f.records();
  assert.equal(firstRow.enabled, true);
  assert.equal(firstRow.legacyPendingRun, undefined);
  assert.equal(secondRow.legacyPendingRun, undefined);
  assert.match(f.calls[1].prompt, /Ручное продолжение/);
  assert.match(f.calls[1].prompt, /Другой таймер/);
  assert.ok(!f.calls[1].prompt.includes(timerPrompt));
  assert.notEqual(f.calls[1].isAutoTurn, true);
});

test('the admitted timer stays bound to its original physical schedule source', async t => {
  const busy = gate();
  t.after(busy.resolve);
  const f = await dispatchFixture(t, { chatId: 42, run: async ({ prompt }) => {
    if (prompt === 'Занять очередь') await busy.promise;
    return normalResult;
  } });
  await f.message('Занять очередь');
  await until(() => f.calls.length === 1, 'manual turn did not start');
  await f.scheduler.tickNow();
  const original = await fs.readFile(f.file);
  const other = path.join(f.home, 'other');
  await fs.mkdir(other);
  const copied = path.join(other, 'schedules.json');
  await fs.writeFile(copied, original);
  process.env.MSB_SESSION_DIR = path.join(other, 'sessions');
  busy.resolve();
  await until(() => !f.bot[Symbol.for('msb.scheduledTurns')].pending, 'stale timer did not settle');
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await fs.readFile(f.file), original);
  assert.deepEqual(await fs.readFile(copied), original);
});

test('legacy recurring local-day stamp suppresses a repeat across the UTC date boundary', async t => {
  const daily = { ...timer, id: 'daily', type: 'daily', hour: 1 };
  const f = await dispatchFixture(t, { timers: [daily] });
  const instant = '2026-10-24T19:30:00.000Z'; // Sunday 01:00 at the saved owner.
  f.setTime(Date.parse(instant));
  await f.scheduler.tickNow();
  await until(() => f.calls.length === 1, 'owner-local early-morning timer did not start');
  await f.scheduler.tickNow();

  assert.deepEqual(await f.records(), [{ ...daily, lastRunAt: instant }]);
  assert.equal(f.calls.length, 1);
});

test('shutdown drains the stamp and leaves a prepared timer for restart', async t => {
  const f = await dispatchFixture(t);
  const file = await fs.realpath(f.file);
  const rename = fs.rename;
  const release = gate();
  let writing = false;
  fs.rename = async (from, to) => {
    if (to === file) {
      writing = true;
      await release.promise;
    }
    return rename(from, to);
  };
  const dispatch = f.scheduler.tickNow();
  let drain;
  try {
    await until(() => writing, 'scheduled write did not reach publication');
    drain = f.scheduler.stop();
    assert.equal(typeof drain?.then, 'function');
    await f.bot.stop();
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.recipients, []);
  } finally {
    fs.rename = rename;
    release.resolve();
    await Promise.all([dispatch, drain]);
  }
  const [prepared] = await f.records();
  assert.ok(prepared.legacyPendingRun?.id);
  assert.equal(prepared.lastRunAt, stamp);
  assert.equal(f.calls.length, 0);
});

test('/stop closes the current admission pass while retaining a later due record for the next tick', async t => {
  const second = { ...timer, id: 'two', name: 'Второй' };
  const f = await dispatchFixture(t, { timers: [timer, second] });
  const file = await fs.realpath(f.file);
  const rename = fs.rename;
  const release = gate();
  let writing = false;
  fs.rename = async (from, to) => {
    if (to === file) {
      writing = true;
      await release.promise;
    }
    return rename(from, to);
  };
  const dispatch = f.scheduler.tickNow();
  let stop;
  try {
    await until(() => writing, 'first scheduled write did not reach publication');
    const turns = f.bot[Symbol.for('msb.scheduledTurns')];
    const epoch = turns.stopEpoch;
    stop = f.message('/stop');
    await until(() => turns.stopEpoch !== epoch, 'stop did not fence the admission pass');
  } finally {
    fs.rename = rename;
    release.resolve();
    await Promise.all([dispatch, stop]);
  }
  assert.ok(f.messages.includes('Моя остановочка ✋🏽⛔️'));
  assert.deepEqual(await f.records(), [{ ...timer, enabled: false, lastRunAt: stamp }, second]);
  assert.equal(f.calls.length, 0);

  f.setTime(tick + 60_000);
  await f.scheduler.tickNow();
  await until(() => f.calls.length === 1, 'second timer did not survive to the next tick');
  assert.match(f.calls[0].prompt, /⏰ Таймер "Второй":/);
});

test('/stop aborts the initial status request for a scheduled timer', async t => {
  const f = await dispatchFixture(t);
  const release = gate();
  const send = f.bot.api.sendMessage;
  let request;
  f.bot.api.sendMessage = async (chat, text, options, signal) => {
    if (text === 'Думаю ⏳') {
      request = { signal };
      const aborted = new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true }));
      await Promise.race([release.promise, aborted]);
      signal?.throwIfAborted();
    }
    return send(chat, text, options, signal);
  };
  try {
    await f.scheduler.tickNow();
    await until(() => request, 'timer did not send its initial status');
    await f.message('/stop');
    assert.ok(request.signal?.aborted, 'stop must abort the timer presentation request');
    await until(() => !f.bot[Symbol.for('msb.scheduledTurns')].pending, 'aborted status did not settle');
  } finally {
    release.resolve();
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.records(), [{ ...timer, enabled: false, lastRunAt: stamp }]);
});


for (const provider of ['codex', 'claude']) {
  test('legacy due while spend paused survives restart and runs once on ' + provider, async t => {
    const f = await dispatchFixture(t, { chatId: 42 });
    const state = { ...(await loadState()).state, costPaused: true };
    if (provider === 'claude') { delete state.extAuthBypass; state.authMode = 'subscription'; state.hasSubscriptionAuth = true; }
    await saveState(state);
    const session = state.ccSessionId;
    await f.scheduler.tickNow();
    await until(() => f.messages.some(text => text.includes('Дневной лимит достигнут')), 'paused notice did not finish');
    await f.scheduler.tickNow();
    assert.ok(f.typingSignals.length > 0, 'the ordinary typing indication is preserved');
    const [prepared] = await f.records();
    assert.ok(prepared.legacyPendingRun);
    assert.equal(prepared.enabled, false);
    assert.equal(prepared.lastRunAt, stamp);
    assert.equal(f.calls.length, 0);
    const fresh = await f.restart();
    try {
      f.setTime(tick + 10 * 60_000);
      await fresh.scheduler.tickNow();
      assert.equal(f.calls.length, 0);
      await saveState({ ...(await loadState()).state, costPaused: false });
      await fresh.scheduler.tickNow();
      await until(() => f.calls.length === 1, 'deferred timer was not dispatched');
      assert.equal(f.calls[0].prompt, timerPrompt);
      assert.equal((await loadState()).state.ccSessionId, session);
      await fresh.scheduler.tickNow();
      assert.equal(f.calls.length, 1);
      assert.equal((await f.records())[0].legacyPendingRun, undefined);
    } finally { await fresh.close(); }
  });
}

test('paused legacy daily and weekly timers coalesce missed slots and a current slot', async t => {
  const daily = { ...timer, id: 'daily-spend', name: 'Каждый день', type: 'daily', hour: 9 };
  const weekly = { ...timer, id: 'weekly-spend', name: 'Воскресенье', type: 'weekly', hour: 9, weekdays: [7] };
  const f = await dispatchFixture(t, { timers: [daily, weekly], chatId: 42 });
  await saveState({ ...(await loadState()).state, costPaused: true });
  await f.scheduler.tickNow();
  await until(() => !f.bot[Symbol.for('msb.scheduledTurns')].pending, 'paused notices did not settle');
  assert.ok((await f.records()).every(row => row.legacyPendingRun));
  f.setTime(tick + 7 * 86_400_000);
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, 0);
  await saveState({ ...(await loadState()).state, costPaused: false });
  await f.scheduler.tickNow();
  await until(() => {
    const text = f.calls.map(call => call.prompt).join('\n');
    return text.includes(daily.name) && text.includes(weekly.name);
  }, 'deferred recurring timers did not run');
  const prompts = f.calls.map(call => call.prompt).join('\n');
  assert.equal(prompts.split(daily.name).length - 1, 1);
  assert.equal(prompts.split(weekly.name).length - 1, 1);
  const count = f.calls.length;
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, count);
  assert.ok((await f.records()).every(row => row.lastRunAt === new Date(tick + 7 * 86_400_000).toISOString()));
});

test('/stop cancels an already deferred legacy once timer', async t => {
  const f = await dispatchFixture(t, { chatId: 42 });
  await saveState({ ...(await loadState()).state, costPaused: true });
  await f.scheduler.tickNow();
  await until(() => f.messages.some(text => text.includes('Дневной лимит достигнут')), 'paused notice did not finish');
  assert.ok((await f.records())[0].legacyPendingRun);
  await f.message('/stop');
  assert.equal((await f.records())[0].legacyPendingRun, undefined);
  await saveState({ ...(await loadState()).state, costPaused: false });
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, 0);
});

test('/stop during publication of a spend-paused legacy timer cancels its pending run', async t => {
  const f = await dispatchFixture(t, { chatId: 42 });
  await saveState({ ...(await loadState()).state, costPaused: true });
  const file = await fs.realpath(f.file);
  const rename = fs.rename.bind(fs), entered = gate(), release = gate();
  t.after(release.resolve);
  let held = false;
  t.mock.method(fs, 'rename', async (from, to, ...options) => {
    if (to === file && !held) { held = true; entered.resolve(); await release.promise; }
    return rename(from, to, ...options);
  });
  const tickRun = f.scheduler.tickNow();
  let stop;
  try {
    await Promise.race([entered.promise, tickRun.then(() => assert.fail('expected timer publication'))]);
    const turns = f.bot[Symbol.for('msb.scheduledTurns')];
    const epoch = turns.stopEpoch;
    stop = f.message('/stop');
    await until(() => turns.stopEpoch !== epoch, '/stop did not start');
  } finally { release.resolve(); }
  await Promise.all([tickRun, stop]);
  assert.equal((await f.records())[0].legacyPendingRun, undefined);
  await saveState({ ...(await loadState()).state, costPaused: false });
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, 0);
});

test('a spend-paused timer follows the same owner to the newly saved chat', async t => {
  const f = await dispatchFixture(t, { chatId: 42 });
  await saveState({ ...(await loadState()).state, costPaused: true });
  await f.scheduler.tickNow();
  await until(() => f.messages.some(text => text.includes('Дневной лимит достигнут')), 'paused notice did not finish');
  await saveState({ ...(await loadState()).state, costPaused: false, chatId: groupChat, userId: 42 });
  await f.scheduler.tickNow();
  await until(() => f.calls.length === 1, 'deferred timer did not follow its owner');
  assert.equal(f.calls[0].prompt, timerPrompt);
  assert.equal(f.recipients.at(-1), groupChat);
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, 1);
});

test('a different saved owner cannot receive a spend-paused timer', async t => {
  const f = await dispatchFixture(t, { chatId: 42 });
  await saveState({ ...(await loadState()).state, costPaused: true });
  await f.scheduler.tickNow();
  await until(() => f.messages.some(text => text.includes('Дневной лимит достигнут')), 'paused notice did not finish');
  await saveState({ ...(await loadState()).state, costPaused: false, chatId: groupChat, userId: 99 });
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, 0);
  assert.ok((await f.records())[0].legacyPendingRun);
  await saveState({ ...(await loadState()).state, chatId: 42, userId: 42 });
  await f.scheduler.tickNow();
  await until(() => f.calls.length === 1, 'timer was not preserved for the original owner');
});


for (const provider of ['codex', 'claude']) {
  test('spend pause after queueing preserves the ' + provider + ' timer and not the mixed owner text', async t => {
    const first = gate();
    t.after(first.resolve);
    const f = await dispatchFixture(t, { chatId: 42, run: async ({ prompt }) => {
      if (prompt === 'Занять очередь') await first.promise;
      return normalResult;
    } });
    const state = { ...(await loadState()).state };
    if (provider === 'claude') { delete state.extAuthBypass; state.authMode = 'subscription'; state.hasSubscriptionAuth = true; }
    await saveState(state);
    const session = state.ccSessionId;
    await f.message('Занять очередь');
    await until(() => f.calls.length === 1, 'manual turn did not start');
    await f.scheduler.tickNow();
    await f.message('Не повторять ручное сообщение');
    await saveState({ ...(await loadState()).state, costPaused: true });
    first.resolve();
    await until(() => f.messages.some(text => text.includes('Дневной лимит достигнут')), 'paused status did not finish');
    assert.equal(f.calls.length, 1);
    assert.equal((await f.records())[0].legacyPendingRun?.reason, 'cost_pause');
    const fresh = await f.restart();
    try {
      f.setTime(tick + 10 * 60_000);
      await saveState({ ...(await loadState()).state, costPaused: false });
      await fresh.scheduler.tickNow();
      await until(() => f.calls.length === 2, 'queued timer did not survive pause');
      assert.ok(f.calls[1].prompt.includes(timerPrompt));
      assert.ok(!f.calls[1].prompt.includes('Не повторять ручное сообщение'));
      assert.equal((await loadState()).state.ccSessionId, session);
      await fresh.scheduler.tickNow();
      assert.equal(f.calls.length, 2);
    } finally { await fresh.close(); }
  });
}


for (const provider of ['codex', 'claude']) {
  test('spend pause committed while ' + provider + ' timer waits for admission is retained', async t => {
    const busy = gate(), held = gate(), release = gate();
    t.after(busy.resolve); t.after(release.resolve);
    const f = await dispatchFixture(t, { chatId: 42, run: async ({ prompt }) => {
      if (prompt === 'Занять очередь') await busy.promise;
      return normalResult;
    } });
    const state = { ...(await loadState()).state };
    if (provider === 'claude') { delete state.extAuthBypass; state.authMode = 'subscription'; state.hasSubscriptionAuth = true; }
    await saveState(state);
    await f.message('Занять очередь');
    await until(() => f.calls.length === 1, 'manual turn did not start');
    await f.scheduler.tickNow();
    const writing = updateState(async current => { held.resolve(); await release.promise; return { ...current, costPaused: true }; });
    await held.promise;
    const stateQueue = globalThis[Symbol.for('msb.stateUpdates')];
    busy.resolve();
    try {
      await until(() => stateQueue.get(statePath()) !== writing || f.calls.length > 1, 'timer did not reach admission');
      assert.equal(f.calls.length, 1);
    } finally { release.resolve(); await writing; }
    await until(() => f.messages.some(text => text.includes('Дневной лимит достигнут')), 'paused response did not finish');
    assert.equal((await f.records())[0].legacyPendingRun?.reason, 'cost_pause');
    await saveState({ ...(await loadState()).state, costPaused: false });
    f.setTime(tick + 10 * 60_000);
    await f.scheduler.tickNow();
    await until(() => f.calls.length === 2, 'deferred timer did not run after resume');
    await f.scheduler.tickNow();
    assert.equal(f.calls.length, 2);
  });
}

test('mixed timers queued before and during spend pause both wait while owner text is not replayed', async t => {
  const first = gate();
  t.after(first.resolve);
  const later = { ...timer, id: 'later-spend', name: 'Календарь', at: new Date(tick + 60_000).toISOString() };
  const f = await dispatchFixture(t, { timers: [timer, later], chatId: 42, run: async ({ prompt }) => {
    if (prompt === 'Занять очередь') await first.promise;
    return normalResult;
  } });
  await f.message('Занять очередь');
  await until(() => f.calls.length === 1, 'manual turn did not start');
  await f.scheduler.tickNow();
  await saveState({ ...(await loadState()).state, costPaused: true });
  f.setTime(tick + 60_000);
  await f.scheduler.tickNow();
  await f.message('Не повторять ручной ввод');
  first.resolve();
  await until(() => f.messages.some(text => text.includes('Дневной лимит достигнут')), 'paused response did not finish');
  assert.ok((await f.records()).every(row => row.legacyPendingRun?.reason === 'cost_pause'));
  await saveState({ ...(await loadState()).state, costPaused: false });
  f.setTime(tick + 10 * 60_000);
  await f.scheduler.tickNow();
  await until(() => f.calls.slice(1).map(call => call.prompt).join('\\n').includes(later.name), 'both timers did not resume');
  const prompts = f.calls.slice(1).map(call => call.prompt).join('\\n');
  assert.equal(prompts.split(timer.name).length - 1, 1);
  assert.equal(prompts.split(later.name).length - 1, 1);
  assert.ok(!prompts.includes('Не повторять ручной ввод'));
  const count = f.calls.length;
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, count);
});

test('a queued daily timer paused by spend coalesces with the next current slot', async t => {
  const busy = gate();
  t.after(busy.resolve);
  const daily = { ...timer, id: 'daily-queued-spend', name: 'Ежедневно', type: 'daily', hour: 9 };
  const f = await dispatchFixture(t, { timers: [daily], chatId: 42, run: async ({ prompt }) => {
    if (prompt === 'Занять очередь') await busy.promise;
    return normalResult;
  } });
  await f.message('Занять очередь');
  await until(() => f.calls.length === 1, 'manual turn did not start');
  await f.scheduler.tickNow();
  await saveState({ ...(await loadState()).state, costPaused: true });
  busy.resolve();
  await until(() => f.messages.some(text => text.includes('Дневной лимит достигнут')), 'paused response did not finish');
  assert.equal((await f.records())[0].legacyPendingRun?.reason, 'cost_pause');
  await saveState({ ...(await loadState()).state, costPaused: false });
  f.setTime(tick + 86_400_000);
  await f.scheduler.tickNow();
  await until(() => f.calls.length === 2, 'the deferred daily timer did not run');
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, 2);
  assert.equal((await f.records())[0].lastRunAt, new Date(tick + 86_400_000).toISOString());
});

test('queued Codex sleep plus spend pause preserves and coalesces the daily timer', async t => {
  const busy = gate();
  t.after(busy.resolve);
  const daily = { ...timer, id: 'daily-sleep-cost', name: 'Ежедневный', type: 'daily', hour: 9 };
  const f = await dispatchFixture(t, { timers: [daily], chatId: 42, run: async ({ prompt }) => {
    if (prompt === 'Занять очередь') await busy.promise;
    return normalResult;
  } });
  await f.message('Занять очередь');
  await until(() => f.calls.length === 1, 'manual turn did not start');
  await f.scheduler.tickNow();
  const marker = path.join(msbRoot(), 'engine', 'sleep.default');
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, 'sleep');
  await saveState({ ...(await loadState()).state, costPaused: true });
  busy.resolve();
  await until(() => !f.bot[Symbol.for('msb.scheduledTurns')].pending, 'sleep did not settle');
  assert.equal((await f.records())[0].legacyPendingRun?.reason, 'cost_pause');
  assert.equal(f.calls.length, 1);
  await fs.unlink(marker);
  await saveState({ ...(await loadState()).state, costPaused: false });
  f.setTime(tick + 86_400_000);
  await f.scheduler.tickNow();
  await until(() => f.calls.length === 2, 'deferred timer did not run after wake');
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, 2);
});


test('a previously queued paused daily or weekly run coalesces at admission after resume', async t => {
  const daily = { ...timer, id: 'daily-queued-boundary', name: 'Дневной', type: 'daily', hour: 9 };
  const weekly = { ...timer, id: 'weekly-queued-boundary', name: 'Недельный', type: 'weekly', hour: 9, weekdays: [7] };
  const f = await dispatchFixture(t, { timers: [daily, weekly], chatId: 42 });
  await saveState({ ...(await loadState()).state, costPaused: true });
  const entered = gate(), release = gate();
  t.after(release.resolve);
  const send = f.bot.api.sendMessage;
  let held = false;
  f.bot.api.sendMessage = async (chat, text, ...options) => {
    if (text === 'Думаю ⏳' && !held) { held = true; entered.resolve(); await release.promise; }
    return send(chat, text, ...options);
  };
  const firstTick = f.scheduler.tickNow();
  try {
    await firstTick;
    await until(() => held, 'expected paused status');
    f.setTime(tick + 7 * 86_400_000);
    await saveState({ ...(await loadState()).state, costPaused: false });
    await f.scheduler.tickNow();
  } finally { release.resolve(); }
  await until(() => f.calls.some(call => call.prompt.includes(weekly.name)), 'queued weekly did not run');
  await until(() => !f.bot[Symbol.for('msb.scheduledTurns')].pending, 'queued turns did not settle');
  await f.scheduler.tickNow();
  await until(() => f.calls.some(call => call.prompt.includes(daily.name)), 'daily did not run');
  await until(() => !f.bot[Symbol.for('msb.scheduledTurns')].pending, 'resumed turns did not settle');
  await f.scheduler.tickNow();
  const prompts = f.calls.map(call => call.prompt).join('\n');
  assert.equal(prompts.split(daily.name).length - 1, 1);
  assert.equal(prompts.split(weekly.name).length - 1, 1);
});

for (const provider of ['codex', 'claude']) {
  test('spend pause during the admitted ' + provider + ' timer status retains only the timer', async t => {
    const busy = gate(), entered = gate(), release = gate();
    t.after(busy.resolve); t.after(release.resolve);
    const f = await dispatchFixture(t, { chatId: 42, run: async ({ prompt }) => {
      if (prompt === 'Занять очередь') await busy.promise;
      return normalResult;
    } });
    const state = { ...(await loadState()).state };
    if (provider === 'claude') { delete state.extAuthBypass; state.authMode = 'subscription'; state.hasSubscriptionAuth = true; }
    await saveState(state);
    await f.message('Занять очередь');
    await until(() => f.calls.length === 1, 'manual turn did not start');
    await f.scheduler.tickNow();
    await f.message('Не повторять ручной ввод');
    const send = f.bot.api.sendMessage, edit = f.bot.api.editMessageText;
    let held = false;
    const pauseStatus = async text => {
      if (text === 'Думаю ⏳' && !held) { held = true; entered.resolve(); await release.promise; }
    };
    f.bot.api.sendMessage = async (chat, text, ...options) => {
      await pauseStatus(text);
      return send(chat, text, ...options);
    };
    f.bot.api.editMessageText = async (chat, id, text, ...options) => {
      await pauseStatus(text);
      return edit(chat, id, text, ...options);
    };
    busy.resolve();
    try {
      await until(() => held, 'timer status did not start');
      await saveState({ ...(await loadState()).state, costPaused: true });
    } finally { release.resolve(); }
    await until(() => f.messages.some(text => text.includes('Дневной лимит достигнут')), 'paused response did not finish');
    assert.equal(f.calls.length, 1);
    assert.equal((await f.records())[0].legacyPendingRun?.reason, 'cost_pause');
    await saveState({ ...(await loadState()).state, costPaused: false });
    f.setTime(tick + 10 * 60_000);
    await f.scheduler.tickNow();
    await until(() => f.calls.length === 2, 'timer did not resume after the late pause');
    assert.ok(f.calls[1].prompt.includes(timerPrompt));
    assert.ok(!f.calls[1].prompt.includes('Не повторять ручной ввод'));
    await f.scheduler.tickNow();
    assert.equal(f.calls.length, 2);
  });
}


test('status delivery failure during a late spend pause retains the unstarted timer', async t => {
  const entered = gate(), release = gate();
  t.after(release.resolve);
  const f = await dispatchFixture(t, { chatId: 42 });
  const send = f.bot.api.sendMessage;
  let held = false;
  f.bot.api.sendMessage = async (chat, text, ...options) => {
    if (text === 'Думаю ⏳' && !held) {
      held = true; entered.resolve(); await release.promise; throw Error('synthetic status failure');
    }
    return send(chat, text, ...options);
  };
  const tickRun = f.scheduler.tickNow();
  try {
    await tickRun;
    await until(() => held, 'timer status did not start');
    await saveState({ ...(await loadState()).state, costPaused: true });
  } finally { release.resolve(); }
  await until(() => !f.bot[Symbol.for('msb.scheduledTurns')].pending, 'timer worker did not settle');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.records())[0].legacyPendingRun?.reason, 'cost_pause');
  f.bot.api.sendMessage = send;
  await saveState({ ...(await loadState()).state, costPaused: false });
  f.setTime(tick + 10 * 60_000);
  await f.scheduler.tickNow();
  await until(() => f.calls.length === 1, 'unstarted timer did not resume');
});

test('a deleted admitted timer is not recreated by a later spend pause', async t => {
  const entered = gate(), release = gate();
  t.after(release.resolve);
  const f = await dispatchFixture(t, { chatId: 42 });
  const send = f.bot.api.sendMessage;
  let held = false;
  f.bot.api.sendMessage = async (chat, text, ...options) => {
    if (text === 'Думаю ⏳' && !held) { held = true; entered.resolve(); await release.promise; }
    return send(chat, text, ...options);
  };
  await f.scheduler.tickNow();
  try {
    await until(() => held, 'timer status did not start');
    await changeLegacyTimer(timer.id, { remove: true });
    await saveState({ ...(await loadState()).state, costPaused: true });
  } finally { release.resolve(); }
  await until(() => !f.bot[Symbol.for('msb.scheduledTurns')].pending, 'timer worker did not settle');
  assert.deepEqual(await f.records(), []);
  assert.equal(f.calls.length, 0);
  await saveState({ ...(await loadState()).state, costPaused: false });
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, 0);
});

test('a daily timer due under existing Codex sleep and spend pause is retained', async t => {
  const daily = { ...timer, id: 'sleep-before-due', name: 'Сон перед сроком', type: 'daily', hour: 9 };
  const f = await dispatchFixture(t, { timers: [daily], chatId: 42 });
  const marker = path.join(msbRoot(), 'engine', 'sleep.default');
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, 'sleep');
  await saveState({ ...(await loadState()).state, costPaused: true });
  await f.scheduler.tickNow();
  await until(() => !f.bot[Symbol.for('msb.scheduledTurns')].pending, 'sleep notice did not settle');
  assert.equal((await f.records())[0].legacyPendingRun?.reason, 'cost_pause');
  assert.equal(f.calls.length, 0);
  await fs.unlink(marker);
  await saveState({ ...(await loadState()).state, costPaused: false });
  f.setTime(tick + 10 * 60_000);
  await f.scheduler.tickNow();
  await until(() => f.calls.length === 1, 'daily timer did not resume');
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, 1);
});

test('an existing Codex-sleep pending timer acquires spend pause and coalesces after resume', async t => {
  const busy = gate();
  t.after(busy.resolve);
  const daily = { ...timer, id: 'prior-sleep', name: 'Ранее уснул', type: 'daily', hour: 9 };
  const f = await dispatchFixture(t, { timers: [daily], chatId: 42, run: async ({ prompt }) => {
    if (prompt === 'Занять очередь') await busy.promise;
    return normalResult;
  } });
  await f.message('Занять очередь');
  await until(() => f.calls.length === 1, 'manual turn did not start');
  await f.scheduler.tickNow();
  const marker = path.join(msbRoot(), 'engine', 'sleep.default');
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, 'sleep');
  busy.resolve();
  await until(() => !f.bot[Symbol.for('msb.scheduledTurns')].pending, 'sleep did not settle');
  assert.ok((await f.records())[0].legacyPendingRun);
  assert.equal((await f.records())[0].legacyPendingRun.reason, undefined);
  await saveState({ ...(await loadState()).state, costPaused: true });
  await f.scheduler.tickNow();
  assert.equal((await f.records())[0].legacyPendingRun?.reason, 'cost_pause');
  await fs.unlink(marker);
  await saveState({ ...(await loadState()).state, costPaused: false });
  f.setTime(tick + 86_400_000);
  await f.scheduler.tickNow();
  await until(() => f.calls.length === 2, 'deferred timer did not resume');
  await f.scheduler.tickNow();
  assert.equal(f.calls.length, 2);
});

test('an existing sleep marker keeps its prior non-Codex behavior under spend pause', async t => {
  const f = await dispatchFixture(t, { chatId: 42 });
  const { extAuthBypass, ...state } = (await loadState()).state;
  await saveState({ ...state, authMode: 'subscription', hasSubscriptionAuth: true, costPaused: true });
  const marker = path.join(msbRoot(), 'engine', 'sleep.default');
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, 'sleep');
  await f.scheduler.tickNow();
  assert.deepEqual(await f.records(), [timer]);
  assert.equal(f.calls.length, 0);
});
