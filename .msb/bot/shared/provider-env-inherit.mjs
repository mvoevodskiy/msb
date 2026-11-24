/**
 * Read-only наследование AI provider keys от основного бота (`default`).
 * Запись остаётся per-bot ([env/store](../src/env/store.mjs), overlay writeEnvKey).
 * Цепочка: process → bots/<id>/.env → bots/default/.env (если не default) → <root>/.env.
 * [Контракт](../tests/reference/parity-env-provider-inherit-contract.txt).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import profile from './profile.cjs';

/** Ключи подключения к AI-провайдерам; BOT_TOKEN и прочие сервисы не входят. */
export const INHERITABLE_PROVIDER_KEYS = Object.freeze([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'MSB_ANTHROPIC_API_KEY',
  'IIA_ANTHROPIC_API_KEY',
  'CURSOR_API_KEY',
  'XAI_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'OPENAI_API_KEY',
  'QWEN_API_KEY',
  'DASHSCOPE_API_KEY',
  'OPENAI_COMPAT_API_KEY',
  'OPENAI_COMPAT_BASE_URL',
]);

const INHERITABLE = new Set(INHERITABLE_PROVIDER_KEYS);

export function isInheritableProviderKey(key) {
  return INHERITABLE.has(String(key || ''));
}

export function botEnvFilePath(env = process.env, home = env.HOME || os.homedir(), id = profile.botId(env)) {
  return path.join(profile.resolveProfile(env, home).root, 'bots', id, '.env');
}

export function defaultBotEnvFilePath(env = process.env, home = env.HOME || os.homedir()) {
  return botEnvFilePath(env, home, 'default');
}

export function rootEnvFilePath(env = process.env, home = env.HOME || os.homedir()) {
  return path.join(profile.resolveProfile(env, home).root, '.env');
}

function candidateKeys(key) {
  if (key.startsWith('MSB_')) return [key, `IIA_${key.slice(4)}`];
  if (key.startsWith('IIA_')) return [key, `MSB_${key.slice(4)}`];
  return [key];
}

function parseEnvFile(text) {
  const rows = [];
  for (const line of text.split(/\n/)) {
    if (!line || line.trimStart().startsWith('#')) {
      rows.push({ kind: 'raw', text: line });
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      rows.push({ kind: 'raw', text: line });
      continue;
    }
    rows.push({ kind: 'kv', key: line.slice(0, eq), value: line.slice(eq + 1) });
  }
  return rows;
}

function valueFromRows(rows, keys) {
  const hit = keys.map((candidate) => rows.find((r) => r.kind === 'kv' && r.key === candidate)).find(Boolean);
  const value = hit?.value?.trim();
  return value || '';
}

function envFilePathsForKey(key, env, home) {
  const current = botEnvFilePath(env, home);
  const root = rootEnvFilePath(env, home);
  if (!isInheritableProviderKey(key)) return [current, root];
  const id = profile.botId(env);
  if (id === 'default') return [current, root];
  return [current, defaultBotEnvFilePath(env, home), root];
}

function processValue(key, env) {
  const value = profile.envValue(env, key);
  if (value?.trim()) return value.trim();
  if (key.startsWith('MSB_') && value !== undefined) return '';
  return null;
}

async function readFileValue(file, keys) {
  try {
    return valueFromRows(parseEnvFile(await fsp.readFile(file, 'utf8')), keys);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    return '';
  }
}

function peekFileValue(file, keys) {
  try {
    return valueFromRows(parseEnvFile(fs.readFileSync(file, 'utf8')), keys);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    return '';
  }
}

/**
 * Read-only resolve: process → current bot → default (allowlist, non-default) → root.
 * Пустая строка в файле не считается заданной.
 */
export async function readEnvKeyChain(key, env = process.env, home = env.HOME || os.homedir()) {
  const fromProcess = processValue(key, env);
  if (fromProcess !== null) return fromProcess;
  const keys = candidateKeys(key);
  for (const file of envFilePathsForKey(key, env, home)) {
    const value = await readFileValue(file, keys);
    if (value) return value;
  }
  return '';
}

/** Sync peek для Claude auth gates; та же цепочка, что у readEnvKeyChain. */
export function peekEnvKeyChain(key, env = process.env, home = env.HOME || os.homedir()) {
  const fromProcess = processValue(key, env);
  if (fromProcess !== null) return fromProcess;
  const keys = candidateKeys(key);
  for (const file of envFilePathsForKey(key, env, home)) {
    const value = peekFileValue(file, keys);
    if (value) return value;
  }
  return '';
}

/** Claude OAuth / Anthropic: process + file inherit без записи на диск. */
export function resolveClaudeCreds(env = process.env, home = env.HOME || os.homedir()) {
  const oauth = peekEnvKeyChain('CLAUDE_CODE_OAUTH_TOKEN', env, home);
  const anthropic = peekEnvKeyChain('ANTHROPIC_API_KEY', env, home)
    || peekEnvKeyChain('MSB_ANTHROPIC_API_KEY', env, home);
  return {
    oauth,
    anthropic,
    ok: Boolean(oauth || anthropic),
  };
}
