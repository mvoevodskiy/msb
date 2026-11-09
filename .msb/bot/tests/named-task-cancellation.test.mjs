/**
 * Old CANCEL_TASK from the [owner reply](../src/telegram/bot.mjs) and its
 * delivered [callback](../src/telegram/router.mjs). [Reference](./reference/parity-autonomy-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { actionRoot } from '../src/paths.mjs';
import { createBot } from '../src/telegram/bot.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { mcpFixture } from './helpers/mcp-fixture.mjs';
import { nativeFixtures } from './helpers/mcp-launch-fixture.mjs';
import { chat, reminderFixture, until } from './helpers/reminder-registration-fixture.mjs';

const runAt = '2026-11-07T09:00:00.000Z';
const request = 'Отмени фоновую задачу';
const cancel = query => '[CANCEL_TASK: ' + query + ']';
const live = (id, name, extra = {}) => ({
  id, name, enabled: true, trigger: { kind: 'interval', intervalMinutes: 60 },
  task: { kind: 'reminder', text: 'Содержание ' + id }, ...extra,
});
const done = (id, name, extra = {}) => live(id, name, {
  trigger: { kind: 'once', at: runAt }, lastRunAt: runAt, lastOutcome: 'ok', ...extra,
});

async function profile(t, { output, records, ...options }) {
  const f = await reminderFixture(t, { output, ...options });
  const put = rows => fs.writeFile(f.actionFile, JSON.stringify(rows));
  await put(records);
  const autonomy = path.join(f.directory, 'autonomy');
  await fs.mkdir(autonomy, { recursive: true });
  const jobFile = path.join(autonomy, 'cron-jobs.json');
  const journal = path.join(autonomy, 'runs.jsonl');
  await fs.writeFile(journal, '{"fixture":"saved journal"}\n');
  await fs.writeFile(f.schedules, '[]\n');
  const stable = [journal, f.schedules, f.storeFile];
  const bytes = () => Promise.all(stable.map(file => fs.readFile(file)));
  const before = await bytes();
  const question = () => f.messages.findLastIndex(text => text.startsWith('Снести фоновую задачу «')) + 1;
  const keyboard = () => f.markupEdits.findLast(row => row.messageId === question())?.options.reply_markup.inline_keyboard;
  const toast = () => f.callbackAnswers.at(-1)?.[0]?.text;
  const click = (data, { bot = f.bot, chatId = chat, messageId = question(), uid = 42 } = {}) =>
    bot.handleUpdate({ callback_query: { id: 'named-cancel-tap', data, from: { id: uid },
      message: { message_id: messageId, chat: { id: chatId }, message_thread_id: 17,
        text: f.messages[messageId - 1] ?? 'Другая карточка' } } });
  const ask = async () => {
    await f.request(request);
    await f.final();
    return question();
  };
  return { ...f, put, jobFile, question, keyboard, toast, click, ask, untouched: async () => assert.deepEqual(await bytes(), before) };
}

test('the exact live ID wins and its bound old buttons delete only after the owner confirms', async t => {
  const exact = live('Exact-ID', 'Точная задача');
  const other = live('other', 'В имени Exact-ID');
  const f = await profile(t, { output: 'Уже снёс «Точная задача».\n' + cancel('Exact-ID'), records: [exact, other] });
  const before = await fs.readFile(f.actionFile);
  const messageId = await f.ask();
  assert.ok(messageId);
  assert.match(f.messages[messageId - 1], /^Снести фоновую задачу «Точная задача»\?\nСработает каждые 60 мин.*Снос необратим\.$/);
  assert.equal(f.messageOptions[messageId - 1].message_thread_id, 17);
  assert.deepEqual(f.keyboard(), [[{ text: 'Снести ✖', callback_data: 'ct:Exact-ID' },
    { text: 'Оставить', callback_data: 'ct-keep' }]]);
  const final = await f.final();
  assert.match(final, /Спросил подтверждение ниже — снесу по кнопке/);
  assert.doesNotMatch(final, /^Уже снёс/);
  assert.deepEqual(await fs.readFile(f.actionFile), before);
  const answers = f.callbackAnswers.length;
  await f.click('ct:Exact-ID', { uid: 99 });
  assert.equal(f.callbackAnswers.length, answers);
  await f.click('ct:Exact-ID', { chatId: 42 });
  assert.equal(f.toast(), 'Подтверждение устарело');
  await f.click('ct:other');
  assert.equal(f.toast(), 'Подтверждение устарело');
  await f.click('ct:Exact-ID');
  assert.equal(f.toast(), 'Снёс');
  assert.match(f.edits.at(-1), /✖ Снёс «Точная задача»/);
  assert.deepEqual(f.editOptions.at(-1).reply_markup.inline_keyboard, []);
  assert.deepEqual(await f.records(), [other]);
  await f.untouched();
});

test('Keep binds to the correct card and a restarted bot refuses a replacement under the same ID', async t => {
  const action = live('mail', 'Почта');
  const f = await profile(t, { output: cancel('mail'), records: [action] });
  const original = await f.ask();
  assert.ok(original);
  await f.click('ct-keep', { messageId: original + 30 });
  assert.equal(f.toast(), 'Подтверждение устарело');
  const replacement = { ...action, task: { ...action.task, text: 'Замена содержимого' } };
  await f.put([replacement]);
  const bot = createBot({ botToken: 'fake', botId: 'default', adminId: 42, workspace: f.workspace, timezone: 'Europe/Moscow' }, {
    bot: new f.bot.constructor(), runTurn: () => assert.fail('Callback must not invoke a model'),
  });
  t.after(() => bot.stop());
  await f.click('ct:mail', { bot });
  assert.equal(f.toast(), 'Подтверждение устарело');
  assert.deepEqual(await f.records(), [replacement]);
  const edits = f.edits.length;
  await f.request(request);
  await until(() => f.edits.slice(edits).some(text => text.includes('⏱')), 'new question did not finish');
  assert.ok(f.question() > original);
  await f.click('ct-keep', { bot });
  assert.equal(f.toast(), 'Оставил');
  assert.match(f.edits.at(-1), /✔ Оставил на месте/);
  await f.click('ct:mail', { bot });
  assert.equal(f.toast(), 'Подтверждение устарело');
  assert.deepEqual(await f.records(), [replacement]);
  await f.untouched();
});

test('a legitimate run between the question and tap keeps the same cancellation target', async t => {
  const action = live('run-between', 'Разовое напоминание', { trigger: { kind: 'once', at: runAt } });
  const f = await profile(t, { output: cancel(action.id), records: [action] });
  assert.ok(await f.ask());
  await f.put([{ ...action, enabled: false, disabledReason: 'spent_once', lastRunAt: runAt, lastStatus: 'ok', lastOutcome: 'ok' }]);
  await f.click('ct:' + action.id);
  assert.equal(f.toast(), 'Снёс');
  assert.deepEqual(await f.records(), []);
  await f.untouched();
});

test('long Unicode IDs fit the button and cannot delete another task with the same prefix', async t => {
  const prefix = 'общий-префикс-'.repeat(12);
  const first = live(prefix + 'first', 'Первая');
  const target = live(prefix + 'target', 'Нужная');
  const f = await profile(t, { output: cancel(target.id), records: [first, target] });
  assert.ok(await f.ask());
  const data = f.keyboard()[0][0].callback_data;
  assert.ok(data.startsWith('ct:'));
  assert.ok(Buffer.byteLength(data, 'utf8') <= 64);
  await f.click('ct:' + prefix.slice(0, 20));
  assert.equal(f.toast(), 'Подтверждение устарело');
  await f.click(data);
  assert.equal(f.toast(), 'Снёс');
  assert.deepEqual(await f.records(), [first]);
});

test('one spent task cancels directly even when disabled', async t => {
  const action = done('spent', 'Уже завершилась', { enabled: false, disabledReason: 'spent_once' });
  const f = await profile(t, { output: cancel('spent'), records: [action] });
  assert.equal(await f.ask(), 0);
  assert.match(await f.final(), /Отменил: «Уже завершилась»/);
  assert.deepEqual(await f.records(), []);
  await f.untouched();
});

test('all-spent matches are removed together, including disabled rows, and a mapped row is retained', async t => {
  const first = done('digest-1', 'Архив первый');
  const second = done('digest-2', 'Архив второй', { enabled: false, disabledReason: 'spent_once' });
  const native = done('digest-oc', 'Архив нативный');
  const neighbor = done('neighbor', 'Соседняя задача');
  const f = await profile(t, { output: cancel('АРХИВ'), records: [first, second, native, neighbor] });
  const mapping = '{"digest-oc":{"jobId":"not-owned-proof"}}';
  await fs.writeFile(f.jobFile, mapping);
  assert.equal(await f.ask(), 0);
  const final = await f.final();
  assert.match(final, /Снёс 2[\s\S]*✖ Архив первый[\s\S]*✖ Архив второй/);
  assert.match(final, /Не удалось снять: Архив нативный/);
  assert.deepEqual(await f.records(), [native, neighbor]);
  assert.equal(await fs.readFile(f.jobFile, 'utf8'), mapping);
  await f.untouched();
});

test('mixed matches ask the owner to choose and leave both saved records unchanged', async t => {
  const first = done('spent', 'Вечерняя почта');
  const second = live('active', 'Вечерняя сводка');
  const f = await profile(t, { output: cancel('вечерняя') + '\n' + cancel(' ') + '\n' + cancel('нет совпадений'),
    records: [first, second] });
  assert.equal(await f.ask(), 0);
  const final = await f.final();
  assert.match(final, /Нашёл несколько — скажи, какую именно:[\s\S]*Вечерняя почта — [\s\S]*Вечерняя сводка — каждые 60 мин/);
  assert.match(final, /Уточни, какую задачу отменить/);
  assert.match(final, /Не нашёл задачу «нет совпадений»/);
  assert.deepEqual(await f.records(), [first, second]);
});

test('one cancellation happens after old read markers but before individual pause', async t => {
  const action = done('once', 'История одной');
  const f = await profile(t, { output: '[PAUSE_TASK: once]\n' + cancel('once') + '\n[SHOW_TASK: once]', records: [action] });
  await f.request(request + ' и покажи детали');
  const final = await f.final();
  assert.match(final, /Не нашёл задачу «once»/);
  assert.match(final, /Отменил: «История одной»/);
  assert.match(final, /Текст задачи, дословно/);
  assert.deepEqual(await f.records(), []);
});

test('a natively mapped live task cannot publish a local delete card', async t => {
  const action = live('mapped', 'Нативная');
  const f = await profile(t, { output: cancel('mapped'), records: [action] });
  await fs.writeFile(f.jobFile, '{"mapped":{"jobId":"native-job"}}');
  assert.equal(await f.ask(), 0);
  assert.match(await f.final(), /Не удалось отменить «Нативная»/);
  assert.deepEqual(await f.records(), [action]);
});

test('a changed engine refuses the old card until its captured route is active again', async t => {
  const action = live('local', 'Локальная');
  const f = await profile(t, { output: cancel('local'), records: [action] });
  assert.ok(await f.ask());
  const { state } = await loadState();
  await saveState({ ...state, engine: 'oc' });
  await f.click('ct:local');
  assert.match(f.toast(), /Отмена задач на этом движке пока не подключена/);
  assert.deepEqual(await f.records(), [action]);
  await saveState(state);
  await f.click('ct:local');
  assert.equal(f.toast(), 'Снёс');
  assert.deepEqual(await f.records(), []);
});

for (const provider of ['claude', 'codex']) {
  test(provider + ' Telegram turn advertises CANCEL_TASK and removes an exact spent record', async t => {
    const f = await mcpFixture(t, provider, { runTurn: runAgentTurn });
    const native = await nativeFixtures(f);
    process.env.AUTONOMY_ENABLED = '1';
    const file = path.join(actionRoot(), 'actions.json');
    await fs.writeFile(file, JSON.stringify([done('local', 'Проверяемая отмена')]));
    await native.respond(cancel('local'));
    await f.message(request);
    await until(() => f.edits.some(text => text.includes('⏱')), 'controlled provider did not finish', 10_000);
    const call = (await native.trace()).at(-1);
    const prompt = provider === 'claude' ? call.argv[call.argv.indexOf('--append-system-prompt') + 1] : call.prompt;
    assert.match(prompt, /\[CANCEL_TASK:/);
    assert.match(f.edits.at(-1), /Отменил: «Проверяемая отмена»/);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), []);
  });
}
