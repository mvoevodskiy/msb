/**
 * Old workspace readiness and non-overwriting bootstrap completion. The exact
 * shipped cold-install seed is not an owner identity; compare bytes before
 * allowing an introduction, and treat all other files as owner data.
 * Used by [Codex introduction](./codex-bootstrap.mjs) and verified through
 * [Telegram/native shim](../../tests/codex-bootstrap.test.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const marker = '.iia-bootstrapped';
// bootstrap/workspace-seed/SOUL.md at this source revision. Update alongside
// the shipped seed and its real-seed test; never identify user files by name alone.
const seedSoul = { size: 9239, sha256: 'e630d64ec0e932c773364797d358d58533f1a90c1b2064755cc70231723487c3' };
const ownerFiles = ['USER.md', 'MEMORY.md', 'MISSION.md', 'GOALS.md', 'PROJECTS.md', 'PREFERENCES.md', 'LEARNED.md', 'IDENTITY.md'];

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    if (error.code === 'EACCES' || error.code === 'EPERM') return true;
    throw error;
  }
}

async function hasEntries(directory, { ignoreSeedPlaceholder = false } = {}) {
  try {
    const entries = await fs.readdir(directory);
    if (!entries.length) return false;
    if (ignoreSeedPlaceholder && entries.length === 1 && entries[0] === '.gitkeep') {
      const placeholder = await fs.lstat(path.join(directory, '.gitkeep'));
      if (placeholder.isFile() && placeholder.size === 0) return false;
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    if (error.code === 'EACCES' || error.code === 'EPERM') return true;
    throw error;
  }
}

export const bootstrapMarkerExists = workspace => exists(path.join(workspace, marker));
async function identityKind(workspace) {
  const file = path.join(workspace, 'SOUL.md');
  try {
    const info = await fs.lstat(file);
    // A user file, symlink or directory must retain the old ready behaviour.
    if (!info.isFile() || info.size !== seedSoul.size) return 'owner';
    const value = await fs.readFile(file);
    return createHash('sha256').update(value).digest('hex') === seedSoul.sha256 ? 'seed' : 'owner';
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'missing';
    if (error.code === 'EACCES' || error.code === 'EPERM') return 'owner';
    throw error;
  }
}

export const bootstrapIdentityExists = async workspace => await identityKind(workspace) === 'owner';

export async function bootstrapWorkspaceReady(workspace, { introductionActive = false } = {}) {
  if (await bootstrapMarkerExists(workspace)) return true;
  const identity = await identityKind(workspace);
  if (identity === 'owner') return true;
  // This scoped attempt started only after checking an empty seed. Notes it
  // creates during the conversation are not a completed identity by themselves.
  if (identity === 'seed' && introductionActive) return false;
  if (identity === 'seed' && !introductionActive) {
    for (const name of ownerFiles) if (await exists(path.join(workspace, name))) return true;
  }
  return await hasEntries(path.join(workspace, 'memory'), { ignoreSeedPlaceholder: identity === 'seed' }) ||
    await hasEntries(path.join(workspace, 'knowledge'));
}

const defaults = {
  'CLAUDE.md': '# Мои правила\n\nЗдесь можно записать персональные настройки работы.\n',
  'MEMORY.md': '# Память\n\n## Факты\n\n## Предпочтения\n\n## Важные решения\n',
  'MISSION.md': '# Миссия\n\nЗачем ты здесь и что строишь.\n',
  'GOALS.md': '# Цели\n\nТекущие цели с приоритетами и сроками.\n',
  'PROJECTS.md': '# Проекты\n\nАктивные проекты, стек, статус и следующие шаги.\n',
  'PREFERENCES.md': '# Предпочтения\n\nСтиль общения, рабочие часы и ограничения.\n',
  'LEARNED.md': '# Что я узнал\n\nРабочие выводы агента.\n',
};

async function createFile(staging, workspace, name, text) {
  const temporary = path.join(staging, name);
  await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
  try {
    await fs.link(temporary, path.join(workspace, name));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

async function createDirectory(file) {
  try {
    await fs.mkdir(file, { mode: 0o700 });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return (await fs.lstat(file)).isDirectory();
  }
}

export async function finishBootstrapWorkspace(workspace, { fallback, signal }) {
  signal?.throwIfAborted();
  await fs.mkdir(workspace, { recursive: true });
  const staging = await fs.mkdtemp(path.join(workspace, '.bootstrap-'));
  try {
    if (fallback) {
      await createFile(staging, workspace, 'SOUL.md',
        '# Личность\n\nСтиль: прямой, по делу\nТон: дружелюбный, профессиональный\nЯзык: русский\n');
    }
    for (const directory of ['memory', 'knowledge']) {
      signal?.throwIfAborted();
      await createDirectory(path.join(workspace, directory));
    }
    if (await createDirectory(path.join(workspace, '.claude'))) {
      await createDirectory(path.join(workspace, '.claude', 'skills'));
    }
    for (const [name, text] of Object.entries(defaults)) {
      signal?.throwIfAborted();
      await createFile(staging, workspace, name, text);
    }
    signal?.throwIfAborted();
    await createFile(staging, workspace, marker, new Date().toISOString() + '\n');
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(error => {
      console.error('[msb/bootstrap] could not clean staging:', error.code || error.name);
    });
  }
}
