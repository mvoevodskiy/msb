/**
 * Old per-bot sleep gate: [bot ingress/worker](../telegram/bot.mjs),
 * [wake callback](../telegram/routes/engines.mjs); no provider/session writes.
 * Marker is owned by the selected runtime profile. Shared [marker](./sleep-marker.mjs)
 * and [admission](./sleep-gate.mjs) are provider-independent; [Codex policy](./codex-sleep.mjs)
 * is shared with a selective release. This adapter retains other existing routes
 * while delegating Codex stop admission to that same policy.
 * [Codex checks](../../tests/codex-engine-sleep.test.mjs).
 */
import path from 'node:path';
import { InlineKeyboard } from 'grammy';
import { botId, msbRoot } from '../paths.mjs';
import { loadState } from '../state.mjs';
import { escapeHtml } from '../telegram/edit.mjs';
import { engineStatusSnapshot } from './client.mjs';
import { createSleepMarker } from './sleep-marker.mjs';
import { createSleepGate } from './sleep-gate.mjs';
import { isCodexSelected } from './codex-active.mjs';
import { createCodexSleep } from './codex-sleep.mjs';

export function createEngineSleep({ bot, pending, now = Date.now, onWake = async () => {} }) {
  const lastNotice = new Map();
  const marker = () => path.join(msbRoot(), 'engine', `sleep.${botId()}`);
  const codex = createCodexSleep({ pending, now, onWake, extraButtons: async keyboard => {
    const state = (await loadState()).state;
    const username = /^[A-Za-z0-9_]{5,32}$/.test(state.nativeOc?.username || '') ? state.nativeOc.username : '';
    if (username) keyboard.url('🦞 Открыть', `https://t.me/${username}`);
  } });
  const markerState = createSleepMarker({ marker, onWake,
    shouldClear: async mark => {
      // Codex sleep is explicit: keep the selected conversation paused until
      // the owner wakes this bot, without depending on another engine's state.
      if (isCodexSelected((await loadState()).state)) return false;
      const snapshot = await engineStatusSnapshot().catch(() => null);
      const oc = snapshot?.openclaw;
      // A snapshot from before sleep was requested cannot prove the newly
      // selected OpenClaw stopped. Timestamps have one-second precision.
      const observedAt = Date.parse(snapshot?.at || '');
      const fresh = Number.isFinite(observedAt) && observedAt >= Math.ceil(mark.mtimeMs / 1000) * 1000;
      return Boolean(fresh && oc && (oc.installed === false || oc.incomplete === true || oc.enabled === false));
    },
  });

  async function notify(ctx, suffix = '') {
    const chat = ctx.chat?.id;
    if (!chat) return;
    const previous = lastNotice.get(chat);
    if (!suffix && previous !== undefined && now() - previous < 30_000) return;
    lastNotice.set(chat, now());
    const state = (await loadState().catch(() => ({ state: {} }))).state;
    const username = /^[A-Za-z0-9_]{5,32}$/.test(state.nativeOc?.username || '') ? state.nativeOc.username : '';
    if (isCodexSelected(state)) return codex.notify(ctx, suffix);
    let view;
    try { view = await bot[Symbol.for('msb.engineProviderView')]?.({ ...state, engine: 'cc' }); }
    catch { /* The selected state remains the fallback. */ }
    const title = view?.activeTitle || (state.extAuthBypass === 'codex' ? 'Codex' : 'Claude Code');
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

  async function sleeping(options) {
    if (!await markerState.sleeping(options)) return false;
    try {
      if (isCodexSelected((await loadState()).state)) {
        if (await codex.sleeping(options)) return true;
        // Selection or marker may have changed while awaiting the Codex gate.
        return markerState.sleeping(options);
      }
    } catch { return true; }
    return true;
  }
  const gate = createSleepGate({ pending, sleeping, notify, allowStop: codex.allowStop });
  return { ...gate, ...markerState, sleeping,
    allowStop: codex.allowStop, captureCodexPause: codex.captureCodexPause,
    wakeCapturedCodexPause: codex.wakeCapturedCodexPause };
}
