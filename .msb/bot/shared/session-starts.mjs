/** Reservations for the first CLI session only; provider switches are not resets. */
import { randomUUID } from 'node:crypto';
const providers = new Set(['claude', 'codex', 'cursor', 'qwen']);
const sentinel = /^(norestart(?:-[a-z0-9]+)?|failed|error|unknown)$/i;
const map = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function selectedSessionProvider(state) {
  return state.extAuthBypass ? (providers.has(state.extAuthBypass) ? state.extAuthBypass : null) : 'claude';
}

/** Same accepted session shapes as the existing CLI adapters; never accept foreign/sentinel IDs. */
export function isProviderSession(sessionId, provider) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || !providers.has(provider)) return false;
  if (provider === 'claude') return !sessionId.startsWith('ext:') && !sentinel.test(sessionId.trim());
  const decoded = /^ext:([a-z]+):(.+)$/.exec(sessionId);
  if (!decoded || decoded[1] !== provider) return false;
  const native = decoded[2];
  if (provider === 'cursor') return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(native.trim());
  if (provider === 'codex') {
    const trimmed = native.trim();
    return trimmed.length >= 8 && !sentinel.test(trimmed) && !/^[cxq]\d{10,}$/i.test(trimmed)
      && !(/^[a-z0-9]{6,12}$/i.test(trimmed) && !trimmed.includes('-'));
  }
  return !sentinel.test(native);
}

/** Called in the same state transaction as the turn snapshot. A newer attempt wins. */
export function claimFirstSession(state, provider = selectedSessionProvider(state)) {
  if (state.ccSessionId || !providers.has(provider)) return null;
  const token = randomUUID();
  state.pendingCcSessionStarts = { ...map(state.pendingCcSessionStarts), [provider]: token };
  return { provider, token };
}

/** Cleanup can only remove its own attempt, never a newer first turn. */
export function releaseFirstSession(state, reservation) {
  if (!reservation || map(state.pendingCcSessionStarts)[reservation.provider] !== reservation.token) return false;
  const pending = { ...state.pendingCcSessionStarts };
  delete pending[reservation.provider];
  if (Object.keys(pending).length) state.pendingCcSessionStarts = pending;
  else delete state.pendingCcSessionStarts;
  return true;
}

/** Explicit reset cancels only the currently selected provider, including an ID-less first turn. */
export function invalidateFirstSession(state) {
  const provider = selectedSessionProvider(state);
  const token = map(state.pendingCcSessionStarts)[provider];
  return token ? releaseFirstSession(state, { provider, token }) : false;
}

/** Return the placement, or null if reset/replaced/foreign/occupied. Consume only this attempt. */
export function completeFirstSession(state, reservation, result) {
  if (!releaseFirstSession(state, reservation)) return null;
  const provider = reservation.provider;
  if (result.providerId !== provider || !isProviderSession(result.sessionId, provider)) return null;
  const parked = map(state.parkedCcSessions);
  const active = state.engine !== 'oc' && selectedSessionProvider(state) === provider;
  // A later established conversation always wins, even when currently parked.
  if (parked[provider] || (active && state.ccSessionId)) return null;
  if (active) state.ccSessionId = result.sessionId;
  else state.parkedCcSessions = { ...parked, [provider]: result.sessionId };
  return active ? 'active' : 'parked';
}
