/** Fake CLI/Telegram in a child; unrelated dispatchers are mocked before import. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);
const fixture=fileURLToPath(new URL('./fixtures/interval-provider-pause-check.mjs',import.meta.url));
test('provider selection and interval pause preserve the selected session', {timeout:20000}, async()=>{
  const env={PATH:'/usr/bin:/bin',TMPDIR:process.env.TMPDIR||'/tmp'};
  const {stdout}=await run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--test','--test-reporter=spec',fixture],{timeout:18000,env});
  assert.match(stdout,/tests 12/);
  assert.match(stdout,/pass 12/);
  assert.match(stdout,/fail 0/);
});
