import test from 'node:test';
import assert from 'node:assert/strict';
import { createInbox } from '../src/telegram/inbox.mjs';
import { createSteerAction } from '../src/telegram/steer-action.mjs';

const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture({ prepareVoice = async entry => (entry.preparedVoice = { transcript: 'speech', prompt: 'speech' }),
  steer = async () => ({ status: 'accepted' }), voiceNotConfigured = async () => {} } = {}) {
  const held = gate(), runs = [], sent = [], shown = [], answers = [];
  const inbox = createInbox({ run: async entry => { runs.push(entry); if (entry.text === 'active') await held.promise; },
    status: async () => {}, cancel: async () => {} });
  const controller = new AbortController();
  const handle = { active: true, isCurrent: async () => true, steer: async text => { sent.push(text); return steer(text); } };
  const turn = { controller, steer: handle };
  const getActive = (chatId, threadId) => chatId === 42 && threadId === 1 ? turn : null;
  const action = createSteerAction({ inbox, getActive, adminId: 42, prepareVoice, voiceNotConfigured,
    present: async (entry, text) => shown.push({ entry, text }), refresh: () => {} });
  const push = (text, { voice = false, status = 100, reply } = {}) => {
    const entry = { text, voice, status: { message_id: status }, ctx: { chat: { id: 42 },
      message: { text, message_thread_id: 1, ...(reply ? { reply_to_message: { text: reply, from: { id: 99 } } } : {}) }, me: { id: 99 } } };
    inbox.push(entry); return entry;
  };
  const click = (candidate, { user = 42, status = 100, thread = 1 } = {}) => {
    candidate.entry.steerOffer ||= { token: candidate.token, candidateToken: candidate.token, turn, handle };
    return action({ from: { id: user }, chat: { id: 42 }, callbackQuery: { data: `steer:${candidate.entry.steerOffer.token}`,
      message: { message_id: status, message_thread_id: thread } },
      answerCallbackQuery: async value => answers.push(value) });
  };
  return { held, runs, sent, shown, answers, inbox, controller, handle, turn, push, click };
}

test('selected queued text is sent once with its own reply context', async () => {
  const f = fixture(); f.push('active'); await settle();
  const entry = f.push('correction', { reply: 'earlier fixture', status: 101 });
  const candidate = f.inbox.steerCandidates()[0];
  await f.click(candidate, { status: 101 });
  assert.equal(f.sent.length, 1); assert.match(f.sent[0], /earlier fixture/); assert.match(f.sent[0], /correction$/);
  assert.equal((f.sent[0].match(/earlier fixture/g) || []).length, 1);
  assert.equal(f.inbox.steerEntries().length, 0);
  assert.equal(f.shown.at(-1).text, 'Передано в текущий ход.');
  assert.equal(f.shown.at(-1).entry, entry);
  await f.click(candidate, { status: 101 }); assert.equal(f.sent.length, 1);
  f.held.resolve(); await settle(); await f.inbox.shutdown();
});

test('foreign owner, wrong topic and stale status cannot promote a message', async () => {
  const f = fixture(); f.push('active'); await settle(); f.push('queued');
  const candidate = f.inbox.steerCandidates()[0];
  await f.click(candidate, { user: 17 });
  await f.click(candidate, { thread: 2 });
  await f.click(candidate, { status: 999 });
  assert.deepEqual(f.sent, []); assert.equal(f.inbox.steerEntries().length, 1);
  f.inbox.clear(); f.held.resolve(); await settle(); await f.inbox.shutdown();
});

test('voice preparation is reused when the active turn ends before steering', async () => {
  const transcribe = gate(); let count = 0;
  const f = fixture({ prepareVoice: async entry => { count++; await transcribe.promise;
    return (entry.preparedVoice = { transcript: 'spoken', prompt: 'spoken with quote' }); } });
  f.push('active'); await settle();
  const entry = f.push('', { voice: true }); const candidate = f.inbox.steerCandidates()[0];
  const clicking = f.click(candidate); await settle();
  f.handle.active = false; f.held.resolve(); await settle();
  assert.equal(f.runs.length, 1, 'reserved voice blocks the FIFO while STT is pending');
  transcribe.resolve(); await clicking; await settle();
  assert.equal(count, 1); assert.deepEqual(f.sent, []);
  assert.equal(f.runs[1], entry); assert.equal(entry.preparedVoice.prompt, 'spoken with quote');
  await f.inbox.shutdown();
});

