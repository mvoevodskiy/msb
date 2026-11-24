/**
 * Сбор источников мониторинга (RSS / YouTube RSS / GitHub Atom / TG public / X).
 * Навигация: [Мониторинг](./README.md) → [storage](./store.mjs), [digest](./digest.mjs).
 * Public Telegram widgets → [telegram-public](./telegram-public.mjs).
 * X handle/username → [source-ref](./source-ref.mjs); merge учитывает снимок строки.
 * Проверки: [source snapshots](../../tests/monitor-source-snapshot.test.mjs),
 * [legacy X](../../tests/monitor-twitter-legacy.test.mjs),
 * [latest successful poll](../../tests/monitor-last-poll.test.mjs),
 * [scheduled intervals](../../tests/monitor-interval-scheduler.test.mjs).
 */
import { isDeepStrictEqual } from 'node:util';
import { loadMonitorConfig, updateMonitorConfig } from './config.mjs';
import { twitterIdentity } from './source-ref.mjs';
import { readPublicPosts } from './telegram-public.mjs';
import { appendItems, itemId, loadMeta, updateMeta } from './store.mjs';
import { botId } from '../paths.mjs';

export async function pollAllSources(env = process.env, { log = console.error, scheduled = false } = {}) {
  const cfg = await loadMonitorConfig(env);
  const pollTimes = {};
  const collected = [];
  const errors = [];
  const sourceUpdates = [];
  // Scheduled cadence belongs to each bot and source type, not the last
  // successful fetch shown in the UI. Manual collection leaves it unchanged.
  const scheduleBot = botId(env);
  const lastScheduled = scheduled ? (await loadMeta(env, { forUpdate: true })).lastScheduledPollAtByBot?.[scheduleBot] || {} : {};
  const startedAt = Date.now();
  const scheduledAttempts = {};
  const due = type => !scheduled || !(startedAt - new Date(lastScheduled[type] || '2000-01-01T00:00:00Z').getTime() <
    (cfg[type].pollIntervalMinutes ?? 30) * 60_000);
  const markScheduled = type => { if (scheduled) scheduledAttempts[type] = new Date().toISOString(); };

  if (cfg.rss.enabled && due('rss')) {
    const feeds = cfg.rss.feeds.filter((f) => f.enabled !== false);
    for (const feed of feeds) {
      const snapshot = structuredClone(feed);
      try {
        const items = await fetchRss(feed.url, 'rss', feed.url, feed.name);
        collected.push(...items);
        pollTimes[`rss:${feed.url}`] = new Date().toISOString();
        feed.lastError = null;
      } catch (err) {
        feed.lastError = err.message;
        errors.push({ type: 'rss', id: feed.url, error: err.message });
        log(`[msb/monitor] rss fail ${feed.url}: ${err.message}`);
      }
      sourceUpdates.push({ type: 'rss', key: feed.url, addedAt: feed.addedAt, lastError: feed.lastError, snapshot });
    }
    if (feeds.length) markScheduled('rss');
  }

  if (cfg.youtube.enabled && due('youtube')) {
    const channels = cfg.youtube.channels.filter((c) => c.enabled !== false);
    for (const ch of channels) {
      const snapshot = structuredClone(ch);
      try {
        let channelId = ch.channelId;
        if (!channelId && ch.handle) {
          channelId = await resolveYoutubeHandle(ch.handle);
          if (channelId) {
            ch.channelId = channelId;
          }
        }
        if (!channelId) throw new Error('нет channelId — укажи /channel/UC… или @handle');
        const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
        const items = await fetchRss(url, 'youtube', channelId, ch.name);
        collected.push(...items);
        pollTimes[`youtube:${channelId}`] = new Date().toISOString();
        ch.lastError = null;
      } catch (err) {
        ch.lastError = err.message;
        errors.push({ type: 'youtube', id: ch.name, error: err.message });
        log(`[msb/monitor] youtube fail ${ch.name}: ${err.message}`);
      }
      sourceUpdates.push({ type: 'youtube', key: ch.handle || ch.channelId || ch.name, addedAt: ch.addedAt, lastError: ch.lastError, channelId: ch.channelId, snapshot });
    }
    if (channels.length) markScheduled('youtube');
  }

  if (cfg.github.enabled && due('github')) {
    const repos = cfg.github.repos.filter((r) => r.enabled !== false);
    for (const repo of repos) {
      const snapshot = structuredClone(repo);
      try {
        const url = `https://github.com/${repo.owner}/${repo.repo}/releases.atom`;
        const items = await fetchRss(url, 'github', `${repo.owner}/${repo.repo}`, repo.name);
        if (!items.length) {
          const commits = `https://github.com/${repo.owner}/${repo.repo}/commits.atom`;
          items.push(...(await fetchRss(commits, 'github', `${repo.owner}/${repo.repo}`, repo.name)));
        }
        collected.push(...items);
        pollTimes[`github:${repo.owner}/${repo.repo}`] = new Date().toISOString();
        repo.lastError = null;
      } catch (err) {
        repo.lastError = err.message;
        errors.push({ type: 'github', id: repo.name, error: err.message });
        log(`[msb/monitor] github fail ${repo.name}: ${err.message}`);
      }
      sourceUpdates.push({ type: 'github', key: `${repo.owner}/${repo.repo}`, addedAt: repo.addedAt, lastError: repo.lastError, snapshot });
    }
    if (repos.length) markScheduled('github');
  }

  if (cfg.telegram.enabled && due('telegram')) {
    const channels = cfg.telegram.channels.filter((c) => c.enabled !== false);
    for (const ch of channels) {
      const snapshot = structuredClone(ch);
      try {
        const items = await fetchTelegramPublic(ch.username, ch.name);
        collected.push(...items);
        pollTimes[`telegram:${ch.username}`] = new Date().toISOString();
        ch.lastError = null;
      } catch (err) {
        ch.lastError = err.message;
        errors.push({ type: 'telegram', id: ch.username, error: err.message });
        log(`[msb/monitor] telegram fail ${ch.username}: ${err.message}`);
      }
      sourceUpdates.push({ type: 'telegram', key: ch.username, addedAt: ch.addedAt, lastError: ch.lastError, snapshot });
    }
    if (channels.length) markScheduled('telegram');
  }

  if (cfg.twitter.enabled && due('twitter')) {
    const bearer = env.X_BEARER_TOKEN || env.TWITTER_BEARER_TOKEN;
    const accounts = cfg.twitter.accounts.filter((a) => a?.enabled !== false);
    let attempted = false;
    for (const acc of accounts) {
      const id = twitterIdentity(acc);
      if (!id) {
        errors.push({ type: 'twitter', id: null, error: 'некорректный идентификатор X-источника' });
        continue;
      }
      const snapshot = structuredClone(acc);
      try {
        if (!bearer) throw new Error('нужен X_BEARER_TOKEN в переменных окружения');
        attempted = true;
        const items = await fetchTwitter(id, bearer, acc.name);
        collected.push(...items);
        pollTimes[`twitter:${id}`] = new Date().toISOString();
        acc.lastError = null;
      } catch (err) {
        acc.lastError = err.message;
        errors.push({ type: 'twitter', id, error: err.message });
        log(`[msb/monitor] twitter fail ${id}: ${err.message}`);
      }
      sourceUpdates.push({ type: 'twitter', key: id, addedAt: acc.addedAt, lastError: acc.lastError, snapshot });
    }
    if (attempted) markScheduled('twitter');
  }

  await updateMonitorConfig((current) => mergeSourceUpdates(current, sourceUpdates), env);
  const added = await appendItems(collected, env);
  await updateMeta((meta) => {
    const lastPollAt = { ...meta.lastPollAt };
    for (const [source, at] of Object.entries(pollTimes)) {
      const previous = lastPollAt[source];
      if (typeof previous === 'string' && Date.parse(previous) > Date.parse(at)) continue;
      lastPollAt[source] = at;
    }
    meta.lastPollAt = lastPollAt;
    if (Object.keys(scheduledAttempts).length) {
      const previous = meta.lastScheduledPollAtByBot?.[scheduleBot] || {};
      const merged = { ...previous };
      for (const [type, at] of Object.entries(scheduledAttempts)) {
        const currentAt = new Date(previous[type] || 0).getTime();
        if (!(currentAt > new Date(at).getTime())) merged[type] = at;
      }
      meta.lastScheduledPollAtByBot = { ...meta.lastScheduledPollAtByBot,
        [scheduleBot]: merged };
    }
  }, env);
  log(`[msb/monitor] poll done: fetched=${collected.length} new=${added} errors=${errors.length}`);
  return { fetched: collected.length, added, errors, cfg };
}

