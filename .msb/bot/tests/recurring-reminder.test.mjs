/**
 * Saved actions through the real local scheduler and Telegram task callbacks.
 * Old blob 73aa9e7e850bad7ac1ea8a8091d086ecbfd47a11: 22097–22174,
 * 24656–24682, 35919–36086, 36099–36139 and 37005–37036.
 * Every sender, time, and file belongs to the fixture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startScheduler } from '../src/autonomy/scheduler.mjs';
import { actionRoot, statePath } from '../src/paths.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { fixture } from './helpers/menu-fixture.mjs';

const initial = Date.parse('2026-11-09T06:00:00.000Z');
const min = 60_000;
const owner = -100777;
const at = time => new Date(time).toISOString();
const every = minutes => ({ kind: 'interval', intervalMinutes: minutes });
const cron = (expression, timezone) => ({ kind: 'cron', cron: expression, ...(timezone ? { timezone } : {}) });
const record = (id, trigger, extra = {}) => ({ id, name: 'Сохранено ' + id, enabled: true,
  trigger, task: { kind: 'reminder', text: 'Дословно ' + id }, runner: 'auto', retained: id, ...extra });

async function profile(t, rows, { state = {}, now = initial } = {}) {
  const f = await fixture(t, async () => assert.fail('The scheduled literal text must not start an owner turn'),
    { overlay: false, runtimeProfile: 'jar1' });
  for (const key of ['MSB_SESSION_DIR', 'IIA_SESSION_DIR', 'AUTONOMY_DIR', 'AUTONOMY_DAILY_CAP_USD',
    'AUTONOMY_DAILY_CAP_RUNS', 'AUTONOMY_DAILY_CAP_TOKENS', 'AUTONOMY_RESERVE_FRACTION']) delete process.env[key];
  process.env.AUTONOMY_ENABLED = '1';
  await saveState({ ...(await loadState()).state, engine: 'cc', timezone: 'Europe/Moscow', chatId: owner, userId: 42, ...state });
  const root = actionRoot();
  const file = path.join(root, 'actions.json');
  const autonomy = path.join(root, 'autonomy');
  const journal = path.join(autonomy, 'runs.jsonl');
  await fs.mkdir(autonomy, { recursive: true });
  const saveRows = actions => fs.writeFile(file, JSON.stringify(actions));
  await saveRows(rows);
  const sent = [];
  const send = f.bot.api.sendMessage;
  f.bot.api.sendMessage = async (chat, text, ...options) => {
    sent.push({ chat, text });
    return send(chat, text, ...options);
  };
  let clock = now;
  const makeScheduler = () => startScheduler({ api: f.bot.api, adminId: 42, timezone: 'UTC',
    runTurn: async () => assert.fail('The interval approximation must not execute actions.json'), now: () => clock, log() {} });
  const scheduler = makeScheduler();
  t.after(() => scheduler.stop());
  return { ...f, file, journal, autonomy, scheduler, makeScheduler, saveRows, sent,
    deliveries: () => sent.filter(row => row.text.startsWith('⏰')),
    rows: async () => JSON.parse(await fs.readFile(file, 'utf8')),
    runs: async () => (await fs.readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse),
    advance: async value => { clock = value; await scheduler.tickNow(); },
    decisions: rows => fs.writeFile(path.join(root, 'owner-decisions.json'), JSON.stringify({ decisions: rows })),
  };
}

test('a saved interval follows its last attempt and keeps owner session and provider store bytes unchanged', async t => {
  const entry = record('interval', every(60), { lastRunAt: at(initial - 60 * min) });
  const f = await profile(t, [entry]);
  const settings = await fs.readFile(statePath());
  const provider = await fs.readFile(f.storeFile);
  await f.scheduler.tickNow();
  await f.advance(initial + 59 * min);
  assert.deepEqual(f.deliveries(), [{ chat: owner, text: '⏰ Дословно interval' }]);
  await f.advance(initial + 60 * min);
  assert.equal(f.deliveries().length, 2);
  assert.deepEqual((await f.runs()).map(row => [row.ts, row.status]), [[at(initial), 'ok'], [at(initial + 60 * min), 'ok']]);
  const [saved] = await f.rows();
  assert.equal(saved.enabled, true);
  assert.equal(saved.lastRunAt, at(initial + 60 * min));
  assert.equal(saved.retained, 'interval');
  assert.notEqual(saved.disabledReason, 'spent_once');
  assert.deepEqual(await fs.readFile(statePath()), settings);
  assert.deepEqual(await fs.readFile(f.storeFile), provider);
});

test('saved cron matches owner local minute, weekday and day together, with no duplicate or catch-up', async t => {
  const ready = record('cron', cron('0 8-10/1 9 11 1-5', 'UTC'));
  const wrong = record('wrong-day', cron('0 9 10 11 1-5'));
  const f = await profile(t, [ready, wrong]);
  await f.advance(initial - min);
  await f.advance(initial);
  await f.advance(initial + 30_000);
  await f.advance(initial + 61 * min);
  assert.deepEqual(f.deliveries(), [{ chat: owner, text: '⏰ Дословно cron' }]);
  assert.equal((await f.rows()).find(row => row.id === 'wrong-day').lastRunAt, undefined);
  assert.equal((await f.rows()).find(row => row.id === 'cron').lastRunAt, at(initial));
});

test('the repeated local cron minute at the DST fallback remains one delivery', async t => {
  const first = Date.parse('2026-11-01T05:30:00.000Z');
  const f = await profile(t, [record('dst', cron('30 1 * * 0'))], { now: first, state: { timezone: 'America/New_York' } });
  await f.scheduler.tickNow();
  await f.advance(first + 60 * min);
  assert.equal(f.deliveries().length, 1);
  assert.equal((await f.rows())[0].lastRunAt, at(first));
});

test('old frequency floor honors the per-action saved Keep and leaves unapproved fast rows alone', async t => {
  const waiting = record('waiting', every(15));
  const keep = record('keep', cron('*/15 * * * *'), { disabledReason: 'frequency' });
  const off = record('off', every(15), { enabled: false, disabledReason: 'owner' });
  const f = await profile(t, [waiting, keep, off]);
  const original = { 'autonomy-cron:keep:frequency': { value: 'keep_as_is' }, 'autonomy-cron:off:frequency': { value: 'keep_as_is' } };
  await f.decisions(original);
  await f.scheduler.tickNow();
  assert.deepEqual(f.deliveries(), [{ chat: owner, text: '⏰ Дословно keep' }]);
  const after = await f.rows();
  assert.deepEqual(after[0], waiting);
  assert.equal(after[1].disabledReason, undefined);
  assert.deepEqual(after[2], off);
});

