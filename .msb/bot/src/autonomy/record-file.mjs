/**
 * Atomic JSON array I/O inside the caller's existing file lock.
 * [Saved timers](./legacy-timers.mjs), [reminder actions](./reminder-store.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

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

export async function writeRecordArray(file, records, { signal, create = false } = {}) {
  signal?.throwIfAborted();
  const mode = await fs.stat(file).then(stat => stat.mode & 0o777, error => {
    if (create && error?.code === 'ENOENT') return 0o600;
    throw error;
  });
  const directory = await fs.mkdtemp(path.join(path.dirname(file), '.records-'));
  try {
    const temporary = path.join(directory, 'records.json');
    await fs.writeFile(temporary, JSON.stringify(records, null, 2), { flag: 'wx', mode: 0o600 });
    await fs.chmod(temporary, mode);
    signal?.throwIfAborted();
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(error => {
      console.error('[msb/autonomy] Could not clean record temporary directory:', error.code || error.name);
    });
  }
}
