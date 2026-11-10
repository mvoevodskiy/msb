import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthStore } from '../src/store/auth.mjs';
import { createReleaseStore } from '../src/store/releases.mjs';

test('token issue redeem revoke', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msb-auth-'));
  const auth = createAuthStore(dir);
  await auth.init();
  const { token, meta } = await auth.issueToken({
    tgUserId: 42,
    kind: 'install_box',
    scopes: ['ext:read'],
  });
  const resolved = await auth.resolveBearer(token);
  assert.equal(resolved.token_id, meta.token_id);
  await auth.revoke(meta.token_id);
  assert.equal(await auth.resolveBearer(token), null);

  const link = await auth.createWebLink({ tgUserId: 42 });
  const once = await auth.redeemWebLink(link.token);
  assert.ok(once.token);
  assert.equal(await auth.redeemWebLink(link.token), null);
});

test('publish ext from staging tree', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'msb-data-'));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'msb-src-'));
  fs.mkdirSync(path.join(src, 'ext'), { recursive: true });
  fs.mkdirSync(path.join(src, 'systemd'), { recursive: true });
  fs.writeFileSync(path.join(src, 'run.mjs'), 'export {}\n');
  fs.writeFileSync(path.join(src, 'ext', 'x.mjs'), 'export {}\n');
  fs.writeFileSync(path.join(src, 'systemd', '60-ext-entry.conf'), '[Service]\n');

  const releases = createReleaseStore(data);
  const man = await releases.publishFromDir({
    channel: 'ext',
    version: '0.1.0',
    fromDir: src,
    compatibleCore: { min: 'x.v27.1', versions: null },
  });
  assert.equal(man.channel, 'ext');
  assert.ok(man.files.some((f) => f.path === 'bot/run.mjs'));
  assert.ok(man.files.some((f) => f.path.startsWith('bot/ext/')));
  const latest = await releases.latest('ext');
  assert.equal(latest.version, '0.1.0');
});
