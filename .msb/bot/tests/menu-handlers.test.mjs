import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/menu-fixture.mjs';
import { saveState, loadState } from '../src/state.mjs';
import { readEnvMap, setEnvKey, maskValue } from '../src/env/store.mjs';
import { connScreen, envScreen, mcpScreen, skillsScreen, limitScreen, settingsScreen, monitorSettingsScreen, monitorDigestScreen } from '../src/telegram/screens.mjs';
import { saveMonitorConfig, defaultConfig } from '../src/monitor/config.mjs';
import { appendItems } from '../src/monitor/store.mjs';
import { maybeSendDigest } from '../src/monitor/digest.mjs';
import { autonomyDir } from '../src/paths.mjs';
import { trySessionOperation } from '../src/agent/session-operation.mjs';
import { presentationAwareRetry } from '../src/telegram/presentation-api.mjs';
import { installUpdateHook } from '../../../overlay/bot/ext/install.mjs';

test('explicit Back and start cancel env/auth input before ordinary text', async (t) => {
  const f = await fixture(t);
  for (const cancel of [() => f.callback('settings:back'), () => f.message('/start'), () => f.callback('menu:agent')]) {
    await f.callback('settings:env:quick:TEST_MENU_TOKEN');
    await cancel();
    await f.message('ordinary task');
    assert.equal((await readEnvMap()).map.has('TEST_MENU_TOKEN'), false);
  }
  await f.callback('settings:auth:switch-sub');
  await f.message('/start');
  await f.message('ordinary task');
  assert.equal((await readEnvMap()).map.has('CLAUDE_CODE_OAUTH_TOKEN'), false);
});

test('env input rejects line injection, retains form for retry, keeps masked previews and service buttons, without deleting the user value message', async (t) => {
  const f = await fixture(t);
  await f.callback('settings:env:quick:TEST_MENU_TOKEN');
  await f.message('first\nINJECTED=bad');
  assert.equal((await readEnvMap()).map.size, 0);
  await f.message('fixture-secret');
  await f.callback('settings:env:skip-comment',42,{messageId:f.messages.length});
  assert.equal((await readEnvMap()).map.get('TEST_MENU_TOKEN'), 'fixture-secret');
  assert.ok(!f.deleted.includes(99),'keep the user env-value message');
  const view = await envScreen();
  assert.doesNotMatch(view.text, /fixture-secret/);
  assert.match(view.text, /fix…ret/);
  const quick = view.keyboard.inline_keyboard.flat().map((button) => button.callback_data);
  for (const key of ['DEEPGRAM_API_KEY', 'GITHUB_TOKEN_FINE', 'GITHUB_TOKEN_CLASSIC', 'GITHUB_TOKEN', 'X_BEARER_TOKEN', 'OPENROUTER_API_KEY']) {
    assert.ok(quick.includes(`settings:env:quick:${key}`));
  }
  for (const value of ['line\rreturn', 'null\0byte']) await assert.rejects(setEnvKey('TEST_MENU_TOKEN', value));
  assert.equal((await readEnvMap()).map.get('TEST_MENU_TOKEN'), 'fixture-secret');
  assert.equal(maskValue(''), 'пусто');
  const custom = { HOME: f.home, MSB_BOT_ID: 'custom' };
  await setEnvKey('TEST_ISOLATED_KEY', 'value', custom);
  assert.equal(custom.TEST_ISOLATED_KEY, 'value');
  assert.equal(process.env.TEST_ISOLATED_KEY, undefined);
});

test('unauthorized overlay and stale unsupported buttons cannot change provider, session or settings', async (t) => {
  const f = await fixture(t);
  const before = JSON.stringify((await loadState()).state);
  const store = await fs.readFile(f.storeFile, 'utf8');
  await f.callback('ext:effort:set:low', 43);
  assert.equal(f.edits.length, 0);
  assert.equal(f.messages.length, 0);
  // Changing a runtime env value must not change the startup owner of one layer only.
  process.env.ADMIN_ID = '43';
  await f.callback('ext:effort:set:low', 43);
  assert.equal(f.edits.length, 0);
  for (const data of ['settings:auth:openrouter', 'settings:engine:set:oc']) await f.callback(data);
  assert.equal(JSON.stringify((await loadState()).state), before);
  assert.equal(await fs.readFile(f.storeFile, 'utf8'), store);
  assert.equal(await fs.stat(path.join(f.home, '.msb/monitor/config.json')).then(() => true, () => false), false);

});

test('/stop keeps current turn locked until it finishes and never reports success for an abort', async (t) => {
  let calls = 0, release, started;
  const entering = new Promise((resolve) => { started = resolve; });
  const f = await fixture(t, async ({ signal }) => {
    calls++;
    if (calls > 1) return { ok: false, error: 'fixture', text: 'fixture failure' };
    started();
    await new Promise((resolve) => { release = resolve; });
    assert.equal(signal.aborted, true);
    return { ok: false, error: 'aborted', text: 'Остановлено.' };
  });
  const first = f.message('first');
  await entering;
  await f.message('/stop');
  await f.message('second before exit');
  assert.equal(calls, 1);
  assert.equal(f.messages.at(-1), '⏳ в очереди');
  release(); await first;
  await until(() => f.edits.includes('Моя остановочка ✋🏽⛔️'));
  await new Promise(resolve => setTimeout(resolve, 10));
  await until(() => calls === 2, 'queued turn after stopped process exits');
  await f.message('after exit');
  await until(() => calls === 3 && f.edits.at(-1) === 'fixture failure');
  assert.ok(!f.edits.includes('✅'));
});

