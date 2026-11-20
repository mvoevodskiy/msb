import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendItems, listRecentItems } from '../src/monitor/store.mjs';

test('recent items are chosen by publication time across batches before applying the limit', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-order-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { MSB_RUNTIME_ROOT: root };
  const now = Date.now();
  const item = (id, minutes) => ({ id, title: id, publishedAt: new Date(now - minutes * 60_000).toISOString() });
  await appendItems([item('newest', 1), item('middle', 5), item('oldest', 10)], env);
  await appendItems([item('second', 2), item('expired', 3_000)], env);
  const recent = await listRecentItems({ limit: 2, sinceHours: 36 }, env);
  assert.deepEqual(recent.map((entry) => entry.id), ['newest', 'second']);
  assert.deepEqual(await listRecentItems({ limit: 0 }, env), []);
});

test('recent items fall back to saved time, skip expired and malformed entries, and break ties by insertion', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-order-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { MSB_RUNTIME_ROOT: root };
  const now = Date.now();
  const time = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const dir = path.join(root, 'monitor');
  await fs.mkdir(dir, { recursive: true });
  const rows = [
    { id: 'earlier-tie', publishedAt: time(2) },
    { id: 'bad-published', publishedAt: 'invalid', savedAt: time(1) },
    { id: 'expired-fallback', savedAt: time(3_000) },
    { id: 'undated', title: 'do not treat as recent' },
    { id: 'later-tie', publishedAt: time(2) },
  ];
  await fs.writeFile(path.join(dir, 'items.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n{bad json\n`);
  const recent = await listRecentItems({ limit: 10, sinceHours: 36 }, env);
  assert.deepEqual(recent.map((entry) => entry.id), ['bad-published', 'later-tie', 'earlier-tie']);
});
