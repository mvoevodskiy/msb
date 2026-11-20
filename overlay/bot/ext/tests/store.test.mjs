import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadStore,
  setActive,
  encodeExtSession,
  decodeExtSession,
  storePath,
  setSelectedModel,
  getSelectedModel,
} from '../store.mjs';

test('store: default active claude', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-ext-'));
  const env = { MSB_BOT_ID: 'default' };
  const s = await loadStore(env, home);
  assert.equal(s.active, 'claude');
  assert.ok(storePath(env, home).includes('ext-providers.json'));
});

test('store: setActive persists', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-ext-'));
  const env = { MSB_BOT_ID: 'personal' };
  await setActive('cursor', env, home);
  const s = await loadStore(env, home);
  assert.equal(s.active, 'cursor');
});

test('ext session codec', () => {
  const id = encodeExtSession('qwen', 'abc');
  assert.equal(id, 'ext:qwen:abc');
  assert.deepEqual(decodeExtSession(id), { providerId: 'qwen', nativeId: 'abc' });
  assert.equal(decodeExtSession('plain-uuid'), null);
});

test('store: selected model per provider', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-ext-'));
  const env = { MSB_BOT_ID: 'default' };
  await setActive('codex', env, home);
  await setSelectedModel('codex', 'gpt-6.1-sol', env, home);
  assert.equal(await getSelectedModel('codex', env, home), 'gpt-6.1-sol');
  assert.equal(await getSelectedModel('cursor', env, home), null);
});
