/**
 * Claude resume refusal through the Telegram inbox and production PATH shim.
 * Old master 00f081f, readable blob 73aa9e7e, qTA/LTA 55986–55988/56039–56053.
 * Native subprocess and Telegram are fixtures. State, workspace and arguments are real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { fixture } from './helpers/menu-fixture.mjs';

const expired = '6b800e2c-f9b1-4b97-bd36-202f96a75530';
const fresh = '6b800e2c-f9b1-4b97-bd36-202f96a75531';
const keptCodex = 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53';
const expiredRow = { id: expired, startedAt: '2026-11-01T00:00:00Z', lastActivity: '2026-11-01T00:01:00Z',
  messageCount: 4, firstPrompt: 'old prompt', lastPrompt: 'old last prompt', engine: 'cc', providerId: 'claude', project: 'alpha' };
const usage = { input_tokens: 53, output_tokens: 4 };

async function waitFor(predicate) {
  const deadline = Date.now() + 6000;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) assert.fail('No fixture result before the deadline');
    await delay(10);
  }
}

async function claudeFixture(t, mode = 'stderr') {
  const f = await fixture(t, runAgentTurn);
  const project = path.join(f.home, 'projects', 'alpha');
  await fs.mkdir(project, { recursive: true });
  const trace = path.join(f.home, 'fixture-claude-calls');
  const release = path.join(f.home, 'release-refusal');
  const cli = path.join(f.home, 'fixture-claude');
  const fixtureProgram = [
    '#!' + process.execPath,
    'const fs = require("node:fs");',
    'const { setTimeout } = require("node:timers/promises");',
    'const opts = ' + JSON.stringify({ mode, trace, release, expired, fresh, usage }) + ';',
    'const args = process.argv.slice(2);',
    'if (args[0] === "--version") { console.log("2.1.316 (Claude Code)"); process.exit(0); }',
    'const id = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;',
    'const prompt = fs.readFileSync(0, "utf8");',
    'const emit = frame => console.log(JSON.stringify(frame));',
    'fs.appendFileSync(opts.trace, JSON.stringify({ args, id, prompt, cwd: process.cwd(), provider: process.env.MSB_TURN_PROVIDER }) + "\\n");',
    '(async () => {',
    '  if (id === opts.expired || opts.mode === "twice") {',
    '    if (opts.mode === "late") while (!fs.existsSync(opts.release)) await setTimeout(5);',
    '    if (opts.mode === "worked") {',
    '      emit({type:"system",subtype:"init",session_id:id,model:"claude-sonnet-5-5"});',
    '      emit({type:"assistant",message:{content:[{type:"tool_use",name:"Write",input:{file_path:"fixture-output"}}]}});',
    '    }',
    '    const reason = "No conversation found with session ID: " + opts.expired;',
    '    if (opts.mode !== "structured") console.error(reason);',
    '    emit({type:"result",subtype:"error_during_execution",is_error:true,session_id:id || undefined,errors:[reason]});',
    '    process.exitCode = 1;',
    '    return;',
    '  }',
    '  emit({type:"system",subtype:"init",session_id:opts.fresh,model:"claude-sonnet-5-5"});',
    '  emit({type:"assistant",message:{content:[{type:"text",text:"fixture Claude answer"}],usage:opts.usage}});',
    '  emit({type:"result",subtype:"success",session_id:opts.fresh,result:"fixture Claude answer",usage:opts.usage,is_error:false});',
    '})();',
    '',
  ].join('\n');
  await fs.writeFile(cli, fixtureProgram, { mode: 0o700 });
  const shim = fileURLToPath(new URL('../../../overlay/bot/ext/shim/bin/', import.meta.url));
  process.env.MSB_REAL_CLAUDE = cli;
  process.env.PATH = [shim, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-only-claude';
  const { state } = await loadState();
  await saveState({ ...state, engine: 'cc', extAuthBypass: undefined,
    authMode: 'subscription', hasSubscriptionAuth: true, activeProject: 'alpha',
    ccSessionId: expired, ccModel: 'sonnet', ccEffort: 'medium', sessionEpoch: 4,
    parkedCcSessions: { codex: keptCodex }, sessionHistory: [expiredRow],
    lastCcUsage: { sessionId: expired, inputTokens: 19 } });
  const calls = async () => (await fs.readFile(trace, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  })).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { ...f, project: await fs.realpath(project), release, calls };
}

for (const mode of ['stderr', 'structured']) {
  test('Claude repeats the original Telegram request once after a resume refusal from ' + mode, async t => {
    const f = await claudeFixture(t, mode);
    const storeBefore = await fs.readFile(f.storeFile, 'utf8');
    const prompt = '  fixture original request  ';
    await f.message(prompt);
    await waitFor(() => f.edits.some(text => text.startsWith('fixture Claude answer\n\n<blockquote>⏱')));
    const [resume, restart] = await f.calls();
    assert.equal((await f.calls()).length, 2);
    assert.deepEqual([resume.id, restart.id], [expired, null]);
    assert.equal(resume.prompt, restart.prompt);
    assert.equal(resume.prompt, prompt);
    assert.deepEqual([resume.cwd, restart.cwd], [f.project, f.project]);
    assert.deepEqual([resume.provider, restart.provider], ['claude', 'claude']);
    assert.deepEqual(resume.args.filter((value, index) => index !== resume.args.indexOf('--resume') &&
      index !== resume.args.indexOf('--resume') + 1), restart.args);
    assert.equal(f.edits.filter(text => text.startsWith('fixture Claude answer')).length, 1);
    const { state } = await loadState();
    assert.equal(state.ccSessionId, fresh);
    assert.equal(state.lastCcUsage.sessionId, fresh);
    assert.deepEqual(state.parkedCcSessions, { codex: keptCodex });
    assert.deepEqual(state.sessionHistory[0], expiredRow);
    assert.equal(state.sessionHistory[1].messageCount, 1);
    assert.equal(state.pendingCcSessionStarts, undefined);
    assert.equal(await fs.readFile(f.storeFile, 'utf8'), storeBefore);

    await f.message('fixture next user request');
    await waitFor(() => f.edits.filter(text => text.startsWith('fixture Claude answer')).length === 2);
    assert.equal((await f.calls())[2].id, fresh);
    assert.equal((await loadState()).state.sessionHistory[1].messageCount, 2);
  });
}

test('a second rejection terminates with no active Claude resume ID and no phantom history', async t => {
  const f = await claudeFixture(t, 'twice');
  const out = await runAgentTurn({ prompt: 'fixture second refusal' });
  assert.equal(out.ok, false);
  assert.deepEqual((await f.calls()).map(call => call.id), [expired, null]);
  const { state } = await loadState();
  assert.equal(state.ccSessionId, undefined);
  assert.equal(state.pendingCcSessionStarts, undefined);
  assert.deepEqual(state.sessionHistory, [expiredRow]);
});

test('a model turn with an observed tool call cannot replay the user request', async t => {
  const f = await claudeFixture(t, 'worked');
  const out = await runAgentTurn({ prompt: 'fixture has already worked' });
  assert.equal(out.ok, false);
  assert.deepEqual((await f.calls()).map(call => call.id), [expired]);
  assert.equal((await loadState()).state.ccSessionId, expired);
});

test('a late rejection does not reopen a Claude conversation after /newtask', async t => {
  const f = await claudeFixture(t, 'late');
  const task = runAgentTurn({ prompt: 'fixture late rejection' });
  try {
    await waitFor(async () => (await f.calls()).length === 1);
    await f.message('/newtask');
  } finally {
    await fs.writeFile(f.release, 'release');
  }
  const out = await task;
  assert.equal(out.ok, false);
  assert.deepEqual((await f.calls()).map(call => call.id), [expired]);
  const { state } = await loadState();
  assert.equal(state.ccSessionId, undefined);
  assert.deepEqual(state.sessionHistory, [expiredRow]);
});
