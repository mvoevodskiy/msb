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

test('a native-only historical group stays readable without offering a local removal', async t => {
  const f = await profile(t, [first]);
  const mapping = '{"first":{"jobId":"foreign-native","enabled":true}}';
  await fs.writeFile(f.jobFile, mapping);
  assert.equal(await f.ask(), 0);
  assert.match(await f.final(), /Уже не сработают \(1\)[\s\S]*Прежнее напоминание/);
  await f.click(confirm, { messageId: 100 });
  assert.equal(f.toast(), 'Подтверждение устарело');
  assert.deepEqual(await f.records(), [first]);
  assert.equal(await fs.readFile(f.jobFile, 'utf8'), mapping);
});

test('a job map change during the atomic action write preserves the row and the confirmation for retry', async t => {
  const stable = finished('stable', 'Локальная');
  const f = await profile(t, [first, stable]);
  assert.ok(await f.ask());
  const mapping = '{"first":{"jobId":"became-native","enabled":true}}';
  const actionDirectory = path.dirname(await fs.realpath(f.actionFile));
  const write = fs.writeFile;
  let injected = false;
  t.mock.method(fs, 'writeFile', async (file, ...args) => {
    await write(file, ...args);
    if (!injected && path.basename(file) === 'records.json' && path.dirname(path.dirname(file)) === actionDirectory) {
      injected = true;
      await write(f.jobFile, mapping);
    }
  });
  await f.click(confirm);
  assert.ok(injected);
  assert.deepEqual(await f.records(), [first, stable]);
  assert.equal(f.toast(), 'Не смог убрать, попробуй ещё раз');
  await f.click(confirm);
  assert.deepEqual(await f.records(), [first]);
  assert.equal(f.toast(), 'Убрал не всё');
  assert.equal(await fs.readFile(f.jobFile, 'utf8'), mapping);
});

test('a failed action rename does not need a second question write to make retry possible', async t => {
  const f = await profile(t, [first]);
  assert.ok(await f.ask());
  const actionFile = await fs.realpath(f.actionFile);
  const rename = fs.rename;
  let fail = true, actionRefused = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (fail && to === actionFile) {
      actionRefused = true;
      throw new Error('fixture action rename refused');
    }
    if (fail && actionRefused && path.basename(to) === 'spent-task-questions.json') {
      throw new Error('fixture question rollback refused');
    }
    return rename(from, to);
  });
  await f.click(confirm);
  assert.ok(actionRefused);
  assert.equal(f.toast(), 'Не смог убрать, попробуй ещё раз');
  assert.deepEqual(await f.records(), [first]);
  fail = false;
  await f.click(confirm);
  assert.equal(f.toast(), 'Убрал');
  assert.deepEqual(await f.records(), []);
});

test('a duplicate tap while the first acknowledgment waits still closes the exact original question', async t => {
  const f = await profile(t, [first]);
  assert.ok(await f.ask());
  const editCount = f.edits.length;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.bot.middleware.unshift(async (ctx, next) => {
    const original = ctx.answerCallbackQuery;
    ctx.answerCallbackQuery = async options => {
      if (options?.text === 'Убрал') {
        entered.resolve();
        await release.promise;
      }
      return original(options);
    };
    return next();
  });
  const firstTap = f.click(confirm);
  try {
    await Promise.race([entered.promise, firstTap]);
    assert.deepEqual(await f.records(), []);
    await f.click(confirm);
    assert.equal(f.toast(), 'Подтверждение устарело');
  } finally {
    release.resolve();
  }
  await firstTap;
  assert.equal(f.edits.length, editCount + 1);
  assert.match(f.edits.at(-1), /Снёс 1/);
  assert.deepEqual(f.editOptions.at(-1).reply_markup.inline_keyboard, []);
});

test('a failed Keep write is reported on its own card and can be retried', async t => {
  const f = await profile(t, [first]);
  assert.ok(await f.ask());
  const edits = f.edits.length;
  const rename = fs.rename;
  let refuse = true;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (refuse && path.basename(to) === 'spent-task-questions.json') throw new Error('fixture Keep write refused');
    return rename(from, to);
  });
  await f.click(keep);
  assert.equal(f.toast(), 'Не смог закрыть вопрос, попробуй ещё раз');
  assert.equal(f.edits.length, edits);
  refuse = false;
  await f.click(keep);
  assert.equal(f.toast(), 'Оставил');
  assert.deepEqual(await f.records(), [first]);
});

test('a second bot profile cannot spend the first bot’s confirmation in the same chat', async t => {
  const f = await profile(t, [first]);
  assert.ok(await f.ask());
  const sibling = path.join(path.dirname(f.directory), 'other');
  const siblingActions = path.join(sibling, 'actions.json');
  const siblingBytes = JSON.stringify([first]);
  await fs.mkdir(sibling);
  await fs.writeFile(siblingActions, siblingBytes);
  const profileId = process.env.MSB_BOT_ID;
  process.env.MSB_BOT_ID = 'other';
  try {
    await saveState({ engine: 'cc' });
    await f.click(confirm);
    assert.equal(f.toast(), 'Подтверждение устарело');
    assert.equal(await fs.readFile(siblingActions, 'utf8'), siblingBytes);
    assert.deepEqual(await f.records(), [first]);
  } finally {
    process.env.MSB_BOT_ID = profileId;
  }
  await f.click(confirm);
  assert.equal(f.toast(), 'Убрал');
  assert.deepEqual(await f.records(), []);
  assert.equal(await fs.readFile(siblingActions, 'utf8'), siblingBytes);
});
