import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import childProcess, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Bot } from 'grammy';

// One subprocess per scenario keeps prototype patches and env writes isolated.
const scenario = process.argv[2];
const engineMenuScenario = scenario.startsWith('engine-');
const fixtureHome = process.env.HOME;
if (!fixtureHome || fixtureHome !== process.env.REFERENCE_HOME || os.homedir() !== fixtureHome) {
  throw new Error('The reference harness requires its isolated HOME');
}
if (!globalThis[Symbol.for('msb.reference.networkBlocked')]) {
  throw new Error('The harness must run with the network-deny preload');
}

const owner = 42;
const thread = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const session = `ext:codex:${thread}`;
const botDir = path.join(fixtureHome, '.msb/bots/default');
const stateFile = path.join(botDir, 'state.json');
const storeFile = path.join(botDir, 'ext-providers.json');
const authFile = path.join(fixtureHome, '.codex/auth.json');
const binDir = path.join(fixtureHome, 'bin');
const traceFile = path.join(fixtureHome, 'cli-trace.jsonl');
const effectsFile = path.join(fixtureHome, 'effects.txt');
const workspace = path.join(fixtureHome, 'workspace');
await Promise.all([fs.mkdir(botDir, { recursive: true }), fs.mkdir(path.dirname(authFile), { recursive: true }),
  fs.mkdir(binDir), fs.mkdir(workspace)]);
const fake = (await fs.readFile(new URL('./fake-provider-cli.mjs', import.meta.url), 'utf8'))
  .replace(/^#![^\n]+/, `#!${process.execPath}`);
for (const name of ['codex', 'claude']) await fs.writeFile(path.join(binDir, name), fake, { mode: 0o700 });

Object.assign(process.env, {
  PATH: binDir, MSB_BOT_ID: 'default', ADMIN_ID: String(owner),
  MSB_WORKSPACE_DIR: workspace, MSB_SESSION_DIR: path.join(botDir, 'sessions'),
  MSB_REAL_CLAUDE: path.join(binDir, 'claude'),
  CLAUDE_CODE_OAUTH_TOKEN: 'reference-claude-oauth-not-a-real-token',
  REFERENCE_TRACE: traceFile, REFERENCE_EFFECTS: effectsFile,
  REFERENCE_LOGIN: scenario.includes('invalid-login') ? 'invalid' : 'valid',
  REFERENCE_SCENARIO: scenario,
});
const nativeAuth = JSON.stringify({ auth_mode: 'chatgpt', tokens: {
  access_token: 'reference-access-not-a-real-token', refresh_token: 'reference-refresh-not-a-real-token',
} });
await fs.writeFile(authFile, nativeAuth, { mode: 0o600 });
await fs.writeFile(path.join(fixtureHome, '.codex/config.toml'),
  'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\napproval_policy = "never"\n', { mode: 0o600 });
const initialState = { engine: 'cc', authMode: 'subscription', hasSubscriptionAuth: true,
  ccSessionId: 'reference-claude-session', userId: owner, chatId: owner };
const initialStore = { version: 1, active: 'claude', sessions: {}, models: {}, efforts: {}, updatedAt: null };
const writeJSON = (file, value) => fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
const readJSON = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
await writeJSON(stateFile, initialState);
await writeJSON(storeFile, initialStore);

// The real router/overlay may write only this disposable profile. In particular,
// never let a regression submit an OS-helper request or execute a system CLI.
const forbiddenEffects = [];
if (engineMenuScenario) {
  const checkPath = (value, method) => {
    const file = value instanceof URL ? fileURLToPath(value) : String(value);
    const resolved = path.resolve(file);
    if (resolved === path.join(fixtureHome, '.msb/engine') || resolved.startsWith(path.join(fixtureHome, '.msb/engine') + path.sep)) {
      forbiddenEffects.push({ method, file });
      throw new Error('Reference harness forbids OS-helper requests');
    }
    if (resolved !== fixtureHome && !resolved.startsWith(`${fixtureHome}${path.sep}`)) {
      forbiddenEffects.push({ method, file });
      throw new Error(`Reference harness forbids ${method} outside HOME`);
    }
  };
  for (const method of ['writeFile', 'appendFile', 'mkdir', 'rename', 'copyFile', 'unlink', 'rm']) {
    for (const [target, name] of [[fs, method], [fsSync, `${method}Sync`]]) {
      const original = target[name];
      target[name] = function (...args) {
        checkPath(args[0], name);
        if (method === 'rename' || method === 'copyFile') checkPath(args[1], name);
        return original.apply(this, args);
      };
    }
  }
  for (const method of ['spawn', 'exec', 'execFile', 'spawnSync', 'execSync', 'execFileSync', 'fork']) {
    const original = childProcess[method];
    childProcess[method] = function (command, ...args) {
      if (method !== 'spawn' || command !== path.join(binDir, 'codex') ||
          JSON.stringify(args[0]) !== JSON.stringify(['login', 'status'])) {
        forbiddenEffects.push({ method, command });
        throw new Error(`Reference harness forbids unexpected ${method}`);
      }
      return original.call(this, command, ...args);
    };
  }
  syncBuiltinESMExports();
}

async function trace() {
  const text = await fs.readFile(traceFile, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return text.trim() ? text.trim().split('\n').map(JSON.parse) : [];
}

async function runShim(argv, envOverrides = {}) {
  const script = fileURLToPath(new URL('../../../shim/run-turn.mjs', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...argv], {
      cwd: workspace, env: { ...process.env, ...envOverrides }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 8_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error(`Reference shim terminated by ${signal}: ${stderr}`));
      const events = stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
      resolve({ code, events });
    });
    child.stdin.end('reference prompt');
  });
}

