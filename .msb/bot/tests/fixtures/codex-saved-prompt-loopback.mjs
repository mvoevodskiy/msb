/**
 * [Production saved Codex adapter](../../../../overlay/bot/ext/adapters/saved-codex.mjs)
 * through the real scheduler against a local Responses fixture. Use network-none
 * Docker with the command in [the old contract](../reference/parity-autonomy-contract.txt).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runSavedCodexPrompt } from '../../../../overlay/bot/ext/adapters/saved-codex.mjs';
import { startScheduler } from '../../src/autonomy/scheduler.mjs';
import { saveState } from '../../src/state.mjs';

const binary = process.argv[2];
assert.ok(path.isAbsolute(binary));
// This workspace stands in for normal user files, outside the adapter's private scratch prefix.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'msb-native-codex-check-')));
const home = path.join(root, 'home'), native = path.join(root, 'account');
const profile = path.join(home, '.iia', 'bots', 'default');
const cwd = path.join(profile, 'autonomy', 'cc-workspace'), bin = path.join(root, 'bin');
const ownerEnv = path.join(profile, '.env');
const protectedNotebook = path.join(profile, 'sessions', 'protected.ipynb');
const allowedNotebook = path.join(cwd, 'sample.ipynb');
const ownerAlias = path.join(cwd, 'bot-env.txt');
const notebook = JSON.stringify({ cells: [{ cell_type: 'markdown', metadata: {}, source: ['original'] }],
  metadata: {}, nbformat: 4, nbformat_minor: 5 });
const secret = path.join(native, 'auth.json');
const config = path.join(native, 'config.toml');
const profileMarker = path.join(root, 'forbidden-mcp-started');
const access = 'fixture-chatgpt-oauth';
const fakeJwt = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' },
})).toString('base64url') + '.fixture';
const oldRollout = path.join(native, 'sessions', 'old-rollout.jsonl');
const old = 'owner conversation fixture';
const workspaceFile = path.join(cwd, 'sample.txt');
const requestedUrl = 'https://fixture.invalid/scheduled-source';
const standardReply = 'saved adapter result';
const pageReply = standardReply + ' [fixture source](' + requestedUrl + ')';
const cases = {
  narrow: [
    { tool: 'read_file', args: { path: 'sample.txt', offset: 2 }, expected: 'second' },
    { tool: 'glob_files', args: { pattern: '*.txt' }, expected: 'sample.txt' },
    { tool: 'grep_files', args: { pattern: '^second$' }, expected: ':2:second' },
    { tool: 'read_file', args: { path: 'alias.txt' }, expected: 'Доступ к пути запрещён' },
    { tool: 'read_file', args: { path: 'bot-env.txt' }, expected: 'Доступ к пути запрещён' },
  ],
  standard: [
    { tool: 'write_file', args: { path: 'new.txt', text: 'new file' }, expected: 'new.txt' },
    { tool: 'edit_file', args: { path: 'sample.txt', old: 'second', text: 'changed' }, expected: 'sample.txt' },
    { tool: 'write_file', args: { path: 'alias.txt', text: 'denied' }, expected: 'Доступ к пути запрещён' },
    { tool: 'write_file', args: { path: ownerEnv, text: 'denied' }, expected: 'Доступ к пути запрещён' },
    { tool: 'write_file', args: { path: 'bot-env.txt', text: 'denied' }, expected: 'Доступ к пути запрещён' },
    { tool: 'edit_notebook', args: { path: protectedNotebook, cell: 0, text: 'denied' }, expected: 'Доступ к пути запрещён' },
    { tool: 'edit_notebook', args: { path: 'sample.ipynb', cell: 0, text: 'owned notebook' }, expected: 'sample.ipynb' },
  ],
};
let phase, step, failure;
const inventory = {};
const service = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/responses') return res.writeHead(404).end();
  try {
    assert.equal(req.headers.authorization, 'Bearer ' + access);
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    assert.equal(JSON.stringify(input.input).includes(old), false);
    const tools = input.tools?.flatMap(tool => tool.type === 'namespace'
      ? tool.tools.map(entry => ({ ...entry, namespace: tool.name })) : [tool]) ?? [];
    inventory[phase] ??= tools.map(tool => tool.name ?? tool.type).sort();
    const previous = cases[phase][step - 1];
    if (previous) {
      const out = input.input.find(item => item.type === 'function_call_output' && item.call_id === 'call_' + (step - 1));
      const observed = JSON.stringify(out);
      assert.ok(observed?.includes(previous.expected), phase + ' result ' + previous.tool + ' ' + observed?.slice(0, 500));
    }
    const next = cases[phase][step];
    const output = [];
    let item;
    if (next) {
      const tool = tools.find(entry => entry.name?.endsWith(next.tool));
      assert.ok(tool, 'Missing permitted tool ' + next.tool);
      item = { id: 'fc_' + step, type: 'function_call', name: tool.name, arguments: JSON.stringify(next.args),
        ...(tool.namespace ? { namespace: tool.namespace } : {}), call_id: 'call_' + step, status: 'completed' };
    } else {
      if (phase === 'narrow') {
        assert.ok(JSON.stringify(input.input).includes(requestedUrl));
        assert.equal(tools.find(tool => tool.type === 'web_search')?.external_web_access, true);
        output.push({ id: 'ws_fixture', type: 'web_search_call', status: 'completed',
          action: { type: 'open_page', url: requestedUrl } });
      }
      item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: phase === 'narrow' ? pageReply : standardReply, annotations: [] }] };
    }
    output.push(item);
    const response = { id: 'resp_fixture_' + phase + '_' + step++, created_at: 1, model: 'gpt-5.4',
      status: 'completed', output };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [type, fields] of [
      ['response.created', { response: { ...response, status: 'in_progress', output: [] } }],
      ...output.map((item, output_index) => ['response.output_item.done', { output_index, item }]),
      ['response.completed', { response }],
    ]) res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n');
    res.end();
  } catch (error) {
    failure = error;
    res.writeHead(500).end();
  }
});

try {
  await Promise.all([cwd, bin, path.dirname(oldRollout), path.dirname(protectedNotebook)].map(dir => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
  await fs.symlink(binary, path.join(bin, 'codex'));
  await fs.symlink(secret, path.join(cwd, 'alias.txt'));
  await fs.writeFile(ownerEnv, 'SYNTHETIC_BOT_PROFILE_MARKER');
  await fs.symlink(ownerEnv, ownerAlias);
  await fs.writeFile(protectedNotebook, notebook);
  await fs.writeFile(allowedNotebook, notebook);
  await fs.writeFile(workspaceFile, 'first\nsecond');
  await fs.writeFile(secret, JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: fakeJwt,
    access_token: access, refresh_token: 'fixture-refresh', account_id: 'fixture-account' },
  last_refresh: new Date().toISOString() }), { mode: 0o600 });
  await fs.writeFile(oldRollout, old);
  await fs.writeFile(config, 'model = "gpt-5.4"\n[mcp_servers.foreign]\ncommand = "/bin/sh"\nargs = ["-c", ' +
    JSON.stringify('touch "' + profileMarker + '"') + ']\n');
  await new Promise((resolve, reject) => { service.once('error', reject); service.listen(0, '127.0.0.1', resolve); });
  const baseUrl = 'http://127.0.0.1:' + service.address().port + '/v1';
  const owner = -100777;
  Object.assign(process.env, { HOME: home, CODEX_HOME: native, PATH: bin + path.delimiter + process.env.PATH,
    OPENAI_API_KEY: 'fixture-should-be-ignored', CODEX_ACCESS_TOKEN: 'fixture-should-be-ignored',
    MSB_RUNTIME_PROFILE: 'jar1', MSB_RUNTIME_ROOT: path.join(home, '.iia'), MSB_BOT_ID: 'default', AUTONOMY_ENABLED: '1' });
  const stateFile = await saveState({ engine: 'cc', authMode: 'subscription', hasSubscriptionAuth: true,
    extAuthBypass: 'codex', chatId: owner, userId: 42, timezone: 'Europe/Moscow' });
  const files = [secret, config, oldRollout, ownerEnv, stateFile, protectedNotebook];
  const previous = await Promise.all(files.map(file => fs.readFile(file)));
  const instant = Date.now();
  const actions = path.join(profile, 'actions.json');
  const reports = [];
  let result;
  const scheduler = startScheduler({
    adminId: 42, timezone: 'Europe/Moscow', now: () => instant, log() {},
    api: { sendMessage: async (chat, text) => { reports.push({ chat, text }); } },
    runTurn: () => assert.fail('Saved Codex turn must not use the owner session'),
    runCodexPrompt: async (options, env) => {
      result = await runSavedCodexPrompt(options, env, { baseUrl });
      return result;
    },
  });
  try {
    for (const name of ['narrow', 'standard']) {
      phase = name;
      step = 0;
      result = undefined;
      const prompt = name === 'narrow' ? 'Open the exact URL ' + requestedUrl : 'Run the stored fixture action.';
      await fs.writeFile(actions, JSON.stringify([{
        id: 'fixture-' + name, name, enabled: true, runner: 'auto',
        trigger: { kind: 'once', at: new Date(instant - 1000).toISOString() },
        task: { kind: 'prompt', prompt, model: 'gpt-5.4', helpers: false },
        authority: { profile: name }, capability: name === 'narrow' ? 'none' : 'read',
        budget: { maxRunSeconds: 120 }, output: { format: 'tg-message' },
      }]));
      await scheduler.tickNow();
      if (failure) throw failure;
      const expected = name === 'narrow' ? pageReply : standardReply;
      assert.equal(result?.isError, false, JSON.stringify(result));
      assert.equal(result.text, expected);
      assert.equal(result.fileCommitStarted, name === 'standard');
      assert.equal(step, cases[name].length + 1);
      assert.ok(reports.some(report => report.chat === owner && report.text.includes(standardReply) &&
        (name !== 'narrow' || report.text.includes('href="' + requestedUrl + '"'))));
      const [saved] = JSON.parse(await fs.readFile(actions, 'utf8'));
      assert.equal(saved.lastStatus, 'ok');
      assert.equal(saved.disabledReason, 'spent_once');
    }
  } finally {
    await scheduler.stop();
  }
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file))), previous);
  assert.deepEqual(await fs.readdir(path.join(native, 'sessions')), ['old-rollout.jsonl']);
  assert.equal(await fs.readFile(workspaceFile, 'utf8'), 'first\nchanged');
  assert.equal(await fs.readFile(path.join(cwd, 'new.txt'), 'utf8'), 'new file');
  const updatedCell = JSON.parse(await fs.readFile(allowedNotebook, 'utf8')).cells[0].source;
  assert.equal(Array.isArray(updatedCell) ? updatedCell.join('') : updatedCell, 'owned notebook');
  await assert.rejects(fs.stat(profileMarker), { code: 'ENOENT' });
  assert.equal(inventory.narrow.some(tool => /write_file|edit_file|edit_notebook/.test(tool)), false);
  assert.ok(inventory.standard.some(tool => tool.endsWith('edit_notebook')));
  for (const names of Object.values(inventory)) {
    assert.ok(names.includes('web_search'));
    assert.equal(names.some(tool => /exec_command|write_stdin|apply_patch|view_image|foreign|spawn_agent/.test(tool)), false);
  }
  console.log(JSON.stringify({ production_adapter: true, scheduler_and_core_scope: true,
    version: '0.166.0', cli_platform: process.platform,
    native_profile_files_byte_exact: true, rollout_separate: true, shell_exposed: false,
    workspace_read_glob_grep_write_edit: true, workspace_notebook_edit: true, protected_alias_denied: true,
    protected_bot_profile_and_notebook_denied: true, saved_owner_profile_byte_exact: true,
    hosted_url_open_protocol: true, real_external_page_read: false,
    inherited_mcp_started: false, tools: inventory, production_auth: false, network: 'loopback-only' }, null, 2));
} finally {
  service.closeAllConnections();
  await new Promise(resolve => service.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
