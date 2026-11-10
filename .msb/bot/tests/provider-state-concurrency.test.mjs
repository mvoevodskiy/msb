import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadState, saveState, updateState } from '../src/state.mjs';
import { statePath } from '../src/paths.mjs';

const extRoot = new URL('../../../overlay/bot/ext/', import.meta.url);
// Optional RED reproduction uses the old sources in memory, never a working tree
// mutation. Their relative imports still resolve to the isolated candidate tree.
async function extension(name) {
  const legacyRepo = process.env.MSB_PROVIDER_STATE_LEGACY_REPO;
  if (!legacyRepo) return import(new URL(name, extRoot));
  const source = execFileSync('git', ['-C', legacyRepo, 'show', `0ade942:overlay/bot/ext/${name}`], { encoding: 'utf8' });
  const rewritten = source.replace(/(from\s+)(['"])(\.[^'"]+)\2/g,
    (_all, prefix, quote, relative) => `${prefix}${quote}${new URL(relative, extRoot).href}${quote}`);
  return import(`data:text/javascript;base64,${Buffer.from(rewritten).toString('base64')}`);
}
const { writeBotPermissionMode } = await extension('menu.mjs');
const { syncExtAuthGate } = await extension('setup-bypass.mjs');
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const nativeSession = 'ext:codex:11111111-1111-1111-1111-111111111111';

async function fixture(t, active) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-provider-state-race-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { HOME: home, MSB_BOT_ID: 'default', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-only-not-real-auth' };
  await saveState({
    authMode: 'subscription', hasSubscriptionAuth: true, extAuthBypass: 'codex',
    ccSessionId: nativeSession, permissionMode: 'auto', sessionEpoch: 0,
    unrelated: 'preserved',
  }, env);
  await fs.writeFile(path.join(home, '.msb/bots/default/ext-providers.json'), JSON.stringify({
    version: 1, active, models: {}, efforts: {}, sessions: {},
  }));
  return { home, env };
}

async function overlapCompletionWithExtension(env, change) {
  const entered = gate(), release = gate();
  const completion = updateState(async state => {
    entered.resolve();
    await release.promise;
    state.lastCcUsage = { sessionId: nativeSession, contextTokens: 1234, contextWindow: 10000 };
    return state;
  }, env);
  await entered.promise;
  const queue = globalThis[Symbol.for('msb.stateUpdates')];
  const held = queue?.get(statePath(env));
  assert.ok(held, 'The core transaction must be held before starting the overlay writer.');
  let overlay;
  try {
    overlay = change();
    // Both production writers enqueue synchronously before their first await.
    // An old unqueued writer is allowed to finish while the core snapshot is
    // held, forcing the lost update deterministically, without timing sleeps.
    if (queue.get(statePath(env)) === held) await overlay;
  } finally {
    release.resolve();
  }
  await Promise.all([completion, overlay]);
  return (await loadState(env)).state;
}

test('provider state: the permission menu preserves a concurrent core completion and Codex session', async t => {
  const { env, home } = await fixture(t, 'codex');
  const state = await overlapCompletionWithExtension(env, () => writeBotPermissionMode('control', env, home));
  assert.equal(state.permissionMode, 'control', 'The late core snapshot must not revert the menu setting.');
  assert.equal(state.ccSessionId, nativeSession, 'Codex ignores this permission UI setting; its session must remain.');
  assert.equal(state.lastCcUsage.contextTokens, 1234);
  assert.equal(state.extAuthBypass, 'codex');
  assert.equal(state.unrelated, 'preserved');
});

test('provider state: switching the auth gate to Claude wins over a held Codex completion', async t => {
  const { env, home } = await fixture(t, 'claude');
  let outcome;
  const state = await overlapCompletionWithExtension(env, () => syncExtAuthGate(env, home).then(value => { outcome = value; }));
  assert.equal(outcome.changed, true);
  assert.equal(outcome.reason, 'clear-bypass-flag');
  assert.equal(state.extAuthBypass, undefined, 'A late completion must not reactivate the old provider bypass.');
  assert.equal(state.ccSessionId, undefined, 'A late completion must not resurrect the foreign Codex session.');
  assert.equal(state.authMode, 'subscription');
  assert.equal(state.hasSubscriptionAuth, true);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'fixture-only-not-real-auth');
  assert.equal(state.lastCcUsage.contextTokens, 1234);
  assert.equal(state.unrelated, 'preserved');
});
