/**
 * Real Codex saved-prompt transport boundary. Run with a pinned Codex executable
 * in a network-none Linux container. Only this fixture's files and API are used.
 * See [old task authority](./parity-autonomy-contract.txt).
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const editableName = 'workspace.txt';
const before = 'fixture workspace before';
const after = 'fixture workspace after';

function toolSpec(name, write = false) {
  return {
    name, description: 'Isolated fixture file access',
    inputSchema: { type: 'object', properties: { file: { type: 'string' },
      ...(write ? { text: { type: 'string' } } : {}) }, required: write ? ['file', 'text'] : ['file'],
      additionalProperties: false },
  };
}

async function fixtureTool(cwd, mode) {
  const tools = [toolSpec('workspace_read'), ...(mode === 'edit' ? [toolSpec('workspace_write', true)] : [])];
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    let result;
    if (request.method === 'initialize') {
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'scheduled-prompt-fixture', version: '1' } };
    } else if (request.method === 'tools/list') {
      result = { tools };
    } else if (request.method === 'tools/call') {
      const { name, arguments: args } = request.params;
      const allowed = args.file === editableName && tools.some(tool => tool.name === name);
      const file = path.join(cwd, editableName);
      if (allowed && name === 'workspace_write') await fs.writeFile(file, args.text, 'utf8');
      const text = allowed ? await fs.readFile(file, 'utf8') : 'fixture outside path denied';
      result = { content: [{ type: 'text', text }], isError: !allowed };
    } else throw new Error('Unexpected fixture tool method');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  }
}

function finishSse(res, item, sequence) {
  const response = { id: 'resp_fixture_' + sequence, created_at: 1, model: 'gpt-5.4', status: 'completed', output: [item] };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [type, value] of [
    ['response.created', { response: { ...response, status: 'in_progress', output: [] } }],
    ['response.output_item.done', { output_index: 0, item }],
    ['response.completed', { response }],
  ]) res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n');
  res.end();
}

async function snapshot(root, dir = root) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const rows = await Promise.all(entries.map(async entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return snapshot(root, file);
    const digest = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    return [[path.relative(root, file), digest]];
  }));
  return rows.flat().sort(([left], [right]) => left.localeCompare(right));
}

const overrides = entries => Object.entries(entries).flatMap(([key, value]) => ['-c', key + '=' + JSON.stringify(value)]);
const fileTools = tools => tools.flatMap(tool => tool.type === 'namespace'
  ? tool.tools.map(child => ({ ...child, namespace: tool.name })) : [tool]);

async function prove(binary) {
  assert.ok(path.isAbsolute(binary));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'msb-codex-saved-prompt-')));
  const home = path.join(root, 'home'), native = path.join(root, 'codex');
  const cwd = path.join(root, 'repo', 'workspace'), scratch = path.join(root, 'scratch');
  const marker = path.join(root, 'foreign-mcp-called');
  const foreign = name => '[mcp_servers.' + name + ']\ncommand = "/bin/sh"\nargs = ["-c", ' +
    JSON.stringify('touch "' + marker + '"') + ']\n';
  const secret = 'loopback-only-oauth-fixture';
  const jwt = 'eyJhbGciOiJub25lIn0.' +
    Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url') +
    '.fixture';
  let failure, phase, step;
  const toolsByPhase = {};
  const cases = {
    seed: [],
    narrow: [{ tool: 'workspace_read', args: { file: editableName }, expected: before },
      { tool: 'workspace_read', args: { file: '../outside.txt' }, expected: 'fixture outside path denied' }],
    standard: [{ tool: 'workspace_write', args: { file: editableName, text: after }, expected: after }],
    shellControl: [],
  };
  const fixture = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/responses') return res.writeHead(404).end();
    try {
      assert.equal(req.headers.authorization, 'Bearer ' + secret);
      let body = '';
      for await (const part of req) body += part;
      const input = JSON.parse(body);
      const tools = fileTools(input.tools ?? []);
      toolsByPhase[phase] ??= tools.map(tool => tool.name).sort();
      const previous = cases[phase][step - 1];
      if (previous) {
        const output = input.input.find(item => item.type === 'function_call_output' && item.call_id === 'call_' + (step - 1));
        assert.ok(JSON.stringify(output)?.includes(previous.expected), phase + ' tool result: ' + JSON.stringify(input.input.slice(-3)).slice(0, 1300));
      }
      const next = cases[phase][step];
      let item;
      if (next) {
        const tool = tools.find(entry => entry.name?.endsWith(next.tool));
        assert.ok(tool, 'Expected tool missing: ' + next.tool);
        item = { id: 'fc_' + step, type: 'function_call', name: tool.name, arguments: JSON.stringify(next.args),
          ...(tool.namespace ? { namespace: tool.namespace } : {}), call_id: 'call_' + step, status: 'completed' };
      } else {
        item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'fixture complete', annotations: [] }] };
      }
      if (process.env.SAVED_PROMPT_PROBE_DEBUG) console.error(phase, step, item.name ?? item.type);
      finishSse(res, item, step++);
    } catch (error) {
      failure = error;
      res.writeHead(500).end();
    }
  });
  const env = { HOME: home, CODEX_HOME: native, PATH: process.env.PATH, LANG: 'C.UTF-8' };
  const invoke = args => new Promise((resolve, reject) => {
    const child = execFile(binary, args, { cwd, env, timeout: 45_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          if (process.env.SAVED_PROMPT_PROBE_DEBUG) console.error(phase, step, stdout.slice(-3500));
          return reject(failure ?? error);
        }
        if (stderr.includes('chatgpt.com/backend-api/ps/mcp')) return reject(new Error('Native personal search MCP attempted startup'));
        resolve(stdout);
      });
    child.stdin.on('error', () => {});
    child.stdin.end();
  });

  try {
    await Promise.all([home, native, scratch, cwd, path.join(root, 'repo', '.git'), path.join(cwd, '.codex')]
      .map(dir => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
    await fs.writeFile(path.join(root, 'repo', 'outside.txt'), 'fixture outside must stay unchanged');
    await fs.writeFile(path.join(cwd, editableName), before);
    await fs.writeFile(path.join(native, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      id_token: jwt, access_token: secret, refresh_token: 'fixture-refresh', account_id: 'fixture-account',
    }, last_refresh: new Date().toISOString() }), { mode: 0o600 });
    await fs.writeFile(path.join(native, 'config.toml'), 'model = "ignored-fixture-model"\n' +
      '[projects.' + JSON.stringify(cwd) + ']\ntrust_level = "trusted"\n' + foreign('owner_fixture'));
    await fs.writeFile(path.join(cwd, '.codex', 'config.toml'), foreign('project_fixture'));
    await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
    const version = (await invoke(['--version'])).trim();
    assert.equal(version, 'codex-cli 0.166.0');
    const policy = {
      model_provider: 'fixture',
      'model_providers.fixture.name': 'Saved prompt loopback fixture',
      'model_providers.fixture.base_url': 'http://127.0.0.1:' + fixture.address().port + '/v1',
      'model_providers.fixture.wire_api': 'responses',
      'model_providers.fixture.requires_openai_auth': true,
      'model_providers.fixture.supports_websockets': false,
      'model_providers.fixture.request_max_retries': 0,
      'model_providers.fixture.stream_max_retries': 0,
      web_search: 'disabled',
      check_for_update_on_startup: false,
      suppress_unstable_features_warning: true,
      sqlite_home: path.join(scratch, 'sqlite'),
      log_dir: path.join(scratch, 'log'),
    };
    for (const key of ['shell_snapshot', 'hooks', 'plugin_hooks', 'multi_agent', 'multi_agent_v2',
      'skill_mcp_dependency_install', 'plugins', 'remote_plugin', 'apps', 'memories', 'view_image', 'image_generation', 'goals']) {
      policy['features.' + key] = false;
    }
    policy['features.skip_host_skill_discovery'] = true;
    const common = ['-a', 'never', 'exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
      '--model', 'gpt-5.4', '--sandbox', 'read-only', ...overrides(policy)];
    async function run(name, bridge, shell = false) {
      phase = name;
      step = 0;
      const ephemeral = name === 'seed' ? [] : ['--ephemeral'];
      const toolConfig = bridge ? {
        'mcp_servers.saved_fixture.command': process.execPath,
        'mcp_servers.saved_fixture.args': [fileURLToPath(import.meta.url), '--fixture-tool', cwd, bridge],
        'mcp_servers.saved_fixture.required': true,
        'mcp_servers.saved_fixture.tools.workspace_read.approval_mode': 'approve',
        ...(bridge === 'edit' ? { 'mcp_servers.saved_fixture.tools.workspace_write.approval_mode': 'approve' } : {}),
      } : { mcp_servers: {} };
      const output = await invoke([...common, ...ephemeral, ...overrides({ ...toolConfig, 'features.shell_tool': shell }),
        'Return the fixture result.']);
      assert.match(output, /fixture complete/);
      assert.equal(step, cases[name].length + 1);
      return output.split('\n').filter(Boolean).map(JSON.parse).find(event => event.type === 'thread.started')?.thread_id;
    }
    const ownerId = await run('seed');
    const initialNative = await snapshot(native);
    assert.ok(initialNative.some(([file]) => file.startsWith('sessions/')), 'Control conversation must persist');
    const narrowId = await run('narrow', 'read');
    const standardId = await run('standard', 'edit');
    await run('shellControl', undefined, true);
    assert.ok(ownerId && narrowId && standardId && new Set([ownerId, narrowId, standardId]).size === 3);
    assert.deepEqual(await snapshot(native), initialNative);
    assert.equal(await fs.readFile(path.join(cwd, editableName), 'utf8'), after);
    assert.equal(await fs.readFile(path.join(root, 'repo', 'outside.txt'), 'utf8'), 'fixture outside must stay unchanged');
    assert.equal(await fs.stat(marker).then(() => true, error => error.code !== 'ENOENT'), false);
    const forbidden = /exec_command|write_stdin|shell|apply_patch|view_image|imagegen|[a-z]_goal|owner_fixture|project_fixture/;
    for (const name of ['seed', 'narrow', 'standard']) assert.equal(toolsByPhase[name].some(tool => forbidden.test(tool)), false);
    assert.equal(toolsByPhase.seed.some(tool => /workspace_(read|write)/.test(tool)), false);
    assert.equal(toolsByPhase.narrow.some(tool => tool.endsWith('workspace_write')), false);
    assert.ok(toolsByPhase.shellControl.includes('exec_command'), 'Positive shell control must expose commands');
    return { version, native_chatgpt_fixture_bearer: true, native_profile_files_byte_exact: true,
      fresh_ephemeral_threads: true, built_in_text_file_tools_without_shell: false, outside_fixture_path_denied: true,
      owner_and_project_mcp_never_started: true, tools: toolsByPhase, production_auth: false, network: 'loopback-only' };
  } finally {
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--fixture-tool') await fixtureTool(process.argv[3], process.argv[4]);
else console.log(JSON.stringify(await prove(process.argv[2]), null, 2));
