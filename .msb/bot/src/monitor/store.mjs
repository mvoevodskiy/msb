/**
 * JSONL items and separate monitor metadata: poll and digest → shared store.
 * Paths/config: [config](./config.mjs).
 * Checks: [meta integrity](../../tests/monitor-meta-integrity.test.mjs),
 * [JSONL append boundaries](../../tests/monitor-jsonl-append.test.mjs),
 * [Telegram legacy repairs](../../tests/monitor-telegram-repair.test.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { monitorDir } from './config.mjs';
import { withFileLock } from '../../shared/file-lock.mjs';
import { physicalFilePath } from '../../shared/physical-file-path.mjs';

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

// Read-only screens keep their empty fallback; writes must not replace an
// unreadable, corrupt or non-object file with a newly fabricated state.
// See [integrity regression](../../tests/monitor-meta-integrity.test.mjs).
export async function loadMeta(env = process.env, { forUpdate = false } = {}) {
  try {
    const meta = JSON.parse(await fs.readFile(metaPath(env), 'utf8'));
    if (forUpdate && (!meta || typeof meta !== 'object' || Array.isArray(meta))) {
      throw new TypeError('Monitor metadata must be an object');
    }
    return meta;
  } catch (error) {
    if (forUpdate && error?.code !== 'ENOENT') throw error;
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
    const meta = await loadMeta(env, { forUpdate: true });
    const result = await mutator(meta);
    await writeMeta(meta, env);
    return result;
  });
}

export async function appendItems(items, env = process.env) {
  if (!items.length) return 0;
  const logical = itemsPath(env);
  const file = await physicalFilePath(logical);
  return withFileLock(file, async () => {
    if (await physicalFilePath(logical) !== file) throw new Error('Monitor items target changed');
    return appendItemsLocked(items, file);
  });
}

async function appendItemsLocked(items, file) {
  const verifiedPosts = new Map();
  for (const item of items) {
    if (item.sourceType === 'telegram' && item.telegramPostVerified === true && !verifiedPosts.has(item.id)) {
      verifiedPosts.set(item.id, item);
    }
  }

  let raw;
  try {
    raw = await fs.readFile(file);
  } catch (error) {
    if (verifiedPosts.size && error.code !== 'ENOENT') throw error;
    raw = Buffer.alloc(0);
  }
  const { seen, repairs } = inspectAppendHistory(raw, verifiedPosts);
  let added = 0;
  const lines = [];
  for (const it of items) {
    const id = it.id || itemId(it.sourceType, it.sourceId, it.externalId, it.url);
    if (seen.has(id)) continue;
    seen.add(id);
    lines.push(JSON.stringify({ ...it, id, savedAt: new Date().toISOString() }));
    added += 1;
  }
  const separator = raw.length > 0 && raw.at(-1) !== 10 ? '\n' : '';
  const appended = lines.length ? `${separator}${lines.join('\n')}\n` : '';
  if (repairs.length) {
    await replaceItemsFile(file, replacementParts(raw, repairs, appended));
  } else if (appended) {
    await fs.appendFile(file, appended);
  }
  return added;
}

function inspectAppendHistory(raw, verifiedPosts) {
  const seen = new Set();
  const repairs = [];
  const recentLimit = 5000;

  // Ignore trailing blank lines as before. Walk the recent window once, then
  // continue further only for fetched Telegram identities still unresolved.
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === 32 || (raw[end - 1] >= 9 && raw[end - 1] <= 13))) end--;
  for (let count = 0; end > 0 && (count < recentLimit || verifiedPosts.size); count++) {
    const start = raw.lastIndexOf(10, end - 1) + 1;
    const rowEnd = raw[end - 1] === 13 ? end - 1 : end;
    end = start - 1;
    let stored;
    try {
      stored = JSON.parse(raw.toString('utf8', start, rowEnd));
    } catch {
      continue;
    }
    if (count < recentLimit && stored?.id) seen.add(stored.id);

    const fresh = verifiedPosts.get(stored?.id);
    if (!fresh || stored.sourceType !== 'telegram' || stored.sourceId !== fresh.sourceId
      || stored.url !== fresh.url || stored.externalId !== fresh.externalId) continue;
    verifiedPosts.delete(stored.id);
    seen.add(stored.id);
    // Once verified, keep the usual first-snapshot semantics of collection.
    if (stored.telegramPostVerified === true) continue;
    const { title, summary, publishedAt } = fresh;
    const corrected = { ...stored, title, summary, publishedAt, telegramPostVerified: true };
    repairs.push({ start, end: rowEnd, bytes: Buffer.from(JSON.stringify(corrected)) });
  }
  return { seen, repairs };
}

// Yield untouched segments byte-for-byte, including malformed or incomplete
// lines. Write the segments directly to avoid a copy of the whole journal.
function* replacementParts(raw, repairs, appended) {
  let start = 0;
  for (const { start: rowStart, end, bytes } of repairs.reverse()) {
    yield raw.subarray(start, rowStart);
    yield bytes;
    start = end;
  }
  yield raw.subarray(start);
  if (appended) yield Buffer.from(appended);
}

async function replaceItemsFile(file, parts) {
  const mode = (await fs.stat(file)).mode & 0o777;
  const temp = `${file}.tmp.${randomUUID()}`;
  try {
    await fs.writeFile(temp, parts, { mode: 0o600, flag: 'wx' });
    await fs.chmod(temp, mode);
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export async function listRecentItems({ limit = 50, sinceHours = 48 } = {}, env = process.env) {
  const since = Date.now() - sinceHours * 3600 * 1000;
  const out = [];
  const verifiedTelegram = new Set();
  try {
    const raw = await fs.readFile(itemsPath(env), 'utf8');
    const lines = raw.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        if (o.sourceType === 'telegram' && o.id) {
          // Old journals can contain repeated IDs beyond the append window.
          // In newest-first order a verified snapshot supersedes those copies.
          const key = JSON.stringify([o.id, o.sourceId, o.externalId, o.url]);
          if (verifiedTelegram.has(key)) continue;
          if (o.telegramPostVerified === true) verifiedTelegram.add(key);
        }
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
