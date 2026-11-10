import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeEnvKey, readEnvKey, saveProviderSecret, botEnvPath } from '../env.mjs';

test('env: write and read key in bot .env', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-ext-'));
  const env = { MSB_BOT_ID: 'default' };
  await writeEnvKey('CURSOR_API_KEY', 'cursor-test-key-123456', env, home);
  const raw = await fs.readFile(botEnvPath(env, home), 'utf8');
  assert.match(raw, /CURSOR_API_KEY=cursor-test-key-123456/);
  assert.equal(await readEnvKey('CURSOR_API_KEY', env, home), 'cursor-test-key-123456');
});

test('env: saveProviderSecret rejects short keys', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-ext-'));
  const env = { MSB_BOT_ID: 'default' };
  await assert.rejects(() => saveProviderSecret('cursor', 'short', env, home));
});

test('env: saveProviderSecret for qwen', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-ext-'));
  const env = { MSB_BOT_ID: 'SMM' };
  await saveProviderSecret('qwen', 'sk-sp-test-key-abcdefgh', env, home);
  assert.equal(await readEnvKey('QWEN_API_KEY', env, home), 'sk-sp-test-key-abcdefgh');
  assert.equal(await readEnvKey('DASHSCOPE_API_KEY', env, home), 'sk-sp-test-key-abcdefgh');
});
