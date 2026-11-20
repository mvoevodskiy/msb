/** The real reminder registration and dispatcher interpret cron lists as sets. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { marker, reminderFixture } from './helpers/reminder-registration-fixture.mjs';

function schedule(cron, text) {
  return marker({ trigger: { kind: 'recurring', cron }, task: { kind: 'reminder', text } });
}

test('repeated minute and hour values do not create additional cron firings', async t => {
  const minute = '0,0 13 * * *';
  const hour = '0 13,13 * * *';
  const fast = '0,0,30 13 * * *';
  const texts = ['Повтор минуты', 'Повтор часа', 'Два разных запуска'];
  const output = [minute, hour, fast].map((cron, i) => schedule(cron, texts[i])).join('\n');
  const f = await reminderFixture(t, { output });
  const due = Date.parse('2026-11-08T10:00:00.000Z');
  f.setTime(due - 60_000);
  await f.request('Поставь три напоминания');

  const final = await f.final();
  assert.equal((final.match(/Ок, поставил:/g) || []).length, 2, final);
  assert.match(final, /слишком часто: каждые 30 мин/);
  assert.deepEqual((await f.records()).map(row => row.trigger.cron), [minute, hour]);

  const scheduler = f.scheduler();
  f.setTime(due);
  await scheduler.tickNow();
  await scheduler.tickNow();
  assert.deepEqual(f.delivered().map(row => row.text), texts.slice(0, 2).map(text => '⏰ ' + text));
});

for (const cron of ['0,bad,bad 13 * * *', '0 13,24,24 * * *']) {
  test(`invalid repeated values in ${cron} are still refused`, async t => {
    const f = await reminderFixture(t, { output: schedule(cron, 'Некорректное расписание') });
    await f.request('Проверь это расписание');

    const final = await f.final();
    assert.doesNotMatch(final, /Ок, поставил:/);
    assert.match(final, /для регулярной задачи нужен корректный cron \(5 полей\)/);
    await assert.rejects(fs.stat(f.actionFile), { code: 'ENOENT' });
  });
}
