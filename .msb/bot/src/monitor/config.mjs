/**
 * Конфигурация источников мониторинга и короткие транзакции изменений.
 * Вход: Telegram forms/routes; сбор и merge статусов → poll.mjs.
 * X identity/callback → source-ref.mjs; проверки → monitor-twitter-legacy.test.mjs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { msbRoot } from '../paths.mjs';
import { withFileLock } from '../../shared/file-lock.mjs';
import { sourceToken, twitterAliases, twitterIdentity } from './source-ref.mjs';

export function monitorDir(env = process.env) {
  return path.join(msbRoot(env), 'monitor');
}

function configPath(env = process.env) {
  return path.join(monitorDir(env), 'config.json');
}

export function defaultConfig() {
  return {
    youtube: { enabled: false, pollIntervalMinutes: 30, channels: [], processing: { transcribe: false, maxVideoMinutes: 120 } },
    twitter: { enabled: false, pollIntervalMinutes: 15, accounts: [] },
    github: { enabled: false, pollIntervalMinutes: 60, repos: [] },
    telegram: { enabled: false, pollIntervalMinutes: 30, channels: [] },
    rss: { enabled: false, pollIntervalMinutes: 60, feeds: [] },
    digest: { enabled: true, hour: 9, topN: 10, target: 'owner' },
    retention: { keepDays: 30, maxDiskMb: 500 },
    storage: process.env.MONITOR_STORAGE || 'jsonl',
    scoringModel: null,
    notifications: { enabled: true, mode: 'all' },
  };
}

export async function loadMonitorConfig(env = process.env) {
  const base = defaultConfig();
  try {
    const raw = await fs.readFile(configPath(env), 'utf8');
    const Q = JSON.parse(raw);
    return {
      ...base,
      ...Q,
      youtube: { ...base.youtube, ...Q.youtube },
      twitter: { ...base.twitter, ...Q.twitter },
      github: { ...base.github, ...Q.github },
      telegram: { ...base.telegram, ...Q.telegram },
      rss: { ...base.rss, ...Q.rss },
      digest: { ...base.digest, ...Q.digest },
      retention: { ...base.retention, ...Q.retention },
      notifications: { ...base.notifications, ...Q.notifications },
    };
  } catch (err) {
    if (err?.code === 'ENOENT') return base;
    throw err;
  }
}

async function writeMonitorConfig(cfg, env) {
  const dir = monitorDir(env);
  await fs.mkdir(dir, { recursive: true });
  const file = configPath(env);
  const tmp = `${file}.tmp.${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  await fs.rename(tmp, file);
}

export function saveMonitorConfig(cfg, env = process.env) {
  return withFileLock(configPath(env), () => writeMonitorConfig(cfg, env));
}

// Network requests must stay outside this short read/modify/write transaction.
export function updateMonitorConfig(change, env = process.env) {
  return withFileLock(configPath(env), async () => {
    const cfg = await loadMonitorConfig(env);
    const result = await change(cfg);
    await writeMonitorConfig(cfg, env);
    return result;
  });
}

/** Разбор ссылки / @ника → тип источника. */
export function classifySourceInput(raw, { type } = {}) {
  const text = String(raw || '').trim();
  if (!text) return null;

  // RSS / Atom явный
  if (/\.(xml|rss|atom)(\?|$)/i.test(text) || /\/feed\/?$/i.test(text) || /\/atom\/?$/i.test(text)) {
    return { type: 'rss', url: text, name: text };
  }

  // YouTube
  let m = text.match(/(?:youtube\.com\/(?:channel\/|c\/|@)|youtu\.be\/)([^\s/?]+)/i);
  if (m) {
    const id = m[1];
    if (text.includes('/channel/')) return { type: 'youtube', channelId: id, name: id };
    return { type: 'youtube', handle: id.replace(/^@/, ''), name: id };
  }
  if (/^UC[\w-]{20,}$/.test(text)) return { type: 'youtube', channelId: text, name: text };

  // GitHub
  m = text.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (m) return { type: 'github', owner: m[1], repo: m[2].replace(/\.git$/, ''), name: `${m[1]}/${m[2]}` };
  if (/^[\w.-]+\/[\w.-]+$/.test(text) && !text.startsWith('@')) {
    return { type: 'github', owner: text.split('/')[0], repo: text.split('/')[1], name: text };
  }

  // Twitter / X
  m = text.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)/i);
  if (m) return { type: 'twitter', username: m[1], name: `@${m[1]}` };
  // The same handle can belong to Telegram or X. Old UI asks the owner.
  if (/^@[A-Za-z0-9_]{2,64}$/.test(text)) {
    if (type === 'telegram' || type === 'twitter') return { type, username: text.slice(1), name: text };
    return { type: 'ambiguous', username: text.slice(1), name: text };
  }
  // Preserve the new core's existing single-character X handle support.
  if (/^@[A-Za-z0-9_]$/.test(text)) return { type: 'twitter', username: text.slice(1), name: text };

  // Telegram
  m = text.match(/(?:t\.me|telegram\.me)\/([A-Za-z0-9_]+)/i);
  if (m) return { type: 'telegram', username: m[1], name: `@${m[1]}` };

  // bare URL → rss attempt
  if (/^https?:\/\//i.test(text)) return { type: 'rss', url: text, name: text };

  return null;
}

