/**
 * Old CANCEL_SPENT through the production [Telegram worker](../src/telegram/bot.mjs).
 * [Reference](./reference/parity-autonomy-contract.txt). All rows and CLI replies are disposable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { actionRoot, msbRoot } from '../src/paths.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { mcpFixture } from './helpers/mcp-fixture.mjs';
import { nativeFixtures } from './helpers/mcp-launch-fixture.mjs';
import { reminderFixture, until } from './helpers/reminder-registration-fixture.mjs';

const cancel = '[CANCEL_SPENT]';
const request = 'Убери завершённые разовые задачи';
const runAt = '2026-11-07T09:00:00.000Z';
const done = (id, name, extra = {}) => ({
  id, name, enabled: true, trigger: { kind: 'once', at: runAt },
  task: { kind: 'reminder', text: 'Содержание ' + id }, lastRunAt: runAt, lastOutcome: 'ok', ...extra,
});
const first = done('first', 'Первый завершённый');
const future = { ...done('future', 'Ещё сработает', { trigger: { kind: 'once', at: '2026-11-08T12:00:00.000Z' } }) };
delete future.lastRunAt;

async function profile(t, { output = cancel, records = [first], ...options } = {}) {
  const f = await reminderFixture(t, { output, ...options });
  await fs.writeFile(f.actionFile, JSON.stringify(records));
  const autonomy = path.join(f.directory, 'autonomy');
  await fs.mkdir(autonomy, { recursive: true });
  const jobs = path.join(autonomy, 'cron-jobs.json');
  const journal = path.join(autonomy, 'runs.jsonl');
  const stop = path.join(autonomy, 'STOP');
  await fs.writeFile(journal, JSON.stringify({ actionId: 'first', ts: runAt, status: 'ok' }) + '\n');
  await fs.writeFile(f.schedules, JSON.stringify([{ id: 'legacy', name: 'Старый таймер', enabled: false }]));
  const stable = [journal, f.schedules, f.storeFile];
  const before = await Promise.all(stable.map(file => fs.readFile(file)));
  return { ...f, jobs, journal, stop, untouched: async () =>
    assert.deepEqual(await Promise.all(stable.map(file => fs.readFile(file))), before) };
}

test('the direct marker removes only the enabled historical once group and leaves native rows named in the result', async t => {
  const second = done('second', 'Исторический дайджест', { task: { kind: 'digest' } });
  const disabled = done('normal', 'Обычный завершённый', { enabled: false, disabledReason: 'spent_once' });
  const pending = done('pending', 'Ожидает подтверждения', { pendingConfirm: true });
  const recurring = done('repeat', 'Регулярный', { trigger: { kind: 'interval', intervalMinutes: 60 } });
  const mapped = done('mapped', 'Задача OpenClaw по карте');
  const native = done('native', 'Задача нативного движка', { runner: 'oc' });
  const f = await profile(t, { records: [first, second, disabled, pending, recurring, future, mapped, native] });
  const map = '{"mapped":{"jobId":"other-native-job","enabled":true}}';
  await fs.writeFile(f.jobs, map);
  await f.request(request);
  const final = await f.final();
  assert.match(final, /Снёс 2, они уже не могли сработать:\n✖ Первый завершённый\n✖ Исторический дайджест/);
  assert.match(final, /⚠ Не удалось снять: Задача OpenClaw по карте, Задача нативного движка/);
  assert.doesNotMatch(final, /CANCEL_SPENT/);
  assert.deepEqual(await f.records(), [disabled, pending, recurring, future, mapped, native]);
  assert.equal(await fs.readFile(f.jobs, 'utf8'), map);
  assert.equal(f.markupEdits.length, 0);
  await assert.rejects(fs.stat(path.join(f.directory, 'autonomy', 'spent-task-questions.json')), { code: 'ENOENT' });
  await f.untouched();
});

test('STOP and cleanup happen before list and detail even when the report markers come first', async t => {
  const f = await profile(t, {
    output: '[LIST_TASKS]\n[SHOW_TASK: first]\n' + cancel + '\n' + cancel + '\n[STOP_ALL]',
    records: [first, future],
  });
  await f.request(request + ' и останови фоновые задачи, затем покажи список');
  const final = await f.final();
  assert.match(final, /Фоновые задачи сейчас на паузе/);
  assert.match(final, /Ещё сработает \(напоминание\)/);
  assert.match(final, /Не нашёл задачу «first»/);
  assert.match(final, /Снёс 1, они уже не могли сработать/);
  assert.match(final, /Сносить нечего — всё, что есть, ещё сработает/);
  assert.doesNotMatch(final, /Уже не сработают \(/);
  assert.deepEqual(await f.records(), [future]);
  assert.ok((await fs.stat(f.stop)).isFile());
  assert.ok(!f.messages.some(text => text.startsWith('Убрать из списка ')));
  await f.untouched();
});

test('the old end-of-line invocation accepts leading prose', async t => {
  const f = await profile(t, { output: 'Запрошенная очистка ' + cancel });
  await f.request(request);
  assert.match(await f.final(), /Запрошенная очистка Снёс 1/);
  assert.deepEqual(await f.records(), []);
});

test('quoted, fenced and trailing-prose cleanup mentions are stripped without deleting a task', async t => {
  const ticks = String.fromCharCode(96);
  const output = [
    'Пример «' + cancel + '».',
    'Пример "пояснение ' + cancel + '".',
    "Пример '" + cancel + "'.",
    'Код ' + ticks + cancel + ticks,
    ticks.repeat(3), cancel, ticks.repeat(3),
    '> ' + cancel,
    cancel + ' здесь только пояснение.',
  ].join('\n');
  const f = await profile(t, { output });
  const before = await fs.readFile(f.actionFile);
  await f.request('Как выглядит пример?');
  const final = await f.final();
  assert.match(final, /здесь только пояснение/);
  assert.doesNotMatch(final, /CANCEL_SPENT|Снёс \d/);
  assert.deepEqual(await fs.readFile(f.actionFile), before);
});

test('cleanup syntax nested in a report selector stays data', async t => {
  const f = await profile(t, { output: '[SHOW_TASK: ' + cancel + ']' });
  await f.request('Покажи задачу по имени');
  assert.match(await f.final(), /Не нашёл задачу/);
  assert.deepEqual(await f.records(), [first]);
});

test('disabled autonomy and a changed engine refuse direct cleanup with no false success', async t => {
  const f = await profile(t, {
    enabled: '0',
    output: async () => {
      if (process.env.AUTONOMY_ENABLED === '1') {
        const { state } = await loadState();
        await saveState({ ...state, engine: 'oc' });
      }
      return { ok: true, text: 'Убрал.\n' + cancel };
    },
  });
  const before = await fs.readFile(f.actionFile);
  await f.request(request);
  const disabled = await f.final();
  assert.match(disabled, /Автономные задачи сейчас выключены/);
  assert.doesNotMatch(disabled, /^Убрал\.|Снёс 1/);
  process.env.AUTONOMY_ENABLED = '1';
  const edits = f.edits.length;
  await f.request(request);
  await until(() => f.edits.slice(edits).some(text => text.includes('⏱')), 'changed engine did not finish');
  assert.match(f.edits.at(-1), /Уборка задач на этом движке пока не подключена/);
  assert.deepEqual(await fs.readFile(f.actionFile), before);
});

test('a per-bot scheduler sleep marker does not disable explicit historical cleanup', async t => {
  const f = await profile(t);
  const sleep = path.join(msbRoot(), 'engine', 'sleep.default');
  await fs.mkdir(path.dirname(sleep), { recursive: true });
  await fs.writeFile(sleep, 'fixture sleep');
  await f.request(request);
  assert.match(await f.final(), /Снёс 1/);
  assert.deepEqual(await f.records(), []);
  assert.equal(await fs.readFile(sleep, 'utf8'), 'fixture sleep');
});

for (const provider of ['claude', 'codex']) {
  test(provider + ' foreground Telegram turn receives direct cleanup and applies it to the local action store', async t => {
    const f = await mcpFixture(t, provider, { runTurn: runAgentTurn });
    const native = await nativeFixtures(f);
    process.env.AUTONOMY_ENABLED = '1';
    const actions = path.join(actionRoot(), 'actions.json');
    await fs.writeFile(actions, JSON.stringify([first, future]));
    await native.respond(cancel);
    await f.message(request);
    await until(() => f.edits.some(text => text.includes('⏱')), 'controlled provider did not finish', 10_000);
    const call = (await native.trace()).at(-1);
    const prompt = provider === 'claude' ? call.argv[call.argv.indexOf('--append-system-prompt') + 1] : call.prompt;
    assert.match(prompt, /\[CANCEL_SPENT\] отдельной строкой/);
    assert.match(f.edits.at(-1), /Снёс 1/);
    assert.deepEqual(JSON.parse(await fs.readFile(actions, 'utf8')), [future]);
    assert.equal(f.markupEdits.length, 0);
  });
}