test('/compact uses the selected Codex session and preserves the previous Telegram presentation', async (t) => {
  const f = await fixture(t, undefined, { overlay: false });
  const before = (await loadState()).state;
  let called = false;
  f.bot[Symbol.for('msb.compactProvider')] = async (snapshot, { isCurrent }) => {
    called = true;
    assert.equal(snapshot.ccSessionId, before.ccSessionId);
    assert.equal(snapshot.extAuthBypass, 'codex');
    assert.equal(await isCurrent(), true);
    return { ok: true };
  };
  await f.message('/compact');
  await until(() => f.edits.includes('🗜️ Контекст успешно сжат. Жду команду.'));
  assert.ok(called);
  assert.ok(f.messages.includes('🗜️ Сжимаю контекст...'));
  assert.equal(f.typingSignals.at(-1)?.aborted, true);
  for (const signal of [f.typingSignals.at(-1), f.editSignals.at(-1), f.replySignals[0]]) {
    assert.ok(signal);
    let retried = false, attempts = 0;
    const transformer = presentationAwareRetry(() => { retried = true; });
    await assert.rejects(async () => transformer(() => { attempts++; throw Error('429'); }, 'presentation', {}, signal), /429/);
    assert.equal(attempts, 1);
    assert.equal(retried, false);
  }
  assert.deepEqual((await loadState()).state, before);
});

test('/stop keeps a compaction locked until the provider finishes', async (t) => {
  const f = await fixture(t, undefined, { overlay: false });
  let start, release, observedSignal;
  const entered = new Promise((resolve) => { start = resolve; });
  f.bot[Symbol.for('msb.compactProvider')] = async (_snapshot, { signal }) => {
    observedSignal = signal;
    start();
    await new Promise((resolve) => { release = resolve; });
    return { ok: true };
  };
  await f.message('/compact');
  await entered;
  await f.message('/stop');
  assert.equal(observedSignal.aborted, true);
  assert.equal(f.typingSignals.at(-1)?.aborted, true);
  await f.message('wait');
  assert.equal(f.messages.at(-1), '⏳ в очереди');
  release();
  await until(() => f.edits.includes('Моя остановочка ✋🏽⛔️'));
  assert.ok(!f.edits.includes('🗜️ Контекст успешно сжат. Жду команду.'));
});

test('/stop does not claim to interrupt a completed compaction while its result is being delivered', async (t) => {
  const f = await fixture(t, undefined, { overlay: false });
  let entered, finish;
  const editing = new Promise((resolve) => { entered = resolve; });
  f.bot.api.editMessageText = async (_chat, _id, text) => {
    entered();
    await new Promise((resolve) => { finish = resolve; });
    f.edits.push(text);
  };
  f.bot[Symbol.for('msb.compactProvider')] = async () => ({ ok: true });
  await f.message('/compact');
  await editing;
  await f.message('/stop');
  assert.equal(f.messages.at(-1), 'Нечего останавливать 🤷');
  finish();
  await until(() => f.edits.includes('🗜️ Контекст успешно сжат. Жду команду.'));
});

test('/compact refuses a background run and never sends a switched session to the old provider', async (t) => {
  const f = await fixture(t, undefined, { overlay: false });
  const guard = trySessionOperation();
  assert.ok(guard);
  await f.message('/compact');
  assert.match(f.messages.at(-1), /фоновый ход/);
  guard();
  let start, release;
  const entered = new Promise((resolve) => { start = resolve; });
  f.bot[Symbol.for('msb.compactProvider')] = async (_snapshot, { isCurrent }) => {
    start();
    await new Promise((resolve) => { release = resolve; });
    return await isCurrent() ? { ok: true } : { ok: false, aborted: true };
  };
  await f.message('/compact');
  await entered;
  const next = { ...(await loadState()).state, extAuthBypass: 'claude', ccSessionId: 'claude-other', sessionEpoch: 1 };
  await saveState(next);
  release();
  await until(() => f.edits.some((text) => /сжатие не запускалось/.test(text)));
  assert.deepEqual((await loadState()).state, next);
});

