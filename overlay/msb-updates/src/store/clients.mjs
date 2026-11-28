import path from 'node:path';
import { storePaths } from './paths.mjs';
import { ensureDir, id, nowIso, readJson, writeJsonAtomic } from '../util.mjs';

const BOT_TOKEN_KEYS = new Set(['bot_token', 'botToken', 'BOT_TOKEN']);

export function isTelegramBotToken(value) {
  return /^\d+:[A-Za-z0-9_-]{20,}$/.test(String(value || '').trim());
}

export function createClientStore(dataDir) {
  const p = storePaths(dataDir);

  async function init() {
    await ensureDir(p.clients);
    await ensureDir(p.installations);
  }

  function clientPath(tgUserId) {
    return path.join(p.clients, `${Number(tgUserId)}.json`);
  }

  function installationPath(installationId) {
    return path.join(p.installations, `${installationId}.json`);
  }

  async function getClient(tgUserId) {
    return readJson(clientPath(tgUserId), null);
  }

  async function saveClient(client) {
    client.updated_at = nowIso();
    await writeJsonAtomic(clientPath(client.tg_user_id), client);
    return client;
  }

  async function upsertFromTelegram(from) {
    await init();
    const tgUserId = Number(from.id);
    let client = await getClient(tgUserId);
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || null;
    if (!client) {
      client = {
        tg_user_id: tgUserId,
        username: from.username || null,
        name,
        created_at: nowIso(),
        updated_at: nowIso(),
        platform_accounts: [],
      };
    } else {
      client.username = from.username || client.username || null;
      client.name = name || client.name || null;
    }
    return saveClient(client);
  }

  async function savePlatformToken(tgUserId, { provider, token }) {
    const raw = String(token || '').trim();
    if (!raw || /\s/.test(raw)) throw Object.assign(new Error('bad platform token'), { code: 'bad_platform_token' });
    if (isTelegramBotToken(raw)) {
      throw Object.assign(new Error('telegram bot token is not a platform token'), { code: 'bot_token_refused' });
    }
    const client = await getClient(tgUserId);
    if (!client) throw Object.assign(new Error('unknown client'), { code: 'unknown_client' });
    const existing = (client.platform_accounts || []).find((item) => item.provider === provider && item.token === raw);
    if (existing) return existing;
    const account = {
      id: id('acct'),
      provider,
      token: raw,
      created_at: nowIso(),
    };
    client.platform_accounts = [...(client.platform_accounts || []), account];
    await saveClient(client);
    return account;
  }

  async function getPlatformAccount(tgUserId, accountId) {
    const client = await getClient(tgUserId);
    if (!client) return null;
    return (client.platform_accounts || []).find((item) => item.id === accountId) || null;
  }

  function assertNoBotToken(input) {
    for (const key of Object.keys(input || {})) {
      if (BOT_TOKEN_KEYS.has(key)) {
        throw Object.assign(new Error('bot token must not be stored'), { code: 'bot_token_refused' });
      }
    }
  }

  async function createInstallation(input) {
    await init();
    assertNoBotToken(input);
    const rec = {
      id: id('srv'),
      owner_tg_user_id: Number(input.owner_tg_user_id),
      owner_username: input.owner_username || null,
      owner_name: input.owner_name || null,
      origin: input.origin,
      provider: input.provider || null,
      provider_server_id: input.provider_server_id || null,
      platform_account_id: input.platform_account_id || null,
      name: input.name || null,
      host: input.host || null,
      port: input.port || 22,
      ssh_user: input.ssh_user || 'root',
      admin_user: 'msb-admin',
      admin_key_installed: false,
      status: input.status || 'creating',
      error: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    await saveInstallation(rec);
    return rec;
  }

  async function getInstallation(installationId) {
    return readJson(installationPath(installationId), null);
  }

  async function saveInstallation(rec) {
    assertNoBotToken(rec);
    rec.updated_at = nowIso();
    await writeJsonAtomic(installationPath(rec.id), rec);
    return rec;
  }

  async function updateInstallation(installationId, patch) {
    const rec = await getInstallation(installationId);
    if (!rec) return null;
    assertNoBotToken(patch);
    Object.assign(rec, patch);
    return saveInstallation(rec);
  }

  async function listInstallations() {
    await init();
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(p.installations);
    const all = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const rec = await readJson(path.join(p.installations, name), null);
      if (rec) all.push(rec);
    }
    all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return all;
  }

  return {
    init,
    upsertFromTelegram,
    savePlatformToken,
    getPlatformAccount,
    createInstallation,
    getInstallation,
    saveInstallation,
    updateInstallation,
    listInstallations,
  };
}

export function ownerLabel(rec) {
  const parts = [rec.owner_name, rec.owner_username ? `@${rec.owner_username}` : '', rec.owner_tg_user_id];
  return parts.filter(Boolean).join(' ');
}

export function publicInstallation(rec) {
  if (!rec) return null;
  return {
    id: rec.id,
    owner_tg_user_id: rec.owner_tg_user_id,
    owner_username: rec.owner_username,
    owner_name: rec.owner_name,
    origin: rec.origin,
    provider: rec.provider,
    provider_server_id: rec.provider_server_id,
    name: rec.name,
    host: rec.host,
    port: rec.port,
    ssh_user: rec.ssh_user,
    admin_user: rec.admin_user,
    admin_key_installed: rec.admin_key_installed,
    status: rec.status,
    error: rec.error,
    created_at: rec.created_at,
  };
}
