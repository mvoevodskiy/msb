/**
 * Owned CLI stream → real [turn](../src/agent/turn.mjs) → old state quota →
 * local reminder scheduler. Old readable 73aa9e7e… at 20020–20031,
 * 36705–36734 and 55998–56011. No native account or network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { startScheduler } from '../src/autonomy/scheduler.mjs';
import { actionRoot } from '../src/paths.mjs';
import { loadState, saveState, updateState } from '../src/state.mjs';
import { fixture } from './helpers/menu-fixture.mjs';

const sampledAt = Date.now();
const window = { resetsAt: Math.floor(sampledAt / 1000) + 3600, rateLimitType: 'five_hour',
  utilization: 0.72, isUsingOverage: false, status: 'allowed', overageResetsAt: Math.floor(sampledAt / 1000) + 7200 };
const prior = { ...window, utilization: 0.15, lastUpdatedAt: Math.floor(sampledAt / 1000) - 60 };
const ownerChat = 42;

async function until(read, explanation, timeoutMs = 8000) {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const result = await read();
    if (result) return result;
    if (Date.now() >= limit) assert.fail(explanation);
    await delay(10);
  }
}

async function exists(file) {
  return fs.stat(file).then(() => true, () => false);
}

async function cliFixture(t, { provider = 'claude', observed = provider, events = [window],
  delayEvent = false, delayExit = false, fail = false, old = undefined, session = undefined } = {}) {
  const f = await fixture(t, undefined, { overlay: false, runtimeProfile: 'jar1' });
  const ready = path.join(f.home, 'cli-ready');
  const sent = path.join(f.home, 'event-sent');
  const releaseEvent = path.join(f.home, 'release-event');
  const releaseExit = path.join(f.home, 'release-exit');
  const bin = path.join(f.home, 'quota-bin');
  await fs.mkdir(bin);
  const config = { ready, sent, releaseEvent, releaseExit, observed, events, delayEvent, delayExit, fail, session };
  const source = [
    '#!' + process.execPath,
    'const fs = require("node:fs");',
    'const { setTimeout } = require("node:timers/promises");',
    'const c = ' + JSON.stringify(config) + ';',
    'if (process.argv.includes("--version")) { console.log("2.1.316 (Claude Code)"); process.exit(0); }',
    'const emit = frame => console.log(JSON.stringify(frame));',
    'async function wait(file) { while (!fs.existsSync(file)) await setTimeout(10); }',
    '(async () => {',
    '  fs.readFileSync(0, "utf8");',
    '  emit({ type:"system", subtype:"provider", provider_id:c.observed });',
    '  fs.writeFileSync(c.ready, "1");',
    '  if (c.delayEvent) await wait(c.releaseEvent);',
    '  for (const info of c.events) emit({ type:"rate_limit_event", rate_limit_info:info });',
    '  fs.writeFileSync(c.sent, "1");',
    '  if (c.delayExit) await wait(c.releaseExit);',
    '  emit({ type:"result", is_error:c.fail, result:"Fixture response", ...(c.session ? {session_id:c.session} : {}) });',
    '  if (c.fail) process.exitCode = 1;',
    '})();',
    '',
  ].join('\n');
  await fs.writeFile(path.join(bin, 'claude'), source, { mode: 0o700 });
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'owned-quota-fixture';
  process.env.AUTONOMY_ENABLED = '1';
  for (const key of ['MSB_SESSION_DIR', 'IIA_SESSION_DIR', 'AUTONOMY_DIR', 'AUTONOMY_DAILY_CAP_USD',
    'AUTONOMY_DAILY_CAP_RUNS', 'AUTONOMY_DAILY_CAP_TOKENS', 'AUTONOMY_RESERVE_FRACTION']) delete process.env[key];
  await saveState({ ...(await loadState()).state, engine: 'cc', authMode: 'subscription', hasSubscriptionAuth: true,
    extAuthBypass: provider === 'claude' ? undefined : provider, ccSessionId: session, chatId: ownerChat,
    userId: ownerChat, timezone: 'Europe/Moscow', rateLimitInfo: old });
  const finish = () => fs.writeFile(releaseExit, '1');
  const allow = () => fs.writeFile(releaseEvent, '1');
  return { ...f, ready, sent, finish, allow };
}

test('real Claude stream saves the old quota while the native turn is still open', async t => {
  const f = await cliFixture(t, { delayExit: true, old: prior, session: 'fixture-claude-session',
    events: [window, { ...window, resetsAt: 'bad fixture', utilization: 0.99 }] });
  let terminal = false;
  const turn = runAgentTurn({ prompt: 'Synthetic subscription event' }).finally(() => { terminal = true; });
  try {
    await until(() => exists(f.sent), 'owned CLI must send the rate_limit_event');
    const saved = await until(async () => {
      const value = (await loadState()).state.rateLimitInfo;
      return value?.utilization === window.utilization ? value : null;
    }, 'Claude quota must be visible before native exit', 3000);
    assert.equal(terminal, false);
    const { lastUpdatedAt, ...data } = saved;
    assert.ok(lastUpdatedAt >= Math.floor(sampledAt / 1000));
    assert.deepEqual(data, window);
    assert.equal((await loadState()).state.ccSessionId, 'fixture-claude-session');
  } finally {
    await f.finish();
    await turn;
  }
});

test('a rejected Claude turn without a session still feeds the real reminder gate', async t => {
  const rejected = { ...window, status: 'rejected', utilization: 0.2 };
  const f = await cliFixture(t, { fail: true, events: [rejected] });
  const result = await runAgentTurn({ prompt: 'Synthetic rejected turn' });
  assert.equal(result.ok, false);
  const { state } = await loadState();
  assert.equal(state.ccSessionId, undefined);
  assert.equal(state.rateLimitInfo?.status, 'rejected');
  const at = new Date(sampledAt).toISOString();
  const file = path.join(actionRoot(), 'actions.json');
  await fs.writeFile(file, JSON.stringify([{ id: 'local-once', name: 'Задача', enabled: true,
    trigger: { kind: 'once', at }, task: { kind: 'reminder', text: 'Проверка' } }]));
  const scheduler = startScheduler({ api: f.bot.api, adminId: ownerChat, now: () => sampledAt,
    log() {}, runTurn: async () => assert.fail('A literal reminder cannot launch the CLI') });
  t.after(() => scheduler.stop());
  await scheduler.tickNow();
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8'))[0].lastOutcome, 'blocked');
  assert.match(f.messages.at(-1), /подписка Claude: провайдер уже отказывает по лимиту/);
});

test('an alternate stream cannot overwrite a retained Claude quota', async t => {
  const f = await cliFixture(t, { provider: 'codex', old: prior,
    session: 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53' });
  const result = await runAgentTurn({ prompt: 'Synthetic alternate event' });
  assert.equal(result.ok, true, result.text);
  assert.equal(await exists(f.sent), true);
  assert.deepEqual((await loadState()).state.rateLimitInfo, prior);
});

test('a Claude event after switching to Codex cannot alter retained quota', async t => {
  const f = await cliFixture(t, { delayEvent: true, old: prior, session: 'fixture-claude-session' });
  const turn = runAgentTurn({ prompt: 'Synthetic switch while running' });
  try {
    await until(() => exists(f.ready), 'owned Claude CLI must start before the switch');
    await updateState(state => ({ ...state, extAuthBypass: 'codex' }));
  } finally {
    await f.allow();
    await turn;
  }
  assert.equal((await loadState()).state.extAuthBypass, 'codex');
  assert.deepEqual((await loadState()).state.rateLimitInfo, prior);
});

test('a reported alternate stream is rejected even under the Claude pin', async t => {
  const f = await cliFixture(t, { observed: 'qwen', old: prior });
  await runAgentTurn({ prompt: 'Synthetic unexpected provider event' });
  assert.equal(await exists(f.sent), true);
  assert.deepEqual((await loadState()).state.rateLimitInfo, prior);
});

test('a quota event from a previous saved auth mode is discarded', async t => {
  const f = await cliFixture(t, { delayEvent: true, old: prior, session: 'fixture-claude-session' });
  const turn = runAgentTurn({ prompt: 'Synthetic auth change while running' });
  try {
    await until(() => exists(f.ready), 'owned Claude CLI must start before auth changes');
    await updateState(state => ({ ...state, authMode: 'fixture-api', hasSubscriptionAuth: false }));
  } finally {
    await f.allow();
    await turn;
  }
  assert.equal((await loadState()).state.authMode, 'fixture-api');
  assert.deepEqual((await loadState()).state.rateLimitInfo, prior);
});
