/**
 * Old CANCEL_ALL and ct-all through the production Telegram worker with
 * disposable saved records, scheduler pause and archives. [Old proof](./reference/parity-autonomy-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { actionRoot } from '../src/paths.mjs';
import { trackAutonomyTurn } from '../src/autonomy/owner-pause.mjs';
import { mcpFixture } from './helpers/mcp-fixture.mjs';
import { nativeFixtures } from './helpers/mcp-launch-fixture.mjs';
import { chat, reminderFixture, until } from './helpers/reminder-registration-fixture.mjs';

const command = '[CANCEL_ALL]';
const request = 'Удали все фоновые задачи';
const row = (id, name, extra = {}) => ({
  id, name, enabled: true, trigger: { kind: 'interval', intervalMinutes: 60 },
  task: { kind: 'reminder', text: 'Содержимое ' + id }, ...extra,
});
const active = row('active', 'Активная');
const archiveName = name => name.startsWith('actions.removed-') && name.endsWith('.json');

async function profile(t, { output = command, records = [active] } = {}) {
  const f = await reminderFixture(t, { output });
  const put = values => fs.writeFile(f.actionFile, JSON.stringify(values));
  await put(records);
  const autonomy = path.join(f.directory, 'autonomy');
  const stop = path.join(autonomy, 'STOP');
  const journal = path.join(autonomy, 'runs.jsonl');
  const jobFile = path.join(autonomy, 'cron-jobs.json');
  const sibling = path.join(path.dirname(f.directory), 'other', 'actions.json');
  const intervals = path.join(f.home, 'intervals', 'tasks.json');
  await fs.mkdir(autonomy, { recursive: true });
  await fs.mkdir(path.dirname(sibling), { recursive: true });
  await fs.mkdir(path.dirname(intervals), { recursive: true });
  process.env.AUTONOMY_DIR = path.dirname(intervals);
  await fs.writeFile(journal, '{"fixture":"journal"}\n');
  await fs.writeFile(f.schedules, '[{"id":"legacy","name":"Старый таймер","enabled":true}]\n');
  await fs.writeFile(sibling, JSON.stringify([row('sibling', 'Соседний бот')]));
  await fs.writeFile(intervals, '[{"id":"interval","title":"Отдельная задача","enabled":true}]\n');
  const stable = [journal, f.schedules, sibling, intervals, f.storeFile];
  const bytes = () => Promise.all(stable.map(file => fs.readFile(file)));
  const before = await bytes();
  const archives = async () => (await fs.readdir(f.directory)).filter(archiveName).sort().map(name => path.join(f.directory, name));
  const question = () => f.messages.findLastIndex(text => text.startsWith('Снести все фоновые задачи')) + 1;
  const toast = () => f.callbackAnswers.at(-1)?.[0]?.text;
  const click = (data, { uid = 42, chatId = chat, messageId = question() } = {}) =>
    f.bot.handleUpdate({ callback_query: { id: 'bulk-cancel-tap', data, from: { id: uid },
      message: { message_id: messageId, chat: { id: chatId }, message_thread_id: 17,
        text: f.messages[messageId - 1] ?? 'Другая карточка' } } });
  async function ask() {
    const start = f.edits.length;
    await f.request(request);
    await until(() => f.edits.slice(start).some(text => text.includes('⏱')), 'missing final Telegram reply');
    return question();
  }
  return { ...f, put, stop, journal, jobFile, archives, question, toast, click, ask,
    untouched: async () => assert.deepEqual(await bytes(), before) };
}

async function absent(file) {
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
}

test('CANCEL_ALL shows the old bound card, stops active work, archives the current rows and removes them', async t => {
  const disabled = row('off', 'Выключенная', { enabled: false, disabledReason: 'owner' });
  const pending = row('pending', 'Ожидающая', { pendingConfirm: true });
  const f = await profile(t, { records: [active, disabled, pending] });
  const before = await fs.readFile(f.actionFile);
  const question = await f.ask();
  assert.ok(question);
  assert.equal(f.messages[question - 1], 'Снести все фоновые задачи (3)?\n• Активная\n• Выключенная\n• Ожидающая\nСнос необратим.');
  assert.equal(f.messageOptions[question - 1].message_thread_id, 17);
  assert.deepEqual(f.markupEdits.find(item => item.messageId === question)?.options.reply_markup.inline_keyboard, [[
    { text: 'Снести все ✖', callback_data: 'ct-all' }, { text: 'Оставить', callback_data: 'ct-keep' },
  ]]);
  assert.match(await f.final(), /Спросил подтверждение ниже, снесу все по кнопке/);
  assert.deepEqual(await fs.readFile(f.actionFile), before);
  await absent(f.stop);
  assert.deepEqual(await f.archives(), []);
  const answers = f.callbackAnswers.length;
  await f.click('ct-all', { uid: 99 });
  assert.equal(f.callbackAnswers.length, answers);
  await f.click('ct-all', { chatId: 42 });
  assert.equal(f.toast(), 'Подтверждение устарело');
  const advanced = { ...active, lastRunAt: '2026-11-08T10:00:00.000Z', lastStatus: 'ok' };
  const latest = [advanced, disabled, pending];
  await f.put(latest);
  const turn = trackAutonomyTurn();
  t.after(() => turn.release());
  await f.click('ct-all');
  assert.equal(f.toast(), 'Снёс');
  assert.ok(turn.signal.aborted);
  assert.ok((await fs.stat(f.stop)).isFile());
  const [archive, ...others] = await f.archives();
  assert.ok(archive);
  assert.deepEqual(others, []);
  assert.equal((await fs.stat(archive)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await fs.readFile(archive, 'utf8')), latest);
  assert.deepEqual(await f.records(), []);
  assert.match(f.edits.at(-1), /Отменил все задачи \(3\) и остановил автономку/);
  assert.match(f.edits.at(-1), /Снимок задач сохранён на сервере/);
  assert.match(f.edits.at(-1), /Таймеры с прошлой настройки работают отдельно/);
  assert.doesNotMatch(f.edits.at(-1), /скажи «верни задачи»/);
  await f.untouched();
});

for (const [label, markers] of [
  ['even if it comes later in the reply', '[CANCEL_ALL]\n[CANCEL_SPENT]'],
  ['when a rendered name starts an unpaired quote', '[CANCEL_SPENT]\n[CANCEL_ALL]'],
]) {
  test('direct spent cleanup runs before the bulk question ' + label, async t => {
    const spent = row('spent', 'Архив " утро', {
      trigger: { kind: 'once', at: '2026-11-01T10:00:00.000Z' },
      lastRunAt: '2026-11-01T10:00:00.000Z',
    });
    const f = await profile(t, { output: markers + '\nСледующая "фраза".', records: [active, spent] });
    const question = await f.ask();
    assert.ok(question);
    assert.equal(f.messages[question - 1], 'Снести все фоновые задачи (1)?\n• Активная\nСнос необратим.');
    assert.deepEqual(await f.records(), [active]);
    assert.match(await f.final(), /Архив " утро/);
    await absent(f.stop);
    assert.deepEqual(await f.archives(), []);
  });
}

test('an empty list has the old reply and does not start the cancellation transaction', async t => {
  const f = await profile(t, { records: [] });
  assert.equal(await f.ask(), 0);
  assert.match(await f.final(), /Сносить нечего: фоновых задач нет/);
  await absent(f.stop);
  assert.deepEqual(await f.archives(), []);
});

test('eleven rows omit the names on the old card and Keep closes only that question', async t => {
  const records = Array.from({ length: 11 }, (_, index) => row('task-' + index, 'Имя ' + index));
  const f = await profile(t, { records });
  const question = await f.ask();
  assert.ok(question);
  assert.equal(f.messages[question - 1], 'Снести все фоновые задачи (11)?\nСнос необратим.');
  await f.click('ct-keep');
  assert.equal(f.toast(), 'Оставил');
  assert.match(f.edits.at(-1), /✔ Оставил на месте/);
  await f.click('ct-all');
  assert.equal(f.toast(), 'Подтверждение устарело');
  assert.deepEqual(await f.records(), records);
  await absent(f.stop);
  assert.deepEqual(await f.archives(), []);
});

test('a replacement or later-added row invalidates the old group before pause or archive', async t => {
  const f = await profile(t);
  assert.ok(await f.ask());
  const replacement = { ...active, task: { ...active.task, text: 'Новая инструкция' } };
  const added = row('added', 'Появилась после вопроса');
  await f.put([replacement, added]);
  const before = await fs.readFile(f.actionFile);
  await f.click('ct-all');
  assert.equal(f.toast(), 'Подтверждение устарело');
  assert.deepEqual(await fs.readFile(f.actionFile), before);
  await absent(f.stop);
  assert.deepEqual(await f.archives(), []);
});

test('a bound confirmation can still pause when the approved rows have already been removed', async t => {
  const f = await profile(t);
  assert.ok(await f.ask());
  await f.put([]);
  await f.click('ct-all');
  assert.equal(f.toast(), 'Снёс');
  assert.ok((await fs.stat(f.stop)).isFile());
  assert.match(f.edits.at(-1), /Автономка остановлена/);
  assert.deepEqual(await f.archives(), []);
  await f.untouched();
});

test('a failed archive preserves tasks, leaves STOP and permits a safe retry', async t => {
  const f = await profile(t);
  assert.ok(await f.ask());
  const rename = fs.rename;
  let refuse = true;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (refuse && archiveName(path.basename(to))) throw new Error('fixture archive write failed');
    return rename(from, to);
  });
  await f.click('ct-all');
  assert.match(f.toast(), /Не удалось сохранить снимок/);
  assert.deepEqual(await f.records(), [active]);
  assert.ok((await fs.stat(f.stop)).isFile());
  assert.deepEqual(await f.archives(), []);
  refuse = false;
  await f.click('ct-all');
  assert.equal(f.toast(), 'Снёс');
  assert.deepEqual(await f.records(), []);
  assert.equal((await f.archives()).length, 1);
});

test('a mapped row and orphan native schedule survive the local removal with an honest receipt', async t => {
  const native = row('mapped', 'Нативная');
  const f = await profile(t, { records: [active, native] });
  const map = '{"mapped":{"jobId":"foreign","enabled":true},"orphan":{"jobId":"orphan","enabled":true}}';
  await fs.writeFile(f.jobFile, map);
  assert.ok(await f.ask());
  await f.click('ct-all');
  assert.equal(f.toast(), 'Снёс не всё');
  assert.match(f.edits.at(-1), /Нативная/);
  assert.match(f.edits.at(-1), /OpenClaw могут продолжать/);
  assert.deepEqual(await f.records(), [native]);
  assert.equal(await fs.readFile(f.jobFile, 'utf8'), map);
  const [archive] = await f.archives();
  assert.deepEqual(JSON.parse(await fs.readFile(archive, 'utf8')), [active, native]);
  await f.untouched();
});

test('a duplicate confirmation cannot put STOP back after removal and a later resume', async t => {
  let reply = command;
  const f = await profile(t, { output: () => ({ ok: true, text: reply }) });
  assert.ok(await f.ask());
  const rename = fs.rename;
  let refuseRetirement = true;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (refuseRetirement && path.basename(to) === 'spent-task-questions.json' &&
        JSON.parse(await fs.readFile(from, 'utf8')).length === 0) throw new Error('fixture retirement failed');
    return rename(from, to);
  });
  await f.click('ct-all');
  assert.equal(f.toast(), 'Снёс');
  assert.deepEqual(await f.records(), []);
  assert.ok((await fs.stat(f.stop)).isFile());
  refuseRetirement = false;
  reply = '[RESUME_ALL]';
  const start = f.edits.length;
  await f.request('Верни фоновые задачи в работу');
  await until(() => f.edits.slice(start).some(text => text.includes('Снял стоп')), 'resume did not finish');
  await absent(f.stop);
  await f.click('ct-all');
  assert.equal(f.toast(), 'Подтверждение устарело');
  await absent(f.stop);
  assert.equal((await f.archives()).length, 1);
});

test('a quoted bulk marker never arms a card and remains separate from a valid STOP request', async t => {
  const f = await profile(t, { output: 'Пример «[CANCEL_ALL]».\n[STOP_ALL]' });
  await f.request('Поставь задачи на паузу');
  const final = await f.final();
  assert.match(final, /Автономка остановлена/);
  assert.doesNotMatch(final, /CANCEL_ALL|Спросил подтверждение ниже, снесу все/);
  assert.equal(f.question(), 0);
  assert.deepEqual(await f.records(), [active]);
  assert.deepEqual(await f.archives(), []);
});

for (const provider of ['claude', 'codex']) {
  test(provider + ' owner turn advertises CANCEL_ALL and only asks before the tap', async t => {
    const f = await mcpFixture(t, provider, { runTurn: runAgentTurn });
    const native = await nativeFixtures(f);
    process.env.AUTONOMY_ENABLED = '1';
    const file = path.join(actionRoot(), 'actions.json');
    const before = JSON.stringify([active]);
    await fs.writeFile(file, before);
    await native.respond(command);
    await f.message(request);
    await until(() => f.edits.some(text => text.includes('⏱')), 'provider did not finish', 10_000);
    const call = (await native.trace()).at(-1);
    const prompt = provider === 'claude' ? call.argv[call.argv.indexOf('--append-system-prompt') + 1] : call.prompt;
    assert.match(prompt, /\[CANCEL_ALL\]/);
    assert.match(f.edits.at(-1), /Спросил подтверждение ниже, снесу все по кнопке/);
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.ok(f.markupEdits.some(item => item.options.reply_markup.inline_keyboard[0]?.[0]?.callback_data === 'ct-all'));
  });
}

test('a failed action publish keeps the prior archive and never reports successful removal', async t => {
  const f = await profile(t);
  assert.ok(await f.ask());
  const physical = await fs.realpath(f.actionFile);
  const rename = fs.rename;
  let refuse = true;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (refuse && to === physical) throw new Error('fixture action publish failed');
    return rename(from, to);
  });
  await f.click('ct-all');
  assert.match(f.toast(), /Не удалось снести/);
  assert.ok((await fs.stat(f.stop)).isFile());
  const [archive] = await f.archives();
  assert.ok(archive);
  const original = await fs.readFile(archive);
  assert.deepEqual(JSON.parse(original), [active]);
  assert.deepEqual(await f.records(), [active]);
  refuse = false;
  await f.click('ct-all');
  assert.equal(f.toast(), 'Снёс');
  assert.deepEqual(await fs.readFile(archive), original);
  assert.deepEqual(await f.records(), []);
});

test('a failure to engage STOP prevents the archive and deletion', async t => {
  const f = await profile(t);
  assert.ok(await f.ask());
  const write = fs.writeFile;
  let refuse = true;
  t.mock.method(fs, 'writeFile', async (file, ...args) => {
    if (refuse && path.basename(file) === 'STOP') throw new Error('fixture STOP write failed');
    return write(file, ...args);
  });
  await f.click('ct-all');
  assert.match(f.toast(), /Не удалось остановить/);
  await absent(f.stop);
  assert.deepEqual(await f.archives(), []);
  assert.deepEqual(await f.records(), [active]);
  refuse = false;
  await f.click('ct-all');
  assert.equal(f.toast(), 'Снёс');
  assert.deepEqual(await f.records(), []);
});

for (const failure of ['STOP sync', 'archive publish']) {
  test(failure + ' failure retries cannot reuse the old pause after resume', async t => {
    let reply = command;
    const f = await profile(t, { output: () => ({ ok: true, text: reply }) });
    assert.ok(await f.ask());
    const open = fs.open, rename = fs.rename;
    let refuse = true;
    if (failure === 'STOP sync') {
      t.mock.method(fs, 'open', async (file, ...args) => {
        if (refuse && path.basename(file) === 'STOP') throw new Error('fixture STOP sync failure');
        return open(file, ...args);
      });
    } else {
      t.mock.method(fs, 'rename', async (from, to) => {
        if (refuse && archiveName(path.basename(to))) throw new Error('fixture archive failure');
        return rename(from, to);
      });
    }
    await f.click('ct-all');
    assert.ok((await fs.stat(f.stop)).isFile());
    assert.deepEqual(await f.records(), [active]);
    assert.deepEqual(await f.archives(), []);
    refuse = false;
    reply = '[RESUME_ALL]';
    const edits = f.edits.length;
    await f.request('Верни фоновые задачи в работу');
    await until(() => f.edits.slice(edits).some(text => /Снял (стоп|паузу)/.test(text)), 'resume did not finish');
    await absent(f.stop);
    await f.click('ct-all');
    assert.equal(f.toast(), 'Подтверждение устарело');
    await absent(f.stop);
    assert.deepEqual(await f.records(), [active]);
    assert.deepEqual(await f.archives(), []);
  });
}
