import test from 'node:test';
import assert from 'node:assert/strict';
import { PrototypeQueue, RejectedSteer } from './queue.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function fixture({ supportsSteer = true, steer = async () => {} } = {}) {
  const starts = [], corrections = [], interrupts = [], events = [], gates = new Map();
  const driver = {
    async start(text) {
      const id = `turn-${starts.length + 1}`;
      const done = deferred(); gates.set(id, done);
      starts.push({ id, text });
      return { id, done: done.promise };
    },
    async interrupt(id) { interrupts.push(id); gates.get(id)?.resolve({ status: 'interrupted' }); },
    ...(supportsSteer ? { async steer(id, text) { corrections.push({ id, text }); return steer(id, text); } } : {}),
  };
  const queue = new PrototypeQueue({ driver, scope: 'owner/topic', notify: row => events.push(row) });
  const send = (id, text = id) => queue.submit({ id, text });
  return { queue, send, starts, corrections, interrupts, events, gates };
}

test('queued text stays FIFO; one selected correction reaches the same active turn once', async () => {
  const f = fixture();
  f.send('first'); await settle();
  f.send('correction', 'restrict the scope'); f.send('next', 'afterwards');
  assert.deepEqual(f.starts.map(x => x.text), ['first']);
  assert.deepEqual(await f.queue.steer('correction'), { status: 'accepted' });
  assert.deepEqual(f.corrections, [{ id: 'turn-1', text: 'restrict the scope' }]);
  assert.deepEqual(f.queue.pending.map(x => x.id), ['next']);
  assert.deepEqual(await f.queue.steer('correction'), { status: 'not-queued' });
  f.gates.get('turn-1').resolve({ status: 'completed' }); await settle();
  assert.deepEqual(f.starts.map(x => x.text), ['first', 'afterwards']);
  f.gates.get('turn-2').resolve({ status: 'completed' }); await settle();
  await f.queue.close();
});

test('known rejection keeps the item in its original position for the next turn', async () => {
  const f = fixture({ steer: async () => { throw new RejectedSteer('turn completed'); } });
  f.send('first'); await settle(); f.send('correction'); f.send('after');
  assert.deepEqual(await f.queue.steer('correction'), { status: 'rejected' });
  assert.deepEqual(f.queue.pending.map(x => x.id), ['correction', 'after']);
  f.gates.get('turn-1').resolve({ status: 'completed' }); await settle();
  assert.deepEqual(f.starts.map(x => x.text), ['first', 'correction']);
  f.gates.get('turn-2').resolve({ status: 'completed' }); await settle();
  assert.deepEqual(f.starts.map(x => x.text), ['first', 'correction', 'after']);
  f.gates.get('turn-3').resolve({ status: 'completed' }); await settle();
  await f.queue.close();
});

test('unknown acknowledgement never replays a potentially accepted correction', async () => {
  const f = fixture({ steer: async () => { throw Error('connection dropped'); } });
  f.send('first'); await settle(); f.send('correction'); f.send('after');
  assert.deepEqual(await f.queue.steer('correction'), { status: 'unknown' });
  f.gates.get('turn-1').resolve({ status: 'completed' }); await settle();
  assert.deepEqual(f.starts.map(x => x.text), ['first']);
  assert.deepEqual(f.queue.pending.map(x => [x.id, x.state]), [['correction', 'unknown'], ['after', 'queued']]);
  assert.deepEqual((await f.queue.stop()).cleared, ['correction', 'after']);
  await f.queue.close();
});

test('/stop clears waiting items and late steer acknowledgement cannot restart them', async () => {
  const reply = deferred();
  const f = fixture({ steer: () => reply.promise });
  f.send('first'); await settle(); f.send('correction'); f.send('after');
  const steering = f.queue.steer('correction'); await settle();
  assert.deepEqual(await f.queue.stop(), { cleared: ['correction', 'after'], active: true });
  reply.resolve();
  assert.deepEqual(await steering, { status: 'stopped' });
  await settle();
  assert.deepEqual(f.interrupts, ['turn-1']);
  assert.deepEqual(f.starts.map(x => x.text), ['first']);
  assert.equal(f.queue.pending.length, 0);
  await f.queue.close();
});

