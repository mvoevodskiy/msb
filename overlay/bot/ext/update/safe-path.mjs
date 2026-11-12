/**
 * Границы путей выкладки обвязки: запрет выхода из корня и записи в local/.
 * Используют [client.applyExt](./client.mjs) и remote install script.
 * local/ — зона владельца сервера, не часть релиза: [local-ext](../local-ext/README.md).
 */
import path from 'node:path';
import { physicalFilePath } from '../../shared/physical-file-path.mjs';

/**
 * Нормализовать относительный путь манифеста и отклонить опасные/запрещённые.
 * @returns {string} posix-относительный путь без ведущего /
 */
export function assertSafeExtInstallPath(rel) {
  const raw = String(rel || '');
  if (!raw || raw.includes('\0')) throw new Error('bad path');
  const normalized = raw.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (/^[A-Za-z]:/.test(normalized) || parts.some(p => !p || p === '.' || p === '..')) throw new Error(`bad path ${rel}`);
  if (parts[0] === 'local') throw new Error(`refusing local/ path: ${rel}`);
  return normalized;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

export async function resolveExtInstallTarget(root, rel) {
  const relative = assertSafeExtInstallPath(rel);
  const live = await physicalFilePath(path.resolve(root));
  const local = await physicalFilePath(path.join(live, 'local'));
  const target = await physicalFilePath(path.join(live, relative));
  if (target === live || !isWithin(live, target)) throw new Error(`bad path ${rel}`);
  if (isWithin(local, target)) throw new Error(`refusing local/ path: ${rel}`);
  return target;
}
