/**
 * Old conversational recurring reminders through [final marker handling](../src/telegram/reminder-markers.mjs)
 * and [the saved scheduler](../src/autonomy/reminder-dispatch.mjs).
 * See [old source provenance](./reference/parity-autonomy-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { listTasks } from '../src/autonomy/store.mjs';
import { sessionDir } from '../src/paths.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { mcpFixture } from './helpers/mcp-fixture.mjs';
import { nativeFixtures } from './helpers/mcp-launch-fixture.mjs';
import { chat, ownerChat, marker, reminderFixture, until } from './helpers/reminder-registration-fixture.mjs';

const recurring = (cron, { text = 'Проверить почту', name, timezone } = {}) => ({
  name, trigger: { kind: 'recurring', cron, timezone }, task: { kind: 'reminder', text },
});
const monday = Date.parse('2026-11-09T06:00:00.000Z');

test('a weekday reminder is saved before confirmation and recurs at the owner clock after restart', async t => {
  const output = 'Утренний список.\n\n' + marker(recurring('  0  9 * * 1-5  ', {
    text: '  Проверить почту <входящие>  ', timezone: 'Asia/Yekaterinburg',
  })) + '\n\nСледующая просьба.';
  const f = await reminderFixture(t, { output });
  await f.request('По будням в 9 напоминай проверить почту');
  const final = await f.final();
  assert.match(final, /Утренний список/);
  assert.match(final, /Ок, поставил: «Напоминание: Проверить почту &lt;входящие&gt;» — по будням в 09:00 \(МСК\) · следующее завтра в 09:00 \(МСК\)\./);
  assert.match(final, /Следующая просьба/);
  assert.doesNotMatch(final, /SCHEDULE_TASK/);
  const [entry] = await f.records();
  assert.deepEqual(entry.trigger, { kind: 'cron', cron: '0  9 * * 1-5', timezone: 'Asia/Yekaterinburg' });
  assert.deepEqual(entry.task, { kind: 'reminder', text: 'Проверить почту <входящие>' });
  assert.deepEqual(entry.origin, { chatId: chat, threadId: 17 });
  assert.equal(entry.output.deliverTo.chatId, chat);
  assert.equal(entry.capability, 'none');
  assert.equal(entry.requiresApproval, false);
  assert.equal(entry.enabled, true);
  assert.deepEqual(await listTasks(), []);
  await assert.rejects(fs.stat(f.schedules), { code: 'ENOENT' });
  await f.callback('auto:task:' + entry.id);
  assert.match(f.edits.at(-1), /Когда: по будням в 09:00 \(МСК\)/);

  const first = f.scheduler();
  f.setTime(monday - 2 * 3600_000);
  await first.tickNow();
  f.setTime(monday - 1000);
  await first.tickNow();
  assert.deepEqual(f.delivered(), []);
  await first.stop();
  const restarted = f.scheduler();
  f.setTime(monday);
  await restarted.tickNow();
  await restarted.tickNow();
  f.setTime(monday + 24 * 3600_000);
  await restarted.tickNow();
  assert.deepEqual(f.delivered(), Array.from({ length: 2 }, () => ({
    destination: ownerChat, text: '⏰ Проверить почту <входящие>', options: undefined,
  })));
  const [saved] = await f.records();
  assert.equal(saved.enabled, true);
  assert.equal(saved.lastRunAt, new Date(monday + 24 * 3600_000).toISOString());
  assert.equal(saved.lastStatus, 'ok');
  assert.equal(f.modelCalls.length, 1);
});

test('the old 60-minute floor and executable cron validation apply before publishing the action', async t => {
  const payloads = [
    recurring('*/59 * * * *'),
    recurring('00 * * *'),
    recurring('0,bad 9 * * *'),
    recurring('88 9 * * *'),
    recurring('0 9 * * *', { text: ' ' }),
    recurring('0 9 * * *', { timezone: 'Invalid/Fixture' }),
    { ...recurring(''), trigger: { kind: 'interval', intervalMinutes: 60 } },
    { ...recurring('0 9 * * *'), task: { kind: 'reminder', text: 'Follow-up', followUp: { everyMinutes: 15 } } },
    recurring('0 * * * *', { name: 'Граница' }),
    recurring('15 8-10 * * *', { name: 'Диапазон' }),
  ];
  const f = await reminderFixture(t, { output: payloads.map(marker).join('\n') });
  await f.request('Проверь расписания и поставь допустимые');
  const final = await f.final();
  assert.match(final, /слишком часто: каждые 59 мин\. Каждый запуск стоит денег, поэтому регулярные задачи ставим не чаще раза в час/);
  assert.match(final, /для регулярной задачи нужен корректный cron \(5 полей\)/);
  assert.match(final, /для напоминания нужен текст/);
  assert.match(final, /часовой пояс.*Invalid\/Fixture/);
  const saved = await f.records();
  assert.deepEqual(saved.map(row => [row.name, row.trigger]), [
    ['Граница', { kind: 'cron', cron: '0 * * * *', timezone: 'Europe/Moscow' }],
    ['Диапазон', { kind: 'cron', cron: '15 8-10 * * *', timezone: 'Europe/Moscow' }],
  ]);
  assert.notEqual(saved[0].id, saved[1].id);
  assert.match(final, /«Граница» — каждый час \(МСК\) · следующее сегодня в 14:00 \(МСК\)/);
  assert.match(final, /«Диапазон» — по расписанию .*15 8-10 \* \* \*/);
});

