// Real Grammy polling + real production handlers. Only transport/CLI are faked.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const scenario = process.argv[2];
if (!['early-stop', 'status-failure', 'late-edit', 'next-turn', 'saved-session', 'empty-session', 'reset-session', 'provider-roundtrip', 'provider-reset', 'provider-clear'].includes(scenario)) {
  throw new Error('Unknown lifecycle scenario');
}
const fixtureHome = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-turn-lifecycle-'));
const report = { events: [], calls: [], cli: [], statusIds: [], finalMessages: {}, unhandled: [], forbidden: [], maxActiveChildren: 0 };
const children = [];
let bot, polling, stopPromise, updateId = 0, messageId = 100, activeChildren = 0;
let firstStatus = true, firstProgress = true;
let releaseInitial, releaseProgress;
const initialGate = new Promise((resolve) => { releaseInitial = resolve; });
const progressGate = new Promise((resolve) => { releaseProgress = resolve; });
const inbox = [];
let notifyInbox;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
const watchdog = setTimeout(() => { console.error(`Lifecycle timeout ${scenario}: ${report.events.join(' -> ')}`); process.exit(2); }, 6000);
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const liveIntervals = new Set();
globalThis.setInterval = (...args) => {
  const timer = nativeSetInterval(...args);
  liveIntervals.add(timer);
  return timer;
};
globalThis.clearInterval = (timer) => {
  liveIntervals.delete(timer);
  return nativeClearInterval(timer);
};
process.on('unhandledRejection', (err) => report.unhandled.push(String(err?.message || err)));

