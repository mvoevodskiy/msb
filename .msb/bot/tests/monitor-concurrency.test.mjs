import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addSourceFromInput, loadMonitorConfig, removeSource, saveMonitorConfig } from '../src/monitor/config.mjs';
import { maybeSendDigest, updateDigestSettings } from '../src/monitor/digest.mjs';
import { pollAllSources } from '../src/monitor/poll.mjs';
import { appendItems, loadMeta } from '../src/monitor/store.mjs';
import { saveState } from '../src/state.mjs';

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { MSB_RUNTIME_ROOT: root };
  const OriginalDate = globalThis.Date;
  const now = OriginalDate.parse('2026-11-06T06:00:00Z');
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  t.after(() => { globalThis.Date = OriginalDate; });
  await saveState({ timezone: 'Europe/Moscow' }, env);
  await appendItems([{ id: 'fixture', title: 'fixture', publishedAt: new Date().toISOString() }], env);
  return env;
}

test('a poll started before delivery cannot erase its digest marker', async (t) => {
  const env = await fixture(t);
  const url = 'https://example.invalid/feed.xml';
  await addSourceFromInput(url, env);
  const entered = gate();
  const finishPoll = gate();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (target) => {
    assert.equal(target, url);
    entered.release();
    await finishPoll.promise;
    return { ok: true, text: async () => '<rss><channel></channel></rss>' };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const polling = pollAllSources(env, { log() {} });
  await entered.promise;
  let sent = 0;
  const send = () => maybeSendDigest({ api: { sendMessage: async () => { sent++; } }, adminId: 42, env, log() {} });
  assert.equal((await send()).sent, true);
  finishPoll.release();
  await polling;
  const meta = await loadMeta(env);
  assert.equal(meta.lastDigestAt, '2026-11-06T06:00:00.000Z');
  assert.equal(meta.lastPollAt[`rss:${url}`], '2026-11-06T06:00:00.000Z');
  assert.equal((await send()).reason, 'already');
  assert.equal(sent, 1);
});

test('a slow poll preserves source edits and digest settings made while it waits', async (t) => {
  const env = await fixture(t);
  const first = 'https://example.invalid/first.xml';
  const second = 'https://example.invalid/second.xml';
  await addSourceFromInput(first, env);
  const entered = gate();
  const finish = gate();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    entered.release();
    await finish.promise;
    return { ok: true, text: async () => '<rss><channel></channel></rss>' };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const polling = pollAllSources(env, { log() {} });
  await entered.promise;
  await addSourceFromInput(second, env);
  await removeSource('rss', first, env);
  await updateDigestSettings({ enabled: false, topN: 15 }, env);
  finish.release();
  await polling;
  const cfg = await loadMonitorConfig(env);
  assert.deepEqual(cfg.rss.feeds.map((feed) => feed.url), [second]);
  assert.equal(cfg.digest.enabled, false);
  assert.equal(cfg.digest.topN, 15);
});

test('concurrent source additions do not overwrite each other', async (t) => {
  const env = await fixture(t);
  const urls = ['https://example.invalid/a.xml', 'https://example.invalid/b.xml'];
  await Promise.all(urls.map((url) => addSourceFromInput(url, env)));
  assert.deepEqual((await loadMonitorConfig(env)).rss.feeds.map((feed) => feed.url).sort(), urls);
});

test('poll still records source errors, recovery and resolved YouTube channel IDs', async (t) => {
  const env = await fixture(t);
  const url = 'https://example.invalid/feed.xml';
  await addSourceFromInput(url, env);
  await addSourceFromInput('https://youtube.com/@fixturehandle', env);
  const originalFetch = globalThis.fetch;
  let failRss = true;
  globalThis.fetch = async (target) => {
    if (target === url && failRss) return { ok: false, status: 404 };
    if (target === 'https://www.youtube.com/@fixturehandle') {
      return { ok: true, text: async () => '"channelId":"UCabcdefghijabcdefghijab"' };
    }
    return { ok: true, text: async () => '<rss><channel></channel></rss>' };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  await pollAllSources(env, { log() {} });
  let cfg = await loadMonitorConfig(env);
  assert.equal(cfg.rss.feeds[0].lastError, 'HTTP 404');
  assert.equal(cfg.youtube.channels[0].channelId, 'UCabcdefghijabcdefghijab');
  assert.equal(cfg.youtube.channels[0].lastError, null);
  failRss = false;
  await pollAllSources(env, { log() {} });
  cfg = await loadMonitorConfig(env);
  assert.equal(cfg.rss.feeds[0].lastError, null);
});

test('concurrent scheduled deliveries send only once', async (t) => {
  const env = await fixture(t);
  const entered = gate();
  const finish = gate();
  let sent = 0;
  const api = { sendMessage: async () => { sent++; entered.release(); await finish.promise; } };
  const first = maybeSendDigest({ api, adminId: 42, env, log() {} });
  await entered.promise;
  const second = maybeSendDigest({ api, adminId: 42, env, log() {} });
  finish.release();
  assert.equal((await first).sent, true);
  assert.equal((await second).reason, 'already');
  assert.equal(sent, 1);
});

test('a failed delivery does not mark the digest sent and releases the queue', async (t) => {
  const env = await fixture(t);
  await assert.rejects(maybeSendDigest({ api: { sendMessage: async () => { throw Error('delivery failed'); } }, adminId: 42, env, log() {} }), /delivery failed/);
  assert.equal((await loadMeta(env)).lastDigestAt, null);
  assert.equal((await maybeSendDigest({ api: { sendMessage: async () => {} }, adminId: 42, env, log() {} })).sent, true);
});

test('different bot processes sharing a profile cannot send the scheduled digest twice', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-process-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { MSB_RUNTIME_ROOT: root };
  await saveState({ timezone: 'UTC' }, env);
  const cfg = await loadMonitorConfig(env);
  cfg.digest.hour = 6;
  await saveMonitorConfig(cfg, env);
  await appendItems([{ id: 'fixture', title: 'fixture', publishedAt: '2026-11-06T05:59:00.000Z' }], env);
  const script = fileURLToPath(new URL('./fixtures/monitor-concurrent.mjs', import.meta.url));
  const child = () => {
    const proc = spawn(process.execPath, [script, root], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', (chunk) => { out += chunk; });
    proc.stderr.on('data', (chunk) => { err += chunk; });
    const exit = new Promise((resolve, reject) => {
      proc.once('error', reject);
      proc.once('close', (code) => resolve({ code, err }));
    });
    t.after(() => proc.kill('SIGKILL'));
    return { proc, exit, output: () => out };
  };
  const waitFor = async (c, marker) => {
    const until = Date.now() + 5_000;
    while (!c.output().includes(marker)) {
      if (Date.now() > until) throw Error(`child did not reach ${marker}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const first = child();
  await waitFor(first, 'SENDING');
  const second = child();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.doesNotMatch(second.output(), /SENDING/, 'second process must wait for the first');
  first.proc.stdin.end('release');
  const [a, b] = await Promise.all([first.exit, second.exit]);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  assert.match(first.output(), /RESULT:sent/);
  assert.match(second.output(), /RESULT:already/);
});

test('two collectors cannot append the same item at the same time', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-append-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('./fixtures/monitor-append.mjs', import.meta.url));
  const child = () => {
    const proc = spawn(process.execPath, [script, root], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    proc.stdout.on('data', (chunk) => { output += chunk; });
    proc.stderr.on('data', (chunk) => { errors += chunk; });
    const exit = new Promise((resolve, reject) => {
      proc.once('error', reject);
      proc.once('close', (code) => resolve({ code, errors }));
    });
    t.after(() => proc.kill('SIGKILL'));
    return { proc, exit, output: () => output };
  };
  const a = child(), b = child();
  const until = Date.now() + 5_000;
  while (!a.output().includes('READY') || !b.output().includes('READY')) {
    if (Date.now() > until) throw Error('collectors did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  a.proc.stdin.end('go'); b.proc.stdin.end('go');
  const results = await Promise.all([a.exit, b.exit]);
  for (const result of results) assert.equal(result.code, 0, result.errors);
  assert.deepEqual([a.output().includes('ADDED:1'), b.output().includes('ADDED:1')].sort(), [false, true]);
  const lines = (await fs.readFile(path.join(root, 'monitor/items.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).id, 'shared-id');
});
