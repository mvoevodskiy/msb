/**
 * The old spent-list question through the real [Telegram worker](../src/telegram/bot.mjs)
 * and its [callback router](../src/telegram/router.mjs). All data is disposable.
 * [Readable old contract](./reference/parity-autonomy-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadState, saveState } from '../src/state.mjs';
import { createBot } from '../src/telegram/bot.mjs';
import { chat, reminderFixture, until } from './helpers/reminder-registration-fixture.mjs';

const runAt = '2026-11-07T09:00:00.000Z';
const confirm = 'ct-spent';
const keep = 'ct-keep';
const prefix = 'Убрать из списка ';
const first = finished('first', 'Прежнее напоминание');
const due = { ...finished('due', 'Ещё сработает'), lastRunAt: undefined };

function finished(id, name, extra = {}) {
  return {
    id, name, enabled: true, trigger: { kind: 'once', at: runAt },
    task: { kind: 'reminder', text: 'Содержание ' + id }, lastRunAt: runAt, lastOutcome: 'ok', ...extra,
  };
}

async function profile(t, records, options) {
  const f = await reminderFixture(t, { output: '[LIST_TASKS]', ...options });
  const put = rows => fs.writeFile(f.actionFile, JSON.stringify(rows));
  await put(records);
  const autonomy = path.join(f.directory, 'autonomy');
  await fs.mkdir(autonomy, { recursive: true });
  const jobFile = path.join(autonomy, 'cron-jobs.json');
  const runFile = path.join(autonomy, 'runs.jsonl');
  await fs.writeFile(runFile, JSON.stringify({ actionId: 'first', ts: runAt, status: 'ok', kind: 'reminder' }) + '\n');
  await fs.writeFile(f.schedules, JSON.stringify([{ id: 'other-timer', name: 'Таймер отдельно', enabled: true }]));
  const preservedFiles = [runFile, f.schedules, f.storeFile];
  const preserved = await Promise.all(preservedFiles.map(file => fs.readFile(file)));

  const question = () => f.messages.findLastIndex(text => text.startsWith(prefix)) + 1;
  const toast = () => f.callbackAnswers.at(-1)?.[0]?.text;
  async function ask() {
    const start = f.edits.length;
    await f.request('Покажи список фоновых задач');
    await until(() => f.edits.slice(start).some(text => text.includes('⏱')), 'missing final list');
    return question();
  }
  function click(data, { bot = f.bot, messageId = question(), chatId = chat, uid = 42 } = {}) {
    return bot.handleUpdate({ callback_query: { id: 'cleanup-tap', data, from: { id: uid },
      message: { message_id: messageId, chat: { id: chatId }, message_thread_id: 17,
        text: f.messages[messageId - 1] ?? 'Неподтверждённое сообщение' } } });
  }
  async function untouched() {
    assert.deepEqual(await Promise.all(preservedFiles.map(file => fs.readFile(file))), preserved);
  }
  return { ...f, jobFile, put, question, toast, ask, click, untouched };
}

test('LIST_TASKS opens the old confirmation in the same topic only for the enabled historical once group', async t => {
  const digest = finished('digest', 'Разовый дайджест', { task: { kind: 'digest' } });
  const disabled = finished('off', 'Сохранённый результат', { enabled: false, disabledReason: 'spent_once' });
  const pending = finished('pending', 'Ожидает решения', { pendingConfirm: true });
  const recurring = finished('repeat', 'Регулярная', { trigger: { kind: 'interval', intervalMinutes: 60 } });
  const f = await profile(t, [first, digest, disabled, pending, recurring, due]);
  const before = await fs.readFile(f.actionFile);
  const question = await f.ask();
  assert.ok(question);
  assert.equal(f.messages[question - 1], 'Убрать из списка 2 просроченные? Они уже не сработают.');
  assert.equal(f.messageOptions[question - 1].message_thread_id, 17);
  assert.deepEqual(f.markupEdits.find(row => row.messageId === question)?.options.reply_markup.inline_keyboard, [[
    { text: 'Убрать ✖', callback_data: confirm }, { text: 'Оставить', callback_data: keep },
  ]]);
  assert.deepEqual(await fs.readFile(f.actionFile), before);
  assert.match(await f.final(), /Уже не сработают \(2\)/);
  await f.click(confirm);
  assert.equal(f.toast(), 'Убрал');
  assert.match(f.edits.at(-1), /Снёс 2, они уже не могли сработать:\n✖ Прежнее напоминание\n✖ Разовый дайджест/);
  assert.deepEqual(f.editOptions.at(-1).reply_markup.inline_keyboard, []);
  assert.deepEqual((await f.records()).map(row => row.id), ['off', 'pending', 'repeat', 'due']);
  await f.untouched();
});

test('an empty eligible group never publishes a cleanup card', async t => {
  const f = await profile(t, [
    finished('normal', 'Обычная завершённая', { enabled: false, disabledReason: 'spent_once' }),
    finished('pending', 'Ожидает решения', { pendingConfirm: true }), due,
  ]);
  assert.equal(await f.ask(), 0);
  assert.equal(f.markupEdits.length, 0);
  assert.doesNotMatch(await f.final(), /Уже не сработают/);
  await f.untouched();
});

test('only the configured owner can use a bound cleanup question and Keep consumes it without any task write', async t => {
  const f = await profile(t, [first, due]);
  const before = await fs.readFile(f.actionFile);
  const question = await f.ask();
  assert.ok(question);
  const answers = f.callbackAnswers.length;
  await f.click(confirm, { uid: 99 });
  assert.equal(f.callbackAnswers.length, answers);
  await f.click(confirm, { chatId: 42 });
  assert.equal(f.toast(), 'Подтверждение устарело');
  await f.click(confirm, { messageId: question + 30 });
  assert.equal(f.toast(), 'Подтверждение устарело');
  await f.click(keep);
  assert.equal(f.toast(), 'Оставил');
  assert.match(f.edits.at(-1), /✔ Оставил на месте/);
  assert.deepEqual(f.editOptions.at(-1).reply_markup.inline_keyboard, []);
  await f.click(confirm);
  assert.equal(f.toast(), 'Подтверждение устарело');
  assert.deepEqual(await fs.readFile(f.actionFile), before);
  await f.untouched();
});

test('a restart preserves the confirmation and a stale card cannot remove a replacement or newly spent task', async t => {
  const stable = finished('same', 'Старая неизменившаяся');
  const f = await profile(t, [first, stable, due]);
  const question = await f.ask();
  assert.ok(question);
  const replacement = { ...first, name: 'Новое содержание под тем же ID' };
  const newlyFinished = { ...due, lastRunAt: '2026-11-08T10:00:00.000Z' };
  await f.put([replacement, stable, newlyFinished]);
  const bot = createBot({ botToken: 'fake', botId: 'default', adminId: 42, workspace: f.workspace, timezone: 'Europe/Moscow' }, {
    bot: new f.bot.constructor(), runTurn: () => assert.fail('Confirmation must not invoke a model'),
  });
  t.after(() => bot.stop());
  await f.click(confirm, { bot });
  assert.equal(f.toast(), 'Убрал не всё');
  assert.match(f.edits.at(-1), /Снёс 1.*\n✖ Старая неизменившаяся/);
  assert.deepEqual(await f.records(), [replacement, newlyFinished]);
  await f.click(confirm, { bot });
  assert.equal(f.toast(), 'Подтверждение устарело');
  assert.deepEqual(await f.records(), [replacement, newlyFinished]);
  await f.untouched();
});

test('cleanup rechecks the local route and leaves the question usable after a refused engine switch', async t => {
  const f = await profile(t, [first]);
  assert.ok(await f.ask());
  const { state } = await loadState();
  await saveState({ ...state, engine: 'oc' });
  const before = await fs.readFile(f.actionFile);
  await f.click(confirm);
  assert.match(f.toast(), /Уборка задач на этом движке пока не подключена/);
  assert.deepEqual(await fs.readFile(f.actionFile), before);
  await saveState(state);
  await f.click(confirm);
  assert.equal(f.toast(), 'Убрал');
  assert.deepEqual(await f.records(), []);
  await f.untouched();
});

test('native ownership is checked again at confirmation and native map errors are retryable', async t => {
  const removed = finished('local', 'Вторая локальная');
  const f = await profile(t, [first, removed]);
  assert.ok(await f.ask());
  const corrupt = '{"broken":';
  await fs.writeFile(f.jobFile, corrupt);
  const before = await fs.readFile(f.actionFile);
  await f.click(confirm);
  assert.equal(f.toast(), 'Не смог убрать, попробуй ещё раз');
  assert.deepEqual(await fs.readFile(f.actionFile), before);
  const mapping = '{"first":{"jobId":"external-id","enabled":true}}';
  await fs.writeFile(f.jobFile, mapping);
  await f.click(confirm);
  assert.equal(f.toast(), 'Убрал не всё');
  assert.match(f.edits.at(-1), /Снёс 1[\s\S]*Вторая локальная[\s\S]*Не удалось снять: Прежнее напоминание/);
  assert.deepEqual(await f.records(), [first]);
  assert.equal(await fs.readFile(f.jobFile, 'utf8'), mapping);
  await f.untouched();
});
