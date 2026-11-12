import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMcpHost } from '../src/protocol.mjs';
import { buildTools, INSTRUCTIONS } from '../src/tools.mjs';
import { isBlockedRelative } from '../src/sanitize.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'index.mjs');

async function fixtureEnv() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-mcp-'));
  const workspace = path.join(home, 'workspace');
  const projects = path.join(home, 'projects');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(projects, { recursive: true });
  await fs.mkdir(path.join(home, '.msb', 'bots', 'default'), { recursive: true });
  await fs.mkdir(path.join(home, '.msb', 'bots', 'visual'), { recursive: true });
  await fs.writeFile(path.join(home, '.msb', 'bots', 'default', 'state.json'), JSON.stringify({
    engine: 'codex',
    ccModel: 'gpt-5.4',
    activeProject: 'demo',
    sessionHistory: [{ id: 'sess-1', first: 'hello token=sk-secretvalue1234567890', provider: 'codex' }],
  }, null, 2) + '\n');
  await fs.writeFile(path.join(home, '.msb', 'bots', 'default', '.env'), 'BOT_TOKEN=123456:ABC\n', { mode: 0o600 });
  await fs.writeFile(
    path.join(home, '.msb', 'bots', 'default', 'chat-diary.jsonl'),
    `${JSON.stringify({ kind: 'agent_reply', summary: 'ответ' })}\n`,
  );
  await fs.mkdir(path.join(projects, 'demo', 'memory'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'note.md'), '# note\n');
  await fs.writeFile(path.join(projects, 'demo', 'README.md'), 'demo project\n');
  return {
    HOME: home,
    MSB_RUNTIME_PROFILE: 'msb',
    MSB_WORKSPACE_DIR: workspace,
  };
}

async function callTool(env, name, args = {}) {
  const host = createMcpHost({ tools: buildTools(env), instructions: INSTRUCTIONS });
  const listed = await host.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.ok(listed.result.tools.some((tool) => tool.name === name));
  const response = await host.handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  assert.notEqual(response.result.isError, true, response.result.content?.[0]?.text);
  return JSON.parse(response.result.content[0].text);
}

test('blocked secret paths', () => {
  assert.equal(isBlockedRelative('.env'), true);
  assert.equal(isBlockedRelative('secrets/api_key'), true);
  assert.equal(isBlockedRelative('README.md'), false);
  assert.equal(isBlockedRelative('.env.example'), false);
});

test('overview and state hide secrets', async () => {
  const env = await fixtureEnv();
  const overview = await callTool(env, 'bots_overview');
  assert.equal(overview.bots.length, 2);
  assert.equal(overview.bots.find((b) => b.botId === 'default').activeProject, 'demo');

  const state = await callTool(env, 'get_bot_state', { botId: 'default' });
  assert.equal(state.state.engine, 'codex');
  assert.match(JSON.stringify(state), /скрыто|\[скрыто\]/);
  assert.doesNotMatch(JSON.stringify(state), /sk-secretvalue1234567890/);

  const sessions = await callTool(env, 'list_sessions', { botId: 'default' });
  assert.equal(sessions.sessions.length, 1);

  const diary = await callTool(env, 'read_diary', { botId: 'default', limit: 10 });
  assert.equal(diary.total, 1);
  assert.equal(diary.rows[0].kind, 'agent_reply');
});

test('workspace and project file actions', async () => {
  const env = await fixtureEnv();
  const listed = await callTool(env, 'list_files', { scope: 'workspace', path: '.' });
  assert.ok(listed.entries.some((e) => e.name === 'note.md'));

  const note = await callTool(env, 'read_file', { scope: 'workspace', path: 'note.md' });
  assert.match(note.content, /# note/);

  const written = await callTool(env, 'write_file', {
    scope: 'project',
    project: 'demo',
    path: 'memory/today.md',
    content: 'task\n',
  });
  assert.equal(written.written, true);
  const again = await callTool(env, 'read_file', {
    scope: 'project',
    project: 'demo',
    path: 'memory/today.md',
  });
  assert.equal(again.content, 'task\n');

  const created = await callTool(env, 'create_project', { name: 'fresh' });
  assert.ok(created.projects.includes('fresh'));

  const blocked = createMcpHost({ tools: buildTools(env), instructions: INSTRUCTIONS });
  const denied = await blocked.handleRequest({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'read_file', arguments: { scope: 'workspace', path: '.env' } },
  });
  assert.equal(denied.result.isError, true);
});

test('stdio initialize + tools/list handshake', async () => {
  const env = await fixtureEnv();
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  child.stdout.setEncoding('utf8');
  let buffer = '';
  const nextLine = () => new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        child.stdout.off('data', onData);
        resolve(line);
      }
    };
    child.stdout.on('data', onData);
    child.on('error', reject);
    setTimeout(() => reject(new Error('timeout waiting for MCP line')), 5000);
  });

  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
  }) + '\n');
  const init = JSON.parse(await nextLine());
  assert.equal(init.result.serverInfo.name, 'msb-bot-data');

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  const listed = JSON.parse(await nextLine());
  lines.push(...listed.result.tools.map((t) => t.name));
  assert.ok(lines.includes('bots_overview'));
  assert.ok(lines.includes('write_file'));

  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));
});
