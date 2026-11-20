/** Run only approved common recurring cases; the unrelated dispatcher is mocked in a child. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const pattern = '^(a saved interval follows|saved cron matches|the repeated local|old frequency|a non-pause budget|the existing task card|one slow send|owner Off)';
const dispatcher = new URL('../../src/autonomy/openclaw-reminder-dispatch.mjs', import.meta.url).href;
const suite = new URL('../recurring-reminder.test.mjs', import.meta.url).href;

test('eight approved common recurring reminder checks', { timeout: 12000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-recurring-approved-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const child = path.join(dir, 'approved.mjs');
  await fs.writeFile(child, `import { mock } from 'node:test';\n` +
    `mock.module(${JSON.stringify(dispatcher)}, { namedExports: { createOpenClawReminderDispatcher: () => async () => {} } });\n` +
    `await import(${JSON.stringify(suite)});\n`);
  const env = { PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), TMPDIR: os.tmpdir() };
  const { stdout } = await run(process.execPath, ['--experimental-test-module-mocks', '--no-warnings', '--test',
    '--test-reporter=spec', '--test-name-pattern=' + pattern, child], { timeout: 10000, env });
  assert.match(stdout, /tests 8/);
  assert.match(stdout, /pass 8/);
  assert.match(stdout, /fail 0/);
  assert.doesNotMatch(stdout, /simultaneous schedulers claim a recurring slot/);
});
