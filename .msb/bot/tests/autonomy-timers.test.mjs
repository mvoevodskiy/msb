/**
 * Old Telegram timer management through production callbacks with a private test HOME.
 * [Autonomy contract](../src/autonomy/README.md), [old behavior](../vendor/CONTRACT-autonomy.md).
 * Read git show 73aa9e7e850bad7ac1ea8a8091d086ecbfd47a11:
 * per-bot schedules 18045–18068/18305–18310, format 18284–18303,
 * callbacks 115192–115293. The SCHEDULE_TASK reminder at 24644 is a separate action.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { botRoot } from '../src/paths.mjs';
import { fixture } from './helpers/menu-fixture.mjs';

const once = {
  id: 'once-fixture',
  name: 'Проверить почту',
  type: 'once',
  at: '2099-11-10T12:30:00.000Z',
  prompt: 'Пришли напоминание',
  enabled: true,
};
const daily = {
  id: 'daily-fixture',
  name: 'Утренний отчёт',
  type: 'daily',
  hour: 9,
  prompt: 'Пришли отчёт',
  enabled: false,
};
const weekly = {
  id: 'weekly-fixture',
  name: 'Проверить итоги',
  type: 'weekly',
  hour: 18,
  minute: 15,
  weekdays: [1, 5],
  prompt: 'Пришли итоги',
  enabled: true,
};

async function timerFixture(t, schedules, options) {
  const bot = await fixture(t, async () => assert.fail('Timer menu must not run the model'), options);
  delete process.env.MSB_SESSION_DIR;
  delete process.env.IIA_SESSION_DIR;
  const file = path.join(botRoot(), 'schedules.json');
  const bytes = schedules === undefined ? undefined : JSON.stringify(schedules, null, 2);
  if (bytes !== undefined) await fs.writeFile(file, bytes);
  return { ...bot, file, bytes };
}

function latestView(f) {
  assert.ok(f.edits.length, 'Timer callback must edit the menu message');
  const markup = f.editOptions.at(-1)?.reply_markup;
  return {
    text: f.edits.at(-1),
    buttons: markup.inline_keyboard.flat().map(button => [button.text, button.callback_data]),
  };
}

test('timer list: empty store shows the old empty message and Back without creating a file', async t => {
  const f = await timerFixture(t);
  await f.callback('auto:timers');

  const { text, buttons } = latestView(f);
  assert.match(text, /⏳ <b>Таймеры<\/b>/);
  assert.match(text, /Ни одного\. Это старая механика повторов/);
  assert.deepEqual(buttons, [['« Назад', 'auto:home']]);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});

test('timer list: reads only this bot, shows old once, daily and weekly rows in file order', async t => {
  const f = await timerFixture(t, [once, daily, weekly]);
  const sibling = botRoot({ ...process.env, MSB_BOT_ID: 'sibling' });
  await fs.mkdir(sibling, { recursive: true });
  await fs.writeFile(path.join(sibling, 'schedules.json'), JSON.stringify([{ ...once, name: 'Таймер соседа' }]));
  await f.callback('auto:timers');

  const { text, buttons } = latestView(f);
  assert.match(text, /Таймеры<\/b> \(3\)/);
  assert.match(text, /✔ Проверить почту — .* \(одноразовый\)/);
  assert.match(text, /⏸ Утренний отчёт — каждый день 09:00/);
  assert.match(text, /✔ Проверить итоги — Пн, Пт 18:15/);
  assert.doesNotMatch(text, /Таймер соседа/);
  assert.deepEqual(buttons, [
    ['✔ Проверить почту', 'auto:timer:once-fixture'],
    ['⏸ Утренний отчёт', 'auto:timer:daily-fixture'],
    ['✔ Проверить итоги', 'auto:timer:weekly-fixture'],
    ['« Назад', 'auto:home'],
  ]);
  assert.equal(await fs.readFile(f.file, 'utf8'), f.bytes);
});

test('timer card: shows once type, active status, bounded prompt and the old action callbacks', async t => {
  const prompt = 'П'.repeat(200) + ' за пределом';
  const f = await timerFixture(t, [{ ...once, prompt }]);
  await f.callback('auto:timer:once-fixture');

  const { text, buttons } = latestView(f);
  assert.match(text, /⏳ <b>Проверить почту<\/b>/);
  assert.match(text, /Тип: одноразовый/);
  assert.match(text, /Статус: ✔ активен/);
  assert.ok(text.includes('Текст: <i>' + prompt.slice(0, 200) + '</i>'));
  assert.doesNotMatch(text, /за пределом/);
  assert.deepEqual(buttons, [
    ['⏸ Выключить', 'auto:timer-toggle:once-fixture'],
    ['🗑 Удалить', 'auto:timer-delete:once-fixture'],
    ['« Назад', 'auto:timers'],
  ]);
  assert.equal(await fs.readFile(f.file, 'utf8'), f.bytes);
});

test('timer card: a stale callback shows the old missing warning and returns to the timer list', async t => {
  const f = await timerFixture(t, [once]);
  await f.callback('auto:timer:missing');

  const { text, buttons } = latestView(f);
  assert.equal(text, '⚠️ Таймер не найден.');
  assert.deepEqual(buttons, [['« Назад', 'auto:timers']]);
  assert.equal(await fs.readFile(f.file, 'utf8'), f.bytes);
});

test('timer toggle: returns to the list and changes only enabled, retaining the one-shot execution stamp', async t => {
  const done = { ...once, enabled: false, lastRunAt: '2099-11-10T12:31:00.000Z' };
  const f = await timerFixture(t, [done, daily]);
  await f.callback('auto:timer-toggle:once-fixture');

  assert.match(latestView(f).text, /Таймеры<\/b> \(2\)/);
  assert.match(latestView(f).text, /✔ Проверить почту/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), [{ ...done, enabled: true }, daily]);
});

test('timer delete: removes the selected legacy row and shows the old post-delete empty list', async t => {
  const f = await timerFixture(t, [once]);
  await f.callback('auto:timer-delete:once-fixture');

  const { text, buttons } = latestView(f);
  assert.match(text, /Ни одного не осталось\./);
  assert.deepEqual(buttons, [['« Назад', 'auto:home']]);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), []);
});

test('timer list: follows the legacy session parent override and safely renders stored markup', async t => {
  const f = await timerFixture(t, [daily], { runtimeProfile: 'jar1' });
  const custom = path.join(f.home, 'legacy-profile');
  await fs.mkdir(custom);
  process.env.IIA_SESSION_DIR = path.join(custom, 'sessions');
  const stored = { ...once, name: 'Почта <важно> & отчёт', prompt: 'Сравни 1 < 2 & 3' };
  await fs.writeFile(path.join(custom, 'schedules.json'), JSON.stringify([stored]));

  await f.callback('auto:timers');
  assert.match(latestView(f).text, /Почта &lt;важно&gt; &amp; отчёт/);
  assert.doesNotMatch(latestView(f).text, /Утренний отчёт/);
  await f.callback('auto:timer:once-fixture');
  assert.match(latestView(f).text, /Сравни 1 &lt; 2 &amp; 3/);
  assert.equal(await fs.readFile(f.file, 'utf8'), f.bytes);
});

test('timer change: corrupted JSON is not replaced with an empty list', async t => {
  const f = await timerFixture(t);
  const corrupt = '[{"id":"once-fixture"';
  await fs.writeFile(f.file, corrupt);

  await f.callback('auto:timer-delete:once-fixture');
  assert.match(latestView(f).text, /Ни одного\. Это старая механика повторов/);
  assert.equal(await fs.readFile(f.file, 'utf8'), corrupt);
});

test('timer changes: concurrent callbacks do not undo each other', async t => {
  const f = await timerFixture(t, [once, daily, weekly]);
  await Promise.all([
    f.callback('auto:timer-toggle:once-fixture', 42, { messageId: 101 }),
    f.callback('auto:timer-delete:daily-fixture', 42, { messageId: 102 }),
  ]);

  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), [{ ...once, enabled: false }, weekly]);
});

test('timer change: a pre-existing temporary symlink cannot redirect the write', async t => {
  const f = await timerFixture(t, [once]);
  const unrelated = path.join(f.home, 'unrelated.txt');
  const oldTemporary = f.file + '.tmp.' + process.pid;
  await fs.writeFile(unrelated, 'untouched bytes');
  await fs.symlink(unrelated, oldTemporary);

  await f.callback('auto:timer-toggle:once-fixture');
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'untouched bytes');
  assert.equal(await fs.readlink(oldTemporary), unrelated);
  assert.equal((await fs.lstat(f.file)).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), [{ ...once, enabled: false }]);
});

test('timer change: a linked schedules file keeps the link and updates its target', async t => {
  const f = await timerFixture(t);
  const target = path.join(f.home, 'existing-schedules.json');
  await fs.writeFile(target, JSON.stringify([once]));
  await fs.chmod(target, 0o640);
  await fs.symlink(target, f.file);

  await f.callback('auto:timer-toggle:once-fixture');
  assert.equal(await fs.readlink(f.file), target);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), [{ ...once, enabled: false }]);
});