function mergeSourceUpdates(cfg, updates) {
  const buckets = {
    rss: [cfg.rss.feeds, (item) => item.url],
    youtube: [cfg.youtube.channels, (item) => item.handle || item.channelId || item.name],
    github: [cfg.github.repos, (item) => `${item.owner}/${item.repo}`],
    telegram: [cfg.telegram.channels, (item) => item.username],
    twitter: [cfg.twitter.accounts, (item) => twitterIdentity(item)],
  };
  for (const update of updates) {
    const [list, key] = buckets[update.type];
    const matches = list.filter((entry) => key(entry) === update.key && entry.addedAt === update.addedAt &&
      (update.type !== 'twitter' || isDeepStrictEqual(entry, update.snapshot)));
    if (matches.length !== 1) continue;
    // Keep the existing ambiguous-identity rule for these sources: only after
    // finding one matching key check that the row has not changed meanwhile.
    if (update.type !== 'twitter' && !isDeepStrictEqual(matches[0], update.snapshot)) continue;
    matches[0].lastError = update.lastError;
    if (update.type === 'youtube' && update.channelId && !matches[0].channelId) {
      matches[0].channelId = update.channelId;
    }
  }
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'MSB-Monitor/1.0', Accept: 'application/atom+xml, application/rss+xml, text/html, */*' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchRss(url, sourceType, sourceId, sourceName) {
  const xml = await fetchText(url);
  const entries = [];
  const entryRe = /<(?:entry|item)\b[\s\S]*?<\/(?:entry|item)>/gi;
  let m;
  while ((m = entryRe.exec(xml)) && entries.length < 30) {
    const block = m[0];
    const title = pick(block, /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const link =
      pick(block, /<link[^>]+href=["']([^"']+)["']/i) ||
      pick(block, /<link[^>]*>([^<]+)<\/link>/i) ||
      pick(block, /<id>([^<]+)<\/id>/i);
    const published =
      pick(block, /<(?:published|updated|pubDate)[^>]*>([^<]+)</i) || new Date().toISOString();
    const summary = pick(block, /<(?:summary|description|content)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:summary|description|content)>/i);
    if (!title && !link) continue;
    const externalId = pick(block, /<(?:id|guid)[^>]*>([^<]+)</i) || link;
    entries.push({
      id: itemId(sourceType, sourceId, externalId, link),
      sourceType,
      sourceId,
      sourceName: sourceName || sourceId,
      title: clean(title).slice(0, 300),
      url: (link || '').trim(),
      publishedAt: new Date(published).toISOString(),
      summary: clean(summary).slice(0, 500),
      externalId,
    });
  }
  return entries;
}

async function resolveYoutubeHandle(handle) {
  const html = await fetchText(`https://www.youtube.com/@${encodeURIComponent(handle)}`);
  const m = html.match(/"channelId":"(UC[\w-]+)"/) || html.match(/\/channel\/(UC[\w-]+)/);
  return m?.[1] || null;
}

async function fetchTelegramPublic(username, name) {
  const html = await fetchText(`https://t.me/s/${encodeURIComponent(username)}`);
  const entries = [];
  for (const { url, date: publishedAt, caption } of readPublicPosts(html, username)) {
    const summary = clean(caption).slice(0, 500);
    entries.push({
      id: itemId('telegram', username, url, url),
      sourceType: 'telegram',
      telegramPostVerified: true,
      sourceId: username,
      sourceName: name || `@${username}`,
      title: summary.slice(0, 120) || url,
      url,
      publishedAt,
      summary,
      externalId: url,
    });
    if (entries.length === 20) break;
  }
  if (!entries.length) {
    // канал может быть закрытым
    throw new Error('нет публичных постов (канал закрыт или пуст)');
  }
  return entries;
}

async function fetchTwitter(username, bearer, name) {
  const ures = await fetch(`https://api.twitter.com/2/users/by/username/${encodeURIComponent(username)}`, {
    headers: { Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!ures.ok) throw new Error(`user lookup HTTP ${ures.status}`);
  const uj = await ures.json();
  const uid = uj?.data?.id;
  if (!uid) throw new Error('пользователь не найден');
  const tres = await fetch(
    `https://api.twitter.com/2/users/${uid}/tweets?max_results=10&tweet.fields=created_at`,
    { headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(20000) },
  );
  if (!tres.ok) throw new Error(`tweets HTTP ${tres.status}`);
  const tj = await tres.json();
  return (tj.data || []).map((t) => ({
    id: itemId('twitter', username, t.id, t.id),
    sourceType: 'twitter',
    sourceId: username,
    sourceName: name || `@${username}`,
    title: String(t.text || '').slice(0, 200),
    url: `https://x.com/${username}/status/${t.id}`,
    publishedAt: t.created_at || new Date().toISOString(),
    summary: String(t.text || '').slice(0, 500),
    externalId: t.id,
  }));
}

function pick(block, re) {
  const m = block.match(re);
  return m ? m[1] : '';
}

function clean(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
