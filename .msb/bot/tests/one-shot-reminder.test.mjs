/**
 * Old conversational once/reminder through the real Telegram and scheduler seams.
 * Old blob 73aa9e7e850bad7ac1ea8a8091d086ecbfd47a11: 24626–24644 (prompt),
 * 106646–106703 / 26729–26748 (final marker), 23002–23064 (action),
 * 36114–36118 / 37005–37036 (CC delivery). Fake model and Telegram only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startScheduler } from '../src/autonomy/scheduler.mjs';
import { listTasks } from '../src/autonomy/store.mjs';
import { sessionDir } from '../src/paths.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { fixture } from './helpers/menu-fixture.mjs';

const time = Date.parse('2026-11-08T10:00:00.000Z');
const scheduledAt = '2026-11-08T10:30:00.000Z';
const chat = -100321;
const ownerChat = -100777;
const body = { trigger: { kind: 'once', at: '+30m' }, task: { kind: 'reminder', text: '  Проверить почту <входящие>  ' } };
const marker = (value = body) => '[SCHEDULE_TASK]' + JSON.stringify(value) + '[/SCHEDULE_TASK]';

async function until(check, label) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(label);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function reminderFixture(t, { output = marker(), enabled = '1', engine = 'cc' } = {}) {
  let clock = time;
  const modelCalls = [];
  const f = await fixture(t, async args => {
    modelCalls.push(args);
    return typeof output === 'function' ? output(args) : { ok: true, text: output };
  }, { overlay: false, runtimeProfile: 'jar1', now: () => clock });
  for (const key of ['MSB_SESSION_DIR', 'IIA_SESSION_DIR', 'AUTONOMY_DIR', 'AUTONOMY_MAX_ACTIONS']) delete process.env[key];
  if (enabled === undefined) delete process.env.AUTONOMY_ENABLED;
  else process.env.AUTONOMY_ENABLED = enabled;
  await saveState({ ...(await loadState()).state, engine, chatId: ownerChat, userId: 42, timezone: 'Europe/Moscow' });
  const directory = path.dirname(sessionDir());
  const actionFile = path.join(directory, 'actions.json');
  const schedules = path.join(directory, 'schedules.json');
  const sent = [];
  const originalSend = f.bot.api.sendMessage;
  f.bot.api.sendMessage = async (destination, text, ...rest) => {
    sent.push({ destination, text, options: rest[0] });
    return originalSend(destination, text, ...rest);
  };
  function scheduler() {
    const instance = startScheduler({ api: f.bot.api, adminId: 42, timezone: 'Europe/Moscow',
      scheduledTurns: f.bot[Symbol.for('msb.scheduledTurns')], now: () => clock,
      log() {}, runTurn: async () => assert.fail('Direct reminders must not invoke the interval model'),
    });
    t.after(() => instance.stop());
    return instance;
  }
  let messageId = 42;
  async function request(text, userId = 42) {
    await f.bot.handleUpdate({ message: { message_id: ++messageId, text, from: { id: userId },
      chat: { id: chat }, message_thread_id: 17 } });
  }
  async function final() {
    await until(() => f.edits.some(text => text.includes('⏱')), 'final Telegram edit missing');
    return f.edits.find(text => text.includes('⏱'));
  }
  return { ...f, actionFile, schedules, directory, modelCalls, sent, scheduler, request, final,
    setTime(value) { clock = value; },
    records: async () => JSON.parse(await fs.readFile(actionFile, 'utf8')),
    delivered: () => sent.filter(row => row.text.startsWith('⏰ ')),
  };
}

test('once reminder from the final answer survives restart and delivers literal text to the saved owner chat', async t => {
  const f = await reminderFixture(t, { output: 'Принял.\n\n' + marker() + '\n\nСледом проверю списки.' });
  await f.request('Напомни через 30 минут проверить почту');
  const final = await f.final();
  assert.match(final, /Принял\./);
  assert.match(final, /Ок, поставил: «Напоминание: Проверить почту &lt;входящие&gt;» — сегодня в 13:30 \(МСК\), через 30 минут\./);
  assert.match(final, /Следом проверю списки\./);
  assert.doesNotMatch(final, /SCHEDULE_TASK/);
  const [action] = await f.records();
  assert.deepEqual(action.trigger, { kind: 'once', at: scheduledAt });
  assert.deepEqual(action.task, { kind: 'reminder', text: 'Проверить почту <входящие>' });
  assert.deepEqual(action.origin, { chatId: chat, threadId: 17 });
  assert.equal(action.output.deliverTo.chatId, chat);
  assert.equal(action.requiresApproval, false);
  assert.equal(action.capability, 'none');
  assert.equal(action.enabled, true);
  assert.deepEqual(await listTasks(), []);
  await assert.rejects(fs.stat(f.schedules), { code: 'ENOENT' });

  const first = f.scheduler();
  f.setTime(Date.parse(scheduledAt) - 1);
  await first.tickNow();
  assert.deepEqual(f.delivered(), []);
  await first.stop();
  const restarted = f.scheduler();
  f.setTime(Date.parse(scheduledAt));
  await restarted.tickNow();
  await restarted.tickNow();
  assert.deepEqual(f.delivered(), [{ destination: ownerChat, text: '⏰ Проверить почту <входящие>', options: undefined }]);
  assert.equal(f.modelCalls.length, 1);
  const [spent] = await f.records();
  assert.equal(spent.enabled, false);
  assert.equal(spent.disabledReason, 'spent_once');
  assert.equal(spent.lastRunAt, scheduledAt);
  assert.equal(spent.lastStatus, 'ok');
});

test('an incoming example marker remains model input and creates no 24-hour interval task', async t => {
  const f = await reminderFixture(t, { output: 'Показываю пример.' });
  await f.request('Объясни этот пример: ' + marker());
  assert.deepEqual(await listTasks(), []);
  await f.final();
  assert.equal(f.modelCalls.length, 1);
  assert.match(f.modelCalls[0].prompt, /Объясни этот пример/);
  await assert.rejects(fs.stat(f.actionFile), { code: 'ENOENT' });
});

test('invalid reminder markers report the old reasons and keep the surrounding response', async t => {
  const invalidTime = marker({ ...body, trigger: { kind: 'once', at: 'когда-нибудь' } });
  const missingText = marker({ ...body, task: { kind: 'reminder', text: ' ' } });
  const f = await reminderFixture(t, { output: 'До.\n[SCHEDULE_TASK]{bad[/SCHEDULE_TASK]\n' + invalidTime + '\n' + missingText + '\nПосле.' });
  await f.request('Проверь три примера');
  const final = await f.final();
  assert.match(final, /До\./);
  assert.match(final, /Не понял задачу — повтори, пожалуйста/);
  assert.match(final, /Не получилось: не понял время «когда-нибудь»/);
  assert.match(final, /Не получилось: для напоминания нужен текст/);
  assert.match(final, /После\./);
  assert.match(final, /⚠ Не выполнено/);
  assert.doesNotMatch(final, /SCHEDULE_TASK/);
  await assert.rejects(fs.stat(f.actionFile), { code: 'ENOENT' });
});

test('disabled autonomy refuses the assistant marker without creating an action', async t => {
  const f = await reminderFixture(t, { enabled: '0' });
  await f.request('Напомни через 30 минут');
  const final = await f.final();
  assert.match(final, /Автономные задачи сейчас выключены\./);
  assert.doesNotMatch(final, /Ок, поставил|SCHEDULE_TASK/);
  await assert.rejects(fs.stat(f.actionFile), { code: 'ENOENT' });
});

test('failed action persistence does not confirm creation or replace existing bytes', async t => {
  const f = await reminderFixture(t);
  await fs.writeFile(f.actionFile, '{"preserve":');
  await f.request('Напомни через 30 минут');
  const final = await f.final();
  assert.match(final, /Не удалось поставить задачу/);
  assert.doesNotMatch(final, /Ок, поставил|SCHEDULE_TASK/);
  assert.equal(await fs.readFile(f.actionFile, 'utf8'), '{"preserve":');
});
