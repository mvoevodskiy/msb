import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { createSteerChannel } from '../src/agent/steer-channel.mjs';

function fixture(timeoutMs = 100) {
  const sent = [], notifications = [];
  const stream = new Duplex({ read() {}, write(chunk, _encoding, callback) {
    sent.push(JSON.parse(chunk.toString())); callback();
  } });
  const channel = createSteerChannel(stream, { onReady: handle => notifications.push(handle), timeoutMs });
  return { channel, stream, sent, notifications, receive: value => stream.push(JSON.stringify(value) + '\n') };
}
const turn = { type: 'ready', threadId: 'thread-fixture', turnId: 'turn-fixture' };

test('readiness binds the correction to its native thread and turn', async () => {
  const f = fixture(); f.receive(turn); await new Promise(resolve => setImmediate(resolve));
  const handle = f.notifications.at(-1);
  const sent = handle.steer('fixture correction');
  assert.deepEqual(f.sent[0], { type: 'steer', id: '1', threadId: turn.threadId, turnId: turn.turnId, text: 'fixture correction' });
  f.receive({ type: 'result', id: '1', status: 'accepted' });
  assert.deepEqual(await sent, { status: 'accepted' });
  f.channel.close(); assert.equal(handle.active, false);
});

test('closed or replaced handles cannot send a correction to a later turn', async () => {
  const f = fixture(); f.receive(turn); await new Promise(resolve => setImmediate(resolve));
  const stale = f.notifications.at(-1);
  f.receive({ ...turn, turnId: 'later' }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await stale.steer('old'), { status: 'unavailable' });
  assert.equal(f.sent.length, 0);
  f.receive({ type: 'closed' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.notifications.at(-1), null);
  f.channel.close();
});

test('lost or malformed acknowledgements never become an automatic retry', async () => {
  const f = fixture(15); f.receive(turn); await new Promise(resolve => setImmediate(resolve));
  const handle = f.notifications.at(-1);
  const first = handle.steer('one');
  f.receive({ type: 'result', id: '1', status: 'unexpected' });
  assert.deepEqual(await first, { status: 'unknown' });
  assert.deepEqual(await handle.steer('two'), { status: 'unknown' });
  assert.equal(f.sent.length, 2);
  f.channel.close();
});

test('closing the pipe while a request is pending resolves it as unknown', async () => {
  const f = fixture(); f.receive(turn); await new Promise(resolve => setImmediate(resolve));
  const result = f.notifications.at(-1).steer('fixture');
  f.stream.push(null);
  assert.deepEqual(await result, { status: 'unknown' });
  assert.equal(f.notifications.at(-1), null);
  f.channel.close();
});
