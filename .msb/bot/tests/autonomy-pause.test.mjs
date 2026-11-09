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
import { loadState, saveState, updateState } from '../src/state.mjs';
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
  const questionId = () => f.messages.findLastIndex(text => text.startsWith('Таймеры с прошлой настройки продолжают работать')) + 1;
  return { ...f, root, stopFile, actionFile, timerFile, remoteFile, ask, scheduler, modelCalls,
    writeActions, writeTimers, readTimers, writeRemote, delivered, questionId };
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
  const original = { messageId: f.questionId() };
  await f.callback('tmr-stop', 99, original);
  assert.deepEqual(await f.readTimers(), savedTimers);
  await f.callback('ct-keep', 42, original);
  assert.match(f.edits.at(-1), /✔ Оставил на месте/);
  await f.callback('tmr-stop', 42, original);
  assert.deepEqual(await f.readTimers(), savedTimers);
  await f.ask('[STOP_ALL]');
  await f.callback('tmr-stop', 42, { messageId: f.questionId() });
  const [paused, ...unchanged] = await f.readTimers();
  assert.deepEqual(paused, { ...savedTimers[0], enabled: false, disabledBy: 'stop' });
  assert.deepEqual(unchanged, savedTimers.slice(1));
  assert.match(f.edits.at(-1), /таймеры тоже остановлены \(1\)/);
  const resume = await f.ask('[RESUME_ALL]', 'Верни всё в работу');
  assert.match(resume, /Таймеры, остановленные вместе со всеми, снова работают \(1\)/);
  assert.deepEqual(await f.readTimers(), savedTimers);
  await f.callback('tmr-stop', 42, { messageId: f.questionId() });
  assert.deepEqual(await f.readTimers(), savedTimers, 'old confirmation must not pause a newly resumed timer');
});