async function hookedBot({ coreRouter = false } = {}) {
  const { prepare } = await import('../../../install.mjs');
  await prepare();
  const botInfo = { id: 123456, is_bot: true, first_name: 'Reference', username: 'provider_reference_bot' };
  const bot = new Bot('123456:REFERENCE_NOT_A_REAL_BOT_TOKEN', { botInfo });
  const calls = [];
  let messageId = 10;
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload });
    if (method === 'answerCallbackQuery') return { ok: true, result: true };
    if (method === 'sendMessage' || method === 'editMessageText') return { ok: true, result: {
      message_id: payload.message_id || messageId++, date: 0,
      chat: { id: payload.chat_id, type: 'private' }, text: payload.text,
    } };
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
  const { adminGuard } = await import(pathToFileURL(path.join(root, '.msb/bot/src/telegram/auth.mjs')).href);
  bot.use(adminGuard(owner));
  const coreCallbacks = [];
  if (coreRouter) {
    const { handleCallback } = await import(pathToFileURL(path.join(root, '.msb/bot/src/telegram/router.mjs')).href);
    const { readConfig } = await import(pathToFileURL(path.join(root, '.msb/bot/src/config.mjs')).href);
    const pending = new Map();
    bot.on('callback_query:data', (ctx) => {
      coreCallbacks.push(ctx.callbackQuery.data);
      return handleCallback({ bot, cfg: readConfig(), pending, ctx });
    });
  } else {
    bot.on('callback_query:data', (ctx) => ctx.answerCallbackQuery());
  }
  let updateId = 1;
  const callback = (data, actor = owner) => bot.handleUpdate({
    update_id: updateId++, callback_query: { id: `reference-${updateId}`, chat_instance: 'reference', data,
      from: { id: actor, is_bot: false, first_name: 'Reference actor' },
      message: { message_id: 1, date: 0, from: botInfo, chat: { id: actor, type: 'private' } },
    },
  });
  return { bot, callback, calls, coreCallbacks };
}

