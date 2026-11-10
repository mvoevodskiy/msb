import path from 'node:path';
import { storePaths } from './paths.mjs';
import { ensureDir, id, nowIso, readJson, writeJsonAtomic } from '../util.mjs';

export function createIntentStore(dataDir) {
  const p = storePaths(dataDir);

  async function init() {
    await ensureDir(p.intents);
  }

  async function create(input) {
    await init();
    const intentId = id('intent');
    const rec = {
      id: intentId,
      type: input.type,
      tg_user_id: Number(input.tg_user_id),
      host: input.host || null,
      port: input.port || 22,
      ssh_user: input.ssh_user || 'client',
      status: 'awaiting_ssh',
      created_at: nowIso(),
      updated_at: nowIso(),
      log: [],
      result: null,
      error: null,
      box_id: null,
      core_version: null,
      ext_version: null,
    };
    await save(rec);
    return rec;
  }

  async function get(intentId) {
    return readJson(path.join(p.intents, `${intentId}.json`), null);
  }

  async function save(rec) {
    rec.updated_at = nowIso();
    await writeJsonAtomic(path.join(p.intents, `${rec.id}.json`), rec);
    return rec;
  }

  async function appendLog(intentId, line) {
    const rec = await get(intentId);
    if (!rec) return null;
    rec.log.push({ at: nowIso(), line: String(line).slice(0, 2000) });
    if (rec.log.length > 200) rec.log = rec.log.slice(-200);
    return save(rec);
  }

  async function setStatus(intentId, status, patch = {}) {
    const rec = await get(intentId);
    if (!rec) return null;
    Object.assign(rec, patch, { status });
    return save(rec);
  }

  async function listByUser(tgUserId, limit = 20) {
    await init();
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(p.intents);
    const all = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const rec = await readJson(path.join(p.intents, name), null);
      if (rec && rec.tg_user_id === Number(tgUserId)) all.push(rec);
    }
    all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return all.slice(0, limit);
  }

  async function listPending(limit = 50) {
    await init();
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(p.intents);
    const all = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const rec = await readJson(path.join(p.intents, name), null);
      if (rec && ['awaiting_ssh', 'probing', 'applying', 'queued'].includes(rec.status) && rec.host) {
        all.push(rec);
      }
    }
    all.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return all.slice(0, limit);
  }

  return { init, create, get, save, appendLog, setStatus, listByUser, listPending };
}
