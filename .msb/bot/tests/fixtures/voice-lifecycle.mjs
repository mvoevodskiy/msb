// Real Grammy polling and production voice handlers; all I/O stays in this fixture.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';

const scenario = process.argv[2];
if (!['stop-download', 'stop-stt', 'stop-preview', 'missing-key', 'pending-env', 'non-owner'].includes(scenario)) {
  throw Error('Unknown voice lifecycle scenario');
}
const fixtureHome = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-voice-lifecycle-'));
const report = { events: [], calls: [], fetches: [], cli: [], finalMessages: {}, deleted: [], forbidden: [], unhandled: [] };
const transcript = 'Это голосовая задача, а не значение ключа. ' + 'Полная расшифровка. '.repeat(20) + 'КОНЕЦ_ГОЛОСОВОГО';
const botToken = '42:voice-fixture-only';
const stopped = 'Моя остановочка ✋🏽⛔️';
const nativeTimers = {
  setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
};
const liveTimeouts = new Set(), liveIntervals = new Set();
globalThis.setTimeout = (fn, delay, ...args) => {
  const timer = nativeTimers.setTimeout(() => { liveTimeouts.delete(timer); fn(...args); }, delay);
  liveTimeouts.add(timer); return timer;
};
globalThis.clearTimeout = timer => {
  liveTimeouts.delete(timer); liveIntervals.delete(timer); return nativeTimers.clearTimeout(timer);
};
globalThis.setInterval = (...args) => {
  const timer = nativeTimers.setInterval(...args); liveIntervals.add(timer); return timer;
};
globalThis.clearInterval = timer => {
  liveIntervals.delete(timer); liveTimeouts.delete(timer); return nativeTimers.clearInterval(timer);
};
const watchdog = nativeTimers.setTimeout(() => {
  console.error(`Voice lifecycle timeout ${scenario}: ${report.events.join(' -> ')}`); process.exit(2);
}, 7000);
const wait = ms => new Promise(resolve => nativeTimers.setTimeout(resolve, ms));
const settle = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
const has = event => report.events.includes(event);
async function until(condition, label) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw Error(`Missing ${label}; events=${report.events.join(' -> ')}`);
    await wait(5);
  }
}
process.on('unhandledRejection', error => report.unhandled.push(String(error?.message || error)));
const forbidden = kind => (..._args) => {
  report.forbidden.push(kind); throw Error(`Forbidden voice fixture boundary: ${kind}`);
};

let bot, polling, stopPromise, updateId = 0, messageId = 100, lastDelivered;
let releaseNetwork, releasePreview, notifyInbox;
const networkGate = new Promise(resolve => { releaseNetwork = resolve; });
const previewGate = new Promise(resolve => { releasePreview = resolve; });
const inbox = [], children = [];
const chat = { id: 42, type: 'private' };
const from = id => ({ id, is_bot: false, first_name: 'Fixture' });
function queue(update) {
  const id = ++updateId;
  inbox.push({ update_id: id, ...update }); notifyInbox?.(); return id;
}
function sendText(text) {
  return queue({ message: {
    message_id: 500 + updateId, date: 1, chat, from: from(42), text,
    ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.length }] } : {}),
  } });
}
function sendVoice(owner = 42) {
  return queue({ message: {
    message_id: 501, date: 1, chat, from: from(owner), message_thread_id: 7,
    voice: { file_id: 'fixture-voice', file_unique_id: 'fixture-unique', duration: 5, mime_type: 'audio/ogg', file_size: 4 },
  } });
}
function callback(data, id = 90) {
  return queue({ callback_query: {
    id: `callback-${updateId}`, from: from(42), chat_instance: 'fixture', data,
    message: { message_id: id, date: 1, chat, from: { id: 99, is_bot: true, first_name: 'Fixture' }, text: 'fixture menu' },
  } });
}

