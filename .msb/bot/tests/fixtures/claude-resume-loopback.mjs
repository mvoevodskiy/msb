/**
 * Native Claude resume conformance. Run in an offline disposable Linux container:
 * node .msb/bot/tests/fixtures/claude-resume-loopback.mjs /absolute/native/claude
 * [Runner](../../src/agent/turn.mjs) uses the actual PATH shim and a loopback model.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentTurn } from '../../src/agent/turn.mjs';
import { loadState, saveState } from '../../src/state.mjs';
import { readClaudeVersion } from '../../src/agent/claude-version.mjs';
import { sendClaudeFixtureReply } from './claude-loopback-reply.mjs';

const binary = process.argv[2];
assert.ok(path.isAbsolute(binary || ''), 'Pass the absolute native Claude CLI path');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-native-claude-resume-'));
const home = path.join(root, 'home');
const workspace = path.join(home, 'workspace');
const project = path.join(home, 'projects', 'alpha');
const wrapper = path.join(root, 'trace-claude');
const trace = path.join(root, 'native-trace');
const shim = fileURLToPath(new URL('../../../../overlay/bot/ext/shim/bin/', import.meta.url));
const expired = '6b800e2c-f9b1-4b97-bd36-202f96a75530';
const parkedCodex = 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53';
const oldRow = { id: expired, providerId: 'claude', engine: 'cc', messageCount: 4, project: 'alpha' };
const first = 'fixture exact request after missing session';
const second = 'fixture continue the recovered session';
const requests = [];

const server = http.createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const part of req) raw += part;
    if (req.url.includes('count_tokens')) return res.end('{"input_tokens":11}');
    if (!req.url.startsWith('/v1/messages')) {
      res.writeHead(404);
      return res.end('{}');
    }
    const body = JSON.parse(raw);
    const current = body.messages.flatMap(message => {
      if (message.role !== 'user') return [];
      return typeof message.content === 'string' ? [message.content] :
        message.content.filter(block => block.type === 'text').map(block => block.text);
    });
    requests.push(current.filter(text => text === first || text === second));
    return sendClaudeFixtureReply(res, body, 'msg_fixture_' + requests.length,
      { type: 'text', text: 'fixture native answer' }, 'end_turn');
  } catch {
    res.writeHead(500);
    res.end('{}');
  }
});
try {
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(wrapper, [
    '#!/bin/bash',
    'if [ "$1" != --version ]; then',
    '  resume=-',
    '  for arg in "$@"; do',
    '    if [ "$resume" = __next__ ]; then resume="$arg"; break; fi',
    '    if [ "$arg" = --resume ]; then resume=__next__; fi',
    '  done',
    '  printf "%s\\t%s\\n" "$resume" "$PWD" >> "$FIXTURE_TRACE"',
    'fi',
    'exec "$FIXTURE_NATIVE" "$@"',
    '',
  ].join('\n'), { mode: 0o700 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    HOME: home, PATH: shim + ':/usr/local/bin:/usr/bin:/bin', MSB_REAL_CLAUDE: wrapper,
    MSB_BOT_ID: 'default', MSB_RUNTIME_PROFILE: 'msb', MSB_RUNTIME_ROOT: path.join(home, '.msb'),
    MSB_WORKSPACE_DIR: workspace, FIXTURE_NATIVE: binary, FIXTURE_TRACE: trace,
    CLAUDE_CODE_OAUTH_TOKEN: 'fixture-loopback-only',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', CI: '1',
  });
  await saveState({
    engine: 'cc', authMode: 'subscription', hasSubscriptionAuth: true, ccModel: 'sonnet',
    permissionMode: 'acceptEdits', activeProject: 'alpha', ccSessionId: expired,
    sessionHistory: [oldRow], parkedCcSessions: { codex: parkedCodex },
  });
  const version = await readClaudeVersion();
  const output = await runAgentTurn({ prompt: first, signal: AbortSignal.timeout(20000) });
  assert.equal(output.ok, true);
  assert.equal(output.text, 'fixture native answer');
  const id = output.result.sessionId;
  assert.ok(id && id !== expired);
  assert.equal((await loadState()).state.ccSessionId, id);

  const next = await runAgentTurn({ prompt: second, signal: AbortSignal.timeout(20000) });
  assert.equal(next.ok, true);
  assert.equal(next.result.sessionId, id);
  assert.deepEqual(requests, [[first], [first, second]]);
  const launches = (await fs.readFile(trace, 'utf8')).trimEnd().split('\n').map(line => line.split('\t'));
  assert.deepEqual(launches, [[expired, project], ['-', project], [id, project]]);
  const { state } = await loadState();
  assert.deepEqual(state.sessionHistory[0], oldRow);
  assert.equal(state.sessionHistory[1].messageCount, 2);
  assert.equal(state.lastCcUsage.sessionId, id);
  assert.deepEqual(state.parkedCcSessions, { codex: parkedCodex });
  assert.equal(state.pendingCcSessionStarts, undefined);
  console.log(JSON.stringify({
    version, native_launches: launches.length, model_requests: requests.length,
    missing_resume_model_requests: 0, retry_same_project: true, resumed_same_new_id: true,
    original_input_and_context_preserved: true, expired_history_unchanged: true, codex_slot_unchanged: true,
  }));
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
