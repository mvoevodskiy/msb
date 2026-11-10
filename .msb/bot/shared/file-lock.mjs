/** Cross-process transaction boundary for a profile JSON file. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const queues = globalThis[Symbol.for('msb.providerStoreUpdates')] ||= new Map();
let useBuiltin = false;

async function openDatabase(file) {
  if (!useBuiltin) {
    try {
      const Database = require('better-sqlite3');
      return new Database(file);
    } catch (err) {
      // Local development may have a native module built for another Node ABI.
      // Node >=22.5 supplies SQLite itself; older supported runtimes keep using
      // the declared better-sqlite3 dependency.
      if (err?.code !== 'MODULE_NOT_FOUND' && err?.code !== 'ERR_DLOPEN_FAILED' &&
          !String(err?.message || '').includes('Could not locate the bindings file')) throw err;
      useBuiltin = true;
    }
  }
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file);
}

async function acquire(db) {
  db.exec('PRAGMA busy_timeout = 0;');
  const deadline = performance.now() + 10_000;
  for (;;) {
    try { db.exec('BEGIN IMMEDIATE;'); return; }
    catch (err) {
      const busy = /^SQLITE_(BUSY|LOCKED)/.test(err?.code || '') ||
        (err?.code === 'ERR_SQLITE_ERROR' && [5, 6].includes(err.errcode & 255));
      if (!busy || performance.now() >= deadline) throw err;
      // SQLite's synchronous busy_timeout would freeze Telegram polling /stop.
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

/** Hold an OS-released SQLite write lock while updating the existing JSON. */
export function withFileLock(file, action) {
  const previous = queues.get(file) || Promise.resolve();
  const update = previous.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const lockPath = `${file}.lock.sqlite`;
    const db = await openDatabase(lockPath);
    try {
      await fs.chmod(lockPath, 0o600);
      await acquire(db);
      try { return await action(); }
      finally { db.exec('ROLLBACK;'); }
    } finally { db.close(); }
  });
  queues.set(file, update);
  const release = () => { if (queues.get(file) === update) queues.delete(file); };
  update.then(release, release);
  return update;
}
