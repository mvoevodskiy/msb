import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { runCodexCompaction } from '../compact-codex.mjs';

const threadId = '0199a213-81c0-7800-8aa1-bbab2a035a53';
function fakeServer(mode) {
  const received = [];
  let child;
  const spawnProcess = () => {
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = () => setImmediate(() => child.emit('close', 0));
    const emit = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const message = JSON.parse(String(chunk).trim());
      received.push(message);
      if (message.id === 1) setImmediate(() => emit({ id: 1, result: {} }));
      if (message.id === 2) setImmediate(() => emit({ id: 2, result: { thread: { id: mode === 'wrong-session' ? 'another' : threadId } } }));
      if (message.id === 3) setImmediate(() => {
        emit({ id: 3, result: {} });
        if (mode === 'success' || mode === 'wrong-turn') {
          emit({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: { type: 'contextCompaction' } } });
          emit({ method: 'turn/completed', params: { threadId, turn: { id: mode === 'success' ? 'turn-1' : 'turn-2', status: 'completed' } } });
        } else if (mode === 'failed') {
          emit({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'failed' } } });
        }
      });
      done();
    } });
    child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0)));
    return child;
  };
  return { spawnProcess, received };
}

test('Codex reports success only after the same thread and compaction turn complete', async () => {
  const fake = fakeServer('success');
  const result = await runCodexCompaction({ command: 'fake', threadId, model: 'fixture-model', effort: 'max', spawnProcess: fake.spawnProcess });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(fake.received.find((m) => m.id === 2).params, {
    threadId, excludeTurns: true, model: 'fixture-model', config: { model_reasoning_effort: 'max' },
  });
  assert.deepEqual(fake.received.find((m) => m.id === 3).params, { threadId });
});

test('an acknowledgement or unrelated completed turn never claims compaction succeeded', async () => {
  for (const mode of ['ack-only', 'wrong-turn']) {
    const fake = fakeServer(mode);
    const keepAlive = setTimeout(() => {}, 500);
    const result = await runCodexCompaction({ command: 'fake', threadId, timeoutMs: 30, spawnProcess: fake.spawnProcess });
    clearTimeout(keepAlive);
    assert.equal(result.ok, false);
    assert.match(result.error, /вовремя/);
  }
});

test('failed compaction and mismatched or switched sessions do not report success', async () => {
  const failed = fakeServer('failed');
  assert.equal((await runCodexCompaction({ command: 'fake', threadId, spawnProcess: failed.spawnProcess })).ok, false);
  const wrong = fakeServer('wrong-session');
  assert.match((await runCodexCompaction({ command: 'fake', threadId, spawnProcess: wrong.spawnProcess })).error, /исходную сессию/);
  assert.equal(wrong.received.some((m) => m.id === 3), false);
  const switched = fakeServer('success');
  const stale = await runCodexCompaction({ command: 'fake', threadId, spawnProcess: switched.spawnProcess, isCurrent: async () => false });
  assert.equal(stale.aborted, true);
  assert.equal(switched.received.some((m) => m.id === 3), false);
});

test('abort closes the Codex process without reporting success', async () => {
  const fake = fakeServer('ack-only');
  const controller = new AbortController();
  const promise = runCodexCompaction({ command: 'fake', threadId, signal: controller.signal, spawnProcess: fake.spawnProcess });
  setTimeout(() => controller.abort(), 20);
  assert.equal((await promise).aborted, true);
});