export async function addSourceFromInput(raw, env = process.env, { type } = {}) {
  const parsed = classifySourceInput(raw, { type });
  if (parsed?.type === 'ambiguous') return { ok: false, needsChoice: true, value: parsed.name };
  if (!parsed) return { ok: false, error: 'Не понял источник. Пришли URL или @ник (YouTube, GitHub, X, Telegram, RSS).' };

  const now = new Date().toISOString();
  return updateMonitorConfig(async (cfg) => {
    if (parsed.type === 'youtube') {
      let matches = cfg.youtube.channels.filter((c) =>
        (parsed.channelId && c.channelId === parsed.channelId) ||
        (parsed.handle && (c.handle === parsed.handle || c.channelId === `handle:${parsed.handle}`)),
      );
      // Preserve the existing handle-by-name fallback for legacy records. It
      // is not proof of identity; resolving handles like the old core is a
      // separate, documented follow-up. Never use it for a concrete ID.
      if (!matches.length && parsed.handle) {
        matches = cfg.youtube.channels.filter((c) => c.name === parsed.name);
      }
      if (matches.length > 1) {
        return { ok: false, error: `Найдено несколько записей YouTube для ${parsed.name}. Проверь список источников.` };
      }
      const exists = matches[0];
      if (exists) {
        const name = exists.name || parsed.name;
        if (exists.enabled === false) {
          exists.enabled = true;
          return { ok: true, added: true, reason: 're-enabled', type: 'youtube', name };
        }
        return { ok: true, added: false, type: 'youtube', name };
      }
      cfg.youtube.channels.push({
        channelId: parsed.channelId || null,
        handle: parsed.handle || null,
        name: parsed.name,
        enabled: true,
        addedAt: now,
      });
      cfg.youtube.enabled = true;
      return { ok: true, added: true, type: 'youtube', name: parsed.name };
    }

    if (parsed.type === 'twitter') {
      const u = parsed.username.toLowerCase();
      const matches = cfg.twitter.accounts.filter((a) => twitterAliases(a).some((alias) => alias.toLowerCase() === u));
      if (matches.length > 1 || (matches.length === 1 && !twitterIdentity(matches[0]))) {
        return { ok: false, error: `Найдены неоднозначные записи Twitter для ${parsed.name}. Проверь список источников.` };
      }
      const existing = matches[0];
      if (existing) {
        if (existing.enabled === false) {
          existing.enabled = true;
          return { ok: true, added: true, reason: 're-enabled', type: 'twitter', name: parsed.name };
        }
        return { ok: true, added: false, type: 'twitter', name: parsed.name };
      }
      cfg.twitter.accounts.push({ username: parsed.username, name: parsed.name, enabled: true, addedAt: now });
      cfg.twitter.enabled = true;
      return { ok: true, added: true, type: 'twitter', name: parsed.name };
    }

    if (parsed.type === 'github') {
      const full = `${parsed.owner}/${parsed.repo}`;
      const matches = cfg.github.repos.filter((r) => `${r.owner}/${r.repo}`.toLowerCase() === full.toLowerCase());
      // Older open-core could create case-variant duplicates. Do not change
      // an arbitrary record or claim a disabled source is already active.
      if (matches.length > 1) {
        return { ok: false, error: `Найдено несколько записей GitHub для ${full}. Проверь список источников.` };
      }
      if (matches.length) {
        if (matches[0].enabled === false) {
          matches[0].enabled = true;
          return { ok: true, added: true, reason: 're-enabled', type: 'github', name: full };
        }
        return { ok: true, added: false, type: 'github', name: full };
      }
      cfg.github.repos.push({ owner: parsed.owner, repo: parsed.repo, name: full, enabled: true, addedAt: now });
      cfg.github.enabled = true;
      return { ok: true, added: true, type: 'github', name: full };
    }

    if (parsed.type === 'telegram') {
      const u = parsed.username.toLowerCase();
      if (cfg.telegram.channels.some((c) => c.username.toLowerCase() === u)) {
        return { ok: true, added: false, type: 'telegram', name: parsed.name };
      }
      cfg.telegram.channels.push({ username: parsed.username, name: parsed.name, enabled: true, addedAt: now });
      cfg.telegram.enabled = true;
      return { ok: true, added: true, type: 'telegram', name: parsed.name };
    }

    if (parsed.type === 'rss') {
      if (cfg.rss.feeds.some((f) => f.url === parsed.url)) {
        return { ok: true, added: false, type: 'rss', name: parsed.name };
      }
      cfg.rss.feeds.push({ url: parsed.url, name: parsed.name, enabled: true, addedAt: now });
      cfg.rss.enabled = true;
      return { ok: true, added: true, type: 'rss', name: parsed.name };
    }

    return { ok: false, error: 'Неизвестный тип' };
  }, env);
}

