/** Model callbacks must retain the old native conversation; no live CLI/auth. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture } from './helpers/menu-fixture.mjs';
import { saveState, loadState } from '../src/state.mjs';

async function claude(t, overlay) {
  const f = await fixture(t, undefined, { overlay });
  await fs.writeFile(f.storeFile, JSON.stringify({ version: 1, active: 'claude', models: { codex: 'gpt-6.1-terra' }, efforts: { codex: 'low' } }));
  const state = { engine: 'cc', authMode: 'subscription', hasSubscriptionAuth: true,
    ccModel: 'opus', ccSessionId: 'native-claude-fixture', ccEffort: 'high', sessionEpoch: 9,
    parkedCcSessions: { codex: 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53' },
    lastCcUsage: { sessionId: 'native-claude-fixture', inputTokens: 20 }, fixtureUnrelated: 'preserve' };
  await saveState(state);
  return { f, state };
}

for (const overlay of [false, true]) test(`Claude model callback preserves native conversation and provider slots (overlay=${overlay})`, async t => {
  const { f, state } = await claude(t, overlay);
  const store = await fs.readFile(f.storeFile, 'utf8');
  await f.callback('settings:model:set:sonnet');
  assert.deepEqual((await loadState()).state, { ...state, ccModel: 'sonnet', model: 'claude-sonnet-4-6' });
  assert.equal(await fs.readFile(f.storeFile, 'utf8'), store, 'Claude model cannot change Codex model/effort');
});

test('unknown Claude model is a no-op; real permission change remains an explicit conversation reset', async t => {
  const { f, state } = await claude(t, true);
  await f.callback('settings:model:set:unknown-fixture');
  assert.deepEqual((await loadState()).state, state);
  await f.callback('settings:permmode:set:control');
  const after = (await loadState()).state;
  assert.equal(after.ccSessionId, undefined);
  assert.deepEqual(after.parkedCcSessions, state.parkedCcSessions);
  assert.equal(after.ccModel, state.ccModel);
});


test('prototype property names are not Claude model choices', async t => {
  const { f, state } = await claude(t, true);
  for (const family of ['constructor', 'toString', '__proto__']) {
    await f.callback(`settings:model:set:${family}`);
    assert.deepEqual((await loadState()).state, state, family);
  }
});
