import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeSession } from './session.mjs';
import { RpcClient, RpcRejected, RpcUnknown } from './rpc.mjs';
import { assertNoSavedSessions } from './ephemeral.mjs';

function fakeChild({ exited = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = exited ? 0 : null; child.signalCode = null; child.pid = 12345;
  child.unref = () => {};
  const sent = [];
  child.stdin.on('data', chunk => sent.push(JSON.parse(chunk.toString())));
  return { child, sent, receive: row => child.stdout.write(JSON.stringify(row) + '\n') };
}

test('a server request with the same ID cannot acknowledge a steering request', async () => {
  const f = fakeChild();
  const rpc = new RpcClient(f.child, { timeoutMs: 1000 });
  const result = rpc.request('turn/steer', { expectedTurnId: 'turn-1' });
  f.receive({ id: 1, method: 'item/tool/requestUserInput', params: {} });
  assert.equal(f.sent[1].error.code, -32601);
  f.receive({ id: 1, result: { turnId: 'turn-1' } });
  assert.deepEqual(await result, { turnId: 'turn-1' });
  rpc.close();
});

test('disconnection makes an unanswered request unknown, not rejected', async () => {
  const f = fakeChild(); const rpc = new RpcClient(f.child, { timeoutMs: 1000 });
  const pending = assert.rejects(rpc.request('turn/steer', {}), RpcUnknown);
  f.child.emit('close', 1);
  await pending;
  rpc.close();
});

test('a server error is preserved as an error, not silently accepted', async () => {
  const f = fakeChild(); const rpc = new RpcClient(f.child, { timeoutMs: 1000 });
  const pending = assert.rejects(rpc.request('turn/steer', {}), RpcRejected);
  f.receive({ id: 1, error: { code: -32603 } });
  await pending;
  rpc.close();
});

test('disconnect after turn/start rejects the completion waiter', async () => {
  const f = fakeChild();
  const session = new NativeSession(f.child, { timeoutMs: 1000, closeGraceMs: 5, isGroupAlive: () => false });
  session.threadId = 'thread-1';
  const starting = session.start('fixture');
  f.receive({ id: 1, result: { turn: { id: 'turn-1' } } });
  const turn = await starting;
  const done = assert.rejects(turn.done, RpcUnknown);
  f.child.emit('close', 1);
  await done;
  await session.close();
});

test('an exited leader with open pipes is bounded and never signals an unverified group', async () => {
  const f = fakeChild({ exited: true }), signals = [];
  const session = new NativeSession(f.child, { timeoutMs: 1000, closeGraceMs: 5,
    signalGroup: (...args) => signals.push(args) });
  await assert.rejects(session.close(), RpcUnknown);
  assert.deepEqual(signals, []);
  assert.equal(f.child.stdout.destroyed, true);
});

test('a still-owned process group is terminated if it does not exit on stdin close', async () => {
  const f = fakeChild(), signals = [];
  const session = new NativeSession(f.child, { timeoutMs: 1000, closeGraceMs: 5,
    isGroupAlive: () => false,
    signalGroup: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 'SIGKILL') f.child.emit('close', null, signal);
    } });
  await session.close();
  assert.deepEqual(signals, [[12345, 'SIGTERM'], [12345, 'SIGKILL']]);
});

test('closing the leader and its pipes does not hide a surviving process group', async () => {
  const f = fakeChild();
  const session = new NativeSession(f.child, { timeoutMs: 1000, closeGraceMs: 5, isGroupAlive: () => true });
  f.child.emit('close', 0);
  await assert.rejects(session.close(), /group still has running members/);
});

test('ephemeral verification rejects any persisted thread file', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'steer-profile-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assertNoSavedSessions(root);
  const folder = path.join(root, 'sessions/fixture');
  await fs.mkdir(folder, { recursive: true });
  await assertNoSavedSessions(root);
  await fs.writeFile(path.join(folder, 'thread.jsonl'), 'synthetic');
  await assert.rejects(assertNoSavedSessions(root), /retained a session file/);
});
