/** Persisted STOP reminder at the scheduler entry and the real Telegram settings callbacks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/menu-fixture.mjs';
import { drainCallbackTasks } from '../shared/callback-renders.mjs';
import { startScheduler } from '../src/autonomy/scheduler.mjs';
import { actionRoot } from '../src/paths.mjs';
import { loadState, saveState } from '../src/state.mjs';

const noon = Date.parse('2026-11-24T12:00:00Z');
const day = 86_400_000;
const active = { id: 'notice-test', name: 'Контроль', enabled: true, runner: 'auto',
  trigger: { kind: 'once', at: new Date(noon).toISOString() }, task: { kind: 'reminder', text: 'Контроль' } };

async function profile(t) {
  let now = noon;
  const f = await fixture(t, undefined, { runtimeProfile: 'jar1', now: () => now });
  const root = actionRoot();
  process.env.AUTONOMY_ENABLED = '1';
  await saveState({ ...(await loadState()).state, engine: 'cc', userId: 42, chatId: 42, timezone: 'UTC' });
  const stop = path.join(root, 'autonomy/STOP');
  const receipt = path.join(root, 'autonomy/stop-notice.json');
  await fs.mkdir(path.dirname(stop), { recursive: true });
  await fs.writeFile(stop, 'owner\n' + new Date(noon - 3 * day).toISOString() + '\n');
  const writeActions = rows => fs.writeFile(path.join(root, 'actions.json'), JSON.stringify(rows));
  await writeActions([active]);
  const scheduler = () => {
    const s = startScheduler({ api: f.bot.api, adminId: 42, timezone: 'UTC', now: () => now,
      scheduledTurns: f.bot[Symbol.for('msb.scheduledTurns')], log() {} });
    t.after(() => s.stop());
    return s;
  };
  return { ...f, root, stop, receipt, scheduler, writeActions, setTime: value => { now = value; } };
}

test('stale owner STOP delivers once across schedulers; mute, return and resume use the real buttons', async t => {
  const f = await profile(t);
  const first = f.scheduler(), second = f.scheduler();
  await Promise.all([first.tickNow(), second.tickNow()]);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0], /Фон стоит с 21 ноября \(3 дня\): задач 1/);
  assert.deepEqual(f.messageOptions[0].reply_markup.inline_keyboard.flat().map(b => b.callback_data), ['pause-off', 'nm:pause_reminder']);
  const readReceipt = async () => JSON.parse(await fs.readFile(f.receipt, 'utf8')).lastToldAt;
  assert.equal(await readReceipt(), new Date(noon).toISOString());

  await f.callback('nm:pause_reminder');
  const before = f.messages.length;
  f.setTime(noon + 7 * day);
  await second.tickNow();
  assert.equal(f.messages.length, before);
  assert.equal(await readReceipt(), new Date(noon + 7 * day).toISOString());
  await f.callback('nm:on:pause_reminder');
  await first.tickNow();
  assert.equal(f.messages.length, before);
  f.setTime(noon + 14 * day);
  await first.tickNow();
  assert.equal(f.messages.length, before + 1);
  assert.match(f.messages.at(-1), /Фон стоит/);
  await f.writeActions([{ ...active, trigger: { kind: 'once', at: new Date(noon + 14 * day).toISOString() } }]);
  await f.callback('pause-off', 42, { replyMarkup: f.messageOptions.at(-1).reply_markup });
  await drainCallbackTasks(f.bot);
  await first.tickNow();
  assert.equal(f.messages.at(-1), '⏰ Контроль');
});

test('daytime, one-day threshold and live-task gates precede the notice; a failed send can retry', async t => {
  const f = await profile(t);
  const at = new Date(noon - day);
  await fs.writeFile(f.stop, 'legacy one-line STOP');
  await fs.utimes(f.stop, at, at);
  const s = f.scheduler();
  await s.tickNow();
  f.setTime(noon + 9 * 3_600_000); // 21:00 UTC
  await s.tickNow();
  f.setTime(noon + day);
  await f.writeActions([{ ...active, lastRunAt: new Date(noon - day).toISOString() }]);
  await s.tickNow();
  await fs.access(f.stop);
  assert.equal(f.messages.length, 0);
  await assert.rejects(fs.access(f.receipt), { code: 'ENOENT' });

  await f.writeActions([active]);
  const send = f.bot.api.sendMessage;
  let attempts = 0;
  t.mock.method(f.bot.api, 'sendMessage', async (...args) => {
    if (++attempts === 1) throw Error('temporary Telegram failure');
    return send(...args);
  });
  await s.tickNow();
  assert.equal(attempts, 1);
  await assert.rejects(fs.access(f.receipt), { code: 'ENOENT' });
  await s.tickNow();
  assert.match(f.messages.at(-1), /23 ноября \(2 дня\)/);
  assert.equal(attempts, 2);
});

test('fleet pause alone, a disabled scheduler and an unbound destination send no owner reminder', async t => {
  const f = await profile(t);
  const s = f.scheduler();
  process.env.AUTONOMY_ENABLED = '0';
  await s.tickNow();
  process.env.AUTONOMY_ENABLED = '1';
  const { state } = await loadState();
  await saveState({ ...state, userId: 101 });
  await s.tickNow();
  await saveState(state);
  await fs.unlink(f.stop);
  await fs.writeFile(path.join(f.root, 'remote-config.json'), '{"autonomyGlobalStop":true}');
  await s.tickNow();
  assert.equal(f.messages.length, 0);
  await assert.rejects(fs.access(f.receipt), { code: 'ENOENT' });
});

test('a corrupt receipt recovers on the first local morning and survives scheduler restart', async t => {
  const f = await profile(t);
  await saveState({ ...(await loadState()).state, timezone: 'America/New_York' });
  await fs.writeFile(f.stop, 'owner\n2026-10-28T12:00:00Z\n');
  await fs.writeFile(f.receipt, '{unfinished');
  const s = f.scheduler();
  f.setTime(Date.parse('2026-11-01T13:59:00Z')); // 08:59 after the fall transition
  await s.tickNow();
  assert.equal(f.messages.length, 0);
  f.setTime(Date.parse('2026-11-01T14:00:00Z'));
  await s.tickNow();
  assert.equal(f.messages.length, 1);
  assert.equal(JSON.parse(await fs.readFile(f.receipt)).lastToldAt, '2026-11-01T14:00:00.000Z');
  await s.stop();
  await f.scheduler().tickNow();
  assert.equal(f.messages.length, 1);
});
