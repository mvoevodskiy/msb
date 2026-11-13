import test from 'node:test';
import assert from 'node:assert/strict';
import { retainIntroductionSession } from '../src/agent/intro-session.mjs';

const sessionId = 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53';
const otherCodex = 'ext:codex:0299a213-81c0-7800-8aa1-bbab2a035a54';

function freshState(extra = {}) {
  return {
    engine: 'cc',
    extAuthBypass: 'codex',
    activeProject: 'alpha',
    sessionEpoch: 7,
    ...extra,
  };
}

function retain(state, extra = {}) {
  return retainIntroductionSession(state, {
    sessionId,
    capturedProject: 'alpha',
    capturedEpoch: 7,
    sameProfile: true,
    sameWorkspace: true,
    prompt: 'fixture private introduction text',
    ...extra,
  });
}

test('a confirmed Codex introduction is indexed with a fixed label and activated in an empty matching slot', () => {
  const state = freshState();
  const result = retain(state);

  assert.deepEqual(result, { recorded: true, activated: true });
  assert.equal(state.ccSessionId, sessionId);
  assert.equal(state.sessionHistory.length, 1);
  assert.deepEqual(state.sessionHistory[0], {
    id: sessionId,
    startedAt: state.sessionHistory[0].startedAt,
    lastActivity: state.sessionHistory[0].lastActivity,
    messageCount: 1,
    firstPrompt: 'Знакомство',
    project: 'alpha',
    engine: 'cc',
    providerId: 'codex',
  });
  assert.doesNotMatch(JSON.stringify(state), /fixture private introduction text/);
});

test('retry is idempotent and preserves existing ledger metadata and counters', () => {
  const state = freshState();
  assert.deepEqual(retain(state), { recorded: true, activated: true });
  const before = structuredClone(state);

  assert.deepEqual(retain(state), { recorded: true, activated: false });
  assert.deepEqual(state, before);
});

test('invalid, foreign-provider and sentinel IDs are ignored without state changes', () => {
  for (const id of [
    'not-a-session',
    'ext:codex:short',
    'ext:codex:norestart',
    'ext:claude:0199a213-81c0-7800-8aa1-bbab2a035a53',
  ]) {
    const state = freshState({ unrelated: 'preserved' });
    const before = structuredClone(state);
    const result = retain(state, { sessionId: id });
    assert.deepEqual(result, { recorded: false, activated: false }, id);
    assert.deepEqual(state, before, id);
  }
});

test('valid history remains available but is not activated after a provider, engine, project, epoch, profile or workspace change', () => {
  const cases = [
    ['provider changed', { extAuthBypass: 'claude' }],
    ['OpenClaw active', { engine: 'oc' }],
    ['project changed', { activeProject: 'beta' }],
    ['epoch changed', { sessionEpoch: 8 }],
  ];

  for (const [label, stateChanges] of cases) {
    const state = freshState({ ...stateChanges, unrelated: label });
    const result = retain(state);
    assert.deepEqual(result, { recorded: true, activated: false }, label);
    assert.equal(state.ccSessionId, undefined, label);
    assert.equal(state.sessionHistory[0].project, 'alpha', label);
    assert.equal(state.unrelated, label, label);
  }

  for (const [label, leaseChanges] of [
    ['profile changed', { sameProfile: false }],
    ['workspace changed', { sameWorkspace: false }],
  ]) {
    const state = freshState();
    const result = retain(state, leaseChanges);
    assert.deepEqual(result, { recorded: true, activated: false }, label);
    assert.equal(state.ccSessionId, undefined, label);
    assert.equal(state.sessionHistory[0].project, 'alpha', label);
  }
});

test('an existing active Claude or Codex conversation is never replaced', () => {
  for (const activeId of ['claude-session-fixture', otherCodex]) {
    const state = freshState({ ccSessionId: activeId, lastCcUsage: { sessionId: activeId } });
    const beforeActive = state.ccSessionId;
    const beforeUsage = structuredClone(state.lastCcUsage);

    assert.deepEqual(retain(state), { recorded: true, activated: false });
    assert.equal(state.ccSessionId, beforeActive);
    assert.deepEqual(state.lastCcUsage, beforeUsage);
    assert.equal(state.sessionHistory[0].id, sessionId);
  }
});

test('parked Codex and pending Codex first-start slots block activation and stay unchanged', () => {
  for (const extra of [
    { parkedCcSessions: { codex: otherCodex, claude: 'claude-parked' } },
    { pendingCcSessionStarts: { codex: 'codex-pending', claude: 'claude-pending' } },
  ]) {
    const state = freshState(extra);
    const before = structuredClone(extra);

    assert.deepEqual(retain(state), { recorded: true, activated: false });
    assert.equal(state.ccSessionId, undefined);
    assert.deepEqual(state.parkedCcSessions, before.parkedCcSessions);
    assert.deepEqual(state.pendingCcSessionStarts, before.pendingCcSessionStarts);
    assert.equal(state.sessionHistory[0].id, sessionId);
  }
});

test('other provider parked and pending slots survive Codex activation unchanged', () => {
  const state = freshState({
    parkedCcSessions: { claude: 'claude-parked' },
    pendingCcSessionStarts: { claude: 'claude-pending' },
  });
  const parked = structuredClone(state.parkedCcSessions);
  const pending = structuredClone(state.pendingCcSessionStarts);

  assert.deepEqual(retain(state), { recorded: true, activated: true });
  assert.deepEqual(state.parkedCcSessions, parked);
  assert.deepEqual(state.pendingCcSessionStarts, pending);
});

test('a reset keeps the ledger row but fences automatic resurrection of its ID', () => {
  const state = freshState();
  assert.deepEqual(retain(state), { recorded: true, activated: true });
  delete state.ccSessionId;
  state.sessionEpoch++;
  const historyBeforeRetry = structuredClone(state.sessionHistory);

  assert.deepEqual(retain(state), { recorded: true, activated: false });
  assert.equal(state.ccSessionId, undefined);
  assert.deepEqual(state.sessionHistory, historyBeforeRetry);
});

test('a unique existing Codex row is not rewritten, while ambiguous or conflicting IDs are not duplicated', () => {
  const existing = [{ id: sessionId, engine: 'cc', providerId: 'codex', project: 'alpha', firstPrompt: 'original', messageCount: 4 }];
  const state = freshState({ sessionHistory: existing });
  assert.deepEqual(retain(state), { recorded: true, activated: true });
  assert.deepEqual(state.sessionHistory, existing);

  for (const sessionHistory of [
    [
      { id: sessionId, engine: 'cc', providerId: 'codex', firstPrompt: 'first' },
      { id: sessionId, engine: 'cc', providerId: 'codex', firstPrompt: 'second' },
    ],
    [{ id: sessionId, engine: 'oc', providerId: 'codex', firstPrompt: 'foreign owner' }],
    [{ id: sessionId, engine: 'cc', providerId: 'codex', project: 'beta', firstPrompt: 'other profile' }],
  ]) {
    const ambiguous = freshState({ sessionHistory });
    const before = structuredClone(ambiguous);
    assert.deepEqual(retain(ambiguous), { recorded: false, activated: false });
    assert.deepEqual(ambiguous, before);
  }
});
