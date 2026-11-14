/**
 * Old per-bot sleep gate: [bot ingress/worker](../telegram/bot.mjs),
 * [wake callback](../telegram/routes/engines.mjs); no provider/session writes.
 * Marker is owned by the selected runtime profile. [Checks](../../tests/engine-sleep.test.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { InlineKeyboard } from 'grammy';
import { botId, msbRoot } from '../paths.mjs';
import { loadState } from '../state.mjs';
import { escapeHtml } from '../telegram/edit.mjs';
import { engineStatusSnapshot } from './client.mjs';
import { withFileLock } from '../../shared/file-lock.mjs';

const KEY_PATTERNS = [
  /(?<!\d)\d{5,12}:[A-Za-z0-9_-]{30,}/,
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{6,}/,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/,
  /(?<![A-Za-z0-9])xai-[A-Za-z0-9]{20,}/,
];

export function createEngineSleep({ bot, pending, now = Date.now, onWake = async () => {} }) {
  const lastNotice = new Map();
  const marker = () => path.join(msbRoot(), 'engine', `sleep.${botId()}`);
  const markerInfo = async () => {
    try { return await fs.lstat(marker()); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  };

  async function wakeAttempt({ resume = true } = {}) {
    let outcome = { ok: true };
    try {
      if (await markerInfo()) {
        outcome = await withFileLock(marker(), async () => {
          let mark;
          try { mark = await fs.lstat(marker(), { bigint: true }); }
          catch (err) { if (err.code === 'ENOENT') return { ok: true }; throw err; }
          const revision = `${mark.dev}:${mark.ino}:${mark.ctimeNs}`;
          try { await fs.unlink(marker()); }
          catch (err) { if (err.code !== 'ENOENT') return { ok: false, revision }; }
          return { ok: !await markerInfo() };
        });
      }
    } catch { return { ok: false }; }
    if (outcome.ok && resume) await onWake().catch(() => {});
    return outcome;
  }

  async function wake(options) { return (await wakeAttempt(options)).ok; }

  async function resumeIfAwake() {
    let awake;
    try { awake = await withFileLock(marker(), async () => !await markerInfo()); }
    catch { return false; }
    if (awake) await onWake().catch(() => {});
    return awake;
  }

  async function sleeping({ resumeOnWake = true } = {}) {
    let result;
    try {
      if (!await markerInfo()) return false;
      result = await withFileLock(marker(), async () => {
        const mark = await markerInfo();
        if (!mark) return { asleep: false, cleared: false };
        const snapshot = await engineStatusSnapshot().catch(() => null);
        const oc = snapshot?.openclaw;
        // A snapshot from before sleep was requested cannot prove the newly
        // selected OpenClaw stopped. Timestamps have one-second precision.
        const observedAt = Date.parse(snapshot?.at || '');
        const fresh = Number.isFinite(observedAt) && observedAt >= Math.ceil(mark.mtimeMs / 1000) * 1000;
        if (fresh && oc && (oc.installed === false || oc.incomplete === true || oc.enabled === false)) {
          try { await fs.unlink(marker()); }
          catch (err) { if (err.code !== 'ENOENT') return { asleep: true, cleared: false }; }
          return { asleep: Boolean(await markerInfo()), cleared: true };
        }
        return { asleep: true, cleared: false };
      });
    } catch { return true; }
    if (result.cleared && resumeOnWake) await onWake().catch(() => {});
    return result.asleep;
  }

  async function notify(ctx, suffix = '') {
    const chat = ctx.chat?.id;
    if (!chat) return;
    const previous = lastNotice.get(chat);
    if (!suffix && previous !== undefined && now() - previous < 30_000) return;
    lastNotice.set(chat, now());
    const state = (await loadState().catch(() => ({ state: {} }))).state;
    let view;
    try { view = await bot[Symbol.for('msb.engineProviderView')]?.({ ...state, engine: 'cc' }); }
    catch { /* The selected state remains the fallback. */ }
    const title = view?.activeTitle || (state.extAuthBypass === 'codex' ? 'Codex' : 'Claude Code');
    const username = /^[A-Za-z0-9_]{5,32}$/.test(state.nativeOc?.username || '') ? state.nativeOc.username : '';
    const snap = await engineStatusSnapshot().catch(() => null);
    const oc = snap?.openclaw;
    const unavailable = oc?.installed === true && oc.enabled === true && ['inactive', 'failed'].includes(oc.gateway);
    const name = username ? ` @${escapeHtml(username)}` : '';
    const text = unavailable
      ? `${escapeHtml(title)} выключен, а OpenClaw${name} сейчас не отвечает. Вернуть ${escapeHtml(title)}: «🔀 Переключить».`
      : `Сейчас работает OpenClaw${username ? `: @${escapeHtml(username)}` : ''}. Вернуть ${escapeHtml(title)}: «🔀 Переключить».`;
    const keyboard = new InlineKeyboard();
    if (username && !unavailable) keyboard.url('🦞 Открыть', `https://t.me/${username}`);
    keyboard.text('🔀 Переключить', 'eng:wake');
    await ctx.reply(`${text}\n⠀${suffix}`, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  }

  async function middleware(ctx, next) {
    if (!await sleeping()) return next();
    const data = ctx.callbackQuery?.data;
    const text = ctx.message?.text || '';
    if (typeof data === 'string' && (data.startsWith('eng:') || data.startsWith('settings:'))) return next();
    if (/^\/settings(?:@\w+)?(?:\s|$)/.test(text)) return next();
    if (pending.has(ctx.chat?.id) && text.trim() && !text.trim().startsWith('/')) return next();
    if (!ctx.message && !ctx.callbackQuery) return;
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    if (!ctx.chat?.id) return;
    let suffix = '';
    if (text && KEY_PATTERNS.some(pattern => pattern.test(text))) {
      const deleted = await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).then(() => true, () => false);
      suffix = deleted ? '\nСообщение с ключом удалил.' : '\nУдали сообщение с ключом из чата сам: у меня не получилось.';
    }
    await notify(ctx, suffix);
  }

  async function queued(entry) {
    if (!await sleeping()) return false;
    await entry.presentation?.catch(() => {});
    if (!entry.recovered && entry.status?.message_id) {
      await entry.ctx.api.deleteMessage(entry.ctx.chat.id, entry.status.message_id).catch(() => {});
    }
    if (!entry.recovered && !entry.isAutoTurn) await notify(entry.ctx);
    return true;
  }

  return { middleware, queued, wake, wakeAttempt, resumeIfAwake, sleeping };
}
