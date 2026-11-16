/** Poll results must not mutate a source row changed while its request was pending.
 * Synthetic profiles and fake fetch only; reference and limits:
 * [contract](./reference/parity-monitor-source-snapshot-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultConfig, loadMonitorConfig, saveMonitorConfig } from '../src/monitor/config.mjs';
import { pollAllSources } from '../src/monitor/poll.mjs';

function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const rows = {
  rss: { bucket: 'feeds', entry: { url: 'https://fixture.invalid/feed', name: 'old', enabled: true } },
  youtube: { bucket: 'channels', entry: { channelId: 'UCabcdefghijabcdefghijab', name: 'old', enabled: true } },
  github: { bucket: 'repos', entry: { owner: 'fixture', repo: 'project', name: 'old', enabled: true } },
  telegram: { bucket: 'channels', entry: { username: 'fixturechannel', name: 'old', enabled: true } },
};

async function fixture(t, type, row, fetchResult) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-source-snapshot-'));
  const env = { MSB_RUNTIME_ROOT: root }, entered = gate(), release = gate();
  const cfg = defaultConfig(); cfg[type].enabled = true; cfg[type][rows[type].bucket] = [row];
  await saveMonitorConfig(cfg, env);
  const originalFetch = globalThis.fetch;
  let polling;
  globalThis.fetch = async target => {
    entered.resolve(String(target));
    await release.promise;
    return fetchResult(String(target));
  };
  t.after(async () => {
    release.resolve();
    if (polling) await polling.catch(() => {});
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  return { env, entered, release, run() { polling = pollAllSources(env, { log() {} }); return polling; } };
}

for (const [type, { bucket, entry }] of Object.entries(rows)) {
  test(`a delayed ${type} error cannot overwrite the changed source row`, async t => {
    const f = await fixture(t, type, entry, () => ({ ok: false, status: 503 }));
    const polling = f.run(); await f.entered.promise;
    const current = await loadMonitorConfig(f.env);
    const replacement = { ...current[type][bucket][0], name: 'replaced', enabled: false,
      marker: 'new-owner-state', lastError: 'current-result' };
    current[type][bucket][0] = replacement;
    await saveMonitorConfig(current, f.env);
    f.release.resolve(); await polling;
    assert.deepEqual((await loadMonitorConfig(f.env))[type][bucket][0], replacement);
  });
}

test('a delayed YouTube resolution cannot assign an old channel ID to a changed row', async t => {
  const row = { channelId: null, handle: 'fixturehandle', name: 'old', enabled: true };
  const resolved = 'UCabcdefghijabcdefghijab';
  const f = await fixture(t, 'youtube', row, target => target.includes('/@fixturehandle')
    ? { ok: true, text: async () => `"channelId":"${resolved}"` }
    : { ok: true, text: async () => '<feed></feed>' });
  const polling = f.run(); await f.entered.promise;
  const current = await loadMonitorConfig(f.env);
  const replacement = { ...current.youtube.channels[0], name: 'replaced', enabled: false,
    marker: 'new-owner-state', lastError: 'current-result' };
  current.youtube.channels[0] = replacement;
  await saveMonitorConfig(current, f.env);
  f.release.resolve(); await polling;
  assert.deepEqual((await loadMonitorConfig(f.env)).youtube.channels[0], replacement);
});

test('an unrelated source and digest edit does not suppress an unchanged source result', async t => {
  const f = await fixture(t, 'rss', { ...rows.rss.entry, lastError: 'previous' }, () => ({ ok: false, status: 503 }));
  const polling = f.run(); await f.entered.promise;
  const current = await loadMonitorConfig(f.env);
  const neighbor = { url: 'https://neighbor.invalid/feed', name: 'neighbor', enabled: false };
  current.rss.feeds.push(neighbor); current.digest.topN = 25;
  await saveMonitorConfig(current, f.env);
  f.release.resolve(); await polling;
  const after = await loadMonitorConfig(f.env);
  assert.equal(after.rss.feeds[0].lastError, 'HTTP 503');
  assert.deepEqual(after.rss.feeds[1], neighbor);
  assert.equal(after.digest.topN, 25);
});

test('a duplicate source key remains ambiguous even if only one row matches the snapshot', async t => {
  const f = await fixture(t, 'rss', rows.rss.entry, () => ({ ok: false, status: 503 }));
  const polling = f.run(); await f.entered.promise;
  const current = await loadMonitorConfig(f.env);
  current.rss.feeds.push({ ...rows.rss.entry, name: 'duplicate', enabled: false, lastError: 'keep' });
  const before = structuredClone(current.rss.feeds);
  await saveMonitorConfig(current, f.env);
  f.release.resolve(); await polling;
  assert.deepEqual((await loadMonitorConfig(f.env)).rss.feeds, before);
});

test('a newer status on the same row is not replaced by a delayed error', async t => {
  const f = await fixture(t, 'rss', rows.rss.entry, () => ({ ok: false, status: 503 }));
  const polling = f.run(); await f.entered.promise;
  const current = await loadMonitorConfig(f.env);
  current.rss.feeds[0].lastError = 'newer-result';
  await saveMonitorConfig(current, f.env);
  f.release.resolve(); await polling;
  assert.equal((await loadMonitorConfig(f.env)).rss.feeds[0].lastError, 'newer-result');
});

test('an unchanged YouTube handle still stores a successful resolution', async t => {
  const row = { channelId: null, handle: 'fixturehandle', name: 'fixture', enabled: true };
  const resolved = 'UCabcdefghijabcdefghijab';
  const f = await fixture(t, 'youtube', row, target => target.includes('/@fixturehandle')
    ? { ok: true, text: async () => `"channelId":"${resolved}"` }
    : { ok: true, text: async () => '<feed></feed>' });
  const polling = f.run(); await f.entered.promise; f.release.resolve();
  const result = await polling;
  assert.equal(result.errors.length, 0);
  assert.deepEqual((await loadMonitorConfig(f.env)).youtube.channels[0], { ...row, channelId: resolved, lastError: null });
});

test('a completed fetch still stores collected items after its source row changes', async t => {
  const now = new Date().toISOString();
  const xml = `<rss><channel><item><title>fixture item</title><link>https://fixture.invalid/item</link><guid>fixture-id</guid><pubDate>${now}</pubDate></item></channel></rss>`;
  const f = await fixture(t, 'rss', rows.rss.entry, () => ({ ok: true, text: async () => xml }));
  const polling = f.run(); await f.entered.promise;
  const current = await loadMonitorConfig(f.env);
  current.rss.feeds[0] = { ...current.rss.feeds[0], enabled: false, lastError: 'newer-result' };
  const replacement = structuredClone(current.rss.feeds[0]);
  await saveMonitorConfig(current, f.env);
  f.release.resolve(); const result = await polling;
  const { listRecentItems, loadMeta } = await import('../src/monitor/store.mjs');
  assert.equal(result.fetched, 1); assert.equal(result.added, 1);
  assert.equal((await listRecentItems({}, f.env))[0].title, 'fixture item');
  assert.ok((await loadMeta(f.env)).lastPollAt[`rss:${rows.rss.entry.url}`]);
  assert.deepEqual((await loadMonitorConfig(f.env)).rss.feeds[0], replacement);
});

test('a later completed successful poll is not replaced by an older delayed error', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-parallel-snapshot-'));
  const env = { MSB_RUNTIME_ROOT: root }, oldEntered = gate(), newEntered = gate();
  const releaseOld = gate(), releaseNew = gate();
  const cfg = defaultConfig(); cfg.rss.enabled = true;
  cfg.rss.feeds = [{ ...rows.rss.entry, lastError: 'previous-error' }];
  await saveMonitorConfig(cfg, env);
  const originalFetch = globalThis.fetch;
  let calls = 0, oldPoll, newPoll;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) { oldEntered.resolve(); await releaseOld.promise; return { ok: false, status: 503 }; }
    if (calls === 2) { newEntered.resolve(); await releaseNew.promise; return { ok: true, text: async () => '<rss></rss>' }; }
    throw Error('unexpected synthetic fetch');
  };
  t.after(async () => {
    releaseOld.resolve(); releaseNew.resolve();
    await Promise.allSettled([oldPoll, newPoll].filter(Boolean));
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  oldPoll = pollAllSources(env, { log() {} }); await oldEntered.promise;
  newPoll = pollAllSources(env, { log() {} }); await newEntered.promise;
  releaseNew.resolve(); const recent = await newPoll;
  releaseOld.resolve(); const older = await oldPoll;
  assert.equal(recent.errors.length, 0);
  assert.equal(older.errors[0].error, 'HTTP 503');
  assert.equal((await loadMonitorConfig(env)).rss.feeds[0].lastError, null);
});

test('a separate process can replace a YouTube row without an old resolution overwriting it', { timeout: 10000 }, async t => {
  const row = { channelId: null, handle: 'fixturehandle', name: 'old', enabled: true };
  const resolved = 'UCabcdefghijabcdefghijab';
  const f = await fixture(t, 'youtube', row, target => target.includes('/@fixturehandle')
    ? { ok: true, text: async () => `"channelId":"${resolved}"` }
    : { ok: true, text: async () => '<feed></feed>' });
  const polling = f.run(); await f.entered.promise;
  const script = fileURLToPath(new URL('./fixtures/monitor-source-replace-worker.mjs', import.meta.url));
  const env = { PATH: '/usr/bin:/bin', TMPDIR: process.env.TMPDIR || '/tmp', MSB_RUNTIME_ROOT: f.env.MSB_RUNTIME_ROOT };
  const child = fork(script, [], { env, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(Error(`synthetic writer ${code}/${signal}: ${stderr}`)));
  });
  const replacement = (await loadMonitorConfig(f.env)).youtube.channels[0];
  assert.equal(replacement.marker, 'other-process');
  f.release.resolve(); await polling;
  assert.deepEqual((await loadMonitorConfig(f.env)).youtube.channels[0], replacement);
});
