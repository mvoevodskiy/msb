/**
 * Native Claude stream usage and launch settings through the real Telegram footer.
 * Old master 00f081f, readable blob 73aa9e7e: Nu 3353–3371, IJ 19524–19525,
 * 19772–19789, 19949–19964, worker 110781–110840. No account or external API.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './helpers/menu-fixture.mjs';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { loadState, saveState } from '../src/state.mjs';

const session = 'fixture-claude-conversation';
const answer = 'fixture Claude context answer';
const defaultUsage = [
  { input_tokens: 1000, cache_read_input_tokens: 9000 },
  { input_tokens: 10000, cache_read_input_tokens: 60000, cache_creation_input_tokens: 20000 },
];

async function verifyTurn(t, { model, nativeModel = model, usages = defaultUsage, terminalUsage = {
  input_tokens: 450000, output_tokens: 7000, cache_read_input_tokens: 400000, cache_creation_input_tokens: 50000,
}, window, percent }) {
  const f = await fixture(t, runAgentTurn, { overlay: false });
  const bin = path.join(f.home, 'bin');
  const trace = path.join(f.home, 'context-native-env.json');
  await fs.mkdir(bin);
  const config = { session, answer, usages, terminalUsage, trace };
  const cli = [
    '#!' + process.execPath,
    'const fs = require("node:fs");',
    'const c = ' + JSON.stringify(config) + ';',
    'const args = process.argv.slice(2);',
    'fs.readFileSync(0, "utf8");',
    'fs.writeFileSync(c.trace, JSON.stringify({model:args[args.indexOf("--model") + 1],',
    '  window:process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, percent:process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE}));',
    'const emit = data => console.log(JSON.stringify(data));',
    'emit({type:"system",subtype:"init",session_id:c.session,model:"claude-haiku-5-5"});',
    'for (const usage of c.usages) emit({type:"assistant",message:{usage,content:[]}});',
    'emit({type:"result",subtype:"success",is_error:false,session_id:c.session,result:c.answer,',
    '  usage:c.terminalUsage,modelUsage:{"claude-haiku-5-5":{inputTokens:3500000,contextWindow:1000000}}});',
  ].join('\n');
  await fs.writeFile(path.join(bin, 'claude'), cli, { mode: 0o700 });
  process.env.PATH = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-only';
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  if (window !== undefined) process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(window);
  if (percent !== undefined) process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(percent);
  const { state } = await loadState();
  await saveState({ ...state, engine: 'cc', extAuthBypass: undefined, authMode: 'subscription',
    hasSubscriptionAuth: true, ccModel: model, ccSessionId: session });
  await f.message('fixture use the original model');
  const limit = Date.now() + 5000;
  let final;
  while (!(final = f.edits.find(text => text.startsWith(answer)))) {
    if (Date.now() >= limit) assert.fail('Claude footer fixture did not finish');
    await delay(10);
  }
  const next = (await loadState()).state;
  assert.equal(next.ccSessionId, session);
  assert.equal(next.lastCcUsage.sessionId, session);
  assert.equal(next.ccModel, model);
  const launch = JSON.parse(await fs.readFile(trace, 'utf8'));
  assert.equal(launch.model, nativeModel);
  return { final, launch, usage: next.lastCcUsage };
}

for (const [model, nativeModel, window, threshold, indicator] of [
  ['sonnet', 'sonnet', '1000000', 900000, '○○○ 10%'],
  ['haiku', 'haiku', '200000', 180000, '●●○ 50%'],
  ['haiku55', 'claude-haiku-5-5', '1000000', 900000, '○○○ 10%'],
]) {
  test('Claude footer restores the old window and current input for ' + model, async t => {
    const result = await verifyTurn(t, { model, nativeModel });
    assert.ok(result.final.endsWith(' · ' + indicator + '</blockquote>'), result.final);
    assert.deepEqual(result.launch, { model: nativeModel, window, percent: '90' });
    assert.equal(result.usage.contextTokens, 90000);
    assert.equal(result.usage.contextWindow, threshold);
    assert.equal(result.usage.inputTokens, 450000);
  });
}

test('Claude footer follows explicit launch overrides and falls back to terminal usage', async t => {
  const result = await verifyTurn(t, { model: 'opus', window: 400000, percent: 50, usages: [],
    terminalUsage: { input_tokens: 30000, cache_creation_input_tokens: 60000, output_tokens: 40000 } });
  assert.ok(result.final.endsWith(' · ●●○ 45%</blockquote>'), result.final);
  assert.deepEqual(result.launch, { model: 'opus', window: '400000', percent: '50' });
  assert.equal(result.usage.contextTokens, 90000);
  assert.equal(result.usage.contextWindow, 200000);
});

test('Claude footer retains only elapsed time without a measurable input', async t => {
  const result = await verifyTurn(t, { model: 'haiku', usages: [{}], terminalUsage: { output_tokens: 50000 } });
  assert.match(result.final, /\n\n<blockquote>⏱ \d+\.\ds<\/blockquote>$/);
  assert.equal(result.usage.contextTokens, undefined);
});
