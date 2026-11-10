/**
 * Bind a lock and its writer to the real file, including a missing leaf under
 * a linked parent. Used by [record stores](../src/autonomy/record-file.mjs) and
 * [native Codex config](../../../overlay/bot/ext/codex-config-write.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export async function physicalFilePath(logical) {
  try {
    return await fs.realpath(logical);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    try {
      await fs.lstat(logical);
    } catch (missing) {
      const parent = path.dirname(logical);
      if (missing?.code !== 'ENOENT' || parent === logical) throw missing;
      // The missing file will have the same lock name after it is created,
      // even when a parent directory is reached through a symlink.
      return path.join(await physicalFilePath(parent), path.basename(logical));
    }
    // Another writer may have created the path after the first realpath.
    // A still-dangling symlink continues to fail here.
    return fs.realpath(logical);
  }
}
