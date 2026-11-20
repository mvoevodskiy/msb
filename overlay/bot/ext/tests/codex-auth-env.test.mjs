import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexChildEnvironment } from '../codex-auth-env.mjs';
import { compactCodex } from '../compact-codex.mjs';

test('normal turns and compaction share per-bot and native Codex auth precedence', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-auth-env-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin');
  const bot = path.join(home, '.msb/bots/default');
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(bot, { recursive: true });
  await fs.writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await fs.writeFile(path.join(bot, '.env'), 'OPENAI_API_KEY=fixture-only-key\n', { mode: 0o600 });
  const env = { HOME: home, PATH: bin, MSB_BOT_ID: 'default' };
  const fromFile = await codexChildEnvironment(env, home);
  assert.equal(fromFile.configured, true);
  assert.equal(fromFile.env.OPENAI_API_KEY, 'fixture-only-key');
  let received;
  const snapshot = { ccSessionId: 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53' };
  const result = await compactCodex(snapshot, { env, run: async (options) => { received = options; return { ok: true }; } });
  assert.equal(result.ok, true);
  assert.equal(received.env.OPENAI_API_KEY, 'fixture-only-key');
  assert.equal(received.threadId, '0199a213-81c0-7800-8aa1-bbab2a035a53');

  await fs.mkdir(path.join(home, '.codex'));
  await fs.writeFile(path.join(home, '.codex/auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-native' } }), { mode: 0o600 });
  const native = await codexChildEnvironment(env, home);
  assert.equal(native.configured, true);
  assert.equal(native.env.OPENAI_API_KEY, undefined);
});
