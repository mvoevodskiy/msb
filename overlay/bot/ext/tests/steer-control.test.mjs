import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { createShimSteerControl } from '../shim/steer-control.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const sent = [], calls = [];
  const stream = new Duplex({ read() {}, write(chunk, _encoding, callback) {
    sent.push(JSON.parse(chunk.toString())); callback();
  } });
  const control = createShimSteerControl(stream);
  const handle = { threadId: 'fixture-thread', turnId: 'fixture-turn', async steer(text) {
    calls.push(text); return { status: 'accepted' };
  } };
  return { control, handle, stream, sent, calls, receive: value => stream.push(JSON.stringify(value) + '\n') };
}

test('only the ready thread and turn receive selected text', async () => {
  const f = fixture(); f.control.ready(f.handle);
  f.receive({ type: 'steer', id: '1', threadId: 'fixture-thread', turnId: 'fixture-turn', text: 'fixture' });
  await settle();
  assert.deepEqual(f.calls, ['fixture']);
  assert.deepEqual(f.sent, [{ type: 'ready', threadId: 'fixture-thread', turnId: 'fixture-turn' },
    { type: 'result', id: '1', status: 'accepted' }]);
  f.control.close();
});

test('stale identifiers or a closed handle cannot reach a later turn', async () => {
  const f = fixture(); f.control.ready(f.handle);
  f.receive({ type: 'steer', id: '1', threadId: 'fixture-thread', turnId: 'old', text: 'fixture' });
  await settle();
  f.control.ready(null);
  f.receive({ type: 'steer', id: '2', threadId: 'fixture-thread', turnId: 'fixture-turn', text: 'fixture' });
  await settle();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.sent.filter(row => row.type === 'result').map(row => row.status), ['rejected', 'rejected']);
  f.control.close();
});

test('exceptions after dispatch are unknown and never automatically repeated', async () => {
  const f = fixture(); let attempts = 0;
  f.handle.steer = async () => { attempts++; throw Error('fixture connection lost'); };
  f.control.ready(f.handle);
  f.receive({ type: 'steer', id: '1', threadId: 'fixture-thread', turnId: 'fixture-turn', text: 'fixture' });
  await settle();
  assert.equal(attempts, 1);
  assert.equal(f.sent.at(-1).status, 'unknown');
  f.control.close();
});
