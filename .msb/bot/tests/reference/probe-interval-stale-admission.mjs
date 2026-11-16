/** GREEN regression; the historical stale-admission RED is preserved in 4860ce8. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const suite = fileURLToPath(new URL('../autonomy-same-bot-claim.test.mjs', import.meta.url));
const env = { PATH: '/usr/bin:/bin', TMPDIR: process.env.TMPDIR || '/tmp' };
const { stdout } = await promisify(execFile)(process.execPath,
  ['--test', '--test-reporter=spec', '--test-name-pattern=^a task (edit|delete) during the final pause check', suite],
  { env, timeout: 20000 });
assert.match(stdout, /tests 2/);
assert.match(stdout, /pass 2/);
assert.match(stdout, /fail 0/);
console.log(stdout.trim());
console.log('PASS: an edit or delete committed before admission prevents the stale interval.');
