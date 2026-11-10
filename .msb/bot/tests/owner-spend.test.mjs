/**
 * Old saved spend controls and metered Claude provenance through production
 * Telegram and CLI seams. Old 73aa9e7e… 19915–19922,20268–20312,
 * 52919–52953,110354–110362,114265–114292. No live provider or data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { fixture } from './helpers/menu-fixture.mjs';
import { mcpFixture } from './helpers/mcp-fixture.mjs';
import { nativeFixtures } from './helpers/mcp-launch-fixture.mjs';

const now = Date.parse('2026-02-08T21:30:00.000Z');
const localDay = '2026-02-09';
const history = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [
  '2026-02-0' + (index + 1), index + 0.25,
]));
history[localDay] = 12.34;
const pauseText = '🛑 Дневной лимит достигнут. /settings → изменить лимит или возобновить.';

async function until(read, explanation, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = read();
    if (found) return found;
    if (Date.now() >= deadline) assert.fail(explanation);
    await delay(10);
  }
}

async function putState(fields) {
  const saved = { ...(await loadState()).state, timezone: 'Europe/Moscow', ...fields };
  await saveState(saved);
  return saved;
}

test('/cost reads the owner-local day and seven latest dates from saved history only', async t => {
  const f = await fixture(t, undefined, { overlay: false, now: () => now });
  const original = await putState({ costHistory: history, dailySpendLimit: 25 });
  await f.message('/cost');
  const report = f.messages.at(-1);
  assert.match(report, /<b>💰 Расходы<\/b>/);
  assert.match(report, /Сегодня: <code>\$12\.34<\/code> из \$25/);
  assert.match(report, /Последние дни/);
  assert.match(report, /▸ 2026-02-09: <code>\$12\.34<\/code>/);
  assert.match(report, /2026-02-03: <code>\$2\.25<\/code>/);
  assert.doesNotMatch(report, /2026-02-02|2026-02-01/);
  assert.deepEqual((await loadState()).state, original);
});

test('the old six limit choices and a positive limit change clear an existing pause', async t => {
  const f = await fixture(t, undefined, { overlay: false, now: () => now });
  await putState({ costHistory: history, dailySpendLimit: 25, costPaused: true, lastCostAlert: localDay });
  await f.message('/settings');
  assert.match(f.messages.at(-1), /Лимит исчерпан — расходы на паузе/);
  await f.callback('settings:limit');
  const buttons = f.editOptions.at(-1).reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.map(button => button.callback_data), [
    ...[0, 10, 25, 50, 100, 200].map(value => 'settings:limit:set:' + value), 'settings:back',
  ]);
  assert.equal(buttons[2].text, '[$25/день]');
  assert.match(f.edits.at(-1), /Сейчас: \$12\.34 из \$25/);
  assert.match(f.edits.at(-1), /Автоматический учёт новых API-списаний пока недоступен/);
  await f.callback('settings:limit:set:invalid');
  assert.equal((await loadState()).state.dailySpendLimit, 25);
  assert.equal((await loadState()).state.costPaused, true);
  await f.callback('settings:limit:set:100');
  const state = (await loadState()).state;
  assert.equal(state.dailySpendLimit, 100);
  assert.equal(state.costPaused, false);
  assert.deepEqual(state.costHistory, history);
  assert.equal(state.lastCostAlert, localDay);
  assert.match(f.edits.at(-1), /⚙️ Настройки/);
});

test('a persisted owner spend pause survives the day boundary and blocks a model until resume', async t => {
  let modelCalls = 0;
  const f = await fixture(t, async () => {
    modelCalls++;
    return { ok: true, text: 'Ответ после возобновления' };
  }, { overlay: false, now: () => now });
  const saved = await putState({ costHistory: { '2026-02-08': 25 }, dailySpendLimit: 25, costPaused: true });
  await f.message('Обычный вопрос при паузе');
  const first = await until(() => f.edits.at(-1), 'The blocked turn must settle');
  assert.equal(first, pauseText);
  assert.equal(modelCalls, 0);
  assert.deepEqual((await loadState()).state, saved);
  await f.callback('settings:cost:resume', 99);
  assert.equal((await loadState()).state.costPaused, true);
  await f.callback('settings:cost:resume');
  assert.equal((await loadState()).state.costPaused, false);
  assert.deepEqual((await loadState()).state.costHistory, saved.costHistory);
  await f.message('Обычный вопрос после возобновления');
  await until(() => f.edits.some(text => text.startsWith('Ответ после возобновления')), 'The resumed worker must answer');
  assert.equal(modelCalls, 1);
});

test('Claude subscription total is preserved as metered telemetry without a billed footer or a ledger entry', async t => {
  let completed;
  const f = await mcpFixture(t, 'claude', { runTurn: async options => {
    completed = await runAgentTurn(options);
    return completed;
  } });
  const native = await nativeFixtures(f);
  await native.respond('Подписочный ответ', { reportedUsd: 0.625 });
  const existing = { [localDay]: 0.1 };
  await putState({ authMode: 'subscription', hasSubscriptionAuth: true, dailySpendLimit: 0.25, costHistory: existing });
  await f.message('Обычный запрос через подписку');
  const final = await until(() => f.edits.find(text => text.startsWith('Подписочный ответ')), 'The owned native CLI must reply', 10_000);
  assert.equal(completed.result.meteredCostUsd, 0.625);
  assert.doesNotMatch(final, /\$0\.625/);
  assert.match(final, /<blockquote>⏱/);
  const state = (await loadState()).state;
  assert.deepEqual(state.costHistory, existing);
  assert.equal(state.costPaused, undefined);
});

test('/cost distinguishes missing current data from a real saved zero', async t => {
  const f = await fixture(t, undefined, { overlay: false, now: () => now });
  await putState({ costHistory: { '2026-02-08': 0 } });
  await f.message('/cost');
  assert.match(f.messages.at(-1), /Сегодня: нет сохранённых данных/);
  assert.match(f.messages.at(-1), /2026-02-08: <code>\$0\.00<\/code>/);
});
