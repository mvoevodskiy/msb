/**
 * Old owner edits through [Telegram](../src/telegram/bot.mjs), the action
 * file and [scheduler](../src/autonomy/scheduler.mjs). [Proof](./reference/parity-autonomy-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { startScheduler } from '../src/autonomy/scheduler.mjs';
import { actionRoot } from '../src/paths.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { mcpFixture } from './helpers/mcp-fixture.mjs';
import { nativeFixtures } from './helpers/mcp-launch-fixture.mjs';
import { reminderFixture, until } from './helpers/reminder-registration-fixture.mjs';

const now = Date.parse('2026-11-08T10:00:00.000Z');
const runAt = '2026-11-07T09:00:00.000Z';
const original = '2026-11-08T11:00:00.000Z';
const request = 'Измени текст фоновой задачи';
const full = (verb, query, text) => '[' + verb + ': ' + query + ']' + text + '[/' + verb + ']';
const short = (verb, query, text) => '[' + verb + ': ' + query + ' | ' + text + ']';
const row = (id, name, fields = {}) => ({
  id, name, enabled: true, trigger: { kind: 'once', at: original },
  task: { kind: 'reminder', text: 'Старый текст' }, ...fields,
});
const active = row('mail', 'Почта');

function withoutRevision({ taskTextRevision, ...record }) {
  return record;
}

async function profile(t, { output, records = [active], enabled = '1' } = {}) {
  const f = await reminderFixture(t, { output, enabled });
  const put = rows => fs.writeFile(f.actionFile, JSON.stringify(rows));
  await put(records);
  const autonomy = path.join(f.directory, 'autonomy');
  await fs.mkdir(autonomy, { recursive: true });
  const journal = path.join(autonomy, 'runs.jsonl');
  const jobs = path.join(autonomy, 'cron-jobs.json');
  const stop = path.join(autonomy, 'STOP');
  await fs.writeFile(journal, '{"fixture":"journal"}\n');
  await fs.writeFile(f.schedules, '[{"id":"legacy","enabled":false}]\n');
  const stable = [journal, f.schedules, f.storeFile];
  const bytes = () => Promise.all(stable.map(file => fs.readFile(file)));
  const before = await bytes();
  const turn = async () => {
    const start = f.edits.length;
    await f.request(request);
    await until(() => f.edits.slice(start).some(text => text.includes('⏱')), 'edit reply did not finish');
    return f.edits.slice(start).find(text => text.includes('⏱'));
  };
  return { ...f, jobs, journal, stop, put, turn, untouched: async () => assert.deepEqual(await bytes(), before) };
}

test('task text replacement keeps multiline punctuation, exact ID and every other saved field', async t => {
  const originalTask = { kind: 'reminder', text: 'Старый текст', custom: 'fixture' };
  const old = { ...active, task: originalTask, authority: { profile: 'narrow' },
    origin: { chatId: -12, threadId: 32 }, output: { format: 'tg-message', deliverTo: { chatId: -12 } },
    budget: { maxRunSeconds: 110 }, runner: 'auto', createdAt: runAt, audit: { source: 'fixture' } };
  const neighbor = row('other', 'Ещё одна mail');
  const next = 'Первый ] пункт | значение\nВторая строка <входящие>';
  const f = await profile(t, { records: [old, neighbor], output: full('EDIT_TASK', 'mail', '\n ' + next + ' \n') });
  assert.match(await f.turn(), /Готово: у «Почта» новый текст\. Расписание, история и поля целы/);
  const [updated, savedNeighbor] = await f.records();
  assert.deepEqual(withoutRevision(updated), { ...old, task: { ...originalTask, text: next } });
  assert.deepEqual(savedNeighbor, neighbor);
  await f.untouched();
});

test('task text append uses one LF and normalizes only a prompt body', async t => {
  const prompt = { kind: 'prompt', prompt: '  Собери старую сводку  ', helpers: false };
  const old = row('digest', 'Сводка', { enabled: false, disabledReason: 'owner', task: prompt,
    authority: { profile: 'standard' }, capability: 'read', lastRunAt: runAt, lastStatus: 'error' });
  const f = await profile(t, { records: [old],
    output: short('APPEND_TASK', 'старую сводку', 'каждый день в 9:00: Проверь архив входящих писем') });
  assert.match(await f.turn(), /Готово: дописал в «Сводка».*Задача остаётся на паузе/);
  const [updated] = await f.records();
  assert.deepEqual(withoutRevision(updated), { ...old,
    task: { ...prompt, prompt: 'Собери старую сводку\nПроверь архив входящих писем' } });
  await f.untouched();
});

test('task text operations run by old type and full-before-short order', async t => {
  const output = [
    full('DROP_FROM_TASK', 'mail', '  «ПОРТРЕТ!»  '),
    short('APPEND_TASK', 'mail', 'Оставить на завтра'),
    full('APPEND_TASK', 'mail', 'ПОРТРЕТ, повтор.'),
    short('EDIT_TASK', 'mail', 'Первый пункт\nПортрет!'),
    full('EDIT_TASK', 'mail', 'Значение длинной формы'),
  ].join('\n');
  const f = await profile(t, { output });
  const final = await f.turn();
  assert.match(final, /Убрал 2 строки/);
  assert.match(final, /«Портрет!»/);
  assert.match(final, /«ПОРТРЕТ, повтор\.»/);
  assert.equal((await f.records())[0].task.text, 'Первый пункт\nОставить на завтра');
  await f.untouched();
});

test('task text removal drops complete sentences from one-line instructions', async t => {
  const old = row('mail', 'Почта', { task: { kind: 'reminder', text: 'Купить хлеб. Проверить ПОЧТУ! Купить молоко.' } });
  const f = await profile(t, { records: [old], output: short('DROP_FROM_TASK', 'mail', '«проверить почту»') });
  assert.match(await f.turn(), /Убрал: «Проверить ПОЧТУ!»/);
  assert.equal((await f.records())[0].task.text, 'Купить хлеб. Купить молоко.');
  await f.untouched();
});

test('task text replacement waits after SHOW of the same resolved ID, while append still works', async t => {
  const f = await profile(t, { output: full('EDIT_TASK', 'mail', 'Опасная замена') + '\n' +
    full('APPEND_TASK', 'mail', 'Согласованная строка') + '\n[SHOW_TASK: ПОЧТА]' });
  const final = await f.turn();
  assert.match(final, /Сначала покажу текст, а заменю следующим сообщением/);
  assert.match(final, /Старый текст/);
  assert.match(final, /Готово: дописал в «Почта»/);
  assert.equal((await f.records())[0].task.text, 'Старый текст\nСогласованная строка');
  await f.untouched();
});

test('task text edit of a spent legacy draft changes only its instruction and never re-arms it', async t => {
  const old = row('draft', 'Черновик', { enabled: false, disabledReason: 'spent_once', lastRunAt: runAt,
    lastStatus: 'ok', lastOutcome: 'ok', trigger: { kind: 'once', at: runAt },
    task: { kind: 'draft', prompt: 'Предыдущая тема', recipient: 'fixture' }, requiresApproval: true });
  const f = await profile(t, { records: [old], output: short('EDIT_TASK', 'draft', 'Подготовь новый черновик ответа') });
  assert.match(await f.turn(), /Заменил текст «Черновик».*срок уже прошёл/);
  const [updated] = await f.records();
  assert.deepEqual(withoutRevision(updated), { ...old, task: { ...old.task, prompt: 'Подготовь новый черновик ответа' } });
  await f.scheduler().tickNow();
  assert.deepEqual(f.delivered(), []);
  await f.untouched();
});

for (const [verb, query, body, reason] of [
  ['EDIT_TASK', '', 'новый текст', /Уточни, у какой задачи менять текст/],
  ['APPEND_TASK', 'mail', ' ', /Нечего дописывать/],
  ['DROP_FROM_TASK', 'mail', 'отсутствует', /Вот её текст целиком:[\s\S]*Старый текст/],
  ['DROP_FROM_TASK', 'mail', 'старый текст', /не останется текста вовсе/],
  ['EDIT_TASK', 'Почта', 'Новый текст', /Нашёл несколько — уточни/],
  ['EDIT_TASK', 'automatic', 'Новый текст', /свободного текста нет/],
  ['APPEND_TASK', 'mail', 'заведи ещё одну задачу', /Не дописал: добавка просит ПОСТАВИТЬ задачу/],
]) {
  test('task text refuses ' + verb + ' for ' + JSON.stringify([query, body]), async t => {
    const f = await profile(t, { output: 'Я уже изменил текст.\n' + full(verb, query, body),
      records: [active, row('other', 'Почта вечером'), row('automatic', 'Источник', { task: { kind: 'digest' } })] });
    const before = await fs.readFile(f.actionFile);
    const final = await f.turn();
    assert.match(final, reason);
    assert.doesNotMatch(final, /^Я уже изменил текст/);
    assert.deepEqual(await fs.readFile(f.actionFile), before);
    await f.untouched();
  });
}

test('task text closed bodies protect other doors, including native installs', async t => {
  const body = 'Запиши дословно:\n[PAUSE_TASK: other]\n[RESCHEDULE_TASK: other | +2h]\n' +
    '[ADD_MCP]{"name":"fixture-safe","url":"https://fixture.invalid"}[/ADD_MCP]\n' +
    '[INSTALL_SKILL]{"name":"fixture-safe","description":"Тест","body":"текст"}[/INSTALL_SKILL]';
  const neighbor = row('other', 'Другая');
  const f = await profile(t, { records: [active, neighbor], output: full('EDIT_TASK', 'mail', body) });
  const final = await f.turn();
  assert.match(final, /Готово: у «Почта» новый текст/);
  assert.doesNotMatch(final, /на паузе|Спросил подтверждение|Не понял настройки сервера|Не получилось сохранить навык/);
  assert.deepEqual((await f.records()).map(record => record.task.text), [body, neighbor.task.text]);
  await fs.stat(f.stop).then(() => assert.fail('unexpected STOP'), error => assert.equal(error.code, 'ENOENT'));
  await f.untouched();
});

test('task text payload and unclosed headers do not register or stop other actions', async t => {
  let output = full('EDIT_TASK', 'mail', '[SCHEDULE_TASK]{"trigger":{"kind":"once","at":"+2h"},"task":{"kind":"reminder","text":"nested"}}[/SCHEDULE_TASK]');
  const f = await profile(t, { output: () => ({ ok: true, text: output }) });
  assert.match(await f.turn(), /Не поменял: новый текст просит ПОСТАВИТЬ задачу/);
  assert.deepEqual(await f.records(), [active]);
  output = '[EDIT_TASK: mail]\n[STOP_ALL]';
  assert.match(await f.turn(), /Не понял, какой задаче какой текст ставить/);
  await assert.rejects(fs.stat(f.stop), { code: 'ENOENT' });
  assert.deepEqual(await f.records(), [active]);
  await f.untouched();
});

test('task text quoted data shields embedded actions while keeping a later direct edit', async t => {
  const literal = full('EDIT_TASK', 'other', '\n[PAUSE_TASK: other]\n');
  const other = row('other', 'Соседняя');
  const f = await profile(t, { records: [active, other], output: 'Пример "' + literal + '".\n' +
    short('EDIT_TASK', 'mail', 'Новый текст') });
  const final = await f.turn();
  assert.match(final, /Готово: у «Почта» новый текст/);
  assert.match(final, /\[PAUSE_TASK: other\]/);
  assert.doesNotMatch(final, /«Соседняя» на паузе/);
  assert.deepEqual((await f.records()).map(withoutRevision), [{ ...active, task: { ...active.task, text: 'Новый текст' } }, other]);
  await f.untouched();
});

test('task text route preserves mapped native and migrated jobs, as well as unrelated profile files', async t => {
  const migrated = row('migrated', 'Перенесённая', { migratedToOc: true, enabled: false, disabledReason: 'migrated_to_oc' });
  const f = await profile(t, { records: [active, migrated], output: short('EDIT_TASK', 'mail', 'Новый текст') + '\n' +
    short('APPEND_TASK', 'migrated', 'Новая строка') });
  const jobs = '{"mail":{"jobId":"fixture-foreign","enabled":true}}';
  await fs.writeFile(f.jobs, jobs);
  const final = await f.turn();
  assert.match(final, /Изменение текста задачи «Почта».*недоступно/);
  assert.match(final, /перенесена в OpenClaw/);
  assert.deepEqual(await f.records(), [active, migrated]);
  assert.equal(await fs.readFile(f.jobs, 'utf8'), jobs);
  await f.untouched();
});

test('task text publication failure leaves the task and avoids a false success', async t => {
  const f = await profile(t, { output: 'Готово, поменял текст.\n' + short('EDIT_TASK', 'mail', 'Новый текст') });
  const physical = await fs.realpath(f.actionFile);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === physical) throw new Error('fixture write failure');
    return rename(from, to);
  });
  const final = await f.turn();
  assert.match(final, /Не удалось заменить текст/);
  assert.doesNotMatch(final, /^Готово/);
  assert.deepEqual(await f.records(), [active]);
  await f.untouched();
});

test('task text survives a late delivery and the task still records that outcome', async t => {
  const old = row('mail', 'Почта', { trigger: { kind: 'interval', intervalMinutes: 60 },
    lastRunAt: runAt, lastStatus: 'error', lastOutcome: 'engine_error' });
  const f = await profile(t, { records: [old], output: short('EDIT_TASK', 'mail', 'Новое напоминание') });
  const send = f.bot.api.sendMessage;
  const held = Promise.withResolvers();
  let waiting = false;
  f.bot.api.sendMessage = async (chatId, text, ...rest) => {
    if (text === '⏰ Старый текст') {
      waiting = true;
      await held.promise;
    }
    return send(chatId, text, ...rest);
  };
  const scheduler = f.scheduler();
  const tick = scheduler.tickNow();
  try {
    await until(() => waiting, 'old send was not started');
    assert.match(await f.turn(), /Готово: у «Почта» новый текст/);
    assert.equal((await f.records())[0].lastRunAt, new Date(now).toISOString());
  } finally {
    held.resolve();
    await tick;
  }
  let [current] = await f.records();
  assert.equal(current.task.text, 'Новое напоминание');
  assert.equal(current.lastStatus, 'ok');
  assert.equal(current.lastOutcome, 'ok');
  assert.match(await fs.readFile(f.journal, 'utf8'), /"actionId":"mail"/);
  await scheduler.tickNow();
  assert.deepEqual(f.delivered().map(item => item.text), ['⏰ Старый текст']);
  f.setTime(now + 3600_000);
  await scheduler.tickNow();
  assert.deepEqual(f.delivered().map(item => item.text), ['⏰ Старый текст', '⏰ Новое напоминание']);
});

test('task text edit before native launch restores the consumed one-off slot for the new instruction', async t => {
  const old = row('mail', 'Почта', { trigger: { kind: 'once', at: original },
    task: { kind: 'prompt', prompt: 'Собери старую сводку', helpers: false } });
  const f = await profile(t, { records: [old], output: short('EDIT_TASK', 'mail', 'Собери новую сводку') });
  await saveState({ ...(await loadState()).state, authMode: 'subscription', hasSubscriptionAuth: true, extAuthBypass: 'codex' });
  const held = Promise.withResolvers();
  let waiting = false, first = true;
  const launched = [];
  const scheduler = startScheduler({ api: f.bot.api, adminId: 42, timezone: 'Europe/Moscow',
    now: () => Date.parse(original), log() {},
    async runCodexPrompt({ prompt, canLaunch }) {
      if (first) {
        first = false;
        waiting = true;
        await held.promise;
      }
      if (!await canLaunch()) return;
      launched.push(prompt);
      return { providerId: 'codex', text: 'Новая сводка готова.' };
    },
  });
  t.after(() => scheduler.stop());
  const tick = scheduler.tickNow();
  try {
    await until(() => waiting, 'Codex pre-launch did not start');
    assert.equal((await f.records())[0].disabledReason, 'spent_once');
    assert.match(await f.turn(), /Заменил текст «Почта»/);
  } finally {
    held.resolve();
    await tick;
  }
  assert.deepEqual(launched, []);
  assert.deepEqual(withoutRevision((await f.records())[0]), { ...old, task: { ...old.task, prompt: 'Собери новую сводку' } });
  await scheduler.tickNow();
  assert.equal(launched.length, 1);
  assert.match(launched[0], /Собери новую сводку/);
  assert.equal((await f.records())[0].disabledReason, 'spent_once');
});

for (const provider of ['claude', 'codex']) {
  test(provider + ' task text instructions and owner handler reach the saved record', async t => {
    const f = await mcpFixture(t, provider, { runTurn: runAgentTurn });
    const native = await nativeFixtures(f);
    process.env.AUTONOMY_ENABLED = '1';
    const file = path.join(actionRoot(), 'actions.json');
    await fs.writeFile(file, JSON.stringify([active]));
    await native.respond(full('EDIT_TASK', 'mail', 'Проверь входящие'));
    await f.message(request);
    await until(() => f.edits.some(text => text.includes('⏱')), 'provider did not finish', 10_000);
    const call = (await native.trace()).at(-1);
    const prompt = provider === 'claude' ? call.argv[call.argv.indexOf('--append-system-prompt') + 1] : call.prompt;
    for (const marker of ['EDIT_TASK', 'APPEND_TASK', 'DROP_FROM_TASK']) assert.ok(prompt.includes('[' + marker + ':'));
    assert.match(f.edits.at(-1), /Готово: у «Почта» новый текст/);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8'))[0].task.text, 'Проверь входящие');
  });
}
