/**
 * Old timer commands through Telegram, the real schedules writer and due
 * admission. [Source proof](./reference/parity-autonomy-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { dispatchLegacyTimers } from '../src/autonomy/legacy-dispatch.mjs';
import { actionRoot } from '../src/paths.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { mcpFixture } from './helpers/mcp-fixture.mjs';
import { nativeFixtures } from './helpers/mcp-launch-fixture.mjs';
import { chat, reminderFixture, until } from './helpers/reminder-registration-fixture.mjs';

const now = Date.parse('2026-11-08T10:00:00.000Z');
const stamp = '2026-11-07T10:00:00.000Z';
const once = { id: 'Exact-ID', name: 'Письмо', type: 'once', at: '2026-11-08T11:30:00.000Z',
  prompt: 'Проверить архив', enabled: true, delivery: { topic: 18 } };
const daily = { id: 'daily', name: 'Почта утром', type: 'daily', hour: 13, minute: 0,
  prompt: 'Утренний отчёт', enabled: false };
const weekly = { id: 'weekly', name: 'Почта в неделю', type: 'weekly', hour: 23, minute: 45, weekdays: [1, 7],
  prompt: 'Свести итоги', enabled: true };
const action = { id: 'action', name: 'Обычная задача', enabled: true, trigger: { kind: 'interval', intervalMinutes: 60 },
  task: { kind: 'reminder', text: 'Обычная задача' } };
const request = 'Управляй прежним таймером';
const timerCommand = (name, selector) => '[TIMER_' + name + ': ' + selector + ']';

async function profile(t, { output = '[LIST_TIMERS]', timers = [once, daily, weekly], enabled = '1' } = {}) {
  const f = await reminderFixture(t, { output, enabled });
  const put = records => fs.writeFile(f.schedules, JSON.stringify(records));
  if (timers !== null) await put(timers);
  await fs.writeFile(f.actionFile, JSON.stringify([action]));
  const autonomy = path.join(f.directory, 'autonomy');
  await fs.mkdir(autonomy, { recursive: true });
  const journal = path.join(autonomy, 'runs.jsonl');
  const stop = path.join(autonomy, 'STOP');
  await fs.writeFile(journal, '{"fixture":"journal"}\n');
  const stable = [f.actionFile, journal, f.storeFile];
  const bytes = () => Promise.all(stable.map(file => fs.readFile(file)));
  const before = await bytes();
  const question = (prefix = 'Удалить таймер «') => f.messages.findLastIndex(text => text.startsWith(prefix)) + 1;
  const keyboard = id => f.markupEdits.findLast(entry => entry.messageId === id)?.options.reply_markup.inline_keyboard;
  const toast = () => f.callbackAnswers.at(-1)?.[0]?.text;
  const click = (data, { messageId = question(), chatId = chat, uid = 42 } = {}) =>
    f.bot.handleUpdate({ callback_query: { id: 'legacy-timer-tap', data, from: { id: uid },
      message: { message_id: messageId, chat: { id: chatId }, message_thread_id: 17,
        text: f.messages[messageId - 1] ?? 'Чужая карточка' } } });
  async function turn() {
    const start = f.edits.length;
    await f.request(request);
    await until(() => f.edits.slice(start).some(text => text.includes('⏱')), 'timer reply did not finish');
    return f.edits.slice(start).find(text => text.includes('⏱'));
  }
  return { ...f, put, stop, question, keyboard, toast, click, turn,
    timers: async () => JSON.parse(await fs.readFile(f.schedules, 'utf8')),
    untouched: async () => assert.deepEqual(await bytes(), before) };
}

test('legacy timer conversation lists old once daily and weekly phrases in file order', async t => {
  const f = await profile(t);
  const before = await fs.readFile(f.schedules);
  const final = await f.turn();
  assert.match(final, /Таймеры с прошлой настройки \(3\):\n▶ «Письмо»: один раз, 2026-11-08T11:30:00.000Z Проверить архив\n⏸ «Почта утром»: каждый день в 13:00 Утренний отчёт \(выключен\)\n▶ «Почта в неделю»: по понедельникам, воскресеньям в 23:45 Свести итоги/);
  assert.equal(f.question(), 0);
  assert.deepEqual(await fs.readFile(f.schedules), before);
  await f.untouched();
});

test('legacy timer conversation lists an absent file without creating schedules', async t => {
  const f = await profile(t, { timers: null });
  assert.match(await f.turn(), /Таймеров с прошлой настройки нет/);
  await assert.rejects(fs.stat(f.schedules), { code: 'ENOENT' });
  await f.untouched();
});

test('legacy timer conversation reports a corrupt schedule without rewriting or claiming it is empty', async t => {
  const f = await profile(t, { output: '[LIST_TIMERS]\n[TIMER_OFF: daily]' });
  const bad = '[{"id":"daily"';
  await fs.writeFile(f.schedules, bad);
  const final = await f.turn();
  assert.match(final, /Не удалось показать таймеры/);
  assert.match(final, /Не удалось выключить таймер/);
  assert.doesNotMatch(final, /Таймеров с прошлой настройки нет/);
  assert.equal(await fs.readFile(f.schedules, 'utf8'), bad);
  await f.untouched();
});

test('legacy timer conversation chooses exact ID before matching names and updates the existing menu', async t => {
  const neighbor = { ...weekly, name: 'В имени Exact-ID' };
  const f = await profile(t, { timers: [once, neighbor], output: timerCommand('OFF', once.id) });
  assert.match(await f.turn(), /Готово: таймер «Письмо» выключил\. Включу словом/);
  assert.deepEqual(await f.timers(), [{ ...once, enabled: false, disabledBy: 'owner' }, neighbor]);
  await f.callback('auto:timer:Exact-ID');
  assert.match(f.edits.at(-1), /Статус: ⏸ выключен/);
  await f.callback('auto:timer-toggle:Exact-ID');
  assert.match(f.edits.at(-1), /✔ Письмо/);
  assert.deepEqual(await f.timers(), [{ ...once, disabledBy: 'owner' }, neighbor]);
  await f.untouched();
});

test('legacy timer conversation reports name ambiguity and ignores prompt or partial ID matches', async t => {
  const f = await profile(t, { output: '[TIMER_OFF: пОчТа]\n[TIMER_ON: архив]\n[TIMER_DELETE: Exact-]' });
  const final = await f.turn();
  assert.match(final, /Нашёл несколько таймеров, уточни:[\s\S]*«Почта утром»[\s\S]*«Почта в неделю»/);
  assert.match(final, /Не нашёл таймер «архив»/);
  assert.match(final, /Не нашёл таймер «Exact-»/);
  assert.equal(f.question(), 0);
  assert.deepEqual(await f.timers(), [once, daily, weekly]);
  await f.untouched();
});

test('legacy timer conversation applies list then off then on before asking for deletion', async t => {
  const f = await profile(t, { output: '[TIMER_DELETE: weekly]\n[TIMER_ON: daily]\n[TIMER_OFF: daily]\n[LIST_TIMERS]' });
  const final = await f.turn();
  assert.match(final, /Готово: таймер «Почта утром» снова работает/);
  assert.match(final, /Таймер «Почта утром» уже выключен/);
  assert.match(final, /⏸ «Почта утром»: каждый день в 13:00 Утренний отчёт \(выключен\)/);
  assert.match(final, /Спросил подтверждение ниже, удалю по кнопке/);
  assert.ok(f.question());
  assert.deepEqual(await f.timers(), [once, { ...daily, enabled: true }, weekly]);
  await f.untouched();
});

test('legacy timer conversation off after group STOP becomes manual and survives global resume', async t => {
  let reply = '[STOP_ALL]';
  const f = await profile(t, { timers: [{ ...daily, enabled: true }, weekly],
    output: () => ({ ok: true, text: reply }) });
  assert.match(await f.turn(), /Автономка остановлена/);
  const question = f.question('Таймеры с прошлой настройки продолжают работать');
  assert.ok(question);
  await f.click('tmr-stop', { messageId: question });
  assert.equal(f.toast(), 'Остановил');
  assert.deepEqual((await f.timers()).map(timer => timer.disabledBy), ['stop', 'stop']);
  reply = '[TIMER_OFF: daily]';
  assert.match(await f.turn(), /Таймер «Почта утром» уже выключен/);
  assert.deepEqual((await f.timers()).map(timer => timer.disabledBy), ['owner', 'stop']);
  reply = '[RESUME_ALL]';
  assert.match(await f.turn(), /Таймеры, остановленные вместе со всеми, снова работают \(1\)/);
  assert.deepEqual(await f.timers(), [{ ...daily, disabledBy: 'owner' }, weekly]);
  await f.untouched();
});

test('legacy timer conversation can enable one timer under STOP without rearming a consumed one-off', async t => {
  const used = { ...once, enabled: false, lastRunAt: stamp, disabledBy: 'owner' };
  const f = await profile(t, { timers: [{ ...daily, disabledBy: 'stop' }, used],
    output: '[TIMER_ON: daily]\n[TIMER_ON: Exact-ID]' });
  await fs.writeFile(f.stop, 'existing stop');
  const final = await f.turn();
  assert.match(final, /Готово: таймер «Почта утром» снова работает/);
  assert.match(final, /Готово: таймер «Письмо» снова работает/);
  assert.deepEqual(await f.timers(), [{ ...daily, enabled: true }, { ...once, lastRunAt: stamp }]);
  const due = f.scheduler();
  await due.tickNow();
  await until(() => f.modelCalls.some(args => args.isAutoTurn), 'enabled legacy timer did not reach the queue');
  f.setTime(Date.parse(once.at));
  await due.tickNow();
  assert.deepEqual(f.modelCalls.filter(args => args.isAutoTurn).map(args => args.prompt),
    ['⏰ Таймер "Почта утром":\nУтренний отчёт']);
  assert.equal(await fs.readFile(f.stop, 'utf8'), 'existing stop');
  await f.untouched();
});

test('legacy timer conversation enables a record whose old enabled flag is missing only on explicit ON', async t => {
  const { enabled, ...stored } = daily;
  const f = await profile(t, { timers: [stored], output: '[TIMER_ON: daily]\n[LIST_TIMERS]' });
  const final = await f.turn();
  assert.match(final, /⏸ «Почта утром»/);
  assert.match(final, /Готово: таймер «Почта утром» снова работает/);
  assert.deepEqual(await f.timers(), [{ ...daily, enabled: true }]);
  await f.untouched();
});

test('legacy timer conversation group pause and resume cannot arm a timer with a missing flag', async t => {
  const { enabled, ...stored } = daily;
  let reply = '[STOP_ALL]';
  const f = await profile(t, { timers: [stored, weekly], output: () => ({ ok: true, text: reply }) });
  assert.match(await f.turn(), /Автономка остановлена/);
  const question = f.question('Таймеры с прошлой настройки продолжают работать');
  assert.ok(question);
  const original = f.messages[question - 1];
  await f.click('tmr-stop', { messageId: question });
  reply = '[RESUME_ALL]';
  const final = await f.turn();
  assert.deepEqual(await f.timers(), [stored, weekly]);
  assert.match(original, /продолжают работать \(1\)/);
  assert.match(final, /снова работают \(1\)/);
  await f.untouched();
});

test('legacy timer conversation OFF invalidates a due snapshot before dispatch reserves it', async t => {
  const f = await profile(t, { timers: [{ ...daily, enabled: true }], output: '[TIMER_OFF: daily]' });
  const originalLstat = fs.lstat;
  const held = Promise.withResolvers();
  let waiting = false, reserved = 0;
  t.mock.method(fs, 'lstat', async (file, ...rest) => {
    if (!waiting && path.basename(file) === 'sleep.default') {
      waiting = true;
      await held.promise;
    }
    return originalLstat(file, ...rest);
  });
  const tick = dispatchLegacyTimers({ now: () => now, timezone: 'Europe/Moscow', isInterrupted: () => false,
    scheduledTurns: { reserve() { reserved++; return () => {}; } } });
  try {
    await until(() => waiting, 'due snapshot did not reach the sleep check');
    assert.match(await f.turn(), /выключил/);
  } finally {
    held.resolve();
    await tick;
  }
  assert.equal(reserved, 0);
  assert.deepEqual(await f.timers(), [{ ...daily, disabledBy: 'owner' }]);
  await f.untouched();
});

test('legacy timer conversation shows the old topic delete card and only its owner-bound tap can remove', async t => {
  const longPrompt = 'x'.repeat(100);
  const current = { ...once, prompt: '  ' + longPrompt + ' beyond limit' };
  const f = await profile(t, { timers: [current, weekly], output: '[TIMER_DELETE: Exact-ID]' });
  assert.match(await f.turn(), /Спросил подтверждение ниже, удалю по кнопке/);
  const question = f.question();
  assert.ok(question);
  assert.equal(f.messages[question - 1], 'Удалить таймер «Письмо» насовсем? Он один раз, ' + once.at +
    ': ' + longPrompt + '. Вернуть будет нельзя.');
  assert.equal(f.messageOptions[question - 1].message_thread_id, 17);
  assert.deepEqual(f.keyboard(question), [[{ text: 'Удалить ✖', callback_data: 'tmr-del:Exact-ID' },
    { text: 'Оставить', callback_data: 'ct-keep' }]]);
  const count = f.callbackAnswers.length;
  await f.click('tmr-del:Exact-ID', { uid: 99 });
  assert.equal(f.callbackAnswers.length, count);
  for (const args of [['tmr-del:Exact-ID', { chatId: 42 }], ['tmr-del:Exact-ID', { messageId: question + 100 }], ['tmr-del:weekly']]) {
    await f.click(...args);
    assert.equal(f.toast(), 'Подтверждение устарело');
  }
  assert.deepEqual(await f.timers(), [current, weekly]);
  // A due attempt and switching the shared timer profile's active engine
  // do not replace the timer definition that the owner saw.
  await f.put([{ ...current, enabled: false, lastRunAt: stamp }, weekly]);
  await saveState({ ...(await loadState()).state, engine: 'oc' });
  await f.click('tmr-del:Exact-ID');
  assert.equal(f.toast(), 'Удалил');
  assert.match(f.edits.at(-1), /Готово: таймер «Письмо» удалён/);
  assert.deepEqual(f.editOptions.at(-1).reply_markup.inline_keyboard, []);
  assert.deepEqual(await f.timers(), [weekly]);
  await f.untouched();
});

test('legacy timer conversation Keep closes only its question and later delete cannot remove the timer', async t => {
  const f = await profile(t, { output: '[TIMER_DELETE: Exact-ID]' });
  await f.turn();
  assert.ok(f.question());
  await f.click('ct-keep');
  assert.equal(f.toast(), 'Оставил');
  assert.match(f.edits.at(-1), /✔ Оставил на месте/);
  await f.click('tmr-del:Exact-ID');
  assert.equal(f.toast(), 'Подтверждение устарело');
  assert.deepEqual(await f.timers(), [once, daily, weekly]);
  await f.untouched();
});

test('legacy timer conversation rejects a same-ID replacement and physical schedule swap', async t => {
  const f = await profile(t, { output: '[TIMER_DELETE: Exact-ID]' });
  await f.turn();
  assert.ok(f.question());
  const replacement = { ...once, prompt: 'Новая инструкция' };
  await f.put([replacement]);
  await f.click('tmr-del:Exact-ID');
  assert.equal(f.toast(), 'Подтверждение устарело');
  assert.deepEqual(await f.timers(), [replacement]);
  await f.turn();
  const original = path.join(f.directory, 'schedules-before.json');
  const alternate = path.join(f.directory, 'schedules-alternate.json');
  await fs.rename(f.schedules, original);
  await fs.writeFile(alternate, JSON.stringify([replacement]));
  await fs.symlink(alternate, f.schedules);
  await f.click('tmr-del:Exact-ID');
  assert.equal(f.toast(), 'Подтверждение устарело');
  assert.deepEqual(JSON.parse(await fs.readFile(original, 'utf8')), [replacement]);
  assert.deepEqual(JSON.parse(await fs.readFile(alternate, 'utf8')), [replacement]);
  await f.untouched();
});

test('legacy timer conversation uses a bounded full reference for long Unicode IDs', async t => {
  const prefix = 'таймер-'.repeat(15);
  const selected = { ...once, id: prefix + 'a' };
  const neighbor = { ...weekly, id: prefix + 'b' };
  const f = await profile(t, { output: timerCommand('DELETE', selected.id), timers: [selected, neighbor] });
  await f.turn();
  const callback = f.keyboard(f.question())?.[0]?.[0]?.callback_data;
  assert.ok(callback?.startsWith('tmr-del:'));
  assert.ok(Buffer.byteLength(callback, 'utf8') <= 64);
  await f.click(callback);
  assert.equal(f.toast(), 'Удалил');
  assert.deepEqual(await f.timers(), [neighbor]);
  await f.untouched();
});

test('legacy timer conversation can retry when atomic removal fails before publication', async t => {
  const f = await profile(t, { output: '[TIMER_DELETE: Exact-ID]' });
  await f.turn();
  assert.ok(f.question());
  const physical = await fs.realpath(f.schedules);
  const originalRename = fs.rename;
  let reject = true;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (reject && to === physical) throw new Error('fixture schedules publish failed');
    return originalRename(from, to);
  });
  await f.click('tmr-del:Exact-ID');
  assert.match(f.toast(), /Не смог удалить/);
  assert.deepEqual(await f.timers(), [once, daily, weekly]);
  reject = false;
  await f.click('tmr-del:Exact-ID');
  assert.equal(f.toast(), 'Удалил');
  assert.deepEqual(await f.timers(), [daily, weekly]);
  await f.untouched();
});

test('legacy timer conversation cannot replay a completed removal after a retirement failure', async t => {
  const f = await profile(t, { timers: [once], output: '[TIMER_DELETE: Exact-ID]' });
  await f.turn();
  assert.ok(f.question());
  const originalRename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(to) === 'legacy-timer-delete-questions.json' &&
        JSON.parse(await fs.readFile(from, 'utf8')).length === 0) throw new Error('fixture retirement failed');
    return originalRename(from, to);
  });
  await f.click('tmr-del:Exact-ID');
  assert.equal(f.toast(), 'Удалил');
  assert.deepEqual(await f.timers(), []);
  await f.put([once]);
  await f.click('tmr-del:Exact-ID');
  assert.equal(f.toast(), 'Подтверждение устарело');
  assert.deepEqual(await f.timers(), [once]);
  await f.untouched();
});

test('legacy timer conversation cannot rearm a delete after the schedule lock fails to release', async t => {
  const f = await profile(t, { timers: [once], output: '[TIMER_DELETE: Exact-ID]' });
  await f.turn();
  assert.ok(f.question());
  const Database = createRequire(import.meta.url)('better-sqlite3');
  const { DatabaseSync } = await import('node:sqlite').catch(error => {
    if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error;
    return {};
  });
  const drivers = [[Database.prototype, db => db.name]];
  if (DatabaseSync) drivers.push([DatabaseSync.prototype, db => db.location?.('main')]);
  let injected = false;
  for (const [prototype, fileName] of drivers) {
    const exec = prototype.exec;
    t.mock.method(prototype, 'exec', function (sql, ...rest) {
      const result = exec.call(this, sql, ...rest);
      if (!injected && sql === 'ROLLBACK;' && path.basename(fileName(this) ?? '') === 'schedules.json.lock.sqlite') {
        injected = true;
        throw new Error('fixture release failure after schedules publication');
      }
      return result;
    });
  }
  await f.click('tmr-del:Exact-ID');
  assert.ok(injected, 'schedules lock release was not tested');
  const firstToast = f.toast();
  assert.deepEqual(await f.timers(), []);
  await f.put([once]);
  await f.click('tmr-del:Exact-ID');
  assert.equal(f.toast(), 'Подтверждение устарело');
  assert.deepEqual(await f.timers(), [once]);
  assert.equal(firstToast, 'Удалил');
  await f.untouched();
});

test('legacy timer conversation accepts the old line break before and after the selector', async t => {
  const f = await profile(t, { output: '[TIMER_OFF:\n Exact-ID \n]' });
  const final = await f.turn();
  assert.match(final, /Готово: таймер «Письмо» выключил/);
  assert.doesNotMatch(final, /Exact-ID \n\]/);
  assert.deepEqual(await f.timers(), [{ ...once, enabled: false, disabledBy: 'owner' }, daily, weekly]);
  await f.untouched();
});

test('legacy timer conversation treats a literal quote in the selector as timer data', async t => {
  const named = { ...once, name: 'Письмо " архив' };
  const f = await profile(t, { timers: [named, daily],
    output: '[TIMER_OFF: Письмо " архив]\n[TIMER_ON: daily]\nСледующая "фраза".' });
  const final = await f.turn();
  assert.match(final, /«Письмо " архив» выключил/);
  assert.match(final, /«Почта утром» снова работает/);
  assert.deepEqual(await f.timers(), [{ ...named, enabled: false, disabledBy: 'owner' }, { ...daily, enabled: true }]);
  await f.untouched();
});

test('legacy timer conversation keeps quoted and nested doors out of the writer', async t => {
  const f = await profile(t, { output: 'Пример "[TIMER_ON: daily]".\n' +
    '[TIMER_OFF: [PAUSE_TASK: action] [\n[LIST_TIMERS]' });
  const final = await f.turn();
  assert.match(final, /Уточни, какой таймер/);
  assert.match(final, /⏸ «Почта утром»/);
  assert.doesNotMatch(final, /«Обычная задача» на паузе/);
  assert.deepEqual(await f.timers(), [once, daily, weekly]);
  await f.untouched();
});

test('legacy timer conversation leaves timer syntax inside original saved work data', async t => {
  const body = 'Покажи дословно [TIMER_ON: daily]';
  const f = await profile(t, { output: '[EDIT_TASK: action]' + body + '[/EDIT_TASK]\n[LIST_TIMERS]' });
  const final = await f.turn();
  assert.match(final, /Готово: у «Обычная задача» новый текст/);
  assert.match(final, /Таймеры с прошлой настройки \(3\)/);
  assert.equal((await f.records())[0].task.text, body);
  assert.deepEqual(await f.timers(), [once, daily, weekly]);
});

for (const provider of ['claude', 'codex']) {
  test(provider + ' legacy timer conversation prompt and owner turn reach the shared schedule', async t => {
    const f = await mcpFixture(t, provider, { runTurn: runAgentTurn });
    const native = await nativeFixtures(f);
    process.env.AUTONOMY_ENABLED = '1';
    const file = path.join(actionRoot(), 'schedules.json');
    await fs.writeFile(file, JSON.stringify([daily]));
    await native.respond('[TIMER_ON: daily]');
    await f.message(request);
    await until(() => f.edits.some(text => text.includes('⏱')), 'provider did not finish', 10_000);
    const call = (await native.trace()).at(-1);
    const prompt = provider === 'claude' ? call.argv[call.argv.indexOf('--append-system-prompt') + 1] : call.prompt;
    for (const marker of ['[LIST_TIMERS]', '[TIMER_OFF:', '[TIMER_ON:', '[TIMER_DELETE:']) assert.ok(prompt.includes(marker));
    assert.match(f.edits.at(-1), /Готово: таймер «Почта утром» снова работает/);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), [{ ...daily, enabled: true }]);
  });
}
