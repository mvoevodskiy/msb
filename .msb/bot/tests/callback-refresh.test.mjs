import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/menu-fixture.mjs';

const TASKS = Symbol.for('msb.callbackTasks');
async function statusFixture(t) {
  let releaseResponse = () => {}, call;
  // Failure cleanup also releases the old synchronous implementation, so RED
  // never leaves a 20-second poll or any test process running in real HOME.
  t.after(async () => { releaseResponse();await call?.catch(() => {}); });
  const f = await fixture(t);
  process.env.MSB_OS_ENGINE = 'native';
  const readFile = fs.readFile.bind(fs);
  let request, started, released = false;
  const entered = new Promise(resolve => { started = resolve; });
  releaseResponse = () => { released = true; };
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (String(file) !== '/run/msb-engine/state.json') return readFile(file, ...args);
    if (!request) {
      try { request = JSON.parse(await readFile(path.join(f.home, '.msb/engine/request'), 'utf8'));await fs.unlink(path.join(f.home, '.msb/engine/request')); } catch {}
      if (request) started();
    }
    return JSON.stringify({ helper: 'fixture', msb: { installed: true, bots: [] }, pult: { installed: true, enabled: true, active: true },
      last: request ? { id: request.id, code: released ? 'OK' : 'RUNNING', result: released ? 'done' : 'running' } : null });
  });
  return { ...f, entered, release: releaseResponse, start() { let returned = false;call = f.callback('eng:status').then(() => { returned = true; });return { call, returned: () => returned }; },
    async settle(refresh) { releaseResponse();await Promise.all([refresh.call, ...(f.bot[TASKS] || [])]); } };
}

test('status refresh: callback returns to polling while the helper request is still running', async t => {
  const f = await statusFixture(t), refresh = f.start();
  await f.entered;
  assert.equal(refresh.returned(), true, 'A status read must not block the next /stop or navigation update');
  await f.settle(refresh);
});

for (const [label, target] of [['core settings', 'settings:back'], ['overlay agent', 'menu:agent']]) {
  test(`status refresh: a late helper result cannot overwrite later ${label} navigation`, async t => {
    const f = await statusFixture(t), refresh = f.start();await f.entered;
    await f.callback(target);
    const edits = [...f.edits], messages = [...f.messages];
    await f.settle(refresh);
    assert.deepEqual(f.edits, edits);
    assert.deepEqual(f.messages, messages);
  });
}

test('status refresh: bot shutdown cancels and drains the pending UI read', async t => {
  const f = await statusFixture(t), refresh = f.start();await f.entered;
  await f.bot.stop();
  assert.equal(refresh.returned(), true, 'The callback must already have returned to polling');
  assert.equal(f.bot[TASKS]?.size, 0, 'No background status observer remains after stop');
});
