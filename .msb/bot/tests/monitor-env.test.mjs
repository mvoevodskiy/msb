import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  addSourceFromInput,
  classifySourceInput,
  listSourcesFlat,
  loadMonitorConfig,
} from '../src/monitor/config.mjs';
import { appendItems, listRecentItems } from '../src/monitor/store.mjs';
import { setEnvKey, deleteEnvKey, listEnvEntries, PROTECTED_KEYS } from '../src/env/store.mjs';
import { checkOwnUpdates } from '../src/updates/client.mjs';

test('classify sources', () => {
  assert.equal(classifySourceInput('https://github.com/foo/bar').type, 'github');
  assert.equal(classifySourceInput('https://x.com/elonmusk').type, 'twitter');
  assert.equal(classifySourceInput('https://t.me/durov').type, 'telegram');
  assert.equal(classifySourceInput('https://example.com/feed.xml').type, 'rss');
  assert.equal(classifySourceInput('https://youtube.com/@veritasium').type, 'youtube');
});

test('monitor config add + store', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-mon-'));
  const env = { HOME: home };
  const a = await addSourceFromInput('https://example.com/atom.xml', env);
  assert.equal(a.ok, true);
  assert.equal(a.type, 'rss');
  const cfg = await loadMonitorConfig(env);
  assert.equal(listSourcesFlat(cfg).length, 1);
  const n = await appendItems(
    [
      {
        sourceType: 'rss',
        sourceId: 'https://example.com/atom.xml',
        title: 'Hello',
        url: 'https://example.com/1',
        publishedAt: new Date().toISOString(),
      },
    ],
    env,
  );
  assert.equal(n, 1);
  const again = await appendItems(
    [
      {
        sourceType: 'rss',
        sourceId: 'https://example.com/atom.xml',
        title: 'Hello',
        url: 'https://example.com/1',
        publishedAt: new Date().toISOString(),
      },
    ],
    env,
  );
  assert.equal(again, 0);
  assert.equal((await listRecentItems({ limit: 10 }, env)).length, 1);
});

test('env CRUD', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-env-'));
  const env = { HOME: home, MSB_BOT_ID: 'default' };
  await setEnvKey('DEEPGRAM_API_KEY', 'secret-value-123', env);
  const list = await listEnvEntries(env);
  assert.ok(list.some((e) => e.key === 'DEEPGRAM_API_KEY'));
  await deleteEnvKey('DEEPGRAM_API_KEY', env);
  assert.equal((await listEnvEntries(env)).some((e) => e.key === 'DEEPGRAM_API_KEY'), false);
  await setEnvKey('BOT_TOKEN', '12345:' + 'F'.repeat(30), env, {internal:true});
  await assert.rejects(() => deleteEnvKey('BOT_TOKEN', env));
  assert.ok(PROTECTED_KEYS.has('BOT_TOKEN'));
});

test('own updates stub', async () => {
  const r = await checkOwnUpdates({});
  assert.equal(r.status, 'unconfigured');
  assert.match(r.message, /MSB_OWN_UPDATES_URL/);
});
