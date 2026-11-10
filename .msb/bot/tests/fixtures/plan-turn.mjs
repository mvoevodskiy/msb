// Actual bot ingress/FIFO → runAgentTurn/runClaudeTurn → final card → callback → resume.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
const provider = process.argv[2];
const calls = [], cleanups = [];
const sessionId = provider === 'claude' ? 'claude-plan-fixture' : 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53';
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { PATH: path.dirname(process.execPath), TMPDIR: os.tmpdir() });
cp.spawn = (command, args, options) => {
  if (command !== 'claude' || !options.env.HOME?.includes('msb-menu-')) throw Error('Unexpected process');
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
  const call = { args, provider: options.env.MSB_TURN_PROVIDER, prompt: '' }; calls.push(call);
  child.stdin.on('data', value => { call.prompt += value; });
  child.stdin.on('finish', () => queueMicrotask(() => {
    const text = calls.length === 1 ? 'Согласуем план.\n[КНОПКИ: plan]' : 'Продолжение завершено';
    for (const event of [
      { type: 'system', subtype: 'provider', provider_id: provider },
      { type: 'system', subtype: 'init', session_id: sessionId, model: 'fixture', provider_id: provider },
      { type: 'assistant', message: { content: [{ type: 'text', text }] } },
      { type: 'result', subtype: 'success', session_id: sessionId, result: text, is_error: false, usage: { input_tokens: 20, output_tokens: 5 } },
    ]) child.stdout.write(JSON.stringify(event) + '\n');
    child.stdout.end(); child.stderr.end(); child.emit('close', 0, null);
  }));
  return child;
};
syncBuiltinESMExports();
globalThis.fetch = () => { throw Error('External network forbidden'); };
const until = async fn => { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('Fixture event timed out'); };
try {
  const { fixture } = await import('../helpers/menu-fixture.mjs');
  const { saveState, loadState } = await import('../../src/state.mjs');
  const { runAgentTurn } = await import('../../src/agent/turn.mjs');
  const f = await fixture({ after(fn) { cleanups.push(fn); } }, runAgentTurn);
  await fs.writeFile(f.storeFile, JSON.stringify({ version: 1, active: provider, models: { codex: 'gpt-6.1-terra' }, efforts: { codex: 'low' } }));
  await saveState({ engine: 'cc', authMode: 'subscription', hasSubscriptionAuth: true, ccModel: 'opus', ccEffort: 'high',
    permissionMode: 'plan', ccSessionId: sessionId, sessionEpoch: 3, ...(provider === 'codex' ? { extAuthBypass: provider } : {}) });
  await f.message('Составь синтетический план без инструментов');
  await until(() => f.messageOptions.some(opts => opts?.reply_markup));
  await f.callback('plan:approve', 42, { messageId: 77, threadId: 7 });
  await until(() => f.edits.some(text => text.startsWith('Продолжение завершено')));
  await f.bot.stop();
  const diary = (await fs.readFile(path.join(f.home, '.msb/bots/default/chat-diary.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  console.log('PLAN_TURN=' + JSON.stringify({ calls, state: (await loadState()).state,
    markupEdits: f.markupEdits, messages: f.messages, messageOptions: f.messageOptions, diary }));
} finally { for (const fn of cleanups.reverse()) await fn(); }
