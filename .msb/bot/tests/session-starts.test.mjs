import test from 'node:test';
import assert from 'node:assert/strict';
import { claimFirstSession, completeFirstSession, invalidateFirstSession, isProviderSession, releaseFirstSession } from '../shared/session-starts.mjs';
const codex = 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53';
const base = () => ({ engine: 'cc', extAuthBypass: 'codex' });
test('a newer first attempt wins; stale success, error/abort cleanup cannot remove it', () => {
  const s = base(), first = claimFirstSession(s), next = claimFirstSession(s);
  assert.notEqual(first.token, next.token);
  assert.equal(completeFirstSession(s, first, { providerId: 'codex', sessionId: codex }), null);
  assert.equal(releaseFirstSession(s, first), false);
  assert.equal(s.pendingCcSessionStarts.codex, next.token);
  assert.equal(completeFirstSession(s, next, { providerId: 'codex', sessionId: codex }), 'active');
  assert.equal(s.ccSessionId, codex); assert.equal(s.pendingCcSessionStarts, undefined);
});
test('an established current or parked conversation is never overwritten', () => {
  for (const active of [true, false]) {
    const s = base(), first = claimFirstSession(s);
    if (active) s.ccSessionId = 'existing-active';
    else { delete s.extAuthBypass; s.parkedCcSessions = { codex: 'existing-parked' }; }
    assert.equal(completeFirstSession(s, first, { providerId: 'codex', sessionId: codex }), null);
    assert.equal(active ? s.ccSessionId : s.parkedCcSessions.codex, active ? 'existing-active' : 'existing-parked');
    assert.equal(s.pendingCcSessionStarts, undefined);
  }
});
test('reset invalidates only selected first attempt; stale reset generations cannot revive', () => {
  const s = base(), cx = claimFirstSession(s); delete s.extAuthBypass;
  const cc = claimFirstSession(s);
  invalidateFirstSession(s);
  assert.equal(completeFirstSession(s, cc, { providerId: 'claude', sessionId: 'claude-fixture' }), null);
  assert.equal(completeFirstSession(s, cx, { providerId: 'codex', sessionId: codex }), 'parked');
  assert.equal(s.parkedCcSessions.codex, codex);
});
test('first-session commit requires actual provider and valid own ID, never sentinel/foreign IDs', () => {
  for (const result of [
    { providerId: 'claude', sessionId: codex }, { providerId: 'codex', sessionId: 'claude-fixture' },
    { providerId: 'codex', sessionId: 'ext:codex:norestart-fixture' },
    { providerId: 'codex', sessionId: 'ext:codex:c1234567890123' },
    { providerId: 'codex', sessionId: 'ext:cursor:0199a213-81c0-7800-8aa1-bbab2a035a53' },
  ]) {
    const s = base(), first = claimFirstSession(s);
    assert.equal(completeFirstSession(s, first, result), null);
    assert.equal(s.ccSessionId, undefined); assert.equal(s.pendingCcSessionStarts, undefined);
  }
  assert.equal(isProviderSession('ext:cursor:0199a213-81c0-7800-8aa1-bbab2a035a53', 'cursor'), true);
  assert.equal(isProviderSession('ext:qwen:qwen-native-session', 'qwen'), true);
});
test('existing-ID turns never create a first-start reservation; OpenClaw remains inactive for CC', () => {
  const s = { ...base(), ccSessionId: codex };
  assert.equal(claimFirstSession(s), null); assert.equal(s.pendingCcSessionStarts, undefined);
  delete s.ccSessionId; const first = claimFirstSession(s); s.engine = 'oc';
  assert.equal(completeFirstSession(s, first, { providerId: 'codex', sessionId: codex }), 'parked');
  assert.equal(s.ccSessionId, undefined);
});


test('Claude service placeholders cannot be used as native conversation IDs',()=>{
 for(const id of ['unknown','failed','error','norestart','norestart-fixture',' UNKNOWN '])assert.equal(isProviderSession(id,'claude'),false,id);
 for(const id of ['claude-valid-fixture','0199a213-81c0-7800-8aa1-bbab2a035a53'])assert.equal(isProviderSession(id,'claude'),true,id);
});
