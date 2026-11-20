/**
 * Private full snapshot before a confirmed [bulk removal](./reminder-store.mjs).
 * The caller holds the action file lock. Publish through [atomic JSON](./record-file.mjs)
 * and make the archive durable before returning its path.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeRecordArray } from './record-file.mjs';

export async function archiveSavedActions(file, records, now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const base = path.join(path.dirname(file), 'actions.removed-' + stamp);
  let archive = base + '.json';
  const exists = await fs.lstat(archive).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (exists) archive = base + '-' + randomUUID() + '.json';
  await writeRecordArray(archive, records, { create: true, durable: true });
  return archive;
}
