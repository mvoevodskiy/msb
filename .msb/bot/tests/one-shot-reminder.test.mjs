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
import { runAgentTurn } from '../src/agent/turn.mjs';
import { startScheduler } from '../src/autonomy/scheduler.mjs';
import { listTasks } from '../src/autonomy/store.mjs';
import { sessionDir } from '../src/paths.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { fixture } from './helpers/menu-fixture.mjs';
import { mcpFixture } from './helpers/mcp-fixture.mjs';
import { nativeFixtures } from './helpers/mcp-launch-fixture.mjs';

const time = Date.parse('2026-11-08T10:00:00.000Z');
const scheduledAt = '2026-11-08T10:30:00.000Z';
const chat = -100321;
const ownerChat = -100777;
const body = { trigger: { kind: 'once', at: '+30m' }, task: { kind: 'reminder', text: '  Проверить почту <входящие>  ' } };
const marker = (value = body) => '[SCHEDULE_TASK]' + JSON.stringify(value) + '[/SCHEDULE_TASK]';

async function until(check, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(label);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function reminderFixture(t, { output = marker(), enabled = '1', engine = 'cc', bound = true } = {}) {
  let clock = time;
  const modelCalls = [];
  const f = await fixture(t, async args => {
    modelCalls.push(args);
    const { state } = await loadState();
    const turn = typeof output === 'function' ? await output(args) : { ok: true, text: output };
    return { ...turn, ...(state.engine === 'cc' ? { reminderRail: 'cc' } : {}) };
  }, { overlay: false, runtimeProfile: 'jar1', now: () => clock });
  for (const key of ['MSB_SESSION_DIR', 'IIA_SESSION_DIR', 'AUTONOMY_DIR', 'AUTONOMY_MAX_ACTIONS']) delete process.env[key];
  if (enabled === null) delete process.env.AUTONOMY_ENABLED;
  else process.env.AUTONOMY_ENABLED = enabled;
  await saveState({ ...(await loadState()).state, engine, ...(bound ? { chatId: ownerChat, userId: 42 } : {}), timezone: 'Europe/Moscow' });
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

test('a marker without an owner delivery binding reports the old collector refusal', async t => {
  const f = await reminderFixture(t, { bound: false });
  await f.request('Напомни');
  assert.match(await f.final(), /некому вернуть результат/);
  assert.equal(f.modelCalls[0].reminderOwner, 42);
  await assert.rejects(fs.stat(f.actionFile), { code: 'ENOENT' });
});

test('an OpenClaw result remains outside the local runner after switching to CC', async t => {
  const f = await reminderFixture(t, { engine: 'oc', output: async () => {
    await saveState({ ...(await loadState()).state, engine: 'cc' });
    return { ok: true, text: marker() };
  } });
  await f.request('Напомни');
  assert.match(await f.final(), /на этом движке пока не подключены/);
  await assert.rejects(fs.stat(f.actionFile), { code: 'ENOENT' });
});

test('activation flags and per-bot STOP preserve a due reminder until the pause is lifted', async t => {
  const f = await reminderFixture(t, { enabled: null });
  const autonomy = path.join(f.directory, 'autonomy');
  const stop = path.join(autonomy, 'STOP');
  const remote = path.join(f.directory, 'remote-config.json');
  await fs.mkdir(autonomy);
  await fs.writeFile(remote, JSON.stringify({ autonomyAutoOnCc: true, autonomyGlobalStop: true }));
  await fs.writeFile(stop, '');
  await f.request('Напомни');
  assert.match(await f.final(), /Но сейчас задачи на паузе/);
  const scheduler = f.scheduler();
  f.setTime(Date.parse(scheduledAt));
  await scheduler.tickNow();
  assert.deepEqual(f.delivered(), []);
  assert.equal((await f.records())[0].lastRunAt, undefined);
  await fs.unlink(stop);
  await scheduler.tickNow();
  assert.deepEqual(f.delivered(), []);
  await fs.writeFile(remote, JSON.stringify({ autonomyAutoOnCc: true }));
  await scheduler.tickNow();
  assert.equal(f.delivered().length, 1);
});

test('a per-bot disabled flag overrides automatic enablement and corrects a false success claim', async t => {
  const f = await reminderFixture(t, { enabled: null, output: 'Поставил.\\n' + marker() });
  const autonomy = path.join(f.directory, 'autonomy');
  await fs.mkdir(autonomy);
  await fs.writeFile(path.join(autonomy, 'config.json'), JSON.stringify({ enabled: false }));
  await fs.writeFile(path.join(f.directory, 'remote-config.json'), JSON.stringify({ autonomyAutoOnCc: true }));
  await f.request('Напомни');
  const final = await f.final();
  assert.match(final, /Автономные задачи сейчас выключены/);
  assert.match(final, /Тут я поторопился с обещанием/);
  assert.doesNotMatch(final, /Поставил\./);
  await assert.rejects(fs.stat(f.actionFile), { code: 'ENOENT' });
});

test('quoted examples stay inert and two ordinary blocks from one turn keep distinct IDs', async t => {
  const second = marker({ name: 'Второе', trigger: { kind: 'once', at: '2026-11-08T15:30:00+03:00' },
    task: { kind: 'reminder', text: 'Текст второго' } });
  const ticks = String.fromCharCode(96).repeat(3);
  const f = await reminderFixture(t, { output: [
    'Пример:', ticks, marker(), ticks, '> ' + marker(),
    '<code>' + marker() + '</code>', marker(), second,
  ].join('\n') });
  await f.request('Поставь два напоминания');
  const final = await f.final();
  assert.match(final, /Пример:/);
  const actions = await f.records();
  assert.equal(actions.length, 2);
  assert.notEqual(actions[0].id, actions[1].id);
  assert.equal(actions[1].name, 'Второе');
  assert.equal(actions[1].trigger.at, '2026-11-08T12:30:00.000Z');
});

test('the existing tasks menu opens, pauses, resumes and removes an ordinary reminder', async t => {
  const f = await reminderFixture(t);
  await f.request('Напомни');
  await f.final();
  const [action] = await f.records();
  const buttons = () => f.editOptions.at(-1).reply_markup.inline_keyboard.flat();
  await f.callback('auto:tasks');
  assert.match(f.edits.at(-1), /✔ <b>Напоминание: Проверить почту &lt;входящие&gt;<\/b> \(напоминание\)/);
  assert.equal(buttons().find(b => b.text.startsWith('✔')).callback_data, 'auto:task:' + action.id);
  await f.callback('auto:task:' + action.id);
  assert.match(f.edits.at(-1), /Вид: напоминание\nСтатус: ✔ работает/);
  assert.match(f.edits.at(-1), /Что делает: <i>Проверить почту &lt;входящие&gt;<\/i>/);
  assert.equal(buttons().find(b => b.text === '⏸ Выключить').callback_data, 'auto:task-toggle:' + action.id);
  await f.callback('auto:task-toggle:' + action.id, 99);
  assert.equal((await f.records())[0].enabled, true);
  await f.callback('auto:task-toggle:' + action.id);
  assert.equal((await f.records())[0].disabledReason, 'owner');
  const scheduler = f.scheduler();
  f.setTime(Date.parse(scheduledAt));
  await scheduler.tickNow();
  assert.deepEqual(f.delivered(), []);
  await f.callback('auto:task:' + action.id);
  assert.equal(buttons().find(b => b.text === '▶️ Включить').callback_data, 'auto:task-toggle:' + action.id);
  await f.callback('auto:task-toggle:' + action.id);
  assert.equal((await f.records())[0].enabled, true);
  await f.callback('auto:task-delete:' + action.id);
  assert.deepEqual(await f.records(), []);
  await scheduler.tickNow();
  assert.deepEqual(f.delivered(), []);
});

test('a direct send failure consumes only its own ordinary record and appears in history', async t => {
  const f = await reminderFixture(t);
  await f.request('Напомни');
  await f.final();
  const [pending] = await f.records();
  const mapped = { ...pending, id: 'native-mapped' };
  const native = { ...pending, id: 'native-runner', runner: 'oc' };
  const migrated = { ...pending, id: 'native-migrated', migratedToOc: true };
  const followUp = { ...pending, id: 'later-with-confirmation', task: { ...pending.task, followUp: {} } };
  const killed = { ...pending, id: 'killed', budget: { killSwitch: true } };
  await fs.writeFile(f.actionFile, JSON.stringify([pending, mapped, native, migrated, followUp, killed]));
  const autonomy = path.join(f.directory, 'autonomy');
  await fs.mkdir(autonomy);
  await fs.writeFile(path.join(autonomy, 'cron-jobs.json'), JSON.stringify({ 'native-mapped': { jobId: 'keep' } }));
  const send = f.bot.api.sendMessage;
  let attempts = 0;
  f.bot.api.sendMessage = async (...args) => {
    if (!args[1].startsWith('⏰ ')) return send(...args);
    attempts++;
    throw new Error('fixture secret must not be logged');
  };
  f.setTime(Date.parse(scheduledAt));
  // Separate scheduler instances simulate a restart or concurrent polling.
  const first = f.scheduler();
  const second = f.scheduler();
  await Promise.all([first.tickNow(), second.tickNow()]);
  await second.tickNow();
  assert.equal(attempts, 1);
  const [spent, ...unchanged] = await f.records();
  assert.equal(spent.lastStatus, 'error');
  assert.equal(spent.disabledReason, 'spent_once');
  assert.deepEqual(unchanged, [mapped, native, migrated, followUp, killed]);
  const log = (await fs.readFile(path.join(autonomy, 'runs.jsonl'), 'utf8')).trim();
  assert.doesNotMatch(log, /fixture secret/);
  assert.deepEqual(JSON.parse(log), { ts: scheduledAt, actionId: pending.id, kind: 'reminder', name: pending.name,
    status: 'error', costUsd: 0, costVisible: true, format: 'tg-message', detail: 'не удалось отправить напоминание' });
  await f.callback('auto:history');
  assert.match(f.edits.at(-1), /ошибка: не удалось отправить напоминание/);
});

test('an owner stop before the model returns leaves no reminder', async t => {
  let finishModel;
  const f = await reminderFixture(t, { output: () => new Promise(resolve => { finishModel = resolve; }) });
  await f.request('Напомни');
  await until(() => Boolean(finishModel), 'the controlled turn must be running');
  await f.request('/stop');
  finishModel({ ok: true, text: marker() });
  await until(() => f.edits.some(text => text.includes('Моя остановочка')), 'the turn must finish as stopped');
  assert.equal(f.modelCalls[0].signal.aborted, true);
  await assert.rejects(fs.stat(f.actionFile), { code: 'ENOENT' });
});

for (const provider of ['claude', 'codex']) {
  test(provider + ' real turn passes the opted-in reminder protocol through its normal CLI', async t => {
    const f = await mcpFixture(t, provider, { runTurn: runAgentTurn });
    const native = await nativeFixtures(f);
    process.env.AUTONOMY_ENABLED = '1';
    await saveState({ ...(await loadState()).state, chatId: 42, userId: 42 });
    await native.respond(marker());
    await f.message('Напомни через тридцать минут');
    await until(() => f.edits.some(text => text.includes('Ок, поставил:')), 'the controlled turn must confirm the reminder', 10_000);
    const call = (await native.trace()).at(-1);
    const prompt = provider === 'claude' ? call.argv[call.argv.indexOf('--append-system-prompt') + 1] : call.prompt;
    assert.match(prompt, /\[SCHEDULE_TASK\].*"kind":"reminder"/);
    assert.match(prompt, /\[STOP_ALL\].*\[RESUME_ALL\]/s);
    const file = path.join(path.dirname(sessionDir()), 'actions.json');
    const saved = await fs.readFile(file, 'utf8');
    assert.equal(JSON.parse(saved).length, 1);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

    process.env.AUTONOMY_ENABLED = '0';
    await native.respond('autonomy-disabled-fixture');
    const result = await runAgentTurn({ prompt: 'controlled disabled case', reminderOwner: 42 });
    assert.equal(result.ok, true, result.text);
    const disabled = (await native.trace()).at(-1);
    const disabledPrompt = provider === 'claude'
      ? disabled.argv[disabled.argv.indexOf('--append-system-prompt') + 1] : disabled.prompt;
    assert.doesNotMatch(disabledPrompt, /SCHEDULE_TASK|STOP_ALL|RESUME_ALL/);
    assert.equal(await fs.readFile(file, 'utf8'), saved);
  });
}

test('a pending direct send cannot delay an existing saved timer or its next tick', async t => {
  const f = await reminderFixture(t);
  await f.request('Напомни');
  await f.final();
  const send = f.bot.api.sendMessage;
  let finishSend;
  f.bot.api.sendMessage = async (...args) => {
    if (args[1] === '⏰ Проверить почту <входящие>') {
      await new Promise(resolve => { finishSend = resolve; });
    }
    return send(...args);
  };
  const scheduler = f.scheduler();
  f.setTime(Date.parse(scheduledAt));
  const pending = scheduler.tickNow();
  try {
    await until(() => Boolean(finishSend), 'direct send must be pending');
    f.setTime(Date.parse(scheduledAt) + 60_000);
    await fs.writeFile(f.schedules, JSON.stringify([{ id: 'legacy', name: 'Прежний таймер',
      enabled: true, type: 'once', at: new Date(Date.parse(scheduledAt) + 60_000).toISOString(),
      prompt: 'Текст сохранённого таймера' }]));
    const anotherTick = scheduler.tickNow();
    await until(() => f.modelCalls.some(args => args.isAutoTurn && args.prompt.includes('Текст сохранённого таймера')),
      'the later timer must be admitted without waiting for the direct send');
    finishSend();
    await anotherTick;
  } finally {
    finishSend?.();
    await pending;
  }
  assert.equal(f.delivered().filter(row => row.text === '⏰ Проверить почту <входящие>').length, 1);
});
