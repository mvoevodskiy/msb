import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('./fixtures/first-session.mjs', import.meta.url));
function run(scenario) {
  const child = spawnSync(process.execPath, [fixture, scenario], { env: { PATH: path.dirname(process.execPath), TMPDIR: os.tmpdir() }, encoding: 'utf8', timeout: 8000 });
  assert.equal(child.status, 0, child.stderr);
  const line = child.stdout.split('\n').find(s => s.startsWith('FIRST_SESSION='));
  assert.ok(line, child.stdout);
  return JSON.parse(line.slice('FIRST_SESSION='.length));
}
const ids = { codex: 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53', claude: 'claude-first-fixture' };
test('first successful provider turn is retained when it completes while another provider is active', () => {
  for (const provider of ['codex', 'claude']) {
    const r = run(provider + '-away');
    assert.equal(r.ok, true); assert.equal(r.provider, provider);
    assert.equal(r.sessionId, ids[provider]);
    assert.equal(r.parked.parkedCcSessions[provider], ids[provider]);
    assert.equal(r.pending, null); assert.equal(r.state.fixtureUnrelated, 'preserved');
  }
});
test('first successful provider turn survives switching away and back before completion', () => {
  const r = run('codex-roundtrip');
  assert.equal(r.sessionId, ids.codex); assert.equal(r.pending, null);
});
test('newtask invalidates only its first start; clearing another provider does not discard this start', () => {
  for (const scenario of ['codex-reset', 'codex-clear', 'codex-menu-reset']) {
    const reset = run(scenario);
    assert.equal(reset.sessionId, null); assert.equal(reset.pending, null);
  }
  const other = run('codex-other-reset');
  assert.equal(other.sessionId, ids.codex); assert.equal(other.pending, null);
});

test('first-start error, abort and throw clean only their own reservation without restoring a conversation', () => {
  for (const scenario of ['codex-error', 'codex-abort', 'codex-throw']) {
    const r = run(scenario);
    assert.equal(r.ok, false); assert.equal(r.sessionId, null); assert.equal(r.pending, null);
  }
});
test('existing session keeps snapshot bytes unchanged; newer first attempt survives old completion cleanup', () => {
  const existing = run('codex-existing');
  assert.equal(existing.snapshotBytesUnchanged, true);
  assert.equal(existing.sessionId, ids.codex); assert.equal(existing.pending, null);
  const newer = run('codex-superseded');
  assert.equal(newer.newerSurvived, true); assert.equal(newer.sessionId, ids.codex); assert.equal(newer.pending, null);
});

test('model selection preserves first Claude start; explicit permission reset still invalidates it', () => {
  const selected = run('claude-model-reset');
  assert.equal(selected.sessionId, ids.claude); assert.equal(selected.pending, null);
  for (const scenario of ['claude-permission-reset', 'claude-overlay-permission']) {
    const r = run(scenario); assert.equal(r.sessionId, null); assert.equal(r.pending, null);
  }
  const codex = run('codex-overlay-permission');
  assert.equal(codex.sessionId, ids.codex); assert.equal(codex.pending, null);
});
