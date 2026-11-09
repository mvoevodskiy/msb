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

async function timerFixture(t, schedules) {
  const bot = await fixture(t, async () => assert.fail('Timer menu must not run the model'));
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
