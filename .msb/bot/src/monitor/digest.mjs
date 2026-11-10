import { loadMonitorConfig, updateMonitorConfig } from './config.mjs';
import { listRecentItems, updateMeta } from './store.mjs';
import { loadState } from '../state.mjs';
import { botId } from '../paths.mjs';

export async function buildDigestText(env = process.env) {
  const cfg = await loadMonitorConfig(env);
  const topN = cfg.digest?.topN || 10;
  const items = await listRecentItems({ limit: topN, sinceHours: 36 }, env);
  if (!items.length) {
    return { empty: true, text: 'За последние сутки новых материалов нет.' };
  }
  const lines = [`📨 <b>Дайджест</b> · ${items.length} материалов`, ''];
  for (const it of items) {
    const when = (it.publishedAt || '').slice(0, 16).replace('T', ' ');
    lines.push(`• <b>${esc(it.sourceName || it.sourceType)}</b> · ${when}`);
    lines.push(`  ${esc(it.title)}`);
    if (it.url) lines.push(`  ${esc(it.url)}`);
    lines.push('');
  }
  return { empty: false, text: lines.join('\n'), count: items.length };
}

export async function maybeSendDigest({ api, adminId, force = false, env = process.env, log = console.error } = {}) {
  if (!api || !adminId) return { sent: false, reason: 'no-api' };
  const cfg = await loadMonitorConfig(env);
  if (!cfg.digest?.enabled && !force) return { sent: false, reason: 'disabled' };
  // Shared monitor storage: only the configured bot owns scheduled delivery.
  if (!force && botId(env) !== (cfg.digest?.targetBotId || 'default')) return { sent: false, reason: 'not-target' };

  const hour = cfg.digest?.hour ?? 9;
  const { state } = await loadState(env);
  const tz = state.timezone || env.MSB_TIMEZONE || 'Europe/Moscow';
  const result = await updateMeta(async (meta) => {
    const now = new Date();
    const localNow = clockInTz(now, tz);
    const lastSent = new Date(meta.lastDigestAt || '');
    const lastDay = Number.isNaN(lastSent.getTime()) ? null : clockInTz(lastSent, tz).day;
    if (!force) {
      if (localNow.hour !== hour) return { sent: false, reason: 'wrong-hour' };
      if (lastDay === localNow.day) return { sent: false, reason: 'already' };
    }

    const dig = await buildDigestText(env);
    if (dig.empty && !force) return { sent: false, reason: 'empty' };

    await api.sendMessage(adminId, dig.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    meta.lastDigestAt = now.toISOString();
    return { sent: true, count: dig.count || 0 };
  }, env);
  if (result.sent) log(`[msb/monitor] digest sent (${result.count})`);
  return result;
}

export async function updateDigestSettings(patch, env = process.env) {
  return updateMonitorConfig((cfg) => {
    const delta = typeof patch === 'function' ? patch(cfg.digest) : patch;
    cfg.digest = { ...cfg.digest, ...delta };
    return cfg.digest;
  }, env);
}

function clockInTz(date, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value;
    return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
  } catch {
    return { day: `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`, hour: date.getHours() };
  }
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
