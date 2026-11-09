/**
 * A conversational SCHEDULE_TASK reaches the real [registration](../src/telegram/reminder-markers.mjs)
 * and [saved runner](../src/autonomy/prompt-turn.mjs). Old contract in
 * [parity-autonomy-contract.txt](./reference/parity-autonomy-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startScheduler } from '../src/autonomy/scheduler.mjs';
import { savedPromptPlan } from '../src/autonomy/prompt-policy.mjs';
import { nextReminderCronAt } from '../src/autonomy/reminder-schedule.mjs';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { actionRoot, statePath } from '../src/paths.mjs';
import { loadState, saveState, updateState } from '../src/state.mjs';
import { marker, reminderFixture, until } from './helpers/reminder-registration-fixture.mjs';
import { mcpFixture } from './helpers/mcp-fixture.mjs';
import { nativeFixtures } from './helpers/mcp-launch-fixture.mjs';

const clause = 'Прочитай заметки проекта и собери краткую сводку.';
const once = { kind: 'once', at: '+15m' };
const daily = { kind: 'recurring', cron: '0 20 * * *' };
const savedCodex = Symbol.for('msb.savedCodexPrompt');
const standard = { profile: 'standard', whatNotToDo: ['не публиковать ничего автоматически'] };
const promptAction = (trigger = once, task = {}, options = {}) => ({
  trigger, task: { kind: 'prompt', prompt: clause, ...task }, ...options,
});
const setClaude = () => updateState(state => ({ ...state, extAuthBypass: undefined,
  authMode: 'subscription', hasSubscriptionAuth: true }));

for (const provider of ['claude', 'codex']) {
  test(provider + ' registers from a normal final turn and executes the saved collection through its own isolated CLI', async t => {
    const f = await mcpFixture(t, provider, { runTurn: runAgentTurn });
    const native = await nativeFixtures(f);
    const quiet = provider === 'claude';
    process.env.AUTONOMY_ENABLED = '1';
    for (const key of ['AUTONOMY_MAX_ACTIONS', 'AUTONOMY_DAILY_CAP_USD', 'AUTONOMY_DAILY_CAP_RUNS',
      'AUTONOMY_DAILY_CAP_TOKENS', 'AUTONOMY_RESERVE_FRACTION']) delete process.env[key];
    const profile = { ...(await loadState()).state, chatId: 42, userId: 42,
      timezone: 'Europe/Moscow', authMode: 'subscription', hasSubscriptionAuth: true };
    await saveState(profile);
    const auth = path.join(process.env.CODEX_HOME, 'auth.json');
    if (provider === 'codex') await fs.writeFile(auth, JSON.stringify({
      auth_mode: 'chatgpt', tokens: { access_token: 'fixture-saved-native' },
    }));
    await native.respond(marker(promptAction(quiet ? once : daily, quiet ? { helpers: false } : {}, {
      quiet, maxMinutes: quiet ? 1.2 : 42.4,
    })));
    await f.message(quiet ? 'Через пятнадцать минут сверь заметки' : 'Каждый вечер в восемь собирай заметки');
    await until(() => f.edits.some(text => text.includes('⏱')), 'ordinary final response did not arrive', 10_000);
    const foreground = (await native.trace()).at(-1);
    const system = provider === 'claude' ? foreground.argv[foreground.argv.indexOf('--append-system-prompt') + 1] : foreground.prompt;
    assert.match(system, /\[SCHEDULE_TASK\].*"kind":"prompt"/);
    const root = actionRoot();
    const file = path.join(root, 'actions.json');
    const [entry] = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.match(entry.id, /^conv-prompt-/);
    assert.equal(entry.name, 'Задача: Прочитай заметки проекта и собери…');
    assert.deepEqual(entry.task, { kind: 'prompt', prompt: clause, ...(quiet ? { helpers: false } : {}) });
    assert.equal(entry.enabled, true);
    assert.equal(entry.capability, 'read');
    assert.deepEqual(entry.authority, standard);
    assert.equal(entry.runner, 'auto');
    assert.equal(entry.requestedKind, 'prompt');
    assert.equal(entry.requiresApproval, false);
    assert.deepEqual(entry.origin, { chatId: 42 });
    assert.deepEqual(entry.output, { format: 'tg-message', deliverTo: { chatId: 42 }, store: false,
      silentIfEmpty: true, ...(quiet ? { emptyIsValidOutcome: true } : {}) });
    assert.equal(entry.budget.maxRunSeconds, quiet ? 60 : 42 * 60);
    assert.equal(entry.trigger.kind, quiet ? 'once' : 'cron');
    assert.ok(f.edits.some(text => text.includes('Она сможет читать и сохранять файлы у тебя на сервере.')));
    const plan = savedPromptPlan(entry, profile, process.env, provider === 'codex');
    assert.equal(plan.timeoutMs, (quiet ? 60 : 1800) * 1000 - 15_000);
    const now = quiet ? Date.parse(entry.trigger.at)
      : nextReminderCronAt(entry.trigger.cron, Date.parse(entry.createdAt), profile.timezone);
    assert.ok(Number.isFinite(now));
    const protectedFiles = [statePath(), f.storeFile, ...(provider === 'codex' ? [auth, f.native] : [])];
    const snapshot = () => Promise.all(protectedFiles.map(file => fs.readFile(file)));
    const before = await snapshot();
    const sentBefore = f.messages.length;
    await native.respond(quiet ? '[NOTHING_TO_REPORT]' : 'Итог сбора <данные>');
    const scheduler = startScheduler({ api: f.bot.api, adminId: 42, timezone: profile.timezone, now: () => now,
      runCodexPrompt: f.bot[savedCodex], log() {},
      runTurn: async () => assert.fail('Saved collection cannot run in the shared owner turn') });
    t.after(() => scheduler.stop());
    await scheduler.tickNow();
    await scheduler.tickNow();
    const [run] = (await native.trace()).slice(-1);
    assert.equal(run.kind, provider === 'claude' ? 'claude' : 'codex-exec');
    assert.equal(run.cwd, await fs.realpath(path.join(root, 'autonomy', 'cc-workspace')));
    assert.match(run.prompt, /Прочитай заметки проекта и собери краткую сводку/);
    assert.doesNotMatch(run.prompt, /\[SCHEDULE_TASK\]/);
    if (provider === 'claude') {
      assert.ok(run.argv.includes('--no-session-persistence') && !run.argv.includes('--resume'));
      const tools = run.argv[run.argv.indexOf('--tools') + 1].split(',');
      assert.ok(tools.includes('Read') && tools.includes('Write') && !tools.includes('Bash') && !tools.includes('Agent'));
      assert.equal(f.messages.length, sentBefore);
    } else {
      assert.ok(run.argv.includes('--ephemeral') && !run.argv.includes('resume'));
      assert.ok(run.argv.includes('features.multi_agent_v2=true'));
      assert.ok(f.messages.slice(sentBefore).some(text => text.includes('Итог сбора &lt;данные&gt;')));
    }
    assert.deepEqual(await snapshot(), before);
    const [record] = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(record.enabled, !quiet);
    assert.equal(record.lastOutcome, quiet ? 'empty' : 'ok');
    const entries = (await fs.readFile(path.join(root, 'autonomy', 'runs.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(entries.map(row => [row.actionId, row.kind, row.status]), [[entry.id, 'prompt', quiet ? 'skipped' : 'ok']]);
  });
}

test('the old prefix guard and nullish text aliases keep only the work instruction', async t => {
  const output = [
    promptAction(once, { prompt: '  Поставь задачу на вечер: Каждый день в 20:00 собери краткую сводку по заметкам.  ' }),
    promptAction(once, { prompt: null, text: '  Сверь состояние источника.  ' }),
    promptAction(once, { prompt: null, text: null, topic: '  Проверь новые строки списка.  ', helpers: true }),
    promptAction(once, { prompt: ' ', text: 'Эта строка не является запасной для пустого prompt.' }),
    promptAction(once, { prompt: null, text: 'Сначала поставь ещё одну задачу, а потом отправь отчёт.' }),
    promptAction(once, { prompt: 'Посмотри, как работает [schedule_task], и примени.' }),
    promptAction(once, { prompt: 'Поставь задачу: Отчёт.' }),
  ].map(marker).join('\n');
  const f = await reminderFixture(t, { output });
  await setClaude();
  await f.request('Поставь разрешённые сборы');
  const final = await f.final();
  assert.match(final, /для задачи-запроса нужен текст инструкции/);
  assert.match(final, /в текст задачи попала просьба ПОСТАВИТЬ задачу/);
  const rows = await f.records();
  assert.deepEqual(rows.map(row => [row.task.prompt, row.task.helpers]), [
    ['собери краткую сводку по заметкам.', undefined],
    ['Сверь состояние источника.', undefined],
    ['Проверь новые строки списка.', true],
  ]);
  assert.equal(new Set(rows.map(row => row.id)).size, 3);
  assert.ok(rows.every(row => !row.budget));
});

test('advanced and explicitly routed requests are refused instead of being saved as an ordinary collection', async t => {
  const output = [
    promptAction(once, { shell: true }),
    promptAction(once, {}, { memory: 'continuous' }),
    promptAction(once, { team: [{ name: 'fixture', brief: 'собирает' }] }),
    promptAction(once, { freshness: { paths: ['/fixture'], maxAgeHours: 2 } }),
    promptAction(once, { provider: 'codex', model: 'gpt-fixture' }),
    promptAction(once, {}, { output: { store: true } }),
    promptAction({ kind: 'when', check: { kind: 'service', unit: 'fixture' } }),
  ].map(marker).join('\n');
  const f = await reminderFixture(t, { output });
  await setClaude();
  await f.request('Проверь разные режимы сбора');
  const final = await f.final();
  assert.match(final, /этот режим сбора пока не подключён/);
  assert.doesNotMatch(final, /Ок, поставил/);
  await assert.rejects(fs.stat(f.actionFile), { code: 'ENOENT' });
});

test('a supported collection may be registered during STOP and stays pending', async t => {
  const f = await reminderFixture(t, { output: marker(promptAction()) });
  await setClaude();
  const autonomy = path.join(f.directory, 'autonomy');
  await fs.mkdir(autonomy, { recursive: true });
  await fs.writeFile(path.join(autonomy, 'STOP'), 'fixture pause');
  await f.request('Через пятнадцать минут сверь заметки');
  assert.match(await f.final(), /Поставил:.*Но сейчас задачи на паузе/s);
  const [entry] = await f.records();
  f.setTime(Date.parse(entry.trigger.at));
  await f.scheduler().tickNow();
  assert.equal((await f.records())[0].lastRunAt, undefined);
  assert.equal(f.modelCalls.length, 1);
});

test('a provider switch before publishing refuses an unavailable route and leaves the action file untouched', async t => {
  const f = await reminderFixture(t, { output: marker(promptAction()) });
  await setClaude();
  const target = path.join(await fs.realpath(f.directory), 'actions.json');
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const read = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (file === target) {
      entered.resolve();
      await release.promise;
    }
    return read(file, ...args);
  });
  await f.request('Через пятнадцать минут сверь заметки');
  try {
    await Promise.race([entered.promise, f.final().then(() => assert.fail('Expected the action check before the reply'))]);
    await updateState(state => ({ ...state, extAuthBypass: 'codex' }));
  } finally {
    release.resolve();
  }
  const final = await f.final();
  assert.match(final, /сбор на выбранном движке недоступен/);
  assert.doesNotMatch(final, /Ок, поставил/);
  await assert.rejects(fs.stat(f.actionFile), { code: 'ENOENT' });
});
