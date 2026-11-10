import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const harness = fileURLToPath(new URL('./fixtures/provider-switch-harness.mjs', import.meta.url));
const networkGuard = new URL('./fixtures/network-deny.mjs', import.meta.url).href;
const thread = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const session = `ext:codex:${thread}`;

async function scenario(t, name) {
  const fixtureHome = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-provider-reference-'));
  t.after(() => fs.rm(fixtureHome, { recursive: true, force: true }));
  const { stdout } = await execute(process.execPath, [harness, name], {
    env: { HOME: fixtureHome, REFERENCE_HOME: fixtureHome, NODE_OPTIONS: `--import=${networkGuard}` },
    timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

test('reference: successful Claude↔Codex switches preserve auth and strip only foreign resume', async (t) => {
  const result = await scenario(t, 'roundtrip');
  assert.deepEqual(result, {
    firstProvider: 'codex', firstMarker: 'codex', oldClaudeSessionCleared: true,
    finalProvider: 'claude', finalMarkerRemoved: true, foreignSessionCleared: true,
    claudeSessionRestored: true, codexSessionRestored: true, returnedProvider: 'codex',
    nativeAuthUnchanged: true, claudeAuthUnchanged: true, foreignCode: 0, ownCode: 0,
    forwarded: [
      { argv: ['-p', '--model', 'sonnet'], stdin: 'reference prompt' },
      { argv: ['-p', '--resume', 'reference-claude-session', '--model', 'sonnet'], stdin: 'reference prompt' },
    ],
  });
});

test('reference: rejected native login preserves the current provider and conversation', async (t) => {
  const result = await scenario(t, 'invalid-login');
  assert.deepEqual({ provider: result.provider, sessionId: result.sessionId,
    stateUnchanged: result.stateUnchanged, storeUnchanged: result.storeUnchanged,
    loginChecked: result.loginChecked, announcedSwitch: result.announcedSwitch }, {
    provider: 'claude', sessionId: 'reference-claude-session',
    stateUnchanged: true, storeUnchanged: true, loginChecked: true, announcedSwitch: false,
  }, 'An existing auth.json is not a successful codex login status');
});

test('reference: a non-owner callback cannot activate a provider before the core guard', async (t) => {
  const result = await scenario(t, 'foreign-owner');
  assert.deepEqual(result, {
    provider: 'claude', sessionId: 'reference-claude-session', stateUnchanged: true,
    storeUnchanged: true, loginChecked: false, announcedSwitch: false, apiCalls: 0,
  }, 'The real overlay hook must not bypass the real core adminGuard');
});

test('reference: Codex failures preserve resume and never replay an executed operation', async (t) => {
  const [modelError, streamCut] = await Promise.all([
    scenario(t, 'model-error'), scenario(t, 'stream-cut'),
  ]);
  assert.deepEqual({ modelError, streamCut }, {
    modelError: { exitCode: 1, executions: 1, effects: 0, savedSession: thread, emittedSessions: [session] },
    streamCut: { exitCode: 1, executions: 1, effects: 1, savedSession: thread, emittedSessions: [session] },
  }, 'A failed response must not invalidate history or repeat an already executed tool operation');
});


test('reference: a native first-stop keeps the issued Codex session available only in history', async (t) => {
  const r = await scenario(t, 'codex-first-stop');
  assert.equal(r.nativeExecutions, 1);
  assert.equal(r.nativeStopped, true);
  assert.equal(r.aborted, true);
  assert.equal(r.ok, false);
  assert.equal(r.text, 'Остановлено.');
  assert.equal(r.active, null);
  assert.equal(r.parked, null);
  assert.equal(r.storedNative, null);
  assert.deepEqual(r.lastUsage, r.priorUsage);
  assert.equal(r.pending, null);
  assert.equal(r.context, null);
  assert.equal(r.observedId, session);
  assert.deepEqual(r.history.map(({ id, providerId, messageCount, firstPrompt }) => ({ id, providerId, messageCount, firstPrompt })), [{
    id: session, providerId: 'codex', messageCount: 1, firstPrompt: 'reference first Codex turn',
  }]);
});

test('reference: a native first-error without a result does not promote a provisional Codex session', async (t) => {
  const r = await scenario(t, 'codex-first-empty-error');
  assert.equal(r.nativeExecutions, 1);
  assert.equal(r.aborted, false);
  assert.equal(r.ok, false);
  assert.match(r.text, /Reference model unavailable/);
  assert.equal(r.observedId, null);
  assert.equal(r.active, null);
  assert.equal(r.parked, null);
  assert.equal(r.storedNative, null);
  assert.deepEqual(r.lastUsage, r.priorUsage);
  assert.equal(r.pending, null);
  assert.deepEqual(r.history, []);
});

test('reference: a turn stays with its original provider if selection changes before shim starts', async (t) => {
  const r = await scenario(t, 'pinned-route');
  assert.equal(r.codexCalls, 1);
  assert.equal(r.codexResumedOwnSession, true);
  assert.deepEqual(r.claudeCalls, [['-p', '--resume', 'reference-claude-session']]);
  assert.equal(r.claudeTurnCode, 0);
  assert.notEqual(r.invalidTurnCode, 0);
  assert.notEqual(r.restrictedTurnCode, 0);
  assert.equal(r.invalidLaunchedCli, false);
});
