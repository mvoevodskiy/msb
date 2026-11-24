import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  hasNativeCursorAuth, clearNativeCursorAuth, cursorLoginStatus, startCursorBrowserLogin,
} from '../cursor-auth.mjs';
import {
  hasNativeGrokAuth, clearNativeGrokAuth, grokLoginStatus, startGrokDeviceLogin,
} from '../grok-auth.mjs';
import { extractDeviceLoginInfo } from '../device-login-parse.mjs';
import { providerConfigured } from '../env.mjs';
import { getProvider } from '../providers.mjs';
import { authPrompt, cursorLoginGuide, grokLoginGuide } from '../menu.mjs';

async function tmpHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-native-auth-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

test('extractDeviceLoginInfo matches Codex-style URL and dashed code', () => {
  const info = extractDeviceLoginInfo(
    'Open https://auth.example/device \n',
    'code: ABCD-1234\n',
  );
  assert.equal(info.url, 'https://auth.example/device');
  assert.equal(info.code, 'ABCD-1234');
});

test('hasNativeCursorAuth is presence-only on auth.json', async (t) => {
  const home = await tmpHome(t);
  assert.equal(await hasNativeCursorAuth(home), false);
  const file = path.join(home, '.config', 'cursor', 'auth.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ accessToken: 'tok', refreshToken: 'ref' }), { mode: 0o600 });
  assert.equal(await hasNativeCursorAuth(home), true);
});

test('clearNativeCursorAuth removes stale auth.json and authInfo', async (t) => {
  const home = await tmpHome(t);
  const env = { HOME: home, PATH: path.join(home, 'bin') };
  await fs.mkdir(path.join(home, 'bin'), { recursive: true });
  await fs.writeFile(path.join(home, 'bin', 'agent'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const auth = path.join(home, '.config', 'cursor', 'auth.json');
  const cli = path.join(home, '.cursor', 'cli-config.json');
  await fs.mkdir(path.dirname(auth), { recursive: true });
  await fs.mkdir(path.dirname(cli), { recursive: true });
  await fs.writeFile(auth, JSON.stringify({ accessToken: 'stale', refreshToken: 'stale' }), { mode: 0o600 });
  await fs.writeFile(cli, JSON.stringify({ authInfo: { email: 'x' }, other: 1 }, null, 2), { mode: 0o600 });
  const cleared = await clearNativeCursorAuth(env, home);
  assert.equal(cleared.ok, true);
  assert.equal(await hasNativeCursorAuth(home), false);
  await assert.rejects(fs.stat(auth), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await fs.readFile(cli, 'utf8')), { other: 1 });
});

test('cursorLoginStatus does not treat auth.json alone as logged in', async (t) => {
  const home = await tmpHome(t);
  const bin = path.join(home, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, 'agent'),
    `#!${process.execPath}\nif (process.argv[2]==='status') { console.log('Not logged in'); process.exit(1); }\nprocess.exit(0);\n`,
    { mode: 0o700 },
  );
  await fs.mkdir(path.join(home, '.config', 'cursor'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.config', 'cursor', 'auth.json'),
    JSON.stringify({ accessToken: 'stale' }),
    { mode: 0o600 },
  );
  const status = await cursorLoginStatus({ HOME: home, PATH: bin }, home);
  assert.equal(status.ok, false);
});

test('hasNativeGrokAuth recognizes auth.x.ai session entry', async (t) => {
  const home = await tmpHome(t);
  const env = { HOME: home };
  assert.equal(await hasNativeGrokAuth(env, home), false);
  const file = path.join(home, '.grok', 'auth.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({ 'https://auth.x.ai::default': { key: 'session-token' } }),
    { mode: 0o600 },
  );
  assert.equal(await hasNativeGrokAuth(env, home), true);
});

test('clearNativeGrokAuth removes stale auth.json', async (t) => {
  const home = await tmpHome(t);
  const env = { HOME: home, PATH: path.join(home, 'bin') };
  await fs.mkdir(path.join(home, 'bin'), { recursive: true });
  await fs.writeFile(path.join(home, 'bin', 'grok'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const file = path.join(home, '.grok', 'auth.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ 'https://auth.x.ai::default': { key: 'stale' } }), { mode: 0o600 });
  const cleared = await clearNativeGrokAuth(env, home);
  assert.equal(cleared.ok, true);
  assert.equal(await hasNativeGrokAuth(env, home), false);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('providerConfigured accepts native cursor/grok without env keys', async (t) => {
  const home = await tmpHome(t);
  const env = { HOME: home, MSB_BOT_ID: 'default' };
  assert.equal(await providerConfigured(getProvider('cursor'), env, home), false);
  assert.equal(await providerConfigured(getProvider('grok'), env, home), false);

  await fs.mkdir(path.join(home, '.config', 'cursor'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.config', 'cursor', 'auth.json'),
    JSON.stringify({ accessToken: 'tok' }),
    { mode: 0o600 },
  );
  await fs.mkdir(path.join(home, '.grok'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.grok', 'auth.json'),
    JSON.stringify({ 'https://auth.x.ai::x': { key: 'tok' } }),
    { mode: 0o600 },
  );
  assert.equal(await providerConfigured(getProvider('cursor'), env, home), true);
  assert.equal(await providerConfigured(getProvider('grok'), env, home), true);
});

test('authPrompt for cursor/grok is native login, not key form', () => {
  for (const id of ['cursor', 'grok']) {
    const prompt = authPrompt(id);
    assert.equal(prompt.nativeLogin, true);
    assert.match(prompt.text, /Секрет в Telegram не присылай/);
    assert.doesNotMatch(prompt.text, /Пришли ключ/);
  }
});

test('login guides mention subscription path', () => {
  assert.match(cursorLoginGuide({ url: 'https://cursor.com/loginEx' }), /Ссылка:/);
  assert.match(grokLoginGuide({ url: 'https://x.ai/cli/auth', code: 'AB12-CD34' }), /Код: <code>AB12-CD34<\/code>/);
});

test('startCursorBrowserLogin extracts URL from fake agent', async (t) => {
  const home = await tmpHome(t);
  const bin = path.join(home, 'bin');
  await fs.mkdir(bin);
  const url = 'https://cursor.com/auth?login=1 ';
  const source = `
if (process.argv[2] === 'login') {
  process.stdout.write('Open ${url}\\n');
  setTimeout(() => {
    const fs = require('node:fs');
    const path = require('node:path');
    const file = path.join(process.env.HOME, '.config', 'cursor', 'auth.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ accessToken: 'ok' }));
    process.exit(0);
  }, 80);
} else if (process.argv[2] === 'status') {
  console.log('Logged in as fixture@example.com');
} else process.exit(1);
`;
  await fs.writeFile(path.join(bin, 'agent'), `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  const env = { HOME: home, PATH: bin };
  const started = startCursorBrowserLogin(env, home);
  assert.equal(started.ok, true);
  t.after(() => { try { started.child?.kill('SIGTERM'); } catch { /* */ } });
  const end = Date.now() + 3000;
  while (Date.now() < end && !started.extract().url) await new Promise((r) => setTimeout(r, 20));
  assert.equal(started.extract().url, 'https://cursor.com/auth?login=1');
  const done = await started.promise;
  assert.equal(done.ok, true);
  assert.equal(await hasNativeCursorAuth(home), true);
  assert.equal((await cursorLoginStatus(env, home)).ok, true);
});

test('startGrokDeviceLogin extracts URL+code from fake grok', async (t) => {
  const home = await tmpHome(t);
  const bin = path.join(home, 'bin');
  await fs.mkdir(bin);
  const sampleUrl = 'https://x.ai/cli/auth';
  const sampleCode = 'Z9KQ-M2PL';
  const source = `
if (process.argv.includes('--device-auth')) {
  process.stdout.write('Open ${sampleUrl} \\n');
  process.stdout.write('code: ${sampleCode}\\n');
  setTimeout(() => {
    const fs = require('node:fs');
    const path = require('node:path');
    const file = path.join(process.env.HOME, '.grok', 'auth.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ 'https://auth.x.ai::default': { key: 'session' } }));
    process.exit(0);
  }, 80);
} else process.exit(1);
`;
  await fs.writeFile(path.join(bin, 'grok'), `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  const env = { HOME: home, PATH: bin };
  const started = startGrokDeviceLogin(env, home);
  assert.equal(started.ok, true);
  t.after(() => { try { started.child?.kill('SIGTERM'); } catch { /* */ } });
  const done = await started.promise;
  assert.equal(done.ok, true);
  assert.equal(done.url, sampleUrl);
  assert.equal(done.code, sampleCode);
  assert.equal(await hasNativeGrokAuth(env, home), true);
  assert.equal((await grokLoginStatus(env, home)).ok, true);
});
