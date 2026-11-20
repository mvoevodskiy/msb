/** Independent processes exercise the production [breaker store](../src/autonomy/reminder-breaker.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { physicalRecordPath } from '../src/autonomy/record-file.mjs';

const startedAt = '2026-11-08T21:30:00.000Z';
const writerUrl = new URL('../src/autonomy/reminder-breaker.mjs', import.meta.url);
const write = `
  import { once } from 'node:events';
  import { recordReminderBreaker } from ${JSON.stringify(writerUrl.href)};
  process.stdout.write('ready\\n');
  await once(process.stdin, 'data');
  for (let i = 0; i < 4; i++) {
    await recordReminderBreaker(process.argv[1] + i, ${JSON.stringify(startedAt)}, { status: 'ok' });
  }
  process.stdin.destroy();
`;

function startWriter(root, home, prefix) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', write, prefix], {
    env: { HOME: home, MSB_RUNTIME_PROFILE: 'jar1', IIA_SESSION_DIR: path.join(root, 'sessions') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const ready = Promise.withResolvers();
  let stderr = '', stdout = '';
  child.stdout.setEncoding('utf8').on('data', data => {
    stdout += data;
    if (stdout.includes('ready\n')) ready.resolve();
  });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, stderr }));
  });
  return { child, ready: ready.promise, closed };
}

test('independent reminder writers share a physical lock, including first creation through a parent link', { timeout: 15000 }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-breaker-process-'));
  const workers = [];
  t.after(async () => {
    for (const { child } of workers) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.allSettled(workers.map(({ closed }) => closed));
    await fs.rm(home, { recursive: true, force: true });
  });
  const directory = path.join(home, 'profile');
  const link = path.join(home, 'linked-profile');
  await fs.mkdir(directory);
  await fs.symlink(directory, link);
  const file = path.join(directory, 'autonomy', 'breakers.json');
  const aliased = path.join(link, 'autonomy', 'breakers.json');
  assert.equal(await physicalRecordPath(aliased), path.join(await fs.realpath(directory), 'autonomy', 'breakers.json'));

  workers.push(startWriter(directory, home, 'a'), startWriter(link, home, 'b'));
  await Promise.race([
    Promise.all(workers.map(({ ready }) => ready)),
    Promise.race(workers.map(({ closed }) => closed)).then(result => assert.fail('Writer exited early: ' + result.stderr)),
  ]);
  for (const { child } of workers) child.stdin.end('go\n');
  const results = await Promise.all(workers.map(({ closed }) => closed));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const rows = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(rows).sort(), ['a0', 'a1', 'a2', 'a3', 'b0', 'b1', 'b2', 'b3']);
  assert.ok(Object.values(rows).every(row => row.consecutiveFailures === 0 && row.lastSuccessAt === startedAt));
  assert.equal(await fs.readlink(link), directory);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('a file created between realpath and lstat still resolves to the shared lock path', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-breaker-path-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'breakers.json');
  const expected = path.join(await fs.realpath(home), 'breakers.json');
  const realpath = fs.realpath.bind(fs);
  let checked = false;
  t.mock.method(fs, 'realpath', async (name, ...options) => {
    if (name === file && !checked) {
      checked = true;
      return realpath(name, ...options).catch(async error => {
        await fs.writeFile(file, '{}');
        throw error;
      });
    }
    return realpath(name, ...options);
  });
  assert.equal(await physicalRecordPath(file), expected);
  assert.ok(checked);
});
