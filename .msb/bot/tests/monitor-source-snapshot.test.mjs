/** Poll results must not mutate a source row changed while its request was pending.
 * Synthetic profiles and fake fetch only; reference and limits:
 * [contract](./reference/parity-monitor-source-snapshot-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
