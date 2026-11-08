import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'history-lifecycle-'));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { HOME: home, PATH: path.dirname(process.execPath), MSB_BOT_ID: 'default', MSB_WORKSPACE_DIR: home, CLAUDE_CODE_OAUTH_TOKEN: 'fixture' });
const { fixtureClaudeVersion } = await import('../helpers/claude-version-fixture.mjs');
await fixtureClaudeVersion(home);
const root = path.join(home, '.msb/bots/default');
await fs.mkdir(root, { recursive: true });
await fs.writeFile(path.join(root, 'state.json'), JSON.stringify({ authMode: 'subscription', hasSubscriptionAuth: true }));
const calls = [];
let phase = 'success', active = 'codex', id = 0, bot;
const until = async fn => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('fixture timeout'); };
const traces = async () => { try { return (await fs.readFile(path.join(root, 'traces', new Date().toISOString().slice(0,10) + '.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse); } catch { return []; } };
try {
  globalThis.fetch = async () => { throw Error('No network allowed'); };
  const { Api } = await import('grammy');
  Api.prototype.setMyCommands = async () => true;
  const { createBot } = await import('../../src/telegram/bot.mjs');
  bot = createBot({ botToken: '42:fixture', botId: 'default', adminId: 42, workspace: home, timezone: 'UTC' }, {
    runTurn: async ({ onStatus }) => {
      const providerId = active;
      onStatus({ kind: 'provider', providerId });
      active = providerId === 'claude' ? 'codex' : 'claude'; // selection changes before completion
      return { ok: phase !== 'agent-error', text: phase === 'agent-error' ? 'agent failed' : 'model answer', result: { providerId, toolCount: 2 } };
    },
  });
  bot.botInfo = { id: 99, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' };
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, text: payload.text, phase });
    if (phase === 'delivery-failure' && payload.text?.startsWith('model answer')) throw Error('fixture delivery rejected');
    return { ok: true, result: { message_id: ++id, date: 1, chat: { id: 42, type: 'private' }, text: payload.text } };
  });
  const send = async () => bot.handleUpdate({ update_id: ++id, message: { message_id: id, date: 1, from: { id: 42, is_bot: false, first_name: 'Owner' }, chat: { id: 42, type: 'private' }, text: 'request-' + phase } });
  for (const step of ['success', 'agent-error', 'delivery-failure']) {
    phase = step; const before = (await traces()).length; await send(); await until(async () => (await traces()).length > before);
  }
  await until(async () => { try { return (await fs.readFile(path.join(root, 'chat-diary.jsonl'), 'utf8')).trim().split('\n').length === 3; } catch { return false; } });
  const records = await traces();
  const diary = (await fs.readFile(path.join(root, 'chat-diary.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  // Block only the trace path: a journaling error must leave Telegram usable.
  await fs.rm(path.join(root, 'traces'), { recursive: true }); await fs.writeFile(path.join(root, 'traces'), 'blocked');
  const append = fs.appendFile; let release, flushing = false, shutdownDone = false;
  const gate = new Promise(resolve => { release = resolve; });
  fs.appendFile = async (file, ...args) => { if (String(file).endsWith('/chat-diary.jsonl')) { flushing = true; await gate; } return append(file, ...args); };
  phase = 'log-failure'; const before = calls.length; await send();
  await until(() => calls.slice(before).some(c => c.text?.startsWith('model answer')));
  await until(() => flushing);
  const shutdown = bot.stop().catch(() => {}).finally(() => { shutdownDone = true; });
  await new Promise(resolve => setImmediate(resolve));
  if (shutdownDone) throw Error('shutdown did not await journal');
  release(); await shutdown; fs.appendFile = append;
  console.log('HISTORY_RESULT=' + JSON.stringify({ records, diary, calls }));
} finally { await bot?.stop().catch(() => {}); await fs.rm(home, { recursive: true, force: true }); }
