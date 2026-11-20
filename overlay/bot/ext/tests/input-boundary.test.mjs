import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installUpdateHook } from '../integration/update-hook.mjs';
import { setPendingAuth, getPendingAuth, clearPendingAuth } from '../auth.mjs';
import { setPendingLocalIp, getPendingLocalIp, clearPendingLocalIp } from '../local-ssh.mjs';

async function fixture(t, { failSend = false } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-input-boundary-')), previous = { ...process.env };
  Object.assign(process.env, { HOME: home, MSB_RUNTIME_ROOT: home, MSB_RUNTIME_PROFILE: 'msb', MSB_BOT_ID: 'default', ADMIN_ID: '42' });
  clearPendingAuth(42);clearPendingLocalIp(42);
  let clock = 1_000_000;
  t.mock.method(Date, 'now', () => clock);
  // Never allow a failed-save regression to reach installer/native auth.
  t.mock.method(fs, 'writeFile', async () => { throw Error('fixture refuses all credential writes'); });
  const forwarded = [], notices = [];
  class Harness {
    api = {
      sendMessage: async (chat, text) => { notices.push({ chat, text });if (failSend) throw Error('fixture Telegram unavailable');return { message_id: 1 }; },
      deleteMessage: async () => {}, answerCallbackQuery: async () => {},
    };
    async handleUpdate(update) { if (update.message) forwarded.push(update.message.text); }
  }
  installUpdateHook(Harness, { ADMIN_ID: '42' });
  const bot = new Harness();
  t.after(async () => { clearPendingAuth(42);clearPendingLocalIp(42);for (const key of Object.keys(process.env)) delete process.env[key];Object.assign(process.env, previous);await fs.rm(home, { recursive: true, force: true }); });
  return {
    forwarded, notices, advance(ms) { clock += ms; },
    send: (chat, text) => bot.handleUpdate({ message: { from: { id: 42 }, chat: { id: chat }, message_id: 9, text } }),
    callback: (chat, data) => bot.handleUpdate({ callback_query: { id: 'fixture', from: { id: 42 }, data, message: { message_id: 1, chat: { id: chat } } } }),
  };
}

for (const kind of ['auth', 'ip']) test(`input admission: failed ${kind} expiry warning cannot forward its consumed text`, async t => {
  const f = await fixture(t, { failSend: true });
  if (kind === 'auth') setPendingAuth(42, 'cursor', 101);else setPendingLocalIp(42, { chatId: 101 });
  f.advance(600_001);
  await f.send(101, 'SYNTHETIC_LATE_INPUT_NEVER_FOR_MODEL');
  assert.deepEqual(f.forwarded, []);
  assert.equal(f.notices.length, 1);
});

test('input admission: failed auth save and failed error warning cannot forward the key', async t => {
  const f = await fixture(t, { failSend: true });
  setPendingAuth(42, 'cursor', 101);
  await f.send(101, 'SYNTHETIC_KEY_NEVER_FOR_MODEL');
  assert.deepEqual(f.forwarded, []);
  assert.equal(getPendingAuth(42), null);
});

test('input admission: invalid IP with a failed warning cannot become a model task', async t => {
  const f = await fixture(t, { failSend: true });
  setPendingLocalIp(42, { chatId: 101 });
  await f.send(101, 'not an IP or hostname');
  assert.deepEqual(f.forwarded, []);
});

for (const kind of ['auth', 'ip']) for (const callback of ['menu:settings', 'settings:env', 'settings:pult:password']) {
  test(`input callback scope: ${callback} in another chat preserves the ${kind} input`, async t => {
    const f = await fixture(t);
    if (kind === 'auth') setPendingAuth(42, 'cursor', 101);else setPendingLocalIp(42, { chatId: 101 });
    await f.callback(202, callback);
    assert.equal((kind === 'auth' ? getPendingAuth(42) : getPendingLocalIp(42))?.chatId, 101);
    f.advance(600_001);
    await f.send(101, 'SYNTHETIC_LATE_INPUT_NEVER_FOR_MODEL');
    assert.deepEqual(f.forwarded, []);
    assert.equal(f.notices.length, 1);
  });
}

test('input admission control: an unrelated command still reaches core when no form owns it', async t => {
  const f = await fixture(t, { failSend: true });
  await f.send(202, '/status');
  assert.deepEqual(f.forwarded, ['/status']);assert.deepEqual(f.notices, []);
});


for (const kind of ['auth', 'ip']) test('a slash command in another chat keeps expired ' + kind + ' input scoped to its origin', async t => {
  const f = await fixture(t);
  if (kind === 'auth') setPendingAuth(42, 'cursor', 101);
  else setPendingLocalIp(42, { chatId: 101 });
  f.advance(600_001);
  await f.send(202, '/help');
  const pending = kind === 'auth' ? getPendingAuth : getPendingLocalIp;
  assert.equal(pending(42, { includeExpired: true })?.chatId, 101);
  await f.send(101, 'SYNTHETIC_LATE_INPUT_NEVER_FOR_MODEL');
  assert.deepEqual(f.forwarded, ['/help']);
  assert.equal(f.notices.length, 1);
});
