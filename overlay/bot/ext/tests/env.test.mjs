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

test('env: saveProviderSecret for qwen and grok', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-ext-'));
  const env = { MSB_BOT_ID: 'SMM' };
  await saveProviderSecret('qwen', 'sk-sp-test-key-abcdefgh', env, home);
  await saveProviderSecret('grok', 'xai-test-key-abcdefghij', env, home);
  assert.equal(await readEnvKey('XAI_API_KEY', env, home), 'xai-test-key-abcdefghij');
  assert.equal(await readEnvKey('QWEN_API_KEY', env, home), 'sk-sp-test-key-abcdefgh');
  assert.equal(await readEnvKey('DASHSCOPE_API_KEY', env, home), 'sk-sp-test-key-abcdefgh');
});

test('env: additional bot inherits AI keys from default, keeps override', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-ext-inherit-'));
  const root = path.join(home, '.msb');
  await fs.mkdir(path.join(root, 'bots/default'), { recursive: true });
  await fs.mkdir(path.join(root, 'bots/extra'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'bots/default/.env'),
    'CURSOR_API_KEY=cursor-from-default-abcdef\nBOT_TOKEN=default-bot-token-should-not-leak\nSERPER_API_KEY=serper-not-inherited\n',
    { mode: 0o600 },
  );
  await fs.writeFile(path.join(root, 'bots/extra/.env'), 'BOT_TOKEN=extra-own-token\n', { mode: 0o600 });

  const extra = { HOME: home, MSB_BOT_ID: 'extra' };
  assert.equal(await readEnvKey('CURSOR_API_KEY', extra, home), 'cursor-from-default-abcdef');
  assert.equal(await readEnvKey('BOT_TOKEN', extra, home), 'extra-own-token');
  assert.equal(await readEnvKey('SERPER_API_KEY', extra, home), '');

  await writeEnvKey('CURSOR_API_KEY', 'cursor-extra-override-xyz', extra, home);
  assert.equal(await readEnvKey('CURSOR_API_KEY', extra, home), 'cursor-extra-override-xyz');
  const defaultRaw = await fs.readFile(path.join(root, 'bots/default/.env'), 'utf8');
  assert.match(defaultRaw, /CURSOR_API_KEY=cursor-from-default-abcdef/);
  assert.doesNotMatch(defaultRaw, /cursor-extra-override/);
});

test('env: root .env remains fallback after default for AI keys', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-ext-root-'));
  const root = path.join(home, '.msb');
  await fs.mkdir(path.join(root, 'bots/extra'), { recursive: true });
  await fs.writeFile(path.join(root, '.env'), 'XAI_API_KEY=xai-from-root-abcdefghij\n', { mode: 0o600 });
  await fs.writeFile(path.join(root, 'bots/extra/.env'), '', { mode: 0o600 });
  const extra = { HOME: home, MSB_BOT_ID: 'extra' };
  assert.equal(await readEnvKey('XAI_API_KEY', extra, home), 'xai-from-root-abcdefghij');
});
