// Synthetic transport only: no server, native auth or real CLI.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-stop-reference-'));
const events = [], calls = [];
let bot, child, autoClose, markStarted, shutdown;
const started = new Promise(resolve => { markStarted = resolve; });
const watchdog = setTimeout(() => { console.error('Fixture timed out'); process.exit(2); }, 4000);
try {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { HOME: home, MSB_BOT_ID: 'default', MSB_WORKSPACE_DIR: home, ADMIN_ID: '42', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-only' });
  const { fixtureClaudeVersion } = await import('../../helpers/claude-version-fixture.mjs');
  await fixtureClaudeVersion(home);
  globalThis.fetch = async () => { throw Error('Unexpected real fetch'); };
  cp.spawn = (command) => {
    if (command !== 'claude') throw Error(`Unexpected child: ${command}`);
    events.push('cli-start');
    markStarted();
    child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let closed = false;
    const close = (aborted) => {
      if (closed) return; closed = true; clearTimeout(autoClose);
      events.push('cli-close');
      if (!aborted) {
        child.stdout.write(JSON.stringify({ type: 'result', session_id: 'fixture-session', result: 'fixture answer', is_error: false }) + '\n');
      }
      child.emit('close', aborted ? null : 0, aborted ? 'SIGINT' : null);
    };
    child.kill = () => { events.push('cli-abort'); queueMicrotask(() => close(true)); return true; };
    // Finite task: a blocked /stop must not hang the test suite.
    autoClose = setTimeout(() => close(false), 350);
    return child;
  };
  syncBuiltinESMExports();
  const { Api } = await import('grammy');
  Api.prototype.setMyCommands = async () => true;
  const { createBot } = await import('../../../src/telegram/bot.mjs');
  bot = createBot({ botToken: '42:fixture', botId: 'default', adminId: 42, workspace: home, timezone: 'UTC' });
  bot.botInfo = { id: 99, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' };
  let batch = 0, messageId = 100;
  const update = (id, text) => ({ update_id: id, message: { message_id: id, date: 1, from: { id: 42, is_bot: false, first_name: 'Fixture' }, chat: { id: 42, type: 'private' }, text, ...(text === '/stop' ? { entities: [{ type: 'bot_command', offset: 0, length: 5 }] } : {}) } });
  bot.api.config.use(async (_prev, method, payload, signal) => {
    calls.push({ method, text: payload.text });
    if (method === 'deleteWebhook') return { ok: true, result: true };
    if (method === 'getUpdates') {
      if (!signal && payload.limit === 1) return { ok: true, result: [] }; // Grammy final offset acknowledgement
      if (batch++ === 0) return { ok: true, result: [update(1, 'reference task')] };
      if (batch === 2) { await started; events.push('stop-delivered'); return { ok: true, result: [update(2, '/stop')] }; }
      await new Promise(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', resolve, { once: true }); });
      return { ok: true, result: [] };
    }
    if (method === 'sendMessage' || method === 'editMessageText') {
      if (/останов|Останавливаю|ничего не выполняется/i.test(payload.text || '')) queueMicrotask(() => { shutdown = bot.stop(); });
      return { ok: true, result: { message_id: payload.message_id || ++messageId, date: 1, chat: { id: 42, type: 'private' }, text: payload.text } };
    }
    if (method === 'sendChatAction' || method === 'deleteMessage') return { ok: true, result: true };
    throw Error(`Unexpected Telegram API: ${method}`);
  });
  await bot.start();
  await shutdown;
  console.log('REFERENCE_RESULT=' + JSON.stringify({ events, calls }));
} finally {
  clearTimeout(watchdog); clearTimeout(autoClose);
  await fs.rm(home, { recursive: true, force: true });
}
