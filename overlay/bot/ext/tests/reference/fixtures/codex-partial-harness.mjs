/** Real Telegram turn → PATH shim → synthetic Codex JSONL. No network or working profile. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot } from 'grammy';

const scenario = process.argv[2];
const home = process.env.HOME;
if (!scenario?.startsWith('codex-partial-') || !home || home !== process.env.REFERENCE_HOME ||
    home !== os.homedir() || !globalThis[Symbol.for('msb.reference.networkBlocked')]) {
  throw Error('Codex partial fixture requires its isolated HOME and network guard');
}
const thread = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const session = 'ext:codex:' + thread;
const resumed = !scenario.endsWith('-first');
const root = path.join(home, '.msb', 'bots', 'default');
const native = path.join(home, '.codex');
const bin = path.join(home, 'bin');
const workspace = path.join(home, 'workspace');
const trace = path.join(home, 'cli-trace.jsonl');
const stateFile = path.join(root, 'state.json');
const storeFile = path.join(root, 'ext-providers.json');
const priorUsage = { sessionId: session, contextTokens: 980, contextWindow: 1000 };
await Promise.all([root, bin, workspace, path.join(native, 'sessions')].map(dir => fs.mkdir(dir, { recursive: true })));
const fake = (await fs.readFile(new URL('./fake-provider-cli.mjs', import.meta.url), 'utf8'))
  .replace(/^#![^\n]+/, '#!' + process.execPath);
await fs.writeFile(path.join(bin, 'codex'), fake, { mode: 0o700 });
await fs.writeFile(path.join(native, 'auth.json'), '{"tokens":{"access_token":"synthetic-only"}}', { mode: 0o600 });
await fs.writeFile(stateFile, JSON.stringify({ engine: 'cc', extAuthBypass: 'codex', authMode: 'subscription',
  hasSubscriptionAuth: true, userId: 42, chatId: 42, ...(resumed ? { ccSessionId: session, lastCcUsage: priorUsage } : {}) }));
await fs.writeFile(storeFile, JSON.stringify({ version: 1, active: 'codex', sessions: resumed ? { codex: thread } : {} }));
if (resumed) {
  const sample = { type: 'event_msg', timestamp: '2024-01-01T00:00:00.000Z', payload: { type: 'token_count',
    info: { model_context_window: 1000, last_token_usage: { total_tokens: 980 } } } };
  await fs.writeFile(path.join(native, 'sessions', 'rollout-fixture-' + thread + '.jsonl'), JSON.stringify(sample) + '\n');
}
const shim = fileURLToPath(new URL('../../../shim/bin/', import.meta.url));
Object.assign(process.env, { PATH: [shim, bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
  MSB_WORKSPACE_DIR: workspace, MSB_BOT_ID: 'default', BOT_TOKEN: '42:reference-only',
  ADMIN_ID: '42', REFERENCE_SCENARIO: scenario, REFERENCE_TRACE: trace });
const { readConfig } = await import('../../../../../../.msb/bot/src/config.mjs');
const { createBot } = await import('../../../../../../.msb/bot/src/telegram/bot.mjs');
const bot = new Bot('42:reference-only', { botInfo: { id: 99, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' } });
const calls = [];
let messageId = 10;
bot.api.config.use(async (_previous, method, payload) => {
  calls.push({ method, text: payload.text, id: payload.message_id, mode: payload.parse_mode, markup: Boolean(payload.reply_markup),
    callbacks: payload.reply_markup?.inline_keyboard?.flat().map(button => button.callback_data) });
  if (['setMyCommands', 'sendChatAction', 'deleteMessage'].includes(method)) return { ok: true, result: true };
  if (method !== 'sendMessage' && method !== 'editMessageText') throw Error('Unexpected Telegram method ' + method);
  return { ok: true, result: { message_id: payload.message_id ?? ++messageId, date: 1,
    chat: { id: 42, type: 'private' }, text: payload.text } };
});
createBot(readConfig(), { bot });
const diaryFile = path.join(root, 'chat-diary.jsonl');
try {
  await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 1, text: 'fixture partial request',
    from: { id: 42, is_bot: false, first_name: 'Owner' }, chat: { id: 42, type: 'private' } } });
  const deadline = Date.now() + 7000;
  while (!await fs.access(diaryFile).then(() => true, () => false)) {
    if (Date.now() > deadline) throw Error('Turn did not finish and record its reply');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await bot.stop();
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  const store = JSON.parse(await fs.readFile(storeFile, 'utf8'));
  const executions = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse)
    .filter(entry => entry.name === 'codex' && entry.argv[0] === 'exec');
  const diary = (await fs.readFile(diaryFile, 'utf8')).trim().split('\n').map(JSON.parse);
  const written = await fs.readdir(home, { recursive: true });
  process.stdout.write(JSON.stringify({
    calls, executions: executions.map(call => call.argv),
    active: state.ccSessionId ?? null, usage: state.lastCcUsage ?? null, priorUsage,
    parked: state.parkedCcSessions?.codex ?? null, pending: state.pendingCcSessionStarts ?? null,
    history: (state.sessionHistory ?? []).map(({id, providerId, messageCount}) => ({id, providerId, messageCount})),
    storedNative: store.sessions.codex ?? null,
    diary: diary.map(({status, providerId, summary}) => ({status, providerId, summary})),
    wroteSkill: written.some(file => file.endsWith('failed-turn-skill/SKILL.md')),
    wroteDiagnosticSkill: written.some(file => file.endsWith('raw-error-skill/SKILL.md')),
  }));
} finally {
  await bot.stop();
}
