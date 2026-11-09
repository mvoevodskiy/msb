/**
 * Old one-task pause/resume through [Telegram](../src/telegram/bot.mjs)
 * and the [saved action store](../src/autonomy/reminder-store.mjs).
 * [Reference contract](./reference/parity-autonomy-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { startScheduler } from '../src/autonomy/scheduler.mjs';
import { actionRoot, statePath } from '../src/paths.mjs';
import { loadState, saveState, updateState } from '../src/state.mjs';
import { mcpFixture } from './helpers/mcp-fixture.mjs';
import { nativeFixtures } from './helpers/mcp-launch-fixture.mjs';
import { ownerChat, reminderFixture, until } from './helpers/reminder-registration-fixture.mjs';

const now = Date.parse('2026-11-08T10:00:00.000Z');
const at = new Date(now).toISOString();
const previous = new Date(now - 3600_000).toISOString();
const every = intervalMinutes => ({ kind: 'interval', intervalMinutes });
const row = (id, name, extra = {}) => ({
  id, name, enabled: true, trigger: every(60), task: { kind: 'reminder', text: 'Сообщение ' + id }, ...extra,
});
const paused = action => ({ ...action, enabled: false, disabledReason: 'owner' });
const command = (mode, value) => '[' + mode + '_TASK: ' + value + ']';

async function profile(t, output, records, opts) {
  const f = await reminderFixture(t, { output, ...opts });
  await fs.writeFile(f.actionFile, JSON.stringify(records));
  return f;
}

test('one-task pause prefers the exact ID and supports case-insensitive matching in the instruction', async t => {
  const target = row('case-ID', 'Сбор дня', { lastRunAt: previous, lastStatus: 'ok', extra: { kept: true } });
  const overlapping = row('other', 'Проверка case-ID');
  const textMatch = row('by-text', 'Другой сбор', { task: { kind: 'reminder', text: 'Проверить почту [архив]' } });
  const output = command('PAUSE', 'case-ID') + '\n' + command('PAUSE', 'ПРОВЕРИТЬ ПОЧТУ [АРХИВ');
  const f = await profile(t, output, [target, overlapping, textMatch]);
  const timers = JSON.stringify([{ id: 'legacy', name: 'case-ID', enabled: false }]);
  await fs.writeFile(f.schedules, timers);
  const state = await fs.readFile(statePath());
  await f.request('Поставь на паузу две конкретные задачи');
  const final = await f.final();
  assert.match(final, /⏸ «Сбор дня» на паузе\. Остальные задачи работают\./);
  assert.match(final, /⏸ «Другой сбор» на паузе\./);
  assert.doesNotMatch(final, /PAUSE_TASK/);
  assert.deepEqual(await f.records(), [paused(target), overlapping, paused(textMatch)]);
  assert.deepEqual(await fs.readFile(statePath()), state);
  assert.equal(await fs.readFile(f.schedules, 'utf8'), timers);
  await f.scheduler().tickNow();
  assert.deepEqual(f.delivered().map(delivery => delivery.text), ['⏰ Сообщение other']);
});

test('an exact name cannot hide a second substring match, including a native row', async t => {
  const local = row('local', 'Проверка');
  const native = row('native', 'Проверка сервера', { runner: 'oc' });
  const f = await profile(t, 'Выключил.\n' + command('PAUSE', 'проверка'), [local, native]);
  const before = await fs.readFile(f.actionFile);
  await f.request('Выключи проверку');
  const final = await f.final();
  assert.match(final, /Нашёл несколько — уточни:/);
  assert.match(final, /Проверка[\s\S]*Проверка сервера/);
  assert.match(final, /Тут я поторопился с обещанием/);
  assert.doesNotMatch(final, /^Выключил\./);
  assert.deepEqual(await fs.readFile(f.actionFile), before);
});

test('empty, missing and exact foreign targets are reported without falling through to a local match', async t => {
  const local = row('local', 'Проверка native-ID', { task: { kind: 'reminder', text: 'Локальное напоминание' } });
  const native = row('native-ID', 'Управляется cron');
  const legacy = paused(row('moved', 'Архив', { migratedToOc: true }));
  legacy.disabledReason = 'migrated_to_oc';
  const output = [command('PAUSE', ' '), command('RESUME', ' '), command('PAUSE', 'native-ID'),
    command('RESUME', 'moved'), command('PAUSE', 'loc')].join('\n');
  const f = await profile(t, output, [local, native, legacy]);
  const dir = path.join(f.directory, 'autonomy');
  const jobs = path.join(dir, 'cron-jobs.json');
  await fs.mkdir(dir);
  const jobRecord = '{"native-ID":{"jobId":"fixture-native"}}';
  await fs.writeFile(jobs, jobRecord);
  await f.request('Проверь выбор задачи');
  const final = await f.final();
  assert.match(final, /Уточни, какую задачу поставить на паузу/);
  assert.match(final, /Уточни, какую задачу вернуть в работу/);
  assert.match(final, /Управление задачей «Управляется cron».*не подключено/);
  assert.match(final, /«Архив» перенесена в OpenClaw/);
  assert.match(final, /Не нашёл задачу «loc»/);
  assert.deepEqual(await f.records(), [local, native, legacy]);
  assert.equal(await fs.readFile(jobs, 'utf8'), jobRecord);
});

test('resume preserves the saved schedule and leaves both the local and fleet STOP in force', async t => {
  const target = paused(row('one', 'Сбор дня', { lastRunAt: previous, lastStatus: 'ok' }));
  const other = paused(row('two', 'Другое'));
  const f = await profile(t, command('RESUME', 'сбор дня'), [target, other]);
  const autonomy = path.join(f.directory, 'autonomy');
  const stop = path.join(autonomy, 'STOP');
  const fleet = path.join(f.directory, 'remote-config.json');
  await fs.mkdir(autonomy);
  await fs.writeFile(stop, 'fixture local pause');
  await fs.writeFile(fleet, '{"autonomyGlobalStop":true}');
  await f.request('Верни в работу сбор дня');
  const final = await f.final();
  assert.match(final, /▶ «Сбор дня» включена/);
  assert.match(final, /Пауза этого бота и общая пауза сервера остаются/);
  assert.doesNotMatch(final, /снова в работе/);
  const { disabledReason, ...rest } = target;
  assert.deepEqual(await f.records(), [{ ...rest, enabled: true }, other]);
  const scheduler = f.scheduler();
  await scheduler.tickNow();
  assert.equal(await fs.readFile(stop, 'utf8'), 'fixture local pause');
  assert.equal(await fs.readFile(fleet, 'utf8'), '{"autonomyGlobalStop":true}');
  assert.deepEqual(f.delivered(), []);
  await fs.unlink(stop);
  await scheduler.tickNow();
  assert.deepEqual(f.delivered(), []);
  await fs.unlink(fleet);
  await scheduler.tickNow();
  assert.deepEqual(f.delivered().map(delivery => delivery.text), ['⏰ Сообщение one']);
});

test('idempotent requests and system-disabled or spent tasks retain their state', async t => {
  const normal = row('active', 'Активная');
  const owner = paused(row('owner', 'На паузе'));
  const held = row('frequency', 'Частая', { trigger: every(15), disabledReason: 'frequency' });
  const system = row('system', 'Ограничена', { enabled: false, disabledReason: 'budget' });
  const spent = row('spent', 'Разовая', { enabled: false, disabledReason: 'spent_once',
    trigger: { kind: 'once', at: previous }, lastRunAt: previous });
  const oldSpent = row('old-once', 'Старая разовая', { enabled: false,
    trigger: { kind: 'once', at: previous }, lastRunAt: previous });
  const output = [command('PAUSE', 'owner'), command('RESUME', 'active'), command('RESUME', 'frequency'),
    command('RESUME', 'system'), command('RESUME', 'spent'), command('RESUME', 'old-once')].join('\n');
  const records = [normal, owner, held, system, spent, oldSpent];
  const f = await profile(t, output, records);
  const before = await fs.readFile(f.actionFile);
  await f.request('Проверь состояние этих задач');
  const final = await f.final();
  assert.match(final, /«На паузе» и так на паузе/);
  assert.match(final, /«Активная» и так в работе/);
  assert.match(final, /«Частая» уже включена.*ограничение частоты/s);
  assert.match(final, /«Ограничена» выключил не ты, а система \(budget\)/);
  assert.match(final, /«Разовая» выключил не ты, а система \(spent_once\)/);
  assert.match(final, /«Старая разовая».*уже сработала/);
  assert.deepEqual(await fs.readFile(f.actionFile), before);
});

test('a pause records the admitted collection result without aborting it', async t => {
  const target = row('running', 'Идущий сбор', { task: { kind: 'prompt', prompt: 'Собери текущую сводку' } });
  const f = await profile(t, command('PAUSE', 'running'), [target]);
  await updateState(state => ({ ...state, extAuthBypass: 'codex', authMode: 'subscription', hasSubscriptionAuth: true }));
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const scheduler = startScheduler({ api: f.bot.api, adminId: 42, timezone: 'Europe/Moscow', now: () => now,
    async runCodexPrompt({ signal, canLaunch }) {
      assert.ok(await canLaunch());
      entered.resolve(signal);
      await release.promise;
      return { providerId: 'codex', text: 'Отчёт уже начатого сбора' };
    }, log() {} });
  t.after(() => scheduler.stop());
  const tick = scheduler.tickNow();
  try {
    const signal = await Promise.race([entered.promise, tick.then(() => assert.fail('Expected an admitted prompt'))]);
    await f.request('Выключи этот сбор');
    assert.match(await f.final(), /⏸ «Идущий сбор» на паузе/);
    assert.equal(signal.aborted, false);
  } finally {
    release.resolve();
    await tick;
  }
  const [saved] = await f.records();
  assert.deepEqual([saved.enabled, saved.disabledReason, saved.lastRunAt, saved.lastStatus], [false, 'owner', at, 'ok']);
  assert.ok(f.sent.some(delivery => delivery.destination === ownerChat && delivery.text.includes('Отчёт уже начатого сбора')));
  const runs = (await fs.readFile(path.join(f.directory, 'autonomy', 'runs.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(runs.map(run => [run.actionId, run.status]), [['running', 'ok']]);
});

test('quoted markers are inert and an engine change before the locked write refuses the mutation', async t => {
  const target = row('target', 'Цель');
  const quoted = row('quoted', 'Только пример');
  const output = 'Показал пример: ' + String.fromCharCode(96) + command('PAUSE', 'quoted') + String.fromCharCode(96) +
    '\n> ' + command('PAUSE', 'quoted') + '\n' + command('PAUSE', 'target');
  const f = await profile(t, output, [target, quoted]);
  const actionFile = await fs.realpath(f.actionFile);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const read = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (file === actionFile) {
      entered.resolve();
      await release.promise;
    }
    return read(file, ...args);
  });
  await f.request('Выключи цель и покажи пример');
  try {
    await Promise.race([entered.promise, f.final().then(() => assert.fail('Expected the locked task lookup'))]);
    await updateState(state => ({ ...state, engine: 'oc' }));
  } finally {
    release.resolve();
  }
  const final = await f.final();
  assert.match(final, /Управление задачами на этом движке пока не подключено/);
  assert.deepEqual(await f.records(), [target, quoted]);
});

for (const provider of ['claude', 'codex']) {
  test(provider + ' normal turn advertises and applies the one-task marker', async t => {
    const f = await mcpFixture(t, provider, { runTurn: runAgentTurn });
    const native = await nativeFixtures(f);
    process.env.AUTONOMY_ENABLED = '1';
    await saveState({ ...(await loadState()).state, chatId: 42, userId: 42 });
    const actionFile = path.join(actionRoot(), 'actions.json');
    const target = row('target', 'Сбор дня');
    await fs.writeFile(actionFile, JSON.stringify([target]));
    await native.respond(command('PAUSE', 'Сбор дня'));
    await f.message('Поставь на паузу сбор дня');
    await until(() => f.edits.some(text => text.includes('⏱')), 'controlled provider reply did not finish', 10_000);
    const call = (await native.trace()).at(-1);
    const prompt = provider === 'claude' ? call.argv[call.argv.indexOf('--append-system-prompt') + 1] : call.prompt;
    assert.match(prompt, /\[PAUSE_TASK:.*\[RESUME_TASK:/s);
    assert.ok(f.edits.some(text => text.includes('⏸ «Сбор дня» на паузе')));
    assert.deepEqual(JSON.parse(await fs.readFile(actionFile, 'utf8')), [paused(target)]);
  });
}

test('mixed controls run all pauses before resumes and keep replies at their marker positions', async t => {
  const target = row('both', 'Сбор', { lastRunAt: previous, lastStatus: 'ok' });
  const f = await profile(t, command('RESUME', 'both') + '\n' + command('PAUSE', 'both'), [target]);
  await f.request('Проверь последовательность двух команд');
  const final = await f.final();
  assert.match(final, /▶ «Сбор» снова в работе[\s\S]*⏸ «Сбор» на паузе/);
  assert.deepEqual(await f.records(), [target]);
});

test('failed named claims are corrected while quoted examples and a successful neighbour are retained', async t => {
  const left = row('morning', 'Почта утром');
  const right = row('evening', 'Почта вечером');
  const lastRunAt = new Date(now - 20 * 60_000).toISOString();
  const target = row('schedule', 'График', { enabled: false, lastRunAt });
  const output = '«Выключил почту».\nВыключил «Почта».\n' + command('PAUSE', 'Почта') +
    '\nВключил «График».\n' + command('RESUME', 'График');
  const f = await profile(t, output, [left, right, target]);
  await f.request('Выключи почту и включи график');
  const final = await f.final();
  assert.match(final, /«Выключил почту»\./);
  assert.doesNotMatch(final, /Выключил «Почта»\./);
  assert.match(final, /Тут я поторопился с обещанием/);
  assert.match(final, /Нашёл несколько — уточни/);
  assert.match(final, /Включил «График»\./);
  assert.match(final, /▶ «График» снова в работе — каждые 60 мин · следующее сегодня в 13:40 \(МСК\)/);
  assert.deepEqual(await f.records(), [left, right, { ...target, enabled: true }]);
  const scheduler = f.scheduler();
  await scheduler.tickNow();
  assert.ok(!f.delivered().some(delivery => delivery.text.includes('schedule')));
  f.setTime(now + 40 * 60_000);
  await scheduler.tickNow();
  assert.equal(f.delivered().filter(delivery => delivery.text.includes('schedule')).length, 1);
});

test('markers embedded inside a task selector cannot pause the bot, set a limit or schedule another action', async t => {
  const target = row('target', 'Обычная задача');
  const nested = '[SCHEDULE_TASK]{"trigger":{"kind":"once","at":"+10m"},"task":{"kind":"reminder","text":"Ложная задача"}}[/SCHEDULE_TASK]';
  const output = [command('PAUSE', '[STOP_ALL]'), command('PAUSE', '[SET_LIMIT max_actions 0]'),
    command('PAUSE', nested), command('PAUSE', 'target')].join('\n');
  const f = await profile(t, output, [target]);
  await f.request('Выключи обычную задачу');
  const final = await f.final();
  assert.match(final, /⏸ «Обычная задача» на паузе/);
  assert.deepEqual(await f.records(), [paused(target)]);
  for (const file of [path.join(f.directory, 'autonomy', 'STOP'), path.join(f.directory, '.env')]) {
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  }
});
