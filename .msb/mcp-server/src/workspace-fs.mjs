/**
 * Bounded read/write under shared workspace and projects root only.
 * Validation mirrors [project paths](../../bot/src/projects/paths.mjs);
 * create uses [createProjectFiles](../../bot/src/projects/files.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  projectLocations,
  projectPath,
  resolveProjectDirectory,
} from '../../bot/src/projects/paths.mjs';
import { createProjectFiles, listProjectNames } from '../../bot/src/projects/files.mjs';
import { isBlockedRelative } from './sanitize.mjs';

const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = 512 * 1024;
const MAX_LIST = 500;

function assertRelative(rel) {
  const value = String(rel ?? '.');
  if (!value || value.includes('\0')) {
    throw Object.assign(new Error('Некорректный путь'), { code: 'INVALID_PATH' });
  }
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw Object.assign(new Error('Путь вне корня'), { code: 'PATH_ESCAPE' });
  }
  return normalized === '.' ? '' : normalized.replace(/^\.\//, '');
}

async function resolveBase(scope, project, env) {
  const locations = projectLocations(env);
  if (scope === 'workspace' || !scope) return { root: locations.workspace, kind: 'workspace' };
  if (scope === 'project') {
    if (!project) throw Object.assign(new Error('Нужен project для scope=project'), { code: 'PROJECT_REQUIRED' });
    const directory = await resolveProjectDirectory(project, env);
    return { root: directory, kind: 'project', project };
  }
  if (scope === 'projects_root') return { root: locations.root, kind: 'projects_root' };
  throw Object.assign(new Error(`Неизвестный scope: ${scope}`), { code: 'INVALID_SCOPE' });
}

function assertContained(root, candidate) {
  const relativeToRoot = path.relative(root, candidate);
  if (relativeToRoot === '..' || relativeToRoot.startsWith('..' + path.sep) || path.isAbsolute(relativeToRoot)) {
    throw Object.assign(new Error('Путь вне корня'), { code: 'PATH_ESCAPE' });
  }
  return relativeToRoot || '.';
}

async function resolveInside(root, relative) {
  const rel = assertRelative(relative);
  if (isBlockedRelative(rel)) {
    throw Object.assign(new Error('Доступ к секретному пути запрещён'), { code: 'BLOCKED_PATH' });
  }
  const absolute = path.resolve(root, rel || '.');
  const realRoot = await fs.realpath(root);
  assertContained(realRoot, absolute);
  let realTarget;
  try {
    realTarget = await fs.realpath(absolute);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    // Walk up until an existing ancestor proves containment for create/write.
    let cursor = path.dirname(absolute);
    for (;;) {
      try {
        const realAncestor = await fs.realpath(cursor);
        assertContained(realRoot, realAncestor);
        break;
      } catch (inner) {
        if (inner?.code !== 'ENOENT') throw inner;
        if (cursor === path.dirname(cursor)) {
          throw Object.assign(new Error('Путь вне корня'), { code: 'PATH_ESCAPE' });
        }
        cursor = path.dirname(cursor);
      }
    }
    return { absolute, relative: rel || '.', exists: false };
  }
  return {
    absolute: realTarget,
    relative: assertContained(realRoot, realTarget),
    exists: true,
  };
}

export async function listFiles({ scope = 'workspace', project, path: rel = '.', env = process.env } = {}) {
  const { root, kind } = await resolveBase(scope, project, env);
  const target = await resolveInside(root, rel);
  if (!target.exists) throw Object.assign(new Error('Путь не найден'), { code: 'NOT_FOUND' });
  const stat = await fs.stat(target.absolute);
  if (!stat.isDirectory()) {
    return {
      scope: kind,
      project: project || null,
      path: target.relative,
      type: 'file',
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      entries: null,
    };
  }
  const ents = await fs.readdir(target.absolute, { withFileTypes: true });
  const entries = [];
  for (const ent of ents.slice(0, MAX_LIST)) {
    const name = ent.name;
    const childRel = path.posix.join(target.relative === '.' ? '' : target.relative.replace(/\\/g, '/'), name);
    if (isBlockedRelative(childRel)) continue;
    entries.push({
      name,
      type: ent.isDirectory() ? 'dir' : ent.isSymbolicLink() ? 'symlink' : 'file',
    });
  }
  return {
    scope: kind,
    project: project || null,
    path: target.relative,
    type: 'dir',
    truncated: ents.length > MAX_LIST,
    entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function readFile({ scope = 'workspace', project, path: rel, env = process.env } = {}) {
  if (rel == null || rel === '') throw Object.assign(new Error('Нужен path'), { code: 'PATH_REQUIRED' });
  const { root, kind } = await resolveBase(scope, project, env);
  const target = await resolveInside(root, rel);
  if (!target.exists) throw Object.assign(new Error('Файл не найден'), { code: 'NOT_FOUND' });
  const stat = await fs.stat(target.absolute);
  if (!stat.isFile()) throw Object.assign(new Error('Это не файл'), { code: 'NOT_FILE' });
  if (stat.size > MAX_READ_BYTES) {
    throw Object.assign(new Error(`Файл больше ${MAX_READ_BYTES} байт`), { code: 'TOO_LARGE' });
  }
  const content = await fs.readFile(target.absolute, 'utf8');
  return {
    scope: kind,
    project: project || null,
    path: target.relative,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    content,
  };
}

export async function writeFile({
  scope = 'workspace',
  project,
  path: rel,
  content = '',
  mkdir = true,
  env = process.env,
} = {}) {
  if (rel == null || rel === '' || rel === '.') {
    throw Object.assign(new Error('Нужен path файла'), { code: 'PATH_REQUIRED' });
  }
  const text = String(content);
  if (Buffer.byteLength(text, 'utf8') > MAX_WRITE_BYTES) {
    throw Object.assign(new Error(`Запись больше ${MAX_WRITE_BYTES} байт`), { code: 'TOO_LARGE' });
  }
  const { root, kind } = await resolveBase(scope, project, env);
  const target = await resolveInside(root, rel);
  if (mkdir) await fs.mkdir(path.dirname(target.absolute), { recursive: true });
  const tmp = `${target.absolute}.tmp.${process.pid}`;
  await fs.writeFile(tmp, text, { mode: 0o600 });
  await fs.rename(tmp, target.absolute);
  const stat = await fs.stat(target.absolute);
  return {
    scope: kind,
    project: project || null,
    path: target.relative,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    written: true,
  };
}

export async function makeDirectory({ scope = 'workspace', project, path: rel, env = process.env } = {}) {
  if (rel == null || rel === '' || rel === '.') {
    throw Object.assign(new Error('Нужен path каталога'), { code: 'PATH_REQUIRED' });
  }
  const { root, kind } = await resolveBase(scope, project, env);
  const target = await resolveInside(root, rel);
  await fs.mkdir(target.absolute, { recursive: true });
  return { scope: kind, project: project || null, path: target.relative, created: true };
}

export async function createProject(name, env = process.env) {
  const directory = await createProjectFiles(name, env);
  return {
    name,
    directory,
    projects: await listProjectNames(env),
  };
}

export async function resolveProjectPath(name, env = process.env) {
  return projectPath(name, env);
}
