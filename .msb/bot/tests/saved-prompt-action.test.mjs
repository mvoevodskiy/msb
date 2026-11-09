/**
 * Old stored prompt actions through the production scheduler and native CLI shim.
 * Old readable blob 73aa9e7e850bad7ac1ea8a8091d086ecbfd47a11, 33315–33504,
 * 36743–36919, 37091–37098. All credentials, CLI traffic and files are synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startScheduler } from '../src/autonomy/scheduler.mjs';
import { setOwnerPause } from '../src/autonomy/owner-pause.mjs';
import { actionRoot, statePath } from '../src/paths.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { fixture } from './helpers/menu-fixture.mjs';

const now = Date.parse('2026-11-09T12:00:00.000Z');
const ts = new Date(now).toISOString();
const owner = -100777;
const action = (id, changes = {}) => ({ id, name: 'Сбор ' + id, enabled: true, runner: 'auto',
  trigger: { kind: 'interval', intervalMinutes: 60 }, task: { kind: 'prompt', prompt: 'Задание ' + id },
  capability: 'read', authority: { profile: 'standard' }, output: { format: 'tg-message', store: false }, ...changes });
const shim = fileURLToPath(new URL('../../../overlay/bot/ext/shim/bin', import.meta.url));

async function profile(t, actions, { state = {}, text = 'Отчёт задачи <данные>', hold = false } = {}) {
  const f = await fixture(t, async () => assert.fail('Saved action must not call the shared owner turn'),
    { overlay: false, runtimeProfile: 'jar1' });
  for (const key of ['MSB_SESSION_DIR', 'IIA_SESSION_DIR', 'AUTONOMY_DIR', 'AUTONOMY_DAILY_CAP_USD',
    'AUTONOMY_DAILY_CAP_RUNS', 'AUTONOMY_DAILY_CAP_TOKENS', 'AUTONOMY_RESERVE_FRACTION']) delete process.env[key];
  process.env.AUTONOMY_ENABLED = '1';
  const root = actionRoot();
  const autonomy = path.join(root, 'autonomy');
  const actionsFile = path.join(root, 'actions.json');
  const log = path.join(f.home, 'native-turns.jsonl');
  const closed = path.join(f.home, 'native-closed');
  const native = path.join(f.home, 'native-test-claude.mjs');
  const fakeBin = path.join(f.home, 'fake-bin');
  await fs.mkdir(fakeBin);
  await fs.writeFile(path.join(fakeBin, 'codex'), '#!/bin/sh\nexit 77\n', { mode: 0o700 });
  await fs.writeFile(native, `import fs from 'node:fs';
const argv = process.argv.slice(2);
if(argv[0] === '--version') { console.log('2.1.154 (Claude Code)'); process.exit(0); }
if(argv[0] === '--help') { console.log('--tools <tools> --no-session-persistence --strict-mcp-config'); process.exit(0); }
const input=fs.readFileSync(0,'utf8');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({argv, input, cwd: process.cwd(), provider: process.env.MSB_TURN_PROVIDER})+'\\n');
const emit=(kind,obj)=>console.log(JSON.stringify({type:kind,...obj}));
const session_id='77777777-7777-4777-8777-777777777777';
emit('system',{subtype:'init',session_id,model:'sonnet'});
const finish=()=>{emit('result',{subtype:'success',session_id,is_error:false,result:${JSON.stringify(text)},total_cost_usd:0.02,
usage:{input_tokens:15,output_tokens:4,cache_read_input_tokens:3,cache_creation_input_tokens:2}});};
if (${JSON.stringify(hold)}) {
 process.on('SIGINT',()=>{fs.writeFileSync(${JSON.stringify(closed)},'signal');finish();process.exit(0);});
 setInterval(()=>{},1000);
} else finish();`);
  process.env.MSB_REAL_CLAUDE = native;
  process.env.PATH = [fakeBin, shim, process.env.PATH].join(path.delimiter);
  await saveState({ ...(await loadState()).state, engine: 'cc', authMode: 'subscription', hasSubscriptionAuth: true,
    extAuthBypass: undefined, chatId: owner, userId: 42, timezone: 'Europe/Moscow', ccModel: 'opus',
    ccSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectId: 'owner-current',
    lastCcUsage: { inputTokens: 900 }, ...state });
  await fs.mkdir(autonomy, { recursive: true });
  await fs.writeFile(actionsFile, JSON.stringify(actions));
  const sent = [];
  const originalSend = f.bot.api.sendMessage;
  f.bot.api.sendMessage = async (chat, message, ...options) => {
    sent.push({ chat, text: message });
    return originalSend(chat, message, ...options);
  };
  const scheduler = startScheduler({ api: f.bot.api, adminId: 42, timezone: 'Europe/Moscow', now: () => now,
    runTurn: async () => assert.fail('Compatibility interval runner must not execute saved actions'), log() {} });
  t.after(() => scheduler.stop());
  const lines = async file => (await fs.readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  })).split('\n').filter(Boolean).map(JSON.parse);
  return { ...f, root, autonomy, closed, sent, scheduler, actionsFile, calls: () => lines(log),
    runs: () => lines(path.join(autonomy, 'runs.jsonl')),
    actions: async () => JSON.parse(await fs.readFile(actionsFile, 'utf8')) };
}

const value = (call, name) => call.argv[call.argv.indexOf(name) + 1];
async function waitForNative(f, tick) {
  for (let index = 0; index < 600; index++) {
    if ((await f.calls()).length) return;
    const ended = await Promise.race([tick.then(() => true), delay(5).then(() => false)]);
    if (ended) break;
  }
  assert.fail('A native process must have started');
}

test('a saved Claude prompt uses the old isolated workspace, native tool boundary and separate history', async t => {
  const f = await profile(t, [action('default')]);
  const protectedBefore = await Promise.all([fs.readFile(statePath()), fs.readFile(f.storeFile)]);
  await f.scheduler.tickNow();
  const calls = await f.calls();
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.cwd, await fs.realpath(path.join(f.autonomy, 'cc-workspace')));
  assert.equal(call.provider, 'claude');
  assert.equal(value(call, '--model'), 'sonnet');
  assert.equal(value(call, '--permission-mode'), 'acceptEdits');
  assert.ok(!call.argv.includes('--resume'));
  assert.ok(call.argv.includes('--no-session-persistence'));
  assert.ok(call.argv.includes('--strict-mcp-config'));
  assert.equal(value(call, '--mcp-config'), '{"mcpServers":{}}');
  const tools = value(call, '--tools').split(',');
  for (const name of ['Read', 'Write', 'Edit', 'NotebookEdit']) assert.ok(tools.includes(name));
  assert.ok(!tools.includes('Bash'));
  assert.ok(call.argv.includes('mcp__*'));
  assert.ok(call.argv.some(arg => arg.startsWith('Write(//') && arg.includes('/state.json')));
  assert.match(call.input, /Задание default/);
  assert.ok(f.sent.some(row => row.chat === owner && row.text.includes('Отчёт задачи')));
  assert.deepEqual(await Promise.all([fs.readFile(statePath()), fs.readFile(f.storeFile)]), protectedBefore);
  const [saved] = await f.actions();
  assert.equal(saved.lastStatus, 'ok');
  assert.equal(saved.lastRunAt, ts);
  const [run] = await f.runs();
  assert.deepEqual([run.kind, run.status, run.costUsd, run.meteredUsd, run.tokensIn, run.tokensOut], ['prompt', 'ok', 0, 0.02, 20, 4]);
  await f.callback('auto:history');
  assert.match(f.edits.at(-1), /Сбор default/);
});

test('an explicitly narrow saved prompt keeps quiet without writing or spawning helpers', async t => {
  const f = await profile(t, [action('quiet', { capability: 'none', authority: { profile: 'narrow' },
    task: { kind: 'prompt', prompt: 'Проверь источники', helpers: false },
    output: { format: 'tg-message', emptyIsValidOutcome: true } })], { text: '[NOTHING_TO_REPORT]' });
  await f.scheduler.tickNow();
  const [call] = await f.calls();
  assert.ok(call);
  assert.match(call.input, /\[NOTHING_TO_REPORT\]/);
  const tools = value(call, '--tools').split(',');
  assert.ok(tools.includes('Read'));
  for (const name of ['Write', 'Edit', 'Bash', 'Agent', 'Task']) assert.ok(!tools.includes(name));
  assert.deepEqual(f.sent, []);
  assert.equal((await f.runs())[0].status, 'skipped');
  assert.equal((await f.actions())[0].lastOutcome, 'empty');
});

test('unsupported saved model actions cannot fall back to the owner or another provider', async t => {
  const rows = [action('default'), action('codex', { task: { kind: 'prompt', prompt: 'fixture', provider: 'codex' } }),
    action('shell', { task: { kind: 'prompt', prompt: 'fixture', shell: true } }),
    action('continuous', { run: { memory: 'continuous' } })];
  const f = await profile(t, rows, { state: { extAuthBypass: 'codex' } });
  await f.scheduler.tickNow();
  assert.deepEqual(await f.calls(), []);
  assert.deepEqual(await f.actions(), rows);
  await saveState({ ...(await loadState()).state, extAuthBypass: undefined });
  await f.scheduler.tickNow();
  assert.equal((await f.calls()).length, 1);
  assert.deepEqual((await f.actions()).slice(1), rows.slice(1));
});

for (const reason of ['owner pause', 'scheduler shutdown']) {
  test(`${reason} interrupts the actual prompt process and releases its attempt without a late response`, async t => {
    const original = action('interrupt');
    const f = await profile(t, [original], { hold: true });
    const tick = f.scheduler.tickNow();
    await waitForNative(f, tick);
    if (reason === 'owner pause') await setOwnerPause(true, { now, check() {}, checkEngine() {} });
    else await f.scheduler.stop();
    await tick;
    assert.equal(await fs.readFile(f.closed, 'utf8'), 'signal');
    assert.deepEqual(await f.actions(), [original]);
    assert.equal((await f.runs())[0].status, 'stopped');
    assert.deepEqual(f.sent, []);
  });
}
