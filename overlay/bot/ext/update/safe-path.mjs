/**
 * Границы путей выкладки обвязки: запрет выхода из корня и записи в local/.
 * Используют [client.applyExt](./client.mjs) и remote install script.
 * local/ — зона владельца сервера, не часть релиза: [local-ext](../local-ext/README.md).
 */

/**
 * Нормализовать относительный путь манифеста и отклонить опасные/запрещённые.
 * @returns {string} posix-относительный путь без ведущего /
 */
export function assertSafeExtInstallPath(rel) {
  const raw = String(rel || '');
  if (!raw || raw.includes('\0')) throw new Error('bad path');
  const normalized = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) throw new Error(`bad path ${rel}`);
  if (parts[0] === 'local') throw new Error(`refusing local/ path: ${rel}`);
  return normalized;
}
