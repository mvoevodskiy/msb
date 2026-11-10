import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { msbRoot } from '../paths.mjs';

export function updatesStatePath(home, env = process.env) {
  return path.join(msbRoot(home, env), 'updates', 'state.json');
}

export async function readUpdatesState(home, env = process.env) {
  try {
    return JSON.parse(await fsp.readFile(updatesStatePath(home, env), 'utf8'));
  } catch {
    return { applied_core_version: null, applied_ext_version: null };
  }
}

export async function writeUpdatesState(patch, home, env = process.env) {
  const file = updatesStatePath(home, env);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const cur = await readUpdatesState(home, env);
  const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(tmp, file);
  return next;
}

export async function detectCoreVersion(home, env = process.env) {
  const state = await readUpdatesState(home, env);
  if (state.applied_core_version) return state.applied_core_version;
  const root = msbRoot(home, env);
  const puller = path.join(root, '.puller-state.json');
  try {
    const j = JSON.parse(await fsp.readFile(puller, 'utf8'));
    if (j.applied_platform_version) return j.applied_platform_version;
  } catch { /* ignore */ }
  const indexJs = path.join(root, 'bot', 'index.js');
  try {
    const buf = await fsp.readFile(indexJs);
    return `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
  } catch {
    return null;
  }
}
