/**
 * Old workspace readiness and non-overwriting bootstrap completion.
 * Used by [Codex introduction](./codex-bootstrap.mjs) and verified through
 * [Telegram/native shim](../../tests/codex-bootstrap.test.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const marker = '.iia-bootstrapped';

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

async function hasEntries(directory) {
  try {
    return (await fs.readdir(directory)).length > 0;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

export const bootstrapMarkerExists = workspace => exists(path.join(workspace, marker));
export const bootstrapIdentityExists = workspace => exists(path.join(workspace, 'SOUL.md'));

export async function bootstrapWorkspaceReady(workspace) {
  return await bootstrapMarkerExists(workspace) || await bootstrapIdentityExists(workspace) ||
    await hasEntries(path.join(workspace, 'memory')) || await hasEntries(path.join(workspace, 'knowledge'));
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
