/** Old Claude effort validation/model mapping, using production callbacks/CLI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture } from './helpers/menu-fixture.mjs';
import { agentOptionsReport } from './helpers/agent-options.mjs';
import { saveState, loadState } from '../src/state.mjs';
import { compactSession } from '../src/agent/compact.mjs';
const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
const callbacks = opts => opts?.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
async function claude(t, model = 'opus') {
  const f = await fixture(t);
  await fs.writeFile(f.storeFile, JSON.stringify({ version: 1, active: 'claude', models: { codex: 'gpt-6.1-terra' }, efforts: { codex: 'low' } }));
  const state = { engine: 'cc', authMode: 'subscription', hasSubscriptionAuth: true, ccModel: model,
    ccEffort: 'xhigh', ccSessionId: 'claude-effort-fixture', sessionEpoch: 4, fixture: 'preserve' };
  await saveState(state);
  return { f, state };
}

test('unknown Claude effort and stale off callbacks leave state/session/provider effort unchanged', async t => {
  const { f, state } = await claude(t);
  const store = await fs.readFile(f.storeFile, 'utf8');
  for (const value of ['unknown-fixture', 'constructor', 'off', '']) {
    await f.callback(`settings:effort:set:${value}`);
    assert.deepEqual((await loadState()).state, state, value);
  }
  assert.equal(await fs.readFile(f.storeFile, 'utf8'), store);
});

test('valid effort stores the chosen preference, preserving Claude native ID and Codex low', async t => {
  const { f, state } = await claude(t, 'sonnet');
  const store = await fs.readFile(f.storeFile, 'utf8');
  await f.callback('settings:effort:set:max');
  assert.deepEqual((await loadState()).state, { ...state, ccEffort: 'max', effort: 'max' });
  assert.equal(await fs.readFile(f.storeFile, 'utf8'), store);
});

test('Haiku 4.5 exposes only the original unsupported-depth explanation and Back', async t => {
  const { f } = await claude(t, 'haiku');
  await f.callback('settings:effort');
  assert.match(f.edits.at(-1), /У этой модели глубина не настраивается/);
  assert.deepEqual(callbacks(f.editOptions.at(-1)), ['menu:agent']);
  await f.callback('menu:agent');
  assert.equal(callbacks(f.editOptions.at(-1)).includes('settings:effort'), false);
});

test('supported Claude effort screen keeps five old levels, current preference and effective fallback note', async t => {
  const { f } = await claude(t, 'sonnet');
  await f.callback('settings:effort');
  assert.deepEqual(callbacks(f.editOptions.at(-1)), [...levels.map(v => `settings:effort:set:${v}`), 'menu:agent']);
  assert.ok(f.editOptions.at(-1).reply_markup.inline_keyboard.flat().some(b => b.text === 'xhigh ✓'));
  assert.match(f.edits.at(-1), /xhigh и max работают как high/);
});

test('actual Haiku 4.5 argv omits unsupported --effort while retaining stored preference', () => {
  const r = agentOptionsReport('claude', 'auto', 'haiku', 'max');
  assert.equal(r.calls[0].args.includes('--effort'), false);
  assert.equal(r.state.ccEffort, 'max');
});

test('Sonnet xhigh/max become high only in actual CLI options, not persisted preferences', () => {
  for (const value of ['xhigh', 'max']) {
    const r = agentOptionsReport('claude', 'auto', 'sonnet', value), args = r.calls[0].args;
    assert.equal(args[args.indexOf('--effort') + 1], 'high');
    assert.equal(r.state.ccEffort, value);
  }
});

test('explicit pinned Opus 4.6 maps xhigh to high but retains its supported max', () => {
  for (const [value, effective] of [['xhigh', 'high'], ['max', 'max'], ['low', 'low']]) {
    const r = agentOptionsReport('claude', 'auto', 'claude-opus-4-6', value), args = r.calls[0].args;
    assert.equal(args[args.indexOf('--effort') + 1], effective);
    assert.equal(r.state.ccEffort, value);
  }
});

test('invalid persisted effort is not passed through as a CLI option', () => {
  const r = agentOptionsReport('claude', 'auto', 'opus', 'unknown-fixture');
  assert.equal(r.calls[0].args.includes('--effort'), false);
  assert.equal(r.state.ccEffort, 'unknown-fixture', 'no implicit migration');
});

test('Claude compact reuses the same model-specific effort resolution', async () => {
  let observed;
  const r = await compactSession({ engine: 'cc', ccSessionId: 'claude-effort-fixture', ccModel: 'haiku', ccEffort: 'max' }, {
    readVersion: async () => '2.1.154', runClaude: async opts => { observed = opts; opts.onEvent({ type: 'system', subtype: 'compact_boundary' }); return { isError: false }; },
  });
  assert.equal(r.ok, true); assert.equal(observed.effort, undefined);
});


test('legacy explicit off keeps native default and does not become a preferred high override', () => {
  const r = agentOptionsReport('claude','auto','claude-opus-5-5','off','2.1.300');
  assert.equal(r.calls[0].args.includes('--effort'),false);
  assert.equal(r.state.ccEffort,'off');
});

test('unset effort restores preferred high only when the selected CLI model requires it', () => {
  const r = agentOptionsReport('claude','auto','claude-opus-5-5','','2.1.300');
  const args = r.calls[0].args;
  assert.equal(args[args.indexOf('--effort')+1],'high');
  assert.equal(r.state.ccEffort,'');
});


for (const [version,model,expected] of [
  ['2.1.154','opus',undefined],['2.1.219','opus',undefined],['2.1.280','opus','high'],
  ['2.1.197','sonnet',undefined],['2.1.284','sonnet','high'],
  ['2.1.292','haiku',undefined],['2.1.293','haiku','high'],
]) test(`unset ${model} effort at CLI ${version} follows old native/default metadata`, () => {
  const r=agentOptionsReport('claude','auto',model,'',version),args=r.calls[0].args;
  assert.equal(args[args.indexOf('--model')+1],model,'preserve native alias');
  assert.equal(args.includes('--effort'),expected!==undefined);
  if(expected)assert.equal(args[args.indexOf('--effort')+1],expected);
  assert.equal(r.state.ccEffort,'');
});
