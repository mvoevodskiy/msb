/** Provider-independent per-bot sleep marker; synthetic files and writer only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSleepMarker } from '../src/engines/sleep-marker.mjs';
import { withFileLock } from '../shared/file-lock.mjs';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-sleep-marker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(await fs.realpath(root), 'sleep.default');
  let wakes = 0;
  const control = createSleepMarker({ marker: () => marker, onWake: async () => { wakes++; }, ...options });
  return { root, marker, control, wakes: () => wakes };
}

test('a paused bot wakes by removing only its own marker and resumes its deferred work', async t => {
  const f = await fixture(t);
  const other = path.join(f.root, 'sleep.other');
  await fs.writeFile(f.marker, 'owner fixture');
  await fs.writeFile(other, 'another bot');
  assert.equal(await f.control.sleeping(), true);
  assert.equal(await f.control.resumeIfAwake(), false);
  assert.equal(await f.control.wake(), true);
  await assert.rejects(fs.lstat(f.marker), { code: 'ENOENT' });
  assert.equal(await fs.readFile(other, 'utf8'), 'another bot');
  assert.equal(f.wakes(), 1);
  assert.equal(await f.control.sleeping(), false);
});

test('a provider switch removes only the captured marker, never a newer pause', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.marker, 'first');
  const previous = await f.control.revision();
  await fs.writeFile(path.join(f.root, 'next'), 'newer');
  await fs.rename(path.join(f.root, 'next'), f.marker);
  assert.deepEqual(await f.control.wakeAttempt({ expectedRevision: previous, resume: false }), { ok: false, stale: true });
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'newer');
  const current = await f.control.revision();
  assert.deepEqual(await f.control.wakeAttempt({ expectedRevision: current, resume: false }), { ok: true });
  await assert.rejects(fs.stat(f.marker), { code: 'ENOENT' });
  assert.equal(f.wakes(), 0, 'Switching providers must not launch a deferred Codex introduction.');
});

test('revision-aware wake waits for a concurrent new marker even when initially absent', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.marker, 'first');
  const previous = await f.control.revision();
  await fs.unlink(f.marker);
  let ready, release;
  const held = new Promise(resolve => { ready = resolve; });
  const continueWriter = new Promise(resolve => { release = resolve; });
  const writer = withFileLock(f.marker, async () => {
    ready();
    await continueWriter;
    await fs.writeFile(f.marker, 'newer');
  });
  t.after(() => release());
  await held;
  const waking = f.control.wakeAttempt({ expectedRevision: previous, resume: false });
  const passedWriter = await Promise.race([
    waking.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 50)),
  ]);
  release();
  await writer;
  const result = await waking;
  assert.equal(passedWriter, false, 'The captured revision must be checked under the writer lock.');
  assert.deepEqual(result, { ok: false, stale: true });
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'newer');
});

test('an unreadable marker fails closed, and a failed wake does not resume', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.marker, 'fixture');
  const original = fs.lstat;
  fs.lstat = async (file, ...args) => String(file) === f.marker
    ? Promise.reject(Object.assign(Error('fixture denied'), { code: 'EACCES' })) : original(file, ...args);
  try {
    assert.equal(await f.control.sleeping(), true);
    assert.equal(await f.control.wake(), false);
    assert.equal(f.wakes(), 0);
  } finally { fs.lstat = original; }
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'fixture');
});

test('reconciliation can clear a marker without recursively starting recovery', async t => {
  const f = await fixture(t, { shouldClear: async () => true });
  await fs.writeFile(f.marker, 'fixture');
  assert.equal(await f.control.sleeping({ resumeOnWake: false }), false);
  assert.equal(f.wakes(), 0);
  assert.equal(await f.control.resumeIfAwake(), true);
  assert.equal(f.wakes(), 1);
});

test('a later Python marker write survives reconciliation under the shared lock', async t => {
  let release, observed;
  const hold = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { observed = resolve; });
  const f = await fixture(t, { shouldClear: async () => { observed(); await hold; return true; } });
  t.after(() => release());
  await fs.writeFile(f.marker, 'older');
  const checking = f.control.sleeping();
  await reached;
  const script = fileURLToPath(new URL('../../../usr-local-lib/msb-engine/client_markers.py', import.meta.url));
  const code = `
import importlib.util, sqlite3, sys
spec = importlib.util.spec_from_file_location('client_markers', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
connect = sqlite3.connect
class Wrapped:
    def __init__(self, db): self.db = db
    def execute(self, sql):
        if sql == 'BEGIN IMMEDIATE': print('LOCK_ATTEMPT', flush=True)
        return self.db.execute(sql)
    def close(self): self.db.close()
module.sqlite3.connect = lambda *a, **kw: Wrapped(connect(*a, **kw))
module.change(sys.argv[2], b'newer')
`;
  const child = spawn('python3', ['-I', '-S', '-u', '-c', code, script, f.marker], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(Error(`writer ${code}/${signal}: ${errors}`)));
  });
  const deadline = Date.now() + 5000;
  while (!output.includes('LOCK_ATTEMPT')) {
    if (Date.now() > deadline) throw Error(`writer did not acquire lock: ${errors}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(child.exitCode, null);
  release();
  assert.equal(await checking, false);
  await finished;
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'newer');
});
