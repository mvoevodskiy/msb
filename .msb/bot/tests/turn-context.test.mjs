import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { invalidateFirstSession } from '../shared/session-starts.mjs';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { formatTurnFooter } from '../src/telegram/response.mjs';
import { saveState, loadState, updateState } from '../src/state.mjs';
const id = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const sessionId = `ext:codex:${id}`;

test('real core spawn persists measured context, preserves failures and honors reset during first turn', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-turn-'));
  const prior = { ...process.env };
  t.after(async () => {
    for (const key of ['PATH', 'MSB_WORKSPACE_DIR', 'FIXTURE_CORE_MODE', 'FIXTURE_CORE_HOME']) {
      if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
    }
    await fs.rm(home, { recursive: true, force: true });
  });
  const env = { HOME: home };
  await fs.mkdir(path.join(home, 'bin'));
  const sessions = path.join(home, '.codex/sessions/2026/11/05');
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, `rollout-test-${id}.jsonl`), JSON.stringify({ type: 'event_msg', payload: {
    type: 'token_count', info: { last_token_usage: { total_tokens: 71142 }, total_token_usage: { total_tokens: 1800000 }, model_context_window: 475000 },
  } }) + '\n');
  await fs.writeFile(path.join(home, 'bin/claude'), `#!${process.execPath}
const fs = require('node:fs');
const emit=(x)=>console.log(JSON.stringify(x));
process.stdin.resume();
process.stdin.on('end', async () => {
 const fail=process.env.FIXTURE_CORE_MODE==='fail';
 const sid=fail?'ext:codex:norestart':'${sessionId}';
 emit({type:'system',subtype:'init',provider_id:'codex',apiKeySource:'ext',session_id:sid,model:'gpt-6.1-terra'});
 if(process.env.FIXTURE_CORE_MODE==='reset') {
  for(let i=0;i<100&&!fs.existsSync(process.env.FIXTURE_CORE_HOME+'/release');i++) await new Promise(r=>setTimeout(r,10));
 }
 emit({type:'result',subtype:fail?'error':'success',session_id:sid,is_error:fail,result:'fixture',usage:{input_tokens:1000,cache_read_input_tokens:1799000,output_tokens:5}});
});
`, { mode: 0o755 });
  process.env.PATH = path.join(home, 'bin') + ':' + prior.PATH;
  process.env.MSB_WORKSPACE_DIR = home;
  process.env.FIXTURE_CORE_HOME = home;
  await saveState({ extAuthBypass: 'codex' }, env);
  process.env.FIXTURE_CORE_MODE = 'reset';
  let reset;
  const resetResult = await runAgentTurn({ prompt: 'fixture', env, onStatus(ev) {
    if (ev.kind === 'init') reset = updateState((s) => { invalidateFirstSession(s); delete s.ccSessionId; s.sessionEpoch = 1; return s; }, env)
      .then(() => fs.writeFile(path.join(home, 'release'), 'ready'));
  } });
  await reset;
  assert.equal(resetResult.result.context, null);
  assert.equal((await loadState(env)).state.ccSessionId, undefined);
  process.env.FIXTURE_CORE_MODE = 'success';
  const result = await runAgentTurn({ prompt: 'fixture', env });
  assert.equal(result.ok, true);
  assert.equal(result.result.usage.inputTokens + result.result.usage.cacheReadTokens, 1800000);
  assert.equal(result.result.context.contextTokens, 71142);
  const state = (await loadState(env)).state;
  assert.equal(state.ccSessionId, sessionId);
  assert.equal(state.lastCcUsage.contextTokens, 71142);
  assert.equal(state.lastCcUsage.contextWindow, 475000);
  process.env.FIXTURE_CORE_MODE = 'fail';
  assert.equal((await runAgentTurn({ prompt: 'fixture', env })).ok, false);
  assert.deepEqual((await loadState(env)).state, state);
});

