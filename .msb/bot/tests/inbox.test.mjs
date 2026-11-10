import test from 'node:test';
import assert from 'node:assert/strict';
import { createInbox } from '../src/telegram/inbox.mjs';
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function fixture(run = async () => {}) {
  let now = 0, id = 0;
  const timers = new Map(), entries = [], statuses = [], cancelled = [], errors = [];
  const inbox = createInbox({ run: async entry => { entries.push(entry); await run(entry); },
    status: async (entry, text) => statuses.push({ entry, text }), cancel: async entry => cancelled.push(entry),
    onError: text => errors.push(text), now: () => now,
    setTimer: (fn, delay) => { const key = { id: ++id }; timers.set(key, { at: now + delay, fn }); return key; },
    clearTimer: key => timers.delete(key),
  });
  const item = (text, forward = true, chat = 42, thread = 1) => ({ text, voice: false,
    ctx: { chat: { id: chat }, message: { text, message_thread_id: thread, ...(forward ? { forward_origin: {} } : {}) } } });
  async function advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    await settle();
  }
  return { inbox, item, entries, statuses, timers, errors, cancelled, advance };
}
test('forward collector: silence resets the deadline, but continuous input flushes by 25 seconds', async () => {
  const f = fixture(); f.inbox.push(f.item('1'));
  for (let n = 2; n <= 13; n++) { await f.advance(2000); assert.equal(f.entries.length, 0); f.inbox.push(f.item(String(n))); }
  await f.advance(1000); assert.equal(f.entries.length, 1); assert.equal(f.entries[0].items.length, 13);
  assert.equal(f.timers.size, 0); await f.inbox.shutdown(); assert.deepEqual(f.errors, []);
});
test('forward collector: message 300 flushes inclusively; the next message starts a new batch', async () => {
  const f = fixture(); for (let n = 0; n < 300; n++) f.inbox.push(f.item(String(n)));
  await settle(); assert.equal(f.entries.length, 1); assert.equal(f.entries[0].items.length, 300); assert.equal(f.entries[0].capHit, true);
  f.inbox.push(f.item('next')); await f.advance(2500);
  assert.equal(f.entries.length, 2); assert.equal(f.entries[1].items.length, 1); await f.inbox.shutdown();
});
test('inbox: a rejected run drains into the next entry without overlapping it', async () => {
  const f = fixture(async entry => { if (entry.text === 'bad') throw Error('fixture failure'); });
  f.inbox.push(f.item('bad', false)); f.inbox.push(f.item('good', false, 43)); await settle();
  assert.deepEqual(f.entries.map(e => e.text), ['bad', 'good']); assert.equal(f.errors.length, 1); await f.inbox.shutdown();
});
test('inbox: immediate shutdown fences a worker scheduled but not yet entered; reopen accepts new input', async () => {
  const f = fixture(); f.inbox.push(f.item('never', false)); await f.inbox.shutdown();
  assert.deepEqual(f.entries, []); assert.equal(f.inbox.size, 0);
  f.inbox.open(); f.inbox.push(f.item('after restart', false)); await settle();
  assert.deepEqual(f.entries.map(e => e.text), ['after restart']); await f.inbox.shutdown();
});
test('inbox: collectors from different chats and topics do not mix', async () => {
  const f = fixture(); f.inbox.push(f.item('a', true)); f.inbox.push(f.item('b', true, 43)); f.inbox.push(f.item('c', true, 42, 7));
  await f.advance(2500); assert.deepEqual(f.entries.map(e => e.items.map(i => i.text)), [['a'], ['b'], ['c']]); await f.inbox.shutdown();
});
