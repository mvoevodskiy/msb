/** Real ingress with fake Telegram/turn and mocked unrelated engine status. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('./fixtures/codex-stop-lock-check.mjs', import.meta.url));
test('paused Codex accepts all stop inputs even when its marker lock is held', { timeout: 20000 }, async () => {
  const env = { PATH: '/usr/bin:/bin', TMPDIR: process.env.TMPDIR || '/tmp' };
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--experimental-test-module-mocks', '--no-warnings', '--test', '--test-reporter=spec', fixture],
    { env, timeout: 18000 });
  assert.match(stdout, /tests 16/);
  assert.match(stdout, /pass 16/);
  assert.match(stdout, /fail 0/);
});
