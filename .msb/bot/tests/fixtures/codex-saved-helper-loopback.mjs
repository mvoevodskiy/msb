/**
 * The [saved Codex adapter](../../../../overlay/bot/ext/adapters/saved-codex.mjs)
 * with real Linux Codex and a synthetic Responses service. The named case starts in
 * the [core runner](../../src/autonomy/prompt-turn.mjs). Run in network-none
 * Docker as described by [the saved task contract](../reference/parity-autonomy-contract.txt).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runSavedCodexPrompt } from '../../../../overlay/bot/ext/adapters/saved-codex.mjs';
import { savedPromptPlan } from '../../src/autonomy/prompt-policy.mjs';
import { runSavedPrompt } from '../../src/autonomy/prompt-turn.mjs';
import { saveState } from '../../src/state.mjs';

const binary = process.argv[2];
assert.ok(path.isAbsolute(binary));
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'msb-native-helper-check-')));
const home = path.join(root, 'home'), native = path.join(root, 'native');
const cwd = path.join(home, '.iia', 'bots', 'default', 'autonomy', 'cc-workspace');
const bin = path.join(root, 'bin'), auth = path.join(native, 'auth.json');
const role = path.join(native, 'agents', 'fixture_override.toml');
const rollout = path.join(native, 'sessions', 'old-rollout.jsonl');
const config = path.join(native, 'config.toml');
const marker = 'fixture old conversation';
const access = 'native-helper-test-auth';
const idToken = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' },
})).toString('base64url') + '.fixture';
const image = path.join(native, 'protected.png');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfKcAAAAASUVORK5CYII=';
const helperReply = 'fixture helper completed';
const parentReply = 'fixture parent completed';
const scope = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Agent', 'Task'];
const namedRole = { name: 'Проверяющий', brief: 'Сверяет заметки и сообщает факт.' };
const namedBrief = namedRole.name + ': ' + namedRole.brief;
const cases = ['reader', 'writer', 'attachment', 'role', 'disabled', 'cancel', 'named'];
const counts = {};
let state, failure, accounting, sequence = 0;

const message = text => ({ id: 'msg_' + sequence, type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }] });

function callResult(input, id) {
  return JSON.stringify(input.input.find(item => item.type === 'function_call_output' && item.call_id === id)?.output);
}

function parentItem(input, tools, call, step) {
  if (state.kind === 'disabled') {
    assert.equal(tools.some(tool => tool.namespace === 'collaboration' || tool.name === 'spawn_agent'), false);
    return message(parentReply);
  }
  if (step === 0) {
    const tool = tools.find(row => row.name === 'spawn_agent');
    assert.equal(tool?.namespace, 'collaboration');
    assert.equal(Object.hasOwn(tool.parameters.properties, 'items'), false);
    const args = { task_name: 'fixture_helper', message: 'Carry out the scoped fixture work.', fork_turns: 'none' };
    if (state.kind === 'named') {
      const prompt = JSON.stringify(input.input);
      assert.ok(prompt.includes('- ' + namedBrief));
      assert.ok(prompt.includes('spawn_agent') && prompt.includes('wait_agent'));
      args.message = namedBrief + ' Прочитай visible.txt.';
    }
    if (state.kind === 'attachment') args.items = [{ type: 'local_image', path: image }];
    if (state.kind === 'role') args.agent_type = 'fixture_override';
    return call('spawn_agent', args);
  }
  if (step === 1) {
    const result = callResult(input, 'parent0');
    if (state.kind === 'attachment') {
      assert.match(result, /unknown field .*items/);
      return message(parentReply);
    }
    if (state.kind === 'role' && !result?.includes('/root/fixture_helper')) {
      assert.match(result, /agent.?type|role|config|unknown|unsupported/i);
      state.roleRejected = true;
      return message(parentReply);
    }
    assert.match(result, /\/root\/fixture_helper/);
  }
  if (JSON.stringify(input.input).includes(helperReply)) return message(parentReply);
  assert.ok(step < 6, 'The child completion did not reach the parent');
  return call('wait_agent', { timeout_ms: 25_000 });
}

function childItem(input, call, step) {
  if (state.kind === 'writer') {
    if (step === 0) return call('write_file', { path: 'helper.txt', text: 'written by the scoped helper' });
    assert.match(callResult(input, 'child0'), /helper\.txt/);
    return message(helperReply);
  }
  if (step === 0) return call('read_file', { path: 'visible.txt' });
  if (step === 1) {
    assert.match(callResult(input, 'child0'), /ordinary fixture text/);
    return call('read_file', { path: 'alias.txt' });
  }
  assert.match(callResult(input, 'child1'), /Доступ к пути запрещён/);
  return message(helperReply);
}

const service = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/responses') return res.writeHead(404).end();
  try {
    assert.equal(req.headers.authorization, 'Bearer ' + access);
    let raw = '';
    for await (const data of req) raw += data;
    assert.equal(raw.includes(marker), false);
    assert.equal(raw.includes(png), false);
    const input = JSON.parse(raw);
    const thread = req.headers['thread-id'];
    assert.ok(thread);
    state.parent ??= thread;
    const parent = state.parent === thread;
    const step = state.requests.get(thread) || 0;
    state.requests.set(thread, step + 1);
    const tools = (input.tools || []).flatMap(tool => tool.type === 'namespace'
      ? tool.tools.map(entry => ({ ...entry, namespace: tool.name })) : [tool]);
    const names = tools.map(tool => tool.name || tool.type);
    assert.equal(names.some(name => /exec_command|write_stdin|apply_patch|view_image|resume_agent|foreign/.test(name)), false);
    for (const tool of tools.filter(tool => tool.namespace === 'collaboration')) {
      assert.equal(Object.keys(tool.parameters.properties).some(key => ['items', 'image_url', 'audio_url'].includes(key)), false);
    }
    if (!parent) {
      assert.notEqual(state.kind, 'attachment', 'A local attachment request must not spawn a child');
      assert.equal(names.includes('write_file'), state.kind === 'writer');
      assert.ok(names.includes('read_file'));
      assert.equal(input.model, 'gpt-5.4');
      if (state.kind === 'named' && step === 0) {
        assert.ok(input.input.some(item => item.role === 'user' && JSON.stringify(item).includes(namedBrief)),
          'The saved role brief reaches the isolated native child');
        state.namedBriefReceived = true;
      }
      if (state.kind === 'cancel') {
        res.once('close', () => { state.childClosed = true; });
        state.activeChild = true;
        state.stop.abort();
        return;
      }
    }
    const side = parent ? 'parent' : 'child';
    const call = (name, args) => {
      const tool = tools.find(row => row.name?.endsWith(name));
      assert.ok(tool, name + ' must be available on ' + side);
      return { id: 'fc_' + sequence, type: 'function_call', name: tool.name, arguments: JSON.stringify(args),
        ...(tool.namespace ? { namespace: tool.namespace } : {}), call_id: side + step, status: 'completed' };
    };
    const item = parent ? parentItem(input, tools, call, step) : childItem(input, call, step);
    const response = { id: 'resp_' + sequence++, created_at: 1, model: input.model, status: 'completed', output: [item] };
    if (state.kind === 'reader') {
      const inputTokens = parent ? 7 : 29;
      response.usage = { input_tokens: inputTokens, input_tokens_details: { cached_tokens: 0 },
        output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: inputTokens + 2 };
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [type, fields] of [
      ['response.created', { response: { ...response, status: 'in_progress', output: [] } }],
      ['response.output_item.done', { output_index: 0, item }],
      ['response.completed', { response }],
    ]) res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n');
    res.end();
  } catch (error) {
    failure = error;
    res.writeHead(500).end();
  }
});

try {
  await Promise.all([cwd, bin, path.dirname(role), path.dirname(rollout)]
    .map(dir => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
  await fs.symlink(binary, path.join(bin, 'codex'));
  await fs.symlink(auth, path.join(cwd, 'alias.txt'));
  await fs.writeFile(path.join(cwd, 'visible.txt'), 'ordinary fixture text');
  await fs.writeFile(image, Buffer.from(png, 'base64'));
  await fs.writeFile(rollout, marker);
  await fs.writeFile(role, 'name = "fixture_override"\ndescription = "Attempted scope widening"\n' +
    'developer_instructions = "Fixture role"\n[features]\nshell_tool = true\nview_image = true\n');
  await fs.writeFile(auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    id_token: idToken, access_token: access, refresh_token: 'fixture-refresh', account_id: 'fixture-account',
  }, last_refresh: new Date().toISOString() }), { mode: 0o600 });
  await fs.writeFile(config, 'model = "gpt-5.4"\n[features]\nmulti_agent = true\nmulti_agent_v2 = true\n');
  const env = { HOME: home, CODEX_HOME: native, PATH: bin + path.delimiter + process.env.PATH,
    MSB_RUNTIME_PROFILE: 'jar1', MSB_RUNTIME_ROOT: path.join(home, '.iia'), MSB_BOT_ID: 'default' };
  const savedState = { engine: 'cc', authMode: 'subscription', hasSubscriptionAuth: true, extAuthBypass: 'codex' };
  const stateFile = await saveState(savedState, env);
  const protectedFiles = [auth, role, rollout, image, config, stateFile];
  const before = await Promise.all(protectedFiles.map(file => fs.readFile(file)));
  await new Promise((resolve, reject) => { service.once('error', reject); service.listen(0, '127.0.0.1', resolve); });
  const baseUrl = 'http://127.0.0.1:' + service.address().port + '/v1';
  for (const kind of cases) {
    state = { kind, requests: new Map(), stop: new AbortController() };
    let tools = scope;
    if (kind === 'writer') tools = [...scope, 'Write', 'Edit'];
    if (kind === 'disabled') tools = scope.filter(tool => tool !== 'Agent' && tool !== 'Task');
    const signal = AbortSignal.any([state.stop.signal, AbortSignal.timeout(85_000)]);
    if (kind === 'named') {
      const action = { id: 'named', task: { kind: 'prompt', prompt: 'Run the saved team fixture.',
        model: 'gpt-5.4', team: [namedRole] }, capability: 'none', authority: { profile: 'narrow' } };
      const plan = savedPromptPlan(action, savedState, env, true);
      const result = await runSavedPrompt(action, plan, { signal, isCurrent: async () => true,
        runCodexPrompt: (options, env) => runSavedCodexPrompt(options, env, { baseUrl }) }, env);
      if (failure) throw failure;
      assert.equal(result.status, 'ok', JSON.stringify(result));
      assert.equal(result.text, parentReply);
      assert.equal(state.namedBriefReceived, true);
      assert.equal(state.requests.size, 2);
      counts[kind] = state.requests.size;
      continue;
    }
    const result = await runSavedCodexPrompt({ cwd, prompt: 'Run the saved helper fixture.', model: 'gpt-5.4',
      tools, directories: [home, os.tmpdir()], denied: [], signal, canLaunch: async () => true }, env, { baseUrl });
    if (failure) throw failure;
    counts[kind] = state.requests.size;
    if (kind === 'reader') {
      const parentRequests = state.requests.get(state.parent);
      const helperRequests = [...state.requests.values()].reduce((total, count) => total + count, 0) - parentRequests;
      const helperTotal = helperRequests * (29 + 2);
      const reported = result.usage.inputTokens + result.usage.cacheReadTokens + (result.helperTokens ?? 0);
      assert.equal(reported, parentRequests * 7 + helperTotal, 'Saved usage must include the entire helper cost');
      assert.equal(result.usage.outputTokens, parentRequests * 2);
      assert.equal(result.usageIncomplete, undefined);
      accounting = { parent_input_tokens: parentRequests * 7, helper_input_tokens: helperRequests * 29,
        helper_total_tokens: helperTotal, reported_input_tokens: reported, helper_tokens_included: true };
    }
    if (kind === 'cancel') {
      assert.equal(state.activeChild, true);
      assert.equal(result?.isError, true);
      for (let tries = 0; tries < 50 && !state.childClosed; tries++) await delay(20);
      assert.equal(state.childClosed, true, 'The child HTTP turn must close when its parent is stopped');
    } else {
      assert.equal(result?.isError, false, JSON.stringify(result));
      assert.equal(result.text, parentReply);
      assert.equal(result.fileCommitStarted, kind === 'writer');
    }
    assert.equal(state.requests.size, ['attachment', 'disabled'].includes(kind) || state.roleRejected ? 1 : 2);
  }
  assert.equal(await fs.readFile(path.join(cwd, 'helper.txt'), 'utf8'), 'written by the scoped helper');
  assert.deepEqual(await fs.readdir(path.join(native, 'sessions')), ['old-rollout.jsonl']);
  assert.deepEqual(await Promise.all(protectedFiles.map(file => fs.readFile(file))), before);
  console.log(JSON.stringify({ version: '0.166.0', parent_and_helper_threads: counts,
    narrow_read_and_protected_denial: true, standard_child_write: true, local_attachment_rejected: true,
    custom_role_scope_widening_rejected: true, active_child_closed_on_abort: true, native_profile_files_byte_exact: true,
    native_sessions_unchanged: true, explicit_disable_native_tools: true, named_brief_reached_native_child: true,
    input_token_accounting: accounting,
    production_auth: false, network: 'loopback-only' }, null, 2));
} finally {
  service.closeAllConnections();
  await new Promise(resolve => service.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