test('Codex uses the launched project profile for normal and partial footers even if CODEX_HOME changes', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-turn-project-context-'));
  const previous = process.cwd();
  const prior = { ...process.env };
  const keys = ['HOME', 'PATH', 'CODEX_HOME', 'MSB_WORKSPACE_DIR', 'FIXTURE_PROFILE_MODE'];
  t.after(async () => {
    process.chdir(previous);
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
    }
    await fs.rm(home, { recursive: true, force: true });
  });
  const workspace = path.join(home, 'workspace'), project = path.join(home, 'projects', 'alpha');
  const bin = path.join(home, 'bin');
  const env = { HOME: home, MSB_WORKSPACE_DIR: workspace, CODEX_HOME: 'native-profile' };
  const sample = total_tokens => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count',
    info: { last_token_usage: { total_tokens }, model_context_window: 100000 } } }) + '\n';
  const profileFile = (cwd, profile) => path.join(cwd, profile, 'sessions', 'rollout-fixture-' + id + '.jsonl');
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  for (const [cwd, profile, tokens] of [[workspace, 'native-profile', 98000],
    [workspace, 'other-profile', 99000], [project, 'other-profile', 97000]]) {
    const file = profileFile(cwd, profile);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, sample(tokens));
  }
  const source = [
    '#!' + process.execPath,
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const id = ' + JSON.stringify(id) + ';',
    "const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');",
    "process.stdin.resume();",
    "process.stdin.once('end', () => {",
    " const partial = process.env.FIXTURE_PROFILE_MODE === 'partial';",
    " const timestamp = new Date().toISOString();",
    " const dir = path.resolve(process.env.CODEX_HOME, 'sessions');",
    " fs.mkdirSync(dir, { recursive: true });",
    " const start = { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: 'fixture-profile-turn' } };",
    " const sample = { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { model_context_window: 100000, last_token_usage: { total_tokens: partial ? 52000 : 18000 } } } };",
    " fs.appendFileSync(path.join(dir, 'rollout-fixture-' + id + '.jsonl'), [start, sample].map(row => JSON.stringify(row) + '\\n').join(''));",
    " emit({ type: 'system', subtype: 'init', provider_id: 'codex', session_id: 'ext:codex:' + id });",
    " emit({ type: 'result', subtype: partial ? 'error_partial' : 'success', is_error: partial, session_id: 'ext:codex:' + id, result: 'project fixture' });",
    " if (partial) process.exitCode = 1;",
    '});',
  ].join('\n');
  await fs.writeFile(path.join(bin, 'claude'), source, { mode: 0o755 });
  Object.assign(process.env, env, { PATH: bin + ':' + path.dirname(process.execPath) + ':/usr/bin:/bin' });
  process.chdir(workspace);
  await saveState({ engine: 'cc', extAuthBypass: 'codex', activeProject: 'alpha' }, env);
  const run = async mode => {
    process.env.FIXTURE_PROFILE_MODE = mode;
    env.CODEX_HOME = process.env.CODEX_HOME = 'native-profile';
    return runAgentTurn({ prompt: 'relative native profile', env, onStatus(event) {
      if (event.kind === 'init') env.CODEX_HOME = process.env.CODEX_HOME = 'other-profile';
    } });
  };
  const first = await run('success');
  assert.equal(first.ok, true);
  assert.equal(first.result.context?.contextTokens, 18000);
  assert.match(formatTurnFooter({ elapsedMs: 1700, context: first.result.context }), /○○○ 18%/);
  const before = (await loadState(env)).state;
  assert.equal(before.lastCcUsage.contextTokens, 18000);
  const partial = await run('partial');
  assert.equal(partial.ok, false);
  assert.equal(partial.result.context, null);
  assert.equal(partial.partialReply.context?.contextTokens, 52000);
  assert.match(formatTurnFooter({ elapsedMs: 1700, context: partial.partialReply.context }), /●●○ 52%/);
  assert.deepEqual((await loadState(env)).state.lastCcUsage, before.lastCcUsage);
});