test('a turn completing while steer is pending does not release the queue early', async () => {
  const reply = deferred();
  const f = fixture({ steer: () => reply.promise });
  f.send('first'); await settle(); f.send('correction'); f.send('after');
  const steering = f.queue.steer('correction'); await settle();
  f.gates.get('turn-1').resolve({ status: 'completed' }); await settle();
  assert.deepEqual(f.starts.map(x => x.text), ['first']);
  reply.reject(new RejectedSteer('already finished'));
  assert.deepEqual(await steering, { status: 'rejected' }); await settle();
  assert.deepEqual(f.starts.map(x => x.text), ['first', 'correction']);
  await f.queue.stop(); await settle(); await f.queue.close();
});

test('unsupported providers keep their regular queue and reject steering', async () => {
  const f = fixture({ supportsSteer: false });
  f.send('claude-first'); await settle(); f.send('claude-next');
  assert.deepEqual(await f.queue.steer('claude-next'), { status: 'unsupported' });
  assert.deepEqual(f.queue.pending.map(x => x.id), ['claude-next']);
  f.gates.get('turn-1').resolve({ status: 'completed' }); await settle();
  assert.deepEqual(f.starts.map(x => x.text), ['claude-first', 'claude-next']);
  f.gates.get('turn-2').resolve({ status: 'completed' }); await settle(); await f.queue.close();
});

test('a different chat/topic or repeated identifier cannot steer this session', async () => {
  const f = fixture();
  f.send('first'); await settle(); f.send('next');
  assert.deepEqual(await f.queue.steer('next', 'another/topic'), { status: 'scope-mismatch' });
  assert.throws(() => f.queue.submit({ id: 'foreign', text: 'foreign', scope: 'another/topic' }), /scope mismatch/);
  assert.throws(() => f.send('next'), /duplicate/);
  assert.deepEqual(f.corrections, []);
  await f.queue.stop(); await settle(); await f.queue.close();
});

test('two simultaneous selections send only one steering request', async () => {
  const reply = deferred();
  const f = fixture({ steer: () => reply.promise });
  f.send('first'); await settle(); f.send('correction');
  const first = f.queue.steer('correction'); await settle();
  assert.deepEqual(await f.queue.steer('correction'), { status: 'not-queued' });
  assert.equal(f.corrections.length, 1);
  reply.resolve();
  assert.deepEqual(await first, { status: 'accepted' });
  await f.queue.stop(); await settle(); await f.queue.close();
});

test('repeated /stop shares one native interrupt while it is pending', async () => {
  const pending = deferred(), done = deferred(), interrupts = [];
  const queue = new PrototypeQueue({ driver: {
    async start() { return { id: 'turn-1', done: done.promise }; },
    async interrupt(id) { interrupts.push(id); await pending.promise; done.resolve({ status: 'interrupted' }); },
  } });
  queue.submit({ id: 'first', text: 'first' }); await settle();
  const first = queue.stop(), second = queue.stop(); await settle();
  assert.deepEqual(interrupts, ['turn-1']);
  pending.resolve(); await Promise.all([first, second]); await settle();
  assert.equal(queue.active, null);
  await queue.close();
});

test('/stop while turn/start is pending interrupts it once its identifier arrives', async () => {
  const starting = deferred(), done = deferred(), interrupted = [];
  const queue = new PrototypeQueue({ driver: {
    start: () => starting.promise,
    async interrupt(id) { interrupted.push(id); done.resolve({ status: 'interrupted' }); },
  } });
  queue.submit({ id: 'first', text: 'first' });
  queue.submit({ id: 'next', text: 'next' });
  const stopping = queue.stop();
  starting.resolve({ id: 'turn-pending', done: done.promise });
  assert.deepEqual(await stopping, { cleared: ['next'], active: true });
  await settle();
  assert.deepEqual(interrupted, ['turn-pending']);
  assert.equal(queue.active, null);
  await queue.close();
});

