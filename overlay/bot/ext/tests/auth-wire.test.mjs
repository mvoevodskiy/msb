import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { wireQwenAuth, wireCodexAuth, codexLoginStatus, startCodexDeviceLogin, waitCodexNativeAuth } from '../auth-wire.mjs';

test('wireQwenAuth writes settings.json and .env for sk-sp token plan', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-qwen-'));
  const key = 'sk-sp-testkey1234567890';
  const r = await wireQwenAuth(key, home);
  assert.match(r.baseUrl, /token-plan/);
  const settings = JSON.parse(await fs.readFile(path.join(home, '.qwen', 'settings.json'), 'utf8'));
  assert.equal(settings.security.auth.selectedType, 'openai');
  assert.equal(settings.model.name, 'qwen3-coder-plus');
  const envText = await fs.readFile(path.join(home, '.qwen', '.env'), 'utf8');
  assert.match(envText, /DASHSCOPE_API_KEY=sk-sp-testkey1234567890/);
});

test('wireQwenAuth uses dashscope for plain sk-', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-qwen-'));
  const r = await wireQwenAuth('sk-plainkey1234567890', home);
  assert.match(r.baseUrl, /dashscope/);
});

test('wireCodexAuth fails closed when CLI missing (не объявляет успех)', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-codex-wire-'));
  const r = await wireCodexAuth(
    { apiKey: 'sk-test-key-1234567890' },
    { PATH: '/nonexistent/bin' },
    home,
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /не установлен|failed|codex/i);
});

test('codexLoginStatus verifies the CLI even with an existing auth.json', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-codex-st-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.mkdir(path.join(home, 'bin'));
  await fs.writeFile(path.join(home, '.codex/auth.json'), JSON.stringify({ tokens: { access_token: 'stale-fixture' } }));
  const bin = path.join(home, 'bin/codex');
  await fs.writeFile(bin, '#!/bin/sh\necho "Not logged in"\nexit 1\n', { mode: 0o755 });
  const env = { PATH: path.join(home, 'bin') };
  assert.equal((await codexLoginStatus(env, home)).ok, false);
  await fs.writeFile(bin, '#!/bin/sh\necho "Logged in using ChatGPT"\n');
  const status = await codexLoginStatus(env, home);
  assert.equal(status.ok, true);
  assert.equal(status.mode, 'cli-status');
});


test('device completion and wait accept auth only from the selected Codex profile', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-device-profile-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin');
  const directory = path.join(home, 'selected');
  const env = { HOME: home, CODEX_HOME: directory, PATH: bin, MSB_BOT_ID: 'default' };
  await fs.mkdir(bin);
  await fs.mkdir(directory);
  const cli = '#!' + process.execPath + '\n' + [
    'const fs = require("node:fs");',
    'const file = require("node:path").join(process.env.CODEX_HOME, "auth.json");',
    'if (process.argv[3] === "--device-auth") {',
    '  fs.writeFileSync(file, JSON.stringify({auth_mode:"chatgpt"}));',
    '  console.log("https://example.invalid/device FIXTURE-CODE");',
    '} else if (process.argv[3] === "status" && fs.existsSync(file)) {',
    '  console.log("Logged in using ChatGPT");',
    '} else process.exitCode = 1;',
  ].join('\n');
  await fs.writeFile(path.join(bin, 'codex'), cli, { mode: 0o700 });
  const device = startCodexDeviceLogin(env, home);
  assert.equal(device.ok, true);
  const completed = await device.promise;
  assert.equal(completed.ok, true);
  assert.equal(completed.code, 'FIXTURE-CODE');
  assert.equal((await waitCodexNativeAuth({ env, home, timeoutMs: 1000, pollMs: 20 })).ok, true);
  await assert.rejects(fs.stat(path.join(home, '.codex/auth.json')), { code: 'ENOENT' });
});
