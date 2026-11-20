/** Current storage baseline, not a decision about future SQLite migration.
 * Uses only an isolated synthetic profile and a minimal old-shaped database.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultConfig, saveMonitorConfig } from '../../src/monitor/config.mjs';
import { appendItems, listRecentItems } from '../../src/monitor/store.mjs';
import { buildDigestText } from '../../src/monitor/digest.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-storage-baseline-'));
const env = { MSB_RUNTIME_ROOT: root };
try {
  const dir = path.join(root, 'monitor'), dbFile = path.join(dir, 'knowledge.db');
  await fs.mkdir(dir, { recursive: true });
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("CREATE TABLE items (id TEXT PRIMARY KEY, source_type TEXT NOT NULL, item_type TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, author TEXT NOT NULL, published_at TEXT NOT NULL)");
    db.prepare('INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?)').run('sqlite-id', 'rss', 'post',
      'synthetic SQLite item', 'https://fixture.invalid/sqlite', 'fixture', new Date().toISOString());
  } finally { db.close(); }
  const before = await fs.readFile(dbFile);
  const cfg = defaultConfig(); cfg.storage = 'sqlite';
  await saveMonitorConfig(cfg, env);
  await appendItems([{ sourceType: 'rss', sourceId: 'fixture', externalId: 'jsonl-id',
    sourceName: 'fixture', title: 'synthetic JSONL item', url: 'https://fixture.invalid/jsonl',
    publishedAt: new Date().toISOString() }], env);
  const items = await listRecentItems({}, env), digest = await buildDigestText(env);
  assert.deepEqual(items.map(item => item.title), ['synthetic JSONL item']);
  assert.match(digest.text, /synthetic JSONL item/);
  assert.doesNotMatch(digest.text, /synthetic SQLite item/);
  assert.deepEqual(await fs.readFile(dbFile), before);
  console.log('BASELINE: saved sqlite choice still reads JSONL and leaves the synthetic database unchanged.');
} finally { await fs.rm(root, { recursive: true, force: true }); }
