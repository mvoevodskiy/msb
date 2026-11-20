import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ensureCodexStableTransport,
  MSB_HTTP_PROVIDER_ID,
  codexHttpProviderOverrides,
} from '../codex-transport.mjs';
import { parseCodexTomlScalars } from '../codex-native.mjs';
import { parseCodexStdout, buildCodexExecArgs, isCodexStreamCutMessage } from '../adapters/codex.mjs';

test('ensureCodexStableTransport writes HTTP-only provider for ChatGPT auth', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-codex-tr-'));
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.codex', 'auth.json'),
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 't', refresh_token: 'r' } }),
    { mode: 0o600 },
  );
  await fs.writeFile(path.join(home, '.codex', 'config.toml'), 'model = "gpt-6.1-sol"\n');

  const r = await ensureCodexStableTransport(home);
  assert.equal(r.ok, true);
  assert.equal(r.providerId, MSB_HTTP_PROVIDER_ID);
  assert.match(r.baseUrl, /chatgpt\.com/);
  const toml = await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /model_provider = "msb_http"/);
  assert.match(toml, /supports_websockets = false/);
  assert.match(toml, /stream_idle_timeout_ms = 600000/);
  assert.match(toml, /model = "gpt-6.1-sol"/);

  const r2 = await ensureCodexStableTransport(home);
  assert.equal(r2.changed, false);
});

test('managed HTTP transport keeps its settings at the TOML root before user tables', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-codex-tr-root-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const directory = path.join(home, '.codex');
  const file = path.join(directory, 'config.toml');
  await fs.mkdir(directory);
  const table = '[mcp_servers.fixture]\ncommand = "fixture"\n';
  await fs.writeFile(file, "model_provider = 'openai' # keep root valid\n" +
    'stream_idle_timeout_ms = 1000\nmodel = "gpt-5.4-mini"\n\n' + table);

  await ensureCodexStableTransport(home);
  const config = await fs.readFile(file, 'utf8');
  const root = parseCodexTomlScalars(config);
  assert.equal(root.model_provider, MSB_HTTP_PROVIDER_ID);
  assert.equal(root.stream_idle_timeout_ms, '1000');
  assert.equal(root.model, 'gpt-5.4-mini');
  assert.equal(config.match(/^model_provider\s*=/gm).length, 1);
  assert.equal(config.match(/^stream_idle_timeout_ms\s*=/gm).length, 1);
  assert.ok(config.endsWith(table));
  assert.equal((await ensureCodexStableTransport(home)).changed, false);
});

test('ensureCodexStableTransport uses api.openai.com for api_key auth', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-codex-tr-api-'));
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.codex', 'auth.json'),
    JSON.stringify({ auth_mode: 'api_key', OPENAI_API_KEY: 'sk-test' }),
    { mode: 0o600 },
  );
  const r = await ensureCodexStableTransport(home);
  assert.match(r.baseUrl, /api\.openai\.com/);
});

test('buildCodexExecArgs forces msb_http provider', () => {
  const args = buildCodexExecArgs({ model: 'gpt-6.1-sol', effort: 'high', forceHttp: true });
  assert.ok(args.includes(`model_provider="${MSB_HTTP_PROVIDER_ID}"`) || args.some((a) => a.includes('msb_http')));
  assert.deepEqual(codexHttpProviderOverrides(true).slice(0, 1), ['-c']);
});

test('parseCodexStdout: reconnect then turn.completed is success, not fail', () => {
  const msg =
    'Reconnecting... 5/5 (stream disconnected before completion: websocket closed by server before response.completed)';
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: msg } }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'готово после HTTP fallback' },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 1, output_tokens: 2 },
    }),
  ].join('\n');
  const p = parseCodexStdout(stdout);
  assert.equal(p.turnCompleted, true);
  assert.equal(p.turnFailed, null);
  assert.equal(p.streamCut, false);
  assert.equal(p.text, 'готово после HTTP fallback');
});

test('parseCodexStdout: reconnect without completion is streamCut', () => {
  const msg =
    'Reconnecting... 5/5 (stream disconnected before completion: websocket closed by server before response.completed)';
  assert.equal(isCodexStreamCutMessage(msg), true);
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: msg } }),
  ].join('\n');
  const p = parseCodexStdout(stdout);
  assert.equal(p.streamCut, true);
  assert.ok(p.turnFailed);
});
