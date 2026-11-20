/** Regression: fake Telegram and an active fake turn, temporary profile only. */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const engineUrl = new URL('../../src/engines/client.mjs', import.meta.url).href;
const engine = await import(engineUrl);
mock.module(engineUrl, { namedExports: { ...engine, engineStatusSnapshot: async () => null } });
const { fixture } = await import('../helpers/menu-fixture.mjs');
const { withFileLock } = await import('../../shared/file-lock.mjs');
const { loadState } = await import('../../src/state.mjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

for (const overlay of [false, true]) {
  for (const input of ['command', 'command-with-username', 'reply']) {
    test(`${overlay ? 'overlay and core' : 'core'} accept ${input} while the marker lock is held`, { timeout: 8000 }, async t => {
      const started = gate(), interrupted = gate();
      const f = await fixture(t, async ({ signal }) => {
        started.resolve();
        return new Promise(resolve => signal.addEventListener('abort', () => {
          interrupted.resolve(); resolve({ ok: false, error: 'aborted' });
        }, { once: true }));
      }, { overlay });
      const before = (await loadState()).state;
      await f.message('synthetic active turn');
      await started.promise;
      const marker = path.join(process.env.MSB_RUNTIME_ROOT, 'engine', 'sleep.default');
      await fs.mkdir(path.dirname(marker), { recursive: true });
      await fs.writeFile(marker, 'synthetic');
      const locked = gate(), release = gate();
      const holder = withFileLock(marker, async () => { locked.resolve(); await release.promise; });
      await locked.promise;
      let request;
      try {
        request = input === 'reply'
          ? f.bot.handleUpdate({ message: { message_id: 100, text: 'стоп', from: { id: 42 },
              chat: { id: 42 }, reply_to_message: { message_id: 1 } } })
          : f.message(input === 'command' ? '/stop' : '/stop@fixture_bot');
        const stoppedWhileLocked = await Promise.race([interrupted.promise.then(() => true), delay(400).then(() => false)]);
        assert.equal(stoppedWhileLocked, true, 'The active turn must be interrupted before the marker lock is released');
      } finally {
        release.resolve();
        await holder;
        if (request) await request;
      }
      assert.equal(await Promise.race([interrupted.promise.then(() => true), delay(1000).then(() => false)]), true);
      assert.ok(f.messages.includes('Моя остановочка ✋🏽⛔️'));
      assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic');
      const after = (await loadState()).state;
      assert.equal(after.ccSessionId, before.ccSessionId);
      assert.equal(after.extAuthBypass, before.extAuthBypass);
    });
  }
}

const auth = await import('../../../../overlay/bot/ext/auth.mjs');
const localIp = await import('../../../../overlay/bot/ext/local-ssh.mjs');
async function markPaused() {
  const marker = path.join(process.env.MSB_RUNTIME_ROOT, 'engine', 'sleep.default');
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, 'synthetic');
  return marker;
}
function pendingForm(t, kind) {
  auth.clearPendingAuth(42); localIp.clearPendingLocalIp(42);
  t.after(() => { auth.clearPendingAuth(42); localIp.clearPendingLocalIp(42); });
  if (kind === 'auth') auth.setPendingAuth(42, 'codex', 42);
  else localIp.setPendingLocalIp(42, { chatId: 42 });
  return () => kind === 'auth'
    ? auth.getPendingAuth(42, { chatId: 42, includeExpired: true })
    : localIp.getPendingLocalIp(42, { chatId: 42, includeExpired: true });
}
for (const kind of ['auth', 'ip']) for (const paused of [false, true]) {
  test(`${paused ? 'paused' : 'awake'} /stop preserves existing ${kind} form routing`, async t => {
    const f = await fixture(t);
    const pending = pendingForm(t, kind);
    let holder, request;
    const locked = gate(), release = gate();
    try {
      if (paused) {
        const marker = await markPaused();
        holder = withFileLock(marker, async () => { locked.resolve(); await release.promise; });
        await locked.promise;
      }
      request = f.message('/stop');
      const completed = await Promise.race([request.then(() => true), delay(400).then(() => false)]);
      assert.equal(completed, true, 'The command must finish before the marker lock is released');
      assert.equal(Boolean(pending()), paused, 'paused bypass preserves the form; awake slash cancels it');
    } finally { release.resolve(); if (holder) await holder; if (request) await request; }
  });
}
for (const kind of ['auth', 'ip']) {
  test(`a paused reply стоп retains priority of the open ${kind} form`, async t => {
    const started = gate(), interrupted = gate();
    const f = await fixture(t, async ({ signal }) => {
      started.resolve();
      return new Promise(resolve => signal.addEventListener('abort', () => {
        interrupted.resolve(); resolve({ ok: false, error: 'aborted' });
      }, { once: true }));
    });
    await f.message('synthetic active turn'); await started.promise;
    const pending = pendingForm(t, kind);
    await markPaused();
    await f.bot.handleUpdate({ message: { message_id: 100, text: 'стоп', from: { id: 42 },
      chat: { id: 42 }, reply_to_message: { message_id: 1 } } });
    assert.equal(await Promise.race([interrupted.promise.then(() => true), delay(100).then(() => false)]), false);
    assert.equal(pending(), null);
    assert.ok(f.messages.some(text => kind === 'auth' ? text.includes('Для Codex секрет') : text.includes('Не похоже на IPv4')));
    await f.message('/stop');
    await interrupted.promise;
  });
}
test('another user cannot stop an active paused Codex turn', async t => {
  const started = gate(), interrupted = gate();
  const f = await fixture(t, async ({ signal }) => {
    started.resolve();
    return new Promise(resolve => signal.addEventListener('abort', () => {
      interrupted.resolve(); resolve({ ok: false, error: 'aborted' });
    }, { once: true }));
  });
  await f.message('synthetic active turn'); await started.promise;
  const marker = await markPaused(), locked = gate(), release = gate();
  const holder = withFileLock(marker, async () => { locked.resolve(); await release.promise; });
  await locked.promise;
  try {
    await f.message('/stop', 43);
    assert.equal(await Promise.race([interrupted.promise.then(() => true), delay(100).then(() => false)]), false);
    await f.message('/stop');
    assert.equal(await Promise.race([interrupted.promise.then(() => true), delay(400).then(() => false)]), true);
  } finally { release.resolve(); await holder; }
});
test('a stop lookalike remains blocked during Codex pause', async t => {
  let turns = 0;
  const f = await fixture(t, async () => { turns++; return { ok: true, text: 'synthetic' }; });
  await markPaused(); await f.message('/stopper');
  assert.equal(turns, 0);
  assert.ok(f.messages.some(text => text.includes('Codex на паузе')));
});

