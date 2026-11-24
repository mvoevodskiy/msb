import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/api/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { createClientStore } from '../src/store/clients.mjs';
import { passwordsMatch } from '../src/crm/session.mjs';

const PLATFORM = 'hcloud_test_token_value_123456';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('password compare does not treat a different secret as equal', () => {
  assert.equal(passwordsMatch('correct-password', 'correct-password'), true);
  assert.equal(passwordsMatch('correct-password', 'other-password'), false);
});

test('crm lists an installation and hides the platform token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msb-crm-'));
  const clients = createClientStore(dir);
  await clients.upsertFromTelegram({ id: 42, username: 'ivan', first_name: 'Иван' });
  await clients.savePlatformToken(42, { provider: 'hetzner', token: PLATFORM });
  const installation = await clients.createInstallation({
    owner_tg_user_id: 42,
    owner_username: 'ivan',
    owner_name: 'Иван',
    origin: 'setup',
    host: '203.0.113.10',
    status: 'ready',
  });
  const config = loadConfig({
    PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
    CRM_PASSWORD: 'crm-secret-value',
  });
  const server = createServer({
    config,
    clients,
    auth: { resolveBearer: async () => null, hasScope: () => false },
    releases: {},
    intents: {},
    worker: {},
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const closed = await fetch(`${base}/crm`);
    assert.equal(closed.status, 200);
    assert.match(await closed.text(), /Пароль/);

    const denied = await fetch(`${base}/crm/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=wrong-password',
      redirect: 'manual',
    });
    assert.equal(denied.status, 401);

    const logged = await fetch(`${base}/crm/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=crm-secret-value',
      redirect: 'manual',
    });
    assert.equal(logged.status, 303);
    const cookie = logged.headers.get('set-cookie') || '';
    assert.match(cookie, /portal_crm=/);
    assert.match(cookie, /HttpOnly/i);
    assert.doesNotMatch(cookie, /crm-secret-value/);

    const list = await fetch(`${base}/crm`, { headers: { cookie: cookie.split(';')[0] } });
    const html = await list.text();
    assert.equal(list.status, 200);
    assert.match(html, /Иван/);
    assert.match(html, /203\.0\.113\.10/);
    assert.doesNotMatch(html, new RegExp(PLATFORM));

    const card = await fetch(`${base}/crm/installations/${installation.id}`, {
      headers: { cookie: cookie.split(';')[0] },
    });
    const cardHtml = await card.text();
    assert.match(cardHtml, /Переписки пока нет/);
    assert.doesNotMatch(cardHtml, new RegExp(PLATFORM));
  } finally {
    server.close();
  }
});

test('empty crm password leaves the page closed', async () => {
  const config = loadConfig({});
  assert.equal(config.crmPassword, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msb-crm-off-'));
  const server = createServer({
    config,
    clients: createClientStore(dir),
    auth: { resolveBearer: async () => null, hasScope: () => false },
    releases: {},
    intents: {},
    worker: {},
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/crm/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=anything',
    });
    assert.equal(res.status, 404);
    assert.match(await res.text(), /CRM выключена/);
  } finally {
    server.close();
  }
});

test('installer bot gains no crm button', () => {
  const text = fs.readFileSync(path.join(root, 'src/bot/app.mjs'), 'utf8');
  assert.doesNotMatch(text, /\/crm|CRM/);
});
