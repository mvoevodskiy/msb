import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { monitorDir } from './config.mjs';
import { withFileLock } from '../../shared/file-lock.mjs';

function itemsPath(env) {
  return path.join(monitorDir(env), 'items.jsonl');
}

function metaPath(env) {
  return path.join(monitorDir(env), 'meta.json');
}

export function itemId(sourceType, sourceId, externalId, url) {
  return createHash('sha1')
    .update(`${sourceType}|${sourceId}|${externalId || ''}|${url || ''}`)
    .digest('hex')
    .slice(0, 16);
}

export async function loadMeta(env = process.env) {
  try {
    return JSON.parse(await fs.readFile(metaPath(env), 'utf8'));
  } catch {
    return { lastPollAt: {}, lastDigestAt: null };
  }
}

function serializeMeta(env, operation) {
  return withFileLock(metaPath(env), operation);
}

async function writeMeta(meta, env) {
  await fs.mkdir(monitorDir(env), { recursive: true });
  const file = metaPath(env);
  const tmp = `${file}.tmp.${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`);
  await fs.rename(tmp, file);
}

export function saveMeta(meta, env = process.env) {
  return serializeMeta(env, () => writeMeta(meta, env));
}

// Hold the per-profile queue through the read, action and write. Mutators must
// not call saveMeta/updateMeta themselves; a failed action never saves the mark.
export function updateMeta(mutator, env = process.env) {
  return serializeMeta(env, async () => {
    const meta = await loadMeta(env);
    const result = await mutator(meta);
    await writeMeta(meta, env);
    return result;
  });
}

export async function appendItems(items, env = process.env) {
  if (!items.length) return 0;
  return withFileLock(itemsPath(env), async () => appendItemsLocked(items, env));
}

async function appendItemsLocked(items, env) {
  await fs.mkdir(monitorDir(env), { recursive: true });
  const seen = await loadRecentIds(5000, env);
  let added = 0;
  const lines = [];
  for (const it of items) {
    const id = it.id || itemId(it.sourceType, it.sourceId, it.externalId, it.url);
    if (seen.has(id)) continue;
    seen.add(id);
    lines.push(JSON.stringify({ ...it, id, savedAt: new Date().toISOString() }));
    added += 1;
  }
  if (lines.length) await fs.appendFile(itemsPath(env), `${lines.join('\n')}\n`);
  return added;
}

async function loadRecentIds(limit, env) {
  const set = new Set();
  try {
    const raw = await fs.readFile(itemsPath(env), 'utf8');
    const lines = raw.trim().split('\n');
    for (const line of lines.slice(-limit)) {
      try {
        const o = JSON.parse(line);
        if (o.id) set.add(o.id);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* empty */
  }
  return set;
}

export async function listRecentItems({ limit = 50, sinceHours = 48 } = {}, env = process.env) {
  const since = Date.now() - sinceHours * 3600 * 1000;
  const out = [];
  try {
    const raw = await fs.readFile(itemsPath(env), 'utf8');
    const lines = raw.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        const published = Date.parse(o.publishedAt);
        const saved = Date.parse(o.savedAt);
        const t = Number.isFinite(published) ? published : saved;
        if (!Number.isFinite(t) || t < since) continue;
        out.push({ item: o, timestamp: t, position: i });
      } catch {
        /* skip */
      }
    }
  } catch {
    /* empty */
  }
  out.sort((a, b) => b.timestamp - a.timestamp || b.position - a.position);
  return out.slice(0, Math.max(0, limit)).map((entry) => entry.item);
}
