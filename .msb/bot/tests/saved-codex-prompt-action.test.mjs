/**
 * Saved Codex actions through the same [scheduler](../src/autonomy/scheduler.mjs)
 * and overlay registration as the bot. Old permissions and session boundary
 * are recorded in [the contract](./reference/parity-autonomy-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startScheduler } from '../src/autonomy/scheduler.mjs';
import { setOwnerPause } from '../src/autonomy/owner-pause.mjs';
import { actionRoot, statePath } from '../src/paths.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { fixture } from './helpers/menu-fixture.mjs';
import { stageCodexMcp } from '../shared/codex-mcp-profile.mjs';
import { savedWorkspaceTools } from '../../../overlay/bot/ext/adapters/saved-workspace-tools.mjs';

const now = Date.parse('2026-11-09T12:00:00.000Z');
const owner = 42;
const original = {
  id: 'codex-task', name: 'Сохранённый сбор', enabled: true, runner: 'auto',
  trigger: { kind: 'interval', intervalMinutes: 60 },
  task: { kind: 'prompt', prompt: 'Выполни сохранённую задачу' },
  capability: 'read', authority: { profile: 'standard' }, output: { format: 'tg-message' },
};

async function profile(t, { action = original, actions, runSavedCodex, readCodexQuota, hold = false, apiAuth = false,
  rotateAuth = false, writeEffect = false } = {}) {
  const f = await fixture(t, async () => assert.fail('A saved action must not call the owner turn'),
    { overlay: true, runtimeProfile: 'jar1' });
  process.env.AUTONOMY_ENABLED = '1';
  for (const key of ['AUTONOMY_DIR', 'MSB_SESSION_DIR', 'IIA_SESSION_DIR', 'AUTONOMY_DAILY_CAP_USD',
    'AUTONOMY_DAILY_CAP_RUNS', 'AUTONOMY_DAILY_CAP_TOKENS', 'AUTONOMY_RESERVE_FRACTION']) delete process.env[key];
  process.env.OPENAI_API_KEY = 'inherited-fixture-key';
  process.env.CODEX_ACCESS_TOKEN = 'inherited-fixture-token';
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9/wrong';
  const native = path.join(f.home, 'chosen-codex-home');
  const wrong = path.join(f.home, '.codex');
  process.env.CODEX_HOME = native;
  await Promise.all([native, wrong].map(dir => fs.mkdir(dir)));
  const auth = path.join(native, 'auth.json'), config = path.join(native, 'config.toml');
  await fs.writeFile(auth, JSON.stringify(apiAuth
    ? { auth_mode: 'api_key', OPENAI_API_KEY: 'fixture-file-key' }
    : { auth_mode: 'chatgpt', tokens: { access_token: 'fixture-native-access' } }));
  await fs.writeFile(path.join(wrong, 'auth.json'), JSON.stringify(apiAuth
    ? { auth_mode: 'chatgpt', tokens: { access_token: 'fixture-wrong-profile' } }
    : { auth_mode: 'api_key', OPENAI_API_KEY: 'fixture-wrong-profile' }));
  await fs.writeFile(config, 'model = "gpt-6.1-sol"\n');
  const log = path.join(f.home, 'codex-call.json');
  const stopped = path.join(f.home, 'codex-stopped');
  const bin = path.join(f.home, 'codex-bin');
  await fs.mkdir(bin);
  const cli = path.join(bin, 'codex');
  await fs.writeFile(cli, '#!' + process.execPath + '\n' + [
    'const fs = require("node:fs");',
    'const argv = process.argv.slice(2);',
    'if (argv[0] === "--version") {',
    ...(rotateAuth ? ['fs.writeFileSync(' + JSON.stringify(auth) + ', JSON.stringify({auth_mode:"api_key",OPENAI_API_KEY:"fixture"}));'] : []),
    'console.log("codex-cli 0.166.0"); process.exit(0); }',
    'const input = fs.readFileSync(0, "utf8");',
    ...(writeEffect ? [
      'const key = "mcp_servers.saved_workspace.args=";',
      'const args = JSON.parse(argv.find(arg => arg.startsWith(key)).slice(key.length));',
      'const before = fs.existsSync("effect.txt") ? fs.readFileSync("effect.txt", "utf8") : "";',
      'const request = {id:1,method:"tools/call",params:{name:"write_file",arguments:{path:"effect.txt",text:before+"effect\\n"}}};',
      'const out = require("node:child_process").spawnSync(process.execPath, args, {input:JSON.stringify(request)+"\\n",encoding:"utf8"});',
      'if (out.status !== 0 || JSON.parse(out.stdout).result.isError) process.exit(78);',
    ] : []),
    'const active = () => fs.writeFileSync(' + JSON.stringify(log) + ', JSON.stringify({ argv, input, cwd: process.cwd(),',
    ' home: process.env.CODEX_HOME, api: !!process.env.OPENAI_API_KEY, access: !!process.env.CODEX_ACCESS_TOKEN,',
    ' base: !!process.env.OPENAI_BASE_URL }));',
    'const emit = event => console.log(JSON.stringify(event));',
    'const reply = () => {',
    ' emit({type:"thread.started",thread_id:"0199a213-81c0-7800-8aa1-bbab2a035a54"});',
    ' emit({type:"item.completed",item:{type:"agent_message",text:"Фоновый ответ Codex"}});',
    ' emit({type:"turn.completed",usage:{input_tokens:30,cached_input_tokens:8,output_tokens:5}});',
    '};',
    ...(hold ? [
      'process.on("SIGINT", () => { fs.writeFileSync(' + JSON.stringify(stopped) + ', "stopped"); reply(); process.exit(0); });',
      'active(); setInterval(() => {}, 1000);',
    ] : ['active(); reply();']),
  ].join('\n'), { mode: 0o700 });
  process.env.PATH = [bin, process.env.PATH].join(path.delimiter);
  await saveState({ ...(await loadState()).state, engine: 'cc', authMode: 'subscription', hasSubscriptionAuth: true,
    extAuthBypass: 'codex', chatId: owner, userId: owner, timezone: 'Europe/Moscow',
    ccSessionId: 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53', projectId: 'owner-current',
    lastCcUsage: { inputTokens: 900 } });
  const root = actionRoot(), autonomy = path.join(root, 'autonomy');
  const file = path.join(root, 'actions.json');
  await fs.mkdir(autonomy, { recursive: true });
  await fs.writeFile(file, JSON.stringify(actions ?? [action]));
  const scheduler = startScheduler({ api: f.bot.api, adminId: owner, timezone: 'Europe/Moscow',
    now: () => now, readCodexQuota, runCodexPrompt: runSavedCodex ?? f.bot[Symbol.for('msb.savedCodexPrompt')],
    runTurn: async () => assert.fail('A saved action must not use the interval compatibility turn'), log() {} });
  t.after(() => scheduler.stop());
  return { ...f, native, scheduler, autonomy, stopped, files: [statePath(), f.storeFile, auth, config],
    actions: async () => JSON.parse(await fs.readFile(file, 'utf8')),
    runs: async () => (await fs.readFile(path.join(autonomy, 'runs.jsonl'), 'utf8'))
      .trim().split('\n').map(JSON.parse),
    call: async () => JSON.parse(await fs.readFile(log, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return 'null';
      throw error;
    })) };
}

test('the saved action launches Codex independently of the normal conversation', async t => {
  const f = await profile(t);
  const snapshot = () => Promise.all(f.files.map(file => fs.readFile(file)));
  const before = await snapshot();
  await f.scheduler.tickNow();
  const call = await f.call();
  assert.ok(call, 'Codex must run the due saved action');
  assert.equal(call.home, await fs.realpath(f.native));
  assert.deepEqual([call.api, call.access, call.base], [false, false, false]);
  assert.equal(call.cwd, await fs.realpath(path.join(f.autonomy, 'cc-workspace')));
  for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules', 'read-only', 'features.shell_tool=false']) {
    assert.ok(call.argv.includes(flag), flag);
  }
  assert.ok(!call.argv.includes('resume'));
  assert.match(call.input, /Выполни сохранённую задачу/);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await f.actions())[0].lastStatus, 'ok');
  const [run] = await f.runs();
  assert.deepEqual([run.status, run.costUsd, run.tokensIn, run.tokensOut], ['ok', 0, 30, 5]);
  assert.equal(f.messages.length, 2);
  assert.match(f.messages[0], /Готово: 1 сообщение/);
  assert.equal(f.messages[1], 'Фоновый ответ Codex');
  await f.callback('auto:task:codex-task');
  assert.match(f.edits.at(-1), /✔ работает/);
});

async function waitForCall(f, tick) {
  for (let attempt = 0; attempt < 500 && !(await f.call()); attempt++) {
    const ended = await Promise.race([tick.then(() => true), delay(10).then(() => false)]);
    if (ended) break;
  }
  assert.ok(await f.call(), 'The saved Codex process must start before pause');
}

test('owner pause interrupts saved Codex and discards a late model reply', async t => {
  const f = await profile(t, { hold: true });
  const tick = f.scheduler.tickNow();
  await waitForCall(f, tick);
  await setOwnerPause(true, { now, check() {}, checkEngine() {} });
  await tick;
  assert.equal(await fs.readFile(f.stopped, 'utf8'), 'stopped');
  assert.deepEqual(await f.actions(), [original]);
  assert.equal((await f.runs())[0].status, 'stopped');
  assert.deepEqual(f.messages, []);
});

test('API-only Codex auth in the effective native home cannot run a saved subscription action', async t => {
  const f = await profile(t, { apiAuth: true });
  await f.scheduler.tickNow();
  assert.equal(await f.call(), null);
  assert.deepEqual(await f.actions(), [original]);
  assert.deepEqual(f.messages, []);
});

test('a native profile replaced with API auth during the version check cannot launch', async t => {
  const f = await profile(t, { rotateAuth: true });
  await f.scheduler.tickNow();
  assert.equal(await f.call(), null);
  assert.deepEqual(await f.actions(), [original]);
});

test('a stopped once action with a published file change does not replay on resume', async t => {
  const action = { ...original, trigger: { kind: 'once', at: new Date(now).toISOString() } };
  const f = await profile(t, { action, hold: true, writeEffect: true });
  const tick = f.scheduler.tickNow();
  await waitForCall(f, tick);
  const effect = path.join(f.autonomy, 'cc-workspace', 'effect.txt');
  assert.equal(await fs.readFile(effect, 'utf8'), 'effect\n');
  await setOwnerPause(true, { now, check() {}, checkEngine() {} });
  await tick;
  const [row] = await f.actions();
  assert.equal(row.disabledReason, 'spent_once');
  assert.equal(row.lastStatus, 'stopped');
  assert.deepEqual(f.messages, []);
  await setOwnerPause(false, { now, check() {}, checkEngine() {} });
  await f.scheduler.tickNow();
  assert.equal(await fs.readFile(effect, 'utf8'), 'effect\n');
});

for (const [label, helpers] of [['default', undefined], ['explicitly enabled', true], ['disabled', false]]) {
  test('saved Codex helper grant ' + label, async t => {
    const task = helpers === undefined ? original.task : { ...original.task, helpers };
    const f = await profile(t, { action: { ...original, task } });
    await f.scheduler.tickNow();
    const call = await f.call();
    assert.ok(call, 'The saved Codex prompt must launch');
    const enabled = helpers !== false;
    assert.ok(call.argv.includes('features.multi_agent=' + enabled));
    assert.ok(call.argv.includes('features.multi_agent_v2=' + enabled));
    assert.equal(call.input.includes('В этом задании можно привлекать помощников.'), enabled);
  });
}

test('a saved Codex turn cannot read or edit a concurrently staged foreground MCP profile', async t => {
  const f = await profile(t);
  const staged = await stageCodexMcp([{ name: 'fixture', config: { type: 'http', url: 'https://invalid.test/',
    headers: { Authorization: 'synthetic-profile-secret' } } }], f.workspace, process.env);
  t.after(staged.close);
  await f.scheduler.tickNow();
  const { argv } = await f.call();
  const key = 'mcp_servers.saved_workspace.args=';
  const [, raw] = JSON.parse(argv.find(arg => arg.startsWith(key)).slice(key.length));
  const bridge = await savedWorkspaceTools(JSON.parse(raw));
  const pending = path.join(staged.codexCustom.directory, 'servers.json');
  const before = await fs.readFile(pending);
  await assert.rejects(bridge.call('read_file', { path: pending }), /Доступ к пути запрещён/);
  await assert.rejects(bridge.call('write_file', { path: pending, text: 'unauthorized' }), /Доступ к пути запрещён/);
  assert.deepEqual(await fs.readFile(pending), before);
  const ordinary = await fs.mkdtemp(path.join(os.tmpdir(), 'ordinary-scheduled-fixture-'));
  t.after(() => fs.rm(ordinary, { recursive: true, force: true }));
  const note = path.join(ordinary, 'note.txt');
  await fs.writeFile(note, 'ordinary temporary work');
  assert.equal(await bridge.call('read_file', { path: note }), 'ordinary temporary work');
});

test('observed helper tokens consume the same daily budget as the parent', async t => {
  const next = { ...original, id: 'second-action', name: 'После лимита' };
  let calls = 0;
  const f = await profile(t, { actions: [original, next], runSavedCodex: async () => {
    calls++;
    return { providerId: 'codex', text: 'Тестовый результат', helperTokens: 93,
      usage: { inputTokens: 20, cacheReadTokens: 7, cacheCreationTokens: 0, outputTokens: 6 } };
  } });
  process.env.AUTONOMY_DAILY_CAP_TOKENS = '120';
  await f.scheduler.tickNow();
  assert.equal(calls, 1);
  const [first, second] = await f.runs();
  assert.deepEqual([first.status, first.tokensIn, first.tokensOut], ['ok', 120, 6]);
  assert.equal(second.status, 'blocked');
  assert.match(second.detail, /дневной запас/);
});

test('partial helper usage keeps known counts and leaves an incomplete marker', async t => {
  const f = await profile(t, { runSavedCodex: async () => ({
    providerId: 'codex', text: 'Тестовый результат', helperTokens: 31, usageIncomplete: true,
  }) });
  await f.scheduler.tickNow();
  const [run] = await f.runs();
  assert.equal(run.status, 'ok');
  assert.equal(run.tokensIn, 31);
  assert.equal(run.tokensOut, undefined);
  assert.equal(run.usageIncomplete, true);
});


test('a Codex account fence is checked again after claim and before the owned CLI starts', async t => {
  let checks = 0;
  const f = await profile(t, { readCodexQuota: async () => ({
    isCurrent: async () => ++checks === 1,
    quota: { measuredAt: now, windows: [{ minutes: 300, usedPercent: 40, resetAtMs: now + 3600_000 }] },
  }) });
  await f.scheduler.tickNow();
  assert.equal(checks, 2);
  assert.equal(await f.call(), null);
  assert.deepEqual(await f.actions(), [original]);
  assert.deepEqual(f.messages, []);
});
