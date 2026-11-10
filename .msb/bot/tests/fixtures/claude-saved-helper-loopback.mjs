/**
 * [Saved runner](../../src/autonomy/prompt-turn.mjs) with a real Linux Claude CLI
 * and local synthetic API. Run in network-none Docker. Pass the native
 * executable and standard, narrow, disabled or legacy. [Proof](../reference/parity-autonomy-contract.txt).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { savedPromptPlan } from '../../src/autonomy/prompt-policy.mjs';
import { runSavedPrompt } from '../../src/autonomy/prompt-turn.mjs';
import { saveState } from '../../src/state.mjs';
import { sendClaudeFixtureReply } from './claude-loopback-reply.mjs';

const [binary, name] = process.argv.slice(2);
const scenarios = {
  standard: { role: 'worker', profile: 'standard', capability: 'read', allowWrite: true },
  narrow: { role: 'researcher', profile: 'narrow', capability: 'none', helpers: true, allowWrite: false },
  disabled: { role: 'worker', profile: 'standard', capability: 'read', helpers: false, allowWrite: false },
  legacy: { role: 'general-purpose', profile: 'narrow', capability: 'none', allowWrite: false },
};
assert.ok(path.isAbsolute(binary || '') && Object.hasOwn(scenarios, name), 'Pass a native binary and scenario');
const { role, profile: posture, capability, helpers, allowWrite } = scenarios[name];
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-helper-proof-'));
const home = path.join(root, 'home');
const profile = path.join(home, '.iia', 'bots', 'default');
const workspace = path.join(profile, 'autonomy', 'cc-workspace');
const bin = path.join(root, 'bin');
const secret = path.join(profile, '.env');
const forbidden = path.join(profile, 'sessions', 'blocked.txt');
const allowed = path.join(workspace, 'allowed.txt');
const childWrite = path.join(workspace, 'child.txt');
const childShell = path.join(workspace, 'shell.txt');
const childPrompt = 'CLAUDE_HELPER_CHILD_ONLY_9477';
const childDone = 'fixture child completed';
const parentDone = 'fixture parent completed';
const ownerSecret = 'SYNTHETIC_HELPER_PROTECTED';
const auth = 'fixture-oauth-helper';
const calls = [
  ['Read', { file_path: allowed }, true],
  ['Write', { file_path: childWrite, content: 'helper output' }, allowWrite],
  ['Read', { file_path: secret }, false],
  ['Write', { file_path: forbidden, content: 'blocked' }, false],
  ['Bash', { command: 'touch ' + childShell, description: 'forbidden fixture shell' }, false],
];
const inventory = { parent: new Set(), child: new Set() };
const results = new Map();
const bodyParts = message => typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
let sequence = 0, childRequests = 0, parentRequests = 0, failure;
function reply(res, body, block, reason) {
  return sendClaudeFixtureReply(res, body, 'msg_fixture_' + sequence++, block, reason);
}

const server = http.createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url.includes('count_tokens')) return res.end('{"input_tokens":11}');
    if (!req.url.startsWith('/v1/messages')) return res.writeHead(404).end('{}');
    const body = JSON.parse(raw);
    assert.equal(req.headers.authorization, 'Bearer ' + auth);
    assert.equal(req.headers['x-api-key'], undefined);
    if (!body.tools?.length) return reply(res, body, { type: 'text', text: 'fixture auxiliary' }, 'end_turn');
    // Claude starts a separate request with the delegated text. Parent
    // messages may contain the child prompt inside a tool call, not as text.
    const child = body.messages.some(message => message.role === 'user' && bodyParts(message)
      .some(part => part.type === 'text' && part.text?.includes(childPrompt)));
    for (const tool of body.tools) inventory[child ? 'child' : 'parent'].add(tool.name ?? tool.type);
    for (const message of body.messages) {
      for (const part of bodyParts(message)) if (part.type === 'tool_result') results.set(part.tool_use_id, part);
    }
    if (child) {
      childRequests++;
      const index = calls.findIndex((_, position) => !results.has('toolu_child_' + position));
      if (index < 0) return reply(res, body, { type: 'text', text: childDone }, 'end_turn');
      const [tool, input] = calls[index];
      return reply(res, body, { type: 'tool_use', id: 'toolu_child_' + index, name: tool, input }, 'tool_use');
    }
    parentRequests++;
    if (results.has('toolu_parent_agent')) return reply(res, body, { type: 'text', text: parentDone }, 'end_turn');
    const input = { description: 'Fixture child work', prompt: childPrompt, subagent_type: role };
    const agent = body.tools.find(tool => tool.name === 'Agent' || tool.name === 'Task');
    if (agent?.input_schema?.properties?.run_in_background) input.run_in_background = false;
    return reply(res, body, { type: 'tool_use', id: 'toolu_parent_agent', name: agent?.name ?? 'Agent', input }, 'tool_use');
  } catch (error) {
    failure = error;
    res.writeHead(500).end('{}');
  }
});

try {
  await Promise.all([workspace, bin, path.dirname(forbidden)].map(dir => fs.mkdir(dir, { recursive: true })));
  await fs.symlink(binary, path.join(bin, 'claude'));
  await fs.writeFile(allowed, 'fixture ordinary input');
  await fs.writeFile(secret, ownerSecret);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, { HOME: home, PATH: bin + ':/usr/local/bin:/usr/bin:/bin', MSB_REAL_CLAUDE: binary,
    MSB_RUNTIME_PROFILE: 'jar1', MSB_RUNTIME_ROOT: path.join(home, '.iia'), MSB_BOT_ID: 'default',
    CLAUDE_CODE_OAUTH_TOKEN: auth, ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', CI: '1' });
  const state = { engine: 'cc', authMode: 'subscription', hasSubscriptionAuth: true, ccModel: 'opus',
    ccSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  const stateFile = await saveState(state);
  const stateBefore = await fs.readFile(stateFile);
  const action = { id: 'fixture', task: { kind: 'prompt', prompt: 'fixture parent work',
    ...(helpers === undefined ? {} : { helpers }) }, capability,
  authority: { profile: posture }, budget: { maxRunSeconds: 75 } };
  const result = await runSavedPrompt(action, savedPromptPlan(action, state), {
    signal: AbortSignal.timeout(50_000), isCurrent: async () => true,
  });
  if (failure) throw failure;
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.match(result.text, /fixture parent completed/);
  assert.ok(parentRequests >= 2);
  const agentResult = results.get('toolu_parent_agent');
  assert.ok(agentResult, 'No Agent result');
  const enabled = helpers !== false;
  // Native 2.1.316 reports 22 parent input tokens and a terminal helper total of 16.
  const expectedTokensIn = enabled && name !== 'legacy' ? 38 : 22;
  assert.equal(result.tokensIn, expectedTokensIn);
  if (enabled) {
    assert.notEqual(agentResult.is_error, true, JSON.stringify(agentResult.content));
    assert.ok(childRequests >= calls.length + 1);
    assert.match(JSON.stringify(agentResult.content), /fixture child completed/);
    for (const [index, [tool, , permitted]] of calls.entries()) {
      const observed = results.get('toolu_child_' + index);
      assert.ok(observed, 'Missing child result for ' + tool);
      assert.equal(observed.is_error !== true, permitted, JSON.stringify(observed.content));
    }
    assert.match(JSON.stringify(results.get('toolu_child_0')?.content), /fixture ordinary input/);
  } else {
    assert.equal(agentResult.is_error, true);
    assert.equal(childRequests, 0);
    assert.ok(!inventory.parent.has('Agent') && !inventory.parent.has('Task'));
  }
  assert.ok(!inventory.child.has('Bash'));
  assert.ok(!JSON.stringify([...results.values()]).includes(ownerSecret));
  assert.equal(await fs.readFile(secret, 'utf8'), ownerSecret);
  assert.deepEqual(await fs.readFile(stateFile), stateBefore);
  for (const file of [forbidden, childShell]) await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  if (allowWrite) assert.equal(await fs.readFile(childWrite, 'utf8'), 'helper output');
  else await assert.rejects(fs.stat(childWrite), { code: 'ENOENT' });
  console.log(JSON.stringify({ passed: true, scenario: name, role, enabled, childRequests, parentRequests,
    childReadAllowed: enabled, childWriteAllowed: allowWrite, protectedProfileByteExact: true,
    shellUnavailable: true, expectedTokensIn, observedTokensIn: result.tokensIn,
    tools: Object.fromEntries(Object.entries(inventory).map(([side, tools]) => [side, [...tools].sort()])) }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
