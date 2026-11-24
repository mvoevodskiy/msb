import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInstallerAdmin, loadConfig } from '../src/config.mjs';
import { createHetznerServer } from '../src/hoster/hetzner.mjs';
import { buildAccessScript } from '../src/bot/access-script.mjs';
import { buildAdminBootstrapScript, buildDropAdminKeyScript, nextSetupAction } from '../src/ssh/admin-bootstrap.mjs';
import { buildUpdatesUrlScript } from '../src/ssh/updates-url.mjs';
import { createIntentStore } from '../src/store/intents.mjs';
import { createClientStore } from '../src/store/clients.mjs';
import { createSecretBox } from '../src/store/secrets.mjs';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGbU3Rz4testkey msb-updates-hub';
const PLATFORM = 'hcloud_test_token_value_123456';
const BOT = '123456789:AAHbotTokenValueForTestsOnly00';

test('empty allowlist admits nobody', () => {
  assert.equal(isInstallerAdmin([], 1), false);
  assert.equal(isInstallerAdmin([7], 7), true);
  assert.equal(isInstallerAdmin([7], 8), false);
});

test('paste script only opens the privileged login', () => {
  const root = buildAccessScript({ publicKey: KEY, username: 'root' });
  assert.match(root, /authorized_keys/);
  assert.doesNotMatch(root, /sudoers/);
  assert.doesNotMatch(root, /useradd/);
  assert.match(root, new RegExp(KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const user = buildAccessScript({ publicKey: KEY, username: 'bob' });
  assert.match(user, /msb-install-once/);
  assert.match(user, /NOPASSWD:ALL/);
  assert.doesNotMatch(user, /useradd/);
  assert.doesNotMatch(user, /msb-admin/);
});

test('admin bootstrap keeps the key and drops the temporary sudo', () => {
  const script = buildAdminBootstrapScript(KEY);
  assert.match(script, /useradd --create-home --shell \/bin\/bash --user-group msb-admin/);
  assert.match(script, /authorized_keys/);
  assert.match(script, /rm -f \/etc\/sudoers.d\/msb-install-once/);
  assert.doesNotMatch(script, /grep -vxF/);
  assert.doesNotMatch(script, /MSB_ADMIN_KEY_REMOVED/);

  const drop = buildDropAdminKeyScript(KEY);
  assert.match(drop, /grep -vxF/);
  assert.match(drop, /MSB_ADMIN_KEY_REMOVED/);
});

test('portal address and updates address are separate', () => {
  const cfg = loadConfig({
    PUBLIC_BASE_URL: 'https://aide.win/',
    UPDATES_BASE_URL: 'https://updates.example/hub/',
    ACCESS_POLICY: 'restricted',
    PORTAL_DATABASE_URL: 'postgres://portal@127.0.0.1/portal',
  });
  assert.equal(cfg.baseUrl, 'https://aide.win');
  assert.equal(cfg.updatesBaseUrl, 'https://updates.example/hub');
  assert.equal(cfg.accessPolicy, 'restricted');
  assert.equal(cfg.databaseUrl, 'postgres://portal@127.0.0.1/portal');
  const open = loadConfig({});
  assert.equal(open.accessPolicy, 'open');
  assert.equal(open.updatesBaseUrl, '');
  assert.throws(() => loadConfig({ ACCESS_POLICY: 'plans' }), /ACCESS_POLICY/);
});

test('updates url is a server env parameter, not a baked-in domain', () => {
  const script = buildUpdatesUrlScript('https://updates.example/hub/');
  assert.match(script, /MSB_UPDATES_URL=/);
  assert.match(script, /https:\/\/updates\.example\/hub/);
  assert.doesNotMatch(script, /aide\.win/);
  assert.match(script, /\/home\/client\/\.msb\/\.env/);
});

test('server create is not repeated after the provider id is saved', () => {
  assert.equal(nextSetupAction({ type: 'system_setup', platform_account_id: 'acct' }), 'create');
  assert.equal(nextSetupAction({ type: 'system_setup', provider_server_id: 9 }), 'refresh');
  assert.equal(nextSetupAction({ type: 'system_setup', host: '203.0.113.10', provider_server_id: 9 }), 'bootstrap');
  assert.equal(nextSetupAction({ type: 'ext_overlay', host: '203.0.113.10' }), 'skip');
});

test('new intent does not keep an IIA migration flag', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msb-intents-'));
  const intents = createIntentStore(dir);
  const intent = await intents.create({
    type: 'system_setup',
    tg_user_id: 7,
    host: '203.0.113.10',
    migrate_from: 'iia',
    skip_iia_backup: true,
  });
  assert.equal(intent.migrate_from, undefined);
  assert.equal(intent.skip_iia_backup, undefined);
  const stored = fs.readFileSync(path.join(dir, 'intents', `${intent.id}.json`), 'utf8');
  assert.doesNotMatch(stored, /iia/);
});

test('client record keeps the owner and the platform token, not the bot token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msb-clients-'));
  const clients = createClientStore(dir);
  await clients.upsertFromTelegram({ id: 42, username: 'ivan', first_name: 'Иван' });
  const account = await clients.savePlatformToken(42, { provider: 'hetzner', token: PLATFORM });
  await assert.rejects(
    () => clients.savePlatformToken(42, { provider: 'hetzner', token: BOT }),
    (err) => err.code === 'bot_token_refused',
  );
  const installation = await clients.createInstallation({
    owner_tg_user_id: 42,
    owner_username: 'ivan',
    owner_name: 'Иван',
    origin: 'hoster',
    provider: 'hetzner',
    platform_account_id: account.id,
    ssh_user: 'root',
  });
  await assert.rejects(
    () => clients.createInstallation({ owner_tg_user_id: 42, origin: 'hoster', bot_token: BOT }),
    (err) => err.code === 'bot_token_refused',
  );
  const stored = fs.readFileSync(path.join(dir, 'installations', `${installation.id}.json`), 'utf8');
  assert.equal(installation.owner_username, 'ivan');
  assert.doesNotMatch(stored, /BOT_TOKEN|bot_token|AAHbotToken/);
  const clientFile = fs.readFileSync(path.join(dir, 'clients', '42.json'), 'utf8');
  assert.match(clientFile, new RegExp(PLATFORM));
  const secrets = createSecretBox();
  secrets.put(installation.id, BOT);
  assert.equal(secrets.peek(installation.id), BOT);
  secrets.drop(installation.id);
  assert.equal(secrets.peek(installation.id), null);
});

test('hetzner create reserves the server once and does not echo the token', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body, authorization: opts.headers.authorization });
    if (String(url).endsWith('/ssh_keys')) {
      return json({ ssh_key: { id: 7 } });
    }
    if (String(url).endsWith('/servers')) {
      return json({
        server: {
          id: 9,
          name: 'msb-1',
          status: 'running',
          public_net: { ipv4: { ip: '203.0.113.10' } },
        },
      });
    }
    return json({ error: { message: `bad ${PLATFORM}` } }, 500);
  };
  let reserved = null;
  const server = await createHetznerServer({
    token: PLATFORM,
    name: 'msb-1',
    publicKey: KEY,
    serverType: 'cpx21',
    image: 'ubuntu-24.04',
    location: 'fsn1',
    fetchImpl,
    sleepImpl: async () => {},
    onServer: async (item) => { reserved = item; },
  });
  assert.equal(server.serverId, 9);
  assert.equal(server.ipv4, '203.0.113.10');
  assert.equal(reserved.serverId, 9);
  assert.equal(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/servers')).length, 1);
  assert.match(calls[0].authorization, new RegExp(PLATFORM));
});

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}