try {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    HOME: fixtureHome, TMPDIR: fixtureHome, PATH: path.dirname(process.execPath),
    MSB_BOT_ID: 'default', MSB_WORKSPACE_DIR: fixtureHome, ADMIN_ID: '42',
    MSB_SESSION_DIR: path.join(fixtureHome, '.msb/bots/default/sessions'),
    CLAUDE_CODE_OAUTH_TOKEN: 'fixture-auth-unchanged',
    ...(scenario !== 'missing-key' ? { DEEPGRAM_API_KEY: 'fixture-deepgram' } : {}),
  });
  const { fixtureClaudeVersion, fixtureVersionExec } = await import('../helpers/claude-version-fixture.mjs');
  await fixtureClaudeVersion(fixtureHome);
  process.chdir(fixtureHome);
  const botRoot = path.join(fixtureHome, '.msb/bots/default');
  const stateFile = path.join(botRoot, 'state.json');
  const envFile = path.join(botRoot, '.env');
  await fs.mkdir(botRoot, { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify({
    authMode: 'subscription', hasSubscriptionAuth: true,
    ccSessionId: 'saved-session', fixtureUnrelated: 'preserve-me',
  }));
  report.envBefore = 'FIXTURE_KEEP=unchanged\n' + (scenario === 'missing-key' ? '' : 'DEEPGRAM_API_KEY=fixture-deepgram\n');
  await fs.writeFile(envFile, report.envBefore);

  for (const api of [http, https]) api.request = api.get = forbidden('HTTP socket');
  net.connect = net.createConnection = net.Socket.prototype.connect = forbidden('TCP socket');
  net.Server.prototype.listen = forbidden('listen');
  tls.connect = forbidden('TLS socket');
  dgram.createSocket = forbidden('UDP socket');
  if (globalThis.WebSocket) globalThis.WebSocket = class { constructor() { forbidden('WebSocket')(); } };
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const stage = url === `https://api.telegram.org/file/bot${botToken}/voice/fixture.oga` ? 'download'
      : url.startsWith('https://api.deepgram.com/v1/listen?') ? 'stt' : null;
    if (!stage) return forbidden('unexpected fetch')();
    const call = { stage, hasSignal: options.signal instanceof AbortSignal, aborted: false, returned: false };
    report.fetches.push(call); report.events.push(`${stage}-started`);
    const onAbort = () => { call.aborted = true; report.events.push(`${stage}-aborted`); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    try {
      if (scenario === `stop-${stage}`) await networkGate;
      // A late network response deliberately ignores cancellation; the caller must fence it.
      call.returned = true; report.events.push(`${stage}-returned`);
      if (stage === 'download') return new Response(new Uint8Array([79, 103, 103, 83]));
      return new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript }] }] } }), { headers: { 'content-type': 'application/json' } });
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  };
  for (const method of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawnSync', 'fork']) cp[method] = forbidden(method);
  cp.execFile = fixtureVersionExec(fixtureHome, kind => forbidden(kind)());
  cp.spawn = (command, args, options) => {
    if (command !== 'claude' || options.env.HOME !== fixtureHome || options.cwd !== fixtureHome) return forbidden('unexpected spawn')();
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const call = { args, prompt: '', closed: false };
    report.cli.push(call); report.events.push('cli-start');
    const emit = value => child.stdout.write(JSON.stringify(value) + '\n');
    const close = signal => {
      if (call.closed) return;
      call.closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', signal ? null : 0, signal || null);
    };
    child.kill = signal => { report.events.push('cli-aborted'); close(signal); return true; };
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', value => { call.prompt += value; });
    child.stdin.on('end', () => setImmediate(() => {
      if (call.closed) return;
      emit({ type: 'system', subtype: 'init', session_id: 'saved-session', model: 'fixture-model' });
      emit({ type: 'result', session_id: 'saved-session', is_error: false, result: 'voice-answer' });
      close();
    }));
    children.push({ close }); return child;
  };
  syncBuiltinESMExports();

  const { Api } = await import('grammy');
  Api.prototype.setMyCommands = async () => true;
  const { createBot } = await import('../../src/telegram/bot.mjs');
  bot = createBot({ botToken, botId: 'default', adminId: 42, workspace: fixtureHome, timezone: 'UTC' });
  bot.botInfo = { id: 99, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' };
  bot.api.config.use(async (_previous, method, payload, signal) => {
    if (method === 'deleteWebhook') return { ok: true, result: true };
    if (method === 'getUpdates') {
      if (lastDelivered !== undefined) { report.events.push(`processed:${lastDelivered}`); lastDelivered = undefined; }
      if (payload.limit === 1 && payload.timeout === undefined) return { ok: true, result: [] };
      if (!has('polling-started')) report.events.push('polling-started');
      while (!inbox.length && !signal?.aborted) {
        await new Promise(resolve => {
          const wake = () => { signal?.removeEventListener('abort', wake); notifyInbox = undefined; resolve(); };
          notifyInbox = wake; signal?.addEventListener('abort', wake, { once: true });
          if (signal?.aborted) wake();
        });
      }
      const update = signal?.aborted ? undefined : inbox.shift();
      if (update) lastDelivered = update.update_id;
      return { ok: true, result: update ? [update] : [] };
    }
    const call = { method, ...payload, applied: false };
    report.calls.push(call);
    if (method === 'getFile') {
      call.hasSignal = signal instanceof AbortSignal;
      return { ok: true, result: { file_id: 'fixture-voice', file_unique_id: 'fixture-unique', file_path: 'voice/fixture.oga', file_size: 4 } };
    }
    if (method === 'sendMessage' || method === 'editMessageText') {
      const id = payload.message_id || ++messageId; call.message_id = id;
      if (method === 'sendMessage' && payload.text === '🎙 Расшифровываю...') report.transcriptionId = id;
      if (method === 'sendMessage' && payload.text === 'Думаю ⏳') report.statusId = id;
      if (method === 'sendMessage' && payload.text.startsWith('🎙 Голосовые пока не настроены.')) report.onboardingId = id;
      if (method === 'editMessageText' && id === report.transcriptionId && payload.text.startsWith('<blockquote>')) {
        report.events.push('preview-dispatched');
        if (scenario === 'stop-preview') await previewGate;
        report.events.push('preview-applied');
      }
      report.finalMessages[id] = payload.text; call.applied = true;
      if (payload.text === stopped) report.events.push(method === 'editMessageText' ? 'stopped-edit' : 'stop-acknowledged');
      return { ok: true, result: { message_id: id, date: 1, chat, text: payload.text, message_thread_id: payload.message_thread_id } };
    }
    if (method === 'deleteMessage') {
      delete report.finalMessages[payload.message_id]; report.deleted.push(payload.message_id); call.applied = true;
      if (payload.message_id === report.transcriptionId) report.events.push('transcription-deleted');
      return { ok: true, result: true };
    }
    if (method === 'sendChatAction' || method === 'answerCallbackQuery') { call.applied = true; return { ok: true, result: true }; }
    return forbidden(`Telegram ${method}`)();
  });

  polling = bot.start();
  if (scenario === 'pending-env') {
    callback('settings:env:quick:DEEPGRAM_API_KEY');
    await until(() => report.calls.some(call => call.applied && call.text === 'Пришли значение для <code>DEEPGRAM_API_KEY</code>.'), 'pending env form');
  }
  const voiceUpdate = sendVoice(scenario === 'non-owner' ? 13 : 42);
  if (scenario.startsWith('stop-')) {
    const stage = scenario.slice('stop-'.length);
    await until(() => has(stage === 'preview' ? 'preview-dispatched' : `${stage}-started`), `held ${stage}`);
    sendText('/stop');
    await until(() => has('stop-acknowledged'), 'stop acknowledgement while speech is pending');
    if (stage !== 'preview') await until(() => has(`${stage}-aborted`), 'cancellation reaches network signal');
    sendText('too early');
    await until(() => report.calls.some(call => call.applied && call.text === '⏳ в очереди'), 'queued while the pending operation drains');
    sendText('/stop');
    await until(() => report.calls.filter(call => call.applied && call.text === stopped && call.method === 'sendMessage').length === 2, 'clear the queued probe');
    releaseNetwork(); releasePreview();
    await until(() => has('stopped-edit') && has('transcription-deleted'), 'stopped status and transcription cleanup');
  } else if (scenario === 'missing-key') {
    await until(() => report.onboardingId && has('transcription-deleted') && report.deleted.includes(report.statusId), 'onboarding with both temporary messages removed');
    callback('whisper:skip', report.onboardingId);
    await until(() => report.finalMessages[report.onboardingId] === 'Когда захочешь — отправь голосовое снова.\nИли подключи Deepgram в /settings → 🔑', 'functional old skip callback');
  } else if (scenario === 'pending-env') {
    await until(() => report.calls.some(call => call.applied && call.text?.startsWith('voice-answer\n')), 'completed voice answer');
    report.envAfterVoice = await fs.readFile(envFile, 'utf8');
    report.keyAfterVoice = process.env.DEEPGRAM_API_KEY;
    sendText('fixture-typed-key');
    await until(() => report.calls.some(call => call.applied && call.text?.startsWith('Описание для <code>DEEPGRAM_API_KEY</code>')), 'typed value reaches old description step');
    const descriptionPrompt = report.calls.find(call => call.applied && call.text?.startsWith('Описание для <code>DEEPGRAM_API_KEY</code>'));
    callback('settings:env:skip-comment', descriptionPrompt.message_id);
    await until(() => report.calls.some(call => call.applied && call.text?.startsWith('Сохранил <code>DEEPGRAM_API_KEY</code> в .env бота.')), 'typed input still consumes the pending env form');
  } else if (scenario === 'non-owner') {
    await until(() => has(`processed:${voiceUpdate}`), 'foreign update processed by the real polling middleware');
    report.beforeOwnerProbe = { calls: report.calls.length, fetches: report.fetches.length, cli: report.cli.length };
  }

  await settle();
  sendText('/stop');
  await until(() => report.calls.some(call => call.applied && call.text === 'Нечего останавливать 🤷'), 'idle stop after voice cleanup');
  stopPromise = bot.stop();
  await Promise.all([polling, stopPromise]);
  await settle();
  report.events.push('stop-drained');
  report.timersAfterStop = { intervals: liveIntervals.size, timeouts: liveTimeouts.size };
  report.state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  report.envAfter = await fs.readFile(envFile, 'utf8');
  report.authAfter = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  report.transcript = transcript;
  console.log('VOICE_LIFECYCLE_RESULT=' + JSON.stringify(report));
} finally {
  releaseNetwork(); releasePreview();
  for (const child of children) child.close('SIGINT');
  if (bot && !stopPromise) await bot.stop().catch(() => {});
  if (polling) await polling.catch(() => {});
  for (const timer of liveIntervals) nativeTimers.clearInterval(timer);
  for (const timer of liveTimeouts) nativeTimers.clearTimeout(timer);
  Object.assign(globalThis, nativeTimers);
  nativeTimers.clearTimeout(watchdog);
  process.chdir(os.tmpdir());
  await fs.rm(fixtureHome, { recursive: true, force: true });
}