test('/compact and normal turns cannot overlap across the owner’s chats', async (t) => {
  let start, release, finishCompact, releaseHistory, runCalls = 0;
  const historyGate = new Promise(resolve => { releaseHistory = resolve; });
  // Release every held fake operation before fixture shutdown, even on failure.
  t.after(() => { releaseHistory(); release?.(); finishCompact?.(); });
  const entered = new Promise((resolve) => { start = resolve; });
  const f = await fixture(t, async () => {
    runCalls++;
    start();
    if (runCalls === 1) await new Promise((resolve) => { release = resolve; });
    return { ok: true, text: 'done', result: {} };
  }, { overlay: false });
  const appendFile = fs.appendFile.bind(fs);
  let journalHeld = false;
  t.mock.method(fs, 'appendFile', async (file, ...args) => {
    if (!journalHeld && String(file).endsWith('/chat-diary.jsonl')) {
      journalHeld = true;
      await historyGate;
    }
    return appendFile(file, ...args);
  });
  let compactCalls = 0;
  f.bot[Symbol.for('msb.compactProvider')] = async () => { compactCalls++; return { ok: true }; };
  await f.message('working');
  await entered;
  await f.bot.handleUpdate({ message: { message_id: 101, text: '/compact', from: { id: 42 }, chat: { id: 43 } } });
  assert.match(f.messages.at(-1), /Уже работаю/);
  assert.equal(compactCalls, 0);
  release();
  await until(() => f.edits.some((text) => text.includes('done')));

  await until(() => journalHeld);
  await f.message('/compact');
  assert.match(f.messages.at(-1), /Уже работаю/);
  assert.equal(compactCalls, 0, 'Visible text does not mean the journal/worker has finished.');
  releaseHistory();

  let startCompact, compactStarted = false;
  const compactEntered = new Promise((resolve) => { startCompact = resolve; });
  f.bot[Symbol.for('msb.compactProvider')] = async () => {
    compactStarted = true;
    startCompact();
    await new Promise((resolve) => { finishCompact = resolve; });
    return { ok: true };
  };
  // Wait through the public admission rule, including history flush. Do not
  // equate a fake transport edit with the end of the detached inbox worker.
  const end = Date.now() + 2000;
  while (!compactStarted && Date.now() < end) {
    await f.message('/compact');
    if (!compactStarted) await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(compactStarted, 'Compaction must start after the worker finishes.');
  await compactEntered;
  await f.bot.handleUpdate({ message: { message_id: 102, text: 'other chat', from: { id: 42 }, chat: { id: 43 } } });
  assert.equal(f.messages.at(-1), '⏳ в очереди');
  assert.equal(runCalls, 1, 'The queued model cannot start inside compaction.');
  finishCompact();
  await until(() => f.edits.includes('🗜️ Контекст успешно сжат. Жду команду.'));
  await until(() => runCalls === 2, 'Queued text starts after the compact provider finishes.');
});

test('timezone form validates and digest screen/executor use the same saved zone', async (t) => {
  const f = await fixture(t);
  await f.callback('settings:tz');
  await f.message('<bad zone>');
  assert.equal((await loadState()).state.timezone, undefined);
  await f.message('Pacific/Honolulu');
  assert.equal((await loadState()).state.timezone, 'Pacific/Honolulu');
  process.env.MSB_TIMEZONE = 'Europe/Moscow';
  const cfg = defaultConfig();
  cfg.digest.hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Pacific/Honolulu', hour: 'numeric', hour12: false }).format(new Date()));
  await saveMonitorConfig(cfg);
  assert.match((await monitorDigestScreen()).text, /Pacific\/Honolulu/);
  await appendItems([{ sourceType: 'rss', sourceId: 'fixture', title: 'fixture', url: 'https://example.invalid/fixture', publishedAt: new Date().toISOString() }]);
  const sent = [];
  const result = await maybeSendDigest({ api: { sendMessage: async (...x) => sent.push(x) }, adminId: 42, log() {} });
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
});

test('stale Codex auth cannot switch provider, and old Claude engine callback exits OpenClaw', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.home, 'bin'));
  await fs.mkdir(path.join(f.home, '.codex'));
  await fs.writeFile(path.join(f.home, 'bin/codex'), '#!/bin/sh\necho "Not logged in"\nexit 1\n', { mode: 0o755 });
  await fs.writeFile(path.join(f.home, '.codex/auth.json'), JSON.stringify({ tokens: { access_token: 'stale-fixture' } }));
  process.env.PATH = path.join(f.home, 'bin') + ':' + process.env.PATH;
  const oldStore = { active: 'cursor', models: { cursor: 'fixture-model' }, sessions: { cursor: 'fixture-session' } };
  await fs.writeFile(f.storeFile, JSON.stringify(oldStore));
  const state = (await loadState()).state;
  await f.callback('ext:conn:set:codex');
  assert.deepEqual(JSON.parse(await fs.readFile(f.storeFile, 'utf8')), oldStore);
  assert.deepEqual((await loadState()).state, state);
  assert.match(f.edits.at(-1), /не подтвердил вход/);
  assert.ok(!f.edits.some((x) => x.includes('✔ Агент теперь')));
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-claude-token';
  await saveState({ ...state, engine: 'oc' });
  await f.callback('settings:conn:set:cc');
  assert.equal((await loadState()).state.engine, 'cc');
  assert.equal(JSON.parse(await fs.readFile(f.storeFile, 'utf8')).active, 'claude');
});

