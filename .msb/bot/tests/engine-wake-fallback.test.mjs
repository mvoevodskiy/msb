// Reference: old blob 73aa9e7e XSA, lines 49547-49575.
// Synthetic helper responses only; no system service or user profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wakeWithFallback } from '../src/engines/wake.mjs';

function fixture({ wake = [false], resumed = true, caps = {}, result = { result: 'done', code: 'OK' } } = {}) {
  const calls = [];
  const sleep = {
    wakeAttempt: async () => { calls.push('wake'); return { ok: wake.shift() ?? false, revision: '1:2:3' }; },
    resumeIfAwake: async () => { calls.push('resume'); return resumed; },
  };
  const io = {
    snapshot: async () => ({ helper: 'msb-engine', host_ready: true, actions: ['enable-msb'], ...caps }),
    submit: async (action, params, env, options) => {
      calls.push({ action, params, signal: options.signal }); return { id: 'fixture-id' };
    },
    wait: async (id, options) => { calls.push({ id, signal: options.signal }); return result; },
  };
  return { calls, sleep, io };
}

test('successful local wake leaves the system service untouched', async () => {
  const f = fixture({ wake: [true] });
  assert.equal(await wakeWithFallback(f.sleep, { botId: 'default', io: f.io }), true);
  assert.deepEqual(f.calls, ['wake']);
});

test('local wake failure uses the existing system action and resumes after its result', async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  assert.equal(await wakeWithFallback(f.sleep, { botId: 'selected', io: f.io, signal }), true);
  assert.deepEqual(f.calls, ['wake', { action: 'enable-msb', params: { bot_id: 'selected', sleep_revision: '1:2:3' }, signal },
    { id: 'fixture-id', signal }, 'resume']);
});

test('a failed local wake without an observed revision never publishes an unconditional wake', async () => {
  const f = fixture();
  f.sleep.wakeAttempt = async () => ({ ok: false, revision: null });
  assert.equal(await wakeWithFallback(f.sleep, { botId: 'default', io: f.io }), false);
  assert.deepEqual(f.calls, []);
});

test('missing capabilities, host hold or an active request never start a competing operation', async () => {
  for (const caps of [{ helper: null }, { actions: [] }, { host_ready: false }, { hold: true },
    { last: { result: 'running', at: new Date().toISOString() } }]) {
    const f = fixture({ caps });
    assert.equal(await wakeWithFallback(f.sleep, { botId: 'default', io: f.io }), false);
    assert.deepEqual(f.calls, ['wake']);
  }
});

test('a stale running result cannot block wake forever', async () => {
  const f = fixture({ caps: { last: { result: 'running', at: '2020-01-01T00:00:00Z' } } });
  assert.equal(await wakeWithFallback(f.sleep, { botId: 'default', io: f.io }), true);
});

test('a refused, failed or missing helper result never reports wake success', async () => {
  for (const result of [{ result: 'refused', code: 'NOT_INSTALLED' },
    { result: 'failed', code: 'FAILED' }, null]) {
    const f = fixture({ result });
    assert.equal(await wakeWithFallback(f.sleep, { botId: 'default', io: f.io }), false);
    assert.equal(f.calls.filter(call => call === 'wake').length, 1);
  }
});

test('an exception or unresolved marker after the helper response is still failure', async () => {
  const failedPublish = fixture();
  failedPublish.io.submit = async () => { throw Error('busy'); };
  assert.equal(await wakeWithFallback(failedPublish.sleep, { botId: 'default', io: failedPublish.io }), false);
  const markerStillThere = fixture({ resumed: false });
  assert.equal(await wakeWithFallback(markerStillThere.sleep, { botId: 'default', io: markerStillThere.io }), false);
});
