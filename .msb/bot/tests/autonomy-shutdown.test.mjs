/** [Scheduler stop](../src/autonomy/scheduler.mjs) with synthetic intervals and notification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startScheduler } from '../src/autonomy/scheduler.mjs';
import { addTask, listTasks } from '../src/autonomy/store.mjs';
import { autonomyDir } from '../src/paths.mjs';
import { fixture } from './helpers/menu-fixture.mjs';

test('scheduler shutdown aborts and drains the active interval before process exit', async t => {
  const f = await fixture(t, undefined, { overlay: false, runtimeProfile: 'jar1' });
  process.env.AUTONOMY_DIR = path.join(f.home, 'tasks');
  const now = Date.parse('2026-11-09T12:00:00.000Z');
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const scheduler = startScheduler({ api: f.bot.api, adminId: 42, now: () => now, log() {},
    runTurn: async ({ signal }) => {
      entered.resolve(signal);
      await release.promise;
      return signal.aborted ? { ok: false, error: 'aborted' } : { ok: true, text: 'late interval result' };
    },
  });
  const task = await addTask({ prompt: 'active interval', nextAt: now - 1 });
  const tick = scheduler.tickNow();
  const signal = await Promise.race([entered.promise, tick.then(() => assert.fail('interval did not start'))]);
  let drained = false;
  const drainage = scheduler.stop().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  const observed = { aborted: signal.aborted, drained };
  release.resolve();
  await Promise.all([drainage, tick]);

  assert.deepEqual(observed, { aborted: true, drained: false });
  assert.deepEqual(await listTasks(), [task]);
  assert.ok(!f.messages.some(text => text.includes('late interval result')));
});

test('shutdown during notification preserves the completed attempt', async t => {
  const f = await fixture(t, undefined, { overlay: false, runtimeProfile: 'jar1' });
  process.env.AUTONOMY_DIR = path.join(f.home, 'tasks');
  const now = Date.parse('2026-11-09T12:00:00.000Z');
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.bot.api.sendMessage = async (_chat, _text, _options, signal) => {
    entered.resolve(signal);
    await release.promise;
    signal?.throwIfAborted();
  };
  const scheduler = startScheduler({ api: f.bot.api, adminId: 42, now: () => now, log() {},
    runTurn: async () => ({ ok: true, text: 'interval result' }),
  });
  const task = await addTask({ prompt: 'completed interval', everyHours: 1, nextAt: now - 1 });
  const tick = scheduler.tickNow();
  const signal = await Promise.race([entered.promise, tick.then(() => assert.fail('notification did not start'))]);
  const drainage = scheduler.stop();
  release.resolve();
  await Promise.all([drainage, tick]);

  assert.equal(signal?.aborted, true);
  const [saved] = await listTasks();
  assert.equal(saved.nextAt, now + 3_600_000);
  const row = JSON.parse(await fs.readFile(path.join(autonomyDir(), 'runs.jsonl'), 'utf8'));
  assert.equal(row.taskId, task.id);
  assert.equal(row.ok, true);
});
