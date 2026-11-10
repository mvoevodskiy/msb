import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseAuthorizedKeys,
  parseUfwSshAllowIps,
  shouldInterceptConstructorUrl,
  handleLocalConstructorRequest,
  isValidLocalSshHost,
  getLocalSshHost,
  setLocalSshHost,
  isLocalTarget,
  isValidBotId,
  buildAddTokenFileBody,
} from '../local-ssh.mjs';
import { buildLocalSshMenu } from '../menu.mjs';

test('parseAuthorizedKeys numbers lines', () => {
  const keys = parseAuthorizedKeys(
    [
      '# comment',
      'ssh-ed25519 AAAAabc user@host',
      '',
      'ssh-rsa AAAAdef laptop',
    ].join('\n'),
  );
  assert.equal(keys.length, 2);
  assert.equal(keys[0].index, 1);
  assert.equal(keys[0].type, 'ssh-ed25519');
  assert.equal(keys[0].comment, 'user@host');
  assert.equal(keys[1].index, 2);
  assert.equal(keys[1].type, 'ssh-rsa');
});

test('parseUfwSshAllowIps extracts From column', () => {
  const ips = parseUfwSshAllowIps(`
Status: active

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW       208.77.244.15
22                         ALLOW       10.0.0.5
80/tcp                     ALLOW       Anywhere
`);
  assert.deepEqual(ips, ['208.77.244.15', '10.0.0.5']);
});

test('shouldInterceptConstructorUrl only for ssh/multibot when host set', () => {
  const env = {
    MSB_LOCAL_SSH_HOST: '192.168.1.10',
    SYNC_URL: 'https://constructor.example/api/sync',
  };
  assert.equal(
    shouldInterceptConstructorUrl('https://constructor.example/api/ssh/status', env),
    true,
  );
  assert.equal(
    shouldInterceptConstructorUrl('https://constructor.example/api/iia/multibot/list', env),
    true,
  );
  assert.equal(
    shouldInterceptConstructorUrl('https://constructor.example/api/report', env),
    false,
  );
  assert.equal(
    shouldInterceptConstructorUrl('https://other.example/api/ssh/status', env),
    false,
  );
  assert.equal(
    shouldInterceptConstructorUrl('https://constructor.example/api/ssh/status', {
      SYNC_URL: env.SYNC_URL,
    }),
    false,
  );
});

test('isValidLocalSshHost accepts ipv4 and hostname', () => {
  assert.equal(isValidLocalSshHost('127.0.0.1'), true);
  assert.equal(isValidLocalSshHost('192.168.1.10'), true);
  assert.equal(isValidLocalSshHost('localhost'), true);
  assert.equal(isValidLocalSshHost('mp-msb'), true);
  assert.equal(isValidLocalSshHost('999.1.1.1'), false);
  assert.equal(isValidLocalSshHost('not a host'), false);
});

test('local ssh status/keys against temp home', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-local-ssh-'));
  await fs.mkdir(path.join(home, '.ssh'), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(home, '.ssh', 'authorized_keys'),
    'ssh-ed25519 AAAAtestkey comment-one\nssh-rsa AAAAsecond two\n',
    { mode: 0o600 },
  );
  await fs.mkdir(path.join(home, '.msb', 'bots', 'default'), { recursive: true });
  await fs.mkdir(path.join(home, '.msb', 'bots', 'personal'), { recursive: true });

  const env = {
    MSB_LOCAL_SSH_HOST: '127.0.0.1',
    MSB_LOCAL_SSH_FORCE_LOCAL: '1',
    SYNC_URL: 'https://constructor.example/api/sync',
  };

  const statusRes = await handleLocalConstructorRequest(
    'https://constructor.example/api/ssh/status',
    { method: 'GET' },
    { env, home },
  );
  const status = await statusRes.json();
  assert.equal(status.ok, true);
  assert.equal(status.vps_ip, '127.0.0.1');
  assert.equal(status.keys_count, 2);
  assert.equal(status.local_ssh, true);

  const keysRes = await handleLocalConstructorRequest(
    'https://constructor.example/api/ssh/keys',
    { method: 'GET' },
    { env, home },
  );
  const keysBody = await keysRes.json();
  assert.equal(keysBody.keys.length, 2);
  assert.equal(keysBody.keys[0].comment, 'comment-one');

  const delRes = await handleLocalConstructorRequest(
    'https://constructor.example/api/ssh/keys',
    { method: 'DELETE', body: JSON.stringify({ index: 1 }) },
    { env, home },
  );
  const delBody = await delRes.json();
  assert.equal(delBody.ok, true);
  assert.equal(delBody.remaining_keys, 1);

  const listRes = await handleLocalConstructorRequest(
    'https://constructor.example/api/iia/multibot/list',
    { method: 'GET' },
    { env, home },
  );
  const listBody = await listRes.json();
  assert.equal(listBody.ok, true);
  assert.deepEqual(
    listBody.bots.map((b) => b.botId),
    ['default', 'personal'],
  );
});

