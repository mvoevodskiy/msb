/**
 * Old per-bot stop/resume at production Telegram ingress and scheduler.
 * Old readable blob 73aa9e7e850bad7ac1ea8a8091d086ecbfd47a11:
 * 11284–11444, 24316–24426, 26785–26811 and 113415–113446.
 * Disposable profiles, owned fake Telegram and CLI only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startScheduler } from '../src/autonomy/scheduler.mjs';
import { addTask, listTasks } from '../src/autonomy/store.mjs';
import { botRoot } from '../src/paths.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { fixture } from './helpers/menu-fixture.mjs';

const instant = Date.parse('2026-11-08T12:00:00.000Z');
const due = new Date(instant).toISOString();
const future = new Date(instant + 60 * 60_000).toISOString();
const pending = {
  id: 'old-once', name: 'Встретить поезд', enabled: true,
  trigger: { kind: 'once', at: due },
  task: { kind: 'reminder', text: 'Встретить поезд' }, runner: 'auto',
};
const savedTimers = [
  { id: 'legacy-on', name: 'Активный', enabled: true, type: 'once', at: future, prompt: 'Текст таймера' },
  { id: 'legacy-off', name: 'Выключенный вручную', enabled: false, disabledBy: 'owner', type: 'daily', hour: 9 },
  { id: 'legacy-spent', name: 'Уже сработал', enabled: false, type: 'once', at: due, lastRunAt: due },
];

async function until(read, message) {
  const deadline = Date.now() + 3000;
  while (!read()) {
    if (Date.now() >= deadline) assert.fail(message);
    await delay(5);
  }
}

async function profile(t, { enabled = '1', engine = 'cc' } = {}) {
  let answer = '';
  const modelCalls = [];
  const f = await fixture(t, async args => {
    modelCalls.push(args);
    const { state } = await loadState();
    const text = typeof answer === 'function' ? await answer() : answer;
    return { ok: true, text, ...(state.engine === 'cc' ? { reminderRail: 'cc' } : {}) };
  }, { overlay: false, runtimeProfile: 'jar1', now: () => instant });
  for (const key of ['MSB_SESSION_DIR', 'IIA_SESSION_DIR', 'AUTONOMY_DIR']) delete process.env[key];
  process.env.AUTONOMY_ENABLED = enabled;
  await saveState({ ...(await loadState()).state, engine, chatId: 42, userId: 42, timezone: 'Europe/Moscow' });
  const root = botRoot();
  const stopFile = path.join(root, 'autonomy', 'STOP');
  const remoteFile = path.join(root, 'remote-config.json');
  const actionFile = path.join(root, 'actions.json');
  const timerFile = path.join(root, 'schedules.json');
  async function ask(response, input = 'Команда владельца') {
    const index = f.edits.length;
    answer = response;
    await f.message(input);
    let final;
    await until(() => final = f.edits.slice(index).find(row => row.includes('⏱')), 'final Telegram answer is missing');
    return final;
  }
  function scheduler(runTurn = async () => ({ ok: true, text: 'Итог интервала' })) {
    const instance = startScheduler({ api: f.bot.api, adminId: 42, timezone: 'Europe/Moscow',
      scheduledTurns: f.bot[Symbol.for('msb.scheduledTurns')], now: () => instant, runTurn, log() {} });
    t.after(() => instance.stop());
    return instance;
  }
  const writeActions = rows => fs.writeFile(actionFile, JSON.stringify(rows));
  const writeTimers = rows => fs.writeFile(timerFile, JSON.stringify(rows));
  const readTimers = async () => JSON.parse(await fs.readFile(timerFile, 'utf8'));
  const writeRemote = data => fs.writeFile(remoteFile, JSON.stringify(data));
  const delivered = () => f.messages.filter(text => text === '⏰ Встретить поезд');
  return { ...f, root, stopFile, actionFile, timerFile, remoteFile, ask, scheduler, modelCalls,
    writeActions, writeTimers, readTimers, writeRemote, delivered };
}

test('owner pause is persistent and per bot, preserves due actions and resumes direct delivery', async t => {
  const f = await profile(t);
  await f.writeActions([pending]);
  const actionBytes = await fs.readFile(f.actionFile);
  const sibling = path.join(path.dirname(f.root), 'another', 'autonomy', 'STOP');
  await fs.mkdir(path.dirname(sibling), { recursive: true });
  await fs.writeFile(sibling, 'sibling pause\n');
  const interval = await addTask({ id: 'interval', title: 'Проверка', prompt: 'Проверить', nextAt: instant - 1 });
  let intervals = 0;
  const scheduler = f.scheduler(async () => { intervals++; return { ok: true, text: 'Готово' }; });
  const answer = await f.ask('[STOP_ALL]', 'Останови все фоновые задачи');
  assert.match(answer, /⛔ Автономка остановлена/);
  assert.match(answer, /Задач сохранено: 2/);
  assert.doesNotMatch(answer, /\[STOP_ALL\]/);
  assert.equal(await fs.readFile(f.stopFile, 'utf8'), 'владелец сказал остановить\n' + due + '\n');
  const mode = (await fs.stat(f.stopFile)).mode & 0o777;
  assert.equal(mode, 0o600);
  await scheduler.tickNow();
  assert.deepEqual(f.delivered(), []);
  assert.equal(intervals, 0);
  assert.deepEqual(await listTasks(), [interval]);
  assert.deepEqual(await fs.readFile(f.actionFile), actionBytes);
  await f.callback('auto:tasks');
  assert.match(f.edits.at(-1), /Всё на паузе: ни одна из них сейчас не сработает/);

  await scheduler.stop();
  const restarted = f.scheduler(async () => { intervals++; return { ok: true, text: 'Готово' }; });
  await restarted.tickNow();
  assert.deepEqual(f.delivered(), []);
  assert.equal(intervals, 0);
  const resume = await f.ask('[RESUME_ALL]', 'Верни задачи в работу');
  assert.match(resume, /Снял паузу, задачи снова в работе \(2\)/);
  assert.match(resume, /Встретить поезд/);
  await assert.rejects(fs.stat(f.stopFile), { code: 'ENOENT' });
  await restarted.tickNow();
  await restarted.tickNow();
  assert.deepEqual(f.delivered(), ['⏰ Встретить поезд']);
  assert.equal(intervals, 1);
  assert.equal(await fs.readFile(sibling, 'utf8'), 'sibling pause\n');
});

test('legacy timers stay enabled until owner confirmation and only stop-disabled records resume', async t => {
  const f = await profile(t);
  await f.writeTimers(savedTimers);
  const answer = await f.ask('[STOP_ALL]', 'Поставь все фоновые задачи на паузу');
  assert.match(answer, /с прошлой настройки этим не остановлены/);
  assert.deepEqual(await f.readTimers(), savedTimers);
  const question = f.messages.findIndex(text => text === 'Таймеры с прошлой настройки продолжают работать (1). Остановить их тоже?');
  assert.ok(question >= 0);
  assert.deepEqual(f.messageOptions[question].reply_markup.inline_keyboard[0], [
    { text: '⏹ Остановить и таймеры тоже', callback_data: 'tmr-stop' },
    { text: 'Оставить', callback_data: 'ct-keep' },
  ]);
  await f.callback('tmr-stop', 99);
  assert.deepEqual(await f.readTimers(), savedTimers);
  await f.callback('ct-keep');
  assert.match(f.edits.at(-1), /✔ Оставил на месте/);
  assert.deepEqual(await f.readTimers(), savedTimers);
  await f.callback('tmr-stop');
  const [paused, ...unchanged] = await f.readTimers();
  assert.deepEqual(paused, { ...savedTimers[0], enabled: false, disabledBy: 'stop' });
  assert.deepEqual(unchanged, savedTimers.slice(1));
  assert.match(f.edits.at(-1), /таймеры тоже остановлены \(1\)/);
  const resume = await f.ask('[RESUME_ALL]', 'Верни всё в работу');
  assert.match(resume, /Таймеры, остановленные вместе со всеми, снова работают \(1\)/);
  assert.deepEqual(await f.readTimers(), savedTimers);
  await f.callback('tmr-stop');
  assert.deepEqual(await f.readTimers(), savedTimers, 'old confirmation must not pause a newly resumed timer');
});

test('first executable control wins and quoted markers have no effect', async t => {
  const f = await profile(t);
  const before = await f.ask('Пример «[STOP_ALL]»', 'Покажи пример');
  assert.doesNotMatch(before, /Автономка остановлена/);
  await assert.rejects(fs.stat(f.stopFile), { code: 'ENOENT' });
  const stopped = await f.ask('Пример «[RESUME_ALL]»\n[STOP_ALL]\n[RESUME_ALL]', 'Останови задачи');
  assert.match(stopped, /выполнил только «останови»/i);
  assert.equal(await fs.readFile(f.stopFile, 'utf8'), 'владелец сказал остановить\n' + due + '\n');
  const resumed = await f.ask('[RESUME_ALL]\n[STOP_ALL]', 'Продолжай');
  assert.match(resumed, /выполнил только «продолжай»/i);
  await assert.rejects(fs.stat(f.stopFile), { code: 'ENOENT' });
});

test('owner resume cannot clear a fleet pause or consume a due reminder', async t => {
  const f = await profile(t);
  await f.writeActions([pending]);
  const bytes = await fs.readFile(f.actionFile);
  await f.ask('[STOP_ALL]');
  const remote = { autonomyGlobalStop: true, other: 'keep' };
  await f.writeRemote(remote);
  const reply = await f.ask('[RESUME_ALL]');
  assert.match(reply, /общая пауза сервера остаётся/i);
  assert.doesNotMatch(reply, /задачи снова в работе/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.remoteFile, 'utf8')), remote);
  await assert.rejects(fs.stat(f.stopFile), { code: 'ENOENT' });
  await f.scheduler().tickNow();
  assert.deepEqual(f.delivered(), []);
  assert.deepEqual(await fs.readFile(f.actionFile), bytes);
});

test('owner pause aborts an active interval without advancing it or treating cancellation as failure', async t => {
  const f = await profile(t);
  const task = await addTask({ id: 'interval', title: 'Интервал', prompt: 'Долгая работа', nextAt: instant - 1 });
  let running, release;
  const instance = f.scheduler(({ signal }) => {
    running = { signal };
    return new Promise(resolve => {
      release = () => resolve({ ok: true, text: 'Устаревший результат' });
      signal?.addEventListener('abort', release, { once: true });
    });
  });
  const inFlight = instance.tickNow();
  try {
    await until(() => running, 'the interval must be running');
    const reply = await f.ask('[STOP_ALL]', 'Останови фоновые задачи');
    assert.match(reply, /оборвано идущих ходов: 1/);
    assert.equal(running.signal?.aborted, true);
  } finally {
    release?.();
    await inFlight;
  }
  assert.deepEqual(await listTasks(), [task]);
  assert.doesNotMatch(f.messages.join('\n'), /Устаревший результат/);
});