test('/stop during delayed voice preparation invalidates the reservation and cannot send later', async () => {
  const transcribe = gate();
  const f = fixture({ prepareVoice: async entry => { await transcribe.promise;
    return (entry.preparedVoice = { transcript: 'late', prompt: 'late' }); } });
  f.push('active'); await settle(); f.push('', { voice: true });
  const clicking = f.click(f.inbox.steerCandidates()[0]); await settle();
  f.inbox.clear(); f.controller.abort(); f.held.resolve(); transcribe.resolve();
  await clicking; await settle();
  assert.deepEqual(f.sent, []); assert.equal(f.inbox.size, 0);
  await f.inbox.shutdown();
});

test('an uncertain steering acknowledgement fences the FIFO and reports uncertainty', async () => {
  const f = fixture({ steer: async () => ({ status: 'unknown' }) });
  f.push('active'); await settle(); const entry = f.push('queued'); f.push('after', { status: 101 });
  await f.click(f.inbox.steerCandidates()[0]);
  assert.equal(entry.steerUnknown, true); assert.equal(f.inbox.steerBusy, true);
  assert.match(f.shown.at(-1).text, /не будет отправлено повторно/i);
  assert.match(f.shown.at(-1).text, /\/stop/);
  f.held.resolve(); await settle(); assert.deepEqual(f.runs.map(row => row.text), ['active']);
  f.inbox.clear(); await f.inbox.shutdown();
});

test('a provider without a live steering handle preserves the queued message', async () => {
  const f = fixture(); f.push('active'); await settle(); f.push('queued');
  const candidate = f.inbox.steerCandidates()[0]; f.turn.steer = null;
  await f.click(candidate); assert.deepEqual(f.sent, []); assert.equal(f.inbox.steerEntries().length, 1);
  f.held.resolve(); await settle(); assert.equal(f.runs[1].text, 'queued');
  await f.inbox.shutdown();
});

test('/stop while the session check is pending prevents a late steering send', async () => {
  const check = gate(); const f = fixture(); let calls = 0;
  f.handle.isCurrent = async () => { calls++; if (calls === 2) await check.promise; return true; };
  f.push('active'); await settle(); f.push('queued');
  const clicking = f.click(f.inbox.steerCandidates()[0]); await settle();
  assert.equal(calls, 2); f.inbox.clear(); f.controller.abort(); check.resolve();
  await clicking; assert.deepEqual(f.sent, []);
  f.held.resolve(); await settle(); await f.inbox.shutdown();
});

test('an exception after initiating a send fences the item instead of replaying it', async () => {
  const f = fixture({ steer: async () => { throw Error('outcome unknown'); } });
  f.push('active'); await settle(); const entry = f.push('queued'); f.push('next', { status: 101 });
  await f.click(f.inbox.steerCandidates()[0]);
  assert.equal(entry.steerUnknown, true); assert.equal(f.inbox.steerBusy, true);
  f.held.resolve(); await settle(); assert.deepEqual(f.runs.map(row => row.text), ['active']);
  f.inbox.clear(); await f.inbox.shutdown();
});

test('missing speech configuration notifies the user and preserves the voice in FIFO', async () => {
  let notified = 0;
  const f = fixture({ prepareVoice: async () => { throw Object.assign(Error('not configured'), { code: 'STT_NOT_CONFIGURED' }); },
    voiceNotConfigured: async () => { notified++; } });
  f.push('active'); await settle(); const entry = f.push('', { voice: true });
  await f.click(f.inbox.steerCandidates()[0]);
  assert.equal(notified, 1); assert.equal(f.inbox.steerBusy, false); assert.equal(f.inbox.steerEntries()[0].entry, entry);
  f.held.resolve(); await settle(); assert.equal(f.runs[1], entry); await f.inbox.shutdown();
});