test('setLocalSshHost persists and getLocalSshHost reads', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-local-ssh-env-'));
  const env = { MSB_BOT_ID: 'default' };
  await fs.mkdir(path.join(home, '.msb', 'bots', 'default'), { recursive: true });
  await setLocalSshHost('192.168.1.10', env, home);
  assert.equal(getLocalSshHost(env), '192.168.1.10');
  const botEnv = await fs.readFile(path.join(home, '.msb', 'bots', 'default', '.env'), 'utf8');
  assert.match(botEnv, /MSB_LOCAL_SSH_HOST=192\.168\.1\.10/);
  const globalEnv = await fs.readFile(path.join(home, '.msb', '.env'), 'utf8');
  assert.match(globalEnv, /MSB_LOCAL_SSH_HOST=192\.168\.1\.10/);
});

test('isLocalTarget treats loopback as local', async () => {
  assert.equal(await isLocalTarget('127.0.0.1'), true);
  assert.equal(await isLocalTarget('localhost'), true);
});

test('buildLocalSshMenu mentions variable', async () => {
  const menu = await buildLocalSshMenu({ MSB_LOCAL_SSH_HOST: '10.0.0.1' });
  assert.match(menu.text, /10\.0\.0\.1/);
  assert.match(menu.text, /MSB_LOCAL_SSH_HOST/);
  const flat = menu.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(flat.includes('ext:ssh:local:edit'));
  assert.ok(flat.includes('ext:ssh:local:clear'));
  assert.ok(flat.includes('settings:ssh'));
});

test('isValidBotId and buildAddTokenFileBody', () => {
  assert.equal(isValidBotId('sales'), true);
  assert.equal(isValidBotId('default'), true);
  assert.equal(isValidBotId('bad id'), false);
  assert.equal(isValidBotId(''), false);
  assert.match(buildAddTokenFileBody({ botToken: '123:ABC' }), /^BOT_TOKEN=123:ABC\n$/);
  assert.match(
    buildAddTokenFileBody({ botToken: '123:ABC', ownerUserId: 42 }),
    /OWNER_USER_ID=42/,
  );
});

test('local multibot add/remove via mocked bot-ctl', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-local-ssh-add-'));
  await fs.mkdir(path.join(home, '.msb', 'bots', 'default'), { recursive: true });

  const env = {
    MSB_LOCAL_SSH_HOST: '127.0.0.1',
    MSB_LOCAL_SSH_FORCE_LOCAL: '1',
    SYNC_URL: 'https://constructor.example/api/sync',
  };

  const calls = [];
  const execFile = async (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    if (args.includes('add')) {
      const tokenFile = args[args.length - 1];
      const body = await fs.readFile(tokenFile, 'utf8');
      assert.match(body, /BOT_TOKEN=123456:AAAtesttokenvaluehere/);
      assert.match(body, /OWNER_USER_ID=99/);
      await fs.unlink(tokenFile);
      await fs.mkdir(path.join(home, '.msb', 'bots', 'sales'), { recursive: true });
      return { stdout: 'ok botId=sales\n', stderr: '' };
    }
    if (args.includes('remove')) {
      await fs.rm(path.join(home, '.msb', 'bots', 'sales'), { recursive: true, force: true });
      return { stdout: 'ok removed=sales\n', stderr: '' };
    }
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
  };

  const bad = await handleLocalConstructorRequest(
    'https://constructor.example/api/iia/multibot/add',
    { method: 'POST', body: JSON.stringify({ botId: 'default', botToken: '123456:AAAtesttokenvaluehere' }) },
    { env, home, execFile },
  );
  assert.equal(bad.status, 400);

  const addRes = await handleLocalConstructorRequest(
    'https://constructor.example/api/iia/multibot/add',
    {
      method: 'POST',
      body: JSON.stringify({
        botId: 'sales',
        botToken: '123456:AAAtesttokenvaluehere',
        ownerUserId: 99,
      }),
    },
    { env, home, execFile },
  );
  const addBody = await addRes.json();
  assert.equal(addRes.status, 200);
  assert.equal(addBody.ok, true);
  assert.equal(addBody.botId, 'sales');
  assert.equal(addBody.local_ssh, true);
  assert.equal(calls[0].args[2], 'add');
  assert.equal(calls[0].args[3], 'sales');

  const rmRes = await handleLocalConstructorRequest(
    'https://constructor.example/api/iia/multibot/remove',
    { method: 'POST', body: JSON.stringify({ botId: 'sales' }) },
    { env, home, execFile },
  );
  const rmBody = await rmRes.json();
  assert.equal(rmRes.status, 200);
  assert.equal(rmBody.ok, true);
  assert.equal(calls[1].args[2], 'remove');
});
