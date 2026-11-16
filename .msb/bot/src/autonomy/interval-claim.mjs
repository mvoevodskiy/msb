/**
 * Неблокирующий межпроцессный claim интервальных ходов конкретного бота.
 * Вход: scheduler.mjs; lock: ../../shared/file-lock.mjs. Проверка:
 * ../../tests/autonomy-same-bot-claim.test.mjs. При падении ОС освобождает lock.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { botRoot } from '../paths.mjs';
import { tryWithFileLock } from '../../shared/file-lock.mjs';

// Resolve the nearest existing ancestor even when a suffix (for example
// bots/default) is missing. Dangling paths may still prevent lock creation.
async function canonicalPath(file) {
  let candidate = path.resolve(file);
  const suffix = [];
  for (;;) {
    try { return path.join(await fs.realpath(candidate), ...suffix); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      suffix.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

export async function tryIntervalClaim(action, env = process.env) {
  const bot = await canonicalPath(botRoot(env));
  return tryWithFileLock(path.join(bot, '.interval-claim'), action);
}