test('recurring rejection consumes a slot and a breaker follows two intervals before recovery', async t => {
  const entry = record('repeat', every(120));
  const f = await profile(t, [entry], { state: { costPaused: true } });
  const originalSend = f.bot.api.sendMessage;
  let failures = 0;
  f.bot.api.sendMessage = async (...args) => {
    if (args[1].startsWith('⏰') && failures < 3) { failures++; throw Error('synthetic send failure'); }
    return originalSend(...args);
  };
  await f.scheduler.tickNow();
  assert.equal((await f.rows())[0].enabled, true);
  assert.equal((await f.rows())[0].lastRunAt, at(initial));
  await saveState({ ...(await loadState()).state, costPaused: false });
  await f.advance(initial + 119 * min);
  assert.equal(failures, 0);
  for (const offset of [120, 240, 360, 480, 600]) await f.advance(initial + offset * min);
  assert.equal(failures, 3);
  const history = await f.runs();
  assert.deepEqual(history.map(row => row.status), ['blocked', 'error', 'error', 'error', 'skipped', 'ok']);
  assert.match(history[4].detail, /breaker открыт до/);
  assert.ok(history[4].detail.includes(at(initial + 600 * min)));
  assert.equal((await f.rows())[0].enabled, true);
  assert.match(f.sent.find(row => row.text.includes('несколько раз подряд'))?.text || '', /Сообщу, когда восстановится/);
  assert.match(f.sent.at(-1).text, /снова работает\. Пауза была 4 часа/);
});

test('the existing task card can pause and resume a recurring reminder after its first delivery', async t => {
  const f = await profile(t, [record('control', every(60))]);
  await f.scheduler.tickNow();
  await f.callback('auto:tasks');
  assert.match(f.edits.at(-1), /Сохранено control.*каждые 60 мин/s);
  await f.callback('auto:task:control');
  assert.match(f.edits.at(-1), /Статус: ✔ работает/);
  assert.ok(f.editOptions.at(-1).reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'auto:task-toggle:control'));
  await f.callback('auto:task-toggle:control');
  assert.equal((await f.rows())[0].enabled, false);
  await f.advance(initial + 60 * min);
  assert.equal(f.deliveries().length, 1);
  await f.callback('auto:task-toggle:control');
  await f.scheduler.tickNow();
  assert.equal(f.deliveries().length, 2);
});
