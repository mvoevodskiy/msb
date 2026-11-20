import test from 'node:test';
import assert from 'node:assert/strict';
import { createInbox, textPrompt } from '../src/telegram/inbox.mjs';

const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function fixture() {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runs = [];
  const inbox = createInbox({ run: async entry => { runs.push(entry); if (entry.text === 'active') await gate; },
    status: async () => {}, cancel: async () => {} });
  const item = (text, { chat = 42, topic = 1, voice = false, status = 900, ...extra } = {}) => ({
    text, voice, status: { message_id: status }, ...extra,
    ctx: { chat: { id: chat }, message: { text, message_thread_id: topic, from: { id: 42 } }, me: { id: 99 } },
  });
  const push = (text, options) => { const entry = item(text, options); inbox.push(entry); return entry; };
  const reserve = (candidate, { chatId = 42, threadId = 1, messageId = 900 } = {}) =>
    inbox.reserveForSteer({ token: candidate.token, chatId, threadId, messageId });
  return { inbox, item, push, reserve, runs, release };
}

test('reservation validates token, chat, topic and current bot status; double clicks fail', async () => {
  const f = fixture(); f.push('active'); await settle(); const item = f.push('queued', { topic: 7, status: 901 });
  const [candidate] = f.inbox.steerCandidates(); assert.equal(candidate.entry, item);
  assert.match(candidate.token, /^[\w-]{16}$/);
  assert.equal(f.reserve(candidate, { chatId: 43, threadId: 7, messageId: 901 }), null);
  assert.equal(f.reserve(candidate, { threadId: 1, messageId: 901 }), null);
  assert.equal(f.reserve(candidate, { threadId: 7, messageId: 900 }), null);
  const handle = f.reserve(candidate, { threadId: 7, messageId: 901 });
  assert.ok(handle?.isCurrent()); assert.equal(f.reserve(candidate, { threadId: 7, messageId: 901 }), null);
  assert.equal(handle.consume(), true); assert.equal(handle.isCurrent(), false); assert.equal(handle.signal.aborted, true);
  assert.equal(handle.consume(), false); assert.equal(f.reserve(candidate, { threadId: 7, messageId: 901 }), null);
  f.release(); await settle(); assert.equal(f.runs.length, 1); await f.inbox.shutdown();
});

test('reservation freezes whole FIFO across completion; release keeps order and voice cache', async () => {
  const f = fixture(); f.push('active'); await settle(); f.push('first', { chat: 43 });
  const voice = f.push('', { voice: true, status: 902 }); f.push('last', { chat: 44 });
  const candidate = f.inbox.steerCandidates().find(c => c.entry === voice);
  const handle = f.reserve(candidate, { messageId: 902 });
  handle.entry.preparedVoice = { transcript: 'готово', prompt: 'готово' };
  f.release(); await settle(); assert.deepEqual(f.runs.map(e => e.text), ['active']);
  assert.equal(handle.release(), true); await settle();
  assert.deepEqual(f.runs.map(e => e.text), ['active', 'first', '', 'last']);
  assert.equal(f.runs[2], voice); assert.equal(f.runs[2].preparedVoice.transcript, 'готово');
  await f.inbox.shutdown();
});

test('unknown fences all queued work until clear, invalidating every handle', async () => {
  const f = fixture(); f.push('active'); await settle(); f.push('waiting'); f.push('next', { chat: 43 });
  const handle = f.reserve(f.inbox.steerCandidates()[0]); assert.equal(handle.unknown(), true);
  assert.equal(handle.signal.aborted, true); assert.equal(handle.release(), false);
  f.release(); await settle(); assert.deepEqual(f.runs.map(e => e.text), ['active']);
  assert.deepEqual(f.inbox.steerCandidates(), []); assert.equal(f.inbox.clear(), true);
  f.push('new'); await settle(); assert.deepEqual(f.runs.map(e => e.text), ['active', 'new']);
  await f.inbox.shutdown();
});

test('rendering can retire all buttons while a reservation blocks new selections', async () => {
  const f = fixture(); f.push('active'); await settle(); f.push('waiting'); f.push('next', { chat: 43 });
  const before = f.inbox.steerEntries();
  const handle = f.reserve(before[0]);
  assert.equal(f.inbox.steerBusy, true);
  assert.deepEqual(f.inbox.steerCandidates(), []);
  assert.deepEqual(f.inbox.steerEntries().map(row => row.token), before.map(row => row.token));
  handle.release(); assert.equal(f.inbox.steerBusy, false);
  f.inbox.clear(); f.release(); await settle(); await f.inbox.shutdown();
});

test('a callback becomes stale as soon as its queued message starts', async () => {
  const f = fixture(); f.push('active'); await settle(); f.push('waiting');
  const candidate = f.inbox.steerCandidates()[0];
  f.release(); await settle();
  assert.equal(f.reserve(candidate), null);
  assert.deepEqual(f.inbox.steerEntries(), []);
  await f.inbox.shutdown();
});

test('clear and shutdown cancel reservation even while first turn runs', async () => {
  for (const action of ['clear', 'shutdown']) {
    const f = fixture(); f.push('active'); await settle(); f.push('waiting');
    const handle = f.reserve(f.inbox.steerCandidates()[0]);
    if (action === 'clear') f.inbox.clear(); else {
      const stopping = f.inbox.shutdown(); f.release(); await stopping;
    }
    assert.equal(handle.signal.aborted, true); assert.equal(handle.isCurrent(), false);
    assert.equal(handle.consume(), false); assert.equal(handle.release(), false);
    f.release(); await settle(); assert.deepEqual(f.runs.map(e => e.text), ['active']);
    await f.inbox.shutdown();
  }
});

test('scheduled, recovered, forwarded, batches and attachments are not candidates', async () => {
  const f = fixture(); f.push('active'); await settle();
  f.push('normal'); f.push('scheduled', { scheduled: true }); f.push('recovered', { recovered: true });
  f.push('attachment', { attachment: 'photo' });
  const forwarded = f.item('forward'); forwarded.ctx.message.forward_origin = {}; f.inbox.push(forwarded);
  assert.deepEqual(f.inbox.steerCandidates().map(c => c.entry.text), ['normal']);
  f.inbox.clear(); f.release(); await settle(); await f.inbox.shutdown();
});

test('text prompt retains one protected reply context', () => {
  const f = fixture(), item = f.item('мой ответ');
  item.ctx.message.reply_to_message = { text: 'уникальная-цитата-42', from: { id: 99 } };
  const prompt = textPrompt(item); assert.match(prompt, /уникальная-цитата-42/); assert.match(prompt, /мой ответ$/);
  assert.equal((prompt.match(/уникальная-цитата-42/g) || []).length, 1);
});
