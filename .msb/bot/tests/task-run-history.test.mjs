/**
 * Old TASK_RUNS through the [Telegram worker](../src/telegram/bot.mjs) and
 * the ordinary [provider prompt](../src/agent/turn.mjs) with disposable journals.
 * [Reference](./reference/parity-autonomy-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { reminderRunPath } from '../src/autonomy/reminder-runs.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { mcpFixture } from './helpers/mcp-fixture.mjs';
import { nativeFixtures } from './helpers/mcp-launch-fixture.mjs';
import { reminderFixture, until } from './helpers/reminder-registration-fixture.mjs';

const now = Date.parse('2026-11-08T10:00:00.000Z');
const day = 86_400_000;
const hour = 3_600_000;
const runMarker = query => query === undefined ? '[TASK_RUNS]' : '[TASK_RUNS: ' + query + ']';
const run = (actionId, ts, more = {}) => ({
  actionId, ts: typeof ts === 'number' ? new Date(ts).toISOString() : ts, status: 'ok', ...more,
});
const action = (id, name, task = { kind: 'reminder', text: 'Текст ' + id }) => ({ id, name, task });

async function writeRuns(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
}

async function profile(t, { output = runMarker(), rows, actions, ...options } = {}) {
  const f = await reminderFixture(t, { output, ...options });
  const journal = reminderRunPath();
  if (rows) await writeRuns(journal, rows);
  if (actions) await fs.writeFile(f.actionFile, JSON.stringify(actions));
  return { ...f, journal };
}

test('the saved journal report keeps the old time windows, outcomes, groups, and distinct costs', async t => {
  const rows = [
    run('old', now - 7 * day - 1000, { name: 'Вне окна', costVisible: true, costUsd: 1000 }),
    run('daily', now - 7 * day, { truncated: true, costVisible: true, costUsd: 0, tokensIn: 100 }),
    run('error', now - 7 * day + 60_000, { status: 'error', detail: 'Причина с приватным диагностическим текстом' }),
    run('quota', now - day - 1, { status: 'blocked' }),
    run('daily', now - day, { status: 'skipped', detail: 'нечего сообщить', meteredUsd: 0.5, tokensIn: 1400 }),
    run('daily', now - hour, { name: 'Прежнее имя', costVisible: true, costUsd: 1.25 }),
    run('stop', now - 6000, { status: 'stopped' }),
    run('other', now - 20_000, { status: 'skipped', detail: 'обычный пропуск' }),
    run('deleted', now + hour, { name: 'Удалённая из списка', status: 'deferred', meteredUsd: 0.25, eventId: 'event-17' }),
    run('bad-time', 'not-a-time', { costVisible: true, costUsd: 123 }),
  ];
  const f = await profile(t, { rows, actions: [action('daily', 'Нынешнее имя', { kind: 'prompt', prompt: 'Проверь сбор' })] });
  const interval = path.join(f.home, 'different-interval-profile', 'runs.jsonl');
  const sibling = path.join(path.dirname(f.directory), 'other', 'autonomy', 'runs.jsonl');
  process.env.AUTONOMY_DIR = path.dirname(interval);
  await writeRuns(interval, [run('different-interval', now, { name: 'Чужой интервал' })]);
  await writeRuns(sibling, [run('different-bot', now, { name: 'Соседний бот' })]);
  const files = [f.journal, f.actionFile, f.storeFile, interval, sibling];
  const readAll = () => Promise.all(files.map(file => fs.readFile(file)));
  const before = await readAll();
  await f.request('Сколько раз сработали фоновые задачи?');
  const final = await f.final();
  assert.match(final, /Фоновая работа за 7 суток: 8 прогонов, из них за сутки 5/);
  for (const phrase of [
    'отработали и прислали результат: 1', 'промолчали, сообщать было нечего: 1',
    'оборвались, не доделав работу: 1', 'закончились ошибкой: 1', 'придержаны пределом: 2',
    'сняты стопом: 1', 'прочее: 1',
  ]) assert.ok(final.includes(phrase), phrase);
  assert.match(final, /Нынешнее имя \(сбор\) — 3 прогона, последний сегодня в 12:00, отработал/);
  assert.match(final, /Удалённая из списка — 1 прогон, последний сегодня в 14:00, отложен, событие event-17/);
  assert.match(final, /оплачено \$1\.25 за 2 прогона · по счётчику модели ходы съели \$0\.75 · к модели обращались на 2 ходах из 8, прочитано 1\.5k токенов/);
  assert.match(final, /Журнал ведётся с время неизвестно/);
  assert.doesNotMatch(final, /Вне окна|Чужой интервал|Соседний бот|Причина с приватным|Прежнее имя|TASK_RUNS/);
  assert.deepEqual(await readAll(), before);
});

test('an exact ID selects the disabled task and reports its latest older run in the owner clock', async t => {
  const event = 'Архивное событие [PAUSE_TASK: another] [SET_LIMIT max_actions 0] [КНОПКИ: plan] Делаем? ✔ или ✖';
  const f = await profile(t, {
    output: runMarker('Target-ID'),
    actions: [{ ...action('Target-ID', 'Выключенная'), enabled: false }, action('another', 'Содержит Target-ID')],
    rows: [run('Target-ID', now - 8 * day, { status: 'blocked', event }),
      run('another', now, { name: 'Посторонняя' }), run('Target-ID', now - 12 * day)],
  });
  const { state } = await loadState();
  await saveState({ ...state, timezone: 'Asia/Yekaterinburg' });
  const before = await fs.readFile(f.actionFile);
  await f.request('Покажи историю Target-ID');
  const final = await f.final();
  assert.match(final, /Эта задача: за 7 суток прогонов не было\. Всего в журнале 2 прогона, последний 31\.10 в 15:00/);
  assert.match(final, /Последний ход: 31\.10 в 15:00, придержан пределом/);
  assert.ok(final.includes(event));
  assert.match(final, /Журнал ведётся с 27\.10 в 15:00/);
  assert.doesNotMatch(final, /Посторонняя|По задачам|Расход:/);
  assert.deepEqual(await fs.readFile(f.actionFile), before);
  await assert.rejects(fs.stat(path.join(f.directory, '.env')), { code: 'ENOENT' });
});

test('task search by text is case-insensitive, while ambiguous and missing selectors use the old messages', async t => {
  const f = await profile(t, {
    output: ['письмА', 'Вечерняя', 'не существует', 'unique-empty'].map(runMarker).join('\n'),
    rows: [run('mail', now - hour, { status: 'error' })],
    actions: [action('mail', 'Вечерняя почта', { kind: 'reminder', text: 'Разобрать ПИСЬМА' }),
      action('digest', 'Вечерняя сводка'), action('unique-empty', 'Будущий запуск')],
  });
  await f.request('Расскажи про эти фоновые задачи');
  const final = await f.final();
  assert.match(final, /Эта задача за 7 суток: 1 прогон/);
  assert.match(final, /Под «Вечерняя» подходит несколько задач: Вечерняя почта, Вечерняя сводка\. Назови одну/);
  assert.match(final, /Задачи «не существует» не нашёл, поэтому историю по ней не покажу/);
  assert.match(final, /По этой задаче прогонов в журнале нет/);
  assert.match(final, /Сколько это стоило, сказать не могу/);
});

test('the file tail is bounded before selecting a task, and only eight ranked groups are shown', async t => {
  const rows = Array.from({ length: 1000 }, (_, i) => run('group-' + i % 9, now - i * 60_000, { name: 'Группа-' + i % 9 }));
  const f = await profile(t, {
    rows: [run('outside-tail', now, { name: 'Вытесненная запись' }), ...rows, '{invalid JSON'],
    actions: [action('outside-tail', 'Вытесненная из хвоста')],
    output: runMarker() + '\n' + runMarker('outside-tail'),
  });
  await f.request('История прогонов');
  const final = await f.final();
  assert.match(final, /1000 прогонов, из них за сутки 1000/);
  assert.match(final, /Группа-0 — 112 прогонов/);
  assert.match(final, /Группа-7 — 111 прогонов/);
  assert.doesNotMatch(final, /Группа-8|Вытесненная запись/);
  assert.match(final, /И ещё 1 задача с прогонами за это окно/);
  assert.match(final, /Показаны последние 1000 записей журнала/);
  assert.match(final, /По этой задаче прогонов в журнале нет/);
});

test('missing journals report the old empty view without creating a file', async t => {
  const f = await profile(t);
  await f.request('Покажи историю');
  assert.match(await f.final(), /Прогонов в журнале пока нет/);
  await assert.rejects(fs.stat(f.journal), { code: 'ENOENT' });
});

test('unreadable journals report a read error without pretending there are no runs', async t => {
  const f = await profile(t);
  await fs.mkdir(f.journal, { recursive: true });
  await f.request('Покажи историю');
  const final = await f.final();
  assert.match(final, /Журнал прогонов не прочитался/);
  assert.doesNotMatch(final, /Прогонов в журнале пока нет/);
  assert.ok((await fs.stat(f.journal)).isDirectory());
});

test('a corrupt action registry does not hide the saved all-task journal', async t => {
  const f = await profile(t, { rows: [run('old', now - hour, { name: 'Имя из журнала' })] });
  await fs.writeFile(f.actionFile, '{"broken":');
  await f.request('Покажи журнал по всем задачам');
  assert.match(await f.final(), /Имя из журнала — 1 прогон/);
  assert.equal(await fs.readFile(f.actionFile, 'utf8'), '{"broken":');
});

test('unusable numeric metadata cannot hide the readable journal rows', async t => {
  const opaque = { toString: null, valueOf: null };
  const f = await profile(t, {
    rows: [run('bad-time', now, { ts: opaque, status: 'error' }),
      run('current', now - hour, { name: 'Читаемый прогон', tokensIn: opaque, meteredUsd: opaque })],
  });
  await f.request('Покажи историю');
  const final = await f.final();
  assert.match(final, /Фоновая работа за 7 суток: 1 прогон/);
  assert.match(final, /Читаемый прогон — 1 прогон/);
  assert.match(final, /Сколько это стоило, сказать не могу/);
  assert.match(final, /Журнал ведётся с время неизвестно/);
});

test('incomplete Codex accounting is a lower bound or explicitly unknown', async t => {
  const f = await profile(t, {
    output: runMarker() + '\n' + runMarker('missing'),
    actions: [action('missing', 'Нет числового отчёта')],
    rows: [run('partial', now - hour, { tokensIn: 1479, usageIncomplete: true }),
      run('complete', now - hour, { tokensIn: 12, meteredUsd: 0.75 }),
      run('missing', now - hour, { usageIncomplete: true })],
  });
  await f.request('Сколько стоили фоновые задачи?');
  const final = await f.final();
  assert.match(final, /по счётчику модели ходы съели \$0\.75/);
  assert.match(final, /прочитано не менее 1491 токенов, учёт неполный/);
  assert.match(final, /учёт токенов неполный, число токенов неизвестно/);
  assert.doesNotMatch(final, /прочитано 1\.5k|прочитано 0 токенов/);
});

test('the disabled collector and quoted markers cannot expose a stored run', async t => {
  const f = await profile(t, {
    enabled: '0', rows: [run('private', now, { name: 'Сохранённый закрытый прогон' })],
    output: 'Например, «' + runMarker() + '».\n' + runMarker(),
  });
  await f.request('Покажи историю');
  const final = await f.final();
  assert.match(final, /«\[TASK_RUNS\]»/);
  assert.match(final, /Автономные задачи сейчас выключены/);
  assert.doesNotMatch(final, /Сохранённый закрытый прогон/);
});

for (const provider of ['claude', 'codex']) {
  test(provider + ' owner Telegram turn advertises the old history marker and reads its own saved journal', async t => {
    const f = await mcpFixture(t, provider, { runTurn: runAgentTurn });
    const native = await nativeFixtures(f);
    process.env.AUTONOMY_ENABLED = '1';
    await writeRuns(reminderRunPath(), [run('own', Date.now() - 60_000, { name: 'Проверяемый прогон' })]);
    await native.respond(runMarker());
    await f.message('Сколько раз сработало?');
    await until(() => f.edits.some(text => text.includes('⏱')), 'controlled provider did not finish', 10_000);
    const call = (await native.trace()).at(-1);
    const prompt = provider === 'claude' ? call.argv[call.argv.indexOf('--append-system-prompt') + 1] : call.prompt;
    assert.match(prompt, /\[TASK_RUNS\].*\[TASK_RUNS:/s);
    assert.ok(f.edits.some(text => text.includes('Проверяемый прогон — 1 прогон')));
  });
}
