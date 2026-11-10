// Child-process-only fixture. It imports NEW production handlers unchanged.
// All Telegram, network and CLI boundaries are fake; no bot.start()/real CLI.
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
import { Bot } from 'grammy';

const scenario = process.argv[2];
const fixtureHome = process.env.HOME;
if (!['voice', 'progress'].includes(scenario) || process.env.REFERENCE_FIXTURE !== 'voice-progress' ||
    !path.basename(fixtureHome || '').startsWith('msb-reference-voice-progress-') ||
    process.env.BOT_TOKEN !== '42:reference-fixture-only' ||
    await fs.realpath(process.cwd()) !== await fs.realpath(fixtureHome)) {
  throw new Error('Refusing to run outside the isolated reference fixture.');
}
const { fixtureClaudeVersion, fixtureVersionExec } = await import('../../helpers/claude-version-fixture.mjs');
await fixtureClaudeVersion(fixtureHome);
const transcript = process.env.REFERENCE_TRANSCRIPT;
const answer = process.env.REFERENCE_ANSWER;
const result = { api: [], fetches: [], cli: [], forbiddenNetwork: [], forbiddenProcesses: [], pollingStarted: false };
const startedAt = Date.now();
const at = () => Date.now() - startedAt;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function denyNetwork(kind) {
  return (..._args) => {
    result.forbiddenNetwork.push(kind);
    throw new Error(`Real network is forbidden in the reference fixture: ${kind}`);
  };
}
net.Socket.prototype.connect = denyNetwork('net.Socket.connect');
net.connect = denyNetwork('net.connect');
net.createConnection = denyNetwork('net.createConnection');
tls.connect = denyNetwork('tls.connect');
http.request = denyNetwork('http.request');
http.get = denyNetwork('http.get');
https.request = denyNetwork('https.request');
https.get = denyNetwork('https.get');
dgram.createSocket = denyNetwork('dgram.createSocket');
if (globalThis.WebSocket) globalThis.WebSocket = class { constructor() { denyNetwork('WebSocket')(); } };

globalThis.fetch = async (input, options = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const headers = Object.fromEntries(new Headers(options.headers).entries());
  const body = options.body;
  const bytes = body instanceof ArrayBuffer ? [...new Uint8Array(body)]
    : ArrayBuffer.isView(body) ? [...new Uint8Array(body.buffer, body.byteOffset, body.byteLength)] : [];
  result.fetches.push({ url, method: options.method || 'GET', headers, bytes, hasAbortSignal: options.signal instanceof AbortSignal, at: at() });
  if (url === 'https://api.telegram.org/file/bot42:reference-fixture-only/voice/reference.oga') {
    return new Response(new Uint8Array([79, 103, 103, 83]), { headers: { 'content-type': 'audio/ogg' } });
  }
  if (url.startsWith('https://api.deepgram.com/v1/listen?')) {
    return new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript }] }] } }), { headers: { 'content-type': 'application/json' } });
  }
  return denyNetwork(`fetch ${new URL(url).origin}`)();
};

const liveIntervals = new Set();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (...args) => {
  const handle = realSetInterval(...args);
  liveIntervals.add(handle);
  return handle;
};
globalThis.clearInterval = (handle) => {
  liveIntervals.delete(handle);
  return realClearInterval(handle);
};

function denyProcess(command) {
  result.forbiddenProcesses.push(String(command));
  throw new Error(`Unexpected OS process in reference fixture: ${command}`);
}
for (const method of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawnSync', 'fork']) {
  childProcess[method] = denyProcess;
}
childProcess.execFile = fixtureVersionExec(fixtureHome, denyProcess);
childProcess.spawn = (command, args, options) => {
  if (command !== 'claude') return denyProcess(command);
  if (options.cwd !== process.env.MSB_WORKSPACE_DIR || options.env.HOME !== fixtureHome) {
    return denyProcess('CLI outside fixture HOME/workspace');
  }
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  // No PID: abort code cannot accidentally signal a real process group.
  const call = { args, prompt: '', startedAt: at(), finishedAt: null };
  result.cli.push(call);
  let timer;
  let closed = false;
  const close = (code, signal = null) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    call.finishedAt = at();
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code, signal);
  };
  child.kill = (signal) => { close(null, signal); return true; };
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', (text) => { call.prompt += text; });
  child.stdin.on('end', () => {
    const emit = (event) => child.stdout.write(JSON.stringify(event) + '\n');
    emit({ type: 'system', subtype: 'init', session_id: 'reference-native-session', model: 'claude-haiku-4-5-20251001' });
    timer = setTimeout(() => {
      emit({ type: 'assistant', session_id: 'reference-native-session', message: {
        role: 'assistant', model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: answer }],
        usage: { input_tokens: 30000, output_tokens: 12 },
      } });
      emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'reference-native-session', result: answer,
        total_cost_usd: 0, usage: { input_tokens: 30000, output_tokens: 12 } });
      close(0);
    }, scenario === 'progress' ? 6500 : 30);
  });
  return child;
};
syncBuiltinESMExports();

