/** Separate child keeps dispatcher mocks and synthetic profiles isolated. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/interval-spend-pause-check.mjs', import.meta.url));
test('saved spend pause blocks every supported direct interval before launch', { timeout: 25_000 }, async () => {
  const env = { PATH: '/usr/bin:/bin', TMPDIR: process.env.TMPDIR || '/tmp' };
  const { stdout } = await run(process.execPath, ['--experimental-test-module-mocks', '--no-warnings', '--test',
    '--test-reporter=spec', fixture], { timeout: 22_000, env });
  assert.match(stdout, /tests 11/);
  assert.match(stdout, /pass 11/);
  assert.match(stdout, /fail 0/);
});
