/**
 * Clear only the Codex pause observed before a successful Claude selection.
 * [Selection](./integration/callbacks.mjs) preserves the existing provider/session
 * transaction; [marker](../../../.msb/bot/src/engines/sleep-marker.mjs) uses the
 * writer's lock. [Checks](../../../.msb/bot/tests/codex-pause-switch.test.mjs).
 */
import { updateBotState } from './state-update.mjs';
import { loadStore, storePath } from './store.mjs';
import { withStoreLock } from './store-lock.mjs';
import { readBotState } from './paths.mjs';
import { randomUUID } from 'node:crypto';
import { hasClaudeCreds, CODEX_PAUSE_SWITCH, validCodexPauseSwitch } from './setup-bypass.mjs';

const epochOf = state => Number.isSafeInteger(state.sessionEpoch) ? state.sessionEpoch : 0;

export async function captureCodexPause(bot) {
  const sleep = bot[Symbol.for('msb.engineSleep')];
  const selected = await sleep?.captureCodexPause?.();
  const state = await readBotState();
  const intent = validCodexPauseSwitch(state[CODEX_PAUSE_SWITCH]) ? state[CODEX_PAUSE_SWITCH] : null;
  const epoch = epochOf(state);
  if (selected) {
    if (state.extAuthBypass === 'codex' && state.engine !== 'oc' && epoch === selected.sourceEpoch &&
        intent?.phase === 'prepared' && intent.sourceEpoch === epoch && selected.revision === intent.revision) return intent;
    return { id: randomUUID(), ...selected, phase: 'prepared' };
  }
  if (state.engine === 'oc') return null;
  if (state.extAuthBypass === 'codex') {
    return intent?.phase === 'prepared' && intent.sourceEpoch === epoch ? intent : null;
  }
  if (state.extAuthBypass) return null;
  return intent?.phase === 'committed' && intent.targetEpoch === epoch ? intent : null;
}

export async function beginClaudePauseSwitch(intent) {
  if (!intent) return true;
  if (!validCodexPauseSwitch(intent)) return false;
  let accepted = false;
  await updateBotState(state => {
    if (state.engine === 'oc') return null;
    const current = state[CODEX_PAUSE_SWITCH];
    if (intent.phase === 'prepared') {
      if (state.extAuthBypass !== 'codex' || epochOf(state) !== intent.sourceEpoch) return null;
    } else if (intent.phase === 'committed') {
      if (state.extAuthBypass || epochOf(state) !== intent.targetEpoch || current?.id !== intent.id) return null;
    } else return null;
    accepted = true;
    if (current?.id === intent.id) return null;
    state[CODEX_PAUSE_SWITCH] = intent;
    return state;
  });
  return accepted;
}

export async function finishClaudePauseSwitch(bot, intent) {
  if (!intent) return { ok: true };
  let result = { superseded: true };
  try {
    await updateBotState(async state => {
      let changed = false;
      await withStoreLock(storePath(), async () => {
        const store = await loadStore();
        const current = state[CODEX_PAUSE_SWITCH];
        if (state.engine === 'oc' || state.extAuthBypass || store.active !== 'claude' ||
            current?.id !== intent.id || current.phase !== 'committed' || epochOf(state) !== current.targetEpoch) return;
        if (!await hasClaudeCreds()) { result = { notReady: true }; return; }
        result = await bot[Symbol.for('msb.engineSleep')].wakeCapturedCodexPause(current.revision);
        if (result.ok || result.stale) {
          delete state[CODEX_PAUSE_SWITCH]; changed = true;
        }
      });
      return changed ? state : null;
    });
  } catch { result = { ok: false }; }
  return result;
}
