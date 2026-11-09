/**
 * Ordinary one-shot reminder admission through the real local scheduler.
 * Old blob 73aa9e7e850bad7ac1ea8a8091d086ecbfd47a11: 11060–11148,
 * 11548–11961, 16616–16716, 24743–24827 and 24928–24948.
 * All journal rows, routes and Telegram events belong to disposable fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startScheduler } from '../src/autonomy/scheduler.mjs';
import { botRoot, msbRoot } from '../src/paths.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { fixture } from './helpers/menu-fixture.mjs';

const now = Date.parse('2026-11-08T21:30:00.000Z');
const at = new Date(now).toISOString();
const prior = '2026-11-08T07:00:00.000Z';
const yesterday = '2026-11-07T23:59:59.999Z';
const ownerChat = -100777;
const title = 'Проверить отчёт <папка>';
const reminder = { id: 'fixture-reminder', name: title, enabled: true, runner: 'auto',
  trigger: { kind: 'once', at }, task: { kind: 'reminder', text: title },
  output: { format: 'tg-message' } };

const account = { resetsAt: now / 1000 + 3600, rateLimitType: 'five_hour', utilization: 0.7 };
const historical = (overrides = {}) => ({ ts: prior, actionId: 'historic', name: 'Старая задача',
  kind: 'prompt', status: 'ok', costUsd: 0, tokensIn: 0, ...overrides });

async function append(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, rows.map(row => (typeof row === 'string' ? row : JSON.stringify(row)) + '\n').join(''));
}

async function profile(t, { state = {}, caps = {}, actions = [reminder] } = {}) {
  const f = await fixture(t, async () => assert.fail('A literal reminder must not invoke an owner model'), {
    overlay: false, runtimeProfile: 'jar1', now: () => now,
  });
  for (const key of ['MSB_SESSION_DIR', 'IIA_SESSION_DIR', 'AUTONOMY_DIR', 'AUTONOMY_DAILY_CAP_USD',
    'AUTONOMY_DAILY_CAP_RUNS', 'AUTONOMY_DAILY_CAP_TOKENS', 'AUTONOMY_RESERVE_FRACTION']) delete process.env[key];
  process.env.AUTONOMY_ENABLED = '1';
  Object.assign(process.env, caps);
  await saveState({ ...(await loadState()).state, engine: 'cc', chatId: ownerChat, userId: 42, timezone: 'Europe/Moscow', ...state });
  const root = botRoot();
  const file = path.join(root, 'actions.json');
  const journal = path.join(root, 'autonomy', 'runs.jsonl');
  const rootJournal = path.join(msbRoot(), 'autonomy', 'runs.jsonl');
  const sibling = path.join(msbRoot(), 'bots', 'other', 'autonomy', 'runs.jsonl');
  const setActions = rows => fs.writeFile(file, JSON.stringify(rows));
  await setActions(actions);
  const messages = [], transport = f.bot.api.sendMessage;
  f.bot.api.sendMessage = async (chat, text, ...options) => {
    messages.push({ chat, text, options: options[0] });
    return transport(chat, text, ...options);
  };
  const scheduler = startScheduler({ api: f.bot.api, adminId: 42, timezone: 'Europe/Moscow',
    scheduledTurns: f.bot[Symbol.for('msb.scheduledTurns')], now: () => now, log() {},
    runTurn: async () => assert.fail('The reminder must not use the interval runner'),
  });
  t.after(() => scheduler.stop());
  const readActions = async () => JSON.parse(await fs.readFile(file, 'utf8'));
  const runs = async () => (await fs.readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse);
  return { ...f, root, journal, rootJournal, sibling, messages, scheduler, setActions, readActions, runs };
}

async function assertBlocked(f, reason, id = reminder.id) {
  const [action] = (await f.readActions()).filter(row => row.id === id);
  assert.equal(action.enabled, false);
  assert.equal(action.disabledReason, 'spent_once');
  assert.equal(action.lastRunAt, at);
  assert.equal(action.lastStatus, 'skipped');
  assert.equal(action.lastOutcome, 'blocked');
  assert.equal(Object.hasOwn(action, 'lastError'), false);
  const rows = (await f.runs()).filter(row => row.actionId === id && row.ts === at);
  assert.equal(rows.length, 1);
  const [run] = rows;
  assert.equal(run.status, 'blocked');
  assert.equal(run.costUsd, 0);
  assert.match(run.detail, reason);
  assert.deepEqual(f.messages.filter(row => row.text.includes('«' + action.name + '»')), [{
    chat: ownerChat, text: '📡 Автономное действие «' + action.name + '» приостановлено: ' + run.detail, options: undefined,
  }]);
  assert.ok(!f.messages.some(row => row.text === '⏰ ' + action.task.text));
}

test('box USD adds current UTC-day root and sibling spending before the old $0.10 estimate', async t => {
  const f = await profile(t, { actions: [{ ...reminder, lastError: 'stale' }] });
  await append(f.rootJournal, [historical({ status: 'stopped', costVisible: false, costUsd: 2 }),
    historical({ ts: yesterday, costUsd: 700 })]);
  await append(f.sibling, [historical({ costUsd: 2.95 }), '{broken row']);
  await f.scheduler.tickNow();
  await f.scheduler.tickNow();
  await assertBlocked(f, /дневной предел расходов автономки: \$5\.05 против \$5\.00 \(весь сервер, ботов: 2\)/);
  await f.callback('auto:history');
  assert.match(f.edits.at(-1), /заблокировано: ход выйдет за дневной предел/);
  assert.match(f.edits.at(-1), /Проверить отчёт &lt;папка&gt;/);
});

test('run cap counts blocked runs and excludes only skipped and stopped before checking tokens', async t => {
  const f = await profile(t, { caps: { AUTONOMY_DAILY_CAP_RUNS: '1', AUTONOMY_DAILY_CAP_TOKENS: '1000' } });
  await append(f.sibling, [historical({ status: 'skipped', tokensIn: 8000 }),
    historical({ status: 'stopped', tokensIn: 9000 }),
    historical({ status: 'blocked', tokensIn: 1000 })]);
  await f.scheduler.tickNow();
  await assertBlocked(f, /сегодня автономка сделала 1 ход — это весь дневной запас \(1\)/);
});

test('input cap uses recorded input tokens and ignores output or tokens from stopped runs', async t => {
  const f = await profile(t, { caps: { AUTONOMY_DAILY_CAP_TOKENS: '2000' } });
  await append(f.rootJournal, [historical({ tokensIn: 1500, tokensOut: 900000 }),
    historical({ status: 'error', tokensIn: 500 }), historical({ status: 'stopped', tokensIn: 40000 })]);
  await f.scheduler.tickNow();
  await assertBlocked(f, /прочитала 2 тысяч токенов за 2 хода — это весь дневной запас \(2 тысяч\)/);
});

test('explicit zero per-action run and day limits both reject the estimate even with no price history', async t => {
  const actions = [
    { ...reminder, budget: { maxUsdPerRun: 0 } },
    { ...reminder, id: 'day', name: 'Дневной предел', task: { ...reminder.task, text: 'Дневной предел' }, budget: { maxUsdPerDay: 0 } },
  ];
  const f = await profile(t, { actions });
  await f.scheduler.tickNow();
  await assertBlocked(f, /оценка хода \$0\.10 > лимита действия на ход \$0/);
  await assertBlocked(f, /действие за день дойдёт до \$0\.10 > лимита \$0/, 'day');
});

test('owner reserve uses the owner-local calendar day and the old default 30 percent', async t => {
  const f = await profile(t, { state: { dailySpendLimit: 1, costHistory: { '2026-11-08': 0, '2026-11-09': 0.65 } } });
  await f.scheduler.tickNow();
  await assertBlocked(f, /израсходовано \$0\.65.*потолок автономки \$0\.70 \(резерв \$0\.30 для диалога\)/);
});

test('saved owner cost pause blocks a reminder with unavailable billing data', async t => {
  const f = await profile(t, { state: { costPaused: true } });
  await f.scheduler.tickNow();
  await assertBlocked(f, /дневной лимит расходов уже достигнут \(costPaused\)/);
});

test('an open legacy breaker spends its once quietly and an expired breaker allows delivery', async t => {
  const second = { ...reminder, id: 'expired', name: 'Срок защиты истёк', task: { ...reminder.task, text: 'Срок защиты истёк' } };
  const f = await profile(t, { actions: [reminder, second] });
  const file = path.join(f.root, 'autonomy', 'breakers.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    [reminder.id]: { open: true, consecutiveFailures: 3, backoffUntil: new Date(now + 60_000).toISOString() },
    [second.id]: { open: true, consecutiveFailures: 3, backoffUntil: at },
  }));
  await f.scheduler.tickNow();
  const [skipped, sent] = await f.readActions();
  assert.equal(skipped.lastStatus, 'skipped');
  assert.equal(skipped.lastOutcome, 'blocked');
  assert.equal(skipped.disabledReason, 'spent_once');
  assert.equal(sent.lastStatus, 'ok');
  assert.deepEqual(f.messages.map(row => row.text), ['⏰ Срок защиты истёк']);
  assert.deepEqual((await f.runs()).map(row => row.status), ['skipped', 'ok']);
  assert.match((await f.runs())[0].detail, /breaker открыт до/);
});

test('fresh Claude quota rejects only Claude and cannot block Codex after the switch', async t => {
  const f = await profile(t, { state: { extAuthBypass: undefined, rateLimitInfo: account } });
  await f.scheduler.tickNow();
  await assertBlocked(f, /подписка Claude израсходована на 70%/);
  const done = await f.readActions();
  const next = { ...reminder, id: 'codex-next', name: 'Codex', task: { ...reminder.task, text: 'Текст Codex' } };
  await f.setActions([...done, next]);
  await saveState({ ...(await loadState()).state, extAuthBypass: 'codex' });
  await f.scheduler.tickNow();
  assert.equal(f.messages.at(-1).text, '⏰ Текст Codex');
  assert.deepEqual((await loadState()).state.rateLimitInfo, account);
});
