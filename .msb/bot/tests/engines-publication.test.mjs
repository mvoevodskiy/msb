import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { submitRequest, requestPath, engineDir } from '../src/engines/client.mjs';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-ipc-publication-'));
  const env = { HOME: home, MSB_RUNTIME_PROFILE: 'msb', MSB_BOT_ID: 'default' };
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const publish = (options) => submitRequest('status', { bot_id: 'default' }, env, options);
  return { home, env, publish, slot: requestPath(env) };
}

test('engine publication: an occupied request is not replaced or removed when another publisher times out', async t => {
  const f = await fixture(t), first = await f.publish();
  const before = await fs.readFile(f.slot, 'utf8');
  await assert.rejects(f.publish({ publishTimeoutMs: 30, pollMs: 5 }), { code: 'ENGINE_REQUEST_BUSY' });
  assert.equal(await fs.readFile(f.slot, 'utf8'), before);
  assert.equal(JSON.parse(before).id, first.id);
  assert.deepEqual(await fs.readdir(engineDir(f.env)), ['request'], 'No publisher temp remains after refusal');
});

test('engine publication: helper read-to-unlink keeps its request and the next request is accepted after consumption', async t => {
  const f = await fixture(t), first = await f.publish();
  const handle = await fs.open(f.slot, 'r');t.after(() => handle.close());
  // This is the actual helper protocol: open/read, then unlink the same path.
  // Hold the consumer before unlink while another producer tries to publish.
  const taken = JSON.parse(await handle.readFile('utf8'));
  await assert.rejects(f.publish({ publishTimeoutMs: 30, pollMs: 5 }), { code: 'ENGINE_REQUEST_BUSY' });
  assert.equal(JSON.parse(await fs.readFile(f.slot, 'utf8')).id, first.id);
  assert.equal(taken.id, first.id);
  await fs.unlink(f.slot);
  const next = await f.publish({ publishTimeoutMs: 30, pollMs: 5 });
  assert.notEqual(next.id, first.id);
  assert.equal(JSON.parse(await fs.readFile(f.slot, 'utf8')).id, next.id);
});

test('engine publication: an occupied symlink is not silently replaced or followed', async t => {
  const f = await fixture(t);await fs.mkdir(engineDir(f.env), { recursive: true });
  const target = path.join(f.home, 'sentinel');await fs.writeFile(target, 'unchanged');
  await fs.symlink(target, f.slot);
  await assert.rejects(f.publish({ publishTimeoutMs: 30, pollMs: 5 }), { code: 'ENGINE_REQUEST_BUSY' });
  assert.ok((await fs.lstat(f.slot)).isSymbolicLink());
  assert.equal(await fs.readFile(target, 'utf8'), 'unchanged');
  assert.deepEqual(await fs.readdir(engineDir(f.env)), ['request']);
});

test('engine publication: independent publishers all reach the existing one-file consumer without lost IDs', async t => {
  const f = await fixture(t), children = [], published = [];
  t.after(() => { for (const child of children) child.kill(); });
  const jobs = Array.from({ length: 3 }, () => {
    const child = fork(new URL('./fixtures/engine-publisher.mjs', import.meta.url), [], {
      env: { ...f.env, PATH: process.env.PATH }, stdio: ['ignore','pipe','pipe','ipc'],
    });
    children.push(child);
    let markReady, markPublished, rejectPublished;
    const ready = new Promise(resolve => { markReady = resolve; });
    const done = new Promise((resolve,reject) => { markPublished = resolve;rejectPublished = reject; });
    child.on('message', msg => {
      if (msg.type === 'ready') markReady();
      if (msg.type === 'published') { published.push(msg.id);markPublished(msg.id); }
      if (msg.type === 'error') rejectPublished(Error(msg.code || 'Publisher failed'));
    });
    child.on('error', rejectPublished);
    child.on('exit', code => { if (code) rejectPublished(Error(`Publisher exit ${code}`)); });
    return { child, ready, done };
  });
  await Promise.all(jobs.map(job => job.ready));
  for (const job of jobs) job.child.send('go');
  const received = [], deadline = performance.now() + 10_000;
  while (received.length < 3 && performance.now() < deadline) {
    try {
      const handle = await fs.open(f.slot, 'r');
      const body = JSON.parse(await handle.readFile('utf8'));await handle.close();
      await fs.unlink(f.slot);received.push(body.id);
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (published.length === 3 && !(await fs.stat(f.slot).then(() => true, () => false))) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await Promise.all(jobs.map(job => job.done));
  assert.equal(received.length, 3, 'Every successfully published ID must be consumed');
  assert.deepEqual(new Set(received), new Set(published));
  assert.deepEqual(await fs.readdir(engineDir(f.env)), []);
});

test('engine publication: unsupported no-replace primitive fails and cleans temp instead of using replacing rename', async t => {
  const f = await fixture(t);
  t.mock.method(fs, 'link', async () => { throw Object.assign(Error('fixture link unsupported'), { code: 'EOPNOTSUPP' }); });
  await assert.rejects(f.publish(), { code: 'EOPNOTSUPP' });
  assert.deepEqual(await fs.readdir(engineDir(f.env)), []);
});

test('engine publication: cancelling a waiting observer removes only its unpublished temp', async t => {
  const f = await fixture(t), first = await f.publish();
  const link = fs.link.bind(fs);let attempted;
  const waiting = new Promise(resolve => { attempted = resolve; });
  t.mock.method(fs, 'link', (...args) => { attempted();return link(...args); });
  const controller = new AbortController();
  const second = f.publish({ signal: controller.signal });
  const refused = assert.rejects(second, { name: 'AbortError' });
  await waiting;controller.abort();await refused;
  assert.equal(JSON.parse(await fs.readFile(f.slot, 'utf8')).id, first.id);
  assert.deepEqual(await fs.readdir(engineDir(f.env)), ['request']);
});
