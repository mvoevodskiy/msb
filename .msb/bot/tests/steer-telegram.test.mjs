/** Actual Telegram handlers with fake API, fake provider and synthetic STT. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBot } from '../src/telegram/bot.mjs';
import { saveState } from '../src/state.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!fn()) { if (Date.now() > end) assert.fail(label); await pause(5); }
}
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

async function fixture(t, {
  withSteer = true, holdVoice, holdPreview, holdQueuedReply, withoutStt = false, voiceFileFailure, loseSttResponse = false,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-steer-telegram-'));
  const previous = { ...process.env }, originalFetch = globalThis.fetch;
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { HOME: root, MSB_BOT_ID: 'default', MSB_WORKSPACE_DIR: root,
    ADMIN_ID: '42', DEEPGRAM_API_KEY: 'fixture-only', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-only' });
  if (withoutStt) delete process.env.DEEPGRAM_API_KEY;
  const rows = new Map(), calls = [], prompts = [], corrections = [], answers = [], holds = [], stt = [];
  let nextMessage = 100, nextInput = 0;
  const edit = async (_chat, id, text, options = {}) => {
    const row = rows.get(id);
    if (!row || row.deleted) throw Error('fixture missing message');
    if (holdPreview && text.includes('fixture voice correction')) { calls.push({ method: 'preview-start', id }); await holdPreview.promise; }
    if (row.deleted) throw Error('fixture message deleted during edit');
    row.text = text;
    if (Object.hasOwn(options, 'reply_markup')) row.keyboard = options.reply_markup;
    calls.push({ method: 'edit', id, text, keyboard: row.keyboard });
    return { message_id: id };
  };
  class Harness {
    handlers = new Map(); commands = new Map(); middleware = [];
    api = { config: { use() {} }, setMyCommands: async () => true,
      sendChatAction: async () => true, editMessageText: edit,
      deleteMessage: async (_chat, id) => { const row = rows.get(id); if (row) row.deleted = true; },
      editMessageReplyMarkup: async () => true,
      getFile: async id => {
        if (voiceFileFailure === 'getFile') throw Error('fixture Telegram getFile 400');
        if (voiceFileFailure === 'file path') return { file_size: 1 };
        return { file_path: id, file_size: 1 };
      },
      sendMessage: async (_chat, text, options) => reply(text, options),
    };
    async start() {} async stop() {}
    use(fn) { this.middleware.push(fn); }
    command(name, fn) { this.commands.set(name, fn); }
    on(name, fn) { for (const value of Array.isArray(name) ? name : [name]) this.handlers.set(value, fn); }
    async dispatch(kind, payload, user = 42) {
      const ctx = { chat: { id: 42 }, from: { id: user }, me: { id: 99 }, api: this.api,
        reply, answerCallbackQuery: async options => answers.push(options) };
      if (kind === 'callback') ctx.callbackQuery = payload;
      else ctx.message = payload;
      const command = ctx.message?.text?.match(/^\/([^@\s]+)/)?.[1];
      const handler = kind === 'callback' ? this.handlers.get('callback_query:data')
        : command ? this.commands.get(command) : this.handlers.get(kind === 'voice' ? 'message:voice' : 'message:text');
      const step = i => i < this.middleware.length ? this.middleware[i](ctx, () => step(i + 1)) : handler?.(ctx);
      return step(0);
    }
  }
  const reply = async (text, options = {}) => {
    const id = ++nextMessage;
    if (holdQueuedReply && text === '⏳ в очереди' && options.reply_markup?.inline_keyboard?.length) {
      calls.push({ method: 'queue-reply-start', id }); await holdQueuedReply.promise;
    }
    rows.set(id, { text, keyboard: options.reply_markup, thread: options.message_thread_id || 1, deleted: false });
    calls.push({ method: 'reply', id, text, keyboard: options.reply_markup });
    return { message_id: id };
  };
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.telegram.org/file/')) {
      if (voiceFileFailure === 'download transport') throw Error('fixture download failed: ' + url);
      if (voiceFileFailure === 'HTTP status') return { ok: false, status: 404 };
      return { ok: true, arrayBuffer: async () => {
        if (voiceFileFailure === 'download read') throw Error('fixture body failed: ' + url);
        return new TextEncoder().encode('fixture').buffer;
      } };
    }
    assert.ok(String(url).startsWith('https://api.deepgram.com/v1/listen?'), 'real network must not be used');
    stt.push('called');
    if (loseSttResponse) throw Error('fixture lost the transcription response');
    if (holdVoice) await holdVoice.promise;
    return { ok: true, json: async () => ({ results: { channels: [{ alternatives: [{ transcript: 'fixture voice correction' }] }] } }) };
  };
  const harness = new Harness();
  const bot = createBot({ botToken: '42:fixture', adminId: 42, timezone: 'UTC' }, { bot: harness,
    runTurn: async args => {
      prompts.push(args.prompt); const hold = gate(); holds.push(hold);
      const handle = { active: true, isCurrent: async () => true, steer: async text => { corrections.push(text); return { status: 'accepted' }; } };
      if (withSteer) args.onSteerReady?.(handle);
      const stopped = new Promise(resolve => args.signal.addEventListener('abort', resolve, { once: true }));
      await Promise.race([hold.promise, stopped]);
      handle.active = false; if (withSteer) args.onSteerReady?.(null);
      return args.signal.aborted ? { ok: false, error: 'aborted', text: 'Остановлено.' } : { ok: true, text: 'fixture response' };
    } });
  await saveState({ authMode: 'subscription', hasSubscriptionAuth: true, ccSessionId: 'saved-session', fixtureKeep: true });
  const input = (text, user = 42, thread = 1) => harness.dispatch('text', { message_id: ++nextInput, date: 1, chat: { id: 42 }, from: { id: user }, text, message_thread_id: thread }, user);
  const voice = () => harness.dispatch('voice', { message_id: ++nextInput, date: 1, chat: { id: 42 }, from: { id: 42 }, voice: { file_id: 'voice-fixture', duration: 1 } });
  const callback = (id, token, user = 42, thread = 1) => harness.dispatch('callback', { id: 'callback-fixture', from: { id: user },
    data: token, message: { message_id: id, chat: { id: 42 }, message_thread_id: thread } }, user);
  const buttonRow = () => [...rows.entries()].find(([, row]) => !row.deleted && row.keyboard?.inline_keyboard?.some(buttons =>
    buttons.some(button => button.callback_data?.startsWith('steer:'))));
  t.after(async () => {
    holds.forEach(hold => hold.resolve()); holdVoice?.resolve(); holdPreview?.resolve(); holdQueuedReply?.resolve(); await bot.stop();
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, previous);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, rows, calls, prompts, corrections, answers, holds, stt, input, voice, callback, buttonRow };
}

test('button disappears after queued message starts normally; stale callback cannot steer', async t => {
  const f = await fixture(t); await f.input('first'); await until(() => f.prompts.length === 1, 'first turn');
  await f.input('queued'); await until(() => f.buttonRow(), 'queued button');
  const [id, row] = f.buttonRow(), token = row.keyboard.inline_keyboard[0][0].callback_data;
  f.holds[0].resolve(); await until(() => f.prompts.length === 2, 'queued turn');
  await until(() => !f.rows.get(id)?.keyboard?.inline_keyboard?.length, 'button removed');
  await f.callback(id, token); assert.deepEqual(f.corrections, []);
  f.holds[1].resolve();
});

test('a delayed Telegram queue reply cannot restore a button after the item starts', async t => {
  const delayed = gate(), f = await fixture(t, { holdQueuedReply: delayed });
  await f.input('first'); await until(() => f.prompts.length === 1, 'first turn');
  await f.input('queued'); await until(() => f.calls.some(call => call.method === 'queue-reply-start'), 'delayed queue reply');
  const id = f.calls.find(call => call.method === 'queue-reply-start').id;
  f.holds[0].resolve(); await pause(20); delayed.resolve();
  await until(() => f.prompts.length === 2, 'queued turn begins after status reply');
  await until(() => !f.rows.get(id)?.keyboard?.inline_keyboard?.length, 'late button removed');
  f.holds[1].resolve();
});

test('accepted correction removes its button and leaves the following message queued', async t => {
  const f = await fixture(t); await f.input('first'); await until(() => f.prompts.length === 1, 'first turn');
  await f.input('correction'); await until(() => f.buttonRow(), 'queued button');
  const [id, row] = f.buttonRow(), token = row.keyboard.inline_keyboard[0][0].callback_data;
  await f.input('after'); await f.callback(id, token);
  await until(() => f.corrections.length === 1, 'correction delivered');
  await until(() => f.rows.get(id)?.text === 'Передано в текущий ход.', 'acknowledgement');
  assert.deepEqual(f.rows.get(id).keyboard.inline_keyboard, []);
  await f.callback(id, token); assert.deepEqual(f.corrections, ['correction']);
  f.holds[0].resolve(); await until(() => f.prompts.length === 2, 'remaining queued turn');
  assert.equal(f.prompts[1], 'after'); f.holds[1].resolve();
});

test('merged queued messages do not leave actionable buttons behind', async t => {
  const f = await fixture(t); await f.input('first'); await until(() => f.prompts.length === 1, 'first turn');
  await f.input('queued one'); await f.input('queued two');
  await until(() => [...f.rows.values()].filter(row => !row.deleted && row.keyboard?.inline_keyboard?.length).length === 2, 'two queued buttons');
  const queued = [...f.rows.entries()].filter(([, row]) => !row.deleted && row.keyboard?.inline_keyboard?.length).map(([id]) => id);
  f.holds[0].resolve(); await until(() => f.prompts.length === 2, 'merged turn');
  await until(() => queued.every(id => f.rows.get(id)?.deleted || !f.rows.get(id)?.keyboard?.inline_keyboard?.length), 'merged buttons removed');
  assert.match(f.prompts[1], /queued one/); assert.match(f.prompts[1], /queued two/);
  f.holds[1].resolve();
});

test('a button from an earlier active turn cannot steer the next active turn', async t => {
  const f = await fixture(t); await f.input('first'); await until(() => f.prompts.length === 1, 'first turn');
  await f.voice(); await f.input('third');
  await until(() => [...f.rows.values()].filter(row => !row.deleted && row.keyboard?.inline_keyboard?.length).length === 2, 'two queued buttons');
  const [id, row] = [...f.rows.entries()].filter(([, value]) => !value.deleted && value.keyboard?.inline_keyboard?.length).at(-1);
  const stale = row.keyboard.inline_keyboard[0][0].callback_data;
  f.holds[0].resolve(); await until(() => f.prompts.length === 2, 'voice turn');
  await until(() => f.rows.get(id)?.keyboard?.inline_keyboard?.[0]?.[0]?.callback_data &&
    f.rows.get(id).keyboard.inline_keyboard[0][0].callback_data !== stale, 'button rebound to current turn');
  const fresh = f.rows.get(id).keyboard.inline_keyboard[0][0].callback_data;
  await f.callback(id, stale); assert.deepEqual(f.corrections, []);
  await f.callback(id, fresh); assert.deepEqual(f.corrections, ['third']);
  f.holds[1].resolve();
});

test('/stop clears a queued button and a late click cannot restart it', async t => {
  const f = await fixture(t); await f.input('first'); await until(() => f.prompts.length === 1, 'first turn');
  await f.input('queued'); await until(() => f.buttonRow(), 'queued button');
  const [id, row] = f.buttonRow(), token = row.keyboard.inline_keyboard[0][0].callback_data;
  await f.input('/stop'); await until(() => f.rows.get(id)?.text === 'Моя остановочка ✋🏽⛔️', 'queued status stopped');
  assert.deepEqual(f.rows.get(id).keyboard.inline_keyboard, []);
  await f.callback(id, token); assert.deepEqual(f.corrections, []); assert.equal(f.prompts.length, 1);
});

test('a queued voice is transcribed once and steered as text', async t => {
  const f = await fixture(t); await f.input('first'); await until(() => f.prompts.length === 1, 'first turn');
  await f.voice(); await until(() => f.buttonRow(), 'voice button');
  const [id, row] = f.buttonRow(), token = row.keyboard.inline_keyboard[0][0].callback_data;
  await f.callback(id, token); await until(() => f.corrections.length === 1, 'voice steered');
  assert.deepEqual(f.corrections, ['fixture voice correction']); assert.equal(f.stt.length, 1);
  await until(() => f.rows.get(id)?.text === 'Передано в текущий ход.', 'voice acknowledgement');
  assert.deepEqual(f.rows.get(id).keyboard.inline_keyboard, []);
  assert.ok([...f.rows.values()].some(value => value.text.includes('fixture voice correction') && value.text.includes('🎙')));
  f.holds[0].resolve();
});

for (const [voiceFileFailure, detail] of [
  ['getFile', 'Не удалось получить голосовое из Telegram'],
  ['file path', 'Не удалось скачать voice: нет пути файла'],
  ['HTTP status', 'Не удалось скачать voice: HTTP 404'],
  ['download transport', 'Не удалось скачать voice'],
  ['download read', 'Не удалось скачать voice'],
]) {
  test('voice ' + voiceFileFailure + ' failure ends only that entry before STT', async t => {
    const f = await fixture(t, { voiceFileFailure });
    await f.input('first');
    await until(() => f.prompts.length === 1, 'first turn');
    await f.voice();
    await until(() => f.buttonRow(), 'voice button');
    const [id, row] = f.buttonRow();
    const token = row.keyboard.inline_keyboard[0][0].callback_data;
    await f.input('queued after voice');
    await f.callback(id, token);
    assert.deepEqual(f.stt, []);
    assert.deepEqual(f.corrections, []);
    assert.equal(f.rows.get(id)?.text, '❌ Не удалось обработать голосовое: ' + detail + '\n\nПопробуй ещё раз или напиши текстом.');
    assert.deepEqual(f.rows.get(id).keyboard.inline_keyboard, []);
    f.holds[0].resolve();
    await until(() => f.prompts.length === 2, 'next text runs after the failed voice');
    assert.equal(f.prompts[1], 'queued after voice');
    f.holds[1].resolve();
  });
}

test('a lost STT response still fences the FIFO without resubmitting voice', async t => {
  const f = await fixture(t, { loseSttResponse: true });
  await f.input('first');
  await until(() => f.prompts.length === 1, 'first turn');
  await f.voice();
  await until(() => f.buttonRow(), 'voice button');
  const [id, row] = f.buttonRow();
  await f.input('queued after voice');
  await f.callback(id, row.keyboard.inline_keyboard[0][0].callback_data);
  assert.match(f.rows.get(id)?.text, /Очередь приостановлена/);
  f.holds[0].resolve();
  await until(() => [...f.rows.values()].some(value => value.text.includes('fixture response')), 'first reply delivered');
  assert.deepEqual(f.stt, ['called']);
  assert.deepEqual(f.corrections, []);
  assert.deepEqual(f.prompts, ['first']);
  await f.input('/stop');
  await until(() => f.rows.get(id)?.text === 'Моя остановочка ✋🏽⛔️', 'stop clears uncertain voice');
});

test('/stop during voice recognition removes the button and fences a late transcript', async t => {
  const held = gate(); const f = await fixture(t, { holdVoice: held });
  await f.input('first'); await until(() => f.prompts.length === 1, 'first turn');
  await f.voice(); await until(() => f.buttonRow(), 'voice button');
  const [id, row] = f.buttonRow(), token = row.keyboard.inline_keyboard[0][0].callback_data;
  const clicking = f.callback(id, token); await until(() => f.stt.length === 1, 'synthetic STT start');
  await f.input('/stop'); held.resolve(); await clicking; await pause(20);
  assert.deepEqual(f.corrections, []); assert.deepEqual(f.rows.get(id).keyboard.inline_keyboard, []);
  assert.equal(f.prompts.length, 1);
});

test('Claude-style turn retains the normal queue without a steering button', async t => {
  const f = await fixture(t, { withSteer: false }); await f.input('first'); await until(() => f.prompts.length === 1, 'first turn');
  await f.input('next'); await until(() => f.calls.some(row => row.text === '⏳ в очереди'), 'queued status');
  assert.equal(f.buttonRow(), undefined);
  f.holds[0].resolve(); await until(() => f.prompts.length === 2, 'next turn');
  assert.equal(f.prompts[1], 'next'); f.holds[1].resolve();
});

test('voice recognized while a turn finishes is used once in the next queued turn', async t => {
  const held = gate(), f = await fixture(t, { holdVoice: held });
  await f.input('first'); await until(() => f.prompts.length === 1, 'first turn');
  await f.voice(); await until(() => f.buttonRow(), 'voice button');
  const [id, row] = f.buttonRow(), token = row.keyboard.inline_keyboard[0][0].callback_data;
  const clicking = f.callback(id, token); await until(() => f.stt.length === 1, 'synthetic STT start');
  f.holds[0].resolve(); await pause(20); held.resolve(); await clicking;
  await until(() => f.prompts.length === 2, 'voice in next turn');
  assert.deepEqual(f.corrections, []); assert.equal(f.prompts[1], 'fixture voice correction');
  assert.equal(f.stt.length, 1); assert.ok(!f.rows.get(id)?.keyboard?.inline_keyboard?.length);
  f.holds[1].resolve();
});

test('/stop while a voice preview is editing removes the late preview and never sends it', async t => {
  const held = gate(), f = await fixture(t, { holdPreview: held });
  await f.input('first'); await until(() => f.prompts.length === 1, 'first turn');
  await f.voice(); await until(() => f.buttonRow(), 'voice button');
  const [id, row] = f.buttonRow(), token = row.keyboard.inline_keyboard[0][0].callback_data;
  const clicking = f.callback(id, token); await until(() => f.calls.some(call => call.method === 'preview-start'), 'preview edit');
  const previewId = f.calls.find(call => call.method === 'preview-start').id;
  await f.input('/stop'); held.resolve(); await clicking;
  await until(() => f.rows.get(previewId)?.deleted, 'cancelled preview removed');
  assert.deepEqual(f.corrections, []); assert.ok(!f.rows.get(id)?.keyboard?.inline_keyboard?.length);
});

test('missing Deepgram shows the existing setup instructions after a queued voice click', async t => {
  const f = await fixture(t, { withoutStt: true });
  await f.input('first'); await until(() => f.prompts.length === 1, 'first turn');
  await f.voice(); await until(() => f.buttonRow(), 'voice button');
  const [id, row] = f.buttonRow(); await f.callback(id, row.keyboard.inline_keyboard[0][0].callback_data);
  assert.equal(f.stt.length, 0);
  assert.ok([...f.rows.values()].some(value => !value.deleted && value.text.includes('Голосовые пока не настроены') &&
    value.keyboard?.inline_keyboard?.some(buttons => buttons.some(button => button.text.includes('Подключить Deepgram')))));
  f.holds[0].resolve();
});

test('a plan callback in a topic offers steering only in that same topic', async t => {
  const f = await fixture(t); await f.callback(555, 'plan:approve', 42, 7);
  await until(() => f.prompts.length === 1, 'plan turn');
  await f.input('other topic', 42, 1); await f.input('same topic', 42, 7);
  await until(() => [...f.rows.values()].some(row => row.thread === 7 && row.keyboard?.inline_keyboard?.length), 'same-topic button');
  const rows = [...f.rows.entries()].filter(([, row]) => row.text === '⏳ в очереди');
  const other = rows.find(([, row]) => row.thread === 1), same = rows.find(([, row]) => row.thread === 7);
  assert.ok(other && same); assert.ok(!other[1].keyboard?.inline_keyboard?.length);
  const token = same[1].keyboard.inline_keyboard[0][0].callback_data;
  await f.callback(same[0], token, 42, 1); assert.deepEqual(f.corrections, []);
  await f.callback(same[0], token, 42, 7); assert.deepEqual(f.corrections, ['same topic']);
  f.holds[0].resolve();
});

for (const inputKind of ['text', 'voice']) {
  test(`accepted ${inputKind} is recorded on the actual active Telegram turn`, async t => {
    const f = await fixture(t); await f.input('first'); await until(() => f.prompts.length === 1, 'first turn');
    if (inputKind === 'voice') await f.voice(); else await f.input('correction token=fixture-secret');
    await until(() => f.buttonRow(), 'queued button');
    const [id, row] = f.buttonRow(), token = row.keyboard.inline_keyboard[0][0].callback_data;
    await f.callback(id, token); await until(() => f.corrections.length === 1, 'steering accepted');
    f.holds[0].resolve();
    const journal = path.join(f.root, '.msb/bots/default');
    let traceFile, transcriptFile;
    await until(() => {
      try { const x = requireForTest(journal); traceFile=x.trace; transcriptFile=x.transcript; return true; } catch { return false; }
    }, 'journal finished');
    const read = async file => (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    const traces = await read(traceFile), records = await read(transcriptFile);
    assert.equal(traces.length, 1); assert.equal(traces[0].query, 'first');
    assert.deepEqual(records.map(x => x.role), ['user', 'user', 'assistant']);
    assert.ok(records.every(x => x.turnId === traces[0].turnId));
    assert.equal(records[1].text.includes('fixture-secret'), false);
    assert.match(records[1].text, inputKind === 'voice' ? /fixture voice correction/ : /^correction/);
  });
}

function requireForTest(root) {
  const traceDir=path.join(root,'traces'), transcriptDir=path.join(root,'transcripts');
  const trace=path.join(traceDir,readdirSync(traceDir)[0]);
  const transcript=path.join(transcriptDir,readdirSync(transcriptDir)[0]);
  if (!existsSync(path.join(root,'chat-diary.jsonl'))) throw Error('not finished');
  return {trace,transcript};
}