test('a Telegram acknowledgement failure does not claim that a saved env value was not written', async (t) => {
  const f = await fixture(t);
  await f.callback('settings:env:quick:TEST_MENU_TOKEN');
  await f.message('fixture-secret'); // value remains a draft until the old description step
  f.bot.api.sendMessage = async () => { throw new Error('fixture Telegram failure'); };
  await assert.rejects(f.message('fixture description'), /fixture Telegram failure/);
  assert.equal((await readEnvMap()).map.get('TEST_MENU_TOKEN'), 'fixture-secret');
  assert.ok(!f.messages.some((x) => x.startsWith('Не сохранил')));
});

test('real Telegram message handler attaches the measured compact footer', async (t) => {
  const f = await fixture(t, async () => ({ ok: true, text: 'footer fixture', result: { context: { contextTokens: 71142, contextWindow: 475000 } } }));
  await f.message('footer fixture');
  await until(() => f.edits.some(x => x.startsWith('footer fixture')));
  assert.match(f.edits.at(-1), /footer fixture\n\n<blockquote>⏱ \d+\.\ds · ○○○ 15%<\/blockquote>$/);
  assert.doesNotMatch(f.edits.at(-1), /Контекст:.*токенов/);
});

test('all baseline menu button routes remain reachable', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.home, '.msb/autonomy'), { recursive: true });
  await fs.mkdir(path.join(f.home, '.codex'), { recursive: true });
  await fs.writeFile(path.join(f.home, '.codex/auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-only' } }));
  await fs.writeFile(path.join(f.home, '.msb/bots/default/.env'), 'BOT_TOKEN=fixture-token\nADMIN_ID=42\nNODE_ENV=production\n');
  await fs.writeFile(path.join(f.home, '.msb/autonomy/tasks.json'), JSON.stringify({ tasks: [{ id: 'scope-fixture', title: 'Fixture task', enabled: true }] }));
  const contract = JSON.parse(await fs.readFile(new URL('./fixtures/menu-callbacks-8e8ae21.json', import.meta.url), 'utf8'));
  const screens = await import('../src/telegram/screens.mjs');
  const overlay = await import('../../../overlay/bot/ext/menu.mjs');
  const callbacks = (v) => v.keyboard.inline_keyboard.flat().map((b) => b.callback_data).filter(Boolean);
  const state = { ...(await loadState()).state, permissionMode: 'auto', autonomyRights: false };
  await saveState(state);
  const screenInput = { mcpScreen: 0, mcpWorkspaceScreen: { entries: [] } };
  for (const [name, expected] of Object.entries(contract.screens)) {
    // The pinned open-core snapshot exposed NODE_ENV deletion. Old bY55151
    // protects it; this one unsafe action is restored by the env contract.
    const restored = name === 'envScreen' ? expected.filter(data => data !== 'settings:env:delete:NODE_ENV') : expected;
    assert.deepEqual(callbacks(await screens[name](screenInput[name] ?? state)), restored, name);
  }
  for (const [name, expected] of Object.entries(contract.overlay)) assert.deepEqual(callbacks(await overlay[name](process.env, f.home)), expected, name);
});

test('stored settings and cost history survive a real project selection reset', async (t) => {
  const f = await fixture(t);
  const epoch = (await loadState()).state.sessionEpoch || 0;
  await f.callback('settings:limit:set:25');
  assert.equal((await loadState()).state.dailySpendLimit, 25);
  await saveState({ ...(await loadState()).state, costPaused: true, costHistory: { [new Date().toISOString().slice(0, 10)]: 2.34 } });
  await f.message('/cost');
  assert.match(f.messages.at(-1), /\$2\.34/);
  assert.match(f.messages.at(-1), /25\/день/);
  await f.callback('settings:limit:set:0');
  assert.equal((await loadState()).state.costPaused, false);
  await f.callback('auto:rights-toggle');
  assert.equal((await loadState()).state.autonomyRights, true);
  await f.callback('mon:storage:set:sqlite');
  const config = JSON.parse(await fs.readFile(path.join(f.home, '.msb/monitor/config.json'), 'utf8'));
  assert.equal(config.storage, 'sqlite');
  await f.callback('menu:newproject');
  await f.message('fixture-project');
  assert.equal((await loadState()).state.activeProject, 'fixture-project');
  assert.ok((await fs.stat(path.join(f.home, 'projects/fixture-project'))).isDirectory());
  await f.callback('ext:permmode:set:plan');
  assert.equal((await loadState()).state.permissionMode, 'plan');
  assert.equal((await loadState()).state.ccSessionId, undefined);
  assert.equal((await loadState()).state.sessionEpoch, epoch+1);
  const store = JSON.parse(await fs.readFile(f.storeFile, 'utf8'));
  assert.equal(store.models.codex, 'gpt-6.1-terra');
  assert.equal(store.efforts.codex, 'max');
});

