import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadStore, setActive, setSelectedEffort, setSelectedModel, setSession, storePath } from '../store.mjs';
import { withStoreLock } from '../store-lock.mjs';

const script = fileURLToPath(new URL('./fixtures/store-concurrent.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-store-concurrency-'));
  t.after(() => fs.rm(home, { recursive:true, force:true }));
  const env = { HOME:home, MSB_BOT_ID:'default' };
  await setActive('codex', env, home);
  return { home, env };
}
function child(home, role) {
  const proc = spawn(process.execPath, [script, role], { env:{ HOME:home }, stdio:['pipe','pipe','pipe'] });
  let output = '', errors = '';
  proc.stdout.on('data', c => { output += c; });
  proc.stderr.on('data', c => { errors += c; });
  const exit = new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', (code, signal) => resolve({code,signal,errors}));
  });
  return { proc, exit, output:() => output };
}
async function waitFor(c, marker) {
  const deadline = Date.now() + 4000;
  while (!c.output().includes(marker)) {
    if (Date.now() > deadline) throw new Error(`fixture did not report ${marker}`);
    await delay(5);
  }
}

test('cross-process session completion cannot revert a concurrent provider selection', async (t) => {
  const f = await fixture(t);
  const slow = child(f.home, 'slow-session');
  t.after(() => slow.proc.kill('SIGKILL'));
  await waitFor(slow, 'snapshot');
  const change = child(f.home, 'switch');
  t.after(() => change.proc.kill('SIGKILL'));
  await waitFor(change, 'started');
  await delay(300); // Give the concurrent writer an opportunity to finish or wait on the lock.
  slow.proc.stdin.end('release');
  const [a,b] = await Promise.all([slow.exit,change.exit]);
  assert.equal(a.code,0,a.errors); assert.equal(b.code,0,b.errors);
  const store = await loadStore(f.env, f.home);
  assert.equal(store.active, 'claude');
  assert.equal(store.sessions.codex, 'fixture-native-session');
});

test('concurrent writes in one process preserve unrelated provider settings', async (t) => {
  const f = await fixture(t);
  await Promise.all([
    setActive('claude',f.env,f.home),
    setSession('codex','fixture-native-session',f.env,f.home),
    setSelectedModel('codex','fixture-model',f.env,f.home),
    setSelectedEffort('codex','max',f.env,f.home),
  ]);
  const store = await loadStore(f.env,f.home);
  assert.equal(store.active,'claude');
  assert.equal(store.sessions.codex,'fixture-native-session');
  assert.equal(store.models.codex,'fixture-model');
  assert.equal(store.efforts.codex,'max');
});

test('a killed writer does not strand the next store update', async (t) => {
  const f = await fixture(t);
  const slow = child(f.home, 'slow-session');
  t.after(() => slow.proc.kill('SIGKILL'));
  await waitFor(slow, 'snapshot');
  slow.proc.kill('SIGKILL');
  await slow.exit;
  await setActive('claude',f.env,f.home);
  assert.equal((await loadStore(f.env,f.home)).active,'claude');
});


test('waiting for another process does not block the bot event loop', async (t) => {
  const f = await fixture(t);
  const slow = child(f.home, 'slow-session');
  t.after(() => slow.proc.kill('SIGKILL'));
  await waitFor(slow, 'snapshot');
  let settled = false;
  const update = setActive('claude', f.env, f.home).finally(() => { settled = true; });
  await delay(80);
  assert.equal(settled, false, 'The other writer still owns the lock');
  slow.proc.stdin.end('release');
  const done = await slow.exit;
  assert.equal(done.code, 0, done.errors);
  await update;
  assert.equal((await loadStore(f.env, f.home)).active, 'claude');
});


test('failed store update releases its lock for the next writer', async (t) => {
  const f = await fixture(t);
  await assert.rejects(withStoreLock(storePath(f.env, f.home), async () => { throw new Error('fixture failure'); }), /fixture failure/);
  await setActive('claude', f.env, f.home);
  assert.equal((await loadStore(f.env, f.home)).active, 'claude');
});