test('a STOP committed just after registration appears in the confirmation and gates due sends', async t => {
  const f = await reminderFixture(t, { output: marker(recurring('0 * * * *')) });
  const autonomy = path.join(f.directory, 'autonomy');
  const stop = path.join(autonomy, 'STOP');
  const target = path.join(await fs.realpath(f.directory), 'actions.json');
  await fs.mkdir(autonomy, { recursive: true });
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to);
    if (to === target) await fs.writeFile(stop, 'fixture pause after action write');
  });
  await f.request('Каждый час напомни проверить почту');
  const final = await f.final();
  assert.match(final, /Поставил: «Напоминание: Проверить почту» — каждый час/);
  assert.match(final, /Но сейчас задачи на паузе, поэтому она не сработает/);
  const scheduler = f.scheduler();
  f.setTime(monday);
  await scheduler.tickNow();
  assert.deepEqual(f.delivered(), []);
  assert.equal((await f.records())[0].lastRunAt, undefined);
  await fs.unlink(stop);
  f.setTime(monday + 3600_000);
  await scheduler.tickNow();
  assert.equal(f.delivered().length, 1);
});

test('matching existing schedules and high daily load are advisories after saving', async t => {
  const f = await reminderFixture(t, { output: marker(recurring('0 * * * *', {
    name: 'Почта', text: 'Проверить, почту!',
  })) });
  const previous = { id: 'existing', name: 'Старая задача', enabled: true,
    trigger: { kind: 'cron', cron: '0  * * * *' }, task: { kind: 'reminder', text: 'проверить почту' } };
  const disabled = { ...previous, id: 'disabled', name: 'Выключена', enabled: false };
  await fs.writeFile(f.actionFile, JSON.stringify([disabled, previous]));
  const legacy = JSON.stringify([{ id: 'legacy', name: 'Старый таймер почты', type: 'daily',
    enabled: true, hour: 9, prompt: 'Проверить почту' }]);
  await fs.writeFile(f.schedules, legacy);
  await f.request('Поставь ещё одно напоминание каждый час');
  const final = await f.final();
  assert.match(final, /🔁 В то же время уже стоит «Старая задача» — то же задание\./);
  assert.match(final, /⏳ Похоже, старый таймер «Старый таймер почты» делает то же самое \(дословно одинаковое задание\)/);
  assert.match(final, /📊 Всего задач 2, вместе это 48 запусков в сутки\./);
  const rows = await f.records();
  assert.deepEqual(rows.slice(0, 2), [disabled, previous]);
  assert.equal(rows[2].name, 'Почта');
  assert.equal(await fs.readFile(f.schedules, 'utf8'), legacy);
});

test('a recurring marker uses the same active-action cap without replacing the saved row', async t => {
  const f = await reminderFixture(t, { output: marker(recurring('0 9 * * *')) });
  process.env.AUTONOMY_MAX_ACTIONS = '1';
  const previous = JSON.stringify([{ id: 'existing', enabled: true }]);
  await fs.writeFile(f.actionFile, previous);
  await f.request('Поставь вторую задачу');
  const final = await f.final();
  assert.match(final, /достигнут лимит активных автодействий \(1\)/);
  assert.doesNotMatch(final, /Ок, поставил/);
  assert.equal(await fs.readFile(f.actionFile, 'utf8'), previous);
});

for (const provider of ['claude', 'codex']) {
  test(provider + ' receives the old recurring marker protocol and can register from a normal turn', async t => {
    const f = await mcpFixture(t, provider, { runTurn: runAgentTurn });
    const native = await nativeFixtures(f);
    process.env.AUTONOMY_ENABLED = '1';
    await saveState({ ...(await loadState()).state, chatId: 42, userId: 42 });
    await native.respond(marker(recurring('0 9 * * *')));
    await f.message('Каждый день в 9 напоминай проверить почту');
    await until(() => f.edits.some(text => text.includes('⏱')), 'controlled CLI turn must finish', 10_000);
    const call = (await native.trace()).at(-1);
    const prompt = provider === 'claude' ? call.argv[call.argv.indexOf('--append-system-prompt') + 1] : call.prompt;
    assert.match(prompt, /\[SCHEDULE_TASK\].*"kind":"recurring".*"kind":"reminder"/);
    assert.match(prompt, /не чаще раза в час/);
    assert.ok(f.edits.some(text => text.includes('Ок, поставил:')));
    const file = path.join(path.dirname(sessionDir()), 'actions.json');
    const [entry] = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(entry.trigger.kind, 'cron');
    assert.equal(entry.trigger.cron, '0 9 * * *');
  });
}
