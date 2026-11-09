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
const normalResult = { ok: true, text: 'Напоминание готово', result: { context: { usedTokens: 5, contextWindow: 10 } } };
const groupChat = -10000234;

async function until(check, label) {
  const deadline = Date.now() + 700;
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
  assert.ok(f.edits.some(text => /Напоминание готово.*⏱/s.test(text)));

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
