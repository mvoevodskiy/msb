/**
 * Scheduled [poll](../src/monitor/poll.mjs) versus explicit collection;
 * all I/O is synthetic. [Old reference](./reference/parity-monitor-interval-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadMonitorConfig, saveMonitorConfig } from '../src/monitor/config.mjs';
import { pollAllSources } from '../src/monitor/poll.mjs';
import { startMonitorScheduler } from '../src/monitor/scheduler.mjs';
import { appendItems, loadMeta, saveMeta } from '../src/monitor/store.mjs';
import { saveState } from '../src/state.mjs';

async function fixture(t, { failure = false, github = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-interval-'));
  const previousRoot = process.env.MSB_RUNTIME_ROOT;
  const previousBot = process.env.MSB_BOT_ID;
  const previousFetch = globalThis.fetch;
  const OriginalDate = globalThis.Date;
  let now = OriginalDate.parse('2026-11-16T09:00:00Z');
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  process.env.MSB_RUNTIME_ROOT = root;
  process.env.MSB_BOT_ID = 'fixture';
  const env = { MSB_RUNTIME_ROOT: root, MSB_BOT_ID: 'fixture' };
  const cfg = await loadMonitorConfig(env);
  cfg.digest.enabled = false;
  cfg.rss.enabled = true;
  cfg.rss.pollIntervalMinutes = 60;
  cfg.rss.feeds = [{ url: 'https://fixture.invalid/feed', name: 'fixture', enabled: true }];
  if (github) {
    cfg.github.enabled = true;
    cfg.github.pollIntervalMinutes = 15;
    cfg.github.repos = [{ owner: 'fixture', repo: 'project', name: 'fixture', enabled: true }];
  }
  await saveMonitorConfig(cfg, env);
  const requests = [], errors = [], messages = [];
  globalThis.fetch = async url => {
    requests.push(String(url));
    const body = String(url).includes('github.com') ?
      '<feed><entry><id>https://fixture.invalid/item</id><title>fixture</title><updated>2026-11-16T09:00:00Z</updated></entry></feed>' :
      '<rss><channel></channel></rss>';
    return failure ? { ok: false, status: 503 } : { ok: true, text: async () => body };
  };
  const options = { api: { sendMessage: async (...args) => { messages.push(args); } }, adminId: 42, log: message => {
    if (message.includes('tick error')) errors.push(message);
  } };
  let scheduler = startMonitorScheduler(options);
  t.after(async () => {
    scheduler.stop();
    globalThis.fetch = previousFetch;
    globalThis.Date = OriginalDate;
    if (previousRoot === undefined) delete process.env.MSB_RUNTIME_ROOT;
    else process.env.MSB_RUNTIME_ROOT = previousRoot;
    if (previousBot === undefined) delete process.env.MSB_BOT_ID;
    else process.env.MSB_BOT_ID = previousBot;
    await fs.rm(root, { recursive: true, force: true });
  });
  return { get scheduler() { return scheduler; }, env, requests, errors, messages,
    restart() { scheduler.stop(); scheduler = startMonitorScheduler(options); },
    advance: ms => { now += ms; } };
}

test('scheduled polling respects the configured source interval', async t => {
  const f = await fixture(t);
  await f.scheduler.tickNow();
  f.advance(5 * 60_000);
  await f.scheduler.tickNow();
  assert.deepEqual(f.errors, []);
  assert.equal(f.requests.length, 1, 'five-minute scheduler tick must not ignore a one-hour interval');
  f.advance(55 * 60_000);
  await f.scheduler.tickNow();
  assert.equal(f.requests.length, 2);
});

test('a failed scheduled attempt does not turn a one-hour interval into five minutes', async t => {
  const f = await fixture(t, { failure: true });
  await f.scheduler.tickNow();
  f.advance(5 * 60_000);
  await f.scheduler.tickNow();
  assert.deepEqual(f.errors, []);
  assert.equal(f.requests.length, 1);
  f.advance(55 * 60_000);
  await f.scheduler.tickNow();
  assert.equal(f.requests.length, 2);
});

test('an explicit collect-now request is not blocked by the scheduling interval', async t => {
  const f = await fixture(t);
  await pollAllSources(f.env, { log() {} });
  await pollAllSources(f.env, { log() {} });
  assert.equal(f.requests.length, 2);
  assert.equal((await loadMeta(f.env)).lastScheduledPollAtByBot, undefined);
  await f.scheduler.tickNow();
  const scheduledBefore = (await loadMeta(f.env)).lastScheduledPollAtByBot;
  f.advance(5 * 60_000);
  await pollAllSources(f.env, { log() {} });
  await pollAllSources(f.env, { log() {} });
  assert.equal(f.requests.length, 5);
  assert.deepEqual((await loadMeta(f.env)).lastScheduledPollAtByBot, scheduledBefore);
  f.advance(55 * 60_000);
  await f.scheduler.tickNow();
  assert.equal(f.requests.length, 6, 'manual collection must not postpone the scheduled attempt');
});

test('source types respect their own intervals and preserve existing metadata', async t => {
  const f = await fixture(t, { github: true });
  await saveMeta({ lastPollAt: { 'rss:previous': 'previous' }, lastDigestAt: '2026-11-15T09:00:00.000Z', extra: 'keep' }, f.env);
  const count = needle => f.requests.filter(url => url.includes(needle)).length;
  await f.scheduler.tickNow();
  f.advance(5 * 60_000);
  await f.scheduler.tickNow();
  assert.deepEqual([count('fixture.invalid/feed'), count('github.com')], [1, 1]);
  f.advance(10 * 60_000);
  await f.scheduler.tickNow();
  assert.deepEqual([count('fixture.invalid/feed'), count('github.com')], [1, 2]);
  f.advance(45 * 60_000);
  await f.scheduler.tickNow();
  assert.deepEqual([count('fixture.invalid/feed'), count('github.com')], [2, 3]);
  const meta = await loadMeta(f.env);
  assert.equal(meta.lastPollAt['rss:previous'], 'previous');
  assert.equal(meta.lastDigestAt, '2026-11-15T09:00:00.000Z');
  assert.equal(meta.extra, 'keep');
  assert.deepEqual(f.errors, []);
});

test('scheduled attempt times survive a scheduler restart', async t => {
  const f = await fixture(t);
  await f.scheduler.tickNow();
  f.restart();
  f.advance(5 * 60_000);
  await f.scheduler.tickNow();
  assert.equal(f.requests.length, 1);
  f.advance(55 * 60_000);
  await f.scheduler.tickNow();
  assert.equal(f.requests.length, 2);
});

test('an empty disabled group is not marked as an attempt', async t => {
  const f = await fixture(t);
  const cfg = await loadMonitorConfig(f.env);
  cfg.rss.feeds[0].enabled = false;
  await saveMonitorConfig(cfg, f.env);
  await f.scheduler.tickNow();
  assert.equal(f.requests.length, 0);
  assert.equal((await loadMeta(f.env)).lastScheduledPollAtByBot?.fixture?.rss, undefined);
  cfg.rss.feeds[0].enabled = true;
  await saveMonitorConfig(cfg, f.env);
  f.advance(5 * 60_000);
  await f.scheduler.tickNow();
  assert.equal(f.requests.length, 1);
});

test('missing X credentials do not delay the first attempt after credentials appear', async t => {
  const f = await fixture(t);
  const cfg = await loadMonitorConfig(f.env);
  cfg.rss.enabled = false;
  cfg.twitter.enabled = true;
  cfg.twitter.accounts = [{ handle: 'fixture', enabled: true }];
  await saveMonitorConfig(cfg, f.env);
  globalThis.fetch = async url => {
    f.requests.push(String(url));
    return { ok: true, json: async () => String(url).includes('/by/username/') ? { data: { id: '42' } } : { data: [] } };
  };
  await pollAllSources({ ...f.env, X_BEARER_TOKEN: '', TWITTER_BEARER_TOKEN: '' }, { scheduled: true, log() {} });
  assert.equal(f.requests.length, 0);
  assert.equal((await loadMeta(f.env)).lastScheduledPollAtByBot?.fixture?.twitter, undefined);
  f.advance(5 * 60_000);
  await pollAllSources({ ...f.env, X_BEARER_TOKEN: 'fixture-token' }, { scheduled: true, log() {} });
  assert.equal(f.requests.length, 2);
});

test('different bots keep separate scheduled source times in a shared monitor', async t => {
  const f = await fixture(t);
  const first = { ...f.env, MSB_BOT_ID: 'first' };
  const second = { ...f.env, MSB_BOT_ID: 'second' };
  await Promise.all([pollAllSources(first, { scheduled: true, log() {} }),
    pollAllSources(second, { scheduled: true, log() {} })]);
  assert.equal(f.requests.length, 2);
  f.advance(5 * 60_000);
  await Promise.all([pollAllSources(first, { scheduled: true, log() {} }),
    pollAllSources(second, { scheduled: true, log() {} })]);
  assert.equal(f.requests.length, 2);
  const meta = await loadMeta(f.env);
  assert.ok(meta.lastScheduledPollAtByBot.first.rss);
  assert.ok(meta.lastScheduledPollAtByBot.second.rss);
});

test('a source added to an already scheduled type waits for that type interval', async t => {
  const f = await fixture(t);
  await f.scheduler.tickNow();
  const cfg = await loadMonitorConfig(f.env);
  cfg.rss.feeds.push({ url: 'https://fixture.invalid/second', name: 'second', enabled: true });
  await saveMonitorConfig(cfg, f.env);
  f.advance(5 * 60_000);
  await f.scheduler.tickNow();
  assert.equal(f.requests.length, 1);
  f.advance(55 * 60_000);
  await f.scheduler.tickNow();
  assert.equal(f.requests.length, 3);
});

test('a slower overlapping poll cannot roll back a newer scheduled type time', async t => {
  const f = await fixture(t, { github: true });
  let entered, release;
  const githubEntered = new Promise(resolve => { entered = resolve; });
  const githubRelease = new Promise(resolve => { release = resolve; });
  let githubCalls = 0;
  globalThis.fetch = async url => {
    f.requests.push(String(url));
    if (String(url).includes('github.com') && ++githubCalls === 1) {
      entered();
      await githubRelease;
    }
    const body = String(url).includes('github.com') ?
      '<feed><entry><id>https://fixture.invalid/item</id><title>fixture</title><updated>2026-11-16T09:00:00Z</updated></entry></feed>' :
      '<rss><channel></channel></rss>';
    return { ok: true, text: async () => body };
  };
  const first = pollAllSources(f.env, { scheduled: true, log() {} });
  await githubEntered;
  f.advance(5 * 60_000);
  try { await pollAllSources(f.env, { scheduled: true, log() {} }); }
  finally { release(); await first; }
  const meta = await loadMeta(f.env);
  assert.equal(meta.lastScheduledPollAtByBot.fixture.rss, '2026-11-16T09:05:00.000Z');
});

test('a scheduled tick does not overwrite invalid metadata', async t => {
  const f = await fixture(t);
  const file = path.join(f.env.MSB_RUNTIME_ROOT, 'monitor', 'meta.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{invalid');
  await f.scheduler.tickNow();
  await f.scheduler.tickNow();
  assert.equal(await fs.readFile(file, 'utf8'), '{invalid');
  assert.equal(f.errors.length, 2);
  assert.equal(f.requests.length, 0, 'unreadable scheduling state must not trigger repeated source requests');
});

test('a due digest is delivered even when no source is due for collection', async t => {
  const f = await fixture(t);
  await saveState({ timezone: 'UTC' }, f.env);
  await appendItems([{ id: 'fixture-item', title: 'fixture', publishedAt: '2026-11-16T09:00:00.000Z' }], f.env);
  await pollAllSources(f.env, { scheduled: true, log() {} });
  const cfg = await loadMonitorConfig(f.env);
  cfg.digest.enabled = true;
  cfg.digest.hour = 9;
  cfg.digest.targetBotId = 'fixture';
  await saveMonitorConfig(cfg, f.env);
  f.advance(5 * 60_000);
  await f.scheduler.tickNow();
  assert.equal(f.requests.length, 1);
  assert.equal(f.messages.length, 1);
  await f.scheduler.tickNow();
  assert.equal(f.messages.length, 1);
  assert.deepEqual(f.errors, []);
});

test('a future scheduled timestamp waits for its interval as in the old scheduler', async t => {
  const f = await fixture(t);
  await saveMeta({ lastPollAt: {}, lastDigestAt: null,
    lastScheduledPollAtByBot: { fixture: { rss: '2026-11-16T10:00:00.000Z' } } }, f.env);
  await f.scheduler.tickNow();
  f.advance(119 * 60_000);
  await f.scheduler.tickNow();
  assert.equal(f.requests.length, 0);
  f.advance(60_000);
  await f.scheduler.tickNow();
  assert.equal(f.requests.length, 1);
});

test('an invalid timestamp makes the source due and is replaced after an attempt', async t => {
  const f = await fixture(t);
  await saveMeta({ lastPollAt: {}, lastDigestAt: null,
    lastScheduledPollAtByBot: { fixture: { rss: 'invalid' } } }, f.env);
  await f.scheduler.tickNow();
  assert.equal(f.requests.length, 1);
  assert.equal((await loadMeta(f.env)).lastScheduledPollAtByBot.fixture.rss, '2026-11-16T09:00:00.000Z');
});

test('a missing type interval uses the previous thirty-minute fallback', async t => {
  const f = await fixture(t);
  const cfg = await loadMonitorConfig(f.env);
  cfg.rss.pollIntervalMinutes = null;
  await saveMonitorConfig(cfg, f.env);
  await f.scheduler.tickNow();
  f.advance(5 * 60_000);
  await f.scheduler.tickNow();
  assert.equal(f.requests.length, 1);
  f.advance(25 * 60_000);
  await f.scheduler.tickNow();
  assert.equal(f.requests.length, 2);
});
