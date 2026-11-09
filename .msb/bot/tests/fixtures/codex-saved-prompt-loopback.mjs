/**
 * [Production saved Codex adapter](../../../../overlay/bot/ext/adapters/saved-codex.mjs)
 * against a local Responses fixture on the pinned Linux CLI. Use network-none
 * Docker with the command in [the old contract](../reference/parity-autonomy-contract.txt).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runSavedCodexPrompt } from '../../../../overlay/bot/ext/adapters/saved-codex.mjs';

const binary = process.argv[2];
assert.ok(path.isAbsolute(binary));
// This workspace stands in for normal user files, outside the adapter's private scratch prefix.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'msb-native-codex-check-')));
const home = path.join(root, 'home'), native = path.join(root, 'account');
const cwd = path.join(home, 'autonomy', 'cc-workspace'), bin = path.join(root, 'bin');
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
  ],
  standard: [
    { tool: 'write_file', args: { path: 'new.txt', text: 'new file' }, expected: 'new.txt' },
    { tool: 'edit_file', args: { path: 'sample.txt', old: 'second', text: 'changed' }, expected: 'sample.txt' },
    { tool: 'write_file', args: { path: 'alias.txt', text: 'denied' }, expected: 'Доступ к пути запрещён' },
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
  await Promise.all([cwd, bin, path.dirname(oldRollout)].map(dir => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
  await fs.symlink(binary, path.join(bin, 'codex'));
  await fs.symlink(secret, path.join(cwd, 'alias.txt'));
  await fs.writeFile(workspaceFile, 'first\nsecond');
  await fs.writeFile(secret, JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: fakeJwt,
    access_token: access, refresh_token: 'fixture-refresh', account_id: 'fixture-account' },
  last_refresh: new Date().toISOString() }), { mode: 0o600 });
  await fs.writeFile(oldRollout, old);
  await fs.writeFile(config, 'model = "gpt-5.4"\n[mcp_servers.foreign]\ncommand = "/bin/sh"\nargs = ["-c", ' +
    JSON.stringify('touch "' + profileMarker + '"') + ']\n');
  const files = [secret, config, oldRollout];
  const previous = await Promise.all(files.map(file => fs.readFile(file)));
  await new Promise((resolve, reject) => { service.once('error', reject); service.listen(0, '127.0.0.1', resolve); });
  const baseUrl = 'http://127.0.0.1:' + service.address().port + '/v1';
  const env = { HOME: home, CODEX_HOME: native, PATH: bin + path.delimiter + process.env.PATH,
    OPENAI_API_KEY: 'fixture-should-be-ignored', CODEX_ACCESS_TOKEN: 'fixture-should-be-ignored' };
  const read = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch'];
  for (const name of ['narrow', 'standard']) {
    phase = name;
    step = 0;
    const tools = name === 'narrow' ? read : [...read, 'Write', 'Edit', 'NotebookEdit'];
    const prompt = name === 'narrow' ? 'Open the exact URL ' + requestedUrl : 'Run the stored fixture action.';
    const result = await runSavedCodexPrompt({ cwd, prompt, model: 'gpt-5.4', tools,
      directories: [home, os.tmpdir()], denied: [], signal: AbortSignal.timeout(65_000),
      canLaunch: async () => true }, env, { baseUrl });
    if (failure) throw failure;
    assert.equal(result?.isError, false, JSON.stringify(result));
    assert.equal(result.text, name === 'narrow' ? pageReply : standardReply);
    assert.equal(result.fileCommitStarted, name === 'standard');
    assert.equal(step, cases[name].length + 1);
  }
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file))), previous);
  assert.deepEqual(await fs.readdir(path.join(native, 'sessions')), ['old-rollout.jsonl']);
  assert.equal(await fs.readFile(workspaceFile, 'utf8'), 'first\nchanged');
  assert.equal(await fs.readFile(path.join(cwd, 'new.txt'), 'utf8'), 'new file');
  await assert.rejects(fs.stat(profileMarker), { code: 'ENOENT' });
  assert.equal(inventory.narrow.some(tool => /write_file|edit_file|edit_notebook/.test(tool)), false);
  assert.ok(inventory.standard.some(tool => tool.endsWith('edit_notebook')));
  for (const names of Object.values(inventory)) {
    assert.ok(names.includes('web_search'));
    assert.equal(names.some(tool => /exec_command|write_stdin|apply_patch|view_image|foreign|spawn_agent/.test(tool)), false);
  }
  console.log(JSON.stringify({ production_adapter: true, version: '0.166.0', cli_platform: process.platform,
    native_profile_files_byte_exact: true, rollout_separate: true, shell_exposed: false,
    workspace_read_glob_grep_write_edit: true, protected_alias_denied: true,
    hosted_url_open_protocol: true, real_external_page_read: false,
    inherited_mcp_started: false, tools: inventory, production_auth: false, network: 'loopback-only' }, null, 2));
} finally {
  service.closeAllConnections();
  await new Promise(resolve => service.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
