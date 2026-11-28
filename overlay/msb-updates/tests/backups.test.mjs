import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createAccess } from '../src/portal/access.mjs';
import { createBackupService } from '../src/portal/backups.mjs';
import { createMemoryStore } from '../src/portal/memory-store.mjs';
import { createClientStore } from '../src/store/clients.mjs';
import { createAuthStore } from '../src/store/auth.mjs';
import { createServer } from '../src/api/server.mjs';
import { loadConfig } from '../src/config.mjs';

test('backup report keeps the object location and refuses the archive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msb-backup-'));
  const clients = createClientStore(dir);
  const auth = createAuthStore(dir);
  await clients.upsertFromTelegram({ id: 9, username: 'oleg', first_name: 'Олег' });
  const installation = await clients.createInstallation({
    owner_tg_user_id: 9,
    owner_name: 'Олег',
    origin: 'setup',
    host: '203.0.113.30',
    status: 'ready',
  });
  const issued = await auth.issueToken({
    tgUserId: 9,
    kind: 'backup_report',
    scopes: ['backup:report'],
  });
  const backups = createBackupService(createMemoryStore());
  const access = createAccess({ policy: 'open', findGrant: async () => null });
  const config = loadConfig({ CRM_PASSWORD: 'crm-secret-value', PUBLIC_BASE_URL: 'http://127.0.0.1' });
  const server = createServer({
    config,
    clients,
    auth,
    access,
    backups,
    releases: {},
    intents: { get: async () => null, listByUser: async () => [] },
    worker: {},
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const reportUrl = `${base}/v1/installations/${installation.id}/backup-report`;
  try {
    const refused = await fetch(reportUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${issued.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ archive: 'binary', object_ref: 's3://bucket/a' }),
    });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error, 'archive_refused');
    assert.equal(await backups.get(installation.id), null);

    const saved = await fetch(reportUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${issued.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        schedule: 'daily',
        last_success_at: '2026-11-24T12:00:00Z',
        object_ref: 's3://bucket/client/a',
      }),
    });
    const body = await saved.json();
    assert.equal(saved.status, 200);
    assert.equal(body.backup.object_ref, 's3://bucket/client/a');
    assert.equal(body.backup.schedule, 'daily');
    assert.equal(Object.hasOwn(body.backup, 'archive'), false);
    assert.equal((await clients.getInstallation(installation.id)).status, 'ready');

    const logged = await fetch(`${base}/crm/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=crm-secret-value',
      redirect: 'manual',
    });
    const cookie = (logged.headers.get('set-cookie') || '').split(';')[0];
    const card = await fetch(`${base}/crm/installations/${installation.id}`, { headers: { cookie } });
    const html = await card.text();
    assert.match(html, /s3:\/\/bucket\/client\/a/);
    const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
    const restored = await fetch(`${base}/crm/installations/${installation.id}/restore`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }),
      redirect: 'manual',
    });
    assert.equal(restored.status, 303);
    const row = await backups.get(installation.id);
    assert.ok(row.restore_requested_at);
    assert.equal(row.object_ref, 's3://bucket/client/a');
    assert.equal((await clients.getInstallation(installation.id)).status, 'ready');
  } finally {
    server.close();
  }
});

test('backup report without a grant is denied and does not need the archive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msb-backup-deny-'));
  const clients = createClientStore(dir);
  const auth = createAuthStore(dir);
  const installation = await clients.createInstallation({
    owner_tg_user_id: 4,
    origin: 'setup',
    status: 'ready',
  });
  const issued = await auth.issueToken({
    tgUserId: 4,
    kind: 'backup_report',
    scopes: ['backup:report'],
  });
  const backups = createBackupService(createMemoryStore());
  const access = createAccess({ policy: 'restricted', findGrant: async () => null });
  const server = createServer({
    config: loadConfig({ PUBLIC_BASE_URL: 'http://127.0.0.1' }),
    clients,
    auth,
    access,
    backups,
    releases: {},
    intents: { get: async () => null, listByUser: async () => [] },
    worker: {},
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const denied = await fetch(`http://127.0.0.1:${server.address().port}/v1/installations/${installation.id}/backup-report`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${issued.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ object_ref: 's3://bucket/b' }),
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, 'capability_denied');
    assert.equal(await backups.get(installation.id), null);
  } finally {
    server.close();
  }
});
