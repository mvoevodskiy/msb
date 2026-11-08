import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture } from './helpers/menu-fixture.mjs';
import { loadState } from '../src/state.mjs';
import { readEnvMap, setEnvKey } from '../src/env/store.mjs';

const OAUTH = 'sk-ant-oat01-fixture-only-' + 'o'.repeat(40);
const API = 'sk-ant-api03-fixture-only-' + 'a'.repeat(40);
const OPAQUE = 'fixture-legacy-token-' + 'z'.repeat(40);
const INVALID = 'Не похоже на токен. Запусти в терминале: <code>claude setup-token</code>';

for (const [label, token, key] of [
  ['setup-token', OAUTH, 'CLAUDE_CODE_OAUTH_TOKEN'],
  ['API key', API, 'ANTHROPIC_API_KEY'],
  ['legacy opaque token', OPAQUE, 'CLAUDE_CODE_OAUTH_TOKEN'],
]) test(`Claude input: normalize ${label}, store in its existing route and preserve the active provider`, async t => {
  const f = await fixture(t, undefined, { overlay: false });
  const otherKey = key === 'ANTHROPIC_API_KEY' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY';
  await setEnvKey(otherKey, 'fixture-other-existing-credential');
  const before = (await loadState()).state, storeBefore = await fs.readFile(f.storeFile, 'utf8');
  await f.callback('settings:auth:switch-sub');
  await f.message(` \n${token.slice(0, 15)}\t${token.slice(15)} \n`);
  const { map } = await readEnvMap();
  assert.equal(map.get(key), token);
  assert.equal(map.get(otherKey), 'fixture-other-existing-credential');
  assert.equal(process.env[key], token);
  if (key === 'ANTHROPIC_API_KEY') assert.equal(process.env.MSB_ANTHROPIC_API_KEY, token);
  assert.deepEqual((await loadState()).state, { ...before, authMode: 'subscription', hasSubscriptionAuth: true });
  assert.equal(await fs.readFile(f.storeFile, 'utf8'), storeBefore);
  assert.deepEqual(f.restartRequests, [0]);
  assert.deepEqual(f.deleted, [99]);
  assert.equal(f.messages.at(-1), 'Токен сохранён. Перезапускаюсь…');
});

test('Claude input: invalid or blank input is deleted, not stored or dispatched, and valid retry remains possible', async t => {
  const turns = [], f = await fixture(t, async request => { turns.push(request); return { ok: true, text: 'unexpected' }; }, { overlay: false });
  const before = (await loadState()).state;
  await f.callback('settings:auth:switch-sub');
  for (const input of [' \n\t ', 'sk-short', 'x'.repeat(49)]) {
    await f.message(input);
    assert.equal((await readEnvMap()).map.size, 0);
    assert.deepEqual((await loadState()).state, before);
    assert.deepEqual(f.restartRequests, []);
    assert.equal(f.messages.at(-1), INVALID);
    assert.equal(f.messageOptions.at(-1)?.parse_mode, 'HTML');
  }
  assert.deepEqual(f.deleted, [99, 99, 99]);
  assert.deepEqual(turns, []);
  await f.message(OAUTH);
  assert.equal((await readEnvMap()).map.get('CLAUDE_CODE_OAUTH_TOKEN'), OAUTH);
  assert.deepEqual(f.restartRequests, [0]);
});

test('Claude input: Telegram deletion failure does not block invalid retry or a valid save', async t => {
  const f = await fixture(t, undefined, { overlay: false });
  let attempts = 0;
  t.mock.method(f.bot.api, 'deleteMessage', async () => { attempts++; throw Error('fixture deletion denied'); });
  await f.callback('settings:auth:switch-sub');
  await f.message('short');
  assert.equal(f.messages.at(-1), INVALID);
  await f.message(OPAQUE);
  assert.equal(attempts, 2);
  assert.equal((await readEnvMap()).map.get('CLAUDE_CODE_OAUTH_TOKEN'), OPAQUE);
  assert.deepEqual(f.restartRequests, [0]);
});
