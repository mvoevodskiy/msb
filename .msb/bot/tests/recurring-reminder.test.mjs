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
import { statePath } from '../src/paths.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { initial, min, owner, at, every, cron, record, profile } from './helpers/recurring-reminder-fixture.mjs';

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

test('old frequency floor honors the per-action saved Keep and holds an unapproved fast row', async t => {
  const waiting = record('waiting', every(15));
  const keep = record('keep', cron('*/15 * * * *'), { disabledReason: 'frequency' });
  const off = record('off', every(15), { enabled: false, disabledReason: 'owner' });
  const f = await profile(t, [waiting, keep, off]);
  const original = { 'autonomy-cron:keep:frequency': { value: 'keep_as_is' }, 'autonomy-cron:off:frequency': { value: 'keep_as_is' } };
  await f.decisions(original);
  await f.scheduler.tickNow();
  assert.deepEqual(f.deliveries(), [{ chat: owner, text: '⏰ Дословно keep' }]);
  const after = await f.rows();
  assert.deepEqual(after[0], { ...waiting, disabledReason: 'frequency' });
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

test('one slow send cannot drop another cron reminder selected in the same old tick', async t => {
  const f = await profile(t, [record('slow', cron('0 9 * * *')), record('second', cron('0 9 * * *'))],
    { now: initial + 59_000 });
  const send = f.bot.api.sendMessage;
  f.bot.api.sendMessage = async (...args) => {
    if (args[1] === '⏰ Дословно slow') f.setTime(initial + 61_000);
    return send(...args);
  };
  await f.scheduler.tickNow();
  await f.scheduler.tickNow();
  assert.deepEqual(f.deliveries().map(row => row.text), ['⏰ Дословно slow', '⏰ Дословно second']);
  assert.deepEqual((await f.runs()).map(row => row.ts), [at(initial + 59_000), at(initial + 61_000)]);
});

test('owner Off during an admitted recurring send preserves the real result and new pause choice', async t => {
  const entry = record('toggle', every(60));
  const f = await profile(t, [entry]);
  const breakerFile = path.join(f.autonomy, 'breakers.json');
  await fs.writeFile(breakerFile, JSON.stringify({ toggle: { open: false, consecutiveFailures: 2 } }));
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const send = f.bot.api.sendMessage;
  f.bot.api.sendMessage = async (...args) => {
    if (args[1] === '⏰ Дословно toggle') {
      entered.resolve();
      await release.promise;
      throw Error('synthetic pending failure');
    }
    return send(...args);
  };
  const tick = f.scheduler.tickNow();
  try {
    await Promise.race([entered.promise, tick.then(() => assert.fail('Expected a send to be in flight'))]);
    await f.callback('auto:task-toggle:toggle');
  } finally {
    release.resolve();
  }
  await tick;
  const [saved] = await f.rows();
  assert.equal(saved.enabled, false);
  assert.equal(saved.disabledReason, 'owner');
  assert.equal(saved.lastStatus, 'error');
  assert.equal(JSON.parse(await fs.readFile(breakerFile, 'utf8')).toggle.consecutiveFailures, 3);
  assert.equal((await f.runs()).length, 1);
});

test('simultaneous schedulers claim a recurring slot only once and leave foreign records alone', async t => {
  const entry = record('local', every(60));
  const separate = [
    record('explicit-oc', every(60), { runner: 'oc' }),
    record('mapped', every(60)),
    record('migrated', every(60), { migratedToOc: true }),
    record('follow-up', every(60), { task: { kind: 'reminder', text: 'Повтор', followUp: { everyMinutes: 5 } } }),
    record('model', every(60), { task: { kind: 'prompt', prompt: 'Synthetic isolated action' } }),
    record('bad', every(-10)),
  ];
  const f = await profile(t, [entry, ...separate]);
  await fs.writeFile(path.join(f.autonomy, 'cron-jobs.json'), '{"mapped":{"jobId":"fixture-native"}}');
  const second = f.makeScheduler();
  t.after(() => second.stop());
  await Promise.all([f.scheduler.tickNow(), second.tickNow()]);
  assert.deepEqual(f.deliveries(), [{ chat: owner, text: '⏰ Дословно local' }]);
  assert.deepEqual((await f.rows()).slice(1), separate);
  assert.deepEqual((await f.runs()).map(row => row.actionId), ['local']);
});
