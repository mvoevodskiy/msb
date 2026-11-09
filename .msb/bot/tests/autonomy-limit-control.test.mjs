/**
 * Old SET_LIMIT via the production Telegram worker and owner callbacks.
 * Readable old blob 73aa9e7e850bad7ac1ea8a8091d086ecbfd47a11, lines
 * 24609, 26053–26274, 27096–27109 and 113219–113262. All profiles are fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readReminderRefusal } from '../src/autonomy/reminder-admission.mjs';
import { readEnvMap } from '../src/env/store.mjs';
import { botRoot, msbRoot } from '../src/paths.mjs';
import { loadState, saveState, updateState } from '../src/state.mjs';
import { createBot } from '../src/telegram/bot.mjs';
import { fixture } from './helpers/menu-fixture.mjs';

const now = Date.parse('2026-11-08T12:00:00.000Z');
const at = new Date(now).toISOString();
const runCap = 'AUTONOMY_DAILY_CAP_RUNS';
const questionText = 'Снять дневной запас ходов совсем? Число фоновых ходов за день перестанет ограничиваться.';
const confirm = 'lim0:daily_cap_runs';
const otherCap = 'lim0:daily_cap_tokens';
const keep = 'ct-keep';
const initial = '# комментарий к профилю\n' + runCap + '=40\nFIXTURE_SETTING=preserve\n';

async function until(read, message) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const found = read();
    if (found) return found;
    if (Date.now() >= deadline) assert.fail(message);
    await delay(5);
  }
}

async function profile(t) {
  let output;
  const f = await fixture(t, async () => {
    const { state } = await loadState();
    const result = typeof output === 'function' ? await output() : { ok: true, text: output };
    return { ...(state.engine === 'cc' ? { reminderRail: 'cc' } : {}), ...result };
  }, { overlay: false, runtimeProfile: 'jar1', now: () => now });
  for (const key of ['MSB_SESSION_DIR', 'IIA_SESSION_DIR', 'AUTONOMY_DIR', 'AUTONOMY_DAILY_CAP_USD',
    'AUTONOMY_DAILY_CAP_TOKENS', 'AUTONOMY_RESERVE_FRACTION', 'AUTONOMY_MAX_ACTIONS']) delete process.env[key];
  process.env.AUTONOMY_ENABLED = '1';
  process.env[runCap] = '40';
  await saveState({ ...(await loadState()).state, chatId: 42, userId: 42, costHistory: { '2026-11-08': 1.25 } });
  const root = botRoot();
  const file = path.join(root, '.env');
  const box = path.join(msbRoot(), '.env');
  const sibling = path.join(msbRoot(), 'bots', 'other');
  const siblingFile = path.join(sibling, '.env');
  await fs.mkdir(path.join(sibling, 'autonomy'), { recursive: true });
  await fs.writeFile(file, initial);
  await fs.writeFile(box, runCap + '=99\n');
  await fs.writeFile(siblingFile, runCap + '=55\n');
  await fs.writeFile(path.join(sibling, 'autonomy', 'runs.jsonl'), JSON.stringify({
    ts: at, actionId: 'sibling', status: 'ok', costUsd: 0, tokensIn: 0,
  }) + '\n');
  const bytes = () => fs.readFile(file, 'utf8');
  const refusal = () => readReminderRefusal({ id: 'fixture-reminder' }, at);
  const value = async (key = runCap) => (await readEnvMap()).map.get(key);
  const untouched = async () => {
    assert.equal(await fs.readFile(box, 'utf8'), runCap + '=99\n');
    assert.equal(await fs.readFile(siblingFile, 'utf8'), runCap + '=55\n');
    const { state } = await loadState();
    assert.equal(state.dailySpendLimit, 10);
    assert.deepEqual(state.costHistory, { '2026-11-08': 1.25 });
  };
  async function ask(result, input = 'Измени лимит автономки', { chatId = 42, threadId } = {}) {
    const start = f.edits.length;
    output = result;
    await f.bot.handleUpdate({ message: { message_id: 99, text: input, from: { id: 42 }, chat: { id: chatId },
      ...(threadId ? { message_thread_id: threadId } : {}) } });
    return until(() => f.edits.slice(start).find(row => row.includes('⏱') || row.includes('Ошибка хода') || row.includes('Моя остановочка')),
      'final Telegram answer is missing');
  }
  const question = () => f.messages.findLastIndex(row => row === questionText) + 1;
  const click = (data, { bot = f.bot, user = 42, chat = 42, messageId = question(), body = questionText } = {}) =>
    bot.handleUpdate({ callback_query: { id: 'fixture-click', data, from: { id: user },
      message: { message_id: messageId, chat: { id: chat }, text: body } } });
  const toast = () => f.callbackAnswers.at(-1)?.[0]?.text;
  return { ...f, root, file, bytes, refusal, value, untouched, ask, question, click, toast };
}

test('valid conversational limits use the bot writer and are immediately visible to admission', async t => {
  const f = await profile(t);
  assert.equal(await f.refusal(), undefined);
  const reply = await f.ask(['[SET_LIMIT DAILY_CAP_RUNS 1.2]', '[SET_LIMIT daily_cap_usd 2.75]',
    '[SET_LIMIT daily_cap_tokens 12000.4]', '[SET_LIMIT reserve_fraction 0.26]', '[SET_LIMIT max_actions 5.7]'].join('\n'));
  assert.match(reply, /Готово: дневной запас ходов теперь 1\./);
  assert.match(reply, /дневной предел расходов автономки теперь \$2\.75\./);
  assert.match(reply, /дневной запас чтения теперь 12 тысяч токенов\./);
  assert.match(reply, /резерв на разговор теперь 26%\./);
  assert.match(reply, /предел активных задач теперь 6\./);
  assert.doesNotMatch(reply, /\[SET_LIMIT/);
  for (const [key, value] of Object.entries({ [runCap]: '1', AUTONOMY_DAILY_CAP_USD: '2.75',
    AUTONOMY_DAILY_CAP_TOKENS: '12000', AUTONOMY_RESERVE_FRACTION: '0.26', AUTONOMY_MAX_ACTIONS: '6' })) {
    assert.equal(await f.value(key), value);
    assert.equal(process.env[key], value);
  }
  assert.match(await f.bytes(), /# комментарий к профилю/);
  assert.equal(await f.value('FIXTURE_SETTING'), 'preserve');
  assert.match((await f.refusal()).detail, /весь дневной запас \(1\)/);
  await f.untouched();
});

test('unknown, extra, nonfinite and out-of-range limit requests are refused without writes', async t => {
  const f = await profile(t);
  const reply = await f.ask(['[SET_LIMIT constructor 1]', '[SET_LIMIT max_actions 5 extra]',
    '[SET_LIMIT daily_cap_runs Infinity]', '[SET_LIMIT daily_cap_usd 1001]',
    '[SET_LIMIT daily_cap_tokens 100000001]', '[SET_LIMIT reserve_fraction 0.91]', '[SET_LIMIT max_actions -1]'].join('\n'));
  for (const refusal of [/Не понял, какой предел менять/, /от 0 до 10000\./, /от 0 до 1000 долларов/,
    /от 0 до 100 миллионов/, /от 0 до 0\.9/, /от 0 до 200/, /Ноль снимает предел совсем/]) assert.match(reply, refusal);
  assert.match(reply, /⚠ Не выполнено/);
  assert.doesNotMatch(reply, /\[SET_LIMIT/);
  assert.equal(await f.bytes(), initial);
  assert.equal(f.question(), 0);
  await f.untouched();
});

test('a rounded zero waits for the owner and the exact Telegram question, including after bot restart', async t => {
  const f = await profile(t);
  const reply = await f.ask('Готово, снял предел.\n[SET_LIMIT daily_cap_runs 0.4]', 'Сними лимит ходов', { chatId: -10042, threadId: 73 });
  assert.match(reply, /Спросил подтверждение ниже — сниму предел по кнопке/);
  assert.doesNotMatch(reply, /Готово, снял предел/);
  const messageId = f.question();
  assert.ok(messageId);
  assert.equal(f.messageOptions[messageId - 1].message_thread_id, 73);
  const published = f.markupEdits.findLast(edit => edit.chatId === -10042 && edit.messageId === messageId);
  const keyboard = published?.options.reply_markup ?? f.messageOptions[messageId - 1].reply_markup;
  assert.deepEqual(keyboard.inline_keyboard[0], [
    { text: 'Снять предел', callback_data: confirm }, { text: 'Оставить', callback_data: keep },
  ]);
  assert.equal(await f.bytes(), initial);
  const clicks = f.callbackAnswers.length;
  await f.click(confirm, { chat: -10042, user: 99 });
  assert.equal(f.callbackAnswers.length, clicks);
  await f.click(confirm, { chat: 42 });
  await f.click(confirm, { chat: -10042, messageId: messageId + 100 });
  await f.click(otherCap, { chat: -10042 });
  assert.equal(await f.bytes(), initial);

  const bot = createBot({ botToken: 'fake', botId: 'default', adminId: 42, workspace: f.workspace, timezone: 'Europe/Moscow' }, {
    bot: new f.bot.constructor(), runTurn: () => assert.fail('Owner callback must not invoke a model'), now: () => now,
  });
  t.after(() => bot.stop());
  await f.click(confirm, { bot, chat: -10042 });
  assert.equal(await f.value(), '0');
  assert.equal(process.env[runCap], '0');
  assert.equal(f.toast(), 'Снял');
  assert.match(f.edits.at(-1), /Снять дневной запас ходов совсем\?.*Снял дневной запас ходов\./s);
  assert.deepEqual(f.editOptions.at(-1).reply_markup.inline_keyboard, []);
  await f.ask('[SET_LIMIT daily_cap_runs 1]');
  await f.click(confirm, { chat: -10042 });
  assert.equal(await f.value(), '1', 'consumed question cannot remove a later value');
  await f.untouched();
});

test('Keep closes only the matched question and leaves the legacy timer Keep route intact', async t => {
  const f = await profile(t);
  const timers = path.join(f.root, 'schedules.json');
  const rows = [{ id: 'legacy', name: 'Таймер', enabled: true, type: 'once', at: '2026-11-09T12:00:00.000Z', prompt: 'Старый' }];
  await fs.writeFile(timers, JSON.stringify(rows));
  await f.ask('[STOP_ALL]\n[SET_LIMIT daily_cap_runs 0]');
  const timerId = f.messages.findIndex(row => row.startsWith('Таймеры с прошлой настройки')) + 1;
  assert.ok(timerId);
  assert.ok(f.question() > timerId);
  await f.click(keep);
  assert.equal(f.toast(), 'Оставил');
  assert.match(f.edits.at(-1), /Снять дневной запас ходов совсем\?.*✔ Оставил на месте/s);
  await f.click(confirm);
  assert.equal(await f.bytes(), initial);
  await f.click(keep, { messageId: timerId, body: f.messages[timerId - 1] });
  assert.equal(f.toast(), 'Оставил');
  assert.match(f.edits.at(-1), /Таймеры с прошлой настройки.*✔ Оставил на месте/s);
  await f.click('tmr-stop', { messageId: timerId });
  assert.deepEqual(JSON.parse(await fs.readFile(timers, 'utf8')), rows);
});

test('a failed Telegram question does not announce confirmation or grant a zero write', async t => {
  const f = await profile(t);
  const send = f.bot.api.sendMessage;
  f.bot.api.sendMessage = async (chat, text, ...options) => {
    if (text === questionText) throw new Error('Telegram fixture refused');
    return send(chat, text, ...options);
  };
  const reply = await f.ask('[SET_LIMIT daily_cap_runs 0]');
  assert.match(reply, /Снятие предела подтверждается кнопкой, а спросить сейчас не получилось/);
  assert.doesNotMatch(reply, /Спросил подтверждение ниже/);
  await f.click(confirm, { messageId: f.messages.length });
  assert.equal(await f.bytes(), initial);
});

test('an env IO failure is reported and a confirmed limit can be retried safely', async t => {
  const f = await profile(t);
  await f.ask('[SET_LIMIT daily_cap_runs 0]');
  const messageId = f.question();
  assert.ok(messageId);
  await fs.rename(f.file, f.file + '.saved');
  await fs.mkdir(f.file);
  const reply = await f.ask('Готово, поменял.\n[SET_LIMIT daily_cap_usd 3]');
  assert.match(reply, /Не удалось изменить предел автономки/);
  assert.doesNotMatch(reply, /Готово, поменял/);
  await f.click(confirm, { messageId });
  assert.match(f.toast(), /Не смог снять предел/);
  assert.equal(process.env[runCap], '40');
  await fs.rmdir(f.file);
  await fs.rename(f.file + '.saved', f.file);
  await f.click(confirm, { messageId });
  assert.equal(await f.value(), '0');
});

test('quoted and incoming markers, disabled autonomy, and a late other engine do not write', async t => {
  const f = await profile(t);
  await f.ask('«[SET_LIMIT daily_cap_runs 0]»\n```text\n[SET_LIMIT max_actions 6]\n```', 'Покажи [SET_LIMIT daily_cap_runs 1]');
  assert.equal(f.question(), 0);
  assert.equal(await f.bytes(), initial);
  process.env.AUTONOMY_ENABLED = '0';
  const disabled = await f.ask('[SET_LIMIT daily_cap_runs 1]');
  assert.match(disabled, /Автономные задачи сейчас выключены/);
  process.env.AUTONOMY_ENABLED = '1';
  const switched = await f.ask(async () => {
    await updateState(state => { state.engine = 'oc'; });
    return { ok: true, text: '[SET_LIMIT daily_cap_runs 1]' };
  });
  assert.match(switched, /на этом движке пока не подключено/);
  assert.equal(await f.bytes(), initial);
  await f.untouched();
});

test('the first visible zero keyboard is already bound, even before the transport returns', async t => {
  const f = await profile(t);
  const publish = f.bot.api.editMessageReplyMarkup;
  const send = f.bot.api.sendMessage;
  let clicked = false;
  async function clickVisible(chat, messageId, options) {
    if (options?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data !== confirm) return;
    clicked = true;
    await f.click(confirm, { chat, messageId });
  }
  f.bot.api.sendMessage = async (chat, text, options, signal) => {
    const result = await send(chat, text, options, signal);
    await clickVisible(chat, result.message_id, options);
    return result;
  };
  f.bot.api.editMessageReplyMarkup = async (chat, messageId, options, signal) => {
    await publish(chat, messageId, options, signal);
    await clickVisible(chat, messageId, options);
  };
  await f.ask('[SET_LIMIT daily_cap_runs 0]');
  assert.ok(clicked);
  assert.equal(await f.value(), '0');
  assert.equal(f.toast(), 'Снял');
});

test('stopping during question delivery leaves no actionable limit confirmation', async t => {
  const f = await profile(t);
  const send = f.bot.api.sendMessage;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let started = false;
  f.bot.api.sendMessage = async (chat, text, ...options) => {
    if (text === questionText) {
      started = true;
      entered.resolve();
      await release.promise;
    }
    return send(chat, text, ...options);
  };
  const turn = f.ask('[SET_LIMIT daily_cap_runs 0]');
  try {
    await Promise.race([entered.promise, turn]);
    assert.ok(started, 'zero question must reach Telegram');
    await f.message('/stop');
  } finally {
    release.resolve();
  }
  assert.match(await turn, /Моя остановочка/);
  const messageId = f.question();
  assert.ok(messageId);
  await f.click(confirm, { messageId });
  assert.equal(await f.bytes(), initial);
  assert.equal(process.env[runCap], '40');
});
