/**
 * Codex sleep adapter for [mixed sleep routing](./sleep.mjs) and Telegram.
 * [Marker](./sleep-marker.mjs) and [gate](./sleep-gate.mjs) contain the shared
 * mechanics; [wake route](../telegram/routes/engines.mjs) changes no provider.
 * [Checks](../../tests/codex-engine-sleep.test.mjs), [notice](../../tests/codex-sleep.test.mjs) and
 * [handoff/stop](../../tests/codex-sleep-flow.test.mjs) use synthetic I/O;
 * allowStop admits existing stop paths only for selected Codex; provider
 * selection captures a revision for [overlay](../../../../overlay/bot/ext/codex-pause-switch.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { InlineKeyboard } from 'grammy';
import { botId, msbRoot } from '../paths.mjs';
import { loadState } from '../state.mjs';
import { createSleepMarker } from './sleep-marker.mjs';
import { createSleepGate } from './sleep-gate.mjs';
import { isCodexSelected } from './codex-active.mjs';

export function createCodexSleep({ pending, now = Date.now, onWake = async () => {}, extraButtons = async () => {} }) {
  const marker = () => path.join(msbRoot(), 'engine', `sleep.${botId()}`);
  const markerState = createSleepMarker({ marker, onWake });
  const notices = new Map();

  async function sleeping(options, onCodexBlock) {
    let unreadable = false;
    try { await fs.lstat(marker()); }
    catch (error) { if (error.code === 'ENOENT') return false; unreadable = true; }
    // Do not touch the marker lock or change admission for other providers.
    // On an unreadable selected state, fail closed rather than start a turn.
    try { if (!isCodexSelected((await loadState()).state)) return false; }
    catch { return true; }
    const asleep = unreadable || await markerState.sleeping(options);
    if (asleep) onCodexBlock?.();
    return asleep;
  }

  async function wake(options) {
    try {
      if (!isCodexSelected((await loadState()).state)) return false;
      return await markerState.wake(options);
    } catch { return false; }
  }

  async function allowStop() {
    try { return isCodexSelected((await loadState()).state); }
    catch { return false; }
  }

  async function captureCodexPause() {
    let revision, markerError, state;
    try { revision = await markerState.revision(); } catch (error) { markerError = error; }
    try { state = (await loadState()).state; }
    catch (error) {
      // A known or unreadable marker cannot be treated as "no paused Codex"
      // when the provider snapshot is temporarily unavailable.
      if (revision || markerError) throw error;
      return null;
    }
    if (!isCodexSelected(state)) return null;
    if (markerError) throw markerError;
    return revision ? { revision, sourceEpoch: Number.isSafeInteger(state.sessionEpoch) ? state.sessionEpoch : 0 } : null;
  }

  async function wakeCapturedCodexPause(revision) {
    return markerState.wakeAttempt({ expectedRevision: revision, resume: false });
  }

  async function notify(ctx, suffix = '') {
    const chat = ctx.chat?.id;
    if (!chat) return;
    const previous = notices.get(chat);
    if (!suffix && previous !== undefined && now() - previous < 30_000) return;
    notices.set(chat, now());
    const keyboard = new InlineKeyboard();
    await extraButtons(keyboard).catch(() => {});
    keyboard.text('🔀 Переключить', 'eng:wake');
    await ctx.reply(`Codex на паузе.\n⠀${suffix}`, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  }

  return { ...markerState, ...createSleepGate({ pending, sleeping, notify, allowStop }), sleeping, wake, notify, allowStop,
    captureCodexPause, wakeCapturedCodexPause };
}
