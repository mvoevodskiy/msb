import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const harness = fileURLToPath(new URL('./fixtures/abort-harness.mjs', import.meta.url));
const networkGuard = new URL('../../../overlay/bot/ext/tests/reference/fixtures/network-deny.mjs', import.meta.url).href;

async function runFixture(t, scenario) {
  const fixtureHome = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-abort-'));
  t.after(() => fs.rm(fixtureHome, { recursive: true, force: true }));
  const binDir = path.join(fixtureHome, 'bin');
  await fs.mkdir(binDir);
  const cli = (await fs.readFile(new URL('./fixtures/abort-cli.mjs', import.meta.url), 'utf8'))
    .replace(/^#![^\n]+/, `#!${process.execPath}`);
  await fs.writeFile(path.join(binDir, 'claude'), cli, { mode: 0o700 });
  const { stdout } = await execute(process.execPath, [harness], {
    env: { HOME: fixtureHome, PATH: binDir, ABORT_CASE: scenario,
      ABORT_TRACE: path.join(fixtureHome, 'signals.jsonl'), NODE_OPTIONS: `--import=${networkGuard}` },
    timeout: 20000, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

test('abort escalates INT → 3s group TERM → 5s group KILL, even after leader exit', async (t) => {
  const value = await runFixture(t, 'group');
  assert.equal(value.result.aborted, true);
  assert.equal(value.result.exitCode, 0, 'leader cooperatively exits on TERM');
  assert.deepEqual(value.calls.map(({ signal }) => signal), ['SIGINT', 'SIGTERM', 'SIGKILL']);
  assert.ok(value.calls.every(({ pid }) => pid === -value.leaderPid), 'all signals address the detached group');
  assert.ok(value.calls[1].at - value.calls[0].at >= 2900);
  assert.ok(value.calls[2].at - value.calls[1].at >= 4900);
  assert.ok(value.elapsedMs >= 7900 && value.elapsedMs < 14000, `closed after ${value.elapsedMs}ms`);
  assert.deepEqual(value.records.filter(({ role }) => role === 'descendant').map(({ signal }) => signal),
    ['SIGINT', 'SIGTERM']);
  assert.equal(value.heartbeatStopped, true, 'the descendant stops writing before the turn closes');
});

test('cooperative abort clears escalation timers on close; no late signal can hit a reused PID', async (t) => {
  const value = await runFixture(t, 'cooperative');
  assert.equal(value.result.aborted, true);
  assert.ok(value.elapsedMs < 3000);
  assert.deepEqual(value.calls.map(({ signal }) => signal), ['SIGINT']);
});

test('ordinary CLI success is unchanged and later abort sends no signals', async (t) => {
  const { result, calls } = await runFixture(t, 'success');
  assert.equal(result.text, 'REFERENCE_SUCCESS');
  assert.equal(result.meteredCostUsd, 0.0123, 'Preserve the native CLI meter.');
  assert.equal(result.costUsd, undefined);
  assert.equal(result.sessionId, 'reference-success');
  assert.equal(result.isError, false);
  assert.equal(result.aborted, false);
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 });
  assert.deepEqual(calls, []);
});

test('already-aborted turn returns without spawning CLI or scheduling signals', async (t) => {
  const { result, calls, records, cliSpawned } = await runFixture(t, 'already-aborted');
  assert.equal(result.aborted, true);
  assert.equal(result.sessionId, 'reference-existing');
  assert.equal(cliSpawned, false);
  assert.deepEqual(records, []);
  assert.deepEqual(calls, []);
});
