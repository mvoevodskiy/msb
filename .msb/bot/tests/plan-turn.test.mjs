/** Full production bot/runner/resume path; synthetic CLI, no native accounts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('./fixtures/plan-turn.mjs', import.meta.url));
const flag = (call, name) => call.args[call.args.indexOf(name) + 1];
for (const provider of ['claude', 'codex']) test(`${provider}: final plan card → approve → same production runner and native conversation`, () => {
  const child = spawnSync(process.execPath, [fixture, provider], { encoding: 'utf8', timeout: 10_000,
    env: { PATH: path.dirname(process.execPath), TMPDIR: os.tmpdir() } });
  assert.equal(child.status, 0, child.stderr);
  const line = child.stdout.split('\n').find(s => s.startsWith('PLAN_TURN='));
  assert.ok(line, child.stdout);
  const r = JSON.parse(line.slice('PLAN_TURN='.length));
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls.map(c => c.prompt), ['Составь синтетический план без инструментов', '✔ Продолжай выполнение.']);
  assert.ok(r.calls.every(c => c.provider === provider));
  assert.ok(r.calls.every(c => flag(c, '--resume') === r.state.ccSessionId));
  assert.equal(r.state.sessionEpoch, 3);
  assert.equal(r.state.permissionMode, 'plan');
  for (const call of r.calls) {
    const prompt = flag(call, '--append-system-prompt');
    assert.equal(prompt.includes('[КНОПКИ: plan]'), provider === 'claude');
  }
  assert.deepEqual(r.markupEdits, [{ chatId: 42, messageId: 77, options: {} }]);
  assert.equal(r.diary.length, 2);
  assert.ok(r.diary.every(row => row.providerId === provider && row.status === 'ok'));
  assert.doesNotMatch(r.diary[0].summary, /КНОПКИ/);
  assert.ok(r.messageOptions.some(opts => opts?.message_thread_id === 7));
});
