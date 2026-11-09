/** Optional native Claude conformance probe. Run only in an offline disposable Linux container.
 * Input: absolute native CLI path. The only API is the local synthetic server below.
 * [Production runner](../../src/autonomy/prompt-turn.mjs) and [contract](../reference/parity-autonomy-contract.txt).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { savedPromptPlan } from '../../src/autonomy/prompt-policy.mjs';
import { runSavedClaudePrompt } from '../../src/autonomy/prompt-turn.mjs';
import { saveState } from '../../src/state.mjs';

const nativeBin = process.argv[2];
assert.ok(path.isAbsolute(nativeBin || ''), 'Pass the absolute native Claude CLI path');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-isolated-native-'));
const home = path.join(root, 'home');
const bot = path.join(home, '.iia', 'bots', 'default');
const cwd = path.join(bot, 'autonomy', 'cc-workspace');
const secret = path.join(bot, '.env');
const protectedWrite = path.join(home, '.iia', 'bots', 'sibling', 'state.json');
const allowedWrite = path.join(cwd, 'result.txt');
const shell = path.join(cwd, 'shell.txt');
const mcp = path.join(cwd, 'mcp.txt');
const hook = path.join(cwd, 'hook.txt');
await fs.mkdir(cwd, { recursive: true });
await fs.mkdir(path.dirname(protectedWrite), { recursive: true });
const bin = path.join(root, 'bin');
await fs.mkdir(bin);
await fs.symlink(nativeBin, path.join(bin, 'claude'));
await fs.writeFile(secret, 'SYNTHETIC_PROTECTED_MARKER');
await fs.mkdir(path.join(home, '.claude'));
await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {
  SessionStart: [{ hooks: [{ type: 'command', command: 'touch ' + hook }] }],
} }));
await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {
  fixture: { command: '/bin/sh', args: ['-c', 'touch ' + mcp] },
} }));
const calls = [
  ['Read', { file_path: secret }],
  ['Write', { file_path: protectedWrite, content: 'should be denied' }],
  ['Write', { file_path: allowedWrite, content: 'owned fixture write' }],
  ['Bash', { command: 'touch ' + shell, description: 'Synthetic forbidden shell' }],
];
const advertised = new Set();
const results = new Map();
let sequence = 0;
let usedOAuth = true;
let modelRequests = 0;

function response(res, model, block, stopReason, stream) {
  const message = { id: 'msg_fixture_' + sequence, type: 'message', role: 'assistant', model, content: [block],
    stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
  if (!stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = (type, fields) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n');
  emit('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } });
  emit('content_block_start', { index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' } });
  emit('content_block_delta', { index: 0, delta: block.type === 'tool_use'
    ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
  emit('message_stop', {});
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const part of req) raw += part;
    if (req.url.includes('count_tokens')) { res.end('{"input_tokens":11}'); return; }
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(404); res.end('{}'); return; }
    const body = JSON.parse(raw);
    modelRequests++;
    usedOAuth &&= req.headers.authorization === 'Bearer fixture-local-oauth' && req.headers['x-api-key'] === undefined;
    if (!(body.tools?.length)) { response(res, body.model, { type: 'text', text: 'fixture' }, 'end_turn', body.stream); return; }
    for (const tool of body.tools) advertised.add(tool.name || tool.type);
    for (const message of body.messages) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) if (part.type === 'tool_result') results.set(part.tool_use_id, part);
    }
    const item = calls[sequence++];
    if (!item) { response(res, body.model, { type: 'text', text: 'completed native probe' }, 'end_turn', body.stream); return; }
    const [name, input] = item;
    response(res, body.model, { type: 'tool_use', id: 'toolu_fixture_' + sequence, name, input }, 'tool_use', body.stream);
  } catch {
    res.writeHead(500); res.end('{}');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
// Test the production runner with a synthetic OAuth token and a competing synthetic
// direct API key. Neither is a credential and the container has no external network.
Object.assign(process.env, { PATH: bin + ':/usr/local/bin:/usr/bin:/bin', HOME: home,
  MSB_RUNTIME_PROFILE: 'jar1', MSB_RUNTIME_ROOT: path.join(home, '.iia'), MSB_BOT_ID: 'default',
  ANTHROPIC_API_KEY: 'fixture-must-be-stripped', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-local-oauth',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', CI: '1' });
const state = { engine: 'cc', authMode: 'subscription', hasSubscriptionAuth: true, ccModel: 'opus',
  ccSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectId: 'fixture-owner' };
await saveState(state);
const stateFile = path.join(bot, 'state.json');
const before = await fs.readFile(stateFile);
const action = { id: 'probe', task: { kind: 'prompt', prompt: 'Synthetic isolated Claude probe' },
  capability: 'read', authority: { profile: 'standard' }, budget: { maxRunSeconds: 30 } };
const plan = savedPromptPlan(action, state);
const cancel = AbortSignal.timeout(10_000);
let outcome;
try {
  outcome = await runSavedClaudePrompt(action, plan, { signal: cancel, isCurrent: async () => true });
} finally {
  server.close();
}
assert.equal(outcome.status, 'ok', JSON.stringify({ status: outcome.status, error: outcome.error, sequence, advertised: [...advertised] }));
assert.ok(usedOAuth && modelRequests > 0);
assert.deepEqual(await fs.readFile(stateFile), before);
assert.ok(advertised.has('Read') && advertised.has('Write'));
assert.ok(!advertised.has('Bash') && ![...advertised].some(tool => tool?.startsWith('mcp__')));
assert.equal(await fs.readFile(allowedWrite, 'utf8'), 'owned fixture write');
for (const file of [protectedWrite, shell, mcp, hook]) await assert.rejects(fs.stat(file), { code: 'ENOENT' });
assert.ok(!JSON.stringify([...results.values()]).includes('SYNTHETIC_PROTECTED_MARKER'));
assert.equal(results.get('toolu_fixture_1')?.is_error, true);
assert.equal(results.get('toolu_fixture_2')?.is_error, true);
const projects = path.join(home, '.claude', 'projects');
const paths = await fs.readdir(projects, { recursive: true }).catch(() => []);
assert.ok(!paths.some(name => name.endsWith('.jsonl')));
console.log(JSON.stringify({ passed: true, permittedWrite: true, protectedReadAndWriteDenied: true,
  shellNotAdvertisedOrExecuted: true, mcpNotStarted: true, userHookNotStarted: true, nativeSessionNotPersisted: true,
  usedSyntheticOAuth: true, ownerStateUnchanged: true, attemptedToolCalls: calls.length }));
