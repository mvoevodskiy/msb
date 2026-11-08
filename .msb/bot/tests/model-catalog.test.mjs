/** Reachable old family/version/lock contract via actual core+overlay callbacks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture } from './helpers/menu-fixture.mjs';
import { saveState, loadState, resolveModel } from '../src/state.mjs';
const buttons = f => f.editOptions.at(-1)?.reply_markup.inline_keyboard.flat();
async function claude(t, version = '2.1.300') {
  const f = await fixture(t, undefined, { claudeCliVersion: version });
  await fs.writeFile(f.storeFile, JSON.stringify({ version: 1, active: 'claude', models: { codex: 'gpt-6.1-terra' }, efforts: { codex: 'low' } }));
  const state = { engine: 'cc', ccModel: 'sonnet', ccEffort: 'low', ccSessionId: 'claude-catalog-fixture', sessionEpoch: 8,
    parkedCcSessions: { codex: 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53' }, fixture: 'preserve' };
  await saveState(state); return { f, state };
}
const pinned = ['fable51','fable5','opus55','opus5','opus48','opus47','opus46','sonnet55','sonnet5','sonnet46','haiku55'];

test('Versions opens original pinned choices and returns to family then Agent without state writes', async t => {
  const { f, state } = await claude(t);
  await f.callback('settings:model:ver');
  assert.deepEqual(buttons(f).map(b => b.callback_data), [...pinned.map(key => `settings:model:set:${key}`), 'settings:model']);
  assert.match(f.edits.at(-1), /Фиксированная версия не обновляется сама/);
  await f.callback('settings:model');
  assert.deepEqual(buttons(f).map(b => b.callback_data), ['settings:model:set:fable51','settings:model:set:opus','settings:model:set:sonnet','settings:model:set:haiku','settings:model:ver','menu:agent']);
  assert.ok(buttons(f).some(b => b.text === '🚀 Sonnet ✓'));
  assert.match(f.edits.at(-1), /Смена модели сохраняет беседу/);
  assert.deepEqual((await loadState()).state, state);
});

test('unknown/old CLI locks min-version pinned choices and never changes the selected conversation', async t => {
  const { f, state } = await claude(t, 'unknown');
  await f.callback('settings:model:ver');
  const choices = buttons(f).filter(b => b.callback_data !== 'settings:model');
  assert.equal(choices.length, pinned.length);
  assert.ok(choices.every(b => b.text.includes('🔒')));
  const edits = f.edits.length, answers = f.callbackAnswers.length;
  await f.callback('settings:model:set:fable51');
  assert.deepEqual((await loadState()).state, state);
  assert.equal(f.edits.length, edits, 'locked click leaves original card in place');
  assert.equal(f.callbackAnswers.length, answers + 1, 'one response, not an empty ack followed by alert');
  assert.deepEqual(f.callbackAnswers.at(-1), [{ show_alert: true, text: 'Fable 5.1 откроется после обновления системы.' }]);
});

test('eligible pinned model saves its real CLI ID and preserves native/parked conversations, effort and Codex low', async t => {
  const { f, state } = await claude(t);
  const store = await fs.readFile(f.storeFile, 'utf8');
  await f.callback('settings:model:set:opus55');
  assert.deepEqual((await loadState()).state, { ...state, ccModel: 'claude-opus-5-5', model: 'claude-opus-5-5' });
  assert.equal(await fs.readFile(f.storeFile, 'utf8'), store);
});

test('family aliases remain native aliases instead of being pinned to an old model', async t => {
  const { f, state } = await claude(t);
  await f.callback('settings:model:set:opus');
  assert.deepEqual((await loadState()).state, { ...state, ccModel: 'opus', model: 'opus' });
  assert.equal(resolveModel({ ccModel: 'sonnet' }), 'sonnet');
  assert.equal(resolveModel({ ccModel: 'haiku' }), 'haiku');
});

test('Fable family selects the latest eligible old option without a new confirmation screen', async t => {
  const { f, state } = await claude(t, '2.1.200');
  await f.callback('settings:model');
  assert.equal(buttons(f)[0].callback_data, 'settings:model:set:fable5');
  await f.callback('settings:model:fable:ask');
  assert.deepEqual((await loadState()).state, { ...state, ccModel: 'claude-fable-5', model: 'claude-fable-5' });
  assert.equal(f.messages.length, 0, 'old one-tap selection edits the card, without an extra credit notice');
});

test('legacy Fable/fableok valid IDs use the same lock-aware selection and ignore unknown suffixes', async t => {
  const { f, state } = await claude(t);
  for (const prefix of ['fable','fableok']) {
    await saveState(state);
    await f.callback(`settings:model:${prefix}:fable51`);
    assert.equal((await loadState()).state.ccModel, 'claude-fable-5-1');
  }
  await saveState(state);
  await f.callback('settings:model:fable:unknown-fixture');
  assert.deepEqual((await loadState()).state, state);
});

test('retired opusplan resolves to native opus without disk/session migration; raw IDs remain passthrough', async t => {
  const { state } = await claude(t);
  await saveState({ ...state, ccModel: 'opusplan' });
  const before = (await loadState()).state;
  assert.equal(resolveModel(before), 'opus');
  assert.deepEqual((await loadState()).state, before);
  assert.equal(resolveModel({ ccModel: 'custom-native-model' }), 'custom-native-model');
});

test('stale pinned/native Claude choices never write Codex model/config/session/low', async t => {
  const f = await fixture(t);
  const state = (await loadState()).state, store = await fs.readFile(f.storeFile, 'utf8');
  await fs.mkdir(f.home + '/.codex', { recursive: true });
  const configFile = f.home + '/.codex/config.toml', config = 'model = "gpt-6.1-terra"\nmodel_reasoning_effort = "low"\n';
  await fs.writeFile(configFile, config);
  for (const key of ['opus46','opus55','sonnet46','haiku55','fable51','claude-opus-4-6','claude-fable-5-1']) {
    await f.callback(`settings:model:set:${key}`);
    assert.deepEqual((await loadState()).state, state, key);
    assert.equal(await fs.readFile(f.storeFile, 'utf8'), store, key);
    assert.equal(await fs.readFile(configFile, 'utf8'), config, key);
  }
});


test('start retains an existing unset effort so model-dependent default can apply', async t => {
  const { f, state } = await claude(t);
  delete state.ccEffort;
  await saveState(state);
  await f.message('/start');
  assert.equal((await loadState()).state.ccEffort, undefined);
  assert.equal((await loadState()).state.ccSessionId, state.ccSessionId);
});
