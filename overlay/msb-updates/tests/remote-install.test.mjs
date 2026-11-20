import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildRemoteExtInstallScript } from '../src/ssh/remote.mjs';

test('install script ставит шаблонный drop-in и рестартит всех ботов', () => {
  const script = buildRemoteExtInstallScript({
    apiBase: 'https://updates.example',
    installToken: 'tok',
    manifestJson: { version: 'test', channel: 'ext', files: [] },
    filesBase64: [],
  });

  assert.match(script, /msb-bot@\.service\.d\/60-ext-entry\.conf/);
  assert.match(script, /bot-ctl\.sh restart all/);
  assert.match(script, /LIVE\/bots/);
  assert.match(script, /RESTARTED/);
  assert.match(script, /DROPIN_OK/);
  // не только default
  assert.doesNotMatch(script, /bot-ctl\.sh restart \|\| true\n\s+else\n\s+sudo -n systemctl restart msb-bot@default/);
});

test('SSH install cannot write an owner package through an absolute path or symlink', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-ext-install-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, '.msb');
  const packageDir = path.join(root, 'local/ext/demo');
  const file = path.join(packageDir, 'manifest.json');
  const alias = path.join(root, 'bot/ext/demo');
  await fs.mkdir(packageDir, { recursive: true });
  await fs.mkdir(path.dirname(alias), { recursive: true });
  await fs.symlink(packageDir, alias, 'dir');
  const bytes = Buffer.from('released fixture');
  const install = rel => {
    const script = buildRemoteExtInstallScript({
      apiBase: 'https://updates.example', installToken: 'fixture', manifestJson: { version: 'test' },
      filesBase64: [{ path: rel, b64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }],
    });
    const [, program] = script.match(/python3 - <<'PY'\n([\s\S]+?)\nPY\n/);
    const result = spawnSync('python3', ['-'], { input: program, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
    assert.ifError(result.error);
    return result;
  };
  for (const rel of [file, 'bot/ext/demo/manifest.json']) {
    await t.test(rel === file ? 'absolute path' : 'symlink parent', async () => {
      await fs.writeFile(file, 'owner fixture');
      const result = install(rel);
      assert.equal(await fs.readFile(file, 'utf8'), 'owner fixture');
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /APPLIED/);
    });
  }
  const valid = install('bot/ext/released.mjs');
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(await fs.readFile(path.join(root, 'bot/ext/released.mjs'), 'utf8'), 'released fixture');
});
