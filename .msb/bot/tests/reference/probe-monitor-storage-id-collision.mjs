/** Synthetic schema comparison; it does not migrate or select a backend. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appendItems, listRecentItems } from '../../src/monitor/store.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-id-collision-'));
const env = { MSB_RUNTIME_ROOT: root }, now = new Date().toISOString();
try {
  const items = [
    { sourceType: 'rss', sourceId: 'feed-one', externalId: 'shared-id',
      title: 'synthetic RSS', url: 'https://fixture.invalid/rss', publishedAt: now },
    { sourceType: 'youtube', sourceId: 'channel-two', externalId: 'shared-id',
      title: 'synthetic YouTube', url: 'https://fixture.invalid/video', publishedAt: now },
  ];
  assert.equal(await appendItems(items, env), 2);
  const stored = await listRecentItems({}, env);
  assert.equal(stored.length, 2);
  assert.notEqual(stored[0].id, stored[1].id);
  const jsonl = path.join(root, 'monitor', 'items.jsonl');
  const before = await fs.readFile(jsonl);
  const db = new DatabaseSync(path.join(root, 'legacy-shape.db'));
  try {
    db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, source_type TEXT NOT NULL, title TEXT NOT NULL)');
    const insert = db.prepare('INSERT OR IGNORE INTO items (id, source_type, title) VALUES (?, ?, ?)');
    const changes = items.map(item => insert.run(item.externalId, item.sourceType, item.title).changes);
    assert.deepEqual(changes, [1, 0]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1);
  } finally { db.close(); }
  assert.deepEqual(await fs.readFile(jsonl), before);
  console.log('BASELINE: two JSONL identities collapse to one under the old externalId primary key.');
} finally { await fs.rm(root, { recursive: true, force: true }); }