test('informational status preserves form input and core Back cancels even without overlay', async (t) => {
  const f = await fixture(t, undefined, { overlay: false });
  await f.callback('settings:env:quick:TEST_MENU_TOKEN');
  await f.message('/status');
  await f.message('fixture-after-status');
  await f.callback('settings:env:skip-comment',42,{messageId:f.messages.length});
  assert.equal((await readEnvMap()).map.get('TEST_MENU_TOKEN'), 'fixture-after-status');
  await f.callback('settings:auth:switch-sub');
  await f.callback('menu:agent');
  await f.message('ordinary task');
  assert.equal((await readEnvMap()).map.has('CLAUDE_CODE_OAUTH_TOKEN'), false);
  assert.ok(!f.deleted.includes(99),'env value is retained; only bot comment prompt is removed');
});

test('restored Claude engine selector opens its token form without switching Codex first', async (t) => {
  const f = await fixture(t);
  for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'MSB_ANTHROPIC_API_KEY']) delete process.env[key];
  const before = (await loadState()).state.ccSessionId;
  const { setPendingAuth, getPendingAuth } = await import('../../../overlay/bot/ext/auth.mjs');
  setPendingAuth(42, 'cursor', 42);
  await f.callback('settings:engine:set:cc');
  assert.equal(getPendingAuth(42), null);
  assert.match(f.edits.at(-1), /Пришли следующим сообщением токен Claude/);
  assert.equal(JSON.parse(await fs.readFile(f.storeFile, 'utf8')).active, 'codex');
  assert.equal((await loadState()).state.ccSessionId, before);
  const authView = await connScreen((await loadState()).state);
  assert.match(authView.text, /Сейчас отвечает Codex/);
  assert.doesNotMatch(authView.text, /Claude Code работает/);
  assert.ok(authView.keyboard.inline_keyboard.flat().some((button) => button.callback_data === 'settings:auth:switch-sub'));
  assert.ok(authView.keyboard.inline_keyboard.flat().every((button) => !button.text.includes('включен')));
  await f.callback('settings:back');
});

test('switching explicit forms clears incompatible secret input only', async (t) => {
  const f = await fixture(t);
  const { setPendingAuth, getPendingAuth } = await import('../../../overlay/bot/ext/auth.mjs');
  setPendingAuth(42, 'cursor', 42);
  await f.callback('settings:auth:switch-sub');
  assert.equal(getPendingAuth(42), null);
  assert.match(f.edits.at(-1), /токен Claude/);
  await f.callback('settings:back');
  await f.callback('settings:env:quick:TEST_MENU_TOKEN');
  await f.callback('ext:auth:cursor');
  assert.equal(getPendingAuth(42).providerId, 'cursor');
  await f.callback('settings:auth');
  assert.equal(getPendingAuth(42), null);
  await f.message('ordinary task');
  assert.equal((await readEnvMap()).map.has('TEST_MENU_TOKEN'), false);
});

test('closed-core routes still reach their original handlers and mode is fixed at startup', async (t) => {
  const f = await fixture(t);
  const seen = [], edits = [];
  class ClosedHarness {
    api = { answerCallbackQuery: async () => {}, editMessageText: async (...x) => edits.push(x), sendMessage: async (...x) => edits.push(x) };
    async handleUpdate(update) { seen.push(update.callback_query.data); }
  }
  installUpdateHook(ClosedHarness, { ADMIN_ID: '42', MSB_USE_CLOSED_CORE: '1' });
  process.env.MSB_USE_CLOSED_CORE = '0';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-claude-token';
  const bot = new ClosedHarness();
  const routes = ['settings:ssh:add-key', 'settings:ssh:list-keys', 'settings:ssh:add-ip', 'settings:ssh:list-ips', 'settings:auth:openrouter', 'settings:engine:set:oc', 'settings:auth:switch-sub', 'settings:auth:help'];
  for (const data of routes) await bot.handleUpdate({ callback_query: { id: 'q', data, from: { id: 42 }, message: { message_id: 1, chat: { id: 42 } } } });
  assert.deepEqual(seen, routes);
  assert.deepEqual(edits, []);
  assert.ok(f.home);
});

async function until(check) {
  const end = Date.now() + 2000;
  while (!check()) { if (Date.now() > end) throw Error('Timed out waiting for detached turn'); await new Promise(r => setTimeout(r, 5)); }
}

// Old-core help reports voice support (vendor/UI-SCREENS.md); current open-core
// retains voice/STT but not photo/video/document ingestion. Exercise both routes.
test('help and attachment fallback do not claim that working voice is unavailable', async (t) => {
  const f = await fixture(t, undefined, { overlay: false });
  await f.message('/help');
  const help = f.messages.at(-1);
  assert.match(help, /Голосов[^\n]*распознаван/iu);
  assert.match(help, /вложени[^\n]*пока не подключен/iu);
  assert.doesNotMatch(help, /голосов[^\n]*не подключен/iu);
  for (const kind of ['photo', 'video', 'document']) {
    await f.bot.handleUpdate({ message: { message_id: 100, date: 1, chat: { id: 42 },
      from: { id: 42, is_bot: false, first_name: 'Fixture' }, [kind]: {} } });
    assert.match(f.messages.at(-1), /вложени[^\n]*пока не подключен/iu);
    assert.doesNotMatch(f.messages.at(-1), /голос/iu);
  }
});

