import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  chatCompletionsEndpoint,
  normalizeOpenaiBaseUrl,
  openaiCompatConfigured,
  saveOpenaiCompatConfig,
  readOpenaiCompatConfig,
} from '../openai-compat.mjs';
import { runOpenaiTurn } from '../adapters/openai.mjs';
import { isProviderId, getProvider } from '../providers.mjs';
import { loadStore } from '../store.mjs';

async function tempEnv() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-openai-'));
  const env = { HOME: home, MSB_BOT_ID: 'default', MSB_RUNTIME_PROFILE: 'msb' };
  await fs.mkdir(path.join(home, '.msb', 'bots', 'default'), { recursive: true });
  return { home, env };
}

test('openai provider is registered', () => {
  assert.equal(isProviderId('openai'), true);
  const p = getProvider('openai');
  assert.equal(p.noCli, true);
  assert.equal(p.authViaWizard, true);
});

test('normalizeOpenaiBaseUrl strips chat/completions and trailing slash', () => {
  assert.equal(
    normalizeOpenaiBaseUrl('https://openrouter.ai/api/v1/'),
    'https://openrouter.ai/api/v1',
  );
  assert.equal(
    normalizeOpenaiBaseUrl('https://openrouter.ai/api/v1/chat/completions'),
    'https://openrouter.ai/api/v1',
  );
  assert.equal(
    chatCompletionsEndpoint('http://127.0.0.1:11434/v1'),
    'http://127.0.0.1:11434/v1/chat/completions',
  );
});

test('saveOpenaiCompatConfig writes key/url/model', async () => {
  const { home, env } = await tempEnv();
  await saveOpenaiCompatConfig({
    apiKey: 'sk-test-key-12345678',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4.1-mini',
  }, env, home);

  assert.equal(await openaiCompatConfigured(env, home), true);
  const cfg = await readOpenaiCompatConfig(env, home);
  assert.equal(cfg.apiKey, 'sk-test-key-12345678');
  assert.equal(cfg.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(cfg.model, 'openai/gpt-4.1-mini');
  const store = await loadStore(env, home);
  assert.equal(store.models.openai, 'openai/gpt-4.1-mini');
});

test('runOpenaiTurn posts chat completions and keeps session', async () => {
  const { home, env } = await tempEnv();
  await saveOpenaiCompatConfig({
    apiKey: 'sk-test-key-12345678',
    baseUrl: 'https://example.test/v1',
    model: 'demo-model',
  }, env, home);

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'привет от endpoint' } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        });
      },
    };
  };

  const first = await runOpenaiTurn({
    prompt: 'sys\n\n---\n\nпривет',
    parsed: {},
    env,
    home,
    userText: 'привет',
    fetchImpl,
  });
  assert.equal(first.ok, true);
  assert.equal(first.text, 'привет от endpoint');
  assert.equal(first.model, 'demo-model');
  assert.ok(first.nativeSessionId);
  assert.equal(calls[0].url, 'https://example.test/v1/chat/completions');
  assert.equal(calls[0].body.model, 'demo-model');
  assert.equal(calls[0].body.messages.at(-1).content, 'привет');

  const second = await runOpenaiTurn({
    prompt: 'ещё',
    parsed: { resume: `ext:openai:${first.nativeSessionId}` },
    env,
    home,
    userText: 'ещё',
    fetchImpl,
  });
  assert.equal(second.ok, true);
  assert.equal(second.nativeSessionId, first.nativeSessionId);
  const roles = calls[1].body.messages.map((m) => m.role);
  assert.ok(roles.includes('assistant'));
  assert.equal(calls[1].body.messages.at(-1).content, 'ещё');
});

test('runOpenaiTurn surfaces HTTP errors', async () => {
  const { home, env } = await tempEnv();
  await saveOpenaiCompatConfig({
    apiKey: 'sk-test-key-12345678',
    baseUrl: 'https://example.test/v1',
    model: 'demo-model',
  }, env, home);

  const result = await runOpenaiTurn({
    prompt: 'x',
    parsed: {},
    env,
    home,
    userText: 'x',
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      async text() {
        return JSON.stringify({ error: { message: 'invalid api key' } });
      },
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.text, /401/);
  assert.match(result.text, /invalid api key/);
});
