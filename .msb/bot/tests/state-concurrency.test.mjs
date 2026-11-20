import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadState, saveState, updateState, NO_STATE_WRITE } from '../src/state.mjs';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-state-race-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { HOME: home, MSB_BOT_ID: 'default' };
  await saveState({ sessionEpoch: 0, unrelated: 'preserved' }, env);
  return env;
}
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('a reset queued during terminal save wins without a lost epoch or temp-file collision', async t => {
  const env = await fixture(t), entered = gate(), release = gate();
  const completion = updateState(async s => { entered.resolve(); await release.promise; s.ccSessionId = 'late-session'; return s; }, env);
  await entered.promise;
  const reset = updateState(s => { delete s.ccSessionId; s.sessionEpoch++; return s; }, env);
  release.resolve();
  await Promise.all([completion, reset]);
  assert.deepEqual((await loadState(env)).state, { sessionEpoch: 1, unrelated: 'preserved' });
});

test('terminal save queued during reset observes the new epoch and rejects its stale session', async t => {
  const env = await fixture(t), entered = gate(), release = gate();
  const reset = updateState(async s => { entered.resolve(); await release.promise; s.sessionEpoch++; delete s.ccSessionId; return s; }, env);
  await entered.promise;
  const completion = updateState(s => { if (s.sessionEpoch === 0) s.ccSessionId = 'late-session'; return s; }, env);
  release.resolve();
  await Promise.all([reset, completion]);
  assert.deepEqual((await loadState(env)).state, { sessionEpoch: 1, unrelated: 'preserved' });
});

test('failed state update releases the profile queue for the next command', async t => {
  const env = await fixture(t);
  const failed = updateState(() => { throw Error('fixture failure'); }, env);
  const next = updateState(s => ({ ...s, sessionEpoch: 1 }), env);
  await assert.rejects(failed, /fixture failure/);
  await next;
  assert.equal((await loadState(env)).state.sessionEpoch, 1);
});


test('serialized snapshot opt-out leaves the stored profile bytes unchanged', async t => {
  const env = await fixture(t);
  const { file } = await loadState(env);
  const raw = '{"fixture":"preserve exact bytes","ccSessionId":"existing"}';
  await fs.writeFile(file, raw);
  const state = await updateState(() => NO_STATE_WRITE, env);
  assert.equal(state.ccSessionId, 'existing');
  assert.equal(await fs.readFile(file, 'utf8'), raw);
});
