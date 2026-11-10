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
import { addTask, listTasks } from '../src/autonomy/store.mjs';
import { botRoot, msbRoot } from '../src/paths.mjs';
import { loadState, saveState } from '../src/state.mjs';
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
  const f = await fixture(t, async args => {
    calls.push(args);
    return run ? run(args) : normalResult;
  }, { overlay: false, runtimeProfile: 'jar1' });
  for (const key of ['MSB_SESSION_DIR', 'IIA_SESSION_DIR', 'AUTONOMY_DIR']) delete process.env[key];
  process.env.TZ = 'UTC';
  const { state } = await loadState();
  await saveState({ ...state, chatId, userId: owner, timezone: 'Asia/Kolkata' });
  const file = path.join(botRoot(), 'schedules.json');
  await fs.writeFile(file, JSON.stringify(timers));
  const send = f.bot.api.sendMessage;
  f.bot.api.sendMessage = async (chat, ...args) => { recipients.push(chat); return send(chat, ...args); };
  let time = tick;
  const intervalRuns = [];
  const scheduler = startScheduler({ api: f.bot.api, adminId: 42, timezone: 'UTC', log() {},
    scheduledTurns: f.bot[Symbol.for('msb.scheduledTurns')], now: () => time,
    runTurn: async args => { intervalRuns.push(args); return { ok: true, text: 'interval answer' }; },
  });
  t.after(() => scheduler.stop());
  return { ...f, scheduler, file, calls, recipients, intervalRuns, setTime(value) { time = value; },
    records: async () => JSON.parse(await fs.readFile(file, 'utf8')) };
}

test('legacy once: emits the old prompt to the saved owner chat and consumes it exactly once', async t => {
  const f = await dispatchFixture(t);
  await f.scheduler.tickNow();
  assert.deepEqual(await f.records(), [{ ...timer, enabled: false, lastRunAt: stamp }]);

  await until(() => f.edits.some(text => text.includes('Напоминание готово')), 'timer must deliver through the Telegram turn');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].prompt, timerPrompt);
  assert.equal(f.calls[0].isAutoTurn, true);
  assert.notEqual(f.calls[0].autonomy, true);
  assert.ok(f.typingSignals.length > 0);
  assert.deepEqual(f.recipients, [groupChat]);
  assert.deepEqual(await listTasks(), []);
  assert.ok(f.edits.some(text => /Напоминание готово.*⏱.*50%/s.test(text)));

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
  assert.deepEqual(await f.records(), [{ ...daily, lastRunAt: stamp }, { ...weekly, lastRunAt: stamp }, wrongDay]);
  await until(() => f.calls.map(call => call.prompt).join('\n').includes('Каждое воскресенье'), 'weekly timer did not dispatch');
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
  assert.deepEqual(await f.records(), [{ ...timer, enabled: false, lastRunAt: stamp }]);
});

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

test('shutdown drains a reserved timer stamp and never starts its cancelled turn', async t => {
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
  assert.deepEqual(await f.records(), [{ ...timer, enabled: false, lastRunAt: stamp }]);
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
  try {
    await until(() => writing, 'first scheduled write did not reach publication');
    await f.message('/stop');
    assert.ok(f.messages.includes('Моя остановочка ✋🏽⛔️'));
  } finally {
    fs.rename = rename;
    release.resolve();
    await dispatch;
  }
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
