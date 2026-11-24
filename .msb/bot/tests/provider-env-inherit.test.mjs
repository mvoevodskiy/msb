/**
 * Read-only AI key inherit from bots/default for additional bots.
 * [Contract](./reference/parity-env-provider-inherit-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hasClaudeAuth } from '../src/state.mjs';
import { isSetupMode } from '../src/telegram/auth.mjs';
import {
  peekEnvKeyChain,
  readEnvKeyChain,
  resolveClaudeCreds,
} from '../shared/provider-env-inherit.mjs';

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-inherit-'));
  const root = path.join(home, '.msb');
  await fs.mkdir(path.join(root, 'bots/default'), { recursive: true });
  await fs.mkdir(path.join(root, 'bots/extra'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'bots/default/.env'),
    [
      'CLAUDE_CODE_OAUTH_TOKEN=oauth-from-default-token',
      'CURSOR_API_KEY=cursor-from-default-abcdef',
      'BOT_TOKEN=default-telegram-token',
    ].join('\n') + '\n',
    { mode: 0o600 },
  );
  await fs.writeFile(path.join(root, 'bots/extra/.env'), 'BOT_TOKEN=extra-telegram-token\n', { mode: 0o600 });
  return { home, root, extra: { HOME: home, MSB_BOT_ID: 'extra' }, main: { HOME: home, MSB_BOT_ID: 'default' } };
}

test('additional bot peeks Claude oauth from default without process env', async () => {
  const { home, extra } = await fixture();
  assert.equal(peekEnvKeyChain('CLAUDE_CODE_OAUTH_TOKEN', extra, home), 'oauth-from-default-token');
  assert.equal(await readEnvKeyChain('CURSOR_API_KEY', extra, home), 'cursor-from-default-abcdef');
  assert.equal(resolveClaudeCreds(extra, home).ok, true);
  assert.equal(hasClaudeAuth(extra), true);
  assert.equal(isSetupMode({}, extra), false);
});

test('own override beats default inherit', async () => {
  const { home, root, extra } = await fixture();
  await fs.writeFile(
    path.join(root, 'bots/extra/.env'),
    'BOT_TOKEN=extra-telegram-token\nCLAUDE_CODE_OAUTH_TOKEN=oauth-extra-own\n',
    { mode: 0o600 },
  );
  assert.equal(peekEnvKeyChain('CLAUDE_CODE_OAUTH_TOKEN', extra, home), 'oauth-extra-own');
  assert.equal(resolveClaudeCreds(extra, home).oauth, 'oauth-extra-own');
});

test('BOT_TOKEN is not inherited from default', async () => {
  const { home, extra } = await fixture();
  assert.equal(await readEnvKeyChain('BOT_TOKEN', extra, home), 'extra-telegram-token');
  assert.equal(peekEnvKeyChain('BOT_TOKEN', extra, home), 'extra-telegram-token');
});

test('default bot does not recurse into itself for inherit step', async () => {
  const { home, main } = await fixture();
  assert.equal(peekEnvKeyChain('CLAUDE_CODE_OAUTH_TOKEN', main, home), 'oauth-from-default-token');
  assert.equal(hasClaudeAuth(main), true);
});

test('missing keys stay empty without inventing auth', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-inherit-empty-'));
  await fs.mkdir(path.join(home, '.msb/bots/extra'), { recursive: true });
  const env = { HOME: home, MSB_BOT_ID: 'extra' };
  assert.equal(resolveClaudeCreds(env, home).ok, false);
  assert.equal(hasClaudeAuth(env), false);
  assert.equal(isSetupMode({}, env), true);
});