test('paused reply стоп still belongs to a core environment form', async t => {
  const started = gate(), interrupted = gate();
  const f = await fixture(t, async ({ signal }) => {
    started.resolve();
    return new Promise(resolve => signal.addEventListener('abort', () => {
      interrupted.resolve(); resolve({ ok: false, error: 'aborted' });
    }, { once: true }));
  });
  await f.message('synthetic active turn'); await started.promise;
  await f.callback('settings:env:quick:TEST_STOP_FORM');
  await markPaused();
  await f.bot.handleUpdate({ message: { message_id: 100, text: 'стоп', from: { id: 42 },
    chat: { id: 42 }, reply_to_message: { message_id: 1 } } });
  assert.equal(await Promise.race([interrupted.promise.then(() => true), delay(100).then(() => false)]), false);
  await f.callback('settings:env:skip-comment', 42, { messageId: f.messages.length });
  const { readEnvMap } = await import('../../src/env/store.mjs');
  assert.equal((await readEnvMap()).map.get('TEST_STOP_FORM'), 'стоп');
  await f.message('/stop'); await interrupted.promise;
});

test('an unreadable marker still reaches the selected Codex stop route', async t => {
  const started = gate(), interrupted = gate();
  const f = await fixture(t, async ({ signal }) => {
    started.resolve();
    return new Promise(resolve => signal.addEventListener('abort', () => {
      interrupted.resolve(); resolve({ ok: false, error: 'aborted' });
    }, { once: true }));
  });
  await f.message('synthetic active turn'); await started.promise;
  const marker = await markPaused(), lstat = fs.lstat;
  const denied = t.mock.method(fs, 'lstat', async (file, ...args) => String(file) === marker
    ? Promise.reject(Object.assign(Error('synthetic denied marker'), { code: 'EACCES' }))
    : lstat(file, ...args));
  try {
    await f.message('/stop');
    assert.equal(await Promise.race([interrupted.promise.then(() => true), delay(400).then(() => false)]), true);
  } finally { denied.mock.restore(); }
  assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic');
});
