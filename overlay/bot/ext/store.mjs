import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PROVIDER, isProviderId } from './providers.mjs';
import { botDir } from './paths.mjs';
import { withStoreLock } from './store-lock.mjs';

const STORE_NAME = 'ext-providers.json';

export function storePath(env = process.env, home = env.HOME || os.homedir()) {
  return path.join(botDir(env, home), STORE_NAME);
}

function emptyStore() {
  return {
    version: 1,
    active: DEFAULT_PROVIDER,
    sessions: {},
    models: {},
    efforts: {},
    updatedAt: null,
  };
}

export async function loadStore(env = process.env, home = env.HOME || os.homedir()) {
  const file = storePath(env, home);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return emptyStore();
    const active = isProviderId(data.active) ? data.active : DEFAULT_PROVIDER;
    return {
      version: 1,
      active,
      sessions: data.sessions && typeof data.sessions === 'object' ? data.sessions : {},
      models: data.models && typeof data.models === 'object' ? data.models : {},
      efforts: data.efforts && typeof data.efforts === 'object' ? data.efforts : {},
      updatedAt: data.updatedAt ?? null,
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyStore();
    throw err;
  }
}

async function writeStore(store, env, home, commit = publish => publish()) {
  const file = storePath(env, home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const next = {
    version: 1,
    active: isProviderId(store.active) ? store.active : DEFAULT_PROVIDER,
    sessions: store.sessions && typeof store.sessions === 'object' ? store.sessions : {},
    models: store.models && typeof store.models === 'object' ? store.models : {},
    efforts: store.efforts && typeof store.efforts === 'object' ? store.efforts : {},
    updatedAt: new Date().toISOString(),
  };
  const tmp = file + '.tmp.' + randomUUID();
  try {
    await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await commit(() => fs.rename(tmp, file));
    return next;
  } finally {
    await fs.unlink(tmp).catch(error => {
      if (error?.code !== 'ENOENT') console.error('[msb/ext] could not clean staged store:', error.code || error.name);
    });
  }
}

/** Replace a complete snapshot; incremental callers must use the atomic setters. */
export async function saveStore(store, env = process.env, home = env.HOME || os.homedir()) {
  return withStoreLock(storePath(env, home), () => writeStore(store, env, home));
}

function updateStore(env, home, change, commit) {
  return withStoreLock(storePath(env, home), async () => {
    const store = await loadStore(env, home);
    change(store);
    return writeStore(store, env, home, commit);
  });
}

export async function setActive(providerId, env = process.env, home = env.HOME || os.homedir()) {
  if (!isProviderId(providerId)) throw new Error(`unknown provider: ${providerId}`);
  return updateStore(env, home, store => { store.active = providerId; });
}

export async function setSession(providerId, sessionId, env = process.env, home = env.HOME || os.homedir()) {
  if (!isProviderId(providerId)) throw new Error(`unknown provider: ${providerId}`);
  return updateStore(env, home, store => {
    if (!sessionId) delete store.sessions[providerId];
    else store.sessions[providerId] = String(sessionId);
  });
}

export async function getSelectedModel(providerId, env = process.env, home = env.HOME || os.homedir()) {
  const store = await loadStore(env, home);
  const id = store.models?.[providerId];
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

export async function setSelectedModel(providerId, modelId, env = process.env, home = env.HOME || os.homedir(), { commit } = {}) {
  if (!isProviderId(providerId)) throw new Error(`unknown provider: ${providerId}`);
  return updateStore(env, home, store => {
    if (!store.models || typeof store.models !== 'object') store.models = {};
    if (!modelId) delete store.models[providerId];
    else store.models[providerId] = String(modelId).trim();
  }, commit);
}

export async function getSelectedEffort(providerId, env = process.env, home = env.HOME || os.homedir()) {
  const store = await loadStore(env, home);
  const id = store.efforts?.[providerId];
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

export async function setSelectedEffort(providerId, effort, env = process.env, home = env.HOME || os.homedir(), { commit } = {}) {
  if (!isProviderId(providerId)) throw new Error(`unknown provider: ${providerId}`);
  return updateStore(env, home, store => {
    if (!store.efforts || typeof store.efforts !== 'object') store.efforts = {};
    if (!effort) delete store.efforts[providerId];
    else store.efforts[providerId] = String(effort).trim();
  }, commit);
}

export function encodeExtSession(providerId, nativeId) {
  return `ext:${providerId}:${nativeId || cryptoRandom()}`;
}

export function decodeExtSession(sessionId) {
  if (typeof sessionId !== 'string') return null;
  const m = /^ext:([a-z]+):(.+)$/.exec(sessionId);
  if (!m) return null;
  if (!isProviderId(m[1])) return null;
  return { providerId: m[1], nativeId: m[2] };
}

function cryptoRandom() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
