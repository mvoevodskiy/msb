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
const partialHarness = fileURLToPath(new URL('./fixtures/codex-partial-harness.mjs', import.meta.url));
const thread = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const session = `ext:codex:${thread}`;

async function scenario(t, name, runner = harness) {
  const fixtureHome = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-provider-reference-'));
  t.after(() => fs.rm(fixtureHome, { recursive: true, force: true }));
  const { stdout } = await execute(process.execPath, [runner, name], {
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

async function partialTurn(t, variant) {
  const r = await scenario(t, 'codex-partial-' + variant, partialHarness);
  assert.equal(r.executions.length, 1);
  assert.equal(r.pending, null);
  assert.equal(r.parked, null);
  assert.deepEqual(r.diary.map(({status, providerId}) => ({status, providerId})), [{ status: 'error', providerId: 'codex' }]);
  const finals = r.calls.filter(call => call.mode === 'HTML');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].method, 'editMessageText');
  assert.equal(finals[0].id, 11);
  assert.equal(finals[0].markup, false);
  return { ...r, final: finals[0].text };
}

const partialText = 'Первый фрагмент\n\nВторой фрагмент';
const partialHistory = [{ id: session, providerId: 'codex', messageCount: 1 }];

test('reference: Codex partial failure keeps completed text, elapsed footer and first session history', async t => {
  const r = await partialTurn(t, 'first');
  assert.equal(r.active, null);
  assert.equal(r.usage, null);
  assert.equal(r.storedNative, null);
  assert.match(r.final, /^Первый фрагмент\n\nВторой фрагмент\n\n<blockquote>⏱ \d+\.\ds<\/blockquote>$/);
  assert.equal(r.diary[0].summary, partialText);
  assert.deepEqual(r.history, partialHistory);
});

test('reference: Codex partial failure with ordinary exit preserves the existing state and treats draft actions as text', async t => {
  const r = await partialTurn(t, 'resume');
  assert.equal(r.active, session);
  assert.equal(r.storedNative, thread);
  assert.deepEqual(r.usage, r.priorUsage);
  assert.equal(r.executions[0][r.executions[0].indexOf('resume') + 1], thread);
  assert.equal(r.wroteSkill, false);
  assert.match(r.final, /^Первый фрагмент\n\nВторой фрагмент[\s\S]*<blockquote>⏱ \d+\.\ds<\/blockquote>$/);
  assert.doesNotMatch(r.final, /98%|Поставил навык|⚠️/);
  assert.ok(!r.calls.some(call => call.markup));
  assert.deepEqual(r.history, partialHistory);
});

test('reference: Codex partial failure footer reports a fresh measurement without replacing saved usage', async t => {
  const r = await partialTurn(t, 'metered');
  assert.equal(r.active, session);
  assert.deepEqual(r.usage, r.priorUsage);
  assert.match(r.final, /^Первый фрагмент\n\nВторой фрагмент\n\n<blockquote>⏱ \d+\.\ds · ●●○ 52%<\/blockquote>$/);
  assert.deepEqual(r.history, partialHistory);
});

test('reference: Codex partial failure never displays a mismatched resume draft', async t => {
  const r = await partialTurn(t, 'mismatch');
  assert.equal(r.active, session);
  assert.deepEqual(r.usage, r.priorUsage);
  assert.doesNotMatch(r.final, /фрагмент|blockquote/);
  assert.match(r.final, /Ordinary native fixture failure/);
  assert.deepEqual(r.history, partialHistory);
});

test('reference: Codex partial failure from websocket keeps the explicit interruption notice', async t => {
  const r = await partialTurn(t, 'transport');
  assert.equal(r.active, session);
  assert.deepEqual(r.usage, r.priorUsage);
  assert.match(r.final, /связь с моделью оборвалась \(websocket\)/);
  assert.match(r.final, /Черновик до обрыва:\nВторой фрагмент/);
  assert.doesNotMatch(r.final, /blockquote/);
  assert.deepEqual(r.history, partialHistory);
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