async function until(condition, label) {
  const deadline = Date.now() + 1600;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Did not observe ${label}; events=${report.events.join(' -> ')}`);
    await wait(5);
  }
}
const has = (event) => report.events.includes(event);
function hasAnswer(number) {
  const cli = report.cli.find((entry) => entry.number === number);
  const text = new RegExp(`^success-${number}\\n\\n<blockquote>⏱ \\d+\\.\\ds</blockquote>$`);
  return report.calls.some((call) => call.applied && call.method === 'editMessageText'
    && call.messageId === cli?.statusMessageId && call.parseMode === 'HTML' && text.test(call.text));
}
function send(text) {
  const id = ++updateId;
  inbox.push({ update_id: id, message: {
    message_id: id, date: 1, from: { id: 42, is_bot: false, first_name: 'Fixture' },
    chat: { id: 42, type: 'private' }, text,
    ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.length }] } : {}),
  } });
  notifyInbox?.();
}

try {
  for (const key of Object.keys(process.env)) delete process.env[key];
  const stateFile = path.join(fixtureHome, '.msb/bots/default/state.json');
  Object.assign(process.env, {
    HOME: fixtureHome, TMPDIR: fixtureHome, PATH: path.dirname(process.execPath),
    MSB_BOT_ID: 'default', MSB_WORKSPACE_DIR: fixtureHome, ADMIN_ID: '42',
    MSB_SESSION_DIR: path.join(fixtureHome, '.msb/bots/default/sessions'),
    CLAUDE_CODE_OAUTH_TOKEN: 'fixture-only',
  });
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify({
    authMode: 'subscription', hasSubscriptionAuth: true, fixtureUnrelated: 'preserve-me',
    ...(scenario === 'saved-session' ? { ccSessionId: 'saved-session-A' } : {}),
    ...(['provider-roundtrip', 'provider-reset', 'provider-clear'].includes(scenario) ? {
      engine: 'cc', extAuthBypass: 'codex',
      ccSessionId: 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53', sessionEpoch: 0,
      parkedCcSessions: { claude: 'saved-claude-session' },
    } : {}),
  }));
  if (['provider-roundtrip', 'provider-reset', 'provider-clear'].includes(scenario)) {
    await fs.mkdir(path.join(fixtureHome, '.codex'), { recursive: true });
    await fs.writeFile(path.join(fixtureHome, '.codex/auth.json'), JSON.stringify({tokens:{access_token:'fixture-only'}}));
    await fs.writeFile(path.join(path.dirname(stateFile), 'ext-providers.json'), JSON.stringify({
      version:1, active:'codex', sessions:{codex:'0199a213-81c0-7800-8aa1-bbab2a035a53'}, models:{}, efforts:{},
    }));
  }
  const forbidden = (kind) => (..._args) => {
    report.forbidden.push(kind);
    throw new Error(`Forbidden fixture boundary: ${kind}`);
  };
  globalThis.fetch = forbidden('fetch');
  for (const method of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawnSync', 'fork']) cp[method] = forbidden(method);
  cp.spawn = (command, args, options) => {
    if (command !== 'claude' || options.env.HOME !== fixtureHome) return forbidden(`spawn ${command}`)();
    const number = children.length + 1;
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const record = { number, args, prompt: '', provider: options.env.MSB_TURN_PROVIDER, statusMessageId: report.statusIds.at(-1) };
    const nativeId = record.provider === 'codex' ? `ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a5${number}` : `new-session-B-${number}`;
    report.cli.push(record);
    report.events.push(`cli-start:${number}`);
    activeChildren++;
    report.maxActiveChildren = Math.max(report.maxActiveChildren, activeChildren);
    let closed = false;
    const emit = (event) => child.stdout.write(JSON.stringify(event) + '\n');
    const close = (mode = 'abort') => {
      if (closed) return;
      closed = true;
      if (mode !== 'abort') {
        if (mode === 'late-result') report.events.push(`cli-late-result:${number}`);
        emit({ type: 'result', session_id: nativeId, result: `success-${number}`, is_error: false });
      }
      report.events.push(`cli-close:${number}`);
      activeChildren--;
      child.stdout.end(); child.stderr.end();
      child.emit('close', mode === 'abort' ? null : 0, mode === 'abort' ? 'SIGINT' : null);
    };
    child.kill = () => {
      if (!has(`cli-abort:${number}`)) report.events.push(`cli-abort:${number}`);
      return true; // Closing is deliberately controlled independently from abort.
    };
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (text) => { record.prompt += text; });
    child.stdin.on('end', () => {
      emit({ type: 'system', subtype: 'provider', provider_id: record.provider });
      emit({ type: 'system', subtype: 'init', session_id: nativeId, model: 'fixture-model' });
      report.events.push(`cli-init:${number}`);
    });
    children.push({ close });
    return child;
  };
  syncBuiltinESMExports();
  const { Api } = await import('grammy');
  Api.prototype.setMyCommands = async () => true;
  const { createBot } = await import('../../src/telegram/bot.mjs');
  bot = createBot({ botToken: '42:fixture-only', botId: 'default', adminId: 42, workspace: fixtureHome, timezone: 'UTC' });
  bot.botInfo = { id: 99, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' };
  bot.api.config.use(async (_previous, method, payload, signal) => {
    if (method === 'deleteWebhook') return { ok: true, result: true };
    if (method === 'getUpdates') {
      // Grammy stop() confirms the last offset with one non-long-poll request.
      if (payload.limit === 1 && payload.timeout === undefined) {
        report.events.push('offset-confirmed');
        return { ok: true, result: [] };
      }
      if (!has('polling-started')) report.events.push('polling-started');
      while (!inbox.length && !signal?.aborted) {
        await new Promise((resolve) => {
          const wake = () => { signal?.removeEventListener('abort', wake); notifyInbox = undefined; resolve(); };
          notifyInbox = wake;
          signal?.addEventListener('abort', wake, { once: true });
          if (signal?.aborted) wake();
        });
      }
      const updates = signal?.aborted ? [] : [inbox.shift()];
      if (updates[0]?.message.text === '/stop') report.events.push('stop-delivered');
      return { ok: true, result: updates };
    }
    if (method === 'sendMessage' || method === 'editMessageText') {
      const id = payload.message_id || ++messageId;
      const call = { method, text: payload.text, messageId: id, parseMode: payload.parse_mode, applied: false };
      report.calls.push(call);
      if (payload.text === 'Думаю ⏳' && !report.statusIds.includes(id)) report.statusIds.push(id);
      if (method === 'sendMessage' && payload.text === 'Думаю ⏳' && firstStatus) {
        firstStatus = false;
        report.initialStatusId = id;
        report.events.push('initial-status-dispatched');
        if (scenario === 'early-stop') {
          await initialGate;
          report.events.push('initial-status-released');
        } else if (scenario === 'status-failure') {
          report.events.push('initial-status-rejected');
          throw new Error('fixture initial status failed');
        }
      }
      if (method === 'editMessageText' && id === report.initialStatusId
          && payload.text === 'Думаю… ⏳' && firstProgress) {
        firstProgress = false;
        if (scenario === 'late-edit') {
          report.events.push('progress-edit-dispatched');
          await progressGate;
          report.events.push('progress-edit-applied');
        }
      }
      report.finalMessages[id] = payload.text;
      call.applied = true;
      if (payload.text === 'Моя остановочка ✋🏽⛔️') {
        report.events.push(method === 'editMessageText' ? 'stopped-edit-applied' : 'stop-acknowledged');
      }
      return { ok: true, result: { message_id: id, date: 1, chat: { id: 42, type: 'private' }, text: payload.text } };
    }
    if (method === 'sendChatAction' || method === 'deleteMessage') return { ok: true, result: true };
    throw new Error(`Unmocked Telegram API: ${method}`);
  });
  polling = bot.start();
  send('first task');

  if (scenario === 'early-stop') {
    await until(() => has('initial-status-dispatched'), 'initial status request');
    send('/stop');
    await until(() => has('stop-acknowledged'), 'early stop acknowledgement');
    releaseInitial();
    await until(() => has('stopped-edit-applied'), 'early stopped edit');
  } else if (scenario === 'status-failure') {
    await until(() => report.calls.some((call) => call.applied && call.text.includes('fixture initial status failed')), 'status failure response');
    await settle();
    send('after failed status');
    await until(() => has('cli-init:1'), 'next CLI after status failure');
    children[0].close('success');
    await until(() => hasAnswer(1), 'next answer replacing its status with the original HTML footer');
  } else if (scenario === 'reset-session') {
    await until(() => has('cli-init:1'), 'first native session before reset');
    send('/newtask');
    await until(() => report.calls.some((call) => call.applied && call.text === 'Новая сессия. Пиши задачу.'), 'newtask during the first turn');
    report.events.push('reset-acknowledged');
    children[0].close('late-result');
    await until(() => hasAnswer(1), 'late answer after reset replacing its status');
  } else if (['provider-roundtrip', 'provider-reset', 'provider-clear'].includes(scenario)) {
    await until(() => has('cli-init:1'), 'old provider turn before switch');
    if (scenario === 'provider-reset' || scenario === 'provider-clear') {
      send(scenario === 'provider-reset' ? '/newtask' : '/clear');
      const ack = scenario === 'provider-reset' ? 'Новая сессия. Пиши задачу.' : 'Начата новая беседа. Файлы и native-история сохранены.';
      await until(() => report.calls.some((call) => call.applied && call.text === ack), 'reset before switching');
      report.events.push('reset-acknowledged');
    }
    const { setActive } = await import('../../../../overlay/bot/ext/store.mjs');
    const { syncExtAuthGate } = await import('../../../../overlay/bot/ext/setup-bypass.mjs');
    await setActive('claude'); await syncExtAuthGate();
    const claudeState = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if (claudeState.ccSessionId !== 'saved-claude-session') throw new Error('Claude session was not restored');
    await setActive('codex'); await syncExtAuthGate();
    const codexState = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    const expected = scenario === 'provider-roundtrip' ? 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53' : undefined;
    if (codexState.ccSessionId !== expected) throw new Error('Codex session did not reflect the reset');
    report.events.push('provider-roundtrip-completed');
    children[0].close('late-result');
    await until(() => hasAnswer(1), 'late answer after switching');
  } else {
    await until(() => has('cli-init:1'), 'first native session');
    if (scenario === 'late-edit') await until(() => has('progress-edit-dispatched'), 'held progress edit');
    send('/stop');
    await until(() => has('cli-abort:1') && has('stop-acknowledged'), 'stop delivery and abort');
    if (scenario === 'next-turn') {
      send('too early');
      await until(() => report.calls.some((call) => call.applied && call.text === '⏳ в очереди'), 'queued with the lock retained before close');
      send('/stop');
      await until(() => report.calls.filter(call => call.applied && call.text === 'Моя остановочка ✋🏽⛔️' && call.method === 'sendMessage').length === 2, 'clear queued early probe');
    }
    children[0].close(['saved-session', 'empty-session'].includes(scenario) ? 'late-result' : 'abort');
    if (scenario === 'late-edit') releaseProgress();
    await until(() => has('stopped-edit-applied'), 'terminal stopped edit');
    await settle();
    if (scenario === 'next-turn') {
      send('second allowed');
      await until(() => has('cli-init:2'), 'replacement turn');
      send('/compact');
      await until(() => report.calls.some((call) => call.applied && call.text.startsWith('Уже работаю')), 'replacement lock remains owned');
      children[1].close('success');
      await until(() => hasAnswer(2), 'replacement answer replacing its own status');
    }
  }
  await settle();
  send('/stop');
  await until(() => report.calls.some(call => call.applied && call.text === 'Нечего останавливать 🤷'), 'idle stop response');
  stopPromise = bot.stop();
  await Promise.all([polling, stopPromise]);
  await settle();
  report.events.push('stop-drained');
  report.intervalsAfterStop = liveIntervals.size;
  report.activeChildren = activeChildren;
  report.state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  const traceDir = path.join(path.dirname(stateFile), 'traces');
  report.history = [];
  for (const name of await fs.readdir(traceDir)) report.history.push(...(await fs.readFile(path.join(traceDir, name), 'utf8')).trim().split('\n').map(JSON.parse));
  console.log('LIFECYCLE_RESULT=' + JSON.stringify(report));
} finally {
  releaseInitial(); releaseProgress();
  for (const child of children) child.close();
  if (bot && !stopPromise) await bot.stop().catch(() => {});
  if (polling) await polling.catch(() => {});
  for (const timer of liveIntervals) nativeClearInterval(timer);
  globalThis.setInterval = nativeSetInterval;
  globalThis.clearInterval = nativeClearInterval;
  clearTimeout(watchdog);
  await fs.rm(fixtureHome, { recursive: true, force: true });
}
