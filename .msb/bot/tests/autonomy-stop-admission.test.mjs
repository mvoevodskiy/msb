/** Real /stop ingress in a child with fake unrelated dispatchers and no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run=promisify(execFile);
const fixture=fileURLToPath(new URL('./fixtures/autonomy-stop-admission-check.mjs',import.meta.url));

test('Telegram /stop during interval admission prevents the pending model turn', {timeout:12000}, async()=>{
  const env={PATH:process.env.PATH||'/usr/bin:/bin',TMPDIR:process.env.TMPDIR||'/tmp'};
  const {stdout}=await run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--test','--test-reporter=spec',fixture],{timeout:10000,env});
  assert.match(stdout,/pass 1/);
  assert.match(stdout,/fail 0/);
});
