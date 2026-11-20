/**
 * Read `<cwd>/.msb/settings.yaml` (or .json). Missing file → routing off.
 * Parse → [routing-parse](./routing-parse.mjs); shape → [routing-schema](./routing-schema.mjs).
 * Path containment stays inside captured cwd (no escape via symlink outside).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseRoutingSettingsText } from './routing-parse.mjs';
import { normalizeRoutingSettings } from './routing-schema.mjs';

const NAMES = Object.freeze(['settings.yaml', 'settings.yml', 'settings.json']);

async function containedFile(cwd, name) {
  const root = await fs.realpath(cwd);
  const candidate = path.join(root, '.msb', name);
  let actual;
  try { actual = await fs.realpath(candidate); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const relative = path.relative(root, actual);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('файл настроек вне каталога проекта'), { code: 'ROUTING_PATH' });
  }
  return actual;
}

/**
 * @param {string} cwd
 * @returns {Promise<null|{settings:object,path:string}>}
 */
export async function loadProjectRouting(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  let file = null;
  let lastError = null;
  for (const name of NAMES) {
    try {
      file = await containedFile(cwd, name);
      if (file) break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!file) {
    if (lastError && lastError.code === 'ROUTING_PATH') throw lastError;
    return null;
  }
  const text = await fs.readFile(file, 'utf8');
  const settings = normalizeRoutingSettings(parseRoutingSettingsText(text));
  return { settings, path: file };
}