let result;
if (engineMenuScenario) {
  const alreadyCodex = ['engine-home', 'engine-reselect'].includes(scenario);
  const openClaw = scenario.startsWith('engine-oc-');
  const selectedStore = { ...initialStore, active: alreadyCodex ? 'codex' : 'claude',
    sessions: { codex: thread }, models: { codex: 'gpt-6.1-sol' }, efforts: { codex: 'high' } };
  const selectedState = { ...initialState, engine: openClaw ? 'oc' : 'cc',
    ccModel: 'sonnet', ccEffort: 'medium', permissionMode: 'auto', sessionEpoch: 7,
    ...(alreadyCodex ? { extAuthBypass: 'codex', ccSessionId: session } : {}),
    ...(openClaw ? { ocModel: 'openai/reference', ocSessionId: 'reference-oc-session' } : {}) };
  await writeJSON(stateFile, selectedState);
  await writeJSON(storeFile, selectedStore);
  const f = await hookedBot({ coreRouter: true });
  const snapshot = async () => ({
    state: await fs.readFile(stateFile, 'utf8'), store: await fs.readFile(storeFile, 'utf8'),
    config: await fs.readFile(path.join(fixtureHome, '.codex/config.toml'), 'utf8'),
    auth: await fs.readFile(authFile, 'utf8'),
  });
  const before = await snapshot();
  await f.callback('eng:home');
  const menu = f.calls.findLast((call) => call.method === 'editMessageText');
  if (!menu) throw new Error('The real core router did not render eng:home');
  const buttons = menu.payload.reply_markup?.inline_keyboard?.flat() || [];
  const codexButton = buttons.find((button) => button.text.includes('Codex'));
  if (!codexButton) throw new Error('The real engine menu contains no Codex button');
  const afterHome = await snapshot();
  const homeCli = await trace();
  const homeCoreCallbacks = [...f.coreCallbacks];
  const callsBeforeClick = f.calls.length;
  if (scenario !== 'engine-home') {
    await f.callback(codexButton.callback_data, scenario === 'engine-foreign-owner' ? 43 : owner);
    if (scenario === 'engine-reselect') await f.callback(codexButton.callback_data);
  }
  const after = await snapshot();
  const unchanged = (a, b) => Object.fromEntries(Object.keys(a).map((key) => [key, a[key] === b[key]]));
  result = {
    menu: { text: menu.payload.text, messageId: menu.payload.message_id, buttons },
    homeUnchanged: unchanged(before, afterHome), homeCli, homeCoreCallbacks,
    unchanged: unchanged(before, after), state: JSON.parse(after.state), store: JSON.parse(after.store),
    // Only non-secret synthetic configuration is returned to the test process.
    nativeConfig: after.config, actionCalls: f.calls.slice(callsBeforeClick),
    coreCallbacks: f.coreCallbacks, cli: await trace(), forbiddenEffects,
  };
} else if (scenario === 'roundtrip') {
  const f = await hookedBot();
  const originalClaudeAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  await f.callback('ext:conn:set:codex');
  const codexState = await readJSON(stateFile);
  const codexStore = await readJSON(storeFile);
  // Existing completed Codex conversation at the point of switching back.
  await writeJSON(stateFile, { ...codexState, ccSessionId: session });
  await f.callback('ext:conn:set:claude');
  const claudeState = await readJSON(stateFile);
  const claudeStore = await readJSON(storeFile);
  const foreign = await runShim(['-p', '--resume', session, '--model', 'sonnet']);
  const own = await runShim(['-p', '--resume', 'reference-claude-session', '--model', 'sonnet']);
  const claudeCalls = (await trace()).filter((entry) => entry.name === 'claude');
  await f.callback('ext:conn:set:codex');
  const returnedCodexState = await readJSON(stateFile);
  const returnedCodexStore = await readJSON(storeFile);
  result = { firstProvider: codexStore.active, firstMarker: codexState.extAuthBypass,
    oldClaudeSessionCleared: !codexState.ccSessionId,
    finalProvider: claudeStore.active, finalMarkerRemoved: !claudeState.extAuthBypass,
    foreignSessionCleared: claudeState.ccSessionId !== session,
    claudeSessionRestored: claudeState.ccSessionId === 'reference-claude-session',
    codexSessionRestored: returnedCodexState.ccSessionId === session,
    returnedProvider: returnedCodexStore.active,
    nativeAuthUnchanged: await fs.readFile(authFile, 'utf8') === nativeAuth,
    claudeAuthUnchanged: process.env.CLAUDE_CODE_OAUTH_TOKEN === originalClaudeAuth,
    foreignCode: foreign.code, ownCode: own.code,
    forwarded: claudeCalls.map(({ argv, stdin }) => ({ argv, stdin })) };
} else if (scenario === 'pinned-route') {
  // The user changes the selected provider after an earlier turn took its snapshot.
  await writeJSON(storeFile, { ...initialStore, active:'claude', sessions:{codex:thread} });
  const codexTurn = await runShim(['-p', '--resume', session], { MSB_TURN_PROVIDER:'codex' });
  await writeJSON(storeFile, { ...initialStore, active:'codex', sessions:{codex:thread} });
  const claudeTurn = await runShim(['-p', '--resume', 'reference-claude-session'], { MSB_TURN_PROVIDER:'claude' });
  const beforeInvalid = (await trace()).length;
  const invalidTurn = await runShim(['-p'], { MSB_TURN_PROVIDER:'invalid-provider' });
  const restrictedTurn = await runShim(['-p'], { MSB_TURN_PROVIDER:'codex', JARVIS_CC_ONLY:'1' });
  const calls = await trace();
  result = { codexTurnCode:codexTurn.code, claudeTurnCode:claudeTurn.code, invalidTurnCode:invalidTurn.code,
    restrictedTurnCode:restrictedTurn.code,
    codexCalls:calls.filter(x => x.name==='codex' && x.argv[0]==='exec').length,
    claudeCalls:calls.filter(x => x.name==='claude').map(x => x.argv),
    invalidLaunchedCli:calls.length!==beforeInvalid,
    codexResumedOwnSession:calls.some(x => x.name==='codex' && x.argv.includes('resume') && x.argv.includes(thread)) };
} else if (scenario === 'invalid-login' || scenario === 'foreign-owner') {
  const f = await hookedBot();
  const beforeState = await fs.readFile(stateFile, 'utf8');
  const beforeStore = await fs.readFile(storeFile, 'utf8');
  await f.callback('ext:conn:set:codex', scenario === 'foreign-owner' ? 43 : owner);
  result = { provider: (await readJSON(storeFile)).active,
    sessionId: (await readJSON(stateFile)).ccSessionId ?? null,
    stateUnchanged: await fs.readFile(stateFile, 'utf8') === beforeState,
    storeUnchanged: await fs.readFile(storeFile, 'utf8') === beforeStore,
    loginChecked: (await trace()).some((entry) => entry.name === 'codex' && entry.argv.join(' ') === 'login status'),
    announcedSwitch: f.calls.some((call) => String(call.payload.text || '').includes('Агент теперь на')),
    apiCalls: f.calls.length };
} else if (scenario === 'codex-first-stop' || scenario === 'codex-first-empty-error') {
  const stopped = scenario === 'codex-first-stop';
  const { ccSessionId, ...firstState } = initialState;
  const priorUsage = { sessionId: 'earlier-session', contextTokens: 123, contextWindow: 1000 };
  await writeJSON(stateFile, { ...firstState, extAuthBypass: 'codex', lastCcUsage: priorUsage });
  await writeJSON(storeFile, { ...initialStore, active: 'codex' });
  const shimBin = fileURLToPath(new URL('../../../shim/bin/', import.meta.url));
  process.env.PATH = [shimBin, binDir, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  const { runAgentTurn } = await import('../../../../../../.msb/bot/src/agent/turn.mjs');
  const controller = new AbortController();
  const pending = runAgentTurn({ prompt: 'reference first Codex turn', signal: controller.signal });
  const exists = name => fs.access(path.join(fixtureHome, name)).then(() => true, () => false);
  let out;
  try {
    if (stopped) {
      const deadline = Date.now() + 5000;
      while (!await exists('reference-native-started')) {
        if (Date.now() > deadline) throw new Error('Codex did not emit thread.started');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      // The CLI is held open after flushing its JSONL record. Allow its pipes to drain before stop.
      await new Promise(resolve => setTimeout(resolve, 300));
      controller.abort();
    }
    out = await pending;
  } finally {
    controller.abort();
    await pending.catch(() => {});
  }
  const state = await readJSON(stateFile);
  result = {
    nativeExecutions: (await trace()).filter(entry => entry.name === 'codex' && entry.argv[0] === 'exec').length,
    nativeStopped: await exists('reference-native-stopped'),
    aborted: Boolean(out.result?.aborted), ok: out.ok, text: out.text,
    observedId: out.result?.sessionId || null, context: out.result?.context ?? null,
    active: state.ccSessionId ?? null, parked: state.parkedCcSessions?.codex ?? null,
    lastUsage: state.lastCcUsage, priorUsage,
    pending: state.pendingCcSessionStarts ?? null,
    storedNative: (await readJSON(storeFile)).sessions.codex ?? null,
    history: state.sessionHistory ?? [],
  };
} else if (scenario === 'model-error' || scenario === 'stream-cut') {
  await writeJSON(storeFile, { ...initialStore, active: 'codex', sessions: { codex: thread } });
  await writeJSON(stateFile, { ...initialState, extAuthBypass: 'codex', ccSessionId: session });
  const output = await runShim(['-p', '--resume', session, '--model', 'opus']);
  const effects = await fs.readFile(effectsFile, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  result = { exitCode: output.code,
    executions: (await trace()).filter((entry) => entry.name === 'codex' && entry.argv[0] === 'exec').length,
    effects: effects.trim() ? effects.trim().split('\n').length : 0,
    savedSession: (await readJSON(storeFile)).sessions.codex ?? null,
    emittedSessions: [...new Set(output.events.map((event) => event.session_id).filter(Boolean))] };
} else {
  throw new Error(`Unknown reference scenario: ${scenario}`);
}
process.stdout.write(JSON.stringify(result));
