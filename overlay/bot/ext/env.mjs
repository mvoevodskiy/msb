/**
 * Provider credential file fallback and writes; stock Claude/native Codex keep
 * their existing auth routes. Writes share core [env queue](../shared/env-writes.mjs).
 * Read scopes/empty fallback are unchanged. [Tests](../../../.msb/bot/tests/env-write-order.test.mjs).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getProvider } from './providers.mjs';
import { botDir, msbRoot } from './paths.mjs';
import profile from '../shared/profile.cjs';
import { serializeEnvMutation } from '../shared/env-writes.mjs';

/** Per-bot .env — как у штатного setEnvVar при MSB_BOT_ID. */
export function botEnvPath(env = process.env, home = env.HOME || os.homedir()) {
  return path.join(botDir(env, home), '.env');
}

export function globalEnvPath(home, env = process.env) {
  return path.join(msbRoot(home, env), '.env');
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

function serializeEnv(rows) {
  return rows
    .map((r) => (r.kind === 'kv' ? `${r.key}=${r.value}` : r.text))
    .join('\n')
    .replace(/\n*$/, '\n');
}

export async function readEnvKey(key, env = process.env, home = env.HOME || os.homedir()) {
  const value = profile.envValue(env, key);
  if (value?.trim()) return value.trim();
  if (key.startsWith('MSB_') && value !== undefined) return '';
  const keys = key.startsWith('MSB_') ? [key, `IIA_${key.slice(4)}`] : [key];
  for (const file of [botEnvPath(env, home), globalEnvPath(home, env)]) {
    try {
      const rows = parseEnvFile(await fs.readFile(file, 'utf8'));
      const hit = keys.map(candidate => rows.find(r => r.kind === 'kv' && r.key === candidate)).find(Boolean);
      if (hit?.value?.trim()) return hit.value.trim();
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  return '';
}

export async function writeEnvKey(key, value, env = process.env, home = env.HOME || os.homedir()) {
  const file = botEnvPath(env, home);
  return serializeEnvMutation(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    let rows = [];
    try {
      rows = parseEnvFile(await fs.readFile(file, 'utf8'));
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    const trimmed = String(value).trim();
    const idx = rows.findIndex((r) => r.kind === 'kv' && r.key === key);
    if (idx >= 0) rows[idx].value = trimmed;
    else {
      if (rows.length && rows[rows.length - 1].kind === 'raw' && rows[rows.length - 1].text === '') {
        /* keep */
      } else if (rows.length) rows.push({ kind: 'raw', text: '' });
      rows.push({ kind: 'kv', key, value: trimmed });
    }
    const tmp = `${file}.tmp.${process.pid}`;
    await fs.writeFile(tmp, serializeEnv(rows), { mode: 0o600 });
    await fs.rename(tmp, file);
    profile.setEnvValue(env, key, trimmed);
    return trimmed;
  });
}

export async function providerConfigured(provider, env = process.env, home = env.HOME || os.homedir()) {
  // Codex: штатный ChatGPT login в ~/.codex/auth.json — без копирования токенов в .env
  if (provider.id === 'codex') {
    const { hasNativeCodexAuth } = await import('./codex-native.mjs');
    if (await hasNativeCodexAuth(home)) return true;
  }
  const keys = [provider.envKey, ...(provider.altEnvKeys || [])];
  for (const key of keys) {
    if (await readEnvKey(key, env, home)) return true;
  }
  return false;
}

export async function configuredMap(env = process.env, home = env.HOME || os.homedir()) {
  const { PROVIDERS } = await import('./providers.mjs');
  const out = {};
  for (const p of PROVIDERS) out[p.id] = await providerConfigured(p, env, home);
  return out;
}

export async function saveProviderSecret(providerId, secret, env = process.env, home = env.HOME || os.homedir()) {
  const p = getProvider(providerId);
  if (!p) throw new Error(`unknown provider: ${providerId}`);
  if (p.authViaStock) throw new Error('claude auth goes through stock menu');
  const value = String(secret).trim();
  if (value.length < 8) throw new Error('Ключ слишком короткий.');
  if (/\s/.test(value)) throw new Error('В ключе не должно быть пробелов.');
  await writeEnvKey(p.envKey, value, env, home);
  // Зеркала, которые читают сами CLI
  if (providerId === 'qwen') {
    await writeEnvKey('DASHSCOPE_API_KEY', value, env, home);
  }
  if (providerId === 'codex' && value.startsWith('sk-')) {
    await writeEnvKey('OPENAI_API_KEY', value, env, home);
  }
  return p.envKey;
}
