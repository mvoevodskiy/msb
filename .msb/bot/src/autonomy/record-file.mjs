/**
 * Atomic profile JSON I/O inside the caller's existing file lock.
 * [Saved timers](./legacy-timers.mjs), [actions](./reminder-store.mjs),
 * [breaker state](./reminder-breaker.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export { physicalFilePath as physicalRecordPath } from '../../shared/physical-file-path.mjs';

export async function readOptionalJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function readRecordArray(file) {
  const records = await readOptionalJson(file);
  if (records === undefined) return [];
  if (!Array.isArray(records)) throw new Error('Expected a record array');
  return records;
}

export function writeRecordArray(file, records, options) {
  return writeRecordJson(file, records, options);
}

export async function syncPublishedRecord(file) {
  for (const target of [file, path.dirname(file)]) {
    const handle = await fs.open(target, 'r');
    try { await handle.sync(); }
    finally { await handle.close(); }
  }
}

export async function writeRecordJson(file, value, { signal, create = false, beforePublish, durable = false } = {}) {
  signal?.throwIfAborted();
  const mode = await fs.stat(file).then(stat => stat.mode & 0o777, error => {
    if (create && error?.code === 'ENOENT') return 0o600;
    throw error;
  });
  const directory = await fs.mkdtemp(path.join(path.dirname(file), '.records-'));
  try {
    const temporary = path.join(directory, 'records.json');
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    await fs.chmod(temporary, mode);
    if (beforePublish) await beforePublish();
    signal?.throwIfAborted();
    await fs.rename(temporary, file);
    if (durable) await syncPublishedRecord(file);
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(error => {
      console.error('[msb/autonomy] Could not clean record temporary directory:', error.code || error.name);
    });
  }
}
