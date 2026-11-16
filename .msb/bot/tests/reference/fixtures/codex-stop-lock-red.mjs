/** RED diagnostic: fake Telegram and an active fake turn, temporary profile only. */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const engineUrl = new URL('../../../src/engines/client.mjs', import.meta.url).href;
const engine = await import(engineUrl);
mock.module(engineUrl, { namedExports: { ...engine, engineStatusSnapshot: async () => null } });
const { fixture } = await import('../../helpers/menu-fixture.mjs');
const { withFileLock } = await import('../../../shared/file-lock.mjs');
const { loadState } = await import('../../../src/state.mjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

for (const overlay of [false, true]) {
  for (const input of ['command', 'command-with-username', 'reply']) {
    test(`RED: ${overlay ? 'overlay and core' : 'core'} block ${input} while the marker lock is held`, { timeout: 8000 }, async t => {
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
        assert.equal(stoppedWhileLocked, false, 'RED must show the active turn still running while the lock is held');
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
