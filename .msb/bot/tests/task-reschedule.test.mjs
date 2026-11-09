/**
 * Old RESCHEDULE_TASK through the owner turn, Telegram callbacks and
 * [saved action dispatcher](../src/autonomy/reminder-dispatch.mjs).
 * [Old proof](./reference/parity-autonomy-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { actionRoot } from '../src/paths.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { mcpFixture } from './helpers/mcp-fixture.mjs';
import { nativeFixtures } from './helpers/mcp-launch-fixture.mjs';
import { chat, reminderFixture, until } from './helpers/reminder-registration-fixture.mjs';

const now = Date.parse('2026-11-08T10:00:00.000Z');
const prior = '2026-11-07T09:00:00.000Z';
const original = '2026-11-08T11:00:00.000Z';
const twoHours = '2026-11-08T12:00:00.000Z';
const command = (selector, at) => '[RESCHEDULE_TASK: ' + selector + ' | ' + at + ']';
const row = (id, name, fields = {}) => ({
  id, name, enabled: true, trigger: { kind: 'once', at: original },
  task: { kind: 'reminder', text: 'Текст ' + id }, origin: { chatId: -100000, threadId: 8 },
  output: { format: 'tg-message', deliverTo: { chatId: -100000 } }, ...fields,
});
const live = row('Exact-ID', 'Почта');
const request = 'Перенеси фоновую задачу';

function expectedRecord(before, trigger) {
  const result = { ...before, trigger, enabled: true };
  for (const key of ['lastRunAt', 'lastStatus', 'lastOutcome', 'nextFireAt', 'pendingReschedule']) delete result[key];
  if (['owner', 'spent_once'].includes(result.disabledReason)) delete result.disabledReason;
  return result;
}

function withoutRevision({ scheduleRevision, ...record }) {
  return record;
}

async function profile(t, { output = command(live.id, '+2h'), records = [live], enabled } = {}) {
  const f = await reminderFixture(t, { output, enabled });
  const put = rows => fs.writeFile(f.actionFile, JSON.stringify(rows));
  await put(records);
  const autonomy = path.join(f.directory, 'autonomy');
  const jobFile = path.join(autonomy, 'cron-jobs.json');
  const journal = path.join(autonomy, 'runs.jsonl');
  const stop = path.join(autonomy, 'STOP');
  await fs.mkdir(autonomy, { recursive: true });
  await fs.writeFile(journal, '{"fixture":"journal"}\n');
  await fs.writeFile(f.schedules, '[{"id":"legacy","name":"Старый таймер","enabled":false}]\n');
  const bytes = () => Promise.all([journal, f.schedules, f.storeFile].map(file => fs.readFile(file)));
  const before = await bytes();
  const question = () => f.messages.findLastIndex(text => text.startsWith('Перенести фоновую задачу «')) + 1;
  const keyboard = messageId => f.markupEdits.findLast(row => row.messageId === messageId)?.options.reply_markup.inline_keyboard;
  const toast = () => f.callbackAnswers.at(-1)?.[0]?.text;
  const click = (data, { chatId = chat, messageId = question(), uid = 42 } = {}) =>
    f.bot.handleUpdate({ callback_query: { id: 'reschedule-tap', data, from: { id: uid },
      message: { message_id: messageId, chat: { id: chatId }, message_thread_id: 17,
        text: f.messages[messageId - 1] ?? 'Другая карточка' } } });
  const turn = async () => {
    const start = f.edits.length;
    await f.request(request);
    await until(() => f.edits.slice(start).some(text => text.includes('⏱')), 'reschedule reply did not finish');
    return f.edits.slice(start).find(text => text.includes('⏱'));
  };
  return { ...f, put, jobFile, journal, stop, question, keyboard, toast, click, turn,
    untouched: async () => assert.deepEqual(await bytes(), before) };
}

test('exact ID and old before/after card update only on the bound owner tap', async t => {
  const other = row('other', 'Задача с Exact-ID');
  const f = await profile(t, { output: 'Уже перенёс «Почта».\n' + command(live.id, '+2h'), records: [live, other] });
  const before = await fs.readFile(f.actionFile);
  const final = await f.turn();
  const messageId = f.question();
  assert.ok(messageId);
  assert.equal(f.messages[messageId - 1], 'Перенести фоновую задачу «Почта»?\nБыло: сегодня в 14:00 (МСК)\nСтанет: сегодня в 15:00 (МСК)');
  assert.equal(f.messageOptions[messageId - 1].message_thread_id, 17);
  assert.deepEqual(f.keyboard(messageId), [[{ text: 'Перенести ⏱', callback_data: 'rs:Exact-ID' },
    { text: 'Оставить', callback_data: 'ct-keep' }]]);
  assert.match(final, /Спросил подтверждение ниже — перенесу по кнопке/);
  assert.doesNotMatch(final, /^Уже перенёс/);
  assert.deepEqual(await fs.readFile(f.actionFile), before);
  const count = f.callbackAnswers.length;
  await f.click('rs:Exact-ID', { uid: 99 });
  assert.equal(f.callbackAnswers.length, count);
  for (const args of [['rs:Exact-ID', { chatId: 42 }], ['rs:other'], ['rs:Exact-ID', { messageId: messageId + 30 }]]) {
    await f.click(...args);
    assert.equal(f.toast(), 'Подтверждение устарело');
  }
  f.setTime(now + 5 * 60_000);
  await f.click('rs:Exact-ID');
  assert.equal(f.toast(), 'Перенёс');
  assert.match(f.edits.at(-1), /⏱ Перенёс «Почта» — теперь сегодня в 15:00 \(МСК\)/);
  assert.deepEqual(f.editOptions.at(-1).reply_markup.inline_keyboard, []);
  const [changed, neighbor] = await f.records();
  assert.deepEqual(withoutRevision(changed), expectedRecord(live, { kind: 'once', at: twoHours }));
  assert.deepEqual(neighbor, other);
  await f.untouched();
});

test('a spent task moves immediately and the real scheduler delivers exactly once at its new time', async t => {
  const old = row('spent', 'История', { enabled: false, disabledReason: 'spent_once', lastRunAt: prior,
    lastStatus: 'error', lastOutcome: 'engine_error', lastError: 'fixture old error',
    nextFireAt: prior, pendingReschedule: { trigger: { kind: 'once', at: prior } },
    trigger: { kind: 'once', at: prior }, budget: { usdPerRun: 7 }, authority: { profile: 'narrow' } });
  const f = await profile(t, { output: command('текст spent', '+30 mins trailing'), records: [old] });
  assert.match(await f.turn(), /Перенёс: «История» — теперь сегодня в 13:30 \(МСК\), через 30 минут/);
  assert.equal(f.question(), 0);
  const at = '2026-11-08T10:30:00.000Z';
  const [changed] = await f.records();
  assert.deepEqual(withoutRevision(changed), expectedRecord(old, { kind: 'once', at }));
  await f.untouched();
  const scheduler = f.scheduler();
  f.setTime(Date.parse(at) - 1000);
  await scheduler.tickNow();
  assert.deepEqual(f.delivered(), []);
  f.setTime(Date.parse(at));
  await scheduler.tickNow();
  await scheduler.tickNow();
  assert.deepEqual(f.delivered().map(item => item.text), ['⏰ Текст spent']);
  assert.match(await fs.readFile(f.journal, 'utf8'), /"actionId":"spent"/);
});

test('a disabled owner task uses the old direct day unit and leaves global STOP in force', async t => {
  const old = row('paused', 'На паузе', { enabled: false, disabledReason: 'owner' });
  const f = await profile(t, { output: command(old.id, '+1 day'), records: [old] });
  await fs.writeFile(f.stop, 'owner STOP fixture');
  assert.match(await f.turn(), /Перенёс: «На паузе» — теперь завтра в 13:00/);
  assert.equal(f.question(), 0);
  const [changed] = await f.records();
  assert.deepEqual(withoutRevision(changed), expectedRecord(old, { kind: 'once', at: '2026-11-09T10:00:00.000Z' }));
  assert.equal(await fs.readFile(f.stop, 'utf8'), 'owner STOP fixture');
  f.setTime(Date.parse(changed.trigger.at));
  await f.scheduler().tickNow();
  assert.deepEqual(f.delivered(), []);
  await f.untouched();
});

for (const [at, iso] of [['+0m', '2026-11-08T10:00:00.000Z'], ['2026-11-07T13:30:00+03:00', '2026-11-07T10:30:00.000Z']]) {
  test('a disabled task accepts a due time and retains its separate gates for ' + at, async t => {
    const old = row('system', 'Ограниченная', { enabled: false, disabledReason: 'frequency', budget: { killSwitch: true } });
    const f = await profile(t, { output: command(old.id, at), records: [old] });
    assert.match(await f.turn(), /Перенёс: «Ограниченная»/);
    assert.equal(f.question(), 0);
    const [changed] = await f.records();
    assert.deepEqual(withoutRevision(changed), expectedRecord(old, { kind: 'once', at: iso }));
    await f.scheduler().tickNow();
    assert.deepEqual(f.delivered(), []);
    await f.untouched();
  });
}

test('SHOW_TASK reads the old schedule before the move, and cron executes in the owner zone', async t => {
  const f = await profile(t, { output: command(live.id, '0 9 * * *') + '\n[SHOW_TASK: Exact-ID]' });
  const final = await f.turn();
  const messageId = f.question();
  assert.ok(messageId);
  assert.match(final, /сегодня в 14:00 \(МСК\)/);
  assert.match(f.messages[messageId - 1], /Станет: каждый день в 09:00 \(МСК\) · следующее завтра в 09:00 \(МСК\)/);
  await f.click('rs:Exact-ID');
  assert.equal(f.toast(), 'Перенёс');
  const [changed] = await f.records();
  assert.deepEqual(changed.trigger, { kind: 'cron', cron: '0 9 * * *', timezone: 'Europe/Moscow' });
  const scheduler = f.scheduler();
  f.setTime(Date.parse('2026-11-09T05:59:00.000Z'));
  await scheduler.tickNow();
  assert.deepEqual(f.delivered(), []);
  f.setTime(Date.parse('2026-11-09T06:00:00.000Z'));
  await scheduler.tickNow();
  await scheduler.tickNow();
  assert.deepEqual(f.delivered().map(item => item.text), ['⏰ Текст Exact-ID']);
});

for (const [output, reason] of [
  ['[RESCHEDULE_TASK: Exact-ID]', /Не понял, что и на когда переносить/],
  [command('', '+2h'), /Уточни, какую задачу перенести/],
  [command('Exact-ID', ''), /Уточни, на когда перенести/],
  [command('Exact-ID', 'when I get home'), /Перенести не смог: не понял время/],
  [command('Exact-ID', '0 55 * * *'), /Перенести не смог: для регулярной задачи нужен корректный cron/],
  [command('Exact-ID', '0-4 9 * * *'), /Перенести не смог: слишком часто/],
  [command('Почта', '+2h'), /Нашёл несколько — уточни/],
]) {
  test('refuses invalid or ambiguous reschedule without editing the record ' + output, async t => {
    const f = await profile(t, { output: 'Уже перенёс «Почта».\n' + output, records: [live, row('second', 'Почта вечером')] });
    const before = await fs.readFile(f.actionFile);
    const final = await f.turn();
    assert.match(final, reason);
    assert.doesNotMatch(final, /^Уже перенёс/);
    assert.equal(f.question(), 0);
    assert.deepEqual(await fs.readFile(f.actionFile), before);
    await f.untouched();
  });
}

test('a newer question supersedes the old card and Keep retires only the shown offer', async t => {
  let reply = command(live.id, '+2h');
  const f = await profile(t, { output: () => ({ ok: true, text: reply }) });
  await f.turn();
  const first = f.question();
  assert.ok(first);
  reply = command(live.id, '+3h');
  await f.turn();
  const second = f.question();
  assert.ok(second > first);
  await f.click('rs:Exact-ID', { messageId: first });
  assert.equal(f.toast(), 'Подтверждение устарело');
  await f.click('ct-keep', { messageId: second });
  assert.equal(f.toast(), 'Оставил');
  assert.match(f.edits.at(-1), /✔ Оставил на месте/);
  await f.click('rs:Exact-ID', { messageId: second });
  assert.equal(f.toast(), 'Подтверждение устарело');
  assert.deepEqual(await f.records(), [live]);
  await f.untouched();
});

test('a replacement definition and a new native map both invalidate the approved local move', async t => {
  const f = await profile(t);
  await f.turn();
  assert.ok(f.question());
  const replacement = { ...live, task: { ...live.task, text: 'Новое содержание' } };
  await f.put([replacement]);
  await f.click('rs:Exact-ID');
  assert.equal(f.toast(), 'Подтверждение устарело');
  await f.turn();
  assert.ok(f.question());
  const jobs = '{"Exact-ID":{"jobId":"foreign-job","enabled":true}}';
  await fs.writeFile(f.jobFile, jobs);
  await f.click('rs:Exact-ID');
  assert.match(f.toast(), /перенос.*недоступен|подтверждение устарело/i);
  assert.equal(await fs.readFile(f.jobFile, 'utf8'), jobs);
  assert.deepEqual(await f.records(), [replacement]);
  await f.untouched();
});

test('a running one-off may finish without overwriting the newly confirmed schedule', async t => {
  const old = row('running', 'Первый запуск', { trigger: { kind: 'once', at: '2026-11-08T10:05:00.000Z' } });
  const f = await profile(t, { output: command(old.id, '+2h'), records: [old] });
  await f.turn();
  assert.ok(f.question());
  const send = f.bot.api.sendMessage;
  const held = Promise.withResolvers();
  let waiting = false;
  f.bot.api.sendMessage = async (chatId, text, ...options) => {
    if (text === '⏰ Текст running' && !waiting) {
      waiting = true;
      await held.promise;
    }
    return send(chatId, text, ...options);
  };
  const scheduler = f.scheduler();
  f.setTime(now + 5 * 60_000);
  const tick = scheduler.tickNow();
  try {
    await until(() => waiting, 'old claimed send did not reach Telegram');
    assert.equal((await f.records())[0].disabledReason, 'spent_once');
    await f.click('rs:running');
    assert.equal(f.toast(), 'Перенёс');
    assert.deepEqual(withoutRevision((await f.records())[0]), expectedRecord(old, { kind: 'once', at: twoHours }));
  } finally {
    held.resolve();
    await tick;
  }
  assert.deepEqual(withoutRevision((await f.records())[0]), expectedRecord(old, { kind: 'once', at: twoHours }));
  assert.match(await fs.readFile(f.journal, 'utf8'), /"actionId":"running"/);
  await scheduler.tickNow();
  assert.equal(f.delivered().length, 1);
  f.setTime(Date.parse(twoHours));
  await scheduler.tickNow();
  assert.equal(f.delivered().length, 2);
});

test('failed publication leaves the old schedule and the same card can retry', async t => {
  const f = await profile(t);
  await f.turn();
  assert.ok(f.question());
  const file = await fs.realpath(f.actionFile);
  const rename = fs.rename;
  let refuse = true;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (refuse && to === file) throw new Error('fixture action publish failed');
    return rename(from, to);
  });
  await f.click('rs:Exact-ID');
  assert.match(f.toast(), /Не смог перенести/);
  assert.deepEqual(await f.records(), [live]);
  refuse = false;
  await f.click('rs:Exact-ID');
  assert.equal(f.toast(), 'Перенёс');
  assert.deepEqual(withoutRevision((await f.records())[0]), expectedRecord(live, { kind: 'once', at: twoHours }));
  await f.untouched();
});

test('changing the owner zone makes an old cron preview stale', async t => {
  const f = await profile(t, { output: command(live.id, '0 9 * * *') });
  await f.turn();
  assert.ok(f.question());
  await saveState({ ...(await loadState()).state, timezone: 'Europe/Berlin' });
  await f.click('rs:Exact-ID');
  assert.equal(f.toast(), 'Подтверждение устарело');
  assert.deepEqual(await f.records(), [live]);
});

test('quoted, nested and unterminated reschedule text cannot move or pause tasks', async t => {
  const f = await profile(t, { output: 'Пример "' + command(live.id, '+2h') + '".\n' +
    '[RESCHEDULE_TASK: [STOP_ALL]\n' + '[RESCHEDULE_TASK: [CANCEL_TASK: Exact-ID] | +2h]' });
  const final = await f.turn();
  assert.doesNotMatch(final, /Автономка остановлена|Спросил подтверждение ниже/);
  assert.equal(f.question(), 0);
  await assert.rejects(fs.stat(f.stop), { code: 'ENOENT' });
  assert.deepEqual(await f.records(), [live]);
  await f.untouched();
});

for (const provider of ['claude', 'codex']) {
  test(provider + ' native prompt includes the old reschedule instruction and reaches the owner card', async t => {
    const f = await mcpFixture(t, provider, { runTurn: runAgentTurn });
    const native = await nativeFixtures(f);
    process.env.AUTONOMY_ENABLED = '1';
    const file = path.join(actionRoot(), 'actions.json');
    const before = JSON.stringify([live]);
    await fs.writeFile(file, before);
    await native.respond(command(live.id, '+2h'));
    await f.message(request);
    await until(() => f.edits.some(text => text.includes('⏱')), 'provider did not finish', 10_000);
    const call = (await native.trace()).at(-1);
    const prompt = provider === 'claude' ? call.argv[call.argv.indexOf('--append-system-prompt') + 1] : call.prompt;
    assert.match(prompt, /\[RESCHEDULE_TASK:/);
    assert.match(f.edits.at(-1), /Спросил подтверждение ниже — перенесу по кнопке/);
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.ok(f.markupEdits.some(item => item.options.reply_markup.inline_keyboard[0]?.[0]?.callback_data === 'rs:Exact-ID'));
  });
}