const botRoot = path.join(fixtureHome, '.msb/bots/default');
await fs.mkdir(botRoot, { recursive: true });
await fs.mkdir(process.env.MSB_SESSION_DIR, { recursive: true });
await fs.mkdir(process.env.MSB_WORKSPACE_DIR, { recursive: true });
await fs.writeFile(path.join(fixtureHome, '.msb/.env'), 'DEEPGRAM_API_KEY=fixture-deepgram-only\n', { mode: 0o600 });
await fs.writeFile(path.join(botRoot, '.env'), 'MSB_BOT_ID=default\n', { mode: 0o600 });
await fs.writeFile(path.join(botRoot, 'state.json'), JSON.stringify({
  engine: 'cc', authMode: 'subscription', hasSubscriptionAuth: true,
  userId: 42, chatId: 42, ccModel: 'haiku', ccEffort: 'high', ccSessionId: 'reference-native-session',
}));

let nextMessageId = 1000;
const originalUse = Bot.prototype.use;
Bot.prototype.use = function (...middleware) {
  if (!this.__referenceTransport) {
    this.__referenceTransport = true;
    // Innermost transformer: every subsequently installed vendor/library transformer
    // still terminates here, never at Grammy's network transport.
    this.api.config.use(async (_previous, method, payload) => {
      const call = { method, payload: JSON.parse(JSON.stringify(payload)), at: at() };
      result.api.push(call);
      let value;
      if (method === 'getMe') value = { id: 99, is_bot: true, first_name: 'Reference', username: 'reference_fixture_bot' };
      else if (method === 'getFile') value = { file_id: 'fixture-voice', file_unique_id: 'fixture-unique', file_path: 'voice/reference.oga', file_size: 4 };
      else if (['sendMessage', 'editMessageText'].includes(method)) {
        call.resultMessageId = payload.message_id || ++nextMessageId;
        value = { message_id: call.resultMessageId, date: 1, chat: { id: 42, type: 'private' }, from: { id: 99, is_bot: true, first_name: 'Reference' }, text: payload.text };
      } else if (['setMyCommands', 'sendChatAction', 'deleteMessage', 'answerCallbackQuery'].includes(method)) value = true;
      else throw new Error(`Unmocked Grammy method: ${method}`);
      return { ok: true, result: value };
    });
  }
  return originalUse.apply(this, middleware);
};
Bot.prototype.start = async function () {
  result.pollingStarted = true;
  throw new Error('Polling must never start in this fixture.');
};

const { createBot } = await import('../../../src/telegram/bot.mjs');
const { readConfig } = await import('../../../src/config.mjs');
const bot = createBot(readConfig());
bot.botInfo = { id: 99, is_bot: true, first_name: 'Reference', username: 'reference_fixture_bot' };
const message = {
  message_id: 501, date: 1, chat: { id: 42, type: 'private' },
  from: { id: 42, is_bot: false, first_name: 'Fixture owner' },
  ...(scenario === 'voice' ? {
    message_thread_id: 7,
    voice: { file_id: 'fixture-voice', file_unique_id: 'fixture-unique', duration: 17, mime_type: 'audio/ogg', file_size: 4 },
    reply_to_message: { message_id: 500, date: 1, chat: { id: 42, type: 'private' }, from: { id: 42, is_bot: false, first_name: 'Fixture owner' }, text: 'Это исходное сообщение для голосового ответа.' },
  } : { text: 'Задача для проверки индикации.' }),
};
await bot.handleUpdate({ update_id: 1, message });
// Long turns now run outside polling. Observe their delivery, not handler return.
const deadline = Date.now() + 10000;
while (Date.now() < deadline) {
  const delivered = result.api.some(call => ['sendMessage', 'editMessageText'].includes(call.method) && String(call.payload.text || '').includes(answer));
  if (result.cli.length && result.cli.every(call => call.finishedAt !== null) && delivered) break;
  // The current voice placeholder is a completed negative observation, not a pass.
  if (scenario === 'voice' && result.api.some(call => /Медиа принято/.test(call.payload.text || ''))) break;
  await wait(20);
}
if (scenario === 'progress' && !result.cli.some(call => call.finishedAt !== null)) throw Error('Delayed CLI fixture did not finish');
await wait(300);
result.activeIntervals = liveIntervals.size;
for (const handle of liveIntervals) realClearInterval(handle);
process.stdout.write(`MSB_REFERENCE_RESULT=${JSON.stringify(result)}\n`);
process.exit(0);
