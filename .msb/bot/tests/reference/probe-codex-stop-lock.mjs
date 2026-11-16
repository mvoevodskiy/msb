/** RED: existing /stop waits behind a held Codex marker lock. Never a release check. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('./fixtures/codex-stop-lock-red.mjs', import.meta.url));
const env = { PATH: '/usr/bin:/bin', TMPDIR: process.env.TMPDIR || '/tmp' };
const { stdout } = await promisify(execFile)(process.execPath,
  ['--experimental-test-module-mocks', '--no-warnings', '--test', '--test-reporter=spec', fixture],
  { env, timeout: 30000 });
assert.match(stdout, /tests 6/);
assert.match(stdout, /pass 6/);
assert.match(stdout, /fail 0/);
console.log(stdout.trim());
console.log('RED REPRODUCED: all six stop paths wait for the held marker lock.');
