/** Mixed ingress through production handlers; no real Telegram, STT or CLI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBot } from '../src/telegram/bot.mjs';
import { saveState, loadState } from '../src/state.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() >= deadline) assert.fail(label); await pause(5); }
}
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t, run) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-inbox-'));
  const env = { ...process.env }, fetch = globalThis.fetch;
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { HOME: home, MSB_BOT_ID: 'default', MSB_WORKSPACE_DIR: home,
    ADMIN_ID: '42', DEEPGRAM_API_KEY: 'fake-stt', CLAUDE_CODE_OAUTH_TOKEN: 'fake-auth' });
  const calls = [], prompts = [], stt = [], signals = [], holds = [];
  let id = 0, active = 0, maxActive = 0;
  class Harness {
    handlers = new Map(); commands = new Map(); middleware = [];
    api = { config: { use() {} }, setMyCommands: async () => true,
      getFile: async fileId => ({ file_path: fileId, file_size: 1 }),
      sendChatAction: async () => true,
      deleteMessage: async (_chat, message_id) => { calls.push({ deleted: message_id }); },
      editMessageText: async (chat, message_id, text) => { calls.push({ chat, message_id, text, edit: true }); return { message_id }; },
    };
    async start() {} async stop() {}
    use(fn) { this.middleware.push(fn); }
    command(name, fn) { this.commands.set(name, fn); }
    on(name, fn) { for (const n of Array.isArray(name) ? name : [name]) this.handlers.set(n, fn); }
    async handleUpdate(message) {
      const ctx = { message, chat: message.chat, from: message.from, me: { id: 99 }, api: this.api,
        reply: async (text, options) => { const row = { text, options, message_id: ++id }; calls.push(row); return row; } };
      const command = message.text?.match(/^\/([^@\s]+)/)?.[1];
      const handler = command ? this.commands.get(command) : this.handlers.get(message.voice ? 'message:voice' : 'message:text');
      const step = i => i < this.middleware.length ? this.middleware[i](ctx, () => step(i + 1)) : handler?.(ctx);
      return step(0);
    }
  }
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.telegram.org/file/')) {
      const name = String(url).split('/').at(-1);
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode(name).buffer };
    }
    assert.ok(String(url).startsWith('https://api.deepgram.com/v1/listen?'), 'No real network allowed');
    const name = new TextDecoder().decode(opts.body); stt.push(name);
    if (name === 'bad') return { ok: false, status: 503, text: async () => 'fixture unavailable' };
    return { ok: true, json: async () => ({ results: { channels: [{ alternatives: [{ transcript: `speech-${name}` }] }] } }) };
  };
  const bot = createBot({ botToken: '42:fake-only', adminId: 42, timezone: 'UTC' }, { bot: new Harness(), runTurn: async args => {
    prompts.push(args.prompt); signals.push(args.signal); active++; maxActive = Math.max(maxActive, active);
    try { return await (run?.(args, prompts.length, holds) ?? { ok: true, text: `answer-${prompts.length}` }); }
    finally { active--; }
  } });
  await saveState({ authMode: 'subscription', hasSubscriptionAuth: true, ccSessionId: 'saved-session', fixtureKeep: true });
  let seq = 100;
  const input = (content, forwarded = false, owner = 42, thread = undefined) => bot.handleUpdate({
    message_id: ++seq, date: 1, chat: { id: 42 }, from: { id: owner },
    ...(forwarded ? { forward_origin: { type: 'hidden_user', sender_user_name: 'Fixture', date: 1 } } : {}),
    ...(thread ? { message_thread_id: thread } : {}),
    ...(typeof content === 'string' ? { text: content } : { voice: { file_id: content.voice, duration: 2 } }),
  });
  t.after(async () => {
    holds.forEach(h => h.resolve());
    await bot.stop(); globalThis.fetch = fetch;
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, env);
    await fs.rm(home, { recursive: true, force: true });
  });
  return { bot, input, calls, prompts, stt, signals, holds, get maxActive() { return maxActive; } };
}

test('inbox: text and voice received during a turn are retained in arrival order', async t => {
  const first = gate();
  const f = await fixture(t, async (_args, n, holds) => { if (n === 1) { holds.push(first); await first.promise; } return { ok: true, text: `answer-${n}` }; });
  await f.input('first'); await until(() => f.prompts.length === 1, 'first turn');
  await f.input('second'); await f.input({ voice: 'third' });
  assert.ok(f.calls.some(c => c.text === '⏳ в очереди'), 'Preserve the legacy queued indication');
  assert.deepEqual(f.stt, [], 'A queued voice must not start a parallel model turn');
  first.resolve();
  await until(() => f.prompts.length === 3, 'all queued inputs must reach the model');
  assert.deepEqual(f.prompts, ['first', 'second', 'speech-third']);
  assert.equal(f.maxActive, 1);
  assert.ok(!f.calls.some(c => c.text?.startsWith('Уже работаю')));
  assert.equal((await loadState()).state.ccSessionId, 'saved-session');
});

test('inbox: six forwarded voices and two texts become one ordered prompt after all STT', async t => {
  const f = await fixture(t);
  for (const item of [{ voice: '1' }, { voice: '2' }, { voice: '3' }, 'text-4', { voice: '5' }, 'text-6', { voice: '7' }, { voice: '8' }]) await f.input(item, true);
  assert.equal(f.prompts.length, 0, 'The first forwarded voice must wait for the rest of the batch');
  await until(() => f.prompts.length === 1, 'one complete forwarded batch');
  assert.deepEqual(f.stt, ['1', '2', '3', '5', '7', '8']);
  const p = f.prompts[0];
  const expected = ['speech-1', 'speech-2', 'speech-3', 'text-4', 'speech-5', 'text-6', 'speech-7', 'speech-8'];
  let pos = -1; for (const part of expected) { const next = p.indexOf(part); assert.ok(next > pos, `Arrival order: ${part}`); pos = next; }
  assert.equal(f.prompts.length, 1);
  assert.ok(f.calls.some(c => /📥 Собираю пересланное/.test(c.text)));
  assert.ok(f.calls.some(c => c.text === '📥 Принял 8 пересланных, загружаю медиа (6)…'));
});

test('inbox: stop cancels the current turn and drops queued text and an open forwarded batch', async t => {
  const first = gate();
  const f = await fixture(t, async ({ signal }, n, holds) => { if (n === 1) { holds.push(first); await first.promise; } return { ok: !signal.aborted, error: signal.aborted ? 'aborted' : undefined, text: `answer-${n}` }; });
  await f.input('first'); await until(() => f.prompts.length === 1, 'first turn');
  await f.input('must-not-run'); await f.input({ voice: 'must-not-transcribe' }, true);
  await f.input('/stop'); assert.equal(f.signals[0].aborted, true);
  first.resolve(); await f.bot.stop();
  assert.deepEqual(f.prompts, ['first']); assert.deepEqual(f.stt, []);
  assert.ok(f.calls.some(c => c.text === 'Моя остановочка ✋🏽⛔️'));
  assert.ok(!f.calls.some(c => c.text?.startsWith('Уже работаю')));
});
