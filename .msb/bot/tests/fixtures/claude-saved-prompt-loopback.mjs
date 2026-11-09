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
import { runSavedPrompt } from '../../src/autonomy/prompt-turn.mjs';
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
const allowedNotebook = path.join(cwd, 'allowed.ipynb');
const sessions = path.join(bot, 'sessions');
const realSessions = path.join(home, 'fixture physical sessions');
const sessionAlias = path.join(cwd, 'session-alias');
const protectedNotebook = path.join(realSessions, 'protected.ipynb');
const aliasWrite = path.join(sessionAlias, 'forbidden.txt');
const physicalWrite = path.join(realSessions, 'forbidden-direct.txt');
const shell = path.join(cwd, 'shell.txt');
const mcp = path.join(cwd, 'mcp.txt');
const hook = path.join(cwd, 'hook.txt');
await fs.mkdir(cwd, { recursive: true });
await fs.mkdir(path.dirname(protectedWrite), { recursive: true });
await fs.mkdir(realSessions);
await fs.symlink(realSessions, sessions);
await fs.symlink(sessions, sessionAlias);
const notebook = JSON.stringify({
  cells: [{ id: 'fixture-cell', cell_type: 'code', metadata: {}, source: ['old notebook'], outputs: [], execution_count: null }],
  metadata: {}, nbformat: 4, nbformat_minor: 5,
});
await fs.writeFile(protectedNotebook, notebook);
await fs.writeFile(allowedNotebook, notebook);
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
const notebookChange = { cell_id: 'fixture-cell', edit_mode: 'replace', new_source: 'new notebook' };
const calls = [
  ['Read', { file_path: secret }, false],
  ['Write', { file_path: protectedWrite, content: 'should be denied' }, false],
  ['Write', { file_path: secret, content: 'should be denied' }, false],
  ['Edit', { file_path: secret, old_string: 'SYNTHETIC_PROTECTED_MARKER', new_string: 'should be denied' }, false],
  ['Read', { file_path: path.join(sessionAlias, 'protected.ipynb') }, false],
  ['Write', { file_path: aliasWrite, content: 'should be denied' }, false],
  ['Write', { file_path: physicalWrite, content: 'should be denied' }, false],
  ['NotebookEdit', { notebook_path: protectedNotebook, ...notebookChange }, false],
  ['Write', { file_path: allowedWrite, content: 'owned fixture write' }, true],
  ['Read', { file_path: allowedWrite }, true],
  ['Edit', { file_path: allowedWrite, old_string: 'fixture write', new_string: 'fixture edit' }, true],
  ['Read', { file_path: allowedNotebook }, true],
  ['NotebookEdit', { notebook_path: allowedNotebook, ...notebookChange }, true],
  ['Bash', { command: 'touch ' + shell, description: 'Synthetic forbidden shell' }, false],
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
  capability: 'read', authority: { profile: 'standard' }, budget: { maxRunSeconds: 75 } };
const plan = savedPromptPlan(action, state);
const cancel = AbortSignal.timeout(50_000);
let outcome;
try {
  outcome = await runSavedPrompt(action, plan, { signal: cancel, isCurrent: async () => true });
} finally {
  server.close();
}
assert.equal(outcome.status, 'ok', JSON.stringify({ status: outcome.status, error: outcome.error, sequence, advertised: [...advertised] }));
assert.ok(usedOAuth && modelRequests > 0);
assert.deepEqual(await fs.readFile(stateFile), before);
for (const tool of ['Read', 'Write', 'Edit']) assert.ok(advertised.has(tool), 'Missing control tool ' + tool);
// A newer CLI may defer NotebookEdit. Its actual result and file are checked below.
assert.ok(!advertised.has('Bash') && ![...advertised].some(tool => tool?.startsWith('mcp__')));
for (const [index, [name, , allowed]] of calls.entries()) {
  const result = results.get('toolu_fixture_' + (index + 1));
  assert.ok(result, 'Missing result ' + (index + 1) + ' ' + name);
  assert.equal(result.is_error !== true, allowed, 'Unexpected result ' + (index + 1) + ' ' + name + ': ' + JSON.stringify(result.content));
}
assert.equal(await fs.readFile(allowedWrite, 'utf8'), 'owned fixture edit');
const edited = JSON.parse(await fs.readFile(allowedNotebook, 'utf8'));
const updatedCell = edited.cells[0].source;
assert.equal(Array.isArray(updatedCell) ? updatedCell.join('') : updatedCell, 'new notebook');
for (const file of [protectedWrite, aliasWrite, physicalWrite, shell, mcp, hook]) {
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
}
assert.equal(await fs.readFile(secret, 'utf8'), 'SYNTHETIC_PROTECTED_MARKER');
assert.equal(await fs.readFile(protectedNotebook, 'utf8'), notebook);
const readBack = results.get('toolu_fixture_1');
assert.ok(!JSON.stringify(readBack).includes('SYNTHETIC_PROTECTED_MARKER'));
const projects = path.join(home, '.claude', 'projects');
const paths = await fs.readdir(projects, { recursive: true }).catch(() => []);
assert.ok(!paths.some(name => name.endsWith('.jsonl')));
console.log(JSON.stringify({ passed: true, permittedWrite: true, permittedEditAndNotebookEdit: true,
  notebookEditAdvertised: advertised.has('NotebookEdit'),
  protectedReadAndWriteDenied: true, protectedEditAndNotebookEditDenied: true,
  protectedDirectoryAliasAndPhysicalWriteDenied: true, protectedFilesByteExact: true,
  shellNotAdvertisedOrExecuted: true, mcpNotStarted: true, userHookNotStarted: true, nativeSessionNotPersisted: true,
  usedSyntheticOAuth: true, ownerStateUnchanged: true, attemptedToolCalls: calls.length }));
