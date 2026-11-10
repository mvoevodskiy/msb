import test from 'node:test';
import assert from 'node:assert/strict';
import { startTurnProgress } from '../src/telegram/progress.mjs';

const flush = () => new Promise(setImmediate);
function fixture(edit = async () => {}) {
  let now = 0, id = 0;
  const tasks = new Map(), messages = [], actions = [];
  const timers = { setInterval(fn, delay) { const key = ++id; tasks.set(key, { fn, delay, at: now + delay }); return key; }, clearInterval(key) { tasks.delete(key); }, setTimeout(fn, delay) { const key=++id; tasks.set(key,{fn, delay:Infinity, at:now+delay}); return key; }, clearTimeout(key) { tasks.delete(key); } };
  const ctx = { chat: { id: 42 }, message: { message_thread_id: 7 }, api: {
    async editMessageText(chat, message, text) { messages.push({ at: now, chat, message, text }); await edit(text); },
    async sendChatAction(chat, action, topic) { actions.push({ at: now, chat, action, topic }); },
  } };
  async function advance(to) {
    await flush();
    for (;;) {
      const due = [...tasks.values()].filter(x => x.at <= to).sort((a,b) => a.at-b.at)[0];
      if (!due) break;
      now = due.at; due.at += due.delay; due.fn(); await flush();
    }
    now = to; await flush();
  }
  return { ctx, messages, actions, tasks, advance, options: { now: () => now, timers } };
}

test('legacy thinking frames and typing continue while CLI emits nothing, then stop completely', async () => {
  const f = fixture(), progress = startTurnProgress(f.ctx, 100, f.options);
  await f.advance(6000);
  assert.deepEqual(f.messages.map(x => x.text), ['Думаю… ⏳', 'Думаю… ⌛️ 2с', 'Соображаю… 🤔 4с', 'Мозгую… 🧠 6с']);
  assert.deepEqual(f.actions.map(x => x.at), [0, 4000]);
  assert.ok(f.actions.every(x => x.action === 'typing' && x.topic.message_thread_id === 7));
  await progress.stop();
  const count = f.messages.length;
  await f.advance(20000);
  assert.equal(f.messages.length, count);
  assert.equal(f.tasks.size, 0);
});

test('legacy long-turn throttling switches to 10 seconds after five minutes and 30 after fifteen', async () => {
  const f = fixture(), progress = startTurnProgress(f.ctx, 100, f.options);
  await f.advance(930000);
  const middle = f.messages.filter(x => x.at >= 300000 && x.at < 900000);
  for (let i=1;i<middle.length;i++) assert.ok(middle[i].at-middle[i-1].at >= 10000);
  const late = f.messages.filter(x => x.at >= 900000);
  assert.ok(late.length > 0);
  for (let i=1;i<late.length;i++) assert.ok(late[i].at-late[i-1].at >= 30000);
  assert.ok(late.every(x => / мин$/.test(x.text)));
  await progress.stop();
});

test('abort drains the in-flight edit, drops queued frames and cancels timers', async () => {
  let release;
  const gate = new Promise(r => { release=r; });
  const f = fixture(() => gate), ac = new AbortController();
  const progress = startTurnProgress(f.ctx, 100, { ...f.options, signal: ac.signal });
  await f.advance(6000);
  assert.equal(f.messages.length, 1, 'slow Telegram must not produce concurrent edits');
  ac.abort();
  let drained = false;
  const stopping = progress.stop().then(() => { drained=true; });
  await flush(); assert.equal(drained, false);
  release(); await stopping;
  await f.advance(20000);
  assert.equal(f.messages.length, 1);
  assert.equal(f.tasks.size, 0);
});

test('tool details retain original URL/path presentation and init never substitutes a model label', async () => {
  const f = fixture(), progress = startTurnProgress(f.ctx, 100, f.options);
  progress.onStatus({ kind: 'init', model: 'wrong-claude-label' });
  progress.onStatus({ kind: 'tool', name: 'WebFetch', rawInput: { url: 'https://example.org/page' } });
  await f.advance(2000);
  assert.equal(f.messages.at(-1).text, 'Открываю страницу 🌐 · example.org/page 2с');
  progress.onStatus({ kind: 'tool', name: 'Read', rawInput: { file_path: '/home/client/project/src/main.js' } });
  await f.advance(4000);
  assert.equal(f.messages.at(-1).text, 'Читаю файл 👁️ · src/main.js 4с');
  assert.ok(!f.messages.some(x => x.text.includes('wrong-claude-label')));
  await progress.stop();
});

test('presentation API failures and already-aborted startup cannot leak timers or reject the task', async () => {
  const f = fixture(async () => { throw Error('fixture Telegram error'); });
  f.ctx.api.sendChatAction = async () => { throw Error('fixture typing error'); };
  const progress = startTurnProgress(f.ctx, 100, f.options);
  await f.advance(4000); await progress.stop(); assert.equal(f.tasks.size,0);
  const ac = new AbortController(); ac.abort();
  const g = fixture(), stopped = startTurnProgress(g.ctx, 100, { ...g.options, signal: ac.signal });
  await g.advance(10000); await stopped.stop();
  assert.equal(g.messages.length + g.actions.length + g.tasks.size, 0);
});


test('voice preparation retains the old seven-frame cadence and transitions to the model phase', async () => {
  const f = fixture(), progress = startTurnProgress(f.ctx, 100, { ...f.options, preparing: true });
  await f.advance(500);
  assert.equal(f.messages.at(-1).text, 'Думаю…⌛️');
  await f.advance(2000);
  assert.equal(f.messages.at(-1).text, 'Вникаю…👁️ 2с');
  await f.advance(2300);
  progress.beginThinking(); await f.advance(2300);
  assert.equal(f.messages.at(-1).text, 'Думаю… ⏳');
  await f.advance(4300);
  assert.equal(f.messages.at(-1).text, 'Думаю… ⌛️ 2с');
  await progress.stop(); assert.equal(f.tasks.size, 0);
});
