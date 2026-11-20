import path from 'node:path';
import { storePaths } from './paths.mjs';
import { ensureDir, id, nowIso, randomToken, readJson, sha256Hex, writeJsonAtomic } from '../util.mjs';

const ALL_SCOPES = new Set([
  'core:read', 'ext:read', 'core:publish', 'ext:publish',
  'install:empty', 'install:ext', 'web:open', 'claim:create',
]);

export function createAuthStore(dataDir) {
  const p = storePaths(dataDir);

  async function init() {
    await ensureDir(p.tokens);
    await ensureDir(p.users);
    await ensureDir(p.webLinks);
  }

  async function ensureUser(tgUserId) {
    const file = path.join(p.users, `${tgUserId}.json`);
    let user = await readJson(file, null);
    if (!user) {
      user = { tg_user_id: Number(tgUserId), created_at: nowIso(), token_ids: [], boxes: [] };
      await writeJsonAtomic(file, user);
    }
    return user;
  }

  async function saveUser(user) {
    await writeJsonAtomic(path.join(p.users, `${user.tg_user_id}.json`), user);
  }

  async function issueToken({ tgUserId, kind, scopes, boxId = null, expiresAt = null }) {
    await init();
    for (const s of scopes) {
      if (!ALL_SCOPES.has(s)) throw new Error(`unknown scope: ${s}`);
    }
    const plaintext = randomToken(32);
    const tokenId = id('tok');
    const meta = {
      token_id: tokenId,
      token_hash: `sha256:${sha256Hex(plaintext)}`,
      tg_user_id: Number(tgUserId),
      kind,
      scopes: [...scopes],
      box_id: boxId,
      created_at: nowIso(),
      expires_at: expiresAt,
      revoked_at: null,
      last_used_at: null,
    };
    await writeJsonAtomic(path.join(p.tokens, `${tokenId}.json`), meta);
    const user = await ensureUser(tgUserId);
    user.token_ids = [...new Set([...(user.token_ids || []), tokenId])];
    await saveUser(user);
    return { token: plaintext, meta };
  }

  async function listTokens(tgUserId) {
    const user = await ensureUser(tgUserId);
    const out = [];
    for (const tid of user.token_ids || []) {
      const meta = await readJson(path.join(p.tokens, `${tid}.json`), null);
      if (meta) out.push(sanitizeMeta(meta));
    }
    return out;
  }

  async function revoke(tokenId) {
    const file = path.join(p.tokens, `${tokenId}.json`);
    const meta = await readJson(file, null);
    if (!meta) return null;
    meta.revoked_at = nowIso();
    await writeJsonAtomic(file, meta);
    return sanitizeMeta(meta);
  }

  async function resolveBearer(bearer) {
    if (!bearer) return null;
    const hash = `sha256:${sha256Hex(bearer)}`;
    // linear scan — OK for small fleets; index later if needed
    const { readdir } = await import('node:fs/promises');
    let names;
    try {
      names = await readdir(p.tokens);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const meta = await readJson(path.join(p.tokens, name), null);
      if (!meta || meta.token_hash !== hash) continue;
      if (meta.revoked_at) return null;
      if (meta.expires_at && Date.parse(meta.expires_at) < Date.now()) return null;
      meta.last_used_at = nowIso();
      await writeJsonAtomic(path.join(p.tokens, name), meta);
      return meta;
    }
    return null;
  }

  function hasScope(meta, scope) {
    return !!(meta && Array.isArray(meta.scopes) && meta.scopes.includes(scope));
  }

  async function createWebLink({ tgUserId, ttlSec = 900, scopes = null }) {
    await init();
    const linkId = id('web');
    const secret = randomToken(24);
    const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
    const rec = {
      link_id: linkId,
      secret_hash: `sha256:${sha256Hex(secret)}`,
      tg_user_id: Number(tgUserId),
      scopes: scopes || ['core:read', 'ext:read', 'install:ext', 'install:empty', 'web:open'],
      created_at: nowIso(),
      expires_at: expiresAt,
      used_at: null,
    };
    await writeJsonAtomic(path.join(p.webLinks, `${linkId}.json`), rec);
    return { link_id: linkId, secret, expires_at: expiresAt, token: `${linkId}.${secret}` };
  }

  async function redeemWebLink(combined) {
    const [linkId, secret] = String(combined || '').split('.');
    if (!linkId || !secret) return null;
    const file = path.join(p.webLinks, `${linkId}.json`);
    const rec = await readJson(file, null);
    if (!rec) return null;
    if (rec.used_at) return null;
    if (Date.parse(rec.expires_at) < Date.now()) return null;
    if (rec.secret_hash !== `sha256:${sha256Hex(secret)}`) return null;
    rec.used_at = nowIso();
    await writeJsonAtomic(file, rec);
    // session token
    return issueToken({
      tgUserId: rec.tg_user_id,
      kind: 'web_session',
      scopes: rec.scopes,
      expiresAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
    });
  }

  async function bindBox(tgUserId, boxId) {
    const user = await ensureUser(tgUserId);
    user.boxes = [...new Set([...(user.boxes || []), boxId])];
    await saveUser(user);
    return user;
  }

  return {
    init, issueToken, listTokens, revoke, resolveBearer, hasScope,
    createWebLink, redeemWebLink, ensureUser, bindBox, ALL_SCOPES,
  };
}

function sanitizeMeta(meta) {
  const { token_hash, ...rest } = meta;
  return rest;
}