test('an unknown turn/start result fences the queue instead of starting the next message', async () => {
  const start = deferred(), starts = [], events = [];
  let closed = 0;
  const queue = new PrototypeQueue({ driver: {
    start(text) { starts.push(text); return start.promise; },
    async interrupt() {}, async close() { closed++; },
  }, notify: event => events.push(event), stopTimeoutMs: 30 });
  queue.submit({ id: 'first', text: 'first' }); queue.submit({ id: 'next', text: 'next' });
  start.reject(Error('acknowledgement lost')); await settle();
  assert.equal(queue.fenced, true);
  assert.deepEqual(starts, ['first']);
  assert.deepEqual(queue.pending.map(item => item.id), ['next']);
  assert.deepEqual(await queue.stop(), { cleared: ['next'], active: false, status: 'unknown' });
  assert.equal(closed, 1);
  assert.throws(() => queue.submit({ id: 'later', text: 'later' }), /fenced/);
});

test('/stop fences and closes an unacknowledged start without launching queued work', async () => {
  const start = deferred(), starts = [];
  let closed = 0;
  const queue = new PrototypeQueue({ driver: {
    start(text) { starts.push(text); return start.promise; },
    async interrupt() {}, async close() { closed++; start.reject(Error('closed')); },
  }, stopTimeoutMs: 20 });
  queue.submit({ id: 'first', text: 'first' }); queue.submit({ id: 'next', text: 'next' });
  assert.deepEqual(await queue.stop(), { cleared: ['next'], active: true, status: 'unknown' });
  await settle();
  assert.equal(closed, 1);
  assert.deepEqual(starts, ['first']);
  assert.equal(queue.closed, true);
});

test('failed interrupt cannot release the active turn or launch another queued turn', async () => {
  const done = deferred(), starts = [];
  let closed = 0;
  const queue = new PrototypeQueue({ driver: {
    async start(text) { starts.push(text); return { id: 'turn-1', done: done.promise }; },
    async interrupt() { throw Error('lost interrupt response'); },
    async close() { closed++; done.reject(Error('connection closed')); },
  }, stopTimeoutMs: 20 });
  queue.submit({ id: 'first', text: 'first' }); await settle();
  queue.submit({ id: 'next', text: 'next' });
  assert.deepEqual(await queue.stop(), { cleared: ['next'], active: true, status: 'unknown' });
  await settle();
  assert.equal(closed, 1);
  assert.deepEqual(starts, ['first']);
  assert.equal(queue.fenced, true);
});

test('missing completion after interrupt is bounded and closes the session', async () => {
  const done = deferred(); let closed = 0;
  const queue = new PrototypeQueue({ driver: {
    async start() { return { id: 'turn-1', done: done.promise }; },
    async interrupt() {}, async close() { closed++; done.reject(Error('connection closed')); },
  }, stopTimeoutMs: 20 });
  queue.submit({ id: 'first', text: 'first' }); await settle();
  assert.deepEqual(await queue.stop(), { cleared: [], active: true, status: 'unknown' });
  assert.equal(closed, 1);
});

test('failed or hanging driver cleanup is reported instead of hidden', async () => {
  for (const close of [() => { throw Error('cleanup failed'); }, async () => { throw Error('cleanup failed'); },
    () => new Promise(() => {})]) {
    const start = deferred();
    const queue = new PrototypeQueue({ driver: { start: () => start.promise, async interrupt() {}, close }, stopTimeoutMs: 10 });
    queue.submit({ id: 'first', text: 'first' });
    assert.deepEqual(await queue.stop(), { cleared: [], active: true, status: 'unknown', cleanup: 'unconfirmed' });
    await assert.rejects(queue.close(), /cleanup not confirmed/);
  }
});