test('first executable control wins and quoted markers have no effect', async t => {
  const f = await profile(t);
  const before = await f.ask('Пример «\n[STOP_ALL]\n»', 'Покажи пример');
  assert.doesNotMatch(before, /Автономка остановлена/);
  await assert.rejects(fs.stat(f.stopFile), { code: 'ENOENT' });
  const stopped = await f.ask('Пример «[RESUME_ALL]»\n[STOP_ALL] [RESUME_ALL]', 'Останови задачи');
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

test('an opted-out model response cannot create a pause or its lock', async t => {
  const f = await profile(t, { enabled: '0' });
  const reply = await f.ask('Остановил.\n[STOP_ALL]');
  assert.match(reply, /Автономные задачи сейчас выключены/);
  assert.doesNotMatch(reply, /Остановил\./);
  await assert.rejects(fs.stat(path.dirname(f.stopFile)), { code: 'ENOENT' });
});

test('a native response cannot change the local pause after switching engines', async t => {
  const f = await profile(t, { engine: 'oc' });
  const reply = await f.ask(async () => {
    await saveState({ ...(await loadState()).state, engine: 'cc' });
    return '[STOP_ALL]';
  });
  assert.match(reply, /на этом движке пока не подключено/);
  await assert.rejects(fs.stat(path.dirname(f.stopFile)), { code: 'ENOENT' });
});

test('a local stop reports armed native jobs without changing their map or actions', async t => {
  const f = await profile(t);
  const native = { ...pending, id: 'native', runner: 'oc' };
  await f.writeActions([pending, native]);
  const map = path.join(f.root, 'autonomy', 'cron-jobs.json');
  await fs.mkdir(path.dirname(map), { recursive: true });
  const mapBytes = JSON.stringify({ native: { jobId: 'owned-fixture-job' } });
  await fs.writeFile(map, mapBytes);
  const reply = await f.ask('[STOP_ALL]');
  assert.match(reply, /Остановка неполная: в профиле остались активные записи OpenClaw \(1\)/);
  assert.doesNotMatch(reply, /Новые прогоны не начнутся/);
  assert.equal(await fs.readFile(map, 'utf8'), mapBytes);
  assert.deepEqual(JSON.parse(await fs.readFile(f.actionFile, 'utf8')), [pending, native]);
});

test('an unconfirmed legacy timer still runs while the owner pause is active', async t => {
  const f = await profile(t);
  await f.writeTimers([{ ...savedTimers[0], at: due }]);
  await f.ask('[STOP_ALL]');
  await f.scheduler().tickNow();
  await until(() => f.modelCalls.some(args => args.isAutoTurn && args.prompt.includes('Текст таймера')),
    'legacy scheduler must admit the original timer while background actions are paused');
  assert.match(await fs.readFile(f.stopFile, 'utf8'), /владелец сказал остановить/);
  const [timer] = await f.readTimers();
  assert.equal(timer.lastRunAt, due);
  assert.equal(timer.enabled, false);
});

test('a manually toggled timer loses the global stop provenance', async t => {
  const f = await profile(t);
  await f.writeTimers(savedTimers);
  await f.ask('[STOP_ALL]');
  await f.callback('tmr-stop', 42, { messageId: f.questionId() });
  await f.callback('auto:timer-toggle:legacy-on');
  await f.callback('auto:timer-toggle:legacy-on');
  await f.ask('[RESUME_ALL]');
  assert.deepEqual(await f.readTimers(), [{ ...savedTimers[0], enabled: false }, ...savedTimers.slice(1)]);
});

test('resume reports an unlink failure without changing the stop or the timers', async t => {
  const f = await profile(t);
  await fs.mkdir(f.stopFile, { recursive: true });
  const paused = { ...savedTimers[0], enabled: false, disabledBy: 'stop' };
  await f.writeTimers([paused]);
  const reply = await f.ask('[RESUME_ALL]');
  assert.match(reply, /Не удалось снять стоп/);
  assert.doesNotMatch(reply, /Снял паузу|Снял стоп|снова работают/);
  assert.equal((await fs.stat(f.stopFile)).isDirectory(), true);
  assert.deepEqual(await f.readTimers(), [paused]);
});

test('a second pause never accepts the previous timer question after the owner chooses Keep', async t => {
  const f = await profile(t);
  await f.writeTimers(savedTimers);
  await f.ask('[STOP_ALL]');
  const old = { messageId: f.questionId() };
  assert.ok(old.messageId > 0);
  await f.ask('[RESUME_ALL]');
  await f.ask('[STOP_ALL]');
  const current = { messageId: f.questionId() };
  assert.notEqual(current.messageId, old.messageId);
  await f.callback('ct-keep', 42, current);
  await f.callback('tmr-stop', 42, old);
  assert.match(f.edits.at(-1), /Этот вопрос уже закрыт/);
  assert.deepEqual(await f.readTimers(), savedTimers);
});

test('a switch during the last policy read cannot commit a pause in the previous engine', async t => {
  const f = await profile(t);
  const config = path.join(f.root, 'autonomy', 'config.json');
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.writeFile(config, '{"enabled":true}');
  let reads = 0, unblock;
  const read = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', async (...args) => {
    if (args[0] === config && ++reads === 2) {
      await new Promise(resolve => { unblock = resolve; });
    }
    return read(...args);
  });
  const reply = f.ask('[STOP_ALL]');
  try {
    await until(() => unblock, 'the last config read must be waiting');
    await updateState(state => ({ ...state, engine: 'oc' }));
  } finally {
    unblock?.();
  }
  assert.match(await reply, /на этом движке пока не подключено/);
  await assert.rejects(fs.stat(f.stopFile), { code: 'ENOENT' });
  assert.equal((await loadState()).state.engine, 'oc');
});

test('a failed timer write retains its owner confirmation for a retry', async t => {
  const f = await profile(t);
  await f.writeTimers(savedTimers);
  await f.ask('[STOP_ALL]');
  const question = { messageId: f.questionId() };
  await fs.writeFile(f.timerFile, '{invalid fixture');
  await f.callback('tmr-stop', 42, question);
  assert.equal(f.callbackAnswers.at(-1)[0].text, 'Не смог остановить, попробуй ещё раз');
  assert.equal(await fs.readFile(f.timerFile, 'utf8'), '{invalid fixture');
  await f.writeTimers(savedTimers);
  await f.callback('tmr-stop', 42, question);
  assert.equal((await f.readTimers())[0].disabledBy, 'stop');
});
