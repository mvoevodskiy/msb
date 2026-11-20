/**
 * Lock the physical native config for [preference saves](./apply-model.mjs)
 * and [HTTP transport updates](./codex-transport.mjs). Stage changes privately
 * and restore the native file if publication of the companion store fails.
 * [Failure and concurrency tests](./tests/apply-model.test.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '../shared/file-lock.mjs';
import { physicalFilePath } from '../shared/physical-file-path.mjs';

async function configStat(file) {
  return fs.stat(file).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
}

function sameConfig(current, previous) {
  if (!current || !previous) return current === previous;
  return current.dev === previous.dev && current.ino === previous.ino &&
    current.size === previous.size && current.mtimeMs === previous.mtimeMs && current.mode === previous.mode;
}

async function writeConfig(file, previous, bytes, text, commitStore) {
  const staged = await fs.mkdtemp(path.join(path.dirname(file), '.codex-config-'));
  let keepBackup = false;
  try {
    const next = path.join(staged, 'next');
    await fs.writeFile(next, text, { mode: 0o600 });
    const backup = commitStore && previous ? path.join(staged, 'previous') : null;
    if (backup) {
      await fs.writeFile(backup, bytes, { mode: 0o600 });
      await fs.chmod(backup, previous.mode & 0o777);
    }
    const prepared = commitStore ? await fs.stat(next) : null;
    if (!sameConfig(await configStat(file), previous)) {
      throw new Error('config.toml изменился во время сохранения.');
    }
    await fs.rename(next, file);
    if (!commitStore) return;

    try {
      await commitStore();
    } catch (error) {
      try {
        if (!sameConfig(await configStat(file), prepared)) throw new Error('config.toml изменился');
        if (backup) await fs.rename(backup, file);
        else await fs.unlink(file);
      } catch (rollbackError) {
        keepBackup = Boolean(backup);
        if (keepBackup) console.error('[msb/ext/codex] config backup kept at', backup);
        throw new AggregateError([error, rollbackError], 'Не удалось восстановить config.toml после ошибки сохранения.');
      }
      throw error;
    }
  } finally {
    if (!keepBackup) {
      await fs.rm(staged, { recursive: true, force: true }).catch(error => {
        console.error('[msb/ext/codex] could not clean staged config:', error.code || error.name);
      });
    }
  }
}

export async function withCodexConfig(logical, update) {
  const file = await physicalFilePath(logical);
  return withFileLock(file, async () => {
    if (await physicalFilePath(logical) !== file) throw new Error('Путь config.toml изменился.');
    const previous = await configStat(file);
    const bytes = previous ? await fs.readFile(file) : Buffer.alloc(0);
    return update(bytes.toString('utf8'), (text, commitStore) =>
      writeConfig(file, previous, bytes, text, commitStore), file);
  });
}
