/**
 * Ordinary one-shot reminder admission through the real local scheduler.
 * Old blob 73aa9e7e850bad7ac1ea8a8091d086ecbfd47a11: 11060–11148,
 * 11548–11961, 13249–13429, 16616–16716, 24743–24893 and 24928–24948.
 * All journal rows, routes and Telegram events belong to disposable fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setOwnerPause } from '../src/autonomy/owner-pause.mjs';
import { startScheduler } from '../src/autonomy/scheduler.mjs';
import { actionRoot, msbRoot } from '../src/paths.mjs';
import { loadState, saveState, updateState } from '../src/state.mjs';
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

async function profile(t, { state = {}, caps = {}, actions = [reminder], sessionOverride = false, readCodexQuota } = {}) {
  const f = await fixture(t, async () => assert.fail('A literal reminder must not invoke an owner model'), {
    overlay: false, runtimeProfile: 'jar1', now: () => now,
  });
  for (const key of ['MSB_SESSION_DIR', 'IIA_SESSION_DIR', 'AUTONOMY_DIR', 'AUTONOMY_DAILY_CAP_USD',
    'AUTONOMY_DAILY_CAP_RUNS', 'AUTONOMY_DAILY_CAP_TOKENS', 'AUTONOMY_RESERVE_FRACTION']) delete process.env[key];
  process.env.AUTONOMY_ENABLED = '1';
  if (sessionOverride) process.env.IIA_SESSION_DIR = path.join(f.home, 'old-profile', 'sessions');
  Object.assign(process.env, caps);
  await saveState({ ...(await loadState()).state, engine: 'cc', chatId: ownerChat, userId: 42, timezone: 'Europe/Moscow', ...state });
  const root = actionRoot();
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, 'actions.json');
  const journal = path.join(root, 'autonomy', 'runs.jsonl');
  const breakerFile = path.join(root, 'autonomy', 'breakers.json');
  const seedBreakers = async rows => {
    await fs.mkdir(path.dirname(breakerFile), { recursive: true });
    await fs.writeFile(breakerFile, JSON.stringify(rows));
  };
  const readBreakers = async () => JSON.parse(await fs.readFile(breakerFile, 'utf8'));
  const rootJournal = path.join(msbRoot(), 'autonomy', 'runs.jsonl');
  const sibling = path.join(msbRoot(), 'bots', 'other', 'autonomy', 'runs.jsonl');
  const setActions = rows => fs.writeFile(file, JSON.stringify(rows));
  await setActions(actions);
  const messages = [], transport = f.bot.api.sendMessage;
  f.bot.api.sendMessage = async (chat, text, ...options) => {
    messages.push({ chat, text, options: options[0] });
    return transport(chat, text, ...options);
  };
  let clock = now;
  const logs = [];
  const scheduler = startScheduler({ api: f.bot.api, readCodexQuota, adminId: 42, timezone: 'Europe/Moscow',
    scheduledTurns: f.bot[Symbol.for('msb.scheduledTurns')], now: () => clock, log: line => logs.push(line),
    runTurn: async () => assert.fail('The reminder must not use the interval runner'),
  });
  t.after(() => scheduler.stop());
  const readActions = async () => JSON.parse(await fs.readFile(file, 'utf8'));
  const runs = async () => (await fs.readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse);
  return { ...f, root, file, journal, rootJournal, sibling, messages, scheduler, setActions, readActions, runs,
    breakerFile, seedBreakers, readBreakers, logs, setTime(value) { clock = value; } };
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
  assert.match(f.edits.at(-1), /приостановлено \(бюджет\): ход выйдет за дневной предел/);
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
  const firstBreaker = { open: true, consecutiveFailures: 3, backoffUntil: new Date(now + 60_000).toISOString() };
  const openedAt = new Date(now - 600_000).toISOString();
  await f.seedBreakers({
    [reminder.id]: firstBreaker,
    [second.id]: { open: true, consecutiveFailures: 3, backoffUntil: at, openedAt, notifiedOpenAt: openedAt,
      crashWindow: [openedAt], lastFailureAt: openedAt, lastReason: 'предыдущий сбой', retained: 'старое поле' },
  });
  await f.scheduler.tickNow();
  const [skipped, sent] = await f.readActions();
  assert.equal(skipped.lastStatus, 'skipped');
  assert.equal(skipped.lastOutcome, 'blocked');
  assert.equal(skipped.disabledReason, 'spent_once');
  assert.equal(sent.lastStatus, 'ok');
  assert.deepEqual(f.messages.map(row => row.text), ['⏰ Срок защиты истёк',
    '✔ Автономное действие «Срок защиты истёк» снова работает. Пауза была 10 минут.']);
  const breakers = await f.readBreakers();
  assert.deepEqual(breakers[reminder.id], firstBreaker);
  assert.deepEqual(breakers[second.id], { open: false, consecutiveFailures: 0, crashWindow: [], lastSuccessAt: at,
    lastFailureAt: openedAt, lastReason: 'предыдущий сбой', retained: 'старое поле' });
  assert.ok(f.messages.every(row => row.chat === ownerChat));
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

test('zero box caps disable each limit and per-action equality uses the legacy estimate', async t => {
  const f = await profile(t, { caps: {
    AUTONOMY_DAILY_CAP_USD: '0', AUTONOMY_DAILY_CAP_RUNS: '0', AUTONOMY_DAILY_CAP_TOKENS: '0',
  }, actions: [{ ...reminder, budget: { maxUsdPerRun: 0.10, maxUsdPerDay: 0.10 } }] });
  await append(f.journal, [historical({ actionId: reminder.id, costUsd: 50, tokensIn: 30_000_000 })]);
  await f.scheduler.tickNow();
  assert.equal(f.messages[0].text, '⏰ ' + title);
  assert.equal((await f.runs()).at(-1).costUsd, 0);
  assert.equal((await f.readActions())[0].lastOutcome, 'ok');
});

test('the explicit reserve overrides per-bot configuration and expired Claude quota is ignored', async t => {
  const f = await profile(t, { caps: { AUTONOMY_RESERVE_FRACTION: '0' },
    state: { extAuthBypass: undefined, rateLimitInfo: { ...account, resetsAt: now / 1000 },
      dailySpendLimit: 1, costHistory: { '2026-11-09': 0.8 } },
  });
  const config = path.join(f.root, 'autonomy', 'config.json');
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.writeFile(config, '{"enabled":true,"reserveFraction":0.9}');
  await f.scheduler.tickNow();
  assert.deepEqual(f.messages.map(row => row.text), ['⏰ ' + title]);
});

test('linked journals count once and the next due action sees the completed first run', async t => {
  const next = { ...reminder, id: 'next', name: 'Следующее', task: { ...reminder.task, text: 'Следующее' } };
  const f = await profile(t, { caps: { AUTONOMY_DAILY_CAP_RUNS: '2' }, actions: [reminder, next] });
  await append(f.journal, [historical()]);
  await fs.mkdir(path.dirname(f.rootJournal), { recursive: true });
  await fs.symlink(f.journal, f.rootJournal);
  await f.scheduler.tickNow();
  assert.equal(f.messages[0].text, '⏰ ' + title);
  await assertBlocked(f, /сегодня автономка сделала 2 хода/, next.id);
});

test('old tail is 500 parsed rows per journal, not 500 source lines', async t => {
  const f = await profile(t, { caps: { AUTONOMY_DAILY_CAP_RUNS: '1' } });
  await append(f.sibling, [historical({ costUsd: 20 }),
    ...Array.from({ length: 499 }, () => historical({ ts: yesterday })), '{broken tail',
    historical({ ts: yesterday })]);
  await f.scheduler.tickNow();
  assert.deepEqual(f.messages.map(row => row.text), ['⏰ ' + title]);
});

test('an existing completed interval row counts as a run with its price and input tokens unknown', async t => {
  const f = await profile(t, { caps: { AUTONOMY_DAILY_CAP_RUNS: '1', AUTONOMY_DAILY_CAP_TOKENS: '1000' } });
  process.env.AUTONOMY_DIR = path.join(f.home, 'custom-intervals');
  await append(path.join(process.env.AUTONOMY_DIR, 'runs.jsonl'), [
    { at: prior, taskId: 'interval', ok: false, error: 'fixture result', preview: 'Synthetic output only' },
  ]);
  await f.scheduler.tickNow();
  await assertBlocked(f, /сегодня автономка сделала 1 ход/);
});

test('a failed limit notice does not undo or repeat the spent action', async t => {
  const f = await profile(t, { state: { costPaused: true } });
  let attempts = 0;
  f.bot.api.sendMessage = async (_chat, text) => {
    assert.match(text, /📡 Автономное действие/);
    assert.equal((await f.readActions())[0].lastOutcome, 'blocked');
    assert.equal((await f.runs())[0].status, 'blocked');
    attempts++;
    throw Error('fixture transport failure');
  };
  await f.scheduler.tickNow();
  await f.scheduler.tickNow();
  assert.equal(attempts, 1);
  assert.equal((await f.runs()).length, 1);
});

async function whileJournalReads(t, f, change) {
  await append(f.rootJournal, [historical()]);
  const journal = await fs.realpath(f.rootJournal);
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const read = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', async (...args) => {
    if (args[0] === journal) {
      entered.resolve();
      await resume.promise;
    }
    return read(...args);
  });
  const pending = f.scheduler.tickNow();
  try {
    await Promise.race([entered.promise, new Promise((_, reject) => {
      setTimeout(() => reject(Error('fixture did not reach the shared journal')), 1500).unref();
    })]);
    await change();
  } finally {
    resume.resolve();
    await pending;
  }
}

test('provider switch during journal I/O uses the new rail at the claim', { timeout: 5000 }, async t => {
  const f = await profile(t, { state: { extAuthBypass: undefined, rateLimitInfo: account } });
  await whileJournalReads(t, f, () => updateState(state => ({ ...state, extAuthBypass: 'codex' })));
  assert.deepEqual(f.messages.map(row => row.text), ['⏰ ' + title]);
});

test('a pause can commit while journal I/O is pending and prevents the claim', { timeout: 5000 }, async t => {
  const f = await profile(t);
  const initial = await f.readActions();
  await whileJournalReads(t, f, () => setOwnerPause(true, {
    now, check: () => undefined, checkEngine: () => undefined,
  }));
  assert.deepEqual(f.messages, []);
  assert.deepEqual(await f.readActions(), initial);
  await assert.rejects(fs.stat(f.journal), { code: 'ENOENT' });
});

test('interval preflight refusals do not spend the completed-run allowance', async t => {
  const f = await profile(t, { caps: { AUTONOMY_DAILY_CAP_RUNS: '1' } });
  await append(f.rootJournal, ['setup', 'engine_oc'].map(error => ({
    at: prior, taskId: 'no-cli', ok: false, error, preview: 'Fixture refused before launching',
  })));
  await f.scheduler.tickNow();
  assert.deepEqual(f.messages.map(row => row.text), ['⏰ ' + title]);
});

test('one real send failure advances the breaker once and never rearms a spent reminder', async t => {
  const f = await profile(t);
  const other = { open: true, consecutiveFailures: 7, otherField: ['preserve'] };
  await f.seedBreakers({ 'other-action': other });
  let attempts = 0;
  f.bot.api.sendMessage = async (chat, text) => {
    assert.equal(chat, ownerChat);
    assert.equal(text, '⏰ ' + title);
    attempts++;
    f.setTime(now + 90_000);
    throw Error('private transport fixture');
  };
  await f.scheduler.tickNow();
  await f.scheduler.tickNow();
  assert.equal(attempts, 1);
  assert.equal((await f.readActions())[0].disabledReason, 'spent_once');
  const runs = await f.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'error');
  assert.equal(runs[0].ts, at);
  assert.doesNotMatch(JSON.stringify(runs), /private transport fixture/);
  assert.deepEqual(await f.readBreakers(), { 'other-action': other, [reminder.id]: {
    open: false, consecutiveFailures: 1, crashWindow: [], lastFailureAt: at, lastReason: 'не удалось отправить напоминание',
  } });
});

test('an old threshold crossing announces one pause and later failures extend backoff without duplicate notice', async t => {
  const retry = { ...reminder, id: 'retry', name: 'Повтор после паузы', task: { ...reminder.task, text: 'Повтор' } };
  const cap = { ...reminder, id: 'cap', name: 'Верхний предел', task: { ...reminder.task, text: 'Предел' } };
  const f = await profile(t, { actions: [reminder, retry, cap] });
  const justBefore = new Date(now - 30_000).toISOString();
  await f.seedBreakers({
    [reminder.id]: { open: false, consecutiveFailures: 2, crashWindow: [prior, justBefore], retained: 17 },
    [retry.id]: { open: true, consecutiveFailures: 3, openedAt: prior, notifiedOpenAt: prior, backoffUntil: at },
    [cap.id]: { open: true, consecutiveFailures: 9, openedAt: prior, notifiedOpenAt: prior, backoffUntil: at },
  });
  const send = f.bot.api.sendMessage;
  f.bot.api.sendMessage = async (chat, text, ...options) => {
    if (text.startsWith('⏰')) throw Error('fixture failure');
    const current = (await f.readBreakers())[reminder.id];
    assert.equal(current.open, true, 'write the breaker before sending its notice');
    assert.equal((await f.runs()).find(row => row.actionId === reminder.id)?.status, 'error');
    return send(chat, text, ...options);
  };
  await f.scheduler.tickNow();
  await f.scheduler.tickNow();
  const rows = await f.readBreakers();
  assert.deepEqual(rows[reminder.id], { open: true, consecutiveFailures: 3, crashWindow: [justBefore], retained: 17,
    lastFailureAt: at, lastReason: 'не удалось отправить напоминание', openedAt: at, notifiedOpenAt: at,
    backoffUntil: new Date(now + 300_000).toISOString(),
  });
  assert.equal(rows[retry.id].backoffUntil, new Date(now + 600_000).toISOString());
  assert.equal(rows[retry.id].openedAt, prior);
  assert.equal(rows[cap.id].backoffUntil, new Date(now + 3_600_000).toISOString());
  assert.equal(rows[cap.id].notifiedOpenAt, prior);
  assert.deepEqual(f.messages, [{ chat: ownerChat, options: undefined,
    text: '📡 Автономное действие «' + title + '» не выполнилось несколько раз подряд.\n' +
      'Причина: не удалось отправить напоминание.\nПоставил на паузу до 00:35 (МСК).',
  }]);
});

test('an owner pause and a budget refusal leave the old breaker bytes alone', async t => {
  const f = await profile(t, { state: { costPaused: true } });
  await f.seedBreakers({ [reminder.id]: { open: true, consecutiveFailures: 4, backoffUntil: at } });
  const bytes = await fs.readFile(f.breakerFile);
  const route = { now, check() {}, checkEngine() {} };
  await setOwnerPause(true, route);
  await f.scheduler.tickNow();
  await assert.rejects(fs.stat(f.journal), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(f.breakerFile), bytes);
  await setOwnerPause(false, route);
  await f.scheduler.tickNow();
  await assertBlocked(f, /costPaused/);
  assert.deepEqual(await fs.readFile(f.breakerFile), bytes);
});

test('a breaker opened while reading usage is checked again before the local attempt is claimed', async t => {
  const f = await profile(t);
  await f.seedBreakers({ [reminder.id]: { open: false, consecutiveFailures: 2 } });
  await append(f.journal, [historical()]);
  const reading = Promise.withResolvers();
  const release = Promise.withResolvers();
  const physicalJournal = await fs.realpath(f.journal);
  const readFile = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', async (file, ...options) => {
    if (file === physicalJournal) {
      reading.resolve();
      await release.promise;
    }
    return readFile(file, ...options);
  });
  const tick = f.scheduler.tickNow();
  try {
    await Promise.race([reading.promise, tick.then(() => assert.fail('Expected a usage read'))]);
    await f.seedBreakers({ [reminder.id]: { open: true, consecutiveFailures: 3,
      backoffUntil: new Date(now + 300_000).toISOString() } });
  } finally {
    release.resolve();
  }
  await tick;
  assert.equal(f.messages.length, 0);
  assert.equal((await f.runs()).at(-1).status, 'skipped');
  assert.equal((await f.readBreakers())[reminder.id].consecutiveFailures, 3);
});

test('a replaced action cannot acquire the old admitted attempt’s breaker state', async t => {
  const f = await profile(t);
  const next = { ...reminder, name: 'Новая запись', task: { ...reminder.task, text: 'Другой текст' } };
  f.bot.api.sendMessage = async () => {
    await f.setActions([next]);
    throw Error('failed prior transport');
  };
  await f.scheduler.tickNow();
  assert.deepEqual(await f.readActions(), [next]);
  assert.equal((await f.runs()).at(-1).status, 'error');
  await assert.rejects(fs.stat(f.breakerFile), { code: 'ENOENT' });
});

test('old session mapping preserves a linked breaker and refuses to overwrite damaged saved data', async t => {
  const f = await profile(t, { sessionOverride: true });
  const actual = path.join(f.home, 'breaker-target.json');
  const sibling = path.join(msbRoot(), 'bots', 'other', 'autonomy', 'breakers.json');
  const previous = { 'another-id': { open: false, custom: 23 } };
  await fs.mkdir(path.dirname(f.breakerFile), { recursive: true });
  await fs.mkdir(path.dirname(sibling), { recursive: true });
  await fs.writeFile(sibling, '{"sibling":"unchanged"}');
  await fs.writeFile(actual, JSON.stringify(previous), { mode: 0o640 });
  await fs.symlink(actual, f.breakerFile);
  await f.scheduler.tickNow();
  assert.equal(await fs.readlink(f.breakerFile), actual);
  assert.equal((await fs.stat(actual)).mode & 0o777, 0o640);
  const written = JSON.parse(await fs.readFile(actual, 'utf8'));
  assert.deepEqual(written['another-id'], previous['another-id']);
  assert.equal(written[reminder.id].lastSuccessAt, at);
  assert.equal(await fs.readFile(sibling, 'utf8'), '{"sibling":"unchanged"}');
  const corrupt = '{existing incomplete bytes';
  await fs.writeFile(actual, corrupt);
  const next = { ...reminder, id: 'next' };
  await f.setActions([next]);
  await f.scheduler.tickNow();
  assert.equal((await f.readActions())[0].lastStatus, 'ok');
  assert.equal((await f.runs()).at(-1).status, 'ok');
  assert.equal(await fs.readFile(actual, 'utf8'), corrupt);
  assert.ok(f.logs.some(line => line.includes('Could not save reminder breaker')));
  assert.ok(!f.logs.some(line => line.includes(corrupt)));
});

test('a failed breaker notice leaves the saved transition and attempt intact', async t => {
  const f = await profile(t);
  await f.seedBreakers({ [reminder.id]: { open: false, consecutiveFailures: 2 } });
  let deliveries = 0, notices = 0;
  f.bot.api.sendMessage = async (_chat, text) => {
    if (text.startsWith('⏰')) deliveries++;
    else notices++;
    throw Error('fixture Telegram failure');
  };
  await f.scheduler.tickNow();
  await f.scheduler.tickNow();
  assert.equal(deliveries, 1);
  assert.equal(notices, 1);
  assert.equal((await f.readBreakers())[reminder.id].consecutiveFailures, 3);
  assert.equal((await f.readActions())[0].lastStatus, 'error');
  assert.deepEqual((await f.runs()).map(row => row.status), ['error']);
  assert.ok(f.logs.includes('[msb/reminder] Could not send the breaker notice'));
});

test('a breaker link to its own action file leaves the reminder and scheduler functional', { timeout: 3000 }, async t => {
  const f = await profile(t);
  await fs.mkdir(path.dirname(f.breakerFile), { recursive: true });
  await fs.symlink(f.file, f.breakerFile);
  // A regression must fail the watchdog without also hanging the test cleanup.
  const stop = f.scheduler.stop;
  f.scheduler.stop = () => { void stop(); };
  await f.scheduler.tickNow();
  assert.equal((await f.readActions())[0].lastStatus, 'ok');
  assert.equal((await f.runs()).at(-1).status, 'ok');
  assert.equal(await fs.readlink(f.breakerFile), f.file);
  assert.ok(f.logs.some(line => line.includes('Could not save reminder breaker')));
});


const codexState = { extAuthBypass: 'codex' };
const codexWindow = (minutes, usedPercent, resetAtMs = now + 3_600_000) => ({ minutes, usedPercent, resetAtMs });
const codexQuota = (windows, extra = {}) => ({
  isCurrent: async () => true, quota: { measuredAt: now, windows, ...extra },
});

for (const [label, window, reason] of [
  ['five-hour reserve', codexWindow(300, 70), /подписка Codex.*70%/],
  ['weekly reserve', codexWindow(10080, 98), /подписка Codex.*недельный.*98%/],
  ['provider denial without a window', undefined, /подписка Codex.*провайдер/],
]) {
  test('Codex admission blocks a once action at the ' + label, async t => {
    const f = await profile(t, { state: codexState, readCodexQuota: async () =>
      window ? codexQuota([window]) : codexQuota([], { ordinaryDenied: true }) });
    await f.scheduler.tickNow();
    await assertBlocked(f, reason);
  });
}

test('Codex admission ignores stale, expired and below-threshold windows', async t => {
  const rows = [
    reminder,
    { ...reminder, id: 'expired-codex-window', name: 'Истёкшее окно' },
    { ...reminder, id: 'below-codex-threshold', name: 'Ниже границы' },
  ];
  const reports = [
    codexQuota([codexWindow(300, 100)], { measuredAt: now - 300_001 }),
    codexQuota([codexWindow(300, 100, now)]),
    codexQuota([codexWindow(10080, 97.9), codexWindow(300, 69.9)]),
  ];
  const f = await profile(t, { state: codexState, actions: rows, readCodexQuota: async () => reports.shift() });
  await f.scheduler.tickNow();
  assert.equal(reports.length, 0);
  assert.equal(f.messages.filter(row => row.text.startsWith('⏰')).length, 3);
  assert.ok((await f.runs()).every(row => row.status === 'ok'));
});

for (const change of ['provider', 'account', 'owner pause']) {
  test('Codex admission leaves a pending once action intact when ' + change + ' changes during the read', async t => {
    let release, entered, didAbort = false, accountCurrent = true;
    const ready = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const f = await profile(t, { state: codexState, readCodexQuota: async ({ signal }) => {
      signal.addEventListener('abort', () => { didAbort = true; release(); }, { once: true });
      entered();
      await wait;
      return { ...codexQuota([codexWindow(300, 90)]), isCurrent: async () => accountCurrent };
    } });
    const tick = f.scheduler.tickNow();
    try {
      assert.equal(await Promise.race([ready.then(() => true), tick.then(() => false)]), true);
      if (change === 'provider') {
        await updateState(state => { state.extAuthBypass = 'claude'; });
      } else if (change === 'account') {
        accountCurrent = false;
      } else {
        const result = await setOwnerPause(true, { now, check() {}, checkEngine() {} });
        assert.equal(result.aborted, 0);
        assert.equal(didAbort, true);
      }
    } finally {
      release();
      await tick;
    }
    assert.deepEqual(await f.readActions(), [reminder]);
    assert.deepEqual(f.messages, []);
  });
}
