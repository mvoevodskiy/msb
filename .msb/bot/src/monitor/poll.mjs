/**
 * Сбор источников мониторинга (RSS / YouTube RSS / GitHub Atom / TG public / X).
 * Навигация: [Мониторинг](./README.md) → [storage](./store.mjs), [digest](./digest.mjs).
 */
import { loadMonitorConfig, updateMonitorConfig } from './config.mjs';
import { appendItems, itemId, updateMeta } from './store.mjs';

export async function pollAllSources(env = process.env, { log = console.error } = {}) {
  const cfg = await loadMonitorConfig(env);
  const pollTimes = {};
  const collected = [];
  const errors = [];
  const sourceUpdates = [];

  if (cfg.rss.enabled) {
    for (const feed of cfg.rss.feeds.filter((f) => f.enabled !== false)) {
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
      sourceUpdates.push({ type: 'rss', key: feed.url, addedAt: feed.addedAt, lastError: feed.lastError });
    }
  }

  if (cfg.youtube.enabled) {
    for (const ch of cfg.youtube.channels.filter((c) => c.enabled !== false)) {
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
      sourceUpdates.push({ type: 'youtube', key: ch.handle || ch.channelId || ch.name, addedAt: ch.addedAt, lastError: ch.lastError, channelId: ch.channelId });
    }
  }

  if (cfg.github.enabled) {
    for (const repo of cfg.github.repos.filter((r) => r.enabled !== false)) {
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
      sourceUpdates.push({ type: 'github', key: `${repo.owner}/${repo.repo}`, addedAt: repo.addedAt, lastError: repo.lastError });
    }
  }

  if (cfg.telegram.enabled) {
    for (const ch of cfg.telegram.channels.filter((c) => c.enabled !== false)) {
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
      sourceUpdates.push({ type: 'telegram', key: ch.username, addedAt: ch.addedAt, lastError: ch.lastError });
    }
  }

  if (cfg.twitter.enabled) {
    const bearer = env.X_BEARER_TOKEN || env.TWITTER_BEARER_TOKEN;
    for (const acc of cfg.twitter.accounts.filter((a) => a.enabled !== false)) {
      try {
        if (!bearer) throw new Error('нужен X_BEARER_TOKEN в переменных окружения');
        const items = await fetchTwitter(acc.username, bearer, acc.name);
        collected.push(...items);
        pollTimes[`twitter:${acc.username}`] = new Date().toISOString();
        acc.lastError = null;
      } catch (err) {
        acc.lastError = err.message;
        errors.push({ type: 'twitter', id: acc.username, error: err.message });
        log(`[msb/monitor] twitter fail ${acc.username}: ${err.message}`);
      }
      sourceUpdates.push({ type: 'twitter', key: acc.username, addedAt: acc.addedAt, lastError: acc.lastError });
    }
  }

  await updateMonitorConfig((current) => mergeSourceUpdates(current, sourceUpdates), env);
  const added = await appendItems(collected, env);
  await updateMeta((meta) => {
    meta.lastPollAt = { ...meta.lastPollAt, ...pollTimes };
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
    twitter: [cfg.twitter.accounts, (item) => item.username],
  };
  for (const update of updates) {
    const [list, key] = buckets[update.type];
    const matches = list.filter((entry) => key(entry) === update.key && entry.addedAt === update.addedAt);
    if (matches.length !== 1) continue;
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
  const re = /class="tgme_widget_message_date" href="(https:\/\/t\.me\/[^"]+)"[\s\S]*?datetime="([^"]+)"[\s\S]*?class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = re.exec(html)) && entries.length < 20) {
    const url = m[1];
    const publishedAt = new Date(m[2]).toISOString();
    const summary = clean(m[3]).slice(0, 500);
    entries.push({
      id: itemId('telegram', username, url, url),
      sourceType: 'telegram',
      sourceId: username,
      sourceName: name || `@${username}`,
      title: summary.slice(0, 120) || url,
      url,
      publishedAt,
      summary,
      externalId: url,
    });
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
