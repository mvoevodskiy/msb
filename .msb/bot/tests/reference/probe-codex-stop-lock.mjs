/** Regression wrapper; historical RED reproduction is preserved in 8c60034. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const test = fileURLToPath(new URL('../codex-stop-lock.test.mjs', import.meta.url));
const env = { PATH: '/usr/bin:/bin', TMPDIR: process.env.TMPDIR || '/tmp' };
const { stdout } = await promisify(execFile)(process.execPath,
  ['--test', '--test-reporter=spec', test], { env, timeout: 25000 });
assert.match(stdout, /pass 1/);
assert.match(stdout, /fail 0/);
console.log(stdout.trim());
console.log('PASS: Codex stop reaches the active turn before the marker lock is released.');