export async function removeSource(type, id, env = process.env, { byToken = false } = {}) {
  return updateMonitorConfig((cfg) => {
    const mark = (arr, pred) => {
      const matches = arr.flatMap((entry, index) => pred(entry) ? [index] : []);
      // Old ID callbacks keep their prior first-match behavior. Token callbacks
      // must resolve uniquely so a stale button cannot remove a different source.
      if (!matches.length || (byToken && matches.length !== 1)) return false;
      arr.splice(matches[0], 1);
      return true;
    };
    const tokenMatches = (aliases) => aliases.filter((alias) => typeof alias === 'string' && alias)
      .some((alias) => sourceToken(type, alias) === id);
    let ok = false;
    if (type === 'youtube') {
      ok = mark(cfg.youtube.channels, (c) => byToken ? tokenMatches([c.channelId, c.handle, c.name]) : c.channelId === id || c.handle === id || c.name === id);
      if (!cfg.youtube.channels.length) cfg.youtube.enabled = false;
    } else if (type === 'twitter') {
      // A previously rendered legacy button could encode a missing X id as
      // the string 'undefined'. Only fresh token buttons can remove that name.
      if (!byToken && (typeof id !== 'string' || id === 'undefined')) return false;
      const matches = cfg.twitter.accounts.filter((a) => byToken
        ? tokenMatches(twitterAliases(a))
        : twitterAliases(a).some((alias) => alias.toLowerCase() === id.toLowerCase()));
      const identity = matches.length === 1 ? twitterIdentity(matches[0]) : null;
      const collisions = identity && cfg.twitter.accounts.filter((a) =>
        twitterAliases(a).some((alias) => alias.toLowerCase() === identity.toLowerCase()));
      if (identity && collisions.length === 1) {
        cfg.twitter.accounts.splice(cfg.twitter.accounts.indexOf(matches[0]), 1);
        ok = true;
      } else if (byToken && !matches.length) {
        // Malformed rows have no safe account identity. A token of the entire
        // unchanged row allows explicit deletion without selecting a neighbor.
        const malformed = cfg.twitter.accounts.filter((a) => !twitterIdentity(a) &&
          sourceToken('twitter-invalid', JSON.stringify(a)) === id);
        const signature = (a) => JSON.stringify(twitterAliases(a).map((alias) => alias.toLowerCase()));
        const indistinguishable = malformed.length === 1 && cfg.twitter.accounts.filter((a) =>
          !twitterIdentity(a) && signature(a) === signature(malformed[0]));
        if (malformed.length === 1 && indistinguishable.length === 1) {
          cfg.twitter.accounts.splice(cfg.twitter.accounts.indexOf(malformed[0]), 1);
          ok = true;
        }
      }
      if (!cfg.twitter.accounts.length) cfg.twitter.enabled = false;
    } else if (type === 'github') {
      ok = mark(cfg.github.repos, (r) => byToken ? tokenMatches([`${r.owner}/${r.repo}`]) : `${r.owner}/${r.repo}` === id || r.name === id);
      if (!cfg.github.repos.length) cfg.github.enabled = false;
    } else if (type === 'telegram') {
      ok = mark(cfg.telegram.channels, (c) => byToken ? tokenMatches([c.username]) : c.username === id);
      if (!cfg.telegram.channels.length) cfg.telegram.enabled = false;
    } else if (type === 'rss') {
      ok = mark(cfg.rss.feeds, (f) => byToken ? tokenMatches([f.url]) : f.url === id || f.name === id);
      if (!cfg.rss.feeds.length) cfg.rss.enabled = false;
    }
    return ok;
  }, env);
}

export function listSourcesFlat(cfg) {
  const out = [];
  for (const c of cfg.youtube.channels || []) {
    out.push({ type: 'youtube', id: c.channelId || c.handle || c.name, name: c.name, enabled: c.enabled !== false });
  }
  let invalidTwitter = 0;
  for (const a of cfg.twitter.accounts || []) {
    const id = twitterIdentity(a);
    const invalidToken = id ? null : sourceToken('twitter-invalid', JSON.stringify(a));
    const invalidName = id ? null : `⚠️ ${++invalidTwitter}: ${twitterAliases(a).map((alias) => `@${alias}`).join(' / ') || 'Некорректный источник X'}`;
    out.push({ type: 'twitter', id, name: id ? (a?.name || `@${id}`) : invalidName,
      enabled: a?.enabled !== false, invalid: !id, ...(!id ? { invalidToken } : {}) });
  }
  for (const r of cfg.github.repos || []) {
    out.push({ type: 'github', id: `${r.owner}/${r.repo}`, name: r.name || `${r.owner}/${r.repo}`, enabled: r.enabled !== false });
  }
  for (const c of cfg.telegram.channels || []) {
    out.push({ type: 'telegram', id: c.username, name: c.name || `@${c.username}`, enabled: c.enabled !== false });
  }
  for (const f of cfg.rss.feeds || []) {
    out.push({ type: 'rss', id: f.url, name: f.name || f.url, enabled: f.enabled !== false });
  }
  return out;
}
