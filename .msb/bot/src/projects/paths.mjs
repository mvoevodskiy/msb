/**
 * Base workspace + saved project → captured execution cwd; no state/env writes.
 * Old qA/_A root contract: [reference](../../tests/reference/parity-projects-contract.txt).
 * Callers: [selection](./selection.mjs), [files](./files.mjs), [runner](../agent/turn.mjs).
 * [Execution checks](../../tests/project-execution.test.mjs), [UI checks](../../tests/projects.test.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {workspaceDir} from '../paths.mjs';

export function projectLocations(env = process.env, base = workspaceDir(env)) {
  const workspace = path.resolve(base);
  return {workspace, root:path.join(path.dirname(workspace), 'projects')};
}
export function projectMissing(name) {
  return Object.assign(new Error(`Проект «${String(name)}» не найден.`), {code:'PROJECT_NOT_FOUND'});
}
export function projectPath(name, env = process.env, base) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..'
    || name.includes('\0') || path.basename(name) !== name || path.isAbsolute(name)) throw projectMissing(name);
  return path.join(projectLocations(env, base).root, name);
}
export async function resolveProjectDirectory(name, env = process.env, base) {
  const directory = projectPath(name, env, base);
  try {
    if (!(await fs.stat(directory)).isDirectory()) throw projectMissing(name);
    const [root, actual] = await Promise.all([fs.realpath(projectLocations(env, base).root), fs.realpath(directory)]);
    const relative = path.relative(root, actual);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw projectMissing(name);
    return directory;
  } catch (error) {
    if (['ENOENT','ENOTDIR'].includes(error?.code)) throw projectMissing(name);
    throw error;
  }
}
export async function resolveProjectCwd(state, env = process.env, base) {
  return state.activeProject === undefined || state.activeProject === null || state.activeProject === ''
    ? projectLocations(env, base).workspace : resolveProjectDirectory(state.activeProject, env, base);
}
