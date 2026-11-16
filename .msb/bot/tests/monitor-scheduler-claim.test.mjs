/**
 * [Scheduled claim](../src/monitor/scheduler-claim.mjs) across owned processes;
 * fake fetch/Telegram. [Reference and limits](./reference/parity-monitor-scheduler-claim-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadMonitorConfig, saveMonitorConfig } from '../src/monitor/config.mjs';
import { appendItems, loadMeta } from '../src/monitor/store.mjs';
import { pollAllSources } from '../src/monitor/poll.mjs';
import { startMonitorScheduler } from '../src/monitor/scheduler.mjs';
import { saveState } from '../src/state.mjs';

const script = fileURLToPath(new URL('./fixtures/monitor-scheduler-claim-worker.mjs', import.meta.url));
async function fixture(t, { digest = false, alias = false } = {}) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-claim-'));
  const root = path.join(scratch, 'root');
  await fs.mkdir(root);
  const alternate = path.join(scratch, 'alias');
  if (alias) await fs.symlink(root, alternate);
  const env = { MSB_RUNTIME_ROOT: root, MSB_BOT_ID: 'same' };
  const cfg = await loadMonitorConfig(env);
  cfg.rss.enabled = true;
  cfg.rss.pollIntervalMinutes = 60;
  cfg.rss.feeds = [{ url: 'https://fixture.invalid/feed', name: 'fixture', enabled: true }];
  cfg.digest.enabled = digest;
  cfg.digest.hour = 9;
  cfg.digest.targetBotId = 'same';
  await saveMonitorConfig(cfg, env);
  await saveState({ timezone: 'UTC' }, env);
  if (digest) await appendItems([{ id: 'old-fixture', title: 'old fixture', publishedAt: '2026-11-16T09:00:00Z' }], env);
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined :
      new Promise(resolve => child.once('close', resolve))));
    await fs.rm(scratch, { recursive: true, force: true });
  });
  function worker(id, role, chosenRoot = root) {
    const child = fork(script, [], { env: { PATH: process.env.PATH || '/usr/bin:/bin',
      MSB_RUNTIME_ROOT: chosenRoot, MSB_BOT_ID: id, FIXTURE_ROLE: role }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    const events = [];
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('message', message => events.push(message));
    const wait = async (wanted, { allowErrors = false } = {}) => {
      const deadline = Date.now() + 8_000;
      while (!events.some(event => event.event === wanted)) {
        const error = events.find(event => event.event === 'error');
        if (error && !allowErrors) throw Error(error.message);
        if (child.exitCode !== null || child.signalCode !== null) throw Error('worker exited: ' + errors.slice(-700));
        if (Date.now() >= deadline) throw Error('worker did not reach ' + wanted);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return events.find(event => event.event === wanted);
    };
    return { child, events, wait, send: message => child.send(message) };
  }
  return { env, root, alternate, worker };
}

test('two processes for one bot do not duplicate collection or send a stale digest', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { digest: true });
  const slow = f.worker('same', 'slow');
  await slow.wait('ready'); slow.send('start'); await slow.wait('fetch');
  const fast = f.worker('same', 'fast');
  await fast.wait('ready'); fast.send('start'); await fast.wait('done');
  const fastFetches = fast.events.filter(event => event.event === 'fetch').length;
  const fastDeliveries = fast.events.filter(event => event.event === 'delivery').length;
  slow.send('release'); await slow.wait('done');
  const deliveries = slow.events.filter(event => event.event === 'delivery');
  const after = f.worker('same', 'fast');
  await after.wait('ready'); after.send('start'); await after.wait('done');
  assert.deepEqual({ fastFetches, fastDeliveries, slowDeliveries: deliveries.length, includesNew: deliveries[0]?.includesNew },
    { fastFetches: 0, fastDeliveries: 0, slowDeliveries: 1, includesNew: true });
  assert.equal(after.events.filter(event => event.event === 'fetch' || event.event === 'delivery').length, 0);
});

test('different bots do not block each other in the shared monitor', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const first = f.worker('first', 'slow'), second = f.worker('second', 'slow');
  await Promise.all([first.wait('ready'), second.wait('ready')]);
  first.send('start'); await first.wait('fetch');
  second.send('start'); await second.wait('fetch');
  first.send('release'); second.send('release');
  await Promise.all([first.wait('done'), second.wait('done')]);
  const meta = await loadMeta(f.env);
  assert.ok(meta.lastScheduledPollAtByBot.first.rss);
  assert.ok(meta.lastScheduledPollAtByBot.second.rss);
});

test('manual collection can proceed while scheduled work is held', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const slow = f.worker('same', 'slow');
  await slow.wait('ready'); slow.send('start'); await slow.wait('fetch');
  const original = globalThis.fetch;
  let manualFetches = 0;
  globalThis.fetch = async () => { manualFetches++; return { ok: true, text: async () => '<rss></rss>' }; };
  try { await pollAllSources(f.env, { log() {} }); }
  finally { globalThis.fetch = original; slow.send('release'); await slow.wait('done'); }
  assert.equal(manualFetches, 1);
});

test('the OS releases a dead scheduler claim so a later process can retry', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const slow = f.worker('same', 'slow');
  await slow.wait('ready'); slow.send('start'); await slow.wait('fetch');
  const exited = new Promise(resolve => slow.child.once('close', resolve));
  slow.child.kill('SIGKILL'); await exited;
  const next = f.worker('same', 'fast');
  await next.wait('ready'); next.send('start'); await next.wait('done');
  assert.equal(next.events.filter(event => event.event === 'fetch').length, 1);
  assert.ok((await loadMeta(f.env)).lastScheduledPollAtByBot.same.rss);
});

test('aliases of the same monitor directory share the same bot claim', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { alias: true });
  const slow = f.worker('same', 'slow');
  await slow.wait('ready'); slow.send('start'); await slow.wait('fetch');
  const fast = f.worker('same', 'fast', f.alternate);
  await fast.wait('ready'); fast.send('start'); await fast.wait('done');
  const fastFetches = fast.events.filter(event => event.event === 'fetch').length;
  slow.send('release'); await slow.wait('done');
  assert.equal(fastFetches, 0);
});

test('a claim path error never falls through to collection or delivery', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { digest: true });
  await fs.writeFile(path.join(f.root, 'monitor', '.scheduler-claims'), 'fixture blocks directory creation');
  const worker = f.worker('same', 'fast');
  await worker.wait('ready'); worker.send('start'); await worker.wait('done', { allowErrors: true });
  assert.ok(worker.events.some(event => event.event === 'error'));
  assert.equal(worker.events.filter(event => event.event === 'fetch' || event.event === 'delivery').length, 0);
});

test('stop before claim admission prevents a later collection', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const priorRoot = process.env.MSB_RUNTIME_ROOT, priorBot = process.env.MSB_BOT_ID;
  process.env.MSB_RUNTIME_ROOT = f.root; process.env.MSB_BOT_ID = 'same';
  const originalFetch = globalThis.fetch;
  let fetched = 0, delivered = 0, enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const originalMkdir = fs.mkdir.bind(fs);
  const target = path.join(f.root, 'monitor', '.scheduler-claims');
  const mkdir = t.mock.method(fs, 'mkdir', async (dir, ...args) => {
    if (String(dir) === target) { enter(); await held; }
    return originalMkdir(dir, ...args);
  });
  globalThis.fetch = async () => { fetched++; return { ok: true, text: async () => '<rss></rss>' }; };
  const scheduler = startMonitorScheduler({ api: { sendMessage: async () => { delivered++; } }, adminId: 42, log() {} });
  try {
    const pending = scheduler.tickNow();
    await entered;
    scheduler.stop(); release();
    await pending;
    assert.deepEqual({ fetched, delivered }, { fetched: 0, delivered: 0 });
  } finally {
    release(); scheduler.stop(); mkdir.mock.restore(); globalThis.fetch = originalFetch;
    if (priorRoot === undefined) delete process.env.MSB_RUNTIME_ROOT; else process.env.MSB_RUNTIME_ROOT = priorRoot;
    if (priorBot === undefined) delete process.env.MSB_BOT_ID; else process.env.MSB_BOT_ID = priorBot;
  }
});
