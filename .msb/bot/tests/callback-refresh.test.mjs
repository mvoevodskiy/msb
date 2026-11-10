import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/menu-fixture.mjs';
import { loadState } from '../src/state.mjs';
import { autoRetry } from '@grammyjs/auto-retry';
import { presentationAwareRetry } from '../src/telegram/presentation-api.mjs';

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

test('callback navigation control: a confirmed settings write still completes after another screen is selected', async t => {
  const f = await fixture(t, undefined, { overlay: false });
  const rename = fs.rename.bind(fs);let entered, release;
  const writing = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  t.mock.method(fs, 'rename', async (from,to) => {
    if (String(to).endsWith('/state.json')) { entered();await hold; }
    return rename(from,to);
  });
  const save = f.callback('settings:limit:set:3');await writing;
  await f.callback('settings:back');const current = f.edits.at(-1);
  release();await save;
  assert.equal((await loadState()).state.dailySpendLimit, 3);
  assert.equal(f.edits.at(-1), current, 'Only the obsolete rendering is suppressed');
});

test('callback delivery control: current ordinary menu updates retain the existing API retry policy', async t => {
  const f = await fixture(t);await f.callback('settings:back');
  const signal = f.editSignals.at(-1);assert.ok(signal);
  let calls = 0;
  const transformer = presentationAwareRetry(autoRetry({ maxRetryAttempts: 1 }));
  const result = await transformer(async () => ++calls === 1
    ? { ok: false, error_code: 429, parameters: { retry_after: 0 } }
    : { ok: true, result: true }, 'editMessageText', {}, signal);
  assert.equal(calls, 2);assert.equal(result.ok, true);
});

for (const target of ['settings:back', 'menu:agent']) test(`status refresh: drain an accepted remote edit before delivering ${target}`, async t => {
  const f = await statusFixture(t), edit = f.bot.api.editMessageText.bind(f.bot.api);
  let accepted, applyRemote, acceptedSignal, remoteText = '', laterText = '', first = true, laterEditStarted = false;
  const sent = new Promise(resolve => { accepted = resolve; });
  t.mock.method(f.bot.api, 'editMessageText', (...args) => {
    if (first) {
      first = false;acceptedSignal = args[4];
      let applied;
      const result = new Promise((resolve,reject) => {
        const abort = () => reject(new DOMException('Client aborted after Telegram accepted the edit', 'AbortError'));
        acceptedSignal?.addEventListener('abort', abort, { once: true });
        applyRemote = () => applied ||= (async () => {
          remoteText = args[2];await edit(...args);resolve();
          acceptedSignal?.removeEventListener('abort', abort);
        })();
      });
      accepted();return result;
    }
    laterEditStarted = true;laterText = args[2];remoteText = args[2];return edit(...args);
  });
  const refresh = f.start();await f.entered;f.release();await sent;
  const read = fs.readFile.bind(fs);let enteredState, releaseState;
  const stateRead = new Promise(resolve => { enteredState = resolve; });
  const gate = new Promise(resolve => { releaseState = resolve; });
  t.mock.method(fs, 'readFile', async (file,...args) => {
    const raw = await read(file,...args);
    if (String(file).endsWith('/state.json') && !String(file).startsWith('/run/')) { enteredState();await gate; }
    return raw;
  });
  const next = f.callback(target);
  try {
    await stateRead;
    assert.equal(acceptedSignal?.aborted || false, false, 'Navigation must not disconnect an already accepted edit');
    releaseState();await new Promise(resolve => setImmediate(resolve));
    assert.equal(laterEditStarted, false, 'A new screen waits for the accepted edit acknowledgement');
    await applyRemote();await f.settle(refresh);await next;
    assert.equal(laterEditStarted, true);assert.equal(remoteText, laterText);
  } finally { releaseState();await applyRemote?.();await f.settle(refresh);await next; }
});
