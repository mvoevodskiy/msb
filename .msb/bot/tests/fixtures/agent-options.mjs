// Production runAgentTurn → runClaudeTurn argv/prompt, fake child and isolated HOME.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
const [provider, mode, model = 'opus', effort = 'high', cliVersion = '2.1.154', envDescription] = process.argv.slice(2);
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-agent-options-'));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { HOME: home, MSB_BOT_ID: 'default', MSB_WORKSPACE_DIR: home,
  MSB_SESSION_DIR: path.join(home, 'sessions'), PATH: path.dirname(process.execPath), CLAUDE_CODE_OAUTH_TOKEN: 'fixture-only' });
const { fixtureClaudeVersion } = await import('../helpers/claude-version-fixture.mjs');
await fixtureClaudeVersion(home, cliVersion);
const calls = [];
cp.spawn = (command, args, options) => {
  if (command !== 'claude' || options.env.HOME !== home) throw Error('Unexpected CLI');
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => true;
  const call = { args, provider: options.env.MSB_TURN_PROVIDER, prompt: '' }; calls.push(call);
  child.stdin.on('data', value => { call.prompt += value; });
  child.stdin.on('finish', () => queueMicrotask(() => {
    const id = provider === 'claude' ? 'claude-options-fixture' : 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53';
    child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: id, model, provider_id: provider }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: id, result: 'fixture options answer', is_error: false }) + '\n');
    child.stdout.end(); child.stderr.end(); child.emit('close', 0, null);
  }));
  return child;
};
syncBuiltinESMExports();
globalThis.fetch = () => { throw Error('External network forbidden'); };
try {
  const { saveState, loadState } = await import('../../src/state.mjs');
  const { runAgentTurn } = await import('../../src/agent/turn.mjs');
  await saveState({ engine: 'cc', ccModel: model, ccEffort: effort, permissionMode: mode,
    authMode: 'subscription', hasSubscriptionAuth: true, ...(provider === 'claude' ? {} : { extAuthBypass: provider }) });
  if (envDescription === 'env-description') {
    const { setEnvKey } = await import('../../src/env/store.mjs');
    await setEnvKey('FIXTURE_CUSTOM_API', 'fixture-env-description-value-79f1', process.env, {comment:'fixture custom description'});
  }
  const out = await runAgentTurn({ prompt: 'synthetic options task' });
  console.log('AGENT_OPTIONS=' + JSON.stringify({ ok: out.ok, calls, state: (await loadState()).state }));
} finally { await fs.rm(home, { recursive: true, force: true }); }
