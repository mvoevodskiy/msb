// Real turn/state/provider-switch path; isolated HOME and synthetic CLI only.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const scenario = process.argv[2];
const provider = scenario.startsWith('claude-') ? 'claude' : 'codex';
const other = provider === 'codex' ? 'claude' : 'codex';
const ids = { codex: 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53', claude: 'claude-first-fixture' };
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-first-session-'));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { HOME: home, PATH: path.dirname(process.execPath), MSB_BOT_ID: 'default',
  MSB_WORKSPACE_DIR: home, MSB_SESSION_DIR: path.join(home, 'sessions'), CLAUDE_CODE_OAUTH_TOKEN: 'fixture' });
const { fixtureClaudeVersion } = await import('../helpers/claude-version-fixture.mjs');
await fixtureClaudeVersion(home);
const file = path.join(home, '.msb/bots/default/state.json');
await fs.mkdir(path.dirname(file), { recursive: true });
await fs.mkdir(path.join(home, '.codex'));
await fs.writeFile(path.join(home, '.codex/auth.json'), JSON.stringify({ tokens: { access_token: 'fixture' } }));
await fs.writeFile(file, JSON.stringify({ engine: 'cc', authMode: 'subscription', hasSubscriptionAuth: true,
  ...(provider === 'codex' ? { extAuthBypass: 'codex' } : {}),
  sessionEpoch: 0, ...(scenario.endsWith('-existing') ? { ccSessionId: ids[provider] } : {}), parkedCcSessions: { [other]: ids[other] }, fixtureUnrelated: 'preserved' }));
const children = [];
cp.spawn = (command, args, options) => {
  if (command !== 'claude' || options.env.HOME !== home) throw Error('Unexpected CLI');
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => true;
  const record = { args, provider: options.env.MSB_TURN_PROVIDER, child };
  children.push(record);
  queueMicrotask(() => child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init',
    provider_id: record.provider, ...(record.provider === 'claude' ? {} : { apiKeySource: 'ext' }),
    session_id: ids[record.provider], model: 'fixture' }) + '\n'));
  return child;
};
syncBuiltinESMExports();
globalThis.fetch = () => { throw Error('Network forbidden'); };
const waitFor = async n => { for (let i = 0; i < 200; i++) { if (children.length >= n) return; await new Promise(r => setTimeout(r, 5)); } throw Error('Spawn timeout'); };
let bot;
try {
  const { setActive, setSession, loadStore } = await import('../../../../overlay/bot/ext/store.mjs');
  const { syncExtAuthGate } = await import('../../../../overlay/bot/ext/setup-bypass.mjs');
  const { runAgentTurn } = await import('../../src/agent/turn.mjs');
  const { Api } = await import('grammy');
  Api.prototype.setMyCommands = async () => true;
  const { createBot } = await import('../../src/telegram/bot.mjs');
  bot = createBot({ botToken: '42:fixture', adminId: 42 });
  bot.botInfo = { id: 99, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' };
  bot.api.config.use(async (_, method, payload) => ({ ok: true, result: { message_id: 1, date: 1, chat: { id: 42, type: 'private' }, text: payload.text } }));
  const reset = async (command) => command === 'menu:newtask' ? bot.handleUpdate({ update_id: 2, callback_query: { id: 'reset', chat_instance: 'fixture', data: command, from: { id: 42, is_bot: false, first_name: 'Owner' }, message: { message_id: 1, date: 1, chat: { id: 42, type: 'private' } } } }) : bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 1,
    from: { id: 42, is_bot: false, first_name: 'Owner' }, chat: { id: 42, type: 'private' },
    text: command, entities: [{ type: 'bot_command', offset: 0, length: command.length }] } });
  const select = async id => { await setActive(id); await syncExtAuthGate(); };
  await setActive(provider);
  const initialBytes = await fs.readFile(file, 'utf8');
  const controller = new AbortController();
  const turn = runAgentTurn({ prompt: 'synthetic first turn', signal: controller.signal });
  let later;
  await waitFor(1);
  const snapshotBytesUnchanged = await fs.readFile(file, 'utf8') === initialBytes;
  if (scenario.endsWith('-superseded')) { later = runAgentTurn({ prompt: 'synthetic newer attempt' }); await waitFor(2); }
  if (scenario === provider + '-reset') await reset('/newtask');
  if (scenario === provider + '-clear') await reset('/clear');
  if (scenario === provider + '-menu-reset') await reset('menu:newtask');
  if (scenario === 'claude-model-reset') await (await import('../../src/telegram/actions.mjs')).applyModelFamily('sonnet');
  if (scenario === 'claude-permission-reset') await (await import('../../src/telegram/actions.mjs')).applyPermMode('control');
  if (scenario.endsWith('-overlay-permission')) await (await import('../../../../overlay/bot/ext/integration/actions.mjs')).writeBotPermissionMode('control');
  if (!scenario.endsWith('-existing')) await select(other);
  if (scenario.endsWith('-other-reset')) await reset('/clear');
  if (scenario.endsWith('-roundtrip')) await select(provider);
  // Match the shim's last-seen metadata: this is never safe as a resume fallback.
  await setSession(provider, provider === 'codex' ? ids.codex.slice(10) : ids.claude);
  if (scenario.endsWith('-abort')) controller.abort();
  if (scenario.endsWith('-throw')) children[0].child.emit('error', Error('fixture child failed'));
  children[0].child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: ids[provider],
    result: 'synthetic successful first answer', is_error: scenario.endsWith('-error') }) + '\n');
  children[0].child.stdout.end(); children[0].child.stderr.end(); children[0].child.emit('close', 0, null);
  const out = await turn.catch(error => ({ ok: false, thrown: error.message }));
  let newerSurvived = null;
  if (later) {
    const intermediate = JSON.parse(await fs.readFile(file, 'utf8'));
    newerSurvived = !!intermediate.pendingCcSessionStarts?.[provider] && !intermediate.parkedCcSessions?.[provider];
    children[1].child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: ids[provider], result: 'newer answer', is_error: false }) + '\n');
    children[1].child.stdout.end(); children[1].child.stderr.end(); children[1].child.emit('close', 0, null);
    await later;
  }
  const parked = JSON.parse(await fs.readFile(file, 'utf8'));
  await select(provider);
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  console.log('FIRST_SESSION=' + JSON.stringify({ ok: out.ok, provider: out.result?.providerId, snapshotBytesUnchanged, newerSurvived, sessionId: state.ccSessionId ?? null,
    pending: state.pendingCcSessionStarts ?? null, parked, state, lastSeen: (await loadStore()).sessions[provider] }));
} finally { await bot?.stop().catch(() => {}); await fs.rm(home, { recursive: true, force: true }); }
