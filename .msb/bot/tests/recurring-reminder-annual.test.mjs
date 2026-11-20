/** Register an annual reminder through Telegram and run the saved scheduler across years. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { marker, ownerChat, reminderFixture } from './helpers/reminder-registration-fixture.mjs';

test('an annual cron delivers at the same owner-local minute next year without duplicating either slot', async t => {
  const cron = '0 13 8 11 *';
  const text = 'Проверить годовой план';
  const first = Date.parse('2026-11-08T10:00:00.000Z');
  const next = Date.parse('2027-11-08T10:00:00.000Z');
  const f = await reminderFixture(t, { output: marker({
    trigger: { kind: 'recurring', cron },
    task: { kind: 'reminder', text },
  }) });
  f.setTime(first - 60_000);
  await f.request('Каждое 8 ноября в 13:00 напоминай проверить годовой план');
  assert.match(await f.final(), /Ок, поставил:/);
  const [created] = await f.records();
  assert.deepEqual(created.trigger, { kind: 'cron', cron, timezone: 'Europe/Moscow' });

  const scheduler = f.scheduler();
  f.setTime(first);
  await scheduler.tickNow();
  f.setTime(first + 30_000);
  await scheduler.tickNow();
  const delivery = { destination: ownerChat, text: '⏰ ' + text, options: undefined };
  assert.deepEqual(f.delivered(), [delivery]);
  assert.equal((await f.records())[0].lastRunAt, new Date(first).toISOString());
  await scheduler.stop();

  const restarted = f.scheduler();
  f.setTime(next - 60_000);
  await restarted.tickNow();
  assert.deepEqual(f.delivered(), [delivery], 'previous minute is not due');
  f.setTime(next);
  await restarted.tickNow();
  f.setTime(next + 30_000);
  await restarted.tickNow();

  assert.deepEqual(f.delivered(), [delivery, delivery]);
  const [saved] = await f.records();
  assert.equal(saved.lastRunAt, new Date(next).toISOString());
  assert.equal(saved.enabled, true);
  assert.equal(f.modelCalls.length, 1, 'only the owner registration invoked the model');
});
