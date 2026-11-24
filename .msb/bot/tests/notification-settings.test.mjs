/** The existing nm:list route reads only the owner and server mute records. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/menu-fixture.mjs';
import { drainCallbackTasks } from '../shared/callback-renders.mjs';

const mutes = (...names) => ({ kinds: Object.fromEntries(names.map(name => [
  name, { mutedAt: '2026-11-24T00:00:00.000Z' },
])) });

async function writeMutes(dir, value) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'notice-mute.json');
  const data = typeof value === 'string' ? value : JSON.stringify(value);
  await fs.writeFile(file, data);
  return { file, data };
}

test('notification settings list saved choices with controls only from their old scopes', async t => {
  const f = await fixture(t, undefined, { runtimeProfile: 'jar1' });
  const root = path.join(f.home, '.iia');
  const files = await Promise.all([
    writeMutes(path.join(root, 'monitor'), mutes('balance', 'pause_reminder')),
    writeMutes(path.join(root, 'bots/default'), mutes('provider_credits', 'unknown')),
    writeMutes(path.join(root, 'bots/second'), mutes('pause_reminder')),
  ]);
  await f.callback('nm:list');
  assert.match(f.edits.at(-1), /Предупреждение о балансе мониторинга/);
  assert.match(f.edits.at(-1), /кончились деньги у провайдера/u);
  assert.doesNotMatch(f.edits.at(-1), /пауза автономки|unknown/i);
  assert.deepEqual(f.editOptions.at(-1).reply_markup.inline_keyboard.flat().map(button => button.callback_data), ['nm:on:balance', 'nm:on:provider_credits', 'nm:demo', 'settings:back']);
  await f.callback('settings:back');
  assert.match(f.edits.at(-1), /Настройки/);
  for (const { file, data } of files) assert.equal(await fs.readFile(file, 'utf8'), data);
});

test('notification settings use the parent of the configured sessions directory', async t => {
  const f = await fixture(t, undefined, { runtimeProfile: 'jar1' });
  const dir = path.join(f.home, 'custom-bot');
  delete process.env.MSB_SESSION_DIR;
  process.env.IIA_SESSION_DIR = path.join(dir, 'sessions');
  await writeMutes(dir, mutes('pause_reminder'));
  await writeMutes(path.join(f.home, '.iia/bots/default'), mutes('provider_credits'));
  await f.callback('nm:list');
  assert.match(f.edits.at(-1), /Напоминание о паузе автономки/);
  assert.doesNotMatch(f.edits.at(-1), /кончились деньги у провайдера/);
});

test('notification settings read a legacy single-bot file only for the default jar1 profile', async t => {
  const f = await fixture(t, undefined, { runtimeProfile: 'jar1' });
  delete process.env.MSB_SESSION_DIR;
  delete process.env.IIA_SESSION_DIR;
  await writeMutes(path.join(f.home, '.iia'), mutes('pause_reminder'));
  await f.callback('nm:list');
  assert.match(f.edits.at(-1), /Напоминание о паузе автономки/);

  process.env.MSB_BOT_ID = 'second';
  await f.callback('nm:list');
  assert.match(f.edits.at(-1), /Ничего не отключено/);
  assert.doesNotMatch(f.edits.at(-1), /пауза автономки/i);
});

test('notification settings distinguish missing data from unreadable preferences', async t => {
  const f = await fixture(t);
  await f.callback('nm:list');
  assert.match(f.edits.at(-1), /Ничего не отключено/);
  const { file, data } = await writeMutes(path.join(f.home, '.msb/monitor'), '{broken');
  await f.callback('nm:list');
  assert.match(f.edits.at(-1), /не удалось прочитать/iu);
  assert.doesNotMatch(f.edits.at(-1), /Ничего не отключено/);
  assert.equal(await fs.readFile(file, 'utf8'), data);
});

test('owner mute and return preserve menu actions, topic and unknown settings', async t => {
  const f = await fixture(t, undefined, { overlay: false, now: () => Date.parse('2026-11-24T12:00Z') });
  const original = { revision: 4, kinds: { unknown: { future: true }, provider_credits: { futureOption: 7 } } };
  const { file, data } = await writeMutes(path.join(f.home, '.msb/bots/default'), original);
  const connect = { text: '🔌 Подключение', callback_data: 'settings:auth' };
  const replyMarkup = { inline_keyboard: [[connect], [{ text: '🔕 Больше не присылать', callback_data: 'nm:provider_credits' }]] };
  const tap = { threadId: 77, messageId: 16, replyMarkup };
  await f.callback('nm:provider_credits', 43, tap);
  assert.deepEqual(f.callbackAnswers.at(-1), [{ text: 'Настраивает только владелец бота', show_alert: true }]);
  assert.equal(await fs.readFile(file, 'utf8'), data);
  await f.callback('nm:provider_credits', 42, tap);
  assert.deepEqual(f.callbackAnswers.at(-1), [{ text: 'Запомнил' }]);
  assert.deepEqual(f.markupEdits.at(-1), {
    chatId: 42, messageId: 16, options: { reply_markup: { inline_keyboard: [[connect]] } },
  });
  assert.match(f.messages.at(-1), /Хорошо, запомнил: больше не пришлю сообщение/);
  assert.equal(f.messageOptions.at(-1).message_thread_id, 77);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {
    ...original, kinds: { ...original.kinds, provider_credits: { futureOption: 7, mutedAt: '2026-11-24T12:00:00.000Z' } },
  });
  await f.callback('nm:provider_credits', 42, tap);
  assert.deepEqual(f.callbackAnswers.at(-1), [{ text: 'Уже отключено' }]);
  assert.equal(f.messages.length, 1);
  await f.callback('nm:on:provider_credits');
  assert.deepEqual(f.callbackAnswers.at(-1), [{ text: 'Вернул' }]);
  assert.match(f.edits.at(-1), /Вернул: сообщение/);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), original);
  await f.callback('nm:on:provider_credits');
  assert.deepEqual(f.callbackAnswers.at(-1), [{ text: 'Уже включено' }]);
});

test('button updates use existing JAR1 fallback and preserve independent writes', async t => {
  const f = await fixture(t, undefined, { runtimeProfile: 'jar1', overlay: false });
  delete process.env.MSB_SESSION_DIR;
  delete process.env.IIA_SESSION_DIR;
  const root = path.join(f.home, '.iia');
  const legacy = await writeMutes(root, { version: 9, ...mutes('unknown', 'pause_reminder') });
  await Promise.all([
    f.callback('nm:on:pause_reminder', 42, { messageId: 2 }),
    f.callback('nm:provider_credits', 42, { messageId: 3 }),
    f.callback('nm:balance', 42, { messageId: 4 }),
  ]);
  const { isNoticeMuted } = await import('../src/notifications/mutes.mjs');
  assert.equal(await isNoticeMuted('pause_reminder'), false);
  assert.equal(await isNoticeMuted('provider_credits'), true);
  assert.equal(await isNoticeMuted('balance'), true);
  const saved = JSON.parse(await fs.readFile(legacy.file, 'utf8'));
  assert.equal(saved.version, 9);
  assert.deepEqual(Object.keys(saved.kinds).sort(), ['provider_credits', 'unknown']);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path.join(root, 'monitor/notice-mute.json'), 'utf8')).kinds), ['balance']);
  await assert.rejects(fs.stat(path.join(root, 'bots/default/notice-mute.json')), { code: 'ENOENT' });
});

test('tap cannot overwrite unreadable preferences or unknown kinds', async t => {
  const f = await fixture(t, undefined, { overlay: false });
  const { file, data } = await writeMutes(path.join(f.home, '.msb/monitor'), '{broken');
  await f.callback('nm:balance');
  assert.deepEqual(f.callbackAnswers.at(-1), [{ text: 'Не получилось, попробуй ещё раз', show_alert: true }]);
  await f.callback('nm:invented');
  assert.deepEqual(f.callbackAnswers.at(-1), [{ text: 'Не разобрал кнопку' }]);
  assert.equal(await fs.readFile(file, 'utf8'), data);
});

test('demo on an empty JAR1 profile respects monitor and mute controls and a tap gate', async t => {
  let now = Date.parse('2026-11-24T12:00Z');
  const f = await fixture(t, undefined, { runtimeProfile: 'jar1', overlay: false, now: () => now });
  delete process.env.MSB_SESSION_DIR;
  delete process.env.IIA_SESSION_DIR;
  const monitor = path.join(f.home, '.iia/monitor');
  await writeMutes(monitor, mutes());
  await fs.writeFile(path.join(monitor, 'config.json'), JSON.stringify({ notifications: { enabled: false } }));
  await f.callback('nm:demo', 42, { threadId: 99 });
  await drainCallbackTasks(f.bot);
  assert.deepEqual(f.callbackAnswers.at(-1), [{ text: 'Присылаю примеры…' }]);
  assert.equal(f.messages.length, 2);
  assert.match(f.messages[0], /Кредиты провайдера закончились/);
  assert.match(f.messages[1], /Стопа сейчас нет/);
  for (const option of f.messageOptions) assert.equal(option.message_thread_id, 99);
  assert.deepEqual(f.messageOptions.map(o => o.reply_markup.inline_keyboard.flat().map(b => b.callback_data)), [
    ['settings:auth', 'nm:provider_credits'], ['nm:pause_reminder'],
  ]);
  assert.match(f.edits.at(-1), /Прислал примеры ниже: 2 из 3/);
  assert.match(f.edits.at(-1), /выключено тумблером уведомлений мониторинга/);
  await f.callback('nm:demo');
  assert.deepEqual(f.callbackAnswers.at(-1), [{ text: 'Примеры только что ушли, подожди 10 секунд' }]);
  assert.equal(f.messages.length, 2);
  await f.callback('nm:provider_credits');
  now += 10000;
  await f.callback('nm:demo');
  await drainCallbackTasks(f.bot);
  assert.match(f.edits.at(-1), /Прислал примеры ниже: 1 из 3/);
  assert.match(f.edits.at(-1), /Деньги у провайдера: сейчас отключено/);
});

test('demo keeps polling while a send is pending and offers real pause-off only with STOP', async t => {
  const now = Date.parse('2026-11-24T12:00Z');
  const f = await fixture(t, undefined, { now: () => now });
  const stop = path.join(f.home, '.msb/bots/default/autonomy/STOP');
  await fs.mkdir(path.dirname(stop), { recursive: true });
  await fs.writeFile(stop, 'fixture\n2026-11-20T12:00:00.000Z\n');
  const send = f.bot.api.sendMessage;
  const { promise, resolve } = Promise.withResolvers();
  f.bot.api.sendMessage = async (...args) => {
    await promise;
    return send(...args);
  };
  const topic = { threadId: 88 };
  try {
    await f.callback('nm:demo', 42, topic);
    assert.equal(f.messages.length, 0);
    await f.callback('nm:demo', 42, topic);
    assert.deepEqual(f.callbackAnswers.at(-1), [{ text: 'Примеры только что ушли, подожди 10 секунд' }]);
  } finally {
    resolve();
  }
  await drainCallbackTasks(f.bot);
  assert.equal(f.messages.length, 3);
  assert.match(f.messages[0], /OpenRouter: осталось \$3\.20/);
  assert.match(f.messages[2], /Кнопка настоящая/);
  assert.match(f.messages[2], /20 ноября \(4 дня\)/);
  assert.deepEqual(f.messageOptions[2].reply_markup.inline_keyboard.flat().map(b => b.callback_data), [
    'pause-off', 'nm:pause_reminder',
  ]);
  assert.match(f.edits.at(-1), /Прислал примеры ниже: 3 из 3/);
});

test('the owner can resume from the notice in its topic and keep independent controls', async t => {
  const f = await fixture(t, undefined);
  const root = path.join(f.home, '.msb/bots/default');
  const stop = path.join(root, 'autonomy/STOP');
  await fs.mkdir(path.dirname(stop), { recursive: true });
  await fs.writeFile(stop, 'fixture\n2026-11-20T12:00:00Z\n');
  await fs.writeFile(path.join(root, 'remote-config.json'), '{"autonomyGlobalStop":true}');
  const controls = { inline_keyboard: [
    [{ text: '▶️ Снять паузу', callback_data: 'pause-off' }],
    [{ text: '🔕 Больше не присылать', callback_data: 'nm:pause_reminder' }],
  ] };
  const options = { messageId: 8, threadId: 77, replyMarkup: controls };
  process.env.AUTONOMY_ENABLED = '1';
  await f.callback('pause-off', 123, options);
  assert.match(f.callbackAnswers.at(-1)?.[0]?.text || '', /только владелец/);
  await fs.access(stop);
  process.env.AUTONOMY_ENABLED = '0';
  await f.callback('pause-off', 42, options);
  await drainCallbackTasks(f.bot);
  await fs.access(stop);
  assert.match(f.messages.at(-1), /выключены/);
  process.env.AUTONOMY_ENABLED = '1';
  await f.callback('pause-off', 42, options);
  await drainCallbackTasks(f.bot);
  await assert.rejects(fs.access(stop), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'remote-config.json'))), { autonomyGlobalStop: true });
  assert.deepEqual(f.markupEdits.at(-1).options.reply_markup.inline_keyboard, [controls.inline_keyboard[1]]);
  assert.equal(f.messageOptions.at(-1).message_thread_id, 77);
  await f.callback('pause-off', 42, options);
  await drainCallbackTasks(f.bot);
  assert.match(f.messages.at(-1), /Пауза уже снята/);
});

test('overlapping resume and mute taps remove both buttons from the same notice', async t => {
  const f = await fixture(t, undefined, { overlay: false });
  process.env.AUTONOMY_ENABLED = '1';
  const stop = path.join(f.home, '.msb/bots/default/autonomy/STOP');
  await fs.mkdir(path.dirname(stop), { recursive: true });
  await fs.writeFile(stop, 'fixture\n2026-11-20T12:00:00Z\n');
  const firstEdit = Promise.withResolvers();
  const releaseEdit = Promise.withResolvers();
  const muteSaved = Promise.withResolvers();
  const edit = f.bot.api.editMessageReplyMarkup;
  let blocked = false;
  t.mock.method(f.bot.api, 'editMessageReplyMarkup', async (...args) => {
    if (args[1] === 8 && !blocked) {
      blocked = true;
      firstEdit.resolve();
      await releaseEdit.promise;
    }
    return edit(...args);
  });
  const sharedAnswers = f.callbackAnswers;
  const push = sharedAnswers.push.bind(sharedAnswers);
  sharedAnswers.push = (...answers) => {
    if (answers.some(([answer]) => answer?.text === 'Запомнил')) muteSaved.resolve();
    return push(...answers);
  };
  const external = { text: 'Подключения', callback_data: 'settings:auth' };
  const controls = { inline_keyboard: [
    [{ text: '▶️ Снять паузу', callback_data: 'pause-off' }, external],
    [{ text: '🔕 Больше не присылать', callback_data: 'nm:pause_reminder' }],
  ] };
  const options = { messageId: 8, threadId: 77, replyMarkup: controls };
  let mute;
  try {
    await f.callback('pause-off', 42, options);
    await firstEdit.promise;
    mute = f.callback('nm:pause_reminder', 42, options);
    await muteSaved.promise;
    await f.callback('nm:pause_reminder', 42, { ...options, messageId: 9 });
  } finally {
    releaseEdit.resolve();
    await mute;
    await drainCallbackTasks(f.bot);
  }
  assert.deepEqual(f.markupEdits.filter(entry => entry.messageId === 8).at(-1).options.reply_markup.inline_keyboard, [[external]]);
  assert.deepEqual(f.markupEdits.find(entry => entry.messageId === 9).options.reply_markup.inline_keyboard, [controls.inline_keyboard[0]]);
  assert.equal(f.messages.filter(text => text.startsWith('Хорошо, запомнил')).length, 1);
  assert.ok(f.messageOptions.every(opts => opts.message_thread_id === 77));
});
