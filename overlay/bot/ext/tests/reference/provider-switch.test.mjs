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

async function partialTurn(t, variant, plan = false) {
  const r = await scenario(t, 'codex-partial-' + variant, partialHarness);
  assert.equal(r.executions.length, 1);
  assert.equal(r.pending, null);
  assert.equal(r.parked, null);
  assert.deepEqual(r.diary.map(({status, providerId}) => ({status, providerId})), [{ status: 'error', providerId: 'codex' }]);
  const finals = r.calls.filter(call => call.mode === 'HTML');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].method, plan ? 'sendMessage' : 'editMessageText');
  assert.equal(finals[0].markup, plan);
  if (plan) assert.ok(finals[0].callbacks.includes('plan:approve'));
  else assert.equal(finals[0].id, 11);
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

test('reference: Codex partial failure with ordinary exit preserves completed skill and plan actions', async t => {
  const r = await partialTurn(t, 'resume', true);
  assert.equal(r.active, session);
  assert.equal(r.storedNative, thread);
  assert.deepEqual(r.usage, r.priorUsage);
  assert.equal(r.executions[0][r.executions[0].indexOf('resume') + 1], thread);
  assert.equal(r.wroteSkill, true);
  assert.match(r.final, /^Первый фрагмент\n\nВторой фрагмент[\s\S]*Поставил навык[\s\S]*<blockquote>⏱ \d+\.\ds<\/blockquote>$/);
  assert.doesNotMatch(r.final, /98%|INSTALL_SKILL|⚠️/);
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

test('reference: Codex partial failure keeps the native context limit guidance', async t => {
  const r = await partialTurn(t, 'context-limit');
  assert.match(r.final, /Start a new thread or clear earlier history/);
  assert.doesNotMatch(r.final, /фрагмент|blockquote/);
  assert.equal(r.active, session);
  assert.deepEqual(r.usage, r.priorUsage);
});

test('reference: Codex partial failure on websocket processes only the genuine model draft', async t => {
  const r = await partialTurn(t, 'transport-actions');
  assert.match(r.final, /Черновик до обрыва:\nПоставил навык «failed-turn-skill»/);
  assert.match(r.final, /websocket closed before completion/);
  assert.doesNotMatch(r.final, /blockquote/);
  assert.equal(r.wroteSkill, true);
  assert.equal(r.wroteDiagnosticSkill, false);
  assert.doesNotMatch(r.final, /ADD_MCP|fixture-mcp-secret-in-diagnostic/);
  assert.doesNotMatch(r.diary[0].summary, /ADD_MCP|fixture-mcp-secret-in-diagnostic/);
});

test('reference: Codex partial failure guard treats a diagnostic without model text as inert', async t => {
  const r = await partialTurn(t, 'diagnostic');
  assert.match(r.final, /^⚠️ Codex: Ordinary native fixture failure/);
  assert.doesNotMatch(r.final, /Поставил навык|blockquote/);
  assert.equal(r.wroteDiagnosticSkill, false);
  assert.doesNotMatch(r.final, /ADD_MCP|fixture-mcp-secret-in-diagnostic/);
  assert.doesNotMatch(r.diary[0].summary, /ADD_MCP|fixture-mcp-secret-in-diagnostic/);
});

test('reference: Codex partial failure keeps long Unicode text with a footer only on the final chunk', async t => {
  const r = await scenario(t, 'codex-partial-long', partialHarness);
  assert.equal(r.executions.length, 1);
  assert.deepEqual(r.diary.map(row => row.status), ['error']);
  const finals = r.calls.filter(call => call.mode === 'HTML');
  assert.ok(finals.length > 1);
  assert.ok(finals.every(call => call.method === 'sendMessage' && !call.markup && call.text.length <= 4000));
  assert.equal(finals.filter(call => call.text.includes('<blockquote>')).length, 1);
  assert.match(finals.at(-1).text, /\n\n<blockquote>⏱ \d+\.\ds<\/blockquote>$/);
  const text = finals.map(call => call.text.replace(/\n\n<blockquote>.*<\/blockquote>$/, '')).join('');
  assert.equal(text.length, 80_002);
  assert.ok(text === '🧠'.repeat(40_001), 'The complete Unicode draft must reach Telegram');
});

test('reference: Codex resume refusal guides explicit recovery and preserves the selected thread until /newtask', async t => {
  const r = await scenario(t, 'codex-recovery-missing', partialHarness);
  const notices = r.calls.filter(call => call.mode === 'HTML').map(call => call.text);
  assert.equal(notices.length, 3);
  const resumeIds = r.executions.map(argv => argv.includes('resume') ? argv[argv.indexOf('resume') + 1] : null);
  assert.deepEqual(resumeIds, [thread, thread, null], 'One CLI invocation for each distinct user message');
  assert.deepEqual(r.diary.map(row => row.status), ['error', 'error', 'ok']);
  const { afterRefusal, afterSecondRefusal, storeAfterRefusal, afterReset } = r.recovery;
  assert.equal(afterRefusal.ccSessionId, session);
  assert.equal(afterSecondRefusal.ccSessionId, session);
  assert.deepEqual(afterRefusal.lastCcUsage, r.priorUsage);
  assert.deepEqual(afterSecondRefusal.lastCcUsage, r.priorUsage);
  assert.equal(storeAfterRefusal.sessions.codex, thread);
  assert.equal(afterReset.ccSessionId, undefined);
  assert.ok(afterReset.sessionHistory.some(row => row.id === session));
  assert.notEqual(r.active, session);
  assert.ok(r.history.some(row => row.id === session));
  assert.ok(r.calls.some(call => call.text === '🆕 Новая сессия. Предыдущий контекст сброшен.'));
  assert.match(notices[2], /^Новая тестовая беседа\n\n<blockquote>⏱/);
  for (const notice of notices.slice(0, 2)) {
    assert.match(notice, /^⚠️ Codex не смог продолжить выбранную сессию\./);
    assert.match(notice, /\/sessions/);
    assert.match(notice, /\/newtask/);
    assert.doesNotMatch(notice, /напиши ещё раз|blockquote/i);
  }
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


for (const kind of ['current', 'legacy']) {
  test('reference: Codex uses its own settings after switching from ' + kind + ' Claude model state', async (t) => {
    const r = await scenario(t, 'codex-own-preferences-' + kind);
    assert.equal(r.firstOk, true);
    assert.equal(r.firstModel, 'gpt-6.1-sol');
    assert.equal(r.directOk, true);
    assert.equal(r.explicitOk, true);
    assert.equal(r.explicitModel, 'gpt-6.1-terra');
    assert.equal(r.codexArgs.length, 3);
    const model = argv => argv[argv.indexOf('-m') + 1];
    assert.deepEqual(r.codexArgs.map(model), ['gpt-6.1-sol', 'gpt-5.4-mini', 'gpt-6.1-terra']);
    assert.ok(r.codexArgs[0].includes('model_reasoning_effort="high"'));
    assert.ok(r.codexArgs[2].includes('model_reasoning_effort="max"'));
    assert.equal(r.sameCodexSession, true);
    assert.equal(r.claudeOk, true);
    assert.equal(r.claudeArgs[r.claudeArgs.indexOf('--model') + 1], 'custom-native-model');
    assert.equal(r.claudeSession, 'reference-claude-session');
    assert.equal(r.oldModel, 'custom-native-model');
    assert.equal(r.oldEffort, 'max');
    assert.equal(r.oldOcModel, 'openrouter/fixture/model');
  });
}
