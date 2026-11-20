import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import profile from '../shared/profile.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function botId(env = process.env) {
  return profile.botId(env);
}

export function msbRoot(home, env = process.env) {
  return profile.resolveProfile(env, home).root;
}

export function botDir(env = process.env, home) {
  return path.join(msbRoot(home, env), 'bots', botId(env));
}

export function botStatePath(env = process.env, home) {
  return path.join(botDir(env, home), 'state.json');
}

export async function readBotState(env = process.env, home = env.HOME || os.homedir()) {
  try {
    return JSON.parse(await fs.readFile(botStatePath(env, home), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/** Локальный префикс npm для Codex/Qwen — без sudo. */
export function extToolsPrefix(home, env = process.env) {
  return path.join(msbRoot(home, env), 'ext-tools');
}

export function extToolsBin(home, env = process.env) {
  return path.join(extToolsPrefix(home, env), 'bin');
}

export function botPackageRoot() {
  return path.resolve(__dirname, '..');
}