// Old help described the legacy implementations; open-core handlers are explicit
// about missing execution. The help must agree without hiding their commands.
test('help distinguishes unavailable actions from the connected autonomy history', async (t) => {
  const f = await fixture(t, undefined, { overlay: false });
  for (const command of ['/help', '/openclaw']) {
    await f.message(command);
    const help = f.messages.at(-1);
    assert.match(help, /\/undo[^\n]*пока не подключен/iu);
    assert.match(help, /\/connect[^\n]*инструкц/iu);
    assert.match(help, /\/autostatus[^\n]*история фоновых прогонов/iu);
    assert.doesNotMatch(help, /\/autostatus[^\n]*пока не подключ[её]н/iu);
  }
  await f.message('/undo'); assert.match(f.messages.at(-1), /пока не подключена/iu);
  await f.message('/connect'); assert.match(f.messages.at(-1), /сама туннель не запускает/iu);
  await f.message('/autostatus'); assert.match(f.messages.at(-1), /Автономка ещё не запускалась/iu);
});

test('autostatus and history menu show recorded results for each engine without starting a turn', async (t) => {
  let turns = 0;
  const f = await fixture(t, async () => { turns++; return { ok: true, text: 'unused' }; }, { overlay: false });
  const dir = autonomyDir();
  await fs.mkdir(dir, { recursive: true });
  const rows = Array.from({ length: 3 }, (_, i) => ({
    at: `2026-11-06T12:0${i}:00.000Z`, taskId: `job-${i}`, ok: i !== 1,
    error: i === 1 ? 'bad <tool>' : null, preview: `saved & ${i}`,
  }));
  await fs.writeFile(path.join(dir, 'runs.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const initial = (await loadState()).state;
  for (const [engine, provider] of [['cc', 'codex'], ['cc', undefined], ['cc', 'cursor'], ['oc', undefined]]) {
    const state = { ...initial, engine };
    if (provider) state.extAuthBypass = provider; else delete state.extAuthBypass;
    await saveState(state);
    await f.message('/autostatus 2');
    const result = f.messages.at(-1);
    assert.match(result, /последние 2 прогонов/);
    assert.match(result, /job-2/);
    assert.match(result, /job-1/);
    assert.doesNotMatch(result, /job-0/);
    assert.match(result, /bad &lt;tool&gt;/);
    assert.match(result, /saved &amp; 2/);
    assert.deepEqual((await loadState()).state, state);
  }
  await f.callback('auto:history');
  assert.match(f.edits.at(-1), /<b>История<\/b>/);
  assert.match(f.edits.at(-1), /job-0/);
  assert.equal(turns, 0);
});

test('autostatus splits long reports and keeps Back on the last message', async (t) => {
  const f = await fixture(t, undefined, { overlay: false });
  const dir = autonomyDir();
  await fs.mkdir(dir, { recursive: true });
  const rows = Array.from({ length: 50 }, (_, i) => ({
    at: '2026-11-06T12:00:00.000Z', taskId: `job-${i}`, ok: true,
    error: null, preview: '<fixture & text> '.repeat(10),
  }));
  await fs.writeFile(path.join(dir, 'runs.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await f.message('/autostatus 50');
  assert.ok(f.messages.length > 1);
  assert.ok(f.messages.every((text) => text.length <= 3500));
  assert.match(f.messages.join(''), /job-49/);
  assert.match(f.messages.join(''), /job-0/);
  assert.doesNotMatch(f.messages.join(''), /<fixture/);
  assert.equal(f.messageOptions.at(-1).reply_markup.inline_keyboard[0][0].callback_data, 'auto:home');
});

test('history menu splits long reports and keeps Back on the last message', async (t) => {
  const f = await fixture(t, undefined, { overlay: false });
  const dir = autonomyDir();
  await fs.mkdir(dir, { recursive: true });
  const rows = Array.from({ length: 10 }, (_, i) => ({
    at: '2026-11-06T12:00:00.000Z', taskId: `job-${i}`, ok: true,
    error: null, preview: '<fixture & text> '.repeat(45),
  }));
  await fs.writeFile(path.join(dir, 'runs.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await f.callback('auto:history');
  assert.ok(f.edits.length > 0 && f.messages.length > 0);
  assert.ok([...f.edits, ...f.messages].every((text) => text.length <= 3500));
  assert.match([...f.edits, ...f.messages].join(''), /job-0/);
  assert.equal(f.messageOptions.at(-1).reply_markup.inline_keyboard[0][0].callback_data, 'auto:home');
});

// The default must never be presented as a saved value when the property is absent.
test('API limit displays the same saved state in menu, screen and /cost', async (t) => {
  const f = await fixture(t, undefined, { overlay: false });
  const base = (await loadState()).state;
  for (const [value, label] of [[undefined, 'не задан'], [0, 'без ограничений'], [25, '$25/день']]) {
    const state = { ...base };
    if (value === undefined) delete state.dailySpendLimit; else state.dailySpendLimit = value;
    await saveState(state);
    const button = settingsScreen(state).keyboard.inline_keyboard.flat().find(x => x.callback_data === 'settings:limit');
    assert.equal(button.text, `💰 Лимит API: ${label}`);
    assert.ok(limitScreen(state).text.includes(`Сохранённый лимит: ${label}.`));
    await f.message('/cost'); assert.ok(f.messages.at(-1).includes(`Сохранённый лимит: ${label}.`));
    assert.deepEqual((await loadState()).state, state, 'viewing must not write a default');
  }
});

test('/compact presents a successful no-op without inventing a compaction or an error', async t => {
  const f = await fixture(t);
  const text = 'Сжимать пока нечего — история короткая. Контекст не забит, можно продолжать.';
  f.bot[Symbol.for('msb.compactProvider')] = async () => ({ ok: true, compacted: false, text });
  await f.message('/compact');
  await until(() => f.edits.some(value => value === text));
  assert.ok(!f.edits.some(value => /успешно сжат|Не получилось/.test(value)));
});

test('reply stop parity: stop reply precedes timezone validation and leaves the form ready for its value', async t => {
  let observed;
  const f = await fixture(t, async ({ signal }) => {
    observed = signal;
    await new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }); });
    return { ok: false, error: 'aborted', text: 'Остановлено.' };
  }, { overlay: false });
  await f.message('active'); await until(() => observed);
  try {
    await f.callback('settings:tz');
    await f.bot.handleUpdate({ message: { message_id: 123, text: 'стоп', from: { id: 42 }, chat: { id: 42 }, reply_to_message: { text: 'Думаю…', from: { id: 99 } } } });
    assert.equal(observed.aborted, true);
    assert.ok(!f.messages.some(text => text.startsWith('Неизвестный часовой пояс.')));
    await f.message('Pacific/Honolulu');
    assert.equal((await loadState()).state.timezone, 'Pacific/Honolulu');
  } finally { if (!observed.aborted) await f.message('/stop'); }
});

test('env parity: delete opens the original confirmation before changing the file', async t => {
  const f = await fixture(t, undefined, { overlay: false });
  await setEnvKey('TEST_DELETE_KEY', 'synthetic-value');
  const before = await fs.readFile(path.join(f.home, '.msb/bots/default/.env'), 'utf8');
  await f.callback('settings:env:delete:TEST_DELETE_KEY');
  assert.equal(await fs.readFile(path.join(f.home, '.msb/bots/default/.env'), 'utf8'), before);
  assert.equal(f.edits.at(-1), 'Удалить <code>TEST_DELETE_KEY</code>?');
  assert.deepEqual(f.editOptions.at(-1).reply_markup.inline_keyboard, [[{text:'🗑 Да, удалить',callback_data:'settings:env:confirm-delete:TEST_DELETE_KEY'},{text:'« Нет',callback_data:'settings:env'}]]);
  await f.callback('settings:env:confirm-delete:TEST_DELETE_KEY');
  assert.equal((await readEnvMap()).map.has('TEST_DELETE_KEY'), false);
});

test('env parity: confirming deletion performs the action, while cancelling keeps the original value', async t => {
  const f = await fixture(t, undefined, { overlay: false });
  await setEnvKey('TEST_DELETE_KEY', 'keep-until-confirmed');
  await f.callback('settings:env:delete:TEST_DELETE_KEY');
  await f.callback('settings:env');
  assert.equal((await readEnvMap()).map.get('TEST_DELETE_KEY'), 'keep-until-confirmed');
  await f.callback('settings:env:confirm-delete:TEST_DELETE_KEY');
  assert.equal((await readEnvMap()).map.has('TEST_DELETE_KEY'), false);
});

test('env parity: returning to the env list or the old Cancel exits key input before the next task', async t => {
  let runs = 0;
  const f = await fixture(t, async () => { runs++; return {ok:true,text:'accepted task'}; }, { overlay: false });
  for (const cancel of ['settings:env','settings:env:cancel']) {
    await f.callback('settings:env:quick:TEST_PENDING_KEY');
    await f.callback(cancel);
    await f.message('ordinary next task');
    assert.equal((await readEnvMap()).map.has('TEST_PENDING_KEY'), false);
  }
  await until(() => runs === 2);
});


test('env parity: protected keys stay protected at both deletion steps', async t => {
  const f = await fixture(t, undefined, {overlay:false});
  await setEnvKey('BOT_TOKEN','12345:'+'F'.repeat(30),process.env,{internal:true});
  await f.callback('settings:env:delete:BOT_TOKEN');
  assert.equal(f.edits.at(-1),'❌ BOT_TOKEN — защищённый ключ, удаление запрещено.');
  assert.deepEqual(f.editOptions.at(-1).reply_markup.inline_keyboard, [[{text:'« Назад',callback_data:'settings:env'}]]);
  await f.callback('settings:env:confirm-delete:BOT_TOKEN');
  assert.equal((await readEnvMap()).map.get('BOT_TOKEN'),'12345:'+'F'.repeat(30));
});

test('env parity: env list and old Cancel clear provider input in the overlay too', async t => {
  const f = await fixture(t);
  const {setPendingAuth,getPendingAuth,clearPendingAuth}=await import('../../../overlay/bot/ext/auth.mjs');
  t.after(()=>clearPendingAuth(42));
  for(const data of ['settings:env','settings:env:cancel']) {
    setPendingAuth(42,'claude',42);
    await f.callback(data);
    assert.equal(getPendingAuth(42),null,'Leaving the form must clear overlay ownership before another message arrives.');
  }
});


test('form timeout parity: expired env input is consumed without storing it or sending it to the model', async t => {
  let clock=1_000_000,runs=0;
  const f=await fixture(t,async()=>{runs++;return{ok:true,text:'ordinary accepted'};},{overlay:false,now:()=>clock});
  await f.callback('settings:env:quick:TEST_EXPIRES');clock+=600_001;
  await f.message('fixture-late-value');
  assert.equal((await readEnvMap()).map.has('TEST_EXPIRES'),false);
  assert.equal(runs,0);
  assert.equal(f.messages.at(-1),'⏳ Время на ввод переменной истекло (10 мин) — режим ввода сброшен. Начни заново: /settings → 🔑 Переменные.');
  await f.message('ordinary task');await until(()=>runs===1);
});

test('form timeout parity: env name-to-value transition keeps the original deadline', async t => {
  let clock=1_000_000;
  const f=await fixture(t,undefined,{overlay:false,now:()=>clock});
  await f.callback('settings:env:add');clock+=590_000;
  await f.message('TEST_WHOLE_FORM');clock+=10_001;
  await f.message('fixture-late-value');
  assert.equal((await readEnvMap()).map.has('TEST_WHOLE_FORM'),false);
  assert.ok(f.messages.at(-1).startsWith('⏳ Время на ввод переменной истекло'));
});

test('form timeout parity: exactly ten minutes still accepts env input; reopening starts a new deadline', async t => {
  let clock=1_000_000;
  const f=await fixture(t,undefined,{overlay:false,now:()=>clock});
  await f.callback('settings:env:quick:TEST_BOUNDARY');clock+=600_000;
  await f.message('at-boundary');await f.callback('settings:env:skip-comment',42,{messageId:f.messages.length});assert.equal((await readEnvMap()).map.get('TEST_BOUNDARY'),'at-boundary');
  await f.callback('settings:env:quick:TEST_BOUNDARY');clock+=600_001;
  await f.message('too-late');assert.equal((await readEnvMap()).map.get('TEST_BOUNDARY'),'at-boundary');
});

test('form timeout parity: an expired Claude token input never changes auth or requests restart', async t => {
  let clock=1_000_000,runs=0;
  const f=await fixture(t,async()=>{runs++;return{ok:true,text:'ordinary accepted'};},{overlay:false,now:()=>clock});
  const before=(await loadState()).state;
  await f.callback('settings:auth:switch-sub');clock+=600_001;
  await f.message('fixture_expired_auth_'+ 'x'.repeat(60));
  assert.equal((await readEnvMap()).map.has('CLAUDE_CODE_OAUTH_TOKEN'),false);
  assert.equal((await readEnvMap()).map.has('ANTHROPIC_API_KEY'),false);
  assert.deepEqual((await loadState()).state,before);
  assert.deepEqual(f.restartRequests,[]);assert.equal(runs,0);
  assert.equal(f.messages.at(-1),'⏳ Время на ввод токена истекло (10 мин) — режим ввода сброшен. Начни заново: /settings → 🔌 Подключение.');
  await f.message('ordinary task');await until(()=>runs===1);
});

for(const form of ['env','auth']) for(const leading of ['', '   ']) {
  test(`form command parity: ${form} consumes an unknown slash input and cancels before the next task (${leading.length} spaces)`,async t=>{
    let runs=0;
    const f=await fixture(t,async()=>{runs++;return{ok:true,text:'ordinary accepted'};},{overlay:false});
    await f.callback(form==='env'?'settings:env:quick:TEST_SLASH':'settings:auth:switch-sub');
    await f.message(leading+'/not_a_registered_command');
    assert.equal(f.messages.at(-1),form==='env'
      ?'Вышел из режима ввода переменной — команда не была сохранена как значение. Отправь её ещё раз.'
      :'Вышел из режима ввода токена — команда не была сохранена. Отправь её ещё раз.');
    assert.equal((await readEnvMap()).map.has('TEST_SLASH'),false);
    assert.equal((await readEnvMap()).map.has('CLAUDE_CODE_OAUTH_TOKEN'),false);
    assert.deepEqual(f.restartRequests,[]);
    await f.message('ordinary task');await until(()=>runs===1);
  });
}

test('form timeout parity: timezone had no old TTL and remains editable after ten minutes',async t=>{
  let clock=1_000_000;
  const f=await fixture(t,undefined,{overlay:false,now:()=>clock});
  await f.callback('settings:tz');clock+=700_000;
  await f.message('Pacific/Honolulu');assert.equal((await loadState()).state.timezone,'Pacific/Honolulu');
});
